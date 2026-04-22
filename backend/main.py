"""
ContextVolt — FastAPI application.

Serves the REST API and static frontend files.
"""

import json
import os
import re
import subprocess
import sys
import threading
import time
from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, JSONResponse, Response, StreamingResponse

from backend.database import (
    init_db,
    get_db_stats,
    create_context,
    create_chunks,
    get_all_contexts,
    get_contexts_paginated,
    get_context,
    get_contexts_by_ids,
    get_chunks_by_context,
    update_context,
    delete_context,
    delete_chunks_by_context,
    search_contexts,
    search_contexts_semantic,
    search_chunks_semantic,
    set_context_embedding,
    toggle_context_starred,
    update_chunk_embedding,
    search_chunks_keyword,
    get_all_collections,
    create_collection,
    update_collection,
    delete_collection,
    set_context_collection,
)
from backend.models import (
    SummarizeRequest, ContextCreate, ContextUpdate, CaptureRequest,
    PromptRequest, EmbedModelSelect, ModelSelect,
    CollectionCreate, CollectionUpdate, ContextCollectionSet,
)
from backend.ollama_client import (
    summarize_conversation,
    summarize_conversation_streaming,
    generate_continuation_prompt,
    build_hybrid_prompt,
    chunk_conversation,
    embed_chunks,
    build_retrieval_prompt,
    build_cross_context_prompt,
    embed_text,
    check_ollama_running,
    check_model_available,
    DEFAULT_MODEL,
    _USER_TURN,
)

# ---------------------------------------------------------------------------
# Rate limiting (in-memory, per-IP, sliding window)
# ---------------------------------------------------------------------------

_rate_limit_store: dict[str, list[float]] = {}
_rate_limit_lock = threading.Lock()

# Limits per route prefix (requests / window_seconds)
_RATE_LIMITS: list[tuple[str, int, int]] = [
    ("/api/capture",          30,  60),   # extension capture: 30 req/min
    ("/api/summarize",        10,  60),   # summarization: 10 req/min
    ("/api/retrieve",         60,  60),   # search/retrieve: 60 req/min
    ("/api/setup/pull-model", 5,   300),  # model pulls: 5 per 5 min
    ("/api/",                 200, 60),   # all other API calls: 200 req/min
]


def _check_rate_limit(client: str, path: str) -> None:
    now = time.monotonic()
    for prefix, limit, window in _RATE_LIMITS:
        if path.startswith(prefix):
            key = f"{client}:{prefix}"
            with _rate_limit_lock:
                timestamps = _rate_limit_store.get(key, [])
                timestamps = [t for t in timestamps if now - t < window]
                if len(timestamps) >= limit:
                    raise HTTPException(
                        status_code=429,
                        detail=f"Rate limit exceeded. Max {limit} requests per {window}s.",
                    )
                timestamps.append(now)
                _rate_limit_store[key] = timestamps
            break


# ---------------------------------------------------------------------------
# App setup
# ---------------------------------------------------------------------------

app = FastAPI(title="ContextVolt", version="1.0.0")


@app.middleware("http")
async def rate_limit_middleware(request: Request, call_next):
    client = request.client.host if request.client else "unknown"
    _check_rate_limit(client, request.url.path)
    return await call_next(request)


app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:8000",
        "http://127.0.0.1:8000",
    ],
    allow_credentials=True,
    allow_methods=["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allow_headers=["Content-Type", "Accept", "Authorization"],
)

# Initialize database on startup
init_db()


def _try_embed_context(context_id: int | None, summary: dict) -> None:
    """Generate and store an embedding for a context (best-effort, never raises)."""
    if not context_id or not isinstance(summary, dict):
        return
    try:
        topic = summary.get("main_topic", "")
        ideas = " ".join(summary.get("key_ideas", []))
        vec = embed_text(f"{topic} {ideas}".strip())
        if vec:
            set_context_embedding(context_id, vec)
    except Exception:
        pass


# Mount static frontend files
FRONTEND_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "frontend")
if os.path.isdir(FRONTEND_DIR):
    app.mount("/static", StaticFiles(directory=FRONTEND_DIR), name="static")


# ---------------------------------------------------------------------------
# Root — serve the frontend
# ---------------------------------------------------------------------------

@app.get("/")
def serve_frontend():
    index_path = os.path.join(FRONTEND_DIR, "index.html")
    if os.path.exists(index_path):
        return FileResponse(index_path)
    return {"message": "ContextVolt API is running. Frontend not found."}


# ---------------------------------------------------------------------------
# Health & Setup Status
# ---------------------------------------------------------------------------

_server_token: dict = {"started_at": time.time()}  # mutable — run.py updates this on each launch

@app.get("/api/health")
def health():
    return {"status": "ok", "started_at": _server_token["started_at"]}


@app.get("/api/setup/status")
def setup_status():
    """Report readiness of all services for the Setup Wizard UI."""
    from backend.ollama_client import _get_default_model
    current_model = _get_default_model()
    ollama_running = check_ollama_running()
    model_ready = check_model_available(current_model) if ollama_running else False
    return {
        "backend": True,
        "ollama_running": ollama_running,
        "model_ready": model_ready,
        "model_name": current_model,
    }


@app.post("/api/setup/pull-model")
def pull_model():
    """Trigger an Ollama model pull in the background."""
    if not check_ollama_running():
        raise HTTPException(status_code=503, detail="Ollama is not running")
    try:
        subprocess.Popen(
            ["ollama", "pull", DEFAULT_MODEL],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            creationflags=subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0,
        )
        return {"status": "pulling", "model": DEFAULT_MODEL}
    except FileNotFoundError:
        raise HTTPException(status_code=503, detail="Ollama CLI not found")


# ---------------------------------------------------------------------------
# Embed model setup
# ---------------------------------------------------------------------------

_CFG_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "config.json")

_EMBED_MODEL_OPTIONS = [
    {"id": "nomic-embed-text", "label": "nomic-embed-text", "size": "274 MB",
     "desc": "Fast, good baseline. Works out of the box.", "recommended": False},
    {"id": "mxbai-embed-large", "label": "mxbai-embed-large", "size": "670 MB",
     "desc": "Best quality for English technical text. Recommended.", "recommended": True},
    {"id": "nomic-embed-text:v1.5", "label": "nomic-embed-text v1.5", "size": "274 MB",
     "desc": "Drop-in upgrade — same size, better accuracy.", "recommended": False},
    {"id": "bge-m3", "label": "bge-m3", "size": "1.2 GB",
     "desc": "Best for multilingual + technical jargon. Large.", "recommended": False},
]


