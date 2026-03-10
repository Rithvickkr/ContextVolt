"""
Context Vault — FastAPI application.

Serves the REST API and static frontend files.
"""

import os
import subprocess
import sys
from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, JSONResponse, Response

from backend.database import (
    init_db,
    create_context,
    get_all_contexts,
    get_context,
    update_context,
    delete_context,
    search_contexts,
)
from backend.models import SummarizeRequest, ContextCreate, ContextUpdate, CaptureRequest
from backend.ollama_client import (
    summarize_conversation,
    check_ollama_running,
    check_model_available,
    DEFAULT_MODEL,
)

# ---------------------------------------------------------------------------
# App setup
# ---------------------------------------------------------------------------

app = FastAPI(title="Context Vault", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Initialize database on startup
init_db()

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
    return {"message": "Context Vault API is running. Frontend not found."}


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
    default_summary = {
        "main_topic": "No topic extracted",
        "key_ideas": [],
        "conclusions": [],
        "unresolved_questions": [],
    }
    title = f"Captured from {req.source}"
    summary = default_summary

    # Attempt Ollama summarization, but don't block save on it
    if check_ollama_running() and check_model_available():
        try:
            summary = summarize_conversation(req.text)
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
        )
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
        contexts = search_contexts(q)
    else:
        contexts = get_all_contexts()

    # Strip heavy fields to keep the payload small
    return [
        {
            "id": ctx["id"],
            "title": ctx["title"],
            "tags": ctx.get("tags", []),
            "created_at": ctx["created_at"],
        }
        for ctx in contexts
    ]


# ---------------------------------------------------------------------------
# Contexts CRUD
# ---------------------------------------------------------------------------

@app.post("/api/contexts")
def api_create_context(ctx: ContextCreate):
    """Save a new context entry."""
    result = create_context(
        title=ctx.title,
        summary=ctx.summary.model_dump(),
        tags=ctx.tags,
        original_chat=ctx.original_chat,
    )
    return result


@app.get("/api/contexts")
def api_list_contexts(q: str = Query(default="", description="Search query")):
    """List all contexts. Supports optional search via ?q="""
    if q:
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


# ---------------------------------------------------------------------------
# Prompt Builder
# ---------------------------------------------------------------------------

@app.post("/api/contexts/{context_id}/prompt")
def api_generate_prompt(context_id: int):
    """Generate a structured continuation prompt for a context."""
    ctx = get_context(context_id)
    if not ctx:
        raise HTTPException(status_code=404, detail="Context not found")

    summary = ctx["summary"]
    if isinstance(summary, str):
        # Fallback if summary is still a raw string
        prompt = f"Context:\n{summary}\n\nContinue the discussion from this point."
    else:
        key_ideas = "\n".join(f"- {idea}" for idea in summary.get("key_ideas", []))
        conclusions = "\n".join(f"- {c}" for c in summary.get("conclusions", []))
        unresolved = "\n".join(f"- {q}" for q in summary.get("unresolved_questions", []))

        prompt = f"""Context:
{summary.get('main_topic', 'N/A')}

Key Points:
{key_ideas or '- None noted'}

Conclusions Reached:
{conclusions or '- None yet'}

Unresolved Questions:
{unresolved or '- None'}

Continue the discussion from this point. Address any unresolved questions and build upon the conclusions reached so far."""

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
