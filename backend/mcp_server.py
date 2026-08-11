"""
ContextVolt — MCP server (stdio transport).

Exposes the user's saved-context vault to any MCP host (Claude Desktop, Cursor,
Claude Code, etc.) so external LLMs can search, browse, and read the contexts
that ConVX has captured.

Run as a module from the project root:
    python -m backend.mcp_server

Wire it into Claude Desktop with a config like:

    {
      "mcpServers": {
        "contextvolt": {
          "command": "python",
          "args": ["-m", "backend.mcp_server"],
          "cwd": "E:/ConVX"
        }
      }
    }

Design notes
- Reads only — never mutates the vault. Safe to run alongside the FastAPI app.
- Imports kept tight: only `database` and `ollama_client` (NOT main / mcp_manager).
- All logging goes to stderr; stdout is reserved for MCP protocol JSON-RPC frames.
- Embedding lookups gracefully fall back to keyword search if Ollama is offline.
"""

from __future__ import annotations

import asyncio
import base64
import json
import logging
import os
import sys
from typing import Any

# Self-bootstrap: when this file is launched as a path (e.g. Claude Desktop's
# GUI form fills only `command` + `args` and ignores `cwd`), Python doesn't see
# the project root on sys.path, so `from backend import ...` would fail with
# ModuleNotFoundError. Add the project root explicitly before any backend
# imports so the script works regardless of how it's invoked.
_HERE = os.path.dirname(os.path.abspath(__file__))
_PROJECT_ROOT = os.path.dirname(_HERE)
if _PROJECT_ROOT not in sys.path:
    sys.path.insert(0, _PROJECT_ROOT)

