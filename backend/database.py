"""
ContextVolt — SQLite database layer.

Manages the 'contexts' and 'chunks' tables, plus sqlite-vec virtual tables
for fast vector similarity search.
"""

import sqlite3
import json
import logging
import os
import struct
from datetime import datetime, timezone

import sqlite_vec

DB_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "context_volt.db")

_log = logging.getLogger("contextvolt")

# ---------------------------------------------------------------------------
# Connection helper
# ---------------------------------------------------------------------------

def _get_conn() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    conn.enable_load_extension(True)
    sqlite_vec.load(conn)
    conn.enable_load_extension(False)
    return conn


def _vec_to_blob(vec: list[float]) -> bytes:
    """Pack a Python list of floats into a little-endian float32 blob for sqlite-vec."""
    return struct.pack(f"{len(vec)}f", *vec)


def _blob_to_vec(blob: bytes) -> list[float]:
    """Unpack a sqlite-vec float32 blob back to a Python list."""
    n = len(blob) // 4
    return list(struct.unpack(f"{n}f", blob))


# ---------------------------------------------------------------------------
# Schema & migrations
# ---------------------------------------------------------------------------

def _detect_embed_dim(conn: sqlite3.Connection) -> int:
    """Detect embedding dimension from existing data. Returns 0 if none found."""
    row = conn.execute(
        "SELECT embedding FROM chunks WHERE embedding IS NOT NULL LIMIT 1"
    ).fetchone()
    if row and row[0]:
        try:
            return len(json.loads(row[0]))
        except Exception:
            pass
    row = conn.execute(
        "SELECT embedding FROM contexts WHERE embedding IS NOT NULL LIMIT 1"
    ).fetchone()
    if row and row[0]:
        try:
            return len(json.loads(row[0]))
        except Exception:
            pass
    return 0



def _ensure_vec_tables(conn: sqlite3.Connection, dim: int) -> None:
    """Create or recreate the vec0 virtual tables for the given embedding dimension."""
    if dim <= 0:
        return

    # Store current dim in a metadata table so we can detect changes
    conn.execute("CREATE TABLE IF NOT EXISTS _vec_meta (key TEXT PRIMARY KEY, value TEXT)")
    row = conn.execute("SELECT value FROM _vec_meta WHERE key = 'embed_dim'").fetchone()
    stored_dim = int(row[0]) if row else 0

    if stored_dim == dim:
        # Tables already exist with correct dim — check they actually exist
        try:
            conn.execute("SELECT rowid FROM chunk_vecs LIMIT 0")
            conn.execute("SELECT rowid FROM context_vecs LIMIT 0")
            return  # all good
        except Exception:
            pass  # table missing, recreate

    _log.info("(Re)creating vec tables: dim %d (was %d)", dim, stored_dim)

    # Drop and recreate
    conn.execute("DROP TABLE IF EXISTS chunk_vecs")
    conn.execute("DROP TABLE IF EXISTS context_vecs")
    conn.execute(f"CREATE VIRTUAL TABLE chunk_vecs USING vec0(embedding float[{dim}] distance_metric=cosine)")
    conn.execute(f"CREATE VIRTUAL TABLE context_vecs USING vec0(embedding float[{dim}] distance_metric=cosine)")

    conn.execute("INSERT OR REPLACE INTO _vec_meta (key, value) VALUES ('embed_dim', ?)", (str(dim),))
    conn.commit()

    # Backfill from existing JSON embeddings
    _backfill_vec_tables(conn, dim)


def _backfill_vec_tables(conn: sqlite3.Connection, dim: int) -> None:
    """Populate vec tables from JSON embedding columns in chunks/contexts."""
    # Chunks
    rows = conn.execute("SELECT id, embedding FROM chunks WHERE embedding IS NOT NULL").fetchall()
    count = 0
    for row in rows:
        try:
            vec = json.loads(row["embedding"])
            if len(vec) == dim:
                conn.execute(
                    "INSERT OR REPLACE INTO chunk_vecs (rowid, embedding) VALUES (?, ?)",
                    (row["id"], _vec_to_blob(vec)),
                )
                count += 1
        except Exception:
            continue
    _log.info("Backfilled %d/%d chunk vectors", count, len(rows))

    # Contexts
    rows = conn.execute("SELECT id, embedding FROM contexts WHERE embedding IS NOT NULL").fetchall()
    count = 0
    for row in rows:
        try:
            vec = json.loads(row["embedding"])
            if len(vec) == dim:
                conn.execute(
                    "INSERT OR REPLACE INTO context_vecs (rowid, embedding) VALUES (?, ?)",
                    (row["id"], _vec_to_blob(vec)),
                )
                count += 1
        except Exception:
            continue
    _log.info("Backfilled %d/%d context vectors", count, len(rows))
    conn.commit()


