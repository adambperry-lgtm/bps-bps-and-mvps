import os
import threading
import time
from datetime import datetime, timedelta, timezone
from typing import Any, Optional

import httpx
import statsapi

MLB_API_BASE = "https://statsapi.mlb.com/api/v1"

# Official MLB.com URL slugs for each team ID (used for team RSS feeds)
TEAM_SLUGS: dict[int, str] = {
    108: "angels",
    109: "dbacks",
    110: "orioles",
    111: "redsox",
    112: "cubs",
    113: "reds",
    114: "guardians",
    115: "rockies",
    116: "tigers",
    117: "astros",
    118: "royals",
    119: "dodgers",
    120: "nationals",
    121: "mets",
    133: "athletics",
    134: "pirates",
    135: "padres",
    136: "mariners",
    137: "giants",
    138: "cardinals",
    139: "rays",
    140: "rangers",
    141: "bluejays",
    142: "twins",
    143: "phillies",
    144: "braves",
    145: "whitesox",
    146: "marlins",
    147: "yankees",
    158: "brewers",
}


class TTLCache:
    """Lightweight thread-safe in-memory TTL cache."""

    def __init__(self) -> None:
        self._store: dict[str, tuple[float, Any]] = {}
        self._lock = threading.Lock()

    def get(self, key: str) -> Optional[Any]:
        with self._lock:
            entry = self._store.get(key)
            if not entry:
                return None
            expires_at, value = entry
            if time.time() > expires_at:
                del self._store[key]
                return None
            return value

    def set(self, key: str, value: Any, ttl_seconds: int) -> None:
        with self._lock:
            self._store[key] = (time.time() + ttl_seconds, value)


def make_http_client() -> httpx.Client:
    try:
        return httpx.Client(timeout=12.0, follow_redirects=True)
    except httpx.InvalidURL:
        proxy = os.environ.get("HTTPS_PROXY") or os.environ.get("HTTP_PROXY")
        verify = os.environ.get("SSL_CERT_FILE") or os.environ.get("REQUESTS_CA_BUNDLE") or True
        return httpx.Client(timeout=12.0, follow_redirects=True, proxy=proxy, verify=verify, trust_env=False)


_cache = TTLCache()
_http_client = make_http_client()

TTL_LIVE = 60          # 60 seconds for live games & scoreboard
TTL_TRANSACTIONS = 900 # 15 minutes for transactions
TTL_STATS = 3600       # 1 hour for season stats & teams


def headshot_url(player_id: int) -> str:
    return (
        "https://img.mlbstatic.com/mlb-photos/image/upload/"
        "d_people:generic:headshot:67:current.png/w_213,q_auto:best/"
        f"v1/people/{player_id}/headshot/67/current"
    )


def _get_json(path: str, params: Optional[dict] = None) -> dict:
    url = f"{MLB_API_BASE}{path}"
    resp = _http_client.get(url, params=params)
    resp.raise_for_status()
    return resp.json()


def get_team_slug(team_id: Optional[int], team_name: Optional[str] = None) -> str:
    if team_id and team_id in TEAM_SLUGS:
        return TEAM_SLUGS[team_id]
    if team_name:
        return team_name.lower().replace(" ", "").replace(".", "")
    return ""


def get_mlb_teams() -> list[dict]:
    cached = _cache.get("mlb_teams")
    if cached is not None:
        return cached

    data = _get_json("/teams", params={"sportId": 1})
    teams = []
    for t in data.get("teams", []):
        tid = t.get("id")
        teams.append(
            {
                "team_id": tid,
                "team_name": t.get("name"),
                "abbreviation": t.get("abbreviation"),
                "team_short_name": t.get("teamName"),
                "location_name": t.get("locationName"),
                "division": (t.get("division") or {}).get("name"),
                "league": (t.get("league") or {}).get("name"),
                "team_slug": get_team_slug(tid, t.get("teamName")),
            }
        )
    teams.sort(key=lambda x: x["team_name"] or "")
    _cache.set("mlb_teams", teams, TTL_STATS)
    return teams


