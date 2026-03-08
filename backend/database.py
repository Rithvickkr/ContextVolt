"""
Context Vault — SQLite database layer.

Manages the 'contexts' table for storing conversation summaries.
"""

import sqlite3
import json
import os
from datetime import datetime, timezone

DB_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "context_vault.db")


def _get_conn():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    return conn


def init_db():
    """Create the contexts table if it doesn't exist."""
    conn = _get_conn()
    conn.execute("""
        CREATE TABLE IF NOT EXISTS contexts (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            title       TEXT    NOT NULL,
            summary     TEXT    NOT NULL,
            tags        TEXT    DEFAULT '',
            original_chat TEXT  NOT NULL,
            created_at  TEXT    NOT NULL,
            updated_at  TEXT    NOT NULL
        )
    """)
    conn.commit()
    conn.close()


def _row_to_dict(row):
    """Convert a sqlite3.Row to a plain dict, parsing JSON summary."""
    if row is None:
        return None
    d = dict(row)
    # Parse the summary JSON string back to a dict
    try:
        d["summary"] = json.loads(d["summary"])
    except (json.JSONDecodeError, TypeError):
        pass
    # Parse tags from comma-separated string to list
    if d.get("tags"):
        d["tags"] = [t.strip() for t in d["tags"].split(",") if t.strip()]
    else:
        d["tags"] = []
    return d


def create_context(title: str, summary: dict, tags: list[str], original_chat: str) -> dict:
    """Insert a new context and return it."""
    now = datetime.now(timezone.utc).isoformat()
    conn = _get_conn()
    cursor = conn.execute(
        """INSERT INTO contexts (title, summary, tags, original_chat, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)""",
        (title, json.dumps(summary), ",".join(tags), original_chat, now, now),
    )
    conn.commit()
    row = conn.execute("SELECT * FROM contexts WHERE id = ?", (cursor.lastrowid,)).fetchone()
    conn.close()
    return _row_to_dict(row)


def get_all_contexts() -> list[dict]:
    """Return all contexts, newest first."""
    conn = _get_conn()
    rows = conn.execute("SELECT * FROM contexts ORDER BY created_at DESC").fetchall()
    conn.close()
    return [_row_to_dict(r) for r in rows]


def get_context(context_id: int) -> dict | None:
    """Return a single context by ID."""
    conn = _get_conn()
    row = conn.execute("SELECT * FROM contexts WHERE id = ?", (context_id,)).fetchone()
    conn.close()
    return _row_to_dict(row)


def update_context(context_id: int, **kwargs) -> dict | None:
    """Update fields of a context. Accepts title, summary, tags."""
    conn = _get_conn()
    now = datetime.now(timezone.utc).isoformat()

    updates = []
    params = []
    if "title" in kwargs:
        updates.append("title = ?")
        params.append(kwargs["title"])
    if "summary" in kwargs:
        updates.append("summary = ?")
        params.append(json.dumps(kwargs["summary"]) if isinstance(kwargs["summary"], dict) else kwargs["summary"])
    if "tags" in kwargs:
        updates.append("tags = ?")
        tags = kwargs["tags"]
        if isinstance(tags, list):
            tags = ",".join(tags)
        params.append(tags)

    if not updates:
        conn.close()
        return get_context(context_id)

    updates.append("updated_at = ?")
    params.append(now)
    params.append(context_id)

    conn.execute(f"UPDATE contexts SET {', '.join(updates)} WHERE id = ?", params)
    conn.commit()
    row = conn.execute("SELECT * FROM contexts WHERE id = ?", (context_id,)).fetchone()
    conn.close()
    return _row_to_dict(row)


def delete_context(context_id: int) -> bool:
    """Delete a context. Returns True if a row was deleted."""
    conn = _get_conn()
    cursor = conn.execute("DELETE FROM contexts WHERE id = ?", (context_id,))
    conn.commit()
    conn.close()
    return cursor.rowcount > 0


def search_contexts(query: str) -> list[dict]:
    """Search contexts by title, tags, or summary content."""
    conn = _get_conn()
    like = f"%{query}%"
    rows = conn.execute(
        """SELECT * FROM contexts
           WHERE title LIKE ? OR tags LIKE ? OR summary LIKE ? OR original_chat LIKE ?
           ORDER BY created_at DESC""",
        (like, like, like, like),
    ).fetchall()
    conn.close()
    return [_row_to_dict(r) for r in rows]