def init_db():
    """Create tables, run migrations, and initialise sqlite-vec virtual tables."""
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

    # Column migrations (safe to run every startup — ALTER TABLE ADD is a no-op if exists)
    _migrations = [
        "ALTER TABLE contexts ADD COLUMN embedding TEXT DEFAULT NULL",
        "ALTER TABLE contexts ADD COLUMN important_notes TEXT DEFAULT NULL",
        "ALTER TABLE contexts ADD COLUMN status TEXT DEFAULT 'completed'",
        "ALTER TABLE contexts ADD COLUMN starred INTEGER DEFAULT 0",
    ]
    for sql in _migrations:
        try:
            conn.execute(sql)
            conn.commit()
        except Exception:
            pass  # column already exists

    # Chunks table
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

    # sqlite-vec virtual tables
    dim = _detect_embed_dim(conn)
    if dim > 0:
        _ensure_vec_tables(conn, dim)

    conn.close()


# ---------------------------------------------------------------------------
# Vec sync helpers — keep vec tables in sync with JSON embedding columns
# ---------------------------------------------------------------------------

def _sync_chunk_vec(conn: sqlite3.Connection, chunk_id: int, embedding: list[float] | None) -> None:
    """Insert/update/delete a chunk's entry in chunk_vecs."""
    if not embedding:
        try:
            conn.execute("DELETE FROM chunk_vecs WHERE rowid = ?", (chunk_id,))
        except Exception:
            pass
        return
    dim = len(embedding)
    _ensure_vec_tables(conn, dim)
    try:
        conn.execute(
            "INSERT OR REPLACE INTO chunk_vecs (rowid, embedding) VALUES (?, ?)",
            (chunk_id, _vec_to_blob(embedding)),
        )
    except Exception as e:
        _log.warning("Failed to sync chunk_vecs rowid=%d: %s", chunk_id, e)


def _sync_context_vec(conn: sqlite3.Connection, context_id: int, embedding: list[float] | None) -> None:
    """Insert/update/delete a context's entry in context_vecs."""
    if not embedding:
        try:
            conn.execute("DELETE FROM context_vecs WHERE rowid = ?", (context_id,))
        except Exception:
            pass
        return
    dim = len(embedding)
    _ensure_vec_tables(conn, dim)
    try:
        conn.execute(
            "INSERT OR REPLACE INTO context_vecs (rowid, embedding) VALUES (?, ?)",
            (context_id, _vec_to_blob(embedding)),
        )
    except Exception as e:
        _log.warning("Failed to sync context_vecs rowid=%d: %s", context_id, e)


# ---------------------------------------------------------------------------
# Row converters
# ---------------------------------------------------------------------------

def _row_to_dict(row):
    """Convert a sqlite3.Row to a plain dict, parsing JSON summary."""
    if row is None:
        return None
    d = dict(row)
    try:
        d["summary"] = json.loads(d["summary"])
    except (json.JSONDecodeError, TypeError):
        pass
    if d.get("tags"):
        d["tags"] = [t.strip() for t in d["tags"].split(",") if t.strip()]
    else:
        d["tags"] = []
    if d.get("important_notes"):
        try:
            d["important_notes"] = json.loads(d["important_notes"])
        except Exception:
            d["important_notes"] = []
    else:
        d["important_notes"] = []
    d["starred"] = bool(d.get("starred"))
    return d


def _chunk_row_to_dict(row) -> dict:
    d = dict(row)
    d["has_code"] = bool(d.get("has_code"))
    d["is_starred"] = bool(d.get("is_starred"))
    return d


# ---------------------------------------------------------------------------
# Context CRUD
# ---------------------------------------------------------------------------

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
    context_id = cursor.lastrowid
    if embedding:
        _sync_context_vec(conn, context_id, embedding)
    conn.commit()
    row = conn.execute("SELECT * FROM contexts WHERE id = ?", (context_id,)).fetchone()
    conn.close()
    return _row_to_dict(row)