def search_players(query: str) -> list[dict]:
    q = query.strip()
    if not q:
        return []
    cache_key = f"search:{q.lower()}"
    cached = _cache.get(cache_key)
    if cached is not None:
        return cached

    results: list[dict] = []
    seen_ids: set[int] = set()

    # Direct MLB Stats API search (covers active + historical MLB players)
    try:
        data = _get_json(
            "/people/search",
            params={"names": q, "sportIds": 1, "hydrate": "currentTeam"},
        )
        for p in data.get("people", [])[:25]:
            pid = p.get("id")
            if not pid or pid in seen_ids:
                continue
            seen_ids.add(pid)
            team = p.get("currentTeam") or {}
            tid = team.get("id")
            pos = (p.get("primaryPosition") or {}).get("abbreviation") or (
                p.get("primaryPosition") or {}
            ).get("name")
            results.append(
                {
                    "player_id": pid,
                    "full_name": p.get("fullName"),
                    "position": pos or "N/A",
                    "team_id": tid,
                    "team_name": team.get("name") or ("Retired / Free Agent" if not p.get("active") else "Free Agent"),
                    "team_slug": get_team_slug(tid, team.get("name")),
                    "active": bool(p.get("active", False)),
                    "headshot_url": headshot_url(pid),
                }
            )
    except Exception:
        pass

    # Fallback via MLB-StatsAPI lookup_player if needed
    if not results:
        try:
            for p in statsapi.lookup_player(q)[:20]:
                pid = p.get("id")
                if not pid or pid in seen_ids:
                    continue
                seen_ids.add(pid)
                tid = (p.get("currentTeam") or {}).get("id")
                results.append(
                    {
                        "player_id": pid,
                        "full_name": p.get("fullName"),
                        "position": (p.get("primaryPosition") or {}).get("abbreviation", "N/A"),
                        "team_id": tid,
                        "team_name": "MLB",
                        "team_slug": get_team_slug(tid),
                        "active": bool(p.get("active", True)),
                        "headshot_url": headshot_url(pid),
                    }
                )
        except Exception:
            pass

    # Sort active players first
    results.sort(key=lambda x: (not x["active"], x["full_name"] or ""))
    _cache.set(cache_key, results, TTL_TRANSACTIONS)
    return results


def _extract_hitting_stats(splits: list[dict]) -> Optional[dict]:
    if not splits:
        return None
    # Prefer the combined season split (no team filter) or last split
    chosen = splits[-1]
    for s in splits:
        if "team" not in s:
            chosen = s
            break
    stat = chosen.get("stat") or {}
    return {
        "season": chosen.get("season", ""),
        "games": stat.get("gamesPlayed", 0),
        "at_bats": stat.get("atBats", 0),
        "runs": stat.get("runs", 0),
        "hits": stat.get("hits", 0),
        "doubles": stat.get("doubles", 0),
        "triples": stat.get("triples", 0),
        "hr": stat.get("homeRuns", 0),
        "rbi": stat.get("rbi", 0),
        "sb": stat.get("stolenBases", 0),
        "walks": stat.get("baseOnBalls", 0),
        "strikeouts": stat.get("strikeOuts", 0),
        "avg": stat.get("avg", ".000"),
        "obp": stat.get("obp", ".000"),
        "slg": stat.get("slg", ".000"),
        "ops": stat.get("ops", ".000"),
    }


