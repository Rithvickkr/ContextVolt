"""
ContextVolt — SQLite database layer.

Manages the 'contexts' table for storing conversation summaries.
"""

import sqlite3
import json
import os
from datetime import datetime, timezone

DB_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "context_volt.db")


def _get_conn():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


def _cosine_similarity(a: list[float], b: list[float]) -> float:
    dot = sum(x * y for x, y in zip(a, b))
    mag = (sum(x ** 2 for x in a) ** 0.5) * (sum(x ** 2 for x in b) ** 0.5)
    return dot / mag if mag else 0.0


def init_db():
    """Create the contexts table if it doesn't exist, and run migrations."""
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
    # Migration: add embedding column for semantic search (safe to run every startup)
    try:
        conn.execute("ALTER TABLE contexts ADD COLUMN embedding TEXT DEFAULT NULL")
        conn.commit()
    except Exception:
        pass  # column already exists
    # Migration: add important_notes column for user-marked snippets
    try:
        conn.execute("ALTER TABLE contexts ADD COLUMN important_notes TEXT DEFAULT NULL")
        conn.commit()
    except Exception:
        pass  # column already exists

    # Migration: add status column for background worker tracking
    try:
        conn.execute("ALTER TABLE contexts ADD COLUMN status TEXT DEFAULT 'completed'")
        conn.commit()
    except Exception:
        pass  # column already exists

    # Chunks table for embedding-based retrieval
    conn.execute("""
        CREATE TABLE IF NOT EXISTS chunks (
            id           INTEGER PRIMARY KEY AUTOINCREMENT,
            context_id   INTEGER NOT NULL,
            chunk_index  INTEGER NOT NULL,
            text         TEXT    NOT NULL,
            role_hint    TEXT    DEFAULT '',
            has_code     INTEGER DEFAULT 0,
            is_starred   INTEGER DEFAULT 0,
            embedding    TEXT    DEFAULT NULL,
            created_at   TEXT    NOT NULL,
            FOREIGN KEY (context_id) REFERENCES contexts(id) ON DELETE CASCADE
        )
    """)
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_chunks_context ON chunks(context_id, chunk_index)"
    )
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
        d["tags"] = [t.strip() for t in d["tags"].split(",") if t.strip()]  # type: ignore[assignment]
    else:
        d["tags"] = []  # type: ignore[assignment]
    # Parse important_notes JSON array
    if d.get("important_notes"):
        try:
            d["important_notes"] = json.loads(d["important_notes"])
        except Exception:
            d["important_notes"] = []
    else:
        d["important_notes"] = []
    return d  # type: ignore[return-value]


def create_context(
    title: str,
    summary: dict,
    tags: list[str],
    original_chat: str,
    embedding: list[float] | None = None,
    important_notes: list[str] | None = None,
    status: str = "completed",
) -> dict:
    """Insert a new context and return it."""
    now = datetime.now(timezone.utc).isoformat()
    embedding_json = json.dumps(embedding) if embedding is not None else None
    notes_json = json.dumps(important_notes) if important_notes else None
    conn = _get_conn()
    cursor = conn.execute(
        """INSERT INTO contexts (title, summary, tags, original_chat, created_at, updated_at, embedding, important_notes, status)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        (title, json.dumps(summary), ",".join(tags), original_chat, now, now, embedding_json, notes_json, status),
    )
    conn.commit()
    row = conn.execute("SELECT * FROM contexts WHERE id = ?", (cursor.lastrowid,)).fetchone()
    conn.close()
    return _row_to_dict(row)  # type: ignore[return-value]


def set_context_embedding(context_id: int, embedding: list[float]) -> None:
    """Store an embedding vector for an existing context."""
    conn = _get_conn()
    conn.execute(
        "UPDATE contexts SET embedding = ? WHERE id = ?",
        (json.dumps(embedding), context_id),
    )
    conn.commit()
    conn.close()


def get_all_contexts() -> list[dict]:
    """Return all contexts, newest first."""
    conn = _get_conn()
    rows = conn.execute("SELECT * FROM contexts ORDER BY created_at DESC").fetchall()
    conn.close()
    return [_row_to_dict(r) for r in rows]  # type: ignore[return-value]


def get_contexts_paginated(page: int = 1, per_page: int = 50) -> dict:
    """Return a page of contexts with total count for pagination."""
    conn = _get_conn()
    total = conn.execute("SELECT COUNT(*) FROM contexts").fetchone()[0]
    offset = (page - 1) * per_page
    rows = conn.execute(
        "SELECT * FROM contexts ORDER BY created_at DESC LIMIT ? OFFSET ?",
        (per_page, offset),
    ).fetchall()
    conn.close()
    return {
        "contexts": [_row_to_dict(r) for r in rows],
        "total": total,
        "page": page,
        "per_page": per_page,
        "has_more": offset + per_page < total,
    }


def get_context(context_id: int) -> dict | None:
    """Return a single context by ID."""
    conn = _get_conn()
    row = conn.execute("SELECT * FROM contexts WHERE id = ?", (context_id,)).fetchone()
    conn.close()
    return _row_to_dict(row)


def update_context(context_id: int, **kwargs) -> dict | None:
    """Update fields of a context. Accepts title, summary, tags, status."""
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
    if "status" in kwargs:
        updates.append("status = ?")
        params.append(kwargs["status"])

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
    return [_row_to_dict(r) for r in rows]  # type: ignore[return-value]


## ── Chunk CRUD ────────────────────────────────────────────────────────

def create_chunks(context_id: int, chunks: list[dict]) -> list[int]:
    """Bulk-insert chunks for a context. Returns list of inserted IDs."""
    now = datetime.now(timezone.utc).isoformat()
    conn = _get_conn()
    ids = []
    for ch in chunks:
        cur = conn.execute(
            """INSERT INTO chunks
               (context_id, chunk_index, text, role_hint, has_code, is_starred, embedding, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                context_id,
                ch.get("chunk_index", 0),
                ch["text"],
                ch.get("role_hint", ""),
                1 if ch.get("has_code") else 0,
                1 if ch.get("is_starred") else 0,
                json.dumps(ch["embedding"]) if ch.get("embedding") else None,
                now,
            ),
        )
        ids.append(cur.lastrowid)
    conn.commit()
    conn.close()
    return ids