def _read_config() -> dict:
    try:
        with open(_CFG_PATH, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return {}


def _write_config(data: dict) -> None:
    """Atomic write: write to temp file then rename to avoid corruption on crash."""
    import tempfile
    tmp_fd, tmp_path = tempfile.mkstemp(
        dir=os.path.dirname(_CFG_PATH), suffix=".tmp", prefix=".config_"
    )
    try:
        with os.fdopen(tmp_fd, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2)
        os.replace(tmp_path, _CFG_PATH)
    except Exception:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass
        raise


@app.get("/api/setup/embed-status")
def embed_setup_status():
    """Return current embed model config and available model list."""
    cfg = _read_config()
    current = cfg.get("embed_model", "nomic-embed-text")
    ollama_ok = check_ollama_running()
    ready = check_model_available(current) if ollama_ok else False
    return {
        "current_embed_model": current,
        "embed_model_ready": ready,
        "available_models": _EMBED_MODEL_OPTIONS,
    }


@app.post("/api/setup/select-embed-model")
def select_embed_model(req: EmbedModelSelect):
    """Save the chosen embed model to config.json."""
    cfg = _read_config()
    cfg["embed_model"] = req.model
    _write_config(cfg)
    return {"status": "saved", "embed_model": req.model}


@app.post("/api/setup/select-model")
def select_model(req: ModelSelect):
    """Save the chosen LLM model to config.json."""
    cfg = _read_config()
    cfg["model"] = req.model
    _write_config(cfg)
    return {"status": "saved", "model": req.model}


@app.get("/api/setup/config")
def get_config():
    """Return the current model config and available options for the Settings modal.

    Each entry in available_models / available_embed_models includes an installed
    boolean so the frontend can show which models are already downloaded.
    """
    cfg = _read_config()
    ollama_ok = check_ollama_running()
    current_model = cfg.get("model", DEFAULT_MODEL)
    current_embed = cfg.get("embed_model", "nomic-embed-text")

    # Fetch installed model names once — single HTTP call
    installed_names: list[str] = []
    if ollama_ok:
        try:
            import requests as _req
            r = _req.get("http://localhost:11434/api/tags", timeout=4)
            if r.status_code == 200:
                installed_names = [m.get("name", "") for m in r.json().get("models", [])]
        except Exception:
            pass

    def _is_installed(model_id: str) -> bool:
        return any(
            n == model_id
            or n.split(":")[0] == model_id
            or model_id.split(":")[0] == n.split(":")[0]
            for n in installed_names
        )

    llm_models = [
        {"id": "qwen2.5:1.5b", "label": "Qwen 2.5 1.5B", "size": "~1 GB",
         "desc": "Lightweight — minimal hardware, basic quality", "recommended": False},
        {"id": "qwen2.5:3b",  "label": "Qwen 2.5 3B",  "size": "~2 GB",
         "desc": "Recommended — fast, great summaries, runs on most hardware", "recommended": True},
        {"id": "qwen2.5:7b",  "label": "Qwen 2.5 7B",  "size": "~5 GB",
         "desc": "Best quality — needs 6 GB+ VRAM or 8 GB+ RAM", "recommended": False},
    ]
    for m in llm_models:
        m["installed"] = _is_installed(m["id"])

    embed_models = [dict(m) for m in _EMBED_MODEL_OPTIONS]
    for m in embed_models:
        m["installed"] = _is_installed(m["id"])

    return {
        "model": current_model,
        "embed_model": current_embed,
        "model_ready": _is_installed(current_model),
        "embed_model_ready": _is_installed(current_embed),
        "ollama_running": ollama_ok,
        "available_models": llm_models,
        "available_embed_models": embed_models,
    }


@app.post("/api/setup/pull-embed-model")
def pull_embed_model():
    """Trigger an Ollama pull for the configured embed model."""
    if not check_ollama_running():
        raise HTTPException(status_code=503, detail="Ollama is not running")
    cfg = _read_config()
    model = cfg.get("embed_model", "nomic-embed-text")
    try:
        subprocess.Popen(
            ["ollama", "pull", model],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            creationflags=subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0,
        )
        return {"status": "pulling", "model": model}
    except FileNotFoundError:
        raise HTTPException(status_code=503, detail="Ollama CLI not found")


@app.post("/api/setup/pull-model-stream")
def pull_model_stream(body: ModelSelect):
    """Stream Ollama pull progress for a model as NDJSON.

    Each line: {"status": "downloading", "completed": bytes, "total": bytes}
    Final line: {"status": "success"}
    """
    if not check_ollama_running():
        raise HTTPException(status_code=503, detail="Ollama is not running")

    import requests as _req
    import json as _json

    def _stream():
        try:
            resp = _req.post(
                "http://localhost:11434/api/pull",
                json={"name": body.model, "stream": True},
                stream=True,
                timeout=600,
            )
            for line in resp.iter_lines():
                if line:
                    try:
                        data = _json.loads(line)
                        yield _json.dumps(data) + "\n"
                    except Exception:
                        pass
        except Exception as e:
            yield _json.dumps({"status": "error", "error": str(e)}) + "\n"

    return StreamingResponse(_stream(), media_type="application/x-ndjson")


# ---------------------------------------------------------------------------
# Summarization
# ---------------------------------------------------------------------------

@app.post("/api/summarize")
def api_summarize(req: SummarizeRequest):
    """Send conversation text to Ollama and return a structured summary."""
    if not req.text.strip():
        raise HTTPException(status_code=400, detail="Text cannot be empty")

    if not check_ollama_running():
        raise HTTPException(
            status_code=503,
            detail="Ollama is not running. Please start it with 'ollama serve'.",
        )

    if not check_model_available():
        raise HTTPException(
            status_code=503,
            detail=f"Model '{DEFAULT_MODEL}' is not available. Pull it with 'ollama pull {DEFAULT_MODEL}'.",
        )

    try:
        summary = summarize_conversation(req.text)
        return summary
    except ConnectionError as e:
        raise HTTPException(status_code=503, detail=str(e))
    except TimeoutError as e:
        raise HTTPException(status_code=504, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Summarization failed: {str(e)}")


@app.post("/api/summarize/stream")
def api_summarize_stream(req: SummarizeRequest):
    """Streaming version of /api/summarize — sends NDJSON progress lines."""
    if not req.text.strip():
        raise HTTPException(status_code=400, detail="Text cannot be empty")
    if not check_ollama_running():
        raise HTTPException(status_code=503, detail="Ollama is not running")
    if not check_model_available():
        raise HTTPException(status_code=503, detail="Model not available")

    import json as _json

    def _stream():
        try:
            for event in summarize_conversation_streaming(req.text):
                yield _json.dumps(event) + "\n"
        except Exception as e:
            yield _json.dumps({"error": str(e)}) + "\n"

    return StreamingResponse(_stream(), media_type="application/x-ndjson")


@app.post("/api/capture")
def api_capture(req: CaptureRequest):
    """Receive raw text from the browser extension, chunk + embed, and save."""
    if not req.text.strip():
        raise HTTPException(status_code=400, detail="Text cannot be empty")

    # Extract first user message as title (no LLM needed)
    user_parts = _USER_TURN.split(req.text)
    first_user_msg = user_parts[1].strip()[:100] if len(user_parts) > 1 else req.text.strip()[:100]
    title = first_user_msg if len(first_user_msg) < 50 else first_user_msg[:47] + "..."

    # Stub summary — retrieval replaces the need for full LLM summarization
    summary: dict = {
        "main_topic": first_user_msg,
        "key_ideas": [], "snapshot": "", "vitals": [],
        "conclusions": [], "unresolved_questions": [],
    }

    try:
        result = create_context(
            title=title,
            summary=summary,
            tags=[req.source, "Extension"],
            original_chat=req.text,
            important_notes=req.important_snippets or [],
            status="summarizing",
        )
        context_id = result.get("id")

        # Chunk the conversation and embed each chunk
        chunks = chunk_conversation(req.text, starred_snippets=req.important_snippets or [])
        chunks = embed_chunks(chunks)
        if context_id and chunks:
            create_chunks(context_id, chunks)

        # Best-effort context-level embedding for semantic search on the list
        _try_embed_context(context_id, summary)

        # Background summarization — runs after response is returned to the extension.
        # Replaces the stub summary with a full map-reduce summary and re-embeds the context.
        def _bg_summarize(cid: int, text: str, snippets: list) -> None:
            try:
                real_summary = summarize_conversation(text, important_snippets=snippets or None)
                new_title = real_summary.get("main_topic", "")
                update_kwargs: dict = {"summary": real_summary}
                if new_title and new_title not in ("No topic extracted", "N/A"):
                    update_kwargs["title"] = new_title  # store full title, no truncation
                update_context(cid, **update_kwargs, status="completed")
                _try_embed_context(cid, real_summary)  # re-embed with real topic + key_ideas
            except Exception:
                update_context(cid, status="failed")

        threading.Thread(
            target=_bg_summarize,
            args=(context_id, req.text, req.important_snippets or []),
            daemon=True,
        ).start()

        return {"success": True, "id": context_id}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Capture save failed: {str(e)}")

@app.post("/api/contexts/{context_id}/resummarize")
def api_resummarize(context_id: int):
    """Re-trigger summarization for a stuck or failed context."""
    ctx = get_context(context_id)
    if not ctx:
        raise HTTPException(status_code=404, detail="Context not found")

    if not check_ollama_running():
        raise HTTPException(status_code=503, detail="Ollama is not running")

    update_context(context_id, status="summarizing")

    def _bg_resummarize(cid: int, text: str, snippets: list) -> None:
        try:
            real_summary = summarize_conversation(text, important_snippets=snippets or None)
            new_title = real_summary.get("main_topic", "")
            update_kwargs: dict = {"summary": real_summary}
            if new_title and new_title not in ("No topic extracted", "N/A"):
                update_kwargs["title"] = new_title
            update_context(cid, **update_kwargs, status="completed")
            _try_embed_context(cid, real_summary)
        except Exception:
            update_context(cid, status="failed")

    threading.Thread(
        target=_bg_resummarize,
        args=(context_id, ctx.get("original_chat", ""), ctx.get("important_notes") or []),
        daemon=True,
    ).start()

    return {"success": True, "status": "summarizing"}


# ---------------------------------------------------------------------------
# Lightweight Context List (for extension import panel)
# ---------------------------------------------------------------------------

@app.get("/api/contexts/list")
def api_list_contexts_lightweight(q: str = Query(default="", description="Search query")):
    """Return minimal context data for the extension import picker."""
    if q:
        vec = embed_text(q)
        if vec:
            contexts = search_contexts_semantic(vec) or search_contexts(q)
        else:
            contexts = search_contexts(q)
    else:
        contexts = get_all_contexts()

    # Strip heavy fields to keep the payload small
    result = []
    for ctx in contexts:
        # Extract a short summary text
        summary = ctx.get("summary", "")
        if isinstance(summary, dict):
            summary = summary.get("summary", summary.get("main_topics", ""))
            if isinstance(summary, list):
                summary = ", ".join(summary[:3])
        if isinstance(summary, str) and len(summary) > 120:
            summary = summary[:120]

        result.append({
            "id": ctx["id"],
            "title": ctx["title"],
            "summary": summary,
            "source": ctx.get("source", ""),
            "tags": ctx.get("tags", []),
            "created_at": ctx["created_at"],
        })
    return result


# ---------------------------------------------------------------------------
# Contexts CRUD
# ---------------------------------------------------------------------------

@app.post("/api/contexts")
def api_create_context(ctx: ContextCreate):
    """Save a new context entry."""
    summary_dict = ctx.summary.model_dump()
    result = create_context(
        title=ctx.title,
        summary=summary_dict,
        tags=ctx.tags,
        original_chat=ctx.original_chat,
    )
    _try_embed_context(result.get("id"), summary_dict)
    return result


@app.get("/api/contexts")
def api_list_contexts(
    q: str = Query(default="", description="Search query"),
    page: int = Query(default=1, ge=1, description="Page number"),
    per_page: int = Query(default=50, ge=1, le=200, description="Items per page"),
    sort: str = Query(default="newest", description="Sort order: newest, oldest, alpha"),
    collection_id: int = Query(default=None, description="Filter by collection ID"),
):
    """List contexts with pagination. Uses semantic search when query provided."""
    if q:
        vec = embed_text(q)
        if vec:
            results = search_contexts_semantic(vec)
            if results:
                if collection_id is not None:
                    results = [r for r in results if r.get("collection_id") == collection_id]
                return {"contexts": results, "total": len(results), "page": 1, "per_page": len(results), "has_more": False, "search_mode": "semantic"}
        results = search_contexts(q)
        if collection_id is not None:
            results = [r for r in results if r.get("collection_id") == collection_id]
        return {"contexts": results, "total": len(results), "page": 1, "per_page": len(results), "has_more": False, "search_mode": "keyword"}
    return get_contexts_paginated(page, per_page, sort=sort, collection_id=collection_id)


@app.post("/api/contexts/{context_id}/star")
def api_toggle_star(context_id: int):
    """Toggle the starred/pinned state of a context."""
    result = toggle_context_starred(context_id)
    if not result:
        raise HTTPException(status_code=404, detail="Context not found")
    return result


@app.post("/api/contexts/bulk-delete")
def api_bulk_delete(body: dict):
    """Delete multiple contexts by ID list. Body: {"ids": [1, 2, 3]}"""
    ids = body.get("ids", [])
    if not ids or not isinstance(ids, list):
        raise HTTPException(status_code=400, detail="ids list required")
    deleted = 0
    for cid in ids:
        delete_chunks_by_context(cid)
        if delete_context(cid):
            deleted += 1
    return {"deleted": deleted, "requested": len(ids)}


@app.get("/api/contexts/{context_id}")
def api_get_context(context_id: int):
    """Get a single context by ID."""
    ctx = get_context(context_id)
    if not ctx:
        raise HTTPException(status_code=404, detail="Context not found")
    return ctx


@app.put("/api/contexts/{context_id}")
def api_update_context(context_id: int, updates: ContextUpdate):
    """Update a context's title, summary, or tags."""
    existing = get_context(context_id)
    if not existing:
        raise HTTPException(status_code=404, detail="Context not found")

    kwargs = {}
    if updates.title is not None:
        kwargs["title"] = updates.title
    if updates.summary is not None:
        kwargs["summary"] = updates.summary.model_dump()
    if updates.tags is not None:
        kwargs["tags"] = updates.tags
    if updates.important_notes is not None:
        kwargs["important_notes"] = updates.important_notes

    result = update_context(context_id, **kwargs)
    return result


@app.delete("/api/contexts/{context_id}")
def api_delete_context(context_id: int):
    """Delete a context and its chunks by ID."""
    delete_chunks_by_context(context_id)
    deleted = delete_context(context_id)
    if not deleted:
        raise HTTPException(status_code=404, detail="Context not found")
    return {"status": "deleted", "id": context_id}


@app.get("/api/contexts/{context_id}/chunks")
def api_get_chunks(
    context_id: int,
    query: str = Query(default="", description="Optional query for similarity scoring"),
):
    """Return all chunks for a context, optionally scored against a query."""
    ctx = get_context(context_id)
    if not ctx:
        raise HTTPException(status_code=404, detail="Context not found")

    chunks = get_chunks_by_context(context_id)

    # If a query is provided, compute similarity scores
    if query.strip():
        query_vec = embed_text(query.strip())
        if query_vec:
            import json as _json
            for ch in chunks:
                try:
                    vec = _json.loads(ch.get("embedding") or "null")
                    if vec:
                        from backend.database import _cosine_similarity
                        ch["similarity"] = round(_cosine_similarity(query_vec, vec), 4)
                    else:
                        ch["similarity"] = None
                except Exception:
                    ch["similarity"] = None
            # Sort by similarity descending
            chunks.sort(key=lambda c: c.get("similarity") or 0.0, reverse=True)
        else:
            for ch in chunks:
                ch["similarity"] = None
    else:
        for ch in chunks:
            ch["similarity"] = None

    # Strip embedding vectors from response (large)
    for ch in chunks:
        ch.pop("embedding", None)

    return {"context_id": context_id, "chunks": chunks, "total": len(chunks)}


@app.post("/api/contexts/embed-all")
def api_embed_all(force: bool = Query(default=False, description="Re-embed even if embedding already exists")):
    """Backfill embeddings for all contexts, streaming progress as NDJSON lines.

    Each line: {"done": N, "total": N, "updated": N, "skipped": N, "title": "..."}
    Final line adds "finished": true.
    Pass force=true to re-embed all contexts with the current embed model.
    """
    import json as _json

    contexts = get_all_contexts()
    total = len(contexts)

    def _stream():
        updated = 0
        skipped = 0
        for i, ctx in enumerate(contexts, start=1):
            if ctx.get("embedding") and not force:
                skipped += 1
            else:
                _try_embed_context(ctx.get("id"), ctx.get("summary", {}))
                updated += 1
            payload = {
                "done": i,
                "total": total,
                "updated": updated,
                "skipped": skipped,
                "title": ctx.get("title", ""),
            }
            yield _json.dumps(payload) + "\n"
        # Final sentinel
        yield _json.dumps({"done": total, "total": total, "updated": updated,
                            "skipped": skipped, "finished": True}) + "\n"

    return StreamingResponse(_stream(), media_type="application/x-ndjson")


@app.post("/api/contexts/chunk-all")
def api_chunk_all(force: bool = Query(default=False, description="Delete and re-embed existing chunks with the current embed model")):
    """Backfill chunks for old contexts that were saved before embedding-based retrieval.

    Streams progress as NDJSON lines.
    Pass force=true to delete existing chunks and re-embed everything with the current
    embed model — useful after switching to a different embedding model.
    """
    import json as _json

    contexts = get_all_contexts()
    total = len(contexts)

    def _stream():
        updated = 0
        skipped = 0
        for i, ctx in enumerate(contexts, start=1):
            cid = ctx.get("id")
            existing_chunks = get_chunks_by_context(cid)
            # Check if any existing chunks are missing embeddings
            unembedded = [ch for ch in existing_chunks if not ch.get("embedding")]
            if existing_chunks and not force and not unembedded:
                skipped += 1
            else:
                try:
                    chat = ctx.get("original_chat", "")
                    if chat.strip():
                        if force:
                            # Full re-chunk and re-embed
                            if existing_chunks:
                                delete_chunks_by_context(cid)
                            notes = ctx.get("important_notes") or []
                            chunks = chunk_conversation(chat, starred_snippets=notes)
                            chunks = embed_chunks(chunks)
                            if chunks:
                                create_chunks(cid, chunks)
                        elif unembedded:
                            # Patch only the chunks that are missing embeddings
                            texts = [ch["text"] for ch in unembedded]
                            embedded = embed_chunks([{"text": t} for t in texts])
                            for ch, result in zip(unembedded, embedded):
                                vec = result.get("embedding")
                                if vec:
                                    update_chunk_embedding(ch["id"], vec)
                        else:
                            # No existing chunks at all — create from scratch
                            notes = ctx.get("important_notes") or []
                            chunks = chunk_conversation(chat, starred_snippets=notes)
                            chunks = embed_chunks(chunks)
                            if chunks:
                                create_chunks(cid, chunks)
                        # Re-embed the context-level vector too
                        _try_embed_context(cid, ctx.get("summary", {}))
                        updated += 1
                    else:
                        skipped += 1
                except Exception:
                    skipped += 1
            payload = {
                "done": i, "total": total,
                "updated": updated, "skipped": skipped,
                "title": ctx.get("title", ""),
            }
            yield _json.dumps(payload) + "\n"
        yield _json.dumps({"done": total, "total": total, "updated": updated,
                            "skipped": skipped, "finished": True}) + "\n"

    return StreamingResponse(_stream(), media_type="application/x-ndjson")


# ---------------------------------------------------------------------------
# Hybrid keyword search helpers (used by Ask Vault + Deep Search)
# ---------------------------------------------------------------------------

_KNOWN_SOURCES_SET = {"ChatGPT", "Claude", "Gemini", "Grok", "DeepSeek", "Perplexity", "Copilot"}

_STOP_WORDS = frozenset({
    "what", "which", "where", "when", "how", "who", "why", "does",
    "do", "did", "is", "are", "was", "were", "have", "has", "had",
    "can", "could", "would", "should", "about", "the", "a", "an",
    "my", "your", "i", "me", "you", "we", "our", "this", "that",
    "it", "its", "any", "some", "context", "tell", "give", "show",
    "find", "get", "know", "information", "info", "details",
})


def _extract_key_terms(text: str) -> list[str]:
    """Extract meaningful search terms from a question, stripping punctuation and stopwords."""
    words = re.findall(r"[a-zA-Z0-9]+", text.lower())
    return [w for w in words if w not in _STOP_WORDS and len(w) > 1]


def _is_whole_word_match(text_lower: str, term: str) -> bool:
    """Check if term appears as a whole word in text (not as substring of another word)."""
    return bool(re.search(r'(?<![a-zA-Z])' + re.escape(term) + r'(?![a-zA-Z])', text_lower))


def _keyword_search_hybrid(question: str) -> list[dict]:
    """Run keyword search with key-term extraction, whole-word filtering, and phrase boosting.

    1. Search for the combined key phrase first (most specific).
    2. Search for individual terms, filtering to whole-word matches only.
    3. Chunks matching more terms rank higher.
    """
    key_terms = _extract_key_terms(question)
    if not key_terms:
        return []

    seen_ids: set = set()
    scored: dict[int, dict] = {}  # chunk_id -> chunk (with _score)

    # Phase 1: Search for the full phrase (all key terms together) — most specific
    phrase = " ".join(key_terms)
    for kch in search_chunks_keyword(phrase, top_k=10):
        cid = kch.get("id")
        if cid not in seen_ids:
            kch["_score"] = 0.75  # phrase match = highest signal
            scored[cid] = kch
            seen_ids.add(cid)

    # Phase 2: Search individual terms, require whole-word match, count term hits
    term_hits: dict[int, int] = {}  # chunk_id -> number of terms matched
    for term in key_terms:
        for kch in search_chunks_keyword(term, top_k=10):
            cid = kch.get("id")
            # Only keep if the term is a whole word (not "goa" inside "goal")
            if not _is_whole_word_match(kch.get("text", "").lower(), term):
                continue
            if cid not in seen_ids:
                kch["_score"] = 0.6
                scored[cid] = kch
                seen_ids.add(cid)
            term_hits[cid] = term_hits.get(cid, 0) + 1

    # Boost chunks that match multiple terms
    for cid, hit_count in term_hits.items():
        if cid in scored and hit_count > 1:
            scored[cid]["_score"] = min(scored[cid]["_score"] + 0.05 * (hit_count - 1), 0.85)

    # Return sorted by score descending
    results = sorted(scored.values(), key=lambda c: c.get("_score", 0), reverse=True)
    return results


def _hybrid_retrieve(question: str, query_vec: list[float] | None, top_k: int = 12) -> list[dict]:
    """Run hybrid retrieval: semantic + keyword with merge and deduplication."""
    # Semantic search
    semantic_chunks = []
    if query_vec:
        semantic_chunks = search_chunks_semantic(query_vec, context_id=None, top_k=top_k)
        if len(question.split()) <= 2:
            semantic_chunks = [ch for ch in semantic_chunks if ch.get("_score", 0) >= 0.35]

    # Keyword search (whole-word, phrase-boosted)
    kw_chunks = _keyword_search_hybrid(question)

    # Merge: keyword matches first (exact hits), then semantic
    seen_ids: set = set()
    merged: list = []
    for kch in kw_chunks:
        if kch.get("id") not in seen_ids:
            merged.append(kch)
            seen_ids.add(kch.get("id"))
    for sch in semantic_chunks:
        if sch.get("id") not in seen_ids:
            merged.append(sch)
            seen_ids.add(sch.get("id"))

    return merged[:top_k]


# ---------------------------------------------------------------------------
# Ask Your Vault — RAG Chat
# ---------------------------------------------------------------------------

@app.post("/api/vault/ask")
def api_vault_ask(body: dict):
    """RAG chat: answer a question using the user's saved conversation vault.

    Streams NDJSON lines:
      {"token": "..."} — during generation
      {"done": true, "sources": [...]} — final line with citations

    Body: {"question": "...", "history": [{"role": "user"|"assistant", "content": "..."}]}
    """
    import requests as _req

    question = (body.get("question") or "").strip()
    if not question:
        raise HTTPException(status_code=400, detail="Question is required")

    history = body.get("history") or []

    # Check Ollama is available
    if not check_ollama_running():
        raise HTTPException(status_code=503, detail="Ollama is not running")

    from backend.ollama_client import _get_default_model, _get_embed_model, OLLAMA_BASE, _NUM_CTX

    model = _get_default_model()

    # 1. Embed the question
    query_vec = embed_text(question)

    # 2. Hybrid retrieval: semantic + keyword, merged
    top_chunks = _hybrid_retrieve(question, query_vec, top_k=12)

    # Also search at context level if still thin
    if len(top_chunks) < 5:
        seen_ids = {ch.get("id") for ch in top_chunks}
        ctx_matches = search_contexts(question)
        if ctx_matches:
            matched_cids = [c["id"] for c in ctx_matches[:3]]
            for mcid in matched_cids:
                ctx_chunks = get_chunks_by_context(mcid)[:2]
                for cch in ctx_chunks:
                    if cch.get("id") not in seen_ids:
                        cch["_score"] = 0.45
                        top_chunks.append(cch)
                        seen_ids.add(cch.get("id"))
            top_chunks = top_chunks[:12]

    # 3. Gather source context metadata
    sources = []
    context_text_parts = []

    if top_chunks:
        unique_cids = list({ch.get("context_id") for ch in top_chunks if ch.get("context_id")})
        ctx_map = get_contexts_by_ids(unique_cids)

        seen_contexts = set()
        for ch in top_chunks:
            cid = ch.get("context_id")
            ctx = ctx_map.get(cid, {})
            tags = ctx.get("tags", [])
            if isinstance(tags, str):
                tags = [t.strip() for t in tags.split(",")]
            source_llm = next((t for t in tags if t in _KNOWN_SOURCES_SET), "")
            title = ctx.get("title", "Unknown")
            created_at = ctx.get("created_at", "")[:10]
            score = round(ch.get("_score", 0), 2)

            # Build context line
            header = f'[From "{title}"'
            if source_llm:
                header += f" ({source_llm})"
            header += f" — {created_at}, relevance {score}]"
            context_text_parts.append(f"{header}:\n{ch['text'][:1500]}")

            # Add to sources (deduplicate by context_id)
            if cid and cid not in seen_contexts:
                seen_contexts.add(cid)
                sources.append({
                    "context_id": cid,
                    "title": title,
                    "score": score,
                    "created_at": created_at,
                    "source": source_llm,
                })

    retrieved_context = "\n\n".join(context_text_parts) if context_text_parts else "No relevant context found in your vault."

    # 4. Build the RAG prompt
    history_text = ""
    if history:
        turns = []
        for msg in history[-6:]:  # last 6 messages for context window
            role = msg.get("role", "user").upper()
            turns.append(f"{role}: {msg.get('content', '')}")
        history_text = "\n".join(turns)

    system_prompt = f"""You are ContextVolt Assistant — an AI that answers questions using the user's saved conversation history.

RULES:
- Answer using ONLY the retrieved context below. Do not make up information.
- If the context doesn't have relevant information, say: "I don't have information about that in your vault."
- When citing information, mention which conversation it came from (use the title in quotes).
- Be concise but thorough. Use markdown formatting for code blocks, lists, etc.
- If multiple conversations discuss the same topic, synthesize the information.

<retrieved_context>
{retrieved_context}
</retrieved_context>
"""

    if history_text:
        system_prompt += f"""
<conversation_history>
{history_text}
</conversation_history>
"""

    full_prompt = f"{system_prompt}\n\nUSER: {question}\nASSISTANT:"

    # 5. Stream the response from Ollama
    def _stream():
        try:
            r = _req.post(
                f"{OLLAMA_BASE}/api/generate",
                json={
                    "model": model,
                    "prompt": full_prompt,
                    "stream": True,
                    "options": {"num_ctx": min(_NUM_CTX, 16384), "temperature": 0.3},
                },
                stream=True,
                timeout=180,
            )
            r.raise_for_status()

            for line in r.iter_lines():
                if not line:
                    continue
                try:
                    data = json.loads(line)
                    token = data.get("response", "")
                    if token:
                        yield json.dumps({"token": token}) + "\n"
                    if data.get("done"):
                        break
                except json.JSONDecodeError:
                    continue

        except Exception as e:
            yield json.dumps({"error": str(e)}) + "\n"

        # Final line with sources
        yield json.dumps({"done": True, "sources": sources}) + "\n"

    return StreamingResponse(_stream(), media_type="application/x-ndjson")


# ---------------------------------------------------------------------------
# Cross-conversation retrieval
# ---------------------------------------------------------------------------

@app.post("/api/retrieve")
def api_cross_retrieve(body: PromptRequest):
    """Search across ALL saved conversations for chunks relevant to a query.

    Returns a retrieval prompt assembled from the top chunks across all contexts.
    """
    if not body.query or not body.query.strip():
        raise HTTPException(status_code=400, detail="Query is required")

    query_vec = embed_text(body.query.strip())
    if not query_vec:
        raise HTTPException(status_code=503, detail="Embedding model not available")

    # Search all chunks across all contexts
    top_chunks = search_chunks_semantic(query_vec, context_id=None, top_k=12)
    if not top_chunks:
        return {"prompt": None, "mode": "retrieval", "chunks_found": 0}

    # Batch fetch context metadata (single query instead of N+1)
    unique_cids = list({ch.get("context_id") for ch in top_chunks if ch.get("context_id")})
    ctx_map = get_contexts_by_ids(unique_cids)
    context_cache: dict = {}
    for cid, ctx in ctx_map.items():
        tags = ctx.get("tags", [])
        if isinstance(tags, str):
            tags = [t.strip() for t in tags.split(",")]
        context_cache[cid] = {
            "title": ctx.get("title", ""),
            "source": next((t for t in tags if t in _KNOWN_SOURCES_SET), ""),
            "created_at": ctx.get("created_at", ""),
        }

    # Enrich chunks with context metadata for the prompt
    for ch in top_chunks:
        cid = ch.get("context_id")
        meta = context_cache.get(cid, {})
        ch["_ctx_title"] = meta.get("title", "")
        ch["_ctx_source"] = meta.get("source", "")
        ch["_ctx_date"] = meta.get("created_at", "")[:10]

    prompt = build_cross_context_prompt(
        retrieved_chunks=top_chunks,
        query=body.query.strip(),
        prompt_size=body.size,
    )
    return {"prompt": prompt, "mode": "retrieval", "chunks_found": len(top_chunks)}


@app.post("/api/retrieve/search")
def api_cross_search(body: PromptRequest):
    """Search across ALL conversations and return raw chunk results grouped by context.

    Returns structured data for the cross-context search UI (not a prompt).
    """
    if not body.query or not body.query.strip():
        raise HTTPException(status_code=400, detail="Query is required")

    search_mode = "hybrid"

    # Hybrid retrieval: semantic + keyword
    query_vec = embed_text(body.query.strip())
    top_chunks = _hybrid_retrieve(body.query.strip(), query_vec, top_k=20)

    if not top_chunks:
        search_mode = "none"
    elif not query_vec:
        search_mode = "keyword"

    if not top_chunks:
        return {"results": [], "query": body.query.strip(), "total_chunks": 0, "low_confidence": True, "search_mode": search_mode}

    # Batch fetch context metadata
    unique_cids = list({ch.get("context_id") for ch in top_chunks if ch.get("context_id")})
    ctx_map = get_contexts_by_ids(unique_cids)
    context_cache: dict = {}
    for cid, ctx in ctx_map.items():
        tags = ctx.get("tags", [])
        if isinstance(tags, str):
            tags = [t.strip() for t in tags.split(",")]
        context_cache[cid] = {
            "id": cid,
            "title": ctx.get("title", ""),
            "tags": tags,
            "created_at": ctx.get("created_at", ""),
        }

    # Group chunks by context
    groups: dict = {}
    for ch in top_chunks:
        cid = ch.get("context_id")
        if cid not in groups:
            meta = context_cache.get(cid, {})
            groups[cid] = {
                "context_id": cid,
                "title": meta.get("title", "Unknown"),
                "tags": meta.get("tags", []),
                "created_at": meta.get("created_at", ""),
                "chunks": [],
                "best_score": 0,
            }
        score = ch.get("_score") or 0
        groups[cid]["chunks"].append({
            "text": ch.get("text", "")[:500],
            "score": round(score, 3) if score else None,
            "chunk_index": ch.get("chunk_index", 0),
            "has_code": ch.get("has_code", False),
            "is_starred": ch.get("is_starred", False),
        })
        if score and score > groups[cid]["best_score"]:
            groups[cid]["best_score"] = round(score, 3)

    # Sort groups by best chunk score
    sorted_groups = sorted(groups.values(), key=lambda g: g["best_score"], reverse=True)
    return {"results": sorted_groups, "query": body.query.strip(), "total_chunks": len(top_chunks), "search_mode": search_mode}


# ---------------------------------------------------------------------------
# Prompt Builder
# ---------------------------------------------------------------------------

_KNOWN_SOURCES = _KNOWN_SOURCES_SET  # alias for backward compat


@app.post("/api/contexts/{context_id}/prompt")
def api_generate_prompt(
    context_id: int,
    size: str = Query(default="standard"),
    body: PromptRequest | None = None,
):
    """Generate a continuation prompt. Uses retrieval when a query is provided."""
    ctx = get_context(context_id)
    if not ctx:
        raise HTTPException(status_code=404, detail="Context not found")

    effective_size = body.size if body and body.size else size
    query = body.query if body else None
    important_notes: list = ctx.get("important_notes") or []

    # Extract source LLM from tags
    tags = ctx.get("tags", [])
    if isinstance(tags, str):
        tags = [t.strip() for t in tags.split(",")]
    source_llm = next((t for t in tags if t in _KNOWN_SOURCES), "")

    # ── Retrieval path: query provided AND context has chunks ──
    if query and query.strip():
        all_chunks = get_chunks_by_context(context_id)
        if all_chunks:
            query_vec = embed_text(query.strip())
            if query_vec:
                # Semantic search within this context
                top_chunks = search_chunks_semantic(
                    query_vec, context_id=context_id, top_k=8,
                )
            else:
                # Embedding failed — fall back to all chunks
                top_chunks = all_chunks[:8]

            # Always anchor: first chunk, last chunk, starred chunks
            anchor_indices = set()
            first_idx = 0
            last_idx = max(ch["chunk_index"] for ch in all_chunks)
            anchor_indices.add(first_idx)
            anchor_indices.add(last_idx)
            for ch in all_chunks:
                if ch.get("is_starred"):
                    anchor_indices.add(ch["chunk_index"])

            # Merge anchors with retrieval results, deduplicate
            seen = {ch["chunk_index"] for ch in top_chunks}
            merged = list(top_chunks)
            for ch in all_chunks:
                if ch["chunk_index"] in anchor_indices and ch["chunk_index"] not in seen:
                    merged.append(ch)
                    seen.add(ch["chunk_index"])

            # Sort chronologically
            merged.sort(key=lambda c: c["chunk_index"])

            # Use hybrid prompt when a real summary exists (not just the capture stub)
            summary = ctx.get("summary", {})
            has_real_summary = (
                isinstance(summary, dict)
                and summary.get("key_ideas")  # stub has empty key_ideas
            )
            if has_real_summary:
                prompt = build_hybrid_prompt(
                    summary=summary,
                    retrieved_chunks=merged,
                    query=query.strip(),
                    total_chunks=len(all_chunks),
                    source_llm=source_llm,
                    created_at=ctx.get("created_at", ""),
                    prompt_size=effective_size,
                    important_snippets=important_notes,
                )
                mode = "hybrid"
            else:
                prompt = build_retrieval_prompt(
                    retrieved_chunks=merged,
                    query=query.strip(),
                    total_chunks=len(all_chunks),
                    context_title=ctx["title"],
                    source_llm=source_llm,
                    created_at=ctx.get("created_at", ""),
                    prompt_size=effective_size,
                    important_snippets=important_notes,
                )
                mode = "retrieval"
            return {
                "prompt": prompt,
                "context_id": context_id,
                "title": ctx["title"],
                "mode": mode,
            }

    # ── Static path: no query or no chunks (backward compat) ──
    summary = ctx["summary"]
    if isinstance(summary, dict):
        all_chunks_static = get_chunks_by_context(context_id)
        prompt = generate_continuation_prompt(
            summary,
            ctx.get("original_chat", ""),
            important_snippets=important_notes,
            source_llm=source_llm,
            created_at=ctx.get("created_at", ""),
            prompt_size=effective_size,
            chunks=all_chunks_static or None,
        )
        return {
            "prompt": prompt,
            "context_id": context_id,
            "title": ctx["title"],
            "mode": "static",
        }

    # Fallback for string summaries (legacy data)
    prompt = f"Context:\n{summary}\n\nContinue the discussion from this point."
    return {"prompt": prompt, "context_id": context_id, "title": ctx["title"], "mode": "static"}


# ---------------------------------------------------------------------------
# Export
# ---------------------------------------------------------------------------

@app.get("/api/contexts/{context_id}/export")
def api_export_markdown(context_id: int):
    """Export a context as a Markdown string."""
    ctx = get_context(context_id)
    if not ctx:
        raise HTTPException(status_code=404, detail="Context not found")

    summary = ctx["summary"]
    tags_str = ", ".join(ctx.get("tags", []))

    if isinstance(summary, dict):
        key_ideas = "\n".join(f"- {idea}" for idea in summary.get("key_ideas", []))
        conclusions = "\n".join(f"- {c}" for c in summary.get("conclusions", []))
        unresolved = "\n".join(f"- {q}" for q in summary.get("unresolved_questions", []))

        md = f"""# {ctx['title']}

**Created:** {ctx['created_at']}
**Tags:** {tags_str or 'None'}

## Main Topic
{summary.get('main_topic', 'N/A')}

## Key Ideas
{key_ideas or '- None'}

## Conclusions
{conclusions or '- None'}

## Unresolved Questions
{unresolved or '- None'}

---

## Original Conversation

```
{ctx['original_chat']}
```
"""
    else:
        md = f"""# {ctx['title']}

**Created:** {ctx['created_at']}
**Tags:** {tags_str or 'None'}

## Summary
{summary}

## Original Conversation

```
{ctx['original_chat']}
```
"""

    return {"markdown": md, "filename": f"{ctx['title'].replace(' ', '_')}.md"}


@app.get("/api/contexts/{context_id}/export/download")
def api_export_markdown_download(context_id: int):
    """Export a context as a downloadable .md file."""
    data = api_export_markdown(context_id)
    filename = data["filename"]
    return Response(
        content=data["markdown"],
        media_type="text/markdown",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


# ---------------------------------------------------------------------------
# Collections
# ---------------------------------------------------------------------------

@app.get("/api/collections")
def api_list_collections():
    return get_all_collections()


@app.post("/api/collections")
def api_create_collection(body: CollectionCreate):
    if not body.name.strip():
        raise HTTPException(status_code=400, detail="Collection name required")
    return create_collection(body.name, body.color)


@app.put("/api/collections/{collection_id}")
def api_update_collection(collection_id: int, body: CollectionUpdate):
    result = update_collection(collection_id, name=body.name, color=body.color)
    if not result:
        raise HTTPException(status_code=404, detail="Collection not found")
    return result


@app.delete("/api/collections/{collection_id}")
def api_delete_collection(collection_id: int):
    if not delete_collection(collection_id):
        raise HTTPException(status_code=404, detail="Collection not found")
    return {"success": True}


@app.post("/api/contexts/{context_id}/collection")
def api_set_context_collection(context_id: int, body: ContextCollectionSet):
    result = set_context_collection(context_id, body.collection_id)
    if not result:
        raise HTTPException(status_code=404, detail="Context not found")
    return result


# ---------------------------------------------------------------------------
# Database Backup
# ---------------------------------------------------------------------------

@app.get("/api/backup/download")
def api_backup_download():
    """Stream a safe hot-backup of the SQLite database as a downloadable file.

    Uses sqlite3's built-in online backup API so the file is always consistent,
    even while the app is running and writing to the database.
    """
    import sqlite3
    import tempfile
    from backend.database import DB_PATH

    with tempfile.NamedTemporaryFile(suffix=".db", delete=False) as tmp:
        tmp_path = tmp.name

    src = sqlite3.connect(DB_PATH)
    try:
        dst = sqlite3.connect(tmp_path)
        src.backup(dst)
        dst.close()
        with open(tmp_path, "rb") as f:
            data = f.read()
    finally:
        src.close()
        os.unlink(tmp_path)

    from datetime import datetime
    ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    filename = f"contextvolt_backup_{ts}.db"
    return Response(
        content=data,
        media_type="application/octet-stream",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


# ---------------------------------------------------------------------------
# Debug + System Status
# ---------------------------------------------------------------------------

@app.get("/api/debug/ollama")
def api_debug_ollama():
    """Show installed models and the model name ContextVolt is configured to use."""
    import requests as _req
    try:
        r = _req.get("http://localhost:11434/api/tags", timeout=5)
        models = [m.get("name") for m in r.json().get("models", [])]
    except Exception as e:
        models = [f"ERROR: {e}"]
    return {"configured_model": DEFAULT_MODEL, "installed_models": models}


@app.get("/api/debug/logs")
def api_debug_logs(lines: int = 100):
    """Return the last N lines of contextvolt.log for in-app debugging."""
    log_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "contextvolt.log")
    if not os.path.exists(log_path):
        return {"lines": [], "path": log_path, "exists": False}
    with open(log_path, "r", encoding="utf-8", errors="replace") as f:
        all_lines = f.readlines()
    return {"lines": all_lines[-lines:], "path": log_path, "exists": True}


@app.get("/api/system/status")
def api_system_status():
    """Combined health snapshot for the system status dashboard."""
    from backend.ollama_client import _get_default_model, _get_embed_model
    import requests as _req

    uptime_s = round(time.time() - _server_token["started_at"], 1)

    try:
        current_model  = _get_default_model()
    except Exception:
        current_model  = "unknown"

    try:
        embed_model = _get_embed_model()
    except Exception:
        embed_model = "unknown"

    try:
        ollama_running = check_ollama_running()
    except Exception:
        ollama_running = False

    try:
        model_ready = check_model_available(current_model) if ollama_running else False
    except Exception:
        model_ready = False

    installed_models: list[str] = []
    if ollama_running:
        try:
            r = _req.get("http://localhost:11434/api/tags", timeout=5)
            installed_models = [m.get("name", "") for m in r.json().get("models", [])]
        except Exception:
            pass

    try:
        db = get_db_stats()
    except Exception:
        db = {"contexts": 0, "chunks": 0, "collections": 0, "size_mb": 0.0}

    return {
        "backend":          {"status": "ok", "uptime_s": uptime_s},
        "ollama":           {"running": ollama_running, "url": "http://localhost:11434"},
        "model":            {"name": current_model, "ready": model_ready},
        "embed":            {"name": embed_model},
        "installed_models": installed_models,
        "database":         db,
    }


# ---------------------------------------------------------------------------
# Dashboard
# ---------------------------------------------------------------------------

@app.get("/api/dashboard")
def api_dashboard():
    """Dashboard data: stats + recent contexts in one call."""
    try:
        db = get_db_stats()
    except Exception:
        db = {"contexts": 0, "chunks": 0, "collections": 0, "size_mb": 0.0}

    try:
        recent = get_contexts_paginated(page=1, per_page=8, sort="newest")
        recent_contexts = recent["contexts"]
    except Exception:
        recent_contexts = []

    return {
        "stats": db,
        "recent": recent_contexts,
    }


# ---------------------------------------------------------------------------
# Restart
# ---------------------------------------------------------------------------

# Populated by run.py after each server launch. Calling it stops the current
# uvicorn instance and starts a fresh one without touching the pywebview window.
_restart_uvicorn: "callable | None" = None


@app.post("/api/restart")
def api_restart():
    """Restart only the uvicorn/FastAPI layer in-process.

    The pywebview window stays open. The HTTP server stops, releases the port,
    then a new uvicorn instance starts on the same port ~1.2 s later.
    The frontend polls /api/setup/status until the new server responds.
    """
    cb = _restart_uvicorn
    if cb is None:
        raise HTTPException(status_code=503, detail="Restart callback not available")

    def _trigger() -> None:
        time.sleep(0.25)  # let the HTTP response reach the client first
        cb()

    threading.Thread(target=_trigger, daemon=True).start()
    return {"status": "restarting"}