def _extract_pitching_stats(splits: list[dict]) -> Optional[dict]:
    if not splits:
        return None
    chosen = splits[-1]
    for s in splits:
        if "team" not in s:
            chosen = s
            break
    stat = chosen.get("stat") or {}
    wins = stat.get("wins", 0)
    losses = stat.get("losses", 0)
    return {
        "season": chosen.get("season", ""),
        "games": stat.get("gamesPlayed", 0),
        "games_started": stat.get("gamesStarted", 0),
        "era": stat.get("era", "0.00"),
        "whip": stat.get("whip", "0.00"),
        "strikeouts": stat.get("strikeOuts", 0),
        "walks": stat.get("baseOnBalls", 0),
        "hits": stat.get("hits", 0),
        "earned_runs": stat.get("earnedRuns", 0),
        "innings_pitched": stat.get("inningsPitched", "0.0"),
        "wins": wins,
        "losses": losses,
        "w_l": f"{wins}-{losses}",
        "saves": stat.get("saves", 0),
    }


def _format_game_log(splits: list[dict], is_pitcher: bool) -> list[dict]:
    logs = []
    # Most recent 5 games
    for s in reversed(splits[-5:]):
        stat = s.get("stat") or {}
        opp = (s.get("opponent") or {}).get("name", "OPP")
        date = s.get("date", "")
        is_home = s.get("isHome", True)
        prefix = "vs" if is_home else "@"
        if is_pitcher and ("inningsPitched" in stat or "earnedRuns" in stat):
            summary = (
                f"{stat.get('inningsPitched', '0.0')} IP, "
                f"{stat.get('hits', 0)} H, "
                f"{stat.get('earnedRuns', 0)} ER, "
                f"{stat.get('strikeOuts', 0)} K"
            )
        else:
            hr = stat.get("homeRuns", 0)
            rbi = stat.get("rbi", 0)
            extras = []
            if hr:
                extras.append(f"{hr} HR")
            if rbi:
                extras.append(f"{rbi} RBI")
            extra_str = f" ({', '.join(extras)})" if extras else ""
            summary = f"{stat.get('hits', 0)}-for-{stat.get('atBats', 0)}{extra_str}"
        logs.append(
            {
                "date": date,
                "matchup": f"{prefix} {opp}",
                "summary": summary,
                "stat": stat,
            }
        )
    return logs


