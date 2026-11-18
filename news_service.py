import hashlib
import html
import re
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from html.parser import HTMLParser
from typing import Optional
from urllib.parse import urlparse

import feedparser

import database
import gemini_agent
import mlb_service

_rss_cache = mlb_service.TTLCache()
_rss_client = mlb_service.make_http_client()
TTL_RSS = 900  # 15 minutes

EXTRA_RSS_FEEDS = [
    ("ESPN", "https://www.espn.com/espn/rss/mlb/news"),
    ("MLB Trade Rumors", "https://www.mlbtraderumors.com/feed"),
    ("CBS Sports", "https://www.cbssports.com/rss/headlines/mlb/"),
    ("Yahoo Sports", "https://sports.yahoo.com/mlb/rss/"),
]

ALLOWED_READER_DOMAINS = (
    "mlb.com",
    "espn.com",
    "mlbtraderumors.com",
    "cbssports.com",
    "sports.yahoo.com",
)


def _strip_html(raw: str) -> str:
    text = re.sub(r"<[^>]+>", " ", raw or "")
    return html.unescape(re.sub(r"\s+", " ", text)).strip()


def _parse_rss_date(entry: dict) -> str:
    for key in ("published", "updated"):
        val = entry.get(key)
        if val:
            try:
                dt = parsedate_to_datetime(val)
                if dt.tzinfo is None:
                    dt = dt.replace(tzinfo=timezone.utc)
                return dt.astimezone(timezone.utc).isoformat()
            except Exception:
                pass
    return datetime.now(timezone.utc).isoformat()


def _fetch_rss(url: str, source_name: str) -> list[dict]:
    cached = _rss_cache.get(f"rss:{url}")
    if cached is not None:
        return cached
    try:
        resp = _rss_client.get(url)
        resp.raise_for_status()
        parsed = feedparser.parse(resp.text)
        entries = []
        for e in parsed.entries[:40]:
            entries.append(
                {
                    "source": source_name,
                    "title": _strip_html(e.get("title", "")),
                    "summary": _strip_html(e.get("summary", "") or e.get("description", "")),
                    "link": e.get("link", "https://www.mlb.com/news"),
                    "published_at": _parse_rss_date(e),
                }
            )
        _rss_cache.set(f"rss:{url}", entries, TTL_RSS)
        return entries
    except Exception:
        return []


def _article_id(url: str, title: str) -> str:
    raw = f"{url}|{title}".encode("utf-8")
    return hashlib.sha256(raw).hexdigest()[:24]


def _source_from_url(url: str) -> str:
    host = (urlparse(url).hostname or "").lower()
    if "espn.com" in host:
        return "ESPN"
    if "mlbtraderumors.com" in host:
        return "MLB Trade Rumors"
    if "cbssports.com" in host:
        return "CBS Sports"
    if "yahoo.com" in host:
        return "Yahoo Sports"
    return "MLB.com"


class _ArticleHTMLParser(HTMLParser):
    """Lightweight HTML parser to extract clean article paragraphs, title, and og:image."""

    def __init__(self) -> None:
        super().__init__()
        self.title: str = ""
        self.image_url: Optional[str] = None
        self.paragraphs: list[str] = []
        self._skip_depth: int = 0
        self._in_p: bool = False
        self._in_title: bool = False
        self._current_p: list[str] = []
        self._current_title: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, Optional[str]]]) -> None:
        tag = tag.lower()
        attr_map = {k.lower(): (v or "") for k, v in attrs}

        if tag == "meta":
            prop = (attr_map.get("property") or attr_map.get("name") or "").lower()
            content = attr_map.get("content", "").strip()
            if prop == "og:image" and content and not self.image_url:
                self.image_url = content
            elif prop == "og:title" and content and not self.title:
                self.title = html.unescape(content)
            return

        if tag in ("script", "style", "noscript", "nav", "header", "footer", "aside", "form", "svg"):
            self._skip_depth += 1
            return

        if self._skip_depth > 0:
            return

        if tag == "title" and not self.title:
            self._in_title = True
            self._current_title = []
        elif tag == "p":
            self._in_p = True
            self._current_p = []

    def handle_endtag(self, tag: str) -> None:
        tag = tag.lower()
        if tag in ("script", "style", "noscript", "nav", "header", "footer", "aside", "form", "svg"):
            if self._skip_depth > 0:
                self._skip_depth -= 1
            return

        if tag == "title" and self._in_title:
            self._in_title = False
            if not self.title:
                self.title = html.unescape("".join(self._current_title)).strip()
        elif tag == "p" and self._in_p:
            self._in_p = False
            text = html.unescape(re.sub(r"\s+", " ", "".join(self._current_p))).strip()
            # Filter out very short boilerplate snippets & promo lines
            lower = text.lower()
            if len(text) >= 45 and not any(
                skip in lower
                for skip in (
                    "copyright ©",
                    "all rights reserved",
                    "privacy policy",
                    "terms of use",
                    "sign up for",
                    "subscribe to",
                    "betting",
                    "sportsbook",
                    "draftkings",
                    "fanduel",
                )
            ):
                self.paragraphs.append(text)

    def handle_data(self, data: str) -> None:
        if self._skip_depth > 0:
            return
        if self._in_title:
            self._current_title.append(data)
        elif self._in_p:
            self._current_p.append(data)


