"""
ContextVolt — SQLite database layer.

Manages the 'contexts' and 'chunks' tables, plus sqlite-vec virtual tables
for fast vector similarity search.
"""

import sqlite3
import json
import logging
import os
import re
import struct
import threading
from datetime import datetime, timezone

import sqlite_vec

from backend.paths import db_path as _db_path

DB_PATH = str(_db_path())

_log = logging.getLogger("contextvolt")

# Set during init_db: True when the SQLite build has FTS5 and the chunks_fts
# index is ready. search_chunks_keyword falls back to LIKE when False.
_HAS_FTS = False

# ---------------------------------------------------------------------------
# Connection helper — thread-local pooling
# ---------------------------------------------------------------------------

_thread_local = threading.local()


def _get_conn() -> sqlite3.Connection:
    """Return a thread-local SQLite connection, reusing it across calls in the same thread."""
    conn = getattr(_thread_local, "conn", None)
    if conn is not None:
        try:
            conn.execute("SELECT 1")
            return conn
        except Exception:
            # Connection is broken, discard and create a new one
            try:
                conn.close()
            except Exception:
                pass
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    conn.enable_load_extension(True)
    sqlite_vec.load(conn)
    conn.enable_load_extension(False)
    _thread_local.conn = conn
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
    # Tables were just dropped+recreated in _ensure_vec_tables before this call,
    # so plain INSERT is safe — no existing rows to conflict with.
    # Chunks
    rows = conn.execute("SELECT id, embedding FROM chunks WHERE embedding IS NOT NULL").fetchall()
    count = 0
    for row in rows:
        try:
            vec = json.loads(row["embedding"])
            if len(vec) == dim:
                conn.execute(
                    "INSERT INTO chunk_vecs (rowid, embedding) VALUES (?, ?)",
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
                    "INSERT INTO context_vecs (rowid, embedding) VALUES (?, ?)",
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

    # Collections table
    conn.execute("""
        CREATE TABLE IF NOT EXISTS collections (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            name       TEXT NOT NULL,
            color      TEXT NOT NULL DEFAULT '#6366f1',
            created_at TEXT NOT NULL
        )
    """)
    conn.commit()

    # Column migrations (safe to run every startup — ALTER TABLE ADD is a no-op if exists)
    _migrations = [
        "ALTER TABLE contexts ADD COLUMN embedding TEXT DEFAULT NULL",
        "ALTER TABLE contexts ADD COLUMN important_notes TEXT DEFAULT NULL",
        "ALTER TABLE contexts ADD COLUMN status TEXT DEFAULT 'completed'",
        "ALTER TABLE contexts ADD COLUMN starred INTEGER DEFAULT 0",
        "ALTER TABLE contexts ADD COLUMN collection_id INTEGER DEFAULT NULL",
        "ALTER TABLE contexts ADD COLUMN conversation_url TEXT DEFAULT NULL",
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
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_chunks_starred ON chunks(is_starred)"
    )
    conn.commit()

    # FTS5 full-text index over chunk text, ranked with BM25. We use a STANDALONE
    # FTS5 table (it stores its own copy of the text) rather than an
    # external-content table: external-content FTS is tightly coupled to the
    # source table and its 'delete' command raises "database disk image is
    # malformed" the moment the index and content drift even slightly — which
    # would block normal chunk/context deletion, not just search. The standalone
    # table is kept in sync with plain INSERT/DELETE/UPDATE triggers that can't
    # corrupt. Guarded because some SQLite builds ship without FTS5 — keyword
    # search falls back to LIKE if so.
    #
    # FTS_SCHEMA_VERSION bumps whenever this layout changes; on mismatch we drop
    # and rebuild the index so old/broken tables (e.g. the prior external-content
    # one) are replaced cleanly.
    global _HAS_FTS
    FTS_SCHEMA_VERSION = "2"
    try:
        conn.execute("CREATE TABLE IF NOT EXISTS _vec_meta (key TEXT PRIMARY KEY, value TEXT)")
        row = conn.execute("SELECT value FROM _vec_meta WHERE key='fts_schema_version'").fetchone()
        stored_fts_ver = row[0] if row else None
        if stored_fts_ver != FTS_SCHEMA_VERSION:
            # Drop any prior index + triggers (handles the broken external-content table).
            for trig in ("chunks_fts_ai", "chunks_fts_ad", "chunks_fts_au"):
                conn.execute(f"DROP TRIGGER IF EXISTS {trig}")
            conn.execute("DROP TABLE IF EXISTS chunks_fts")
            conn.commit()

        conn.execute(
            "CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(text, tokenize='unicode61')"
        )
        conn.execute(
            "CREATE TRIGGER IF NOT EXISTS chunks_fts_ai AFTER INSERT ON chunks BEGIN "
            "INSERT INTO chunks_fts(rowid, text) VALUES (new.id, new.text); END"
        )
        conn.execute(
            "CREATE TRIGGER IF NOT EXISTS chunks_fts_ad AFTER DELETE ON chunks BEGIN "
            "DELETE FROM chunks_fts WHERE rowid = old.id; END"
        )
        conn.execute(
            "CREATE TRIGGER IF NOT EXISTS chunks_fts_au AFTER UPDATE ON chunks BEGIN "
            "UPDATE chunks_fts SET text = new.text WHERE rowid = old.id; END"
        )
        # Backfill when the index is empty but chunks exist (first run or post-rebuild).
        fts_count = conn.execute("SELECT COUNT(*) FROM chunks_fts").fetchone()[0]
        chunk_count = conn.execute("SELECT COUNT(*) FROM chunks").fetchone()[0]
        if chunk_count and not fts_count:
            conn.execute("INSERT INTO chunks_fts(rowid, text) SELECT id, text FROM chunks")
        conn.execute(
            "INSERT OR REPLACE INTO _vec_meta (key, value) VALUES ('fts_schema_version', ?)",
            (FTS_SCHEMA_VERSION,),
        )
        conn.commit()
        _HAS_FTS = True
    except Exception as e:
        _HAS_FTS = False
        _log.warning("FTS5 unavailable — keyword search will use LIKE fallback: %s", e)
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_contexts_status ON contexts(status)"
    )
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_contexts_starred ON contexts(starred)"
    )
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_contexts_collection ON contexts(collection_id)"
    )
    conn.commit()

    # App-level stats counter (questions asked, etc.)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS app_stats (
            key   TEXT PRIMARY KEY,
            value INTEGER NOT NULL DEFAULT 0
        )
    """)
    conn.commit()

    # Ask Vault sessions + messages
    conn.execute("""
        CREATE TABLE IF NOT EXISTS ask_sessions (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            title      TEXT    NOT NULL,
            pinned     INTEGER NOT NULL DEFAULT 0,
            created_at TEXT    NOT NULL,
            updated_at TEXT    NOT NULL
        )
    """)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS ask_messages (
            id             INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id     INTEGER NOT NULL,
            role           TEXT    NOT NULL,
            content        TEXT    NOT NULL,
            citations_json TEXT    DEFAULT NULL,
            created_at     TEXT    NOT NULL,
            FOREIGN KEY (session_id) REFERENCES ask_sessions(id) ON DELETE CASCADE
        )
    """)
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_ask_messages_session ON ask_messages(session_id, created_at)"
    )
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_ask_sessions_updated ON ask_sessions(pinned DESC, updated_at DESC)"
    )
    conn.commit()

    # Lattice versions — per-chunk verbatim extractions produced during
    # summarization. Layer 1 of the Memory Lattice; consumed by the
    # continuation-prompt builder (STONE) to surface facts that flat
    # synthesis would otherwise paraphrase away.
    conn.execute("""
        CREATE TABLE IF NOT EXISTS lattice_versions (
            id                INTEGER PRIMARY KEY AUTOINCREMENT,
            context_id        INTEGER NOT NULL,
            depth             INTEGER NOT NULL DEFAULT 1,
            chunk_label       TEXT    NOT NULL,
            chunk_range_start INTEGER DEFAULT NULL,
            chunk_range_end   INTEGER DEFAULT NULL,
            content           TEXT    NOT NULL,
            version           INTEGER NOT NULL DEFAULT 1,
            created_at        TEXT    NOT NULL,
            FOREIGN KEY (context_id) REFERENCES contexts(id) ON DELETE CASCADE
        )
    """)
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_lattice_ctx_ver "
        "ON lattice_versions(context_id, version, depth)"
    )
    conn.commit()

    # Entity index — identifier-shaped tokens extracted heuristically from
    # chunks. Used to boost retrieval when the user's query mentions an
    # indexed name (deploy keys, ticket IDs, file paths, env-var names).
    conn.execute("""
        CREATE TABLE IF NOT EXISTS entities (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            context_id  INTEGER NOT NULL,
            name        TEXT    NOT NULL,
            name_lower  TEXT    NOT NULL,
            chunk_ids   TEXT    NOT NULL,
            count       INTEGER NOT NULL DEFAULT 1,
            created_at  TEXT    NOT NULL,
            FOREIGN KEY (context_id) REFERENCES contexts(id) ON DELETE CASCADE
        )
    """)
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_entities_name_lower ON entities(name_lower)"
    )
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_entities_ctx ON entities(context_id)"
    )
    conn.commit()

    # sqlite-vec virtual tables
    dim = _detect_embed_dim(conn)
    if dim > 0:
        _ensure_vec_tables(conn, dim)

    # Any context stuck in "summarizing" from a previous crashed run → mark failed
    conn.execute(
        "UPDATE contexts SET status = 'failed' WHERE status = 'summarizing'"
    )
    conn.commit()
    # connection reused (thread-local pool)


