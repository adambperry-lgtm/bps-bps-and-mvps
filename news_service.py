import hashlib
import re
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from typing import Optional

import feedparser
import httpx

import database
import gemini_agent
import mlb_service

_rss_cache = mlb_service.TTLCache()
_rss_client = mlb_service.make_http_client()
TTL_RSS = 900  # 15 minutes


def _strip_html(raw: str) -> str:
    text = re.sub(r"<[^>]+>", " ", raw or "")
    return re.sub(r"\s+", " ", text).strip()


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


def _fetch_rss(url: str) -> list[dict]:
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


def get_followed_player_newsfeed() -> dict:
    fav_players = database.get_favorite_players()
    fav_team = database.get_favorite_team()

    if not fav_players and not fav_team:
        return {
            "has_favorites": False,
            "items": [],
            "message": "Follow your favorite MLB players or team in the BPs & MVPs Tracker to see their kid-safe newsfeed here!",
        }

    feed_items: list[dict] = []
    seen_article_ids: set[str] = set()

    # 1. Collect RSS feeds (main MLB + unique team slugs for followed players & team)
    rss_urls = ["https://www.mlb.com/feeds/news/rss.xml"]
    team_slugs: set[str] = set()
    for p in fav_players:
        if p.get("team_slug"):
            team_slugs.add(p["team_slug"])
    if fav_team and fav_team.get("team_slug"):
        team_slugs.add(fav_team["team_slug"])

    for slug in sorted(team_slugs):
        rss_urls.append(f"https://www.mlb.com/{slug}/feeds/news/rss.xml")

    all_entries: list[dict] = []
    for url in rss_urls:
        all_entries.extend(_fetch_rss(url))

    # Match RSS articles to favorited players or favorite team
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

        team_match = False
        if not matched_player and fav_team:
            tname = (fav_team.get("team_name") or "").lower()
            tshort = tname.split()[-1] if tname else ""
            if (tname and tname in haystack) or (tshort and len(tshort) > 3 and tshort in haystack):
                team_match = True

        if not matched_player and not team_match:
            continue

        seen_article_ids.add(aid)
        target_name = matched_player["full_name"] if matched_player else fav_team["team_name"]

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
                "title": entry["title"],
                "summary": kid_summary or entry["summary"],
                "player_id": matched_player["player_id"] if matched_player else None,
                "player_name": target_name,
                "headshot_url": mlb_service.headshot_url(matched_player["player_id"]) if matched_player else None,
                "published_at": entry["published_at"],
                "url": entry["link"],
            }
        )

    # 2. Roster Transactions & Game Performance Recaps for each favorited player
    for p in fav_players:
        pid = p["player_id"]
        pname = p["full_name"]
        p_headshot = mlb_service.headshot_url(pid)

        # Official Roster Moves
        txs = mlb_service.get_player_transactions(pid, limit=4)
        for tx in txs:
            tx_date = tx.get("date") or datetime.now(timezone.utc).date().isoformat()
            iso_dt = f"{tx_date[:10]}T12:00:00+00:00"
            feed_items.append(
                {
                    "id": f"tx-{pid}-{tx.get('id')}",
                    "category": "Roster Move",
                    "title": f"{pname}: {tx.get('type_desc', 'Roster Move')}",
                    "summary": tx.get("description") or f"Official MLB roster update for {pname}.",
                    "player_id": pid,
                    "player_name": pname,
                    "headshot_url": p_headshot,
                    "published_at": iso_dt,
                    "url": f"https://www.mlb.com/player/{pid}",
                }
            )

        # Recent Game Performance Recap from last game
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
                        "title": f"{pname} {last_g.get('matchup', '')} ({g_date})",
                        "summary": f"In {pname}'s most recent game {last_g.get('matchup', '')}, they posted: {last_g.get('summary', 'Great effort on the field!')}.",
                        "player_id": pid,
                        "player_name": pname,
                        "headshot_url": p_headshot,
                        "published_at": iso_dt,
                        "url": f"https://www.mlb.com/player/{pid}",
                    }
                )
        except Exception:
            pass

    # Sort chronologically (newest first)
    feed_items.sort(key=lambda x: x.get("published_at", ""), reverse=True)

    return {
        "has_favorites": True,
        "items": feed_items[:40],
        "message": None if feed_items else "No recent articles found yet—check back soon or follow more players!",
    }
