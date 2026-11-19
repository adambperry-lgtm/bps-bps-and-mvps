import uuid
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Optional

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, Query
from fastapi.responses import FileResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

load_dotenv()

import database  # noqa: E402
import gemini_agent  # noqa: E402
import mlb_service  # noqa: E402
import news_service  # noqa: E402


@asynccontextmanager
async def lifespan(app: FastAPI):
    database.init_db()
    yield


app = FastAPI(
    title="BP’s BPs and MVPs",
    description="Child-safe, baseball-only web application with Dugout Chat, BPs & MVPs Tracker, and Player Newsfeed.",
    lifespan=lifespan,
)


@app.middleware("http")
async def add_cache_headers(request, call_next):
    response = await call_next(request)
    if request.url.path.startswith("/api/"):
        response.headers["Cache-Control"] = "no-store, no-cache, must-revalidate, max-age=0"
    elif request.url.path == "/" or request.url.path.startswith("/static/"):
        response.headers["Cache-Control"] = "no-cache, must-revalidate"
    return response


STATIC_DIR = Path(__file__).parent / "static"
STATIC_DIR.mkdir(parents=True, exist_ok=True)
app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")


# --- Request Models ---

class ChatRequest(BaseModel):
    session_id: Optional[str] = None
    message: str = Field(..., min_length=1, max_length=2000)


class FavoritePlayerRequest(BaseModel):
    player_id: int


class FavoriteTeamRequest(BaseModel):
    team_id: int


# --- Root & Health ---

@app.get("/")
def serve_index():
    return FileResponse(str(STATIC_DIR / "index.html"))


@app.get("/favicon.ico", include_in_schema=False)
def serve_favicon():
    return FileResponse(str(STATIC_DIR / "favicon.ico"))


@app.get("/api/health")
def health():
    return {"status": "ok", "app": "BP’s BPs and MVPs"}


# --- Feature 1: Dugout Chat ---

@app.get("/api/chat/sessions")
def list_chat_sessions():
    return {"sessions": database.list_sessions()}


@app.post("/api/chat/sessions")
def create_chat_session():
    session_id = str(uuid.uuid4())
    session = database.create_session(session_id, title="New Dugout Chat")
    return {"session": session}


@app.get("/api/chat/sessions/{session_id}/messages")
def get_chat_messages(session_id: str):
    database.create_session(session_id)
    messages = database.get_session_messages(session_id, limit=50)
    return {"session_id": session_id, "messages": messages}


@app.post("/api/chat")
def send_chat_message(req: ChatRequest):
    session_id = req.session_id or str(uuid.uuid4())
    database.create_session(session_id)

    # Load last 20 messages BEFORE adding the current turn
    history = database.get_session_messages(session_id, limit=20)
    if not history:
        snippet = req.message.strip()[:45]
        database.update_session_title(session_id, snippet or "Dugout Chat")

    before_mvp_ids = {p["player_id"] for p in database.get_favorite_players()}

    user_msg = database.add_message(session_id, "user", req.message.strip())
    reply_text = gemini_agent.chat_with_dugout_coach(history, req.message.strip())
    assistant_msg = database.add_message(session_id, "assistant", reply_text)

    after_mvps = database.get_favorite_players()
    added_mvps = [p for p in after_mvps if p["player_id"] not in before_mvp_ids]

    return {
        "session_id": session_id,
        "user_message": user_msg,
        "assistant_message": assistant_msg,
        "reply": reply_text,
        "added_mvps": added_mvps,
    }


# --- Feature 2: BPs & MVPs Player Search & Live Tracker ---

@app.get("/api/teams")
def list_teams():
    return {"teams": mlb_service.get_mlb_teams()}


@app.get("/api/players/search")
def search_players(q: str = Query(..., min_length=1)):
    return {"results": mlb_service.search_players(q)}


@app.get("/api/players/{player_id}")
def get_player(player_id: int):
    try:
        return {"player": mlb_service.get_player_details(player_id)}
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc))


@app.get("/api/favorites")
def get_favorites():
    fav_players = database.get_favorite_players()
    enriched_players = []
    for fp in fav_players:
        try:
            details = mlb_service.get_player_details(fp["player_id"])
            enriched_players.append(details)
        except Exception:
            enriched_players.append(
                {
                    "player_id": fp["player_id"],
                    "full_name": fp["full_name"],
                    "headshot_url": mlb_service.headshot_url(fp["player_id"]),
                    "team_id": fp["team_id"],
                    "team_name": fp["team_name"],
                    "team_slug": fp["team_slug"],
                    "position": fp["position"],
                }
            )

    fav_team = database.get_favorite_team()
    team_live = None
    if fav_team:
        try:
            team_live = mlb_service.get_team_live_status(fav_team["team_id"])
        except Exception:
            team_live = None

    return {
        "favorite_players": enriched_players,
        "favorite_team": fav_team,
        "team_live_status": team_live,
    }


@app.post("/api/favorites/players")
def add_favorite_player(req: FavoritePlayerRequest):
    try:
        details = mlb_service.get_player_details(req.player_id)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc))

    saved = database.add_favorite_player(
        player_id=details["player_id"],
        full_name=details["full_name"],
        team_id=details.get("team_id"),
        team_name=details.get("team_name"),
        team_slug=details.get("team_slug"),
        position=details.get("position"),
    )
    return {"saved": saved, "player": details}


@app.delete("/api/favorites/players/{player_id}")
def delete_favorite_player(player_id: int):
    removed = database.remove_favorite_player(player_id)
    return {"removed": removed, "player_id": player_id}


@app.post("/api/favorites/team")
def set_favorite_team(req: FavoriteTeamRequest):
    teams = mlb_service.get_mlb_teams()
    match = next((t for t in teams if t["team_id"] == req.team_id), None)
    if not match:
        raise HTTPException(status_code=404, detail="MLB team not found")

    saved = database.set_favorite_team(
        team_id=match["team_id"],
        team_name=match["team_name"],
        team_abbreviation=match.get("abbreviation"),
        team_slug=match.get("team_slug"),
    )
    live_status = mlb_service.get_team_live_status(match["team_id"])
    return {"favorite_team": saved, "team_live_status": live_status}


@app.delete("/api/favorites/team")
def delete_favorite_team():
    database.clear_favorite_team()
    return {"cleared": True}


# --- Feature 3: Child-Safe Followed-Player Newsfeed ---

@app.get("/api/newsfeed")
def get_newsfeed():
    return news_service.get_followed_player_newsfeed()


@app.get("/api/article")
def get_reader_article(url: str = Query(..., min_length=10)):
    try:
        return news_service.fetch_reader_article(url)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


class TTSRequest(BaseModel):
    text: str = Field(..., min_length=1, max_length=4000)
    voice: str = "Puck"


@app.post("/api/tts")
def text_to_speech(req: TTSRequest):
    try:
        audio_bytes, media_type = gemini_agent.synthesize_speech(req.text, voice_name=req.voice)
        return Response(content=audio_bytes, media_type=media_type)
    except Exception as exc:
        print(f"[Gemini TTS Error] {type(exc).__name__}: {exc}", flush=True)
        raise HTTPException(status_code=503, detail=f"TTS unavailable: {type(exc).__name__}")