def fetch_reader_article(url: str) -> dict:
    """Fetch and clean an article from an allowlisted baseball news domain for the in-app reader pane."""
    parsed = urlparse(url)
    host = (parsed.hostname or "").lower()
    if parsed.scheme not in ("http", "https") or not any(
        host == d or host.endswith(f".{d}") for d in ALLOWED_READER_DOMAINS
    ):
        raise ValueError("Article domain is not in the allowlisted baseball sources.")

    cache_key = f"reader:{url}"
    cached = _rss_cache.get(cache_key)
    if cached is not None:
        return cached

    source = _source_from_url(url)
    try:
        resp = _rss_client.get(
            url,
            headers={
                "User-Agent": "Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1"
            },
        )
        resp.raise_for_status()
        parser = _ArticleHTMLParser()
        parser.feed(resp.text)

        paragraphs = parser.paragraphs[:25]
        result = {
            "url": url,
            "source": source,
            "title": parser.title or f"{source} Baseball Story",
            "image_url": parser.image_url,
            "paragraphs": paragraphs,
            "reader_available": len(paragraphs) > 0,
        }
    except Exception:
        result = {
            "url": url,
            "source": source,
            "title": f"{source} Baseball Story",
            "image_url": None,
            "paragraphs": [],
            "reader_available": False,
        }

    _rss_cache.set(cache_key, result, TTL_RSS)
    return result


