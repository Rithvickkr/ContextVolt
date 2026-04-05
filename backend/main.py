"""
ContextVolt — FastAPI application.

Serves the REST API and static frontend files.
"""

import json
import os
import subprocess
import sys
import threading
from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, JSONResponse, Response, StreamingResponse

from backend.database import (
    init_db,
    create_context,
    create_chunks,
    get_all_contexts,
    get_contexts_paginated,
    get_context,
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
)
from backend.models import SummarizeRequest, ContextCreate, ContextUpdate, CaptureRequest, PromptRequest, EmbedModelSelect, ModelSelect
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
    _parse_messages,
    _USER_TURN,
)

# ---------------------------------------------------------------------------
# App setup
# ---------------------------------------------------------------------------

app = FastAPI(title="ContextVolt", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
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

@app.get("/api/health")
def health():
    return {"status": "ok"}


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
):
    """List contexts with pagination. Uses semantic search when query provided."""
    if q:
        vec = embed_text(q)
        if vec:
            results = search_contexts_semantic(vec)
            if results:
                return {"contexts": results, "total": len(results), "page": 1, "per_page": len(results), "has_more": False, "search_mode": "semantic"}
        results = search_contexts(q)
        return {"contexts": results, "total": len(results), "page": 1, "per_page": len(results), "has_more": False, "search_mode": "keyword"}
    return get_contexts_paginated(page, per_page, sort=sort)


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

    # Group by context to add source info
    from backend.database import get_context as _get_ctx
    context_cache: dict = {}
    for ch in top_chunks:
        cid = ch.get("context_id")
        if cid and cid not in context_cache:
            ctx = _get_ctx(cid)
            if ctx:
                tags = ctx.get("tags", [])
                if isinstance(tags, str):
                    tags = [t.strip() for t in tags.split(",")]
                context_cache[cid] = {
                    "title": ctx.get("title", ""),
                    "source": next((t for t in tags if t in _KNOWN_SOURCES), ""),
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

    query_words = len(body.query.strip().split())
    MIN_SCORE = 0.65 if query_words <= 2 else 0.55
    search_mode = "semantic"

    query_vec = embed_text(body.query.strip())
    if query_vec:
        top_chunks = search_chunks_semantic(query_vec, context_id=None, top_k=20)
        top_chunks = [ch for ch in top_chunks if ch.get("_score", 0) >= MIN_SCORE]

    if not query_vec or not top_chunks:
        # Semantic unavailable or scored below threshold — fall back to keyword search
        top_chunks = search_chunks_keyword(body.query.strip(), top_k=20)
        search_mode = "keyword"

    if not top_chunks:
        return {"results": [], "query": body.query.strip(), "total_chunks": 0, "low_confidence": True, "search_mode": search_mode}

    from backend.database import get_context as _get_ctx
    context_cache: dict = {}
    for ch in top_chunks:
        cid = ch.get("context_id")
        if cid and cid not in context_cache:
            ctx = _get_ctx(cid)
            if ctx:
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

_KNOWN_SOURCES = {"ChatGPT", "Claude", "Gemini", "Grok", "DeepSeek", "Perplexity", "Copilot"}


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
# Debug
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
    return {"lines": all_lines[-lines:], "path": log_path, "exists": True}  # type: ignore[index]


# ---------------------------------------------------------------------------
# Restart
# ---------------------------------------------------------------------------

@app.post("/api/restart")
def api_restart():
    """Restart the backend process."""
    def _do_restart() -> None:
        import time
        time.sleep(0.4)
        kwargs: dict = {}
        if sys.platform == "win32":
            kwargs["creationflags"] = subprocess.CREATE_NO_WINDOW
        subprocess.Popen([sys.executable] + sys.argv, **kwargs)
        os._exit(0)

    threading.Thread(target=_do_restart, daemon=True).start()
    return {"status": "restarting"}
