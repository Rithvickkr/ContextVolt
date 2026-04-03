"""
ContextVolt — FastAPI application.

Serves the REST API and static frontend files.
"""

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
    get_context,
    get_chunks_by_context,
    update_context,
    delete_context,
    delete_chunks_by_context,
    search_contexts,
    search_contexts_semantic,
    search_chunks_semantic,
    set_context_embedding,
)
from backend.models import SummarizeRequest, ContextCreate, ContextUpdate, CaptureRequest, PromptRequest
from backend.ollama_client import (
    summarize_conversation,
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
    ollama_running = check_ollama_running()
    model_ready = check_model_available(DEFAULT_MODEL) if ollama_running else False
    return {
        "backend": True,
        "ollama_running": ollama_running,
        "model_ready": model_ready,
        "model_name": DEFAULT_MODEL,
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
                    update_kwargs["title"] = new_title[:120]  # cap at 120 chars
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
def api_list_contexts(q: str = Query(default="", description="Search query")):
    """List all contexts. Uses semantic search when embedding model is available, else keyword."""
    if q:
        vec = embed_text(q)
        if vec:
            results = search_contexts_semantic(vec)
            if results:
                return results
        return search_contexts(q)
    return get_all_contexts()


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


@app.post("/api/contexts/embed-all")
def api_embed_all():
    """Backfill embeddings for all contexts, streaming progress as NDJSON lines.

    Each line: {"done": N, "total": N, "updated": N, "skipped": N, "title": "..."}
    Final line adds "finished": true
    """
    import json as _json

    contexts = get_all_contexts()
    total = len(contexts)

    def _stream():
        updated = 0
        skipped = 0
        for i, ctx in enumerate(contexts, start=1):
            if ctx.get("embedding"):
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
def api_chunk_all():
    """Backfill chunks for old contexts that were saved before embedding-based retrieval.

    Streams progress as NDJSON lines.
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
            if existing_chunks:
                skipped += 1
            else:
                try:
                    chat = ctx.get("original_chat", "")
                    if chat.strip():
                        notes = ctx.get("important_notes") or []
                        chunks = chunk_conversation(chat, starred_snippets=notes)
                        chunks = embed_chunks(chunks)
                        if chunks:
                            create_chunks(cid, chunks)
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
