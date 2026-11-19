import json
import os
import re
import unicodedata
from typing import Optional

from google import genai
from google.genai import types

import database
import mlb_service

MODEL_NAME = "gemini-3.5-flash-lite"
MODEL_CANDIDATES = [
    "gemini-3.5-flash-lite",
    "gemini-3.1-flash-lite",
    "gemini-3.8-flash",
    "gemini-3.6-flash",
]

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
1. **Child-Safe, Natural Tone:** Be warm, upbeat, supportive, age-appropriate, and educational—like a real coach chatting in the dugout, not an over-the-top hype announcer. Keep your enthusiasm around an 8 out of 10: genuinely fun and encouraging, while using exclamation marks, baseball catchphrases, and praise naturally rather than on every sentence. Explain baseball stats and rules clearly so a 9-or-10-year-old can easily understand and enjoy them.
2. **Easygoing Follow-Up Questions:** Let your answers stand on their own without feeling like you have to end every single reply with a follow-up question. It's totally fine to add a brief, natural follow-up question now and then when it fits the conversation, but keep it light and never stack multiple questions at the end of a response.
3. **Strict Topic Lock (Baseball Only):** You may ONLY discuss baseball (MLB history, rules, strategy, stats, players, teams, hitting/fielding/pitching tips, youth baseball, ballparks, etc.). If the user asks about ANYTHING unrelated to baseball (such as video games, school homework, movies, politics, coding, general chat, or other non-baseball topics), politely decline with a warm coach-like message and steer the conversation back to baseball.
4. **Live Data Grounding:** When asked about MLB player stats, team standings, today's games/scores, or recent player news/transactions, ALWAYS use your MLB lookup tools first rather than guessing. If a tool returns no games today (for example, during the offseason or an off-day), explain that clearly and warmly.
5. **My MVPs Management:** If the user asks to add or follow a player in their My MVPs list (for example, "add Bryce Harper to my MVPs" or "follow Shohei Ohtani"), ALWAYS call `add_player_to_my_mvps` rather than pretending you added them. If the tool reports multiple matching players, briefly list the top candidates and ask which one they meant. If they ask who is currently in their My MVPs, call `list_my_mvps`.
6. **No Gambling or Adult Themes:** Never discuss sports betting, odds, fantasy gambling, or inappropriate off-field incidents.
"""


def _get_client(api_version: Optional[str] = None) -> Optional[genai.Client]:
    api_key = os.getenv("GEMINI_API_KEY", "").strip().strip('"').strip("'")
    if not api_key or api_key == "your_gemini_api_key_here":
        return None
    http_kwargs: dict = {"timeout": 12_000}
    if hasattr(types, "HttpRetryOptions"):
        http_kwargs["retry_options"] = types.HttpRetryOptions(attempts=1)
    if api_version:
        http_kwargs["api_version"] = api_version
    return genai.Client(api_key=api_key, http_options=types.HttpOptions(**http_kwargs))


# --- MLB Function-Calling Tools for Gemini ---

_NAME_SUFFIX_RE = re.compile(r"\b(jr|sr|ii|iii|iv)\b$")


def _normalize_name(name: str, strip_suffix: bool = False) -> str:
    decomposed = unicodedata.normalize("NFKD", name or "")
    ascii_only = "".join(ch for ch in decomposed if not unicodedata.combining(ch))
    cleaned = re.sub(r"[^a-z0-9\s]", " ", ascii_only.lower())
    cleaned = " ".join(cleaned.split())
    if strip_suffix:
        cleaned = _NAME_SUFFIX_RE.sub("", cleaned).strip()
    return cleaned


def _resolve_player_match(
    matches: list[dict], player_name: str, team_name: str = ""
) -> tuple[Optional[dict], list[dict]]:
    """Return (selected_player, ambiguous_candidates) from MLB search matches."""
    if not matches:
        return None, []

    pool = matches
    team_filter = _normalize_name(team_name)
    if team_filter:
        filtered = [
            m
            for m in pool
            if team_filter in _normalize_name(m.get("team_name") or "")
            or team_filter in _normalize_name(m.get("team_slug") or "")
        ]
        if filtered:
            pool = filtered

    q_exact = _normalize_name(player_name)
    q_base = _normalize_name(player_name, strip_suffix=True)

    exact = [
        m
        for m in pool
        if _normalize_name(m.get("full_name") or "") == q_exact
        or (q_base and _normalize_name(m.get("full_name") or "", strip_suffix=True) == q_base)
    ]
    if len(exact) == 1:
        return exact[0], []
    if len(exact) > 1:
        active_exact = [m for m in exact if m.get("active")]
        if len(active_exact) == 1:
            return active_exact[0], []
        if len(active_exact) > 1:
            return None, active_exact[:5]
        return None, exact[:5]

    active_pool = [m for m in pool if m.get("active")]
    if len(active_pool) == 1:
        return active_pool[0], []
    if len(active_pool) > 1:
        return None, active_pool[:5]

    if len(pool) == 1:
        return pool[0], []
    return None, pool[:5]


def lookup_mlb_player_stats(player_name: str) -> dict:
    """Look up an MLB player's current team, position, season hitting/pitching stats, and last 5 games."""
    matches = mlb_service.search_players(player_name)
    if not matches:
        return {"found": False, "message": f"No MLB player found matching '{player_name}'."}
    selected, _ = _resolve_player_match(matches, player_name)
    top = selected or matches[0]
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
    selected, _ = _resolve_player_match(matches, player_name)
    top = selected or matches[0]
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