def get_player_details(player_id: int) -> dict:
    cache_key = f"player_details:{player_id}"
    cached = _cache.get(cache_key)
    if cached is not None:
        return cached

    current_year = datetime.now().year
    candidate_seasons = [current_year, current_year - 1, current_year - 2]

    person_data = _get_json(f"/people/{player_id}", params={"hydrate": "currentTeam"})
    people = person_data.get("people", [])
    if not people:
        raise ValueError(f"Player {player_id} not found")
    p = people[0]

    team = p.get("currentTeam") or {}
    tid = team.get("id")
    pos_info = p.get("primaryPosition") or {}
    pos_abbr = pos_info.get("abbreviation", "N/A")
    is_pitcher = pos_abbr == "P" or pos_info.get("type") == "Pitcher"

    hitting_stats = None
    pitching_stats = None
    last_5_games: list[dict] = []
    season_used = None

    # Find most recent season with stats
    for yr in candidate_seasons:
        try:
            s_data = _get_json(
                f"/people/{player_id}/stats",
                params={
                    "stats": "season,gameLog",
                    "group": "hitting,pitching",
                    "season": yr,
                },
            )
            stats_blocks = s_data.get("stats", [])
            yr_hitting = None
            yr_pitching = None
            yr_h_logs: list[dict] = []
            yr_p_logs: list[dict] = []

            for block in stats_blocks:
                stype = (block.get("type") or {}).get("displayName", "")
                group = (block.get("group") or {}).get("displayName", "")
                splits = block.get("splits", [])
                if not splits:
                    continue
                if stype == "season" and group == "hitting":
                    yr_hitting = _extract_hitting_stats(splits)
                elif stype == "season" and group == "pitching":
                    yr_pitching = _extract_pitching_stats(splits)
                elif stype == "gameLog" and group == "hitting":
                    yr_h_logs = splits
                elif stype == "gameLog" and group == "pitching":
                    yr_p_logs = splits

            if yr_hitting or yr_pitching:
                hitting_stats = yr_hitting
                pitching_stats = yr_pitching
                season_used = yr
                if is_pitcher and yr_p_logs:
                    last_5_games = _format_game_log(yr_p_logs, is_pitcher=True)
                elif yr_h_logs:
                    last_5_games = _format_game_log(yr_h_logs, is_pitcher=False)
                elif yr_p_logs:
                    last_5_games = _format_game_log(yr_p_logs, is_pitcher=True)
                break
        except Exception:
            continue

    # Always fetch career stats for active and historical players
    career_hitting_stats = None
    career_pitching_stats = None
    try:
        c_data = _get_json(
            f"/people/{player_id}/stats",
            params={"stats": "career", "group": "hitting,pitching"},
        )
        for block in c_data.get("stats", []):
            group = (block.get("group") or {}).get("displayName", "")
            splits = block.get("splits", [])
            if group == "hitting" and splits:
                career_hitting_stats = _extract_hitting_stats(splits)
                career_hitting_stats["season"] = "Career"
            elif group == "pitching" and splits:
                career_pitching_stats = _extract_pitching_stats(splits)
                career_pitching_stats["season"] = "Career"
    except Exception:
        pass

    # Historical fallback: if no recent season stats found, mirror career stats into primary fields
    if not hitting_stats and not pitching_stats:
        hitting_stats = career_hitting_stats
        pitching_stats = career_pitching_stats
        if hitting_stats or pitching_stats:
            season_used = "Career"

    result = {
        "player_id": player_id,
        "full_name": p.get("fullName"),
        "headshot_url": headshot_url(player_id),
        "team_id": tid,
        "team_name": team.get("name") or ("Retired / Historical" if not p.get("active") else "Free Agent"),
        "team_slug": get_team_slug(tid, team.get("name")),
        "position": pos_abbr,
        "position_name": pos_info.get("name", pos_abbr),
        "bats": (p.get("batSide") or {}).get("code", "—"),
        "throws": (p.get("pitchHand") or {}).get("code", "—"),
        "age": p.get("currentAge"),
        "height": p.get("height", ""),
        "weight": p.get("weight", ""),
        "birth_date": p.get("birthDate", ""),
        "mlb_debut_date": p.get("mlbDebutDate", ""),
        "jersey_number": p.get("primaryNumber"),
        "active": bool(p.get("active", False)),
        "is_pitcher": is_pitcher,
        "season_used": season_used,
        "hitting_stats": hitting_stats,
        "pitching_stats": pitching_stats,
        "career_hitting_stats": career_hitting_stats,
        "career_pitching_stats": career_pitching_stats,
        "last_5_games": last_5_games,
    }
    _cache.set(cache_key, result, TTL_STATS)
    return result


def _parse_game_summary(g: dict) -> dict:
    status = g.get("status") or {}
    teams = g.get("teams") or {}
    away = teams.get("away") or {}
    home = teams.get("home") or {}
    linescore = g.get("linescore") or {}
    offense = linescore.get("offense") or {}
    defense = linescore.get("defense") or {}

    return {
        "game_pk": g.get("gamePk"),
        "game_date": g.get("officialDate") or g.get("gameDate", "")[:10],
        "game_datetime": g.get("gameDate"),
        "abstract_state": status.get("abstractGameState"),  # Preview, Live, Final
        "detailed_state": status.get("detailedState"),
        "venue": (g.get("venue") or {}).get("name"),
        "away_team": (away.get("team") or {}).get("name"),
        "away_abbr": (away.get("team") or {}).get("abbreviation"),
        "away_score": away.get("score"),
        "home_team": (home.get("team") or {}).get("name"),
        "home_abbr": (home.get("team") or {}).get("abbreviation"),
        "home_score": home.get("score"),
        "inning": linescore.get("currentInningOrdinal"),
        "inning_state": linescore.get("inningState"),
        "balls": linescore.get("balls"),
        "strikes": linescore.get("strikes"),
        "outs": linescore.get("outs"),
        "current_pitcher": (defense.get("pitcher") or {}).get("fullName"),
        "current_batter": (offense.get("batter") or {}).get("fullName"),
    }


