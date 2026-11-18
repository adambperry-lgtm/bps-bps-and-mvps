import json
import os
from typing import Optional

from google import genai
from google.genai import types

import mlb_service

MODEL_NAME = "gemini-2.5-flash"

SAFETY_SETTINGS = [
    types.SafetySetting(
        category=types.HarmCategory.HARM_CATEGORY_HARASSMENT,
        threshold=types.HarmBlockThreshold.BLOCK_LOW_AND_ABOVE,
    ),
    types.SafetySetting(
        category=types.HarmCategory.HARM_CATEGORY_HATE_SPEECH,
        threshold=types.HarmBlockThreshold.BLOCK_LOW_AND_ABOVE,
    ),
    types.SafetySetting(
        category=types.HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT,
        threshold=types.HarmBlockThreshold.BLOCK_LOW_AND_ABOVE,
    ),
    types.SafetySetting(
        category=types.HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT,
        threshold=types.HarmBlockThreshold.BLOCK_LOW_AND_ABOVE,
    ),
]

SYSTEM_INSTRUCTION = """You are the **BP’s BPs and MVPs Dugout Coach**, a friendly, encouraging, and knowledgeable baseball coach chatting with a 9-to-10-year-old baseball player and fan.

Follow these rules STRICTLY on every single response:
1. **Child-Safe Tone:** Always be positive, encouraging, age-appropriate, and educational. Explain baseball stats and rules clearly so a 9-or-10-year-old can easily understand and enjoy them.
2. **Strict Topic Lock (Baseball Only):** You may ONLY discuss baseball (MLB history, rules, strategy, stats, players, teams, hitting/fielding/pitching tips, youth baseball, ballparks, etc.). If the user asks about ANYTHING unrelated to baseball (such as video games, school homework, movies, politics, coding, general chat, or other non-baseball topics), politely decline with a warm coach-like message and steer the conversation right back to baseball!
3. **Live Data Grounding:** When asked about MLB player stats, team standings, today's games/scores, or recent player news/transactions, ALWAYS use your MLB lookup tools first rather than guessing. If a tool returns no games today (for example, during the offseason or an off-day), explain that clearly and cheerfully.
4. **No Gambling or Adult Themes:** Never discuss sports betting, odds, fantasy gambling, or inappropriate off-field incidents.
"""


def _get_client() -> Optional[genai.Client]:
    api_key = os.getenv("GEMINI_API_KEY", "").strip()
    if not api_key or api_key == "your_gemini_api_key_here":
        return None
    return genai.Client(api_key=api_key)


# --- MLB Function-Calling Tools for Gemini ---

def lookup_mlb_player_stats(player_name: str) -> dict:
    """Look up an MLB player's current team, position, season hitting/pitching stats, and last 5 games."""
    matches = mlb_service.search_players(player_name)
    if not matches:
        return {"found": False, "message": f"No MLB player found matching '{player_name}'."}
    top = matches[0]
    details = mlb_service.get_player_details(top["player_id"])
    return {"found": True, "player": details}


def lookup_mlb_standings(division_or_league: str = "all") -> dict:
    """Look up MLB standings. Pass 'all' or a division/league filter like 'AL East', 'NL West', 'American', 'National'."""
    return mlb_service.get_standings(division_or_league)


def lookup_todays_mlb_scoreboard(date: str = "") -> dict:
    """Look up MLB scoreboard/games for today (or a specific YYYY-MM-DD date)."""
    games = mlb_service.get_todays_scoreboard(date if date else None)
    return {"date": date or "today", "game_count": len(games), "games": games}


def lookup_player_news_and_transactions(player_name: str) -> dict:
    """Look up recent official MLB roster transactions and recent game-log info for a player."""
    matches = mlb_service.search_players(player_name)
    if not matches:
        return {"found": False, "message": f"No MLB player found matching '{player_name}'."}
    top = matches[0]
    pid = top["player_id"]
    txs = mlb_service.get_player_transactions(pid, limit=5)
    details = mlb_service.get_player_details(pid)
    return {
        "found": True,
        "player_name": details.get("full_name"),
        "team": details.get("team_name"),
        "recent_transactions": txs,
        "last_5_games": details.get("last_5_games", []),
    }