def add_player_to_my_mvps(player_name: str, team_name: str = "") -> dict:
    """Add an MLB player (active or historical) to the user's My MVPs (followed players) list.

    Pass optional team_name (e.g., 'Dodgers', 'Phillies') if needed to disambiguate players with the same name.
    """
    matches = mlb_service.search_players(player_name)
    if not matches:
        return {
            "added": False,
            "found": False,
            "message": f"No MLB player found matching '{player_name}'.",
        }

    selected, candidates = _resolve_player_match(matches, player_name, team_name=team_name)
    if selected is None:
        return {
            "added": False,
            "found": True,
            "ambiguous": True,
            "message": f"Multiple MLB players match '{player_name}'. Ask the user which one they mean.",
            "candidates": [
                {
                    "player_id": c.get("player_id"),
                    "full_name": c.get("full_name"),
                    "team_name": c.get("team_name"),
                    "position": c.get("position"),
                    "active": c.get("active"),
                }
                for c in candidates
            ],
        }

    pid = selected["player_id"]
    existing = database.get_favorite_players()
    already = next((p for p in existing if p["player_id"] == pid), None)
    if already:
        return {
            "added": False,
            "already_in_mvps": True,
            "player": {
                "player_id": already["player_id"],
                "full_name": already["full_name"],
                "team_name": already.get("team_name"),
                "position": already.get("position"),
            },
            "message": f"{already['full_name']} is already in My MVPs.",
        }

    try:
        details = mlb_service.get_player_details(pid)
        saved = database.add_favorite_player(
            player_id=details["player_id"],
            full_name=details["full_name"],
            team_id=details.get("team_id"),
            team_name=details.get("team_name"),
            team_slug=details.get("team_slug"),
            position=details.get("position"),
        )
    except Exception:
        saved = database.add_favorite_player(
            player_id=pid,
            full_name=selected.get("full_name") or player_name,
            team_id=selected.get("team_id"),
            team_name=selected.get("team_name"),
            team_slug=selected.get("team_slug"),
            position=selected.get("position"),
        )

    return {
        "added": True,
        "already_in_mvps": False,
        "player": {
            "player_id": saved["player_id"],
            "full_name": saved["full_name"],
            "team_name": saved.get("team_name"),
            "position": saved.get("position"),
        },
        "message": f"Added {saved['full_name']} to My MVPs.",
    }


def list_my_mvps() -> dict:
    """List the MLB players currently in the user's My MVPs (followed players) list."""
    mvps = database.get_favorite_players()
    return {
        "count": len(mvps),
        "players": [
            {
                "player_id": p["player_id"],
                "full_name": p["full_name"],
                "team_name": p.get("team_name"),
                "position": p.get("position"),
            }
            for p in mvps
        ],
    }