# Logging MUST go to stderr — stdout is the MCP protocol channel.
logging.basicConfig(
    level=logging.INFO,
    stream=sys.stderr,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
_log = logging.getLogger("contextvolt.mcp_server")

try:
    # pyrefly: ignore [missing-import]
    from mcp.server import Server
    # pyrefly: ignore [missing-import]
    from mcp.server.stdio import stdio_server
    # pyrefly: ignore [missing-import]
    import mcp.types as types
except ImportError as e:
    print(f"FATAL: mcp SDK not installed ({e}). Run: pip install 'mcp>=1.0.0'",
          file=sys.stderr)
    sys.exit(1)

# Make `backend.*` importable when launched via `python -m backend.mcp_server`
# from the project root. If the user invokes us with the wrong cwd, fail loudly
# with a clear hint instead of cryptic ImportError.
try:
    from backend import database
    from backend.ollama_client import embed_text
    # local_engine_ready(), not check_ollama_running(): under the native backend
    # Ollama is absent by design, so gating on it would silently drop MCP search
    # to keyword-only even though embeddings work fine.
    from backend.engine import local_engine_ready
except ImportError as e:
    print(
        f"FATAL: cannot import ConVX backend ({e}). "
        "Run from the ConVX project root, e.g. `cd E:/ConVX && python -m backend.mcp_server`.",
        file=sys.stderr,
    )
    sys.exit(1)


SERVER_NAME = "contextvolt"
SERVER_VERSION = "0.1.0"
RESOURCE_SCHEME = "convx"  # convx://context/{id}

# ── Icon (embedded base64 data-URI so it works over stdio & HTTP) ────
_ICON_PATH = os.path.join(_PROJECT_ROOT, "main icon", "CVicon.png")
_cv_icons: list[types.Icon] | None = None
try:
    with open(_ICON_PATH, "rb") as _f:
        _b64 = base64.b64encode(_f.read()).decode("ascii")
    _cv_icons = [
        types.Icon(
            src=f"data:image/png;base64,{_b64}",
            mimeType="image/png",
        )
    ]
    _log.info("Loaded CV icon from %s (%d bytes encoded)", _ICON_PATH, len(_b64))
except FileNotFoundError:
    _log.warning("CV icon not found at %s — server will use default icon", _ICON_PATH)
except Exception as _exc:
    _log.warning("Could not load CV icon: %s", _exc)

server = Server(SERVER_NAME, icons=_cv_icons)


# ─────────────────────────────────────────────────────────────────────
# Helpers
# ─────────────────────────────────────────────────────────────────────

def _summary_to_text(summary: Any) -> str:
    """Render a context summary dict as compact markdown."""
    if isinstance(summary, str):
        return summary
    if not isinstance(summary, dict):
        return ""
    parts: list[str] = []
    if summary.get("main_topic"):
        parts.append(f"**Topic:** {summary['main_topic']}")
    if summary.get("snapshot"):
        parts.append(summary["snapshot"])
    if summary.get("key_ideas"):
        parts.append("**Key ideas:**\n" + "\n".join(f"- {x}" for x in summary["key_ideas"]))
    if summary.get("vitals"):
        parts.append("**Vitals:**\n" + "\n".join(f"- {x}" for x in summary["vitals"]))
    if summary.get("conclusions"):
        parts.append("**Conclusions:**\n" + "\n".join(f"- {x}" for x in summary["conclusions"]))
    if summary.get("unresolved_questions"):
        parts.append("**Open questions:**\n" + "\n".join(f"- {x}" for x in summary["unresolved_questions"]))
    return "\n\n".join(parts)


def _truncate(text: str, max_chars: int) -> str:
    if not text:
        return ""
    return text if len(text) <= max_chars else text[:max_chars].rstrip() + "…"


def _format_chunk(ch: dict, max_chars: int = 1500) -> dict:
    return {
        "id": ch.get("id"),
        "context_id": ch.get("context_id"),
        "context_title": ch.get("context_title") or ch.get("title"),
        "chunk_index": ch.get("chunk_index"),
        "score": round(ch.get("_score") or 0.0, 3) if ch.get("_score") else None,
        "is_starred": bool(ch.get("is_starred")),
        "text": _truncate(ch.get("text", ""), max_chars),
    }


def _format_context_meta(ctx: dict) -> dict:
    tags = ctx.get("tags", [])
    if isinstance(tags, str):
        tags = [t.strip() for t in tags.split(",") if t.strip()]
    return {
        "id": ctx.get("id"),
        "title": ctx.get("title", ""),
        "tags": tags,
        "created_at": ctx.get("created_at", ""),
        "updated_at": ctx.get("updated_at", ""),
        "starred": bool(ctx.get("starred")),
        "status": ctx.get("status", "completed"),
    }


# ─────────────────────────────────────────────────────────────────────
# Tools
# ─────────────────────────────────────────────────────────────────────

TOOLS: list[types.Tool] = [
    types.Tool(
        name="search_vault",
        description=(
            "Search the user's ContextVolt vault for chunks of saved conversations "
            "matching a query. Uses semantic embedding search when available, with "
            "keyword fallback. Returns ranked chunks with their source context titles. "
            "Use this first when the user asks about something they may have discussed before."
        ),
        inputSchema={
            "type": "object",
            "properties": {
                "query": {"type": "string", "description": "Natural-language search query"},
                "top_k": {"type": "integer", "minimum": 1, "maximum": 30, "default": 8},
                "context_id": {"type": "integer",
                                "description": "Optional — restrict search to a single context"},
            },
            "required": ["query"],
        },
    ),
    types.Tool(
        name="get_context",
        description=(
            "Fetch the full record for one saved context: title, summary, tags, "
            "creation date, and the original captured chat (truncated)."
        ),
        inputSchema={
            "type": "object",
            "properties": {
                "context_id": {"type": "integer"},
                "include_original_chat": {"type": "boolean", "default": False,
                    "description": "If true, include the raw original conversation (up to 20k chars)"},
            },
            "required": ["context_id"],
        },
    ),
    types.Tool(
        name="list_recent_contexts",
        description=(
            "List recently saved contexts (titles + tags only). Use to browse what "
            "the user has captured without running a search."
        ),
        inputSchema={
            "type": "object",
            "properties": {
                "limit": {"type": "integer", "minimum": 1, "maximum": 100, "default": 20},
                "sort": {"type": "string", "enum": ["newest", "oldest", "alpha"], "default": "newest"},
            },
        },
    ),
    types.Tool(
        name="get_chunks",
        description=(
            "Pull chunks for a specific context by index range. Useful after "
            "search_vault/get_context to read the actual conversation slices."
        ),
        inputSchema={
            "type": "object",
            "properties": {
                "context_id": {"type": "integer"},
                "start_index": {"type": "integer", "minimum": 0, "default": 0},
                "end_index": {"type": "integer", "minimum": 0,
                              "description": "Inclusive. Omit for all chunks."},
                "max_chars_per_chunk": {"type": "integer", "minimum": 200, "maximum": 8000, "default": 2000},
            },
            "required": ["context_id"],
        },
    ),
    types.Tool(
        name="vault_stats",
        description="High-level stats about the vault — total contexts, chunks, embedding coverage.",
        inputSchema={"type": "object", "properties": {}},
    ),
    types.Tool(
        name="search_contexts",
        description=(
            "Search for whole contexts (titles + summaries) matching a query, ranked by "
            "relevance. Use this when the user asks WHICH saved conversation is about X "
            "(as opposed to search_vault, which finds individual chunks)."
        ),
        inputSchema={
            "type": "object",
            "properties": {
                "query": {"type": "string", "description": "Natural-language search query"},
                "top_k": {"type": "integer", "minimum": 1, "maximum": 50, "default": 10},
            },
            "required": ["query"],
        },
    ),
    types.Tool(
        name="get_chunk_neighbors",
        description=(
            "Given a context_id and chunk_index, return the immediately surrounding "
            "chunks (index-1 and index+1). Use to expand the window around a search hit "
            "without pulling the entire context."
        ),
        inputSchema={
            "type": "object",
            "properties": {
                "context_id": {"type": "integer"},
                "chunk_index": {"type": "integer", "minimum": 0},
                "max_chars_per_chunk": {"type": "integer", "minimum": 200, "maximum": 8000, "default": 2000},
            },
            "required": ["context_id", "chunk_index"],
        },
    ),
    types.Tool(
        name="find_related_contexts",
        description=(
            "Given a context_id, return other contexts that are semantically similar to "
            "it (using its stored embedding). Useful for 'what else have I saved that's "
            "related to this one'. Requires the source context to have an embedding."
        ),
        inputSchema={
            "type": "object",
            "properties": {
                "context_id": {"type": "integer"},
                "top_k": {"type": "integer", "minimum": 1, "maximum": 30, "default": 8},
            },
            "required": ["context_id"],
        },
    ),
    types.Tool(
        name="list_starred_contexts",
        description=(
            "List the user's starred (pinned/important) contexts. The user has flagged "
            "these as high-signal, so prefer them when looking for canonical answers."
        ),
        inputSchema={
            "type": "object",
            "properties": {
                "limit": {"type": "integer", "minimum": 1, "maximum": 100, "default": 25},
            },
        },
    ),
    types.Tool(
        name="list_collections",
        description=(
            "Enumerate the user's collections (top-level folders/projects that group "
            "contexts). Use to discover organization before drilling into a topic."
        ),
        inputSchema={"type": "object", "properties": {}},
    ),
    types.Tool(
        name="list_contexts_by_tag",
        description=(
            "List contexts that carry a given tag. Tag matching is case-insensitive and "
            "exact (not substring). Use after list_recent_contexts reveals the available "
            "tag vocabulary."
        ),
        inputSchema={
            "type": "object",
            "properties": {
                "tag": {"type": "string", "description": "Exact tag to match (case-insensitive)"},
                "limit": {"type": "integer", "minimum": 1, "maximum": 200, "default": 50},
            },
            "required": ["tag"],
        },
    ),
]


@server.list_tools()
async def list_tools() -> list[types.Tool]:
    return TOOLS


@server.call_tool()
async def call_tool(name: str, arguments: dict | None) -> list[types.TextContent]:
    args = arguments or {}
    try:
        if name == "search_vault":
            payload = await _tool_search_vault(args)
        elif name == "get_context":
            payload = _tool_get_context(args)
        elif name == "list_recent_contexts":
            payload = _tool_list_recent_contexts(args)
        elif name == "get_chunks":
            payload = _tool_get_chunks(args)
        elif name == "vault_stats":
            payload = _tool_vault_stats()
        elif name == "search_contexts":
            payload = await _tool_search_contexts(args)
        elif name == "get_chunk_neighbors":
            payload = _tool_get_chunk_neighbors(args)
        elif name == "find_related_contexts":
            payload = _tool_find_related_contexts(args)
        elif name == "list_starred_contexts":
            payload = _tool_list_starred_contexts(args)
        elif name == "list_collections":
            payload = _tool_list_collections()
        elif name == "list_contexts_by_tag":
            payload = _tool_list_contexts_by_tag(args)
        else:
            return [types.TextContent(type="text", text=f"unknown tool: {name!r}")]
    except Exception as e:
        _log.exception("tool %s failed", name)
        return [types.TextContent(type="text", text=f"error: {type(e).__name__}: {e}")]

    return [types.TextContent(type="text", text=json.dumps(payload, ensure_ascii=False, indent=2))]


# ─────────────────────────────────────────────────────────────────────
# Tool implementations
# ─────────────────────────────────────────────────────────────────────

async def _tool_search_vault(args: dict) -> dict:
    query = (args.get("query") or "").strip()
    if not query:
        return {"error": "query is required"}
    top_k = max(1, min(30, int(args.get("top_k") or 8)))
    context_id = args.get("context_id")

    # Try semantic first; fall back to keyword if the local engine is down or returns nothing.
    semantic_chunks: list[dict] = []
    embed_ok = local_engine_ready()
    if embed_ok:
        try:
            qvec = embed_text(query)
            if qvec:
                semantic_chunks = database.search_chunks_semantic(
                    qvec, context_id=context_id, top_k=top_k,
                )
        except Exception as e:
            _log.warning("semantic search failed, falling back to keyword: %s", e)

    if not semantic_chunks:
        keyword_chunks = database.search_chunks_keyword(query, top_k=top_k)
        if context_id is not None:
            keyword_chunks = [c for c in keyword_chunks if c.get("context_id") == context_id]
        semantic_chunks = keyword_chunks

    # Hydrate context titles
    cids = list({c.get("context_id") for c in semantic_chunks if c.get("context_id")})
    ctx_map = database.get_contexts_by_ids(cids)
    for ch in semantic_chunks:
        ctx = ctx_map.get(ch.get("context_id"), {})
        ch["context_title"] = ctx.get("title", "")

    return {
        "query": query,
        "mode": "semantic" if embed_ok else "keyword",
        "results": [_format_chunk(c, max_chars=1500) for c in semantic_chunks[:top_k]],
        "count": min(len(semantic_chunks), top_k),
    }


def _tool_get_context(args: dict) -> dict:
    cid = int(args["context_id"])
    include_chat = bool(args.get("include_original_chat"))
    ctx = database.get_context(cid)
    if not ctx:
        return {"error": f"context {cid} not found"}
    out = _format_context_meta(ctx)
    out["summary"] = ctx.get("summary")
    out["summary_text"] = _summary_to_text(ctx.get("summary"))
    if include_chat:
        out["original_chat"] = _truncate(ctx.get("original_chat", ""), 20_000)
    return out


def _tool_list_recent_contexts(args: dict) -> dict:
    limit = max(1, min(100, int(args.get("limit") or 20)))
    sort = args.get("sort") or "newest"
    page = database.get_contexts_paginated(page=1, per_page=limit, sort=sort)
    return {
        "total": page.get("total", 0),
        "returned": len(page.get("contexts") or []),
        "contexts": [_format_context_meta(c) for c in page.get("contexts") or []],
    }


def _tool_get_chunks(args: dict) -> dict:
    cid = int(args["context_id"])
    start = max(0, int(args.get("start_index") or 0))
    end = args.get("end_index")
    max_chars = max(200, min(8000, int(args.get("max_chars_per_chunk") or 2000)))
    all_chunks = database.get_chunks_by_context(cid)
    if not all_chunks:
        return {"context_id": cid, "chunks": [], "total": 0}
    sliced = [c for c in all_chunks
              if c.get("chunk_index", 0) >= start
              and (end is None or c.get("chunk_index", 0) <= int(end))]
    return {
        "context_id": cid,
        "total": len(all_chunks),
        "returned": len(sliced),
        "chunks": [_format_chunk(c, max_chars=max_chars) for c in sliced],
    }


def _tool_vault_stats() -> dict:
    stats = database.get_db_stats()
    return {**stats, "ollama_running": local_engine_ready()}


async def _tool_search_contexts(args: dict) -> dict:
    query = (args.get("query") or "").strip()
    if not query:
        return {"error": "query is required"}
    top_k = max(1, min(50, int(args.get("top_k") or 10)))

    results: list[dict] = []
    embed_ok = local_engine_ready()
    mode = "keyword"
    if embed_ok:
        try:
            qvec = embed_text(query)
            if qvec:
                results = database.search_contexts_semantic(qvec, top_k=top_k)
                mode = "semantic"
        except Exception as e:
            _log.warning("semantic context search failed, falling back: %s", e)

    if not results:
        results = database.search_contexts(query)[:top_k]
        mode = "keyword"

    out = []
    for ctx in results[:top_k]:
        meta = _format_context_meta(ctx)
        meta["summary_text"] = _truncate(_summary_to_text(ctx.get("summary")), 600)
        out.append(meta)
    return {"query": query, "mode": mode, "count": len(out), "results": out}


def _tool_get_chunk_neighbors(args: dict) -> dict:
    cid = int(args["context_id"])
    idx = int(args["chunk_index"])
    max_chars = max(200, min(8000, int(args.get("max_chars_per_chunk") or 2000)))
    neighbors = database.get_chunk_neighbors(cid, idx)
    return {
        "context_id": cid,
        "chunk_index": idx,
        "count": len(neighbors),
        "chunks": [_format_chunk(c, max_chars=max_chars) for c in neighbors],
    }


def _tool_find_related_contexts(args: dict) -> dict:
    cid = int(args["context_id"])
    top_k = max(1, min(30, int(args.get("top_k") or 8)))
    ctx = database.get_context(cid)
    if not ctx:
        return {"error": f"context {cid} not found"}

    raw_emb = ctx.get("embedding")
    vec: list[float] | None = None
    if isinstance(raw_emb, str):
        try:
            vec = json.loads(raw_emb)
        except Exception:
            vec = None
    elif isinstance(raw_emb, list):
        vec = raw_emb
    if not vec:
        return {"error": f"context {cid} has no embedding — cannot find related"}

    related = database.search_contexts_semantic(vec, top_k=top_k + 1)
    related = [c for c in related if c.get("id") != cid][:top_k]
    return {
        "source_context_id": cid,
        "count": len(related),
        "results": [_format_context_meta(c) for c in related],
    }


def _tool_list_starred_contexts(args: dict) -> dict:
    limit = max(1, min(100, int(args.get("limit") or 25)))
    page = database.get_contexts_paginated(page=1, per_page=200, sort="newest")
    starred = [c for c in (page.get("contexts") or []) if c.get("starred")][:limit]
    return {
        "returned": len(starred),
        "contexts": [_format_context_meta(c) for c in starred],
    }


def _tool_list_collections() -> dict:
    cols = database.get_all_collections()
    return {"count": len(cols), "collections": cols}


def _tool_list_contexts_by_tag(args: dict) -> dict:
    tag = (args.get("tag") or "").strip().lower()
    if not tag:
        return {"error": "tag is required"}
    limit = max(1, min(200, int(args.get("limit") or 50)))

    matched: list[dict] = []
    page_num = 1
    per_page = 100
    while len(matched) < limit:
        page = database.get_contexts_paginated(page=page_num, per_page=per_page, sort="newest")
        rows = page.get("contexts") or []
        for ctx in rows:
            tags = [t.lower() for t in (ctx.get("tags") or [])]
            if tag in tags:
                matched.append(ctx)
                if len(matched) >= limit:
                    break
        if not page.get("has_more"):
            break
        page_num += 1

    return {
        "tag": tag,
        "returned": len(matched),
        "contexts": [_format_context_meta(c) for c in matched],
    }


# ─────────────────────────────────────────────────────────────────────
# Resources — every context is a browsable resource at convx://context/{id}
# ─────────────────────────────────────────────────────────────────────

@server.list_resources()
async def list_resources() -> list[types.Resource]:
    page = database.get_contexts_paginated(page=1, per_page=200, sort="newest")
    out: list[types.Resource] = []
    for ctx in page.get("contexts") or []:
        cid = ctx.get("id")
        if cid is None:
            continue
        title = ctx.get("title") or f"Context {cid}"
        out.append(types.Resource(
            uri=f"{RESOURCE_SCHEME}://context/{cid}",
            name=title,
            description=f"Saved ContextVolt context #{cid}",
            mimeType="text/markdown",
        ))
    return out


@server.read_resource()
async def read_resource(uri: Any) -> str:
    uri_str = str(uri)
    prefix = f"{RESOURCE_SCHEME}://context/"
    if not uri_str.startswith(prefix):
        raise ValueError(f"unsupported uri: {uri_str}")
    try:
        cid = int(uri_str[len(prefix):])
    except ValueError as e:
        raise ValueError(f"bad context id in uri: {uri_str}") from e
    ctx = database.get_context(cid)
    if not ctx:
        raise ValueError(f"context {cid} not found")

    meta = _format_context_meta(ctx)
    summary_text = _summary_to_text(ctx.get("summary"))
    chunks = database.get_chunks_by_context(cid)

    parts = [f"# {meta['title']}", ""]
    if meta["tags"]:
        parts.append(f"**Tags:** {', '.join(meta['tags'])}")
    parts.append(f"**Saved:** {meta['created_at']}")
    parts.append("")
    if summary_text:
        parts.append("## Summary")
        parts.append(summary_text)
        parts.append("")
    if chunks:
        parts.append(f"## Conversation ({len(chunks)} chunks)")
        for ch in chunks:
            parts.append(f"\n### Chunk {ch.get('chunk_index')}")
            parts.append(_truncate(ch.get("text", ""), 4000))
    return "\n".join(parts)


# ─────────────────────────────────────────────────────────────────────
# Entrypoint
# ─────────────────────────────────────────────────────────────────────

async def _main() -> None:
    _log.info("ContextVolt MCP server %s starting (stdio)", SERVER_VERSION)
    # Idempotent — handles cold-start when the FastAPI app has never run yet.
    try:
        database.init_db()
    except Exception as e:
        _log.warning("init_db skipped: %s", e)
    async with stdio_server() as (read_stream, write_stream):
        await server.run(read_stream, write_stream, server.create_initialization_options())


if __name__ == "__main__":
    try:
        asyncio.run(_main())
    except KeyboardInterrupt:
        _log.info("shutting down")
