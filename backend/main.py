"""
ContextVolt — FastAPI application.

Serves the REST API and static frontend files.
"""

import os
import subprocess
import sys
from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, JSONResponse, Response, StreamingResponse

from backend.database import (
    init_db,
    create_context,
    get_all_contexts,
    get_context,
    update_context,
    delete_context,
    search_contexts,
    search_contexts_semantic,
    set_context_embedding,
)
from backend.models import SummarizeRequest, ContextCreate, ContextUpdate, CaptureRequest
from backend.ollama_client import (
    summarize_conversation,
    generate_continuation_prompt,
    embed_text,
    check_ollama_running,
    check_model_available,
    DEFAULT_MODEL,
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
    """Receive raw text from the browser extension, summarize, and save it automatically."""
    if not req.text.strip():
        raise HTTPException(status_code=400, detail="Text cannot be empty")

    # Build a default/fallback summary
    default_summary: dict = {
        "main_topic": "No topic extracted",
        "key_ideas": [], "snapshot": "", "vitals": [],
        "conclusions": [], "unresolved_questions": [],
    }
    title = f"Captured from {req.source}"
    summary = default_summary

    # Attempt Ollama summarization, but don't block save on it
    if check_ollama_running() and check_model_available():
        try:
            summary = summarize_conversation(
                req.text,
                important_snippets=req.important_snippets or [],
            )
            if summary and summary.get("main_topic") and summary["main_topic"] != "No topic extracted":
                topic = summary["main_topic"]
                title = topic if len(topic) < 50 else topic[:47] + "..."
        except Exception:
            # Summarization failed — proceed with default summary
            summary = default_summary

    try:
        result = create_context(
            title=title,
            summary=summary,
            tags=[req.source, "Extension"],
            original_chat=req.text,
            important_notes=req.important_snippets or [],
        )
        # Best-effort embedding for semantic search (don't fail the capture if unavailable)
        _try_embed_context(result.get("id"), summary)
        return {"success": True, "id": result.get("id")}
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
    """Delete a context by ID."""
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


# ---------------------------------------------------------------------------
# Prompt Builder
# ---------------------------------------------------------------------------

@app.post("/api/contexts/{context_id}/prompt")
def api_generate_prompt(context_id: int):
    """Generate a structured continuation prompt for a context using the local LLM."""
    ctx = get_context(context_id)
    if not ctx:
        raise HTTPException(status_code=404, detail="Context not found")

    summary = ctx["summary"]
    important_notes: list = ctx.get("important_notes") or []

    # Try LLM-generated prompt first (richer context brief)
    if isinstance(summary, dict) and check_ollama_running() and check_model_available():
        llm_prompt = generate_continuation_prompt(
            summary,
            ctx.get("original_chat", ""),
            important_snippets=important_notes,
        )
        if llm_prompt:
            return {"prompt": llm_prompt, "context_id": context_id, "title": ctx["title"]}

    # Fallback: structured template from summary fields
    if isinstance(summary, str):
        prompt = f"Context:\n{summary}\n\nContinue the discussion from this point."
    else:
        key_ideas   = "\n".join(f"- {idea}" for idea in summary.get("key_ideas", []))
        snapshot    = summary.get("snapshot", "")
        vitals      = "\n".join(f"- {v}" for v in summary.get("vitals", []))
        conclusions = "\n".join(f"- {c}" for c in summary.get("conclusions", []))
        unresolved  = "\n".join(f"- {q}" for q in summary.get("unresolved_questions", []))
        marked      = "\n".join(f"- {n}" for n in important_notes)
        prompt = (
            f"Context: {summary.get('main_topic', 'N/A')}\n\n"
            f"Key Points:\n{key_ideas or '- None noted'}\n\n"
            + (f"Active State:\n{snapshot}\n\n" if snapshot and snapshot != "n/a" else "")
            + (f"Technical Vitals:\n{vitals}\n\n" if vitals else "")
            + (f"Marked Important:\n{marked}\n\n" if marked else "")
            + f"Conclusions Reached:\n{conclusions or '- None yet'}\n\n"
            f"Unresolved Questions:\n{unresolved or '- None'}\n\n"
            "Continue the discussion from this point."
        )

    return {"prompt": prompt, "context_id": context_id, "title": ctx["title"]}


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