MLB_TOOLS = [
    lookup_mlb_player_stats,
    lookup_mlb_standings,
    lookup_todays_mlb_scoreboard,
    lookup_player_news_and_transactions,
    add_player_to_my_mvps,
    list_my_mvps,
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

    config_kwargs: dict = {
        "system_instruction": SYSTEM_INSTRUCTION,
        "safety_settings": SAFETY_SETTINGS,
        "tools": MLB_TOOLS,
        "temperature": 0.7,
    }
    if hasattr(types, "ThinkingConfig"):
        try:
            config_kwargs["thinking_config"] = types.ThinkingConfig(thinking_level="low")
        except TypeError:
            pass
    config = types.GenerateContentConfig(**config_kwargs)

    try:
        import time

        def _should_try_next_model(exc: Exception) -> bool:
            s = f"{type(exc).__name__} {exc}"
            return any(
                k in s
                for k in (
                    "404",
                    "NOT_FOUND",
                    "no longer available",
                    "503",
                    "UNAVAILABLE",
                    "high demand",
                    "overloaded",
                    "429",
                    "RESOURCE_EXHAUSTED",
                    "Timeout",
                    "timeout",
                    "DEADLINE_EXCEEDED",
                )
            )

        response = None
        first_exc = None
        last_exc = None
        deadline = time.monotonic() + 40.0
        for model_id in MODEL_CANDIDATES:
            if time.monotonic() > deadline:
                break
            try:
                response = client.models.generate_content(
                    model=model_id,
                    contents=contents,
                    config=config,
                )
                break
            except Exception as model_exc:
                if first_exc is None:
                    first_exc = model_exc
                last_exc = model_exc
                err_str = str(model_exc)
                if _should_try_next_model(model_exc):
                    print(
                        f"[Gemini Fallback] {model_id} failed ({type(model_exc).__name__}): {model_exc}",
                        flush=True,
                    )
                    time.sleep(0.2)
                    continue
                if any(hint in err_str for hint in ("Unknown name", "v1", "not found for API version")):
                    v1beta_client = _get_client(api_version="v1beta")
                    if v1beta_client is not None:
                        try:
                            response = v1beta_client.models.generate_content(
                                model=model_id,
                                contents=contents,
                                config=config,
                            )
                            break
                        except Exception as inner_exc:
                            if first_exc is None:
                                first_exc = inner_exc
                            last_exc = inner_exc
                            if _should_try_next_model(inner_exc):
                                print(
                                    f"[Gemini Fallback] {model_id} (v1beta) failed ({type(inner_exc).__name__}): {inner_exc}",
                                    flush=True,
                                )
                                time.sleep(0.2)
                                continue
                            raise
                raise

        if response is None and (first_exc is not None or last_exc is not None):
            raise first_exc or last_exc

        if response and response.text:
            return response.text.strip()
        return (
            "Whoa, that pitch was a little outside the strike zone! "
            "Let's keep our chat focused on baseball—ask me about your favorite MLB player, team, or hitting tips!"
        )
    except Exception as exc:
        print(f"[Gemini Error] {type(exc).__name__}: {exc}", flush=True)
        detail = str(exc).strip().replace("\n", " ")
        if len(detail) > 160:
            detail = detail[:157] + "..."
        return (
            f"Oops, the dugout radio had a little static ({type(exc).__name__}: {detail}). "
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


# --- Gemini Text-to-Speech (TTS) ---

TTS_MODEL_CANDIDATES = [
    "gemini-3.8-flash-lite-tts",
    "gemini-3.8-flash-tts",
    "gemini-3.1-flash-tts-preview",
    "gemini-2.5-flash-preview-tts",
]
_tts_cache = mlb_service.TTLCache()


def _pcm_to_wav(pcm_bytes: bytes, sample_rate: int = 24000) -> bytes:
    import io
    import wave

    buf = io.BytesIO()
    with wave.open(buf, "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(sample_rate)
        wf.writeframes(pcm_bytes)
    return buf.getvalue()


def synthesize_speech(text: str, voice_name: str = "Puck") -> tuple[bytes, str]:
    """Generate natural-sounding WAV audio for article/chat read-aloud via Gemini TTS."""
    import hashlib

    clean_text = " ".join((text or "").split())[:2800]
    if not clean_text:
        raise ValueError("No text provided for speech synthesis.")

    allowed_voices = {"Puck", "Kore", "Charon", "Zephyr", "Fenrir", "Aoede"}
    voice = voice_name if voice_name in allowed_voices else "Puck"

    cache_key = f"tts:{voice}:{hashlib.sha256(clean_text.encode('utf-8')).hexdigest()[:20]}"
    cached = _tts_cache.get(cache_key)
    if cached is not None:
        return cached

    client = _get_client()
    if client is None:
        raise RuntimeError("GEMINI_API_KEY is not configured.")

    prompt = (
        "Read the following baseball story or message in a warm, natural, engaging tone "
        "suitable for a young baseball fan:\n\n" + clean_text
    )

    config = types.GenerateContentConfig(
        response_modalities=["AUDIO"],
        speech_config=types.SpeechConfig(
            voice_config=types.VoiceConfig(
                prebuilt_voice_config=types.PrebuiltVoiceConfig(voice_name=voice)
            )
        ),
    )

    import time

    def _is_retryable(exc: Exception) -> bool:
        s = str(exc)
        return any(
            k in s
            for k in (
                "404",
                "NOT_FOUND",
                "no longer available",
                "503",
                "UNAVAILABLE",
                "high demand",
                "overloaded",
                "429",
                "RESOURCE_EXHAUSTED",
            )
        )

    response = None
    last_exc = None
    for model_id in TTS_MODEL_CANDIDATES:
        try:
            response = client.models.generate_content(
                model=model_id,
                contents=prompt,
                config=config,
            )
            break
        except Exception as exc:
            last_exc = exc
            err_str = str(exc)
            if _is_retryable(exc):
                time.sleep(0.4)
                continue
            if any(hint in err_str for hint in ("Unknown name", "v1", "not found for API version")):
                v1beta_client = _get_client(api_version="v1beta")
                if v1beta_client is not None:
                    try:
                        response = v1beta_client.models.generate_content(
                            model=model_id,
                            contents=prompt,
                            config=config,
                        )
                        break
                    except Exception as inner_exc:
                        last_exc = inner_exc
                        if _is_retryable(inner_exc):
                            time.sleep(0.4)
                            continue
                        raise
            raise

    if response is None:
        raise last_exc or RuntimeError("No Gemini TTS model available.")

    part = response.candidates[0].content.parts[0]
    inline = part.inline_data
    audio_bytes = inline.data
    mime = (inline.mime_type or "audio/pcm").lower()

    if "wav" in mime:
        result = (audio_bytes, "audio/wav")
    elif "mpeg" in mime or "mp3" in mime:
        result = (audio_bytes, "audio/mpeg")
    else:
        result = (_pcm_to_wav(audio_bytes, sample_rate=24000), "audio/wav")

    _tts_cache.set(cache_key, result, 1800)
    return result