MLB_TOOLS = [
    lookup_mlb_player_stats,
    lookup_mlb_standings,
    lookup_todays_mlb_scoreboard,
    lookup_player_news_and_transactions,
]


def chat_with_dugout_coach(history_messages: list[dict], user_message: str) -> str:
    """Send a message to the BP's BPs and MVPs Dugout Coach with up to 20 messages of conversation memory."""
    client = _get_client()
    if client is None:
        return (
            "Hey slugger! It looks like `GEMINI_API_KEY` isn't configured yet in `.env`. "
            "Ask a grown-up to add a valid Gemini API key to `.env` and restart the server so we can talk baseball!"
        )

    contents: list[types.Content] = []
    for msg in history_messages[-20:]:
        role = "model" if msg.get("role") == "assistant" else "user"
        text = (msg.get("content") or "").strip()
        if text:
            contents.append(types.Content(role=role, parts=[types.Part.from_text(text=text)]))

    contents.append(types.Content(role="user", parts=[types.Part.from_text(text=user_message)]))

    config = types.GenerateContentConfig(
        system_instruction=SYSTEM_INSTRUCTION,
        safety_settings=SAFETY_SETTINGS,
        tools=MLB_TOOLS,
        temperature=0.7,
    )

    try:
        response = client.models.generate_content(
            model=MODEL_NAME,
            contents=contents,
            config=config,
        )
        if response.text:
            return response.text.strip()
        return (
            "Whoa, that pitch was a little outside the strike zone! "
            "Let's keep our chat focused on baseball—ask me about your favorite MLB player, team, or hitting tips!"
        )
    except Exception as exc:
        return (
            f"Oops, the dugout radio had a little static ({type(exc).__name__}). "
            "Please check your `GEMINI_API_KEY` or try asking your baseball question again!"
        )


_UNSAFE_KEYWORDS = (
    "betting",
    "odds",
    "draftkings",
    "fanduel",
    "sportsbook",
    "wager",
    "parlay",
    "moneyline",
    "spread",
    "gambling",
    "arrested",
    "dui",
    "domestic",
    "assault",
    "lawsuit",
    "suspension for",
)


def summarize_news_for_kids(title: str, raw_summary: str, player_name: str) -> dict:
    """Filter and summarize an MLB news article into a kid-friendly 2-sentence recap."""
    combined_lower = f"{title} {raw_summary}".lower()
    if any(kw in combined_lower for kw in _UNSAFE_KEYWORDS):
        return {"is_safe": False, "summary": ""}

    client = _get_client()
    if client is None:
        clean = (raw_summary or title).strip()
        if len(clean) > 220:
            clean = clean[:217].rsplit(" ", 1)[0] + "..."
        return {"is_safe": True, "summary": clean}

    prompt = f"""You are a kid-safe baseball editor for 9-to-10-year-old fans on "BP's BPs and MVPs".
Review this MLB news item about {player_name}:
Title: {title}
Details: {raw_summary}

Task:
1. Check if this story is 100% appropriate for a 9-10 year old. Mark is_safe = false if it focuses on sports betting/odds/gambling, or non-kid-appropriate off-field incidents (arrests, violence, legal trouble, adult controversies).
2. If is_safe = true, write an enthusiastic, easy-to-understand 2-sentence summary for a 9-10 year old baseball fan.

Respond ONLY with valid JSON:
{{"is_safe": true, "summary": "..."}}"""

    try:
        resp = client.models.generate_content(
            model=MODEL_NAME,
            contents=prompt,
            config=types.GenerateContentConfig(
                safety_settings=SAFETY_SETTINGS,
                response_mime_type="application/json",
                temperature=0.4,
            ),
        )
        if not resp.text:
            return {"is_safe": False, "summary": ""}
        parsed = json.loads(resp.text)
        return {
            "is_safe": bool(parsed.get("is_safe", True)),
            "summary": str(parsed.get("summary", "")).strip(),
        }
    except Exception:
        clean = (raw_summary or title).strip()
        if len(clean) > 220:
            clean = clean[:217].rsplit(" ", 1)[0] + "..."
        return {"is_safe": True, "summary": clean}