def set_context_embedding(context_id: int, embedding: list[float]) -> None:
    """Store an embedding vector for an existing context."""
    conn = _get_conn()
    conn.execute(
        "UPDATE contexts SET embedding = ? WHERE id = ?",
        (json.dumps(embedding), context_id),
    )
    _sync_context_vec(conn, context_id, embedding)
    conn.commit()
    conn.close()


def get_all_contexts() -> list[dict]:
    """Return all contexts, newest first."""
    conn = _get_conn()
    rows = conn.execute("SELECT * FROM contexts ORDER BY created_at DESC").fetchall()
    conn.close()
    return [_row_to_dict(r) for r in rows]


def get_contexts_paginated(page: int = 1, per_page: int = 50, sort: str = "newest") -> dict:
    """Return a page of contexts with total count for pagination."""
    conn = _get_conn()
    total = conn.execute("SELECT COUNT(*) FROM contexts").fetchone()[0]
    offset = (page - 1) * per_page

    order_clause = {
        "newest": "starred DESC, created_at DESC",
        "oldest": "starred DESC, created_at ASC",
        "alpha":  "starred DESC, title COLLATE NOCASE ASC",
    }.get(sort, "starred DESC, created_at DESC")

    rows = conn.execute(
        f"SELECT * FROM contexts ORDER BY {order_clause} LIMIT ? OFFSET ?",
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
    """Update fields of a context. Accepts title, summary, tags, status, important_notes."""
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
    if "important_notes" in kwargs:
        updates.append("important_notes = ?")
        notes = kwargs["important_notes"]
        params.append(json.dumps(notes) if isinstance(notes, list) else notes)

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


def toggle_context_starred(context_id: int) -> dict | None:
    """Toggle the starred state of a context. Returns updated context."""
    conn = _get_conn()
    conn.execute(
        "UPDATE contexts SET starred = CASE WHEN starred = 1 THEN 0 ELSE 1 END WHERE id = ?",
        (context_id,),
    )
    conn.commit()
    row = conn.execute("SELECT * FROM contexts WHERE id = ?", (context_id,)).fetchone()
    conn.close()
    return _row_to_dict(row)


def delete_context(context_id: int) -> bool:
    """Delete a context. Returns True if a row was deleted."""
    conn = _get_conn()
    # Clean up vec table entry
    try:
        conn.execute("DELETE FROM context_vecs WHERE rowid = ?", (context_id,))
    except Exception:
        pass
    cursor = conn.execute("DELETE FROM contexts WHERE id = ?", (context_id,))
    conn.commit()
    conn.close()
    return cursor.rowcount > 0


def search_chunks_keyword(query: str, top_k: int = 20) -> list[dict]:
    """Full-text keyword search across all chunk text. Returns chunks with context_id."""
    conn = _get_conn()
    like = f"%{query}%"
    rows = conn.execute(
        """SELECT c.id, c.context_id, c.chunk_index, c.text, c.role_hint, c.has_code, c.is_starred
           FROM chunks c
           WHERE lower(c.text) LIKE lower(?)
           ORDER BY c.created_at DESC
           LIMIT ?""",
        (like, top_k),
    ).fetchall()
    conn.close()
    return [{"id": r[0], "context_id": r[1], "chunk_index": r[2],
             "text": r[3], "role_hint": r[4], "has_code": bool(r[5]),
             "is_starred": bool(r[6]), "_score": None, "_keyword_match": True}
            for r in rows]


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


# ---------------------------------------------------------------------------
# Chunk CRUD
# ---------------------------------------------------------------------------

def create_chunks(context_id: int, chunks: list[dict]) -> list[int]:
    """Bulk-insert chunks for a context. Returns list of inserted IDs."""
    now = datetime.now(timezone.utc).isoformat()
    conn = _get_conn()
    ids = []
    for ch in chunks:
        embedding = ch.get("embedding")
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
                json.dumps(embedding) if embedding else None,
                now,
            ),
        )
        chunk_id = cur.lastrowid
        ids.append(chunk_id)
        if embedding:
            _sync_chunk_vec(conn, chunk_id, embedding)
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


def update_chunk_embedding(chunk_id: int, embedding: list[float]) -> None:
    """Update the embedding for an existing chunk and sync to vec table."""
    conn = _get_conn()
    conn.execute(
        "UPDATE chunks SET embedding = ? WHERE id = ?",
        (json.dumps(embedding), chunk_id),
    )
    _sync_chunk_vec(conn, chunk_id, embedding)
    conn.commit()
    conn.close()