def get_team_live_status(team_id: int) -> dict:
    cache_key = f"team_live:{team_id}"
    cached = _cache.get(cache_key)
    if cached is not None:
        return cached

    today = datetime.now(timezone.utc).date()
    start_date = (today - timedelta(days=10)).isoformat()
    end_date = (today + timedelta(days=10)).isoformat()
    today_str = today.isoformat()

    data = _get_json(
        "/schedule",
        params={
            "sportId": 1,
            "teamId": team_id,
            "startDate": start_date,
            "endDate": end_date,
            "hydrate": "linescore,team",
        },
    )

    all_games: list[dict] = []
    for d in data.get("dates", []):
        for g in d.get("games", []):
            all_games.append(_parse_game_summary(g))

    today_game = None
    next_game = None
    last_final_game = None

    for g in all_games:
        if g["game_date"] == today_str:
            today_game = g
        if g["abstract_state"] == "Final":
            last_final_game = g
        elif g["abstract_state"] == "Preview" and next_game is None and g["game_date"] >= today_str:
            next_game = g

    result = {
        "team_id": team_id,
        "today_game": today_game,
        "next_game": next_game,
        "last_final_game": last_final_game,
    }
    _cache.set(cache_key, result, TTL_LIVE)
    return result


def get_todays_scoreboard(date_str: Optional[str] = None) -> list[dict]:
    target_date = date_str.strip() if date_str else datetime.now(timezone.utc).date().isoformat()
    cache_key = f"scoreboard:{target_date}"
    cached = _cache.get(cache_key)
    if cached is not None:
        return cached

    data = _get_json(
        "/schedule",
        params={
            "sportId": 1,
            "date": target_date,
            "hydrate": "linescore,team",
        },
    )
    games: list[dict] = []
    for d in data.get("dates", []):
        for g in d.get("games", []):
            games.append(_parse_game_summary(g))

    _cache.set(cache_key, games, TTL_LIVE)
    return games


def get_standings(division_or_league: str = "all") -> dict:
    cache_key = f"standings:{division_or_league.lower()}"
    cached = _cache.get(cache_key)
    if cached is not None:
        return cached

    current_year = datetime.now().year
    for yr in (current_year, current_year - 1):
        try:
            raw = statsapi.standings_data(season=yr)
            if raw:
                formatted = {}
                for _, div in raw.items():
                    div_name = div.get("div_name", "Division")
                    if division_or_league != "all" and division_or_league.lower() not in div_name.lower():
                        continue
                    formatted[div_name] = [
                        {
                            "name": t.get("name"),
                            "w": t.get("w"),
                            "l": t.get("l"),
                            "gb": t.get("gb"),
                            "wc_gb": t.get("wc_gb"),
                        }
                        for t in div.get("teams", [])
                    ]
                result = {"season": yr, "divisions": formatted}
                _cache.set(cache_key, result, TTL_STATS)
                return result
        except Exception:
            continue

    return {"season": current_year, "divisions": {}}


def get_player_transactions(player_id: int, limit: int = 8) -> list[dict]:
    cache_key = f"transactions:{player_id}"
    cached = _cache.get(cache_key)
    if cached is not None:
        return cached

    try:
        data = _get_json("/transactions", params={"playerId": player_id})
        txs = []
        for t in reversed(data.get("transactions", [])):
            txs.append(
                {
                    "id": str(t.get("id", "")),
                    "date": t.get("date") or t.get("effectiveDate") or "",
                    "type_desc": t.get("typeDesc", "Roster Move"),
                    "description": t.get("description", ""),
                    "player_id": player_id,
                }
            )
            if len(txs) >= limit:
                break
        _cache.set(cache_key, txs, TTL_TRANSACTIONS)
        return txs
    except Exception:
        return []