def get_followed_player_newsfeed() -> dict:
    fav_players = database.get_favorite_players()
    fav_team = database.get_favorite_team()
    fav_team_name = (fav_team or {}).get("team_name") or "Philadelphia Phillies"
    fav_team_short = fav_team_name.split()[-1] if fav_team_name else "Phillies"
    fav_team_slug = (fav_team or {}).get("team_slug") or "phillies"

    feed_items: list[dict] = []
    seen_article_ids: set[str] = set()

    # 1. Collect RSS feeds (MLB.com + team RSS + ESPN + MLBTR + CBS + Yahoo)
    rss_sources: list[tuple[str, str, bool]] = [
        ("MLB.com", "https://www.mlb.com/feeds/news/rss.xml", False),
        ("MLB.com", f"https://www.mlb.com/{fav_team_slug}/feeds/news/rss.xml", True),
    ]
    team_slugs: set[str] = {fav_team_slug}
    for p in fav_players:
        slug = p.get("team_slug")
        if slug and slug not in team_slugs:
            team_slugs.add(slug)
            rss_sources.append(("MLB.com", f"https://www.mlb.com/{slug}/feeds/news/rss.xml", False))

    for source_name, url in EXTRA_RSS_FEEDS:
        rss_sources.append((source_name, url, False))

    all_entries: list[dict] = []
    for source_name, url, is_fav_team_feed in rss_sources:
        for e in _fetch_rss(url, source_name):
            e["from_fav_team_feed"] = is_fav_team_feed
            all_entries.append(e)

    general_mlb_count = 0
    MAX_GENERAL_MLB = 20

    for entry in all_entries:
        aid = _article_id(entry["link"], entry["title"])
        if aid in seen_article_ids:
            continue

        haystack = f"{entry['title']} {entry['summary']}".lower()
        matched_player: Optional[dict] = None
        for p in fav_players:
            pname = (p.get("full_name") or "").lower()
            if pname and pname in haystack:
                matched_player = p
                break

        is_team = bool(entry.get("from_fav_team_feed"))
        if not is_team and fav_team_name:
            tname_l = fav_team_name.lower()
            tshort_l = fav_team_short.lower()
            if tname_l in haystack or (len(tshort_l) > 3 and tshort_l in haystack):
                is_team = True

        is_mvp = matched_player is not None

        if not is_mvp and not is_team:
            if general_mlb_count >= MAX_GENERAL_MLB:
                continue
            general_mlb_count += 1

        seen_article_ids.add(aid)
        target_name = (
            matched_player["full_name"]
            if matched_player
            else (fav_team_name if is_team else "MLB")
        )

        # Check SQLite cache for Gemini summary
        cached = database.get_cached_summary(aid)
        if cached is not None:
            if not cached["is_safe"]:
                continue
            kid_summary = cached["summary"]
        else:
            res = gemini_agent.summarize_news_for_kids(
                title=entry["title"],
                raw_summary=entry["summary"],
                player_name=target_name,
            )
            database.save_cached_summary(
                article_id=aid,
                url=entry["link"],
                title=entry["title"],
                summary=res["summary"],
                is_safe=res["is_safe"],
                category="MLB News",
            )
            if not res["is_safe"]:
                continue
            kid_summary = res["summary"]

        feed_items.append(
            {
                "id": aid,
                "category": "MLB News",
                "source": entry.get("source", "MLB.com"),
                "title": entry["title"],
                "summary": kid_summary or entry["summary"],
                "player_id": matched_player["player_id"] if matched_player else None,
                "player_name": target_name,
                "headshot_url": mlb_service.headshot_url(matched_player["player_id"]) if matched_player else None,
                "published_at": entry["published_at"],
                "url": entry["link"],
                "is_team": is_team,
                "is_mvp": is_mvp,
            }
        )

    # 2. Roster Transactions & Game Performance Recaps for each favorited player
    fav_team_id = (fav_team or {}).get("team_id")
    for p in fav_players:
        pid = p["player_id"]
        pname = p["full_name"]
        p_headshot = mlb_service.headshot_url(pid)
        p_is_team = bool(fav_team_id and p.get("team_id") == fav_team_id)

        txs = mlb_service.get_player_transactions(pid, limit=4)
        for tx in txs:
            tx_date = tx.get("date") or datetime.now(timezone.utc).date().isoformat()
            iso_dt = f"{tx_date[:10]}T12:00:00+00:00"
            feed_items.append(
                {
                    "id": f"tx-{pid}-{tx.get('id')}",
                    "category": "Roster Move",
                    "source": "MLB.com",
                    "title": f"{pname}: {tx.get('type_desc', 'Roster Move')}",
                    "summary": tx.get("description") or f"Official MLB roster update for {pname}.",
                    "player_id": pid,
                    "player_name": pname,
                    "headshot_url": p_headshot,
                    "published_at": iso_dt,
                    "url": f"https://www.mlb.com/player/{pid}",
                    "is_team": p_is_team,
                    "is_mvp": True,
                }
            )

        try:
            details = mlb_service.get_player_details(pid)
            logs = details.get("last_5_games") or []
            if logs:
                last_g = logs[0]
                g_date = last_g.get("date") or datetime.now(timezone.utc).date().isoformat()
                iso_dt = f"{g_date[:10]}T23:00:00+00:00"
                feed_items.append(
                    {
                        "id": f"game-{pid}-{g_date}",
                        "category": "Game Highlight",
                        "source": "MLB.com",
                        "title": f"{pname} {last_g.get('matchup', '')} ({g_date})",
                        "summary": f"In {pname}'s most recent game {last_g.get('matchup', '')}, they posted: {last_g.get('summary', 'Great effort on the field!')}.",
                        "player_id": pid,
                        "player_name": pname,
                        "headshot_url": p_headshot,
                        "published_at": iso_dt,
                        "url": f"https://www.mlb.com/player/{pid}",
                        "is_team": p_is_team,
                        "is_mvp": True,
                    }
                )
        except Exception:
            pass

    feed_items.sort(key=lambda x: x.get("published_at", ""), reverse=True)

    return {
        "has_favorites": True,
        "team_short_name": fav_team_short,
        "items": feed_items[:60],
        "message": None if feed_items else "No recent articles found yet—check back soon!",
    }
