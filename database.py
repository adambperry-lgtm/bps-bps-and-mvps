import os
import sqlite3
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional


def _resolve_db_path() -> str:
    raw = os.getenv("DATABASE_URL", "./bps_and_mvps.db").strip()
    if raw.startswith("sqlite:///"):
        raw = raw[len("sqlite:///"):]
    elif raw.startswith("sqlite://"):
        raw = raw[len("sqlite://"):]
    if not raw:
        raw = "./bps_and_mvps.db"
    db_path = Path(raw)
    if db_path.parent and str(db_path.parent) not in ("", "."):
        db_path.parent.mkdir(parents=True, exist_ok=True)
    return str(db_path)


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


@contextmanager
def get_conn():
    db_path = _resolve_db_path()
    conn = sqlite3.connect(db_path, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    try:
        yield conn
        conn.commit()
    finally:
        conn.close()


def init_db() -> None:
    with get_conn() as conn:
        cur = conn.cursor()
        cur.execute(
            """
            CREATE TABLE IF NOT EXISTS chat_sessions (
                id TEXT PRIMARY KEY,
                title TEXT NOT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            )
            """
        )
        cur.execute(
            """
            CREATE TABLE IF NOT EXISTS chat_messages (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                session_id TEXT NOT NULL,
                role TEXT NOT NULL,
                content TEXT NOT NULL,
                timestamp TEXT NOT NULL,
                FOREIGN KEY (session_id) REFERENCES chat_sessions(id) ON DELETE CASCADE
            )
            """
        )
        cur.execute(
            """
            CREATE INDEX IF NOT EXISTS idx_chat_messages_session
            ON chat_messages(session_id, id)
            """
        )
        cur.execute(
            """
            CREATE TABLE IF NOT EXISTS favorite_players (
                player_id INTEGER PRIMARY KEY,
                full_name TEXT NOT NULL,
                team_id INTEGER,
                team_name TEXT,
                team_slug TEXT,
                position TEXT,
                added_at TEXT NOT NULL
            )
            """
        )
        cur.execute(
            """
            CREATE TABLE IF NOT EXISTS favorite_team (
                id INTEGER PRIMARY KEY CHECK (id = 1),
                team_id INTEGER NOT NULL,
                team_name TEXT NOT NULL,
                team_abbreviation TEXT,
                team_slug TEXT,
                updated_at TEXT NOT NULL
            )
            """
        )
        cur.execute(
            """
            CREATE TABLE IF NOT EXISTS article_summaries (
                article_id TEXT PRIMARY KEY,
                url TEXT NOT NULL,
                title TEXT NOT NULL,
                summary TEXT NOT NULL,
                is_safe INTEGER NOT NULL DEFAULT 1,
                category TEXT NOT NULL DEFAULT 'MLB News',
                created_at TEXT NOT NULL
            )
            """
        )
        # Default favorite team: Philadelphia Phillies
        cur.execute(
            """
            INSERT OR IGNORE INTO favorite_team
            (id, team_id, team_name, team_abbreviation, team_slug, updated_at)
            VALUES (1, 143, 'Philadelphia Phillies', 'PHI', 'phillies', ?)
            """,
            (_now_iso(),),
        )


# --- Chat Sessions & Memory ---

def create_session(session_id: str, title: str = "New Dugout Chat") -> dict:
    now = _now_iso()
    with get_conn() as conn:
        conn.execute(
            """
            INSERT OR IGNORE INTO chat_sessions (id, title, created_at, updated_at)
            VALUES (?, ?, ?, ?)
            """,
            (session_id, title, now, now),
        )
    return {"id": session_id, "title": title, "created_at": now, "updated_at": now}


def list_sessions() -> list[dict]:
    with get_conn() as conn:
        rows = conn.execute(
            """
            SELECT s.id, s.title, s.created_at, s.updated_at,
                   (SELECT COUNT(*) FROM chat_messages m WHERE m.session_id = s.id) AS message_count
            FROM chat_sessions s
            ORDER BY s.updated_at DESC
            LIMIT 10
            """
        ).fetchall()
    return [dict(r) for r in rows]


def update_session_title(session_id: str, title: str) -> None:
    now = _now_iso()
    with get_conn() as conn:
        conn.execute(
            "UPDATE chat_sessions SET title = ?, updated_at = ? WHERE id = ?",
            (title[:60], now, session_id),
        )


def add_message(session_id: str, role: str, content: str) -> dict:
    now = _now_iso()
    create_session(session_id)
    with get_conn() as conn:
        cur = conn.execute(
            """
            INSERT INTO chat_messages (session_id, role, content, timestamp)
            VALUES (?, ?, ?, ?)
            """,
            (session_id, role, content, now),
        )
        conn.execute(
            "UPDATE chat_sessions SET updated_at = ? WHERE id = ?",
            (now, session_id),
        )
        msg_id = cur.lastrowid
    return {
        "id": msg_id,
        "session_id": session_id,
        "role": role,
        "content": content,
        "timestamp": now,
    }


def get_session_messages(session_id: str, limit: int = 20) -> list[dict]:
    with get_conn() as conn:
        rows = conn.execute(
            """
            SELECT id, session_id, role, content, timestamp
            FROM chat_messages
            WHERE session_id = ?
            ORDER BY id DESC
            LIMIT ?
            """,
            (session_id, limit),
        ).fetchall()
    return [dict(r) for r in reversed(rows)]


# --- Favorites (Players & Team) ---

def get_favorite_players() -> list[dict]:
    with get_conn() as conn:
        rows = conn.execute(
            """
            SELECT player_id, full_name, team_id, team_name, team_slug, position, added_at
            FROM favorite_players
            ORDER BY added_at DESC
            """
        ).fetchall()
    return [dict(r) for r in rows]


def add_favorite_player(
    player_id: int,
    full_name: str,
    team_id: Optional[int],
    team_name: Optional[str],
    team_slug: Optional[str],
    position: Optional[str],
) -> dict:
    now = _now_iso()
    with get_conn() as conn:
        conn.execute(
            """
            INSERT OR REPLACE INTO favorite_players
            (player_id, full_name, team_id, team_name, team_slug, position, added_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (player_id, full_name, team_id, team_name, team_slug, position, now),
        )
    return {
        "player_id": player_id,
        "full_name": full_name,
        "team_id": team_id,
        "team_name": team_name,
        "team_slug": team_slug,
        "position": position,
        "added_at": now,
    }


def remove_favorite_player(player_id: int) -> bool:
    with get_conn() as conn:
        cur = conn.execute(
            "DELETE FROM favorite_players WHERE player_id = ?",
            (player_id,),
        )
    return cur.rowcount > 0


def get_favorite_team() -> Optional[dict]:
    with get_conn() as conn:
        row = conn.execute(
            "SELECT team_id, team_name, team_abbreviation, team_slug, updated_at FROM favorite_team WHERE id = 1"
        ).fetchone()
    return dict(row) if row else None


def set_favorite_team(
    team_id: int,
    team_name: str,
    team_abbreviation: Optional[str],
    team_slug: Optional[str],
) -> dict:
    now = _now_iso()
    with get_conn() as conn:
        conn.execute(
            """
            INSERT OR REPLACE INTO favorite_team
            (id, team_id, team_name, team_abbreviation, team_slug, updated_at)
            VALUES (1, ?, ?, ?, ?, ?)
            """,
            (team_id, team_name, team_abbreviation, team_slug, now),
        )
    return {
        "team_id": team_id,
        "team_name": team_name,
        "team_abbreviation": team_abbreviation,
        "team_slug": team_slug,
        "updated_at": now,
    }


def clear_favorite_team() -> None:
    with get_conn() as conn:
        conn.execute("DELETE FROM favorite_team WHERE id = 1")


# --- Cached Article Summaries ---

def get_cached_summary(article_id: str) -> Optional[dict]:
    with get_conn() as conn:
        row = conn.execute(
            """
            SELECT article_id, url, title, summary, is_safe, category, created_at
            FROM article_summaries
            WHERE article_id = ?
            """,
            (article_id,),
        ).fetchone()
    if not row:
        return None
    data = dict(row)
    data["is_safe"] = bool(data["is_safe"])
    return data


def save_cached_summary(
    article_id: str,
    url: str,
    title: str,
    summary: str,
    is_safe: bool,
    category: str = "MLB News",
) -> None:
    now = _now_iso()
    with get_conn() as conn:
        conn.execute(
            """
            INSERT OR REPLACE INTO article_summaries
            (article_id, url, title, summary, is_safe, category, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (article_id, url, title, summary, 1 if is_safe else 0, category, now),
        )