# ---------------------------------------------------------------------------
# Embedding-scheme metadata (fix #6 — detect embed-model switches)
# ---------------------------------------------------------------------------

def get_meta(key: str) -> str | None:
    """Read a value from the _vec_meta key/value table, or None if absent."""
    conn = _get_conn()
    try:
        conn.execute("CREATE TABLE IF NOT EXISTS _vec_meta (key TEXT PRIMARY KEY, value TEXT)")
        row = conn.execute("SELECT value FROM _vec_meta WHERE key = ?", (key,)).fetchone()
        return row[0] if row else None
    except Exception:
        return None


def set_meta(key: str, value: str) -> None:
    """Upsert a value into the _vec_meta key/value table."""
    conn = _get_conn()
    conn.execute("CREATE TABLE IF NOT EXISTS _vec_meta (key TEXT PRIMARY KEY, value TEXT)")
    conn.execute(
        "INSERT OR REPLACE INTO _vec_meta (key, value) VALUES (?, ?)", (key, value)
    )
    conn.commit()


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
    # _ensure_vec_tables may call _backfill_vec_tables which inserts this row,
    # so DELETE must come AFTER ensure — not before — to avoid UNIQUE conflicts.
    _ensure_vec_tables(conn, dim)
    try:
        conn.execute("DELETE FROM chunk_vecs WHERE rowid = ?", (chunk_id,))
    except Exception:
        pass
    try:
        conn.execute(
            "INSERT INTO chunk_vecs (rowid, embedding) VALUES (?, ?)",
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
    # _ensure_vec_tables may call _backfill_vec_tables which inserts this row,
    # so DELETE must come AFTER ensure — not before — to avoid UNIQUE conflicts.
    _ensure_vec_tables(conn, dim)
    try:
        conn.execute("DELETE FROM context_vecs WHERE rowid = ?", (context_id,))
    except Exception:
        pass
    try:
        conn.execute(
            "INSERT INTO context_vecs (rowid, embedding) VALUES (?, ?)",
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
    d["collection_id"] = d.get("collection_id")
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
    conversation_url: str | None = None,
) -> dict:
    """Insert a new context and return it."""
    now = datetime.now(timezone.utc).isoformat()
    embedding_json = json.dumps(embedding) if embedding is not None else None
    notes_json = json.dumps(important_notes) if important_notes else None
    conn = _get_conn()
    cursor = conn.execute(
        """INSERT INTO contexts (title, summary, tags, original_chat, created_at, updated_at, embedding, important_notes, status, conversation_url)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        (title, json.dumps(summary), ",".join(tags), original_chat, now, now, embedding_json, notes_json, status, conversation_url or None),
    )
    context_id = cursor.lastrowid
    if embedding:
        _sync_context_vec(conn, context_id, embedding)
    conn.commit()
    row = conn.execute("SELECT * FROM contexts WHERE id = ?", (context_id,)).fetchone()
    # connection reused (thread-local pool)
    return _row_to_dict(row)


def get_context_by_url(conversation_url: str) -> dict | None:
    """Return the most recently created context matching this URL, or None."""
    if not conversation_url:
        return None
    conn = _get_conn()
    row = conn.execute(
        "SELECT * FROM contexts WHERE conversation_url = ? ORDER BY created_at DESC LIMIT 1",
        (conversation_url,),
    ).fetchone()
    return _row_to_dict(row) if row else None


def set_context_embedding(context_id: int, embedding: list[float]) -> None:
    """Store an embedding vector for an existing context."""
    conn = _get_conn()
    conn.execute(
        "UPDATE contexts SET embedding = ? WHERE id = ?",
        (json.dumps(embedding), context_id),
    )
    _sync_context_vec(conn, context_id, embedding)
    conn.commit()
    # connection reused (thread-local pool)


def get_all_contexts() -> list[dict]:
    """Return all contexts, newest first."""
    conn = _get_conn()
    rows = conn.execute("SELECT * FROM contexts ORDER BY created_at DESC").fetchall()
    # connection reused (thread-local pool)
    return [_row_to_dict(r) for r in rows]


def get_contexts_paginated(
    page: int = 1,
    per_page: int = 50,
    sort: str = "newest",
    collection_id: int | None = None,
) -> dict:
    """Return a page of contexts with total count for pagination."""
    conn = _get_conn()

    where = "WHERE collection_id = ?" if collection_id is not None else ""
    params_count = (collection_id,) if collection_id is not None else ()
    total = conn.execute(f"SELECT COUNT(*) FROM contexts {where}", params_count).fetchone()[0]
    offset = (page - 1) * per_page

    # id is a deterministic tie-breaker: created_at is a TEXT timestamp that can
    # collide for rows created in the same instant, leaving the order undefined.
    order_clause = {
        "newest": "starred DESC, created_at DESC, id DESC",
        "oldest": "starred DESC, created_at ASC, id ASC",
        "alpha":  "starred DESC, title COLLATE NOCASE ASC, id ASC",
    }.get(sort, "starred DESC, created_at DESC, id DESC")

    params = (*params_count, per_page, offset)
    rows = conn.execute(
        f"SELECT * FROM contexts {where} ORDER BY {order_clause} LIMIT ? OFFSET ?",
        params,
    ).fetchall()
    # connection reused (thread-local pool)
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
    # connection reused (thread-local pool)
    return _row_to_dict(row)


def get_summarizing_contexts() -> list[dict]:
    """Return id and title for all contexts currently being summarized."""
    conn = _get_conn()
    rows = conn.execute(
        "SELECT id, title FROM contexts WHERE status = 'summarizing'"
    ).fetchall()
    return [{"id": r["id"], "title": r["title"]} for r in rows]


def get_contexts_by_ids(context_ids: list[int]) -> dict[int, dict]:
    """Batch fetch contexts by IDs. Returns a dict mapping id -> context dict."""
    if not context_ids:
        return {}
    conn = _get_conn()
    placeholders = ",".join("?" * len(context_ids))
    rows = conn.execute(
        f"SELECT * FROM contexts WHERE id IN ({placeholders})", context_ids
    ).fetchall()
    # connection reused (thread-local pool)
    result = {}
    for row in rows:
        ctx = _row_to_dict(row)
        if ctx:
            result[ctx["id"]] = ctx
    return result


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
    if "original_chat" in kwargs:
        updates.append("original_chat = ?")
        params.append(kwargs["original_chat"])

    if not updates:
        # connection reused (thread-local pool)
        return get_context(context_id)

    updates.append("updated_at = ?")
    params.append(now)
    params.append(context_id)

    conn.execute(f"UPDATE contexts SET {', '.join(updates)} WHERE id = ?", params)
    conn.commit()
    row = conn.execute("SELECT * FROM contexts WHERE id = ?", (context_id,)).fetchone()
    # connection reused (thread-local pool)
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
    # connection reused (thread-local pool)
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
    # connection reused (thread-local pool)
    return cursor.rowcount > 0


def _build_fts_match(query: str) -> str | None:
    """Turn arbitrary user text into a safe FTS5 MATCH expression.

    Extracts alphanumeric tokens and quotes each (so FTS special characters in
    the raw query can't break the parse or inject operators). Tokens are ANDed
    — matching the previous LIKE-on-phrase semantics where every term must be
    present. Returns None when the query has no usable tokens.
    """
    tokens = re.findall(r"[a-zA-Z0-9]+", query)
    if not tokens:
        return None
    return " ".join(f'"{t}"' for t in tokens)


def search_chunks_keyword(
    query: str, top_k: int = 20, context_ids: list[int] | None = None,
) -> list[dict]:
    """Full-text keyword search across all chunk text. Returns chunks with context_id.

    Uses the FTS5 index (BM25-ranked) when available; falls back to a LIKE scan
    on SQLite builds without FTS5. When `context_ids` is given, results are
    restricted to chunks whose context is in that set (collection scoping).
    """
    conn = _get_conn()
    scope_sql = ""
    scope_params: tuple = ()
    if context_ids:
        ph = ",".join("?" * len(context_ids))
        scope_sql = f" AND c.context_id IN ({ph})"
        scope_params = tuple(context_ids)

    if _HAS_FTS:
        match = _build_fts_match(query)
        if match:
            try:
                rows = conn.execute(
                    f"""SELECT c.id, c.context_id, c.chunk_index, c.text, c.role_hint,
                              c.has_code, c.is_starred
                       FROM chunks_fts
                       JOIN chunks c ON c.id = chunks_fts.rowid
                       WHERE chunks_fts MATCH ?{scope_sql}
                       ORDER BY bm25(chunks_fts)
                       LIMIT ?""",
                    (match, *scope_params, top_k),
                ).fetchall()
                return [{"id": r[0], "context_id": r[1], "chunk_index": r[2],
                         "text": r[3], "role_hint": r[4], "has_code": bool(r[5]),
                         "is_starred": bool(r[6]), "_score": None, "_keyword_match": True}
                        for r in rows]
            except Exception as e:
                _log.warning("FTS query failed (%r) — falling back to LIKE: %s", query, e)

    # LIKE fallback
    like = f"%{query}%"
    rows = conn.execute(
        f"""SELECT c.id, c.context_id, c.chunk_index, c.text, c.role_hint, c.has_code, c.is_starred
           FROM chunks c
           WHERE lower(c.text) LIKE lower(?){scope_sql}
           ORDER BY c.created_at DESC
           LIMIT ?""",
        (like, *scope_params, top_k),
    ).fetchall()
    # connection reused (thread-local pool)
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
    # connection reused (thread-local pool)
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
    # connection reused (thread-local pool)
    return ids


def get_chunks_by_context(context_id: int) -> list[dict]:
    """Return all chunks for a context, ordered by chunk_index."""
    conn = _get_conn()
    rows = conn.execute(
        "SELECT * FROM chunks WHERE context_id = ? ORDER BY chunk_index",
        (context_id,),
    ).fetchall()
    # connection reused (thread-local pool)
    return [_chunk_row_to_dict(r) for r in rows]


def get_chunks_by_ids(chunk_ids: list[int]) -> dict[int, dict]:
    """Batch fetch full chunk rows (including embedding) by IDs. Returns id -> chunk dict."""
    if not chunk_ids:
        return {}
    conn = _get_conn()
    placeholders = ",".join("?" * len(chunk_ids))
    rows = conn.execute(
        f"SELECT * FROM chunks WHERE id IN ({placeholders})", chunk_ids
    ).fetchall()
    out: dict[int, dict] = {}
    for r in rows:
        ch = _chunk_row_to_dict(r)
        out[ch["id"]] = ch
    return out


def get_chunk_neighbors(context_id: int, chunk_index: int) -> list[dict]:
    """Return chunks at chunk_index-1 and chunk_index+1 within the same context."""
    conn = _get_conn()
    rows = conn.execute(
        "SELECT * FROM chunks WHERE context_id = ? AND chunk_index IN (?, ?)",
        (context_id, chunk_index - 1, chunk_index + 1),
    ).fetchall()
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
    # connection reused (thread-local pool)


def rebuild_chunks_fts() -> None:
    """Rebuild the external-content FTS5 index from the chunks table.

    chunks_fts is an external-content table whose AFTER-DELETE trigger issues
    the FTS5 'delete' command using the row's old text to locate its postings.
    If the index drifts out of sync with chunks(text) — e.g. a partial write or
    a re-chunk that reused rowids — that command raises "database disk image is
    malformed" and aborts any DELETE on chunks. A 'rebuild' regenerates the
    index from the content table and clears the corruption.
    """
    if not _HAS_FTS:
        return
    conn = _get_conn()
    conn.execute("INSERT INTO chunks_fts(chunks_fts) VALUES('rebuild')")
    conn.commit()


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
    try:
        cur = conn.execute("DELETE FROM chunks WHERE context_id = ?", (context_id,))
    except sqlite3.DatabaseError as e:
        # A corrupt chunks_fts index makes the AFTER-DELETE trigger raise
        # "database disk image is malformed", which would otherwise bubble up as
        # a 500 and block deletion (incl. bulk delete). Repair the index in place
        # and retry once.
        if "malformed" not in str(e).lower():
            raise
        conn.rollback()
        _log.warning(
            "chunks_fts corrupt while deleting context %s — rebuilding FTS index",
            context_id,
        )
        rebuild_chunks_fts()
        cur = conn.execute("DELETE FROM chunks WHERE context_id = ?", (context_id,))
    conn.commit()
    # connection reused (thread-local pool)
    return cur.rowcount


# ---------------------------------------------------------------------------
# Lattice helpers (Memory Lattice — Phase 1, Layer 1)
# ---------------------------------------------------------------------------

def get_lattice_max_version(context_id: int) -> int:
    """Return the highest version number stored for this context, or 0."""
    conn = _get_conn()
    row = conn.execute(
        "SELECT MAX(version) FROM lattice_versions WHERE context_id = ?",
        (context_id,),
    ).fetchone()
    return int(row[0]) if row and row[0] is not None else 0


def create_lattice_entries(context_id: int, entries: list[dict], version: int | None = None) -> int:
    """Bulk-insert lattice entries for a context. Returns the version written.

    Each entry dict supports: depth, chunk_label, chunk_range_start,
    chunk_range_end, content. Missing keys default sensibly.
    """
    if not entries:
        return 0
    now = datetime.now(timezone.utc).isoformat()
    if version is None:
        version = get_lattice_max_version(context_id) + 1
    conn = _get_conn()
    for e in entries:
        conn.execute(
            """INSERT INTO lattice_versions
               (context_id, depth, chunk_label, chunk_range_start, chunk_range_end,
                content, version, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                context_id,
                int(e.get("depth", 1)),
                str(e.get("chunk_label", "")),
                e.get("chunk_range_start"),
                e.get("chunk_range_end"),
                str(e.get("content", "")),
                version,
                now,
            ),
        )
    conn.commit()
    return version


def get_lattice_entries_by_context(
    context_id: int, version: int | None = None, depth: int | None = None,
) -> list[dict]:
    """Return lattice entries for a context, defaulting to the latest version."""
    conn = _get_conn()
    if version is None:
        version = get_lattice_max_version(context_id)
        if version == 0:
            return []
    if depth is None:
        rows = conn.execute(
            "SELECT id, context_id, depth, chunk_label, chunk_range_start, "
            "chunk_range_end, content, version, created_at "
            "FROM lattice_versions WHERE context_id = ? AND version = ? "
            "ORDER BY chunk_range_start IS NULL, chunk_range_start, id",
            (context_id, version),
        ).fetchall()
    else:
        rows = conn.execute(
            "SELECT id, context_id, depth, chunk_label, chunk_range_start, "
            "chunk_range_end, content, version, created_at "
            "FROM lattice_versions WHERE context_id = ? AND version = ? AND depth = ? "
            "ORDER BY chunk_range_start IS NULL, chunk_range_start, id",
            (context_id, version, depth),
        ).fetchall()
    cols = ["id", "context_id", "depth", "chunk_label", "chunk_range_start",
            "chunk_range_end", "content", "version", "created_at"]
    return [dict(zip(cols, r)) for r in rows]


def delete_lattice_by_context(context_id: int) -> int:
    """Delete all lattice rows for a context. Returns count deleted."""
    conn = _get_conn()
    cur = conn.execute(
        "DELETE FROM lattice_versions WHERE context_id = ?", (context_id,)
    )
    conn.commit()
    return cur.rowcount


# ---------------------------------------------------------------------------
# Entity index helpers (Memory Lattice — Phase 1, Step 5)
# ---------------------------------------------------------------------------

def create_entities_for_context(
    context_id: int, entity_chunk_map: dict[str, list[int]],
) -> int:
    """Bulk-insert entity rows for a context. Returns count inserted.

    `entity_chunk_map` is {name: [chunk_index, ...]}. Duplicates within a
    chunk list are collapsed; count is the de-duped length.
    """
    if not entity_chunk_map:
        return 0
    now = datetime.now(timezone.utc).isoformat()
    conn = _get_conn()
    inserted = 0
    for name, indices in entity_chunk_map.items():
        unique = sorted(set(indices))
        if not unique:
            continue
        conn.execute(
            "INSERT INTO entities (context_id, name, name_lower, chunk_ids, count, created_at) "
            "VALUES (?, ?, ?, ?, ?, ?)",
            (context_id, name, name.lower(), json.dumps(unique), len(unique), now),
        )
        inserted += 1
    conn.commit()
    return inserted


def delete_entities_by_context(context_id: int) -> int:
    """Delete all entity rows for a context."""
    conn = _get_conn()
    cur = conn.execute("DELETE FROM entities WHERE context_id = ?", (context_id,))
    conn.commit()
    return cur.rowcount


def find_entity_chunks_for_query(
    context_id: int, query: str, max_terms: int = 6,
) -> list[int]:
    """Return chunk_indices for any indexed entities the query mentions.

    Matching is case-insensitive substring in both directions: a query of
    "INC-4V5UYBHK" matches an indexed entity "4V5UYBHK", and a query of
    "4V5UYBHK" matches an indexed entity "INC-4V5UYBHK". Returns the union
    of chunk indices across all matched entities for this context,
    de-duped and sorted.
    """
    if not query.strip():
        return []
    # Tokenize the query into candidate id-shaped substrings. We import the
    # extractor here to avoid a hard dependency at module load.
    from backend.entity_extractor import extract_entities

    q_lower = query.lower()
    candidates: set[str] = {q_lower}
    for term in extract_entities(query):
        candidates.add(term.lower())
    # Cap how many LIKE patterns we'll OR together to avoid pathological
    # queries on huge entity tables.
    candidates_list = list(candidates)[:max_terms]
    if not candidates_list:
        return []

    conn = _get_conn()
    found: set[int] = set()
    for cand in candidates_list:
        rows = conn.execute(
            "SELECT chunk_ids FROM entities "
            "WHERE context_id = ? AND (name_lower = ? OR name_lower LIKE ? OR ? LIKE '%' || name_lower || '%')",
            (context_id, cand, f"%{cand}%", cand),
        ).fetchall()
        for r in rows:
            try:
                found.update(int(i) for i in json.loads(r[0]))
            except Exception:
                continue
    return sorted(found)


# ---------------------------------------------------------------------------
# Semantic search via sqlite-vec
# ---------------------------------------------------------------------------

def search_chunks_semantic(
    query_vec: list[float],
    context_id: int | None = None,
    top_k: int = 10,
    star_boost: float = 0.15,
    context_ids: list[int] | None = None,
) -> list[dict]:
    """Return top_k chunks ranked by cosine similarity via sqlite-vec.

    Scope precedence: `context_id` (single context) > `context_ids` (a set of
    contexts, e.g. a collection) > global. Starred chunks get +star_boost.
    """
    conn = _get_conn()

    # Check vec table exists
    try:
        conn.execute("SELECT rowid FROM chunk_vecs LIMIT 0")
    except Exception:
        # connection reused (thread-local pool)
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
            # connection reused (thread-local pool)
            return []

        scored_ids = [(r[0], 1.0 - r[1]) for r in vec_rows]
    elif context_ids:
        # Collection-scoped: exact cosine over the bounded subset of chunks whose
        # context is in the given set. Same JOIN approach as single-context.
        ph = ",".join("?" * len(context_ids))
        try:
            vec_rows = conn.execute(
                f"""SELECT c.id, vec_distance_cosine(cv.embedding, ?) AS dist
                    FROM chunks c
                    JOIN chunk_vecs cv ON cv.rowid = c.id
                    WHERE c.context_id IN ({ph})
                    ORDER BY dist ASC
                    LIMIT ?""",
                (q_blob, *context_ids, top_k * 3),
            ).fetchall()
        except Exception:
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
            # connection reused (thread-local pool)
            return []
        scored_ids = [(r[0], 1.0 - r[1]) for r in vec_rows]

    if not scored_ids:
        # connection reused (thread-local pool)
        return []

    # Fetch full chunk data for the matched IDs
    id_list = [sid[0] for sid in scored_ids]
    score_map = {sid[0]: sid[1] for sid in scored_ids}
    placeholders = ",".join("?" * len(id_list))
    rows = conn.execute(
        f"SELECT * FROM chunks WHERE id IN ({placeholders})", id_list
    ).fetchall()
    # connection reused (thread-local pool)

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
        # connection reused (thread-local pool)
        return []

    q_blob = _vec_to_blob(query_vec)
    try:
        vec_rows = conn.execute(
            "SELECT rowid, distance FROM context_vecs WHERE embedding MATCH ? ORDER BY distance LIMIT ?",
            (q_blob, top_k),
        ).fetchall()
    except Exception:
        # connection reused (thread-local pool)
        return []

    if not vec_rows:
        # connection reused (thread-local pool)
        return []

    id_list = [r[0] for r in vec_rows]
    placeholders = ",".join("?" * len(id_list))
    rows = conn.execute(
        f"SELECT * FROM contexts WHERE id IN ({placeholders})", id_list
    ).fetchall()
    # connection reused (thread-local pool)

    # Preserve score-based ordering from vec search
    order = {rid: idx for idx, rid in enumerate(id_list)}
    contexts = [_row_to_dict(r) for r in rows]
    contexts.sort(key=lambda c: order.get(c["id"], 999))
    return contexts


# ---------------------------------------------------------------------------
# System stats
# ---------------------------------------------------------------------------

def get_db_stats() -> dict:
    """Return row counts and file size for the status dashboard."""
    conn = _get_conn()
    contexts  = conn.execute("SELECT COUNT(*) FROM contexts").fetchone()[0]
    chunks    = conn.execute("SELECT COUNT(*) FROM chunks").fetchone()[0]
    try:
        collections = conn.execute("SELECT COUNT(*) FROM collections").fetchone()[0]
    except Exception:
        collections = 0
    try:
        row = conn.execute("SELECT value FROM app_stats WHERE key = 'questions_asked'").fetchone()
        questions_asked = row[0] if row else 0
    except Exception:
        questions_asked = 0
    # connection reused (thread-local pool)
    try:
        size_mb = round(os.path.getsize(DB_PATH) / 1_048_576, 2)
    except Exception:
        size_mb = 0.0
    try:
        from datetime import timedelta
        week_ago = (datetime.now(timezone.utc) - timedelta(days=7)).isoformat()
        contexts_this_week = conn.execute(
            "SELECT COUNT(*) FROM contexts WHERE created_at >= ?", (week_ago,)
        ).fetchone()[0]
    except Exception:
        contexts_this_week = 0
    return {"contexts": contexts, "chunks": chunks, "collections": collections,
            "size_mb": size_mb, "questions_asked": questions_asked,
            "contexts_this_week": contexts_this_week}


def increment_stat(key: str) -> None:
    """Atomically increment an app-level counter."""
    conn = _get_conn()
    conn.execute(
        "INSERT INTO app_stats (key, value) VALUES (?, 1) "
        "ON CONFLICT(key) DO UPDATE SET value = value + 1",
        (key,),
    )
    conn.commit()


# ---------------------------------------------------------------------------
# Collections CRUD
# ---------------------------------------------------------------------------

def get_all_collections() -> list[dict]:
    """Return all collections with a context count for each."""
    conn = _get_conn()
    rows = conn.execute(
        "SELECT id, name, color, created_at FROM collections ORDER BY created_at ASC"
    ).fetchall()
    counts = {
        r[0]: r[1]
        for r in conn.execute(
            "SELECT collection_id, COUNT(*) FROM contexts WHERE collection_id IS NOT NULL GROUP BY collection_id"
        ).fetchall()
    }
    # connection reused (thread-local pool)
    return [
        {"id": r[0], "name": r[1], "color": r[2], "created_at": r[3], "count": counts.get(r[0], 0)}
        for r in rows
    ]


def get_context_ids_by_collection(collection_id: int) -> list[int]:
    """Return the IDs of all contexts assigned to a collection."""
    conn = _get_conn()
    rows = conn.execute(
        "SELECT id FROM contexts WHERE collection_id = ?", (collection_id,)
    ).fetchall()
    return [r[0] for r in rows]


def create_collection(name: str, color: str = "#6366f1") -> dict:
    """Create a new collection and return it."""
    now = datetime.now(timezone.utc).isoformat()
    conn = _get_conn()
    cur = conn.execute(
        "INSERT INTO collections (name, color, created_at) VALUES (?, ?, ?)",
        (name.strip(), color, now),
    )
    cid = cur.lastrowid
    conn.commit()
    row = conn.execute("SELECT id, name, color, created_at FROM collections WHERE id = ?", (cid,)).fetchone()
    # connection reused (thread-local pool)
    return {"id": row[0], "name": row[1], "color": row[2], "created_at": row[3], "count": 0}


def update_collection(collection_id: int, name: str | None = None, color: str | None = None) -> dict | None:
    """Rename or recolor a collection."""
    conn = _get_conn()
    updates, params = [], []
    if name is not None:
        updates.append("name = ?"); params.append(name.strip())
    if color is not None:
        updates.append("color = ?"); params.append(color)
    if updates:
        params.append(collection_id)
        conn.execute(f"UPDATE collections SET {', '.join(updates)} WHERE id = ?", params)
        conn.commit()
    row = conn.execute("SELECT id, name, color, created_at FROM collections WHERE id = ?", (collection_id,)).fetchone()
    count = conn.execute("SELECT COUNT(*) FROM contexts WHERE collection_id = ?", (collection_id,)).fetchone()[0]
    # connection reused (thread-local pool)
    if not row:
        return None
    return {"id": row[0], "name": row[1], "color": row[2], "created_at": row[3], "count": count}


def delete_collection(collection_id: int) -> bool:
    """Delete a collection. Contexts in it become uncollected (collection_id → NULL)."""
    conn = _get_conn()
    conn.execute("UPDATE contexts SET collection_id = NULL WHERE collection_id = ?", (collection_id,))
    cur = conn.execute("DELETE FROM collections WHERE id = ?", (collection_id,))
    conn.commit()
    # connection reused (thread-local pool)
    return cur.rowcount > 0


# ---------------------------------------------------------------------------
# Ask Vault sessions + messages
# ---------------------------------------------------------------------------

def create_ask_session(title: str) -> dict:
    """Create a new Ask Vault session and return it."""
    now = datetime.now(timezone.utc).isoformat()
    conn = _get_conn()
    cur = conn.execute(
        "INSERT INTO ask_sessions (title, pinned, created_at, updated_at) VALUES (?, 0, ?, ?)",
        (title.strip() or "Untitled", now, now),
    )
    sid = cur.lastrowid
    conn.commit()
    return {"id": sid, "title": title, "pinned": False,
            "created_at": now, "updated_at": now, "message_count": 0}


def list_ask_sessions() -> list[dict]:
    """Return all sessions, pinned first then newest, with message counts."""
    conn = _get_conn()
    rows = conn.execute(
        """SELECT s.id, s.title, s.pinned, s.created_at, s.updated_at,
                  (SELECT COUNT(*) FROM ask_messages m WHERE m.session_id = s.id) AS message_count
           FROM ask_sessions s
           ORDER BY s.pinned DESC, s.updated_at DESC"""
    ).fetchall()
    return [
        {"id": r[0], "title": r[1], "pinned": bool(r[2]),
         "created_at": r[3], "updated_at": r[4], "message_count": r[5]}
        for r in rows
    ]


def get_ask_session(session_id: int) -> dict | None:
    """Return a session with its full message list (ordered oldest → newest)."""
    conn = _get_conn()
    srow = conn.execute(
        "SELECT id, title, pinned, created_at, updated_at FROM ask_sessions WHERE id = ?",
        (session_id,),
    ).fetchone()
    if not srow:
        return None
    mrows = conn.execute(
        """SELECT id, role, content, citations_json, created_at
           FROM ask_messages WHERE session_id = ?
           ORDER BY id ASC""",
        (session_id,),
    ).fetchall()
    messages = []
    for m in mrows:
        cites = []
        if m[3]:
            try:
                cites = json.loads(m[3])
            except Exception:
                cites = []
        messages.append({"id": m[0], "role": m[1], "content": m[2],
                         "citations": cites, "created_at": m[4]})
    return {"id": srow[0], "title": srow[1], "pinned": bool(srow[2]),
            "created_at": srow[3], "updated_at": srow[4], "messages": messages}


def append_ask_message(
    session_id: int,
    role: str,
    content: str,
    citations: list[dict] | None = None,
) -> dict:
    """Append a message to a session and bump the session's updated_at."""
    now = datetime.now(timezone.utc).isoformat()
    conn = _get_conn()
    cites_json = json.dumps(citations) if citations else None
    cur = conn.execute(
        """INSERT INTO ask_messages (session_id, role, content, citations_json, created_at)
           VALUES (?, ?, ?, ?, ?)""",
        (session_id, role, content, cites_json, now),
    )
    mid = cur.lastrowid
    conn.execute("UPDATE ask_sessions SET updated_at = ? WHERE id = ?", (now, session_id))
    conn.commit()
    return {"id": mid, "session_id": session_id, "role": role,
            "content": content, "citations": citations or [], "created_at": now}


def update_ask_session(session_id: int, title: str | None = None, pinned: bool | None = None) -> dict | None:
    """Rename or pin/unpin a session."""
    conn = _get_conn()
    updates, params = [], []
    if title is not None:
        updates.append("title = ?"); params.append(title.strip() or "Untitled")
    if pinned is not None:
        updates.append("pinned = ?"); params.append(1 if pinned else 0)
    if updates:
        params.append(session_id)
        conn.execute(f"UPDATE ask_sessions SET {', '.join(updates)} WHERE id = ?", params)
        conn.commit()
    row = conn.execute(
        """SELECT id, title, pinned, created_at, updated_at,
                  (SELECT COUNT(*) FROM ask_messages m WHERE m.session_id = ask_sessions.id)
           FROM ask_sessions WHERE id = ?""",
        (session_id,),
    ).fetchone()
    if not row:
        return None
    return {"id": row[0], "title": row[1], "pinned": bool(row[2]),
            "created_at": row[3], "updated_at": row[4], "message_count": row[5]}


def delete_ask_session(session_id: int) -> bool:
    """Delete a session and all its messages (FK cascade)."""
    conn = _get_conn()
    cur = conn.execute("DELETE FROM ask_sessions WHERE id = ?", (session_id,))
    conn.commit()
    return cur.rowcount > 0


# ---------------------------------------------------------------------------
# Collection assignment
# ---------------------------------------------------------------------------

def set_context_collection(context_id: int, collection_id: int | None) -> dict | None:
    """Assign (or unassign with None) a context to a collection."""
    conn = _get_conn()
    conn.execute(
        "UPDATE contexts SET collection_id = ? WHERE id = ?",
        (collection_id, context_id),
    )
    conn.commit()
    row = conn.execute("SELECT * FROM contexts WHERE id = ?", (context_id,)).fetchone()
    # connection reused (thread-local pool)
    return _row_to_dict(row)