def delete_chunks_by_context(context_id: int) -> int:
    """Delete all chunks for a context. Returns count deleted."""
    conn = _get_conn()
    # Get chunk IDs to clean up vec table
    chunk_ids = [r[0] for r in conn.execute(
        "SELECT id FROM chunks WHERE context_id = ?", (context_id,)
    ).fetchall()]
    for cid in chunk_ids:
        try:
            conn.execute("DELETE FROM chunk_vecs WHERE rowid = ?", (cid,))
        except Exception:
            pass
    cur = conn.execute("DELETE FROM chunks WHERE context_id = ?", (context_id,))
    conn.commit()
    conn.close()
    return cur.rowcount


# ---------------------------------------------------------------------------
# Semantic search via sqlite-vec
# ---------------------------------------------------------------------------

def search_chunks_semantic(
    query_vec: list[float],
    context_id: int | None = None,
    top_k: int = 10,
    star_boost: float = 0.15,
) -> list[dict]:
    """Return top_k chunks ranked by cosine similarity via sqlite-vec.

    If context_id is given, search within that context only.
    Starred chunks get +star_boost added to their score.
    """
    conn = _get_conn()

    # Check vec table exists
    try:
        conn.execute("SELECT rowid FROM chunk_vecs LIMIT 0")
    except Exception:
        conn.close()
        return []

    q_blob = _vec_to_blob(query_vec)

    if context_id is not None:
        # Context-filtered: use vec_distance_cosine scalar function via JOIN.
        # This is exact (not ANN) but fast for the small number of chunks per context.
        try:
            vec_rows = conn.execute(
                """SELECT c.id, vec_distance_cosine(cv.embedding, ?) AS dist
                   FROM chunks c
                   JOIN chunk_vecs cv ON cv.rowid = c.id
                   WHERE c.context_id = ?
                   ORDER BY dist ASC
                   LIMIT ?""",
                (q_blob, context_id, top_k * 3),
            ).fetchall()
        except Exception:
            conn.close()
            return []

        scored_ids = [(r[0], 1.0 - r[1]) for r in vec_rows]
    else:
        # Global search
        try:
            vec_rows = conn.execute(
                "SELECT rowid, distance FROM chunk_vecs WHERE embedding MATCH ? ORDER BY distance LIMIT ?",
                (q_blob, top_k * 3),
            ).fetchall()
        except Exception:
            conn.close()
            return []
        scored_ids = [(r[0], 1.0 - r[1]) for r in vec_rows]

    if not scored_ids:
        conn.close()
        return []

    # Fetch full chunk data for the matched IDs
    id_list = [sid[0] for sid in scored_ids]
    score_map = {sid[0]: sid[1] for sid in scored_ids}
    placeholders = ",".join("?" * len(id_list))
    rows = conn.execute(
        f"SELECT * FROM chunks WHERE id IN ({placeholders})", id_list
    ).fetchall()
    conn.close()

    chunks = []
    for row in rows:
        ch = _chunk_row_to_dict(row)
        score = score_map.get(ch["id"], 0.0)
        if ch.get("is_starred"):
            score += star_boost
        ch["_score"] = score
        chunks.append(ch)

    chunks.sort(key=lambda x: x["_score"], reverse=True)
    return chunks[:top_k]


def search_contexts_semantic(query_vec: list[float], top_k: int = 20) -> list[dict]:
    """Return up to top_k contexts ranked by cosine similarity via sqlite-vec."""
    conn = _get_conn()

    try:
        conn.execute("SELECT rowid FROM context_vecs LIMIT 0")
    except Exception:
        conn.close()
        return []

    q_blob = _vec_to_blob(query_vec)
    try:
        vec_rows = conn.execute(
            "SELECT rowid, distance FROM context_vecs WHERE embedding MATCH ? ORDER BY distance LIMIT ?",
            (q_blob, top_k),
        ).fetchall()
    except Exception:
        conn.close()
        return []

    if not vec_rows:
        conn.close()
        return []

    id_list = [r[0] for r in vec_rows]
    placeholders = ",".join("?" * len(id_list))
    rows = conn.execute(
        f"SELECT * FROM contexts WHERE id IN ({placeholders})", id_list
    ).fetchall()
    conn.close()

    # Preserve score-based ordering from vec search
    order = {rid: idx for idx, rid in enumerate(id_list)}
    contexts = [_row_to_dict(r) for r in rows]
    contexts.sort(key=lambda c: order.get(c["id"], 999))
    return contexts