def get_chunks_by_context(context_id: int) -> list[dict]:
    """Return all chunks for a context, ordered by chunk_index."""
    conn = _get_conn()
    rows = conn.execute(
        "SELECT * FROM chunks WHERE context_id = ? ORDER BY chunk_index",
        (context_id,),
    ).fetchall()
    conn.close()
    return [_chunk_row_to_dict(r) for r in rows]


def _chunk_row_to_dict(row) -> dict:
    d = dict(row)
    d["has_code"] = bool(d.get("has_code"))
    d["is_starred"] = bool(d.get("is_starred"))
    return d


def search_chunks_semantic(
    query_vec: list[float],
    context_id: int | None = None,
    top_k: int = 10,
    star_boost: float = 0.15,
) -> list[dict]:
    """Return top_k chunks ranked by cosine similarity.

    If context_id is given, search within that context only.
    Starred chunks get +star_boost added to their score.
    """
    conn = _get_conn()
    if context_id is not None:
        rows = conn.execute(
            "SELECT * FROM chunks WHERE context_id = ? AND embedding IS NOT NULL",
            (context_id,),
        ).fetchall()
    else:
        rows = conn.execute(
            "SELECT * FROM chunks WHERE embedding IS NOT NULL"
        ).fetchall()
    conn.close()

    if not rows:
        return []

    scored = []
    for row in rows:
        ch = _chunk_row_to_dict(row)
        try:
            vec = json.loads(ch.get("embedding") or "null")
            if vec:
                score = _cosine_similarity(query_vec, vec)
                if ch.get("is_starred"):
                    score += star_boost
                ch["_score"] = score
                scored.append(ch)
        except Exception:
            continue

    scored.sort(key=lambda x: x.get("_score", 0.0), reverse=True)
    return scored[:top_k]


def delete_chunks_by_context(context_id: int) -> int:
    """Delete all chunks for a context. Returns count deleted."""
    conn = _get_conn()
    cur = conn.execute("DELETE FROM chunks WHERE context_id = ?", (context_id,))
    conn.commit()
    conn.close()
    return cur.rowcount


def search_contexts_semantic(query_vec: list[float], top_k: int = 20) -> list[dict]:
    """Return up to top_k contexts ranked by cosine similarity to query_vec.

    Only considers contexts that have a stored embedding. Falls back gracefully
    to an empty list if none exist (caller should then use keyword search).
    """
    conn = _get_conn()
    rows = conn.execute(
        "SELECT * FROM contexts WHERE embedding IS NOT NULL ORDER BY created_at DESC"
    ).fetchall()
    conn.close()

    if not rows:
        return []

    scored = []
    for row in rows:
        ctx = _row_to_dict(row)
        try:
            vec: list[float] = json.loads(ctx.get("embedding") or "null")  # type: ignore[union-attr]
            if vec:
                ctx["_score"] = _cosine_similarity(query_vec, vec)  # type: ignore[index]
                scored.append(ctx)
        except Exception:
            continue

    scored.sort(key=lambda x: x.get("_score", 0.0), reverse=True)  # type: ignore[union-attr]
    # Remove internal scoring field before returning
    for ctx in scored:
        ctx.pop("_score", None)  # type: ignore[union-attr]
    return scored[:top_k]  # type: ignore[index]
