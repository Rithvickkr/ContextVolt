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
from collections import deque
from fastapi import FastAPI, Form, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, RedirectResponse, Response, StreamingResponse

from backend.database import (
    init_db,
    get_db_stats,
    create_context,
    create_chunks,
    get_all_contexts,
    get_contexts_paginated,
    get_context,
    get_starred_contexts,
    get_summarizing_contexts,
    get_contexts_by_ids,
    get_chunks_by_context,
    get_chunks_by_ids,
    get_chunk_neighbors,
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
    get_context_ids_by_collection,
    increment_stat,
    create_ask_session,
    list_ask_sessions,
    get_ask_session,
    append_ask_message,
    update_ask_session,
    delete_ask_session,
    get_context_by_url,
    create_lattice_entries,
    delete_lattice_by_context,
    get_lattice_entries_by_context,
    create_entities_for_context,
    delete_entities_by_context,
    find_entity_chunks_for_query,
    get_meta,
    set_meta,
)
from backend.models import (
    SummarizeRequest, ContextCreate, ContextUpdate, CaptureRequest,
    PromptRequest, EmbedModelSelect, ModelSelect,
    CollectionCreate, CollectionUpdate, ContextCollectionSet,
    CloudKeySet, ProviderSelect, CloudKeyValidate, UserProfileUpdate,
)
from backend.ollama_client import (
    summarize_conversation as _ollama_summarize,
    summarize_conversation_streaming as _ollama_summarize_streaming,
    generate_continuation_prompt,
    build_hybrid_prompt,
    chunk_conversation,
    embed_chunks,
    build_retrieval_prompt,
    build_cross_context_prompt,
    embed_text,
    _embedding_scheme_id,
    _get_embed_model,
    _truncate_at_sentence,
    check_ollama_running,
    check_model_available,
    DEFAULT_MODEL,
    OLLAMA_BASE,
    _USER_TURN,
)
from backend.llm_router import (
    get_active_provider,
    is_cloud_active,
    summarize_conversation,
    summarize_conversation_streaming,
    summarize_with_lattice,
    generate as router_generate,
    generate_stream as router_generate_stream,
)
from backend.cloud_client import (
    cloud_validate_key,
    PROVIDERS as CLOUD_PROVIDERS,
)

# ---------------------------------------------------------------------------
# Rate limiting (in-memory, per-IP, sliding window)
# ---------------------------------------------------------------------------

_rate_limit_store: dict[str, deque[float]] = {}
_rate_limit_lock = threading.Lock()

# Periodic stale-key sweep. Buckets that have fully expired leave behind empty
# deques (and keys for IPs that never return); we drop them every so often so
# the store can't grow without bound.
_rate_limit_last_cleanup = 0.0
_RATE_LIMIT_CLEANUP_INTERVAL = 300.0  # seconds between sweeps

# Serialises background LLM work (capture summarize, resummarize) so multiple
# captures don't contend on the local GPU. Synchronous endpoints don't acquire
# this — they already block the caller's request and so can't pile up.
_local_llm_lock = threading.Lock()

# Limits per route prefix (requests / window_seconds)
_RATE_LIMITS: list[tuple[str, int, int]] = [
    ("/api/capture",          30,  60),   # extension capture: 30 req/min
    ("/api/summarize",        10,  60),   # summarization: 10 req/min
    ("/api/retrieve",         60,  60),   # search/retrieve: 60 req/min
    ("/api/setup/pull-model", 5,   300),  # model pulls: 5 per 5 min
    ("/api/",                 200, 60),   # all other API calls: 200 req/min
]


# Longest window across all rules — used by the sweep to age out abandoned keys.
_RATE_LIMIT_MAX_WINDOW = max(window for _, _, window in _RATE_LIMITS)


def _maybe_cleanup_rate_limit_store(now: float) -> None:
    """Drop stale keys. Caller must hold _rate_limit_lock."""
    global _rate_limit_last_cleanup
    if now - _rate_limit_last_cleanup < _RATE_LIMIT_CLEANUP_INTERVAL:
        return
    _rate_limit_last_cleanup = now
    stale = [
        key
        for key, bucket in _rate_limit_store.items()
        if not bucket or now - bucket[-1] >= _RATE_LIMIT_MAX_WINDOW
    ]
    for key in stale:
        del _rate_limit_store[key]


def _check_rate_limit(client: str, path: str) -> None:
    now = time.monotonic()
    for prefix, limit, window in _RATE_LIMITS:
        if path.startswith(prefix):
            key = f"{client}:{prefix}"
            with _rate_limit_lock:
                _maybe_cleanup_rate_limit_store(now)
                bucket = _rate_limit_store.setdefault(key, deque())
                # Evict expired timestamps from the front (oldest first).
                while bucket and now - bucket[0] >= window:
                    bucket.popleft()
                if len(bucket) >= limit:
                    raise HTTPException(
                        status_code=429,
                        detail=f"Rate limit exceeded. Max {limit} requests per {window}s.",
                    )
                bucket.append(now)
            break


# ---------------------------------------------------------------------------
# App setup
# ---------------------------------------------------------------------------

from contextlib import asynccontextmanager as _asynccontextmanager  # noqa: E402


@_asynccontextmanager
async def _lifespan(_app: "FastAPI"):
    # The MCP HTTP transport runs on a SEPARATE app/port (backend.mcp_app), which
    # is the only surface the Cloudflare tunnel exposes. This app — the full REST
    # API + frontend — is bound to loopback and never tunneled, so it does not
    # carry the MCP session manager.
    #
    # Warm the embed model in the background so the first library search isn't
    # paying a multi-second cold load. Best-effort and non-blocking: if Ollama
    # is down or the model is missing, warm_embed_model() just returns False and
    # search falls back to keyword as usual.
    import threading as _threading
    from backend.ollama_client import (
        ensure_ollama_running as _ensure_ollama_running,
        warm_embed_model as _warm_embed_model,
    )

    def _startup_warm() -> None:
        # Auto-start Ollama if the user closed it, THEN warm the embed model
        # (warming needs Ollama up). Both are best-effort and never raise.
        _ensure_ollama_running()
        _warm_embed_model()

    _threading.Thread(target=_startup_warm, daemon=True).start()
    yield


app = FastAPI(title="ContextVolt", version="2.6.1", lifespan=_lifespan)

# Port of the loopback MCP-only app (backend.mcp_app), published by run.py. The
# Cloudflare tunnel is pointed here — never at this app's own port — so remote
# clients can reach /mcp + OAuth but not /api/*. None when the app is run without
# run.py (e.g. bare `uvicorn backend.main`); in that mode the tunnel is refused.
_mcp_port: int | None = None


@app.middleware("http")
async def rate_limit_middleware(request: Request, call_next):
    client = request.client.host if request.client else "unknown"
    _check_rate_limit(client, request.url.path)
    return await call_next(request)


# The actual port is chosen at runtime (run.py picks the first free candidate
# and overwrites this). Import-time default keeps direct `uvicorn backend.main`
# runs working. Consumers needing the live value (tunnel, MCP URL) read this.
from backend.paths import SERVER_PORT as _SERVER_PORT  # noqa: E402
_active_port: int = _SERVER_PORT

app.add_middleware(
    CORSMiddleware,
    # Allow any loopback origin regardless of the chosen port — the frontend is
    # same-origin anyway, and sensitive endpoints are separately gated to
    # loopback via _is_loopback().
    allow_origin_regex=r"^http://(localhost|127\.0\.0\.1)(:\d+)?$",
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
        vec = embed_text(f"{topic} {ideas}".strip(), is_query=False)
        if vec:
            set_context_embedding(context_id, vec)
    except Exception:
        pass


# Mount static frontend files. Disable HTTP caching so JS/CSS edits are
# always picked up — pywebview/WebView2 caches aggressively otherwise.
class _NoCacheStatic(StaticFiles):
    async def get_response(self, path: str, scope):
        response = await super().get_response(path, scope)
        response.headers["Cache-Control"] = "no-store, no-cache, must-revalidate, max-age=0"
        response.headers["Pragma"] = "no-cache"
        response.headers["Expires"] = "0"
        return response


FRONTEND_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "frontend")
if os.path.isdir(FRONTEND_DIR):
    app.mount("/static", _NoCacheStatic(directory=FRONTEND_DIR), name="static")


# ---------------------------------------------------------------------------
# Root — serve the frontend
# ---------------------------------------------------------------------------

@app.get("/")
def serve_frontend():
    index_path = os.path.join(FRONTEND_DIR, "index.html")
    if os.path.exists(index_path):
        return FileResponse(
            index_path,
            headers={
                "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
                "Pragma": "no-cache",
                "Expires": "0",
            },
        )
    return {"message": "ContextVolt API is running. Frontend not found."}


# ---------------------------------------------------------------------------
# Health & Setup Status
# ---------------------------------------------------------------------------

_server_token: dict = {"started_at": time.time()}  # mutable — run.py updates this on each launch

@app.get("/api/health")
def health():
    from backend.updater import APP_VERSION
    # "app" marker lets the extension's port probe confirm it found ContextVolt
    # and not some unrelated service occupying a candidate port.
    return {
        "status": "ok",
        "app": "contextvolt",
        "port": _active_port,
        "started_at": _server_token["started_at"],
        "version": APP_VERSION,
    }


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


@app.get("/api/gpu/diagnostic")
def gpu_diagnostic():
    """Report whether a loaded model is actually running on the NVIDIA GPU.

    Lets the UI warn hybrid-GPU laptop users when inference landed on the
    integrated GPU instead of a faster dedicated NVIDIA card. Best-effort.
    """
    from backend.ollama_client import gpu_usage_diagnostic
    return gpu_usage_diagnostic()


@app.post("/api/gpu/prefer-nvidia")
def gpu_prefer_nvidia():
    """Persist the NVIDIA preference and relaunch Ollama so it takes effect now.

    Backs the 'Switch to NVIDIA' banner action — explicit, user-initiated, so the
    Ollama restart (which it implies) is consented. Returns the post-restart
    diagnostic for the UI to confirm.
    """
    cfg = _read_config()
    cfg["prefer_dedicated_gpu"] = True
    _write_config(cfg)
    from backend.ollama_client import restart_ollama
    return restart_ollama()


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

from backend.paths import config_path as _config_path  # noqa: E402
_CFG_PATH = str(_config_path())

_EMBED_MODEL_OPTIONS = [
    {"id": "qwen3-embedding:0.6b", "label": "qwen3-embedding 0.6B", "size": "640 MB",
     "desc": "Current SOTA local retrieval — top of MTEB at this size. Recommended.", "recommended": True},
    {"id": "mxbai-embed-large", "label": "mxbai-embed-large", "size": "670 MB",
     "desc": "High-quality English technical text — strong semantic search.", "recommended": False},
    {"id": "nomic-embed-text", "label": "nomic-embed-text", "size": "274 MB",
     "desc": "Fast, small footprint. Good baseline.", "recommended": False},
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

    # Mark the VRAM-appropriate embed model as recommended
    from backend.gpu_info import detect_gpu, recommend_models
    gpu = detect_gpu()
    rec = recommend_models(gpu.get("vram_mb"))
    available = [dict(m) for m in _EMBED_MODEL_OPTIONS]
    for m in available:
        m["recommended"] = (m["id"] == rec["embed"])

    # Re-embed guard (fix #6): if the existing document vectors were built with a
    # different embed model/prefix scheme than the active one, freshly-embedded
    # queries won't match them — retrieval silently degrades. Surface this so the
    # UI can prompt a full re-embed (chunk-all?force=true).
    current_scheme = _embedding_scheme_id(current)
    stored_scheme = get_meta("embed_scheme")
    chunk_count = get_db_stats().get("chunks", 0)
    reembed_needed = bool(stored_scheme and stored_scheme != current_scheme and chunk_count)

    return {
        "current_embed_model": current,
        "embed_model_ready": ready,
        "available_models": available,
        "gpu": gpu,
        "recommendation": rec,
        "reembed_needed": reembed_needed,
        "embedded_scheme": stored_scheme,
        "current_scheme": current_scheme,
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
    Includes cloud provider info.
    """
    cfg = _read_config()
    ollama_ok = check_ollama_running()
    current_model = cfg.get("model", DEFAULT_MODEL)
    current_embed = cfg.get("embed_model", "nomic-embed-text")
    current_provider = cfg.get("provider", "ollama")
    cloud_keys = cfg.get("cloud_keys", {})
    cloud_models = cfg.get("cloud_models", {})

    # Fetch installed model names once — single HTTP call
    installed_names: list[str] = []
    if ollama_ok:
        try:
            import requests as _req
            r = _req.get(f"{OLLAMA_BASE}/api/tags", timeout=4)
            if r.status_code == 200:
                installed_names = [m.get("name", "") for m in r.json().get("models", [])]
        except Exception:
            pass

    def _is_installed(model_id: str) -> bool:
        for n in installed_names:
            if n == model_id:
                return True
            # Only do base-name fallback when model_id has no explicit tag
            # (e.g. "nomic-embed-text" should match "nomic-embed-text:latest")
            if ":" not in model_id and n.split(":")[0] == model_id:
                return True
        return False

    llm_models = [
        {"id": "llama3.2:3b", "label": "Llama 3.2 3B", "size": "~2 GB",
         "desc": "Strong JSON adherence, faithful summaries, 128k context",
         "min_vram_mb": 5000},
        {"id": "qwen3:4b",    "label": "Qwen 3 4B",    "size": "~2.6 GB",
         "desc": "Highest quality — newest reasoning model, beats Qwen 2.5 7B at half the size",
         "min_vram_mb": 8000},
        {"id": "qwen2.5:1.5b","label": "Qwen 2.5 1.5B","size": "~1 GB",
         "desc": "Lightweight — minimal hardware, basic quality",
         "min_vram_mb": 0},
        {"id": "qwen2.5:3b",  "label": "Qwen 2.5 3B",  "size": "~2 GB",
         "desc": "Stable fallback — proven, multilingual, runs on most hardware",
         "min_vram_mb": 5000},
        {"id": "qwen2.5:7b",  "label": "Qwen 2.5 7B",  "size": "~5 GB",
         "desc": "High quality — needs 6 GB+ VRAM or 8 GB+ RAM",
         "min_vram_mb": 8000},
    ]

    # Apply VRAM-aware recommendations
    from backend.gpu_info import detect_gpu, recommend_models
    gpu = detect_gpu()
    rec = recommend_models(gpu.get("vram_mb"))
    vram_mb = gpu.get("vram_mb")
    for m in llm_models:
        m["installed"] = _is_installed(m["id"])
        m["recommended"] = (m["id"] == rec["llm"])
        m["fits_vram"] = vram_mb is None or vram_mb >= m.get("min_vram_mb", 0)

    embed_models = [dict(m) for m in _EMBED_MODEL_OPTIONS]
    # Add per-embed VRAM requirements so the frontend can warn on bad pairs
    _EMBED_VRAM = {
        "qwen3-embedding:0.6b": 6000,   # ~1 GB peak, needs co-load headroom
        "mxbai-embed-large":    6000,
        "bge-m3":               7000,
        "nomic-embed-text":     0,      # ~0.5 GB peak — fits anywhere
        "nomic-embed-text:v1.5": 0,
    }
    for m in embed_models:
        m["installed"] = _is_installed(m["id"])
        m["recommended"] = (m["id"] == rec["embed"])
        m["min_vram_mb"] = _EMBED_VRAM.get(m["id"], 0)
        m["fits_vram"] = vram_mb is None or vram_mb >= m["min_vram_mb"]

    # Build cloud provider info
    cloud_providers = []
    for pid, pinfo in CLOUD_PROVIDERS.items():
        has_key = bool(cloud_keys.get(pid, "").strip())
        cloud_providers.append({
            "id": pid,
            "label": pinfo["label"],
            "has_key": has_key,
            "key_hint": pinfo["key_hint"],
            "docs_url": pinfo["docs_url"],
            "selected_model": cloud_models.get(pid, pinfo["models"][0]["id"] if pinfo["models"] else ""),
            "models": pinfo["models"],
        })

    # Determine active provider display info
    active = get_active_provider()

    return {
        "model": current_model,
        "embed_model": current_embed,
        "model_ready": _is_installed(current_model),
        "embed_model_ready": _is_installed(current_embed),
        "ollama_running": ollama_ok,
        "available_models": llm_models,
        "available_embed_models": embed_models,
        "provider": current_provider,
        "cloud_providers": cloud_providers,
        "active_provider": active["provider"],
        "active_model": active["model"],
        "is_cloud_active": active["is_cloud"],
        "user_name": cfg.get("user_name", ""),
        "user_about": cfg.get("user_about", ""),
        "gpu": gpu,
        "recommendation": rec,
        "prefer_dedicated_gpu": cfg.get("prefer_dedicated_gpu", True),
    }


@app.get("/api/setup/gpu_info")
def gpu_info():
    """Detect GPU + VRAM and return the recommended LLM/embed pair."""
    from backend.gpu_info import detect_gpu, recommend_models
    gpu = detect_gpu()
    return {"gpu": gpu, "recommendation": recommend_models(gpu.get("vram_mb"))}


@app.post("/api/setup/save-profile")
def save_profile(req: UserProfileUpdate):
    """Save user name and about to config.json."""
    cfg = _read_config()
    cfg["user_name"] = req.name.strip()
    cfg["user_about"] = req.about.strip()
    _write_config(cfg)
    return {"status": "saved"}


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
                f"{OLLAMA_BASE}/api/pull",
                json={"model": body.model, "name": body.model, "stream": True},
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


@app.delete("/api/setup/delete-model/{model_id:path}")
def delete_ollama_model(model_id: str):
    """Delete an installed Ollama model.

    Resolves the actual Ollama model name (e.g. qwen2.5:latest) from the
    config model ID (e.g. qwen2.5:3b) using the same fuzzy base-name match
    that _is_installed uses, so the delete never fails with 'model not found'.
    """
    if not check_ollama_running():
        raise HTTPException(status_code=503, detail="Ollama is not running")
    import requests as _req
    try:
        # Resolve actual installed name that matches the requested model_id
        actual_name = model_id
        try:
            r = _req.get(f"{OLLAMA_BASE}/api/tags", timeout=4)
            if r.status_code == 200:
                installed = [m.get("name", "") for m in r.json().get("models", [])]
                for n in installed:
                    if n == model_id:
                        actual_name = n
                        break
                    if ":" not in model_id and n.split(":")[0] == model_id:
                        actual_name = n
                        break
        except Exception:
            pass

        resp = _req.delete(
            f"{OLLAMA_BASE}/api/delete",
            json={"name": actual_name, "model": actual_name},
            timeout=30,
        )
        if resp.status_code in (200, 204):
            return {"status": "deleted", "model": model_id, "actual": actual_name}
        raise HTTPException(status_code=resp.status_code, detail=f"Ollama error: {resp.text}")
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=503, detail=str(e))


# ---------------------------------------------------------------------------
# Cloud Provider Management
# ---------------------------------------------------------------------------

@app.post("/api/setup/cloud-key")
def save_cloud_key(req: CloudKeySet):
    """Save a cloud API key for a provider and optionally set the model."""
    if req.provider not in CLOUD_PROVIDERS:
        raise HTTPException(status_code=400, detail=f"Unknown provider: {req.provider}")
    if not req.api_key.strip():
        raise HTTPException(status_code=400, detail="API key cannot be empty")

    cfg = _read_config()
    if "cloud_keys" not in cfg:
        cfg["cloud_keys"] = {}
    if "cloud_models" not in cfg:
        cfg["cloud_models"] = {}

    cfg["cloud_keys"][req.provider] = req.api_key.strip()
    if req.model:
        cfg["cloud_models"][req.provider] = req.model
    elif req.provider not in cfg["cloud_models"]:
        # Set default model for this provider
        default_model = CLOUD_PROVIDERS[req.provider]["models"][0]["id"]
        cfg["cloud_models"][req.provider] = default_model

    _write_config(cfg)
    return {
        "status": "saved",
        "provider": req.provider,
        "model": cfg["cloud_models"].get(req.provider, ""),
    }


@app.delete("/api/setup/cloud-key/{provider}")
def delete_cloud_key(provider: str):
    """Remove a saved cloud API key."""
    cfg = _read_config()
    cloud_keys = cfg.get("cloud_keys", {})
    if provider in cloud_keys:
        del cloud_keys[provider]
        cfg["cloud_keys"] = cloud_keys
        # If this was the active provider, switch back to Ollama
        if cfg.get("provider") == provider:
            cfg["provider"] = "ollama"
        _write_config(cfg)
    return {"status": "deleted", "provider": provider}


@app.post("/api/setup/validate-key")
def validate_cloud_key(req: CloudKeyValidate):
    """Test if a cloud API key is valid by making a minimal API call."""
    if req.provider not in CLOUD_PROVIDERS:
        raise HTTPException(status_code=400, detail=f"Unknown provider: {req.provider}")
    result = cloud_validate_key(req.provider, req.api_key.strip())
    return result


@app.post("/api/setup/select-provider")
def select_provider(req: ProviderSelect):
    """Switch the active LLM provider."""
    valid_providers = {"ollama"} | set(CLOUD_PROVIDERS.keys())
    if req.provider not in valid_providers:
        raise HTTPException(status_code=400, detail=f"Unknown provider: {req.provider}")

    cfg = _read_config()

    # If selecting a cloud provider, verify we have a key
    if req.provider != "ollama":
        cloud_keys = cfg.get("cloud_keys", {})
        if not cloud_keys.get(req.provider, "").strip():
            raise HTTPException(status_code=400, detail=f"No API key saved for {req.provider}")

    cfg["provider"] = req.provider
    if req.model and req.provider != "ollama":
        if "cloud_models" not in cfg:
            cfg["cloud_models"] = {}
        cfg["cloud_models"][req.provider] = req.model
    elif req.model and req.provider == "ollama":
        cfg["model"] = req.model

    _write_config(cfg)

    active = get_active_provider()
    return {
        "status": "saved",
        "provider": active["provider"],
        "model": active["model"],
        "is_cloud": active["is_cloud"],
    }


@app.get("/api/setup/providers")
def list_providers():
    """List all available providers with their status."""
    cfg = _read_config()
    current_provider = cfg.get("provider", "ollama")
    cloud_keys = cfg.get("cloud_keys", {})
    cloud_models = cfg.get("cloud_models", {})
    ollama_ok = check_ollama_running()

    providers = [
        {
            "id": "ollama",
            "label": "Local (Ollama)",
            "is_local": True,
            "active": current_provider == "ollama",
            "ready": ollama_ok and check_model_available(),
            "model": cfg.get("model", DEFAULT_MODEL),
        },
    ]
    for pid, pinfo in CLOUD_PROVIDERS.items():
        has_key = bool(cloud_keys.get(pid, "").strip())
        providers.append({
            "id": pid,
            "label": pinfo["label"],
            "is_local": False,
            "active": current_provider == pid,
            "ready": has_key,
            "has_key": has_key,
            "model": cloud_models.get(pid, pinfo["models"][0]["id"] if pinfo["models"] else ""),
            "models": pinfo["models"],
            "key_hint": pinfo["key_hint"],
            "docs_url": pinfo["docs_url"],
        })

    return {"providers": providers, "active": current_provider}


# ---------------------------------------------------------------------------
# Summarization
# ---------------------------------------------------------------------------

@app.post("/api/summarize")
def api_summarize(req: SummarizeRequest):
    """Send conversation text to the active LLM provider and return a structured summary."""
    if not req.text.strip():
        raise HTTPException(status_code=400, detail="Text cannot be empty")

    active = get_active_provider()
    if not active["is_cloud"]:
        # Ollama checks only needed for local provider
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

    active = get_active_provider()
    if not active["is_cloud"]:
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


# Continuation briefs pasted via "From Vault" are generated artifacts, not
# conversation content — strip them from captures so a re-saved chat doesn't
# store its own summary as part of the transcript. Every prompt builder wraps
# its output in <context_brief>…</context_brief>; the trailing "Begin now"
# line is emitted after the closing tag by generate_continuation_prompt.
_CONTEXT_BRIEF_RE = re.compile(
    r"<context_brief>.*?</context_brief>\s*"
    r"(?:The next message in the conversation is yours, as the assistant\.\s*Begin now:\s*)?",
    re.DOTALL,
)


@app.post("/api/capture")
def api_capture(req: CaptureRequest):
    """Receive raw text from the browser extension, chunk + embed, and save.

    If conversation_url matches an existing context, updates it in place instead
    of creating a duplicate entry. If the URL doesn't match but the extension
    reports that a vault context was imported into this conversation
    (imported_context_id), that context is updated instead — the new exchanges
    are appended and the whole thing is re-summarized.
    """
    if not req.text.strip():
        raise HTTPException(status_code=400, detail="Text cannot be empty")

    text = _CONTEXT_BRIEF_RE.sub("", req.text)
    text = re.sub(r"\n{3,}", "\n\n", text).strip()
    # Bare role labels are all that's left when the message was only a brief
    if not re.sub(r"(?im)^\s*(?:USER|ASSISTANT)\s*:\s*$", "", text).strip():
        raise HTTPException(
            status_code=400,
            detail="No conversation content beyond the imported context brief",
        )

    def _bg_summarize(cid: int, text: str, snippets: list, preserve_title: bool = False) -> None:
        # Serialise local LLM work so concurrent captures don't contend on the GPU
        _local_llm_lock.acquire()
        try:
            # Chunk + embed first so semantic search works as soon as possible
            chunks = chunk_conversation(text, starred_snippets=snippets or [])
            chunks = embed_chunks(chunks)
            delete_chunks_by_context(cid)
            if chunks:
                create_chunks(cid, chunks)
                # Record which embed scheme the stored vectors use (fix #6).
                # Only set on first write; a model switch is detected by comparing
                # this to the active scheme and is cleared by a full re-embed.
                if get_meta("embed_scheme") is None:
                    set_meta("embed_scheme", _embedding_scheme_id(_get_embed_model()))

            sl = summarize_with_lattice(text, important_snippets=snippets or None)
            real_summary = sl["summary"]
            lattice = sl.get("lattice") or []
            # Replace any prior lattice for this context — capture is the
            # canonical (re)build path, so old versions are not retained yet.
            delete_lattice_by_context(cid)
            if lattice:
                create_lattice_entries(cid, lattice)

            # Entity index — heuristic, populated from the same chunks the
            # retrieval path already uses. Rebuilt fully each capture for now.
            from backend.entity_extractor import extract_entities_per_chunk
            delete_entities_by_context(cid)
            if chunks:
                ent_map = extract_entities_per_chunk(chunks)
                if ent_map:
                    create_entities_for_context(cid, ent_map)

            new_title = real_summary.get("main_topic", "")
            update_kwargs: dict = {"summary": real_summary}
            # Keep a user-provided title; otherwise adopt the summarized topic.
            if not preserve_title and new_title and new_title not in ("No topic extracted", "N/A"):
                update_kwargs["title"] = new_title
            update_context(cid, **update_kwargs, status="completed")
            _try_embed_context(cid, real_summary)
        except Exception:
            update_context(cid, status="failed")
        finally:
            _local_llm_lock.release()

    try:
        # Check if we already saved this conversation URL before
        existing = get_context_by_url(req.conversation_url) if req.conversation_url else None
        matched_by_url = existing is not None

        # No URL match — fall back to the context the user imported into this
        # conversation via "From Vault", so continuing a saved context in a new
        # chat updates the original instead of creating a duplicate.
        if not existing and req.imported_context_id:
            existing = get_context(req.imported_context_id)

        if existing:
            context_id = existing["id"]
            stored_chat: str = existing.get("original_chat") or ""

            # If the incoming text is shorter than what's already stored, the
            # extension only captured new messages (e.g. after a page refresh or
            # navigating back). Append only the new part so we never lose history.
            # An imported-context save is always an append: the new conversation
            # doesn't contain the original transcript.
            if matched_by_url and len(text) >= len(stored_chat):
                full_chat = text
            else:
                full_chat = (stored_chat + "\n\n" + text) if stored_chat else text

            new_notes = req.important_snippets or []
            update_kwargs: dict = {
                "original_chat": full_chat,
                "important_notes": new_notes,
                "status": "summarizing",
            }
            if not matched_by_url:
                # Continuing in a different conversation: keep prior starred
                # snippets (they live in the old transcript) and re-key the
                # context to the new URL so the next save matches directly.
                prior_notes = existing.get("important_notes") or []
                update_kwargs["important_notes"] = prior_notes + [
                    s for s in new_notes if s not in prior_notes
                ]
                if req.conversation_url:
                    update_kwargs["conversation_url"] = req.conversation_url

            update_context(context_id, **update_kwargs)
            # All Ollama work (chunk, embed, summarize) happens in the background
            threading.Thread(
                target=_bg_summarize,
                args=(context_id, full_chat, update_kwargs["important_notes"]),
                daemon=True,
            ).start()
            return {"success": True, "id": context_id, "updated": True}

        # No existing context — create a new one
        user_parts = _USER_TURN.split(text)
        first_user_msg = user_parts[1].strip()[:100] if len(user_parts) > 1 else text.strip()[:100]
        user_title = (req.title or "").strip()
        title = user_title or (first_user_msg if len(first_user_msg) < 50 else first_user_msg[:47] + "...")
        summary: dict = {
            "main_topic": title,
            "key_ideas": [], "snapshot": "", "vitals": [],
            "conclusions": [], "unresolved_questions": [],
        }
        # Merge user tags with the source + capture-method tags (de-duped, order kept).
        method_tag = req.method or "Extension"
        tags = list(dict.fromkeys([*(req.tags or []), req.source, method_tag]))
        result = create_context(
            title=title,
            summary=summary,
            tags=tags,
            original_chat=text,
            important_notes=req.important_snippets or [],
            status="summarizing",
            conversation_url=req.conversation_url or None,
        )
        context_id = result.get("id")
        if req.collection_id:
            try:
                set_context_collection(context_id, req.collection_id)
            except Exception:
                pass
        # All Ollama work (chunk, embed, summarize) happens in the background
        threading.Thread(
            target=_bg_summarize,
            args=(context_id, text, req.important_snippets or [], bool(user_title)),
            daemon=True,
        ).start()
        return {"success": True, "id": context_id, "updated": False}

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
        # Serialise local LLM work so concurrent captures don't contend on the GPU
        _local_llm_lock.acquire()
        try:
            sl = summarize_with_lattice(text, important_snippets=snippets or None)
            real_summary = sl["summary"]
            lattice = sl.get("lattice") or []
            delete_lattice_by_context(cid)
            if lattice:
                create_lattice_entries(cid, lattice)

            # Refresh entity index from current chunks.
            from backend.entity_extractor import extract_entities_per_chunk
            delete_entities_by_context(cid)
            existing_chunks = get_chunks_by_context(cid)
            if existing_chunks:
                ent_map = extract_entities_per_chunk(existing_chunks)
                if ent_map:
                    create_entities_for_context(cid, ent_map)

            new_title = real_summary.get("main_topic", "")
            update_kwargs: dict = {"summary": real_summary}
            if new_title and new_title not in ("No topic extracted", "N/A"):
                update_kwargs["title"] = new_title
            update_context(cid, **update_kwargs, status="completed")
            _try_embed_context(cid, real_summary)
        except Exception:
            update_context(cid, status="failed")
        finally:
            _local_llm_lock.release()

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
        # Extract a short summary snippet from the structured summary dict
        summary_data = ctx.get("summary", "")
        snippet = ""
        key_ideas: list[str] = []
        if isinstance(summary_data, dict):
            snippet = (
                summary_data.get("snapshot") or
                summary_data.get("main_topic") or
                ""
            )
            raw_ideas = summary_data.get("key_ideas", [])
            if isinstance(raw_ideas, list):
                key_ideas = [str(k) for k in raw_ideas[:3] if k]
            if not snippet and key_ideas:
                snippet = key_ideas[0]
        elif isinstance(summary_data, str):
            snippet = summary_data
        if len(snippet) > 140:
            snippet = snippet[:140].rsplit(" ", 1)[0] + "…"

        result.append({
            "id": ctx["id"],
            "title": ctx["title"],
            "summary": snippet,
            "key_ideas": key_ideas,
            "source": ctx.get("source", ""),
            "tags": ctx.get("tags", []),
            "starred": ctx.get("starred", False),
            "status": ctx.get("status", "ready"),
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


@app.get("/api/contexts/summarizing")
def api_get_summarizing_contexts():
    """Return id+title for all contexts currently being summarized."""
    return {"contexts": get_summarizing_contexts()}


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
        # Single-character queries aren't worth a semantic embed (which would cost
        # an Ollama round-trip for no ranking benefit) — go straight to keyword.
        vec = embed_text(q) if len(q.strip()) >= 2 else None
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
    failed: list[int] = []
    for cid in ids:
        # Isolate each context so one bad row (e.g. a transient lock) can't abort
        # the whole batch and 500 the request — delete what we can, report the rest.
        try:
            delete_chunks_by_context(cid)
            if delete_context(cid):
                deleted += 1
        except Exception:
            import logging
            logging.getLogger("contextvolt").exception(
                "bulk-delete: failed to delete context %s", cid
            )
            failed.append(cid)
    return {"deleted": deleted, "requested": len(ids), "failed": failed}


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
        # A force re-embed rebuilds every vector with the active model, so the
        # stored scheme now matches the active one (clears the re-embed guard, #6).
        if force:
            set_meta("embed_scheme", _embedding_scheme_id(_get_embed_model()))
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


def _keyword_search_hybrid(question: str, context_ids: list[int] | None = None) -> list[dict]:
    """Run keyword search with key-term extraction, whole-word filtering, and phrase boosting.

    1. Search for the combined key phrase first (most specific).
    2. Search for individual terms, filtering to whole-word matches only.
    3. Chunks matching more terms rank higher.

    `context_ids`, when given, restricts results to that set of contexts.
    """
    key_terms = _extract_key_terms(question)
    if not key_terms:
        return []

    seen_ids: set = set()
    scored: dict[int, dict] = {}  # chunk_id -> chunk (with _score)

    # Phase 1: Search for the full phrase (all key terms together) — most specific
    phrase = " ".join(key_terms)
    for kch in search_chunks_keyword(phrase, top_k=10, context_ids=context_ids):
        cid = kch.get("id")
        if cid not in seen_ids:
            kch["_score"] = 0.75  # phrase match = highest signal
            scored[cid] = kch
            seen_ids.add(cid)

    # Phase 2: Search individual terms, require whole-word match, count term hits
    term_hits: dict[int, int] = {}  # chunk_id -> number of terms matched
    for term in key_terms:
        for kch in search_chunks_keyword(term, top_k=10, context_ids=context_ids):
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


def _cosine(a: list[float], b: list[float]) -> float:
    """Cosine similarity between two equal-length vectors. Returns 0.0 on degenerate input."""
    if not a or not b or len(a) != len(b):
        return 0.0
    dot = 0.0
    na = 0.0
    nb = 0.0
    for x, y in zip(a, b):
        dot += x * y
        na += x * x
        nb += y * y
    if na == 0.0 or nb == 0.0:
        return 0.0
    return dot / ((na ** 0.5) * (nb ** 0.5))


def _decode_embedding(ch: dict) -> list[float] | None:
    """Pull embedding off a chunk dict, JSON-decoding if needed."""
    emb = ch.get("embedding")
    if emb is None:
        return None
    if isinstance(emb, str):
        try:
            emb = json.loads(emb)
        except Exception:
            return None
    if isinstance(emb, list) and emb:
        return emb
    return None


def _rrf_fuse(semantic: list[dict], keyword: list[dict], k: int = 60) -> list[dict]:
    """Reciprocal Rank Fusion of two ranked lists. Returns chunks sorted by fused score.

    When a chunk appears in both lists, flags from both are preserved (e.g. a chunk
    that's both a semantic hit AND a keyword hit must keep its `_keyword_match` flag —
    otherwise downstream code that treats keyword matches as a strong signal misses it).
    """
    by_id: dict[int, dict] = {}
    fused: dict[int, float] = {}

    def _accumulate(lst: list[dict]) -> None:
        for rank, ch in enumerate(lst):
            cid = ch.get("id")
            if cid is None:
                continue
            fused[cid] = fused.get(cid, 0.0) + 1.0 / (k + rank + 1)
            existing = by_id.get(cid)
            if existing is None:
                by_id[cid] = dict(ch)
            else:
                # Merge: keep best _score, preserve embedding (semantic), OR _keyword_match flag
                if ch.get("_keyword_match"):
                    existing["_keyword_match"] = True
                if existing.get("embedding") is None and ch.get("embedding") is not None:
                    existing["embedding"] = ch["embedding"]
                a = existing.get("_score") or 0.0
                b = ch.get("_score") or 0.0
                if b > a:
                    existing["_score"] = b

    _accumulate(semantic)
    _accumulate(keyword)

    out = []
    for cid, score in sorted(fused.items(), key=lambda kv: kv[1], reverse=True):
        ch = dict(by_id[cid])
        ch["_rrf"] = score
        out.append(ch)
    return out


def _mmr_select(
    candidates: list[dict],
    query_vec: list[float] | None,
    k: int = 8,
    lambda_: float = 0.7,
) -> list[dict]:
    """Maximal Marginal Relevance selection. Falls back to head(k) if embeddings unavailable."""
    if not candidates or not query_vec:
        return candidates[:k]

    # Hydrate embeddings for any chunk missing one (keyword-only hits)
    missing = [ch["id"] for ch in candidates if _decode_embedding(ch) is None and ch.get("id") is not None]
    if missing:
        hydrated = get_chunks_by_ids(missing)
        for ch in candidates:
            if _decode_embedding(ch) is None and ch.get("id") in hydrated:
                ch["embedding"] = hydrated[ch["id"]].get("embedding")

    # Pre-decode + score against query
    pool = []
    for ch in candidates:
        emb = _decode_embedding(ch)
        if emb is None:
            pool.append((ch, None, 0.0))
        else:
            pool.append((ch, emb, _cosine(query_vec, emb)))

    selected: list[dict] = []
    selected_embs: list[list[float]] = []

    while pool and len(selected) < k:
        best_idx = -1
        best_score = -1e9
        for i, (ch, emb, q_sim) in enumerate(pool):
            if emb is None:
                # Unembeddable chunk: low priority but keep eligible if pool allows
                relevance = q_sim
                diversity_penalty = 0.0
            else:
                relevance = q_sim
                if selected_embs:
                    diversity_penalty = max(_cosine(emb, se) for se in selected_embs)
                else:
                    diversity_penalty = 0.0
            mmr = lambda_ * relevance - (1 - lambda_) * diversity_penalty
            if mmr > best_score:
                best_score = mmr
                best_idx = i
        if best_idx < 0:
            break
        ch, emb, _ = pool.pop(best_idx)
        selected.append(ch)
        if emb is not None:
            selected_embs.append(emb)

    return selected


# Per-embed-model retrieval score calibration. sqlite-vec returns
# score = 1 - cosine_distance; different embed models produce different score
# distributions, so a single hardcoded floor mis-gates the "I don't know"
# short-circuit when the user switches models. Values are (weak_floor, relative_drop):
#   weak_floor    — below this top semantic score, treat the result as no-match
#   relative_drop — discard semantic hits more than this far below the leader
_EMBED_SCORE_PARAMS: dict[str, tuple[float, float]] = {
    "nomic-embed-text":  (0.18, 0.15),
    "mxbai-embed-large": (0.18, 0.15),
    "qwen3-embedding":   (0.30, 0.18),
}
_EMBED_SCORE_DEFAULT: tuple[float, float] = (0.18, 0.15)


def _embed_score_params() -> tuple[float, float]:
    """Return (weak_floor, relative_drop) calibrated for the active embed model."""
    from backend.ollama_client import _get_embed_model
    base = _get_embed_model().split(":")[0].lower()
    for key, val in _EMBED_SCORE_PARAMS.items():
        if base.startswith(key):
            return val
    return _EMBED_SCORE_DEFAULT


def _hybrid_retrieve(
    question: str,
    query_vec: list[float] | None,
    top_k: int = 8,
    context_ids: list[int] | None = None,
) -> list[dict]:
    """Hybrid retrieval: RRF-fuse semantic + keyword, then MMR-diversify.

    Returns up to top_k chunks. Drops semantic hits whose score is far below the top
    semantic match (relative threshold replaces the old hardcoded 0.35 short-query gate).
    `context_ids`, when given, restricts retrieval to that set of contexts (scoping).
    """
    semantic_chunks: list[dict] = []
    if query_vec:
        semantic_chunks = search_chunks_semantic(
            query_vec, context_id=None, top_k=30, context_ids=context_ids
        )
        if semantic_chunks:
            weak_floor, relative_drop = _embed_score_params()
            top_score = semantic_chunks[0].get("_score", 0)
            # Relative drop: discard hits more than `relative_drop` below the leader,
            # with an absolute pre-filter floor just under the weak-result floor.
            cutoff = max(weak_floor - 0.03, top_score - relative_drop)
            semantic_chunks = [ch for ch in semantic_chunks if ch.get("_score", 0) >= cutoff]

    kw_chunks = _keyword_search_hybrid(question, context_ids=context_ids)[:30]

    fused = _rrf_fuse(semantic_chunks, kw_chunks)
    if not fused:
        return []

    # Diversify with MMR (limit candidate pool to top 20 by RRF for speed)
    return _mmr_select(fused[:20], query_vec, k=top_k, lambda_=0.7)


def _rerank_chunks(
    question: str,
    chunks: list[dict],
    top_n: int = 8,
    candidate_cap: int = 15,
) -> list[dict]:
    """Listwise LLM rerank of retrieved chunks for final-stage precision.

    RRF+MMR order by fusion/diversity, not true relevance to the question. A
    single cheap listwise pass through the active LLM (local or cloud) reorders
    the candidate pool by actual relevance before it's fed to the answer model.

    Provider-agnostic via the router. Gated by config "rag_rerank" (default on).
    Falls back to the input order (truncated to top_n) on any failure, so a bad
    or slow rerank can never drop a result that retrieval already found.
    """
    if not chunks:
        return chunks
    if not _read_config().get("rag_rerank", True):
        return chunks[:top_n]

    pool = chunks[:candidate_cap]
    if len(pool) <= 1:
        return pool[:top_n]

    lines = []
    for i, ch in enumerate(pool):
        snippet = (ch.get("text") or "").strip().replace("\n", " ")[:300]
        lines.append(f"[{i}] {snippet}")
    listing = "\n".join(lines)

    prompt = (
        "You are a search reranker. Given a user question and numbered passages, "
        "return the passage numbers most relevant to answering the question, "
        "most relevant first.\n"
        "Rules:\n"
        "- Output ONLY comma-separated numbers, e.g. 3,0,7\n"
        f"- Return at most {top_n} numbers.\n"
        "- Omit clearly irrelevant passages.\n\n"
        f"Question: {question}\n\n"
        f"Passages:\n{listing}\n\n"
        "Most relevant passage numbers:"
    )
    try:
        result = router_generate(prompt, temperature=0.0, max_tokens=60, timeout=30)
        raw = (result.get("response") or "").strip()
        nums = [int(n) for n in re.findall(r"\d+", raw)]
        seen: set[int] = set()
        ordered: list[dict] = []
        for n in nums:
            if 0 <= n < len(pool) and n not in seen:
                seen.add(n)
                ordered.append(pool[n])
        if ordered:
            # Keep retrieval recall: append any pool chunks the reranker omitted,
            # in their original order, so they fill remaining slots up to top_n.
            for i, ch in enumerate(pool):
                if i not in seen:
                    ordered.append(ch)
            return ordered[:top_n]
    except Exception:
        pass
    return chunks[:top_n]


# ---------------------------------------------------------------------------
# Ask Your Vault — RAG Chat
# ---------------------------------------------------------------------------

def _dedup_near_duplicate_chunks(chunks: list[dict], threshold: float = 0.9) -> list[dict]:
    """Drop chunks whose text is near-identical to one already kept (token Jaccard).

    Overlapping chunks and repeated boilerplate across captures can surface the
    same passage multiple times, wasting prompt budget and skewing the model
    toward repetition. Keeps the first occurrence (already the higher-ranked one).
    """
    kept: list[dict] = []
    kept_sets: list[set] = []
    for ch in chunks:
        toks = set(re.findall(r"[a-z0-9]+", (ch.get("text") or "").lower()))
        if not toks:
            kept.append(ch)
            kept_sets.append(toks)
            continue
        is_dup = False
        for ks in kept_sets:
            if not ks:
                continue
            union = len(toks | ks)
            if union and len(toks & ks) / union >= threshold:
                is_dup = True
                break
        if not is_dup:
            kept.append(ch)
            kept_sets.append(toks)
    return kept


def _rag_context_budget(active: dict) -> dict:
    """Per-provider budget for the retrieved-context block fed to the answer model.

    Cloud models have large context windows, so we feed more chunks and longer
    bodies; local Ollama models are capped to avoid overflowing num_ctx (the
    streaming path limits ctx to 16k).
    """
    if active.get("is_cloud"):
        return {"max_chunks": 12, "per_chunk_chars": 4000}
    return {"max_chunks": 8, "per_chunk_chars": 1500}

def _rewrite_query_with_history(question: str, history: list[dict]) -> str:
    """Rewrite a follow-up question into a standalone search query using history.

    Returns the rewritten query, or the original question on any failure / no history.
    Uses the active LLM router with temperature 0 and a tight token budget.
    """
    if not history:
        return question

    # Use only the last few turns to keep the rewrite prompt compact
    turns = []
    for msg in history[-4:]:
        role = (msg.get("role") or "user").upper()
        content = (msg.get("content") or "").strip()
        if content:
            turns.append(f"{role}: {content[:500]}")
    if not turns:
        return question

    history_block = "\n".join(turns)
    prompt = (
        "You are a query-rewriting assistant for a vector search system. "
        "The user is asking a follow-up question. Rewrite it into ONE standalone "
        "search query that contains the specific topic/entity being discussed "
        "(carry forward proper nouns, project names, or subjects from the prior "
        "turns into the rewritten query).\n\n"
        "Rules:\n"
        "- Output ONLY the rewritten query, on a single line.\n"
        "- No preamble, no labels, no quotes, no explanation.\n"
        "- 5–20 words. Keep concrete nouns from the prior turns.\n\n"
        f"<conversation>\n{history_block}\n</conversation>\n\n"
        f"Latest question from user: {question}\n\n"
        "Rewritten standalone query:"
    )
    try:
        result = router_generate(prompt, temperature=0.0, max_tokens=120, timeout=30)
        raw = (result.get("response") or "").strip()
        if not raw:
            return question
        # Collapse the full output to a single line. Some models (e.g. Gemini)
        # emit soft line breaks mid-query — taking only the first line truncates
        # the rewrite and corrupts retrieval ("script for the Alan" instead of
        # "script for the Alan Turing reel").
        flat = " ".join(ln.strip() for ln in raw.splitlines() if ln.strip())
        # Drop any preamble paragraph if the model added one (e.g. "Sure! Here's
        # the rewritten query: ..."). Keep everything after the last colon if
        # the prefix looks like a label.
        rewritten = re.sub(
            r"^(here(?:'s| is) (?:the )?(?:rewritten )?(?:standalone )?(?:search )?query[:\-]?|"
            r"sure[!,]?|"
            r"query|standalone query|rewritten( standalone)?( query)?|search query)\s*[:\-]\s*",
            "",
            flat,
            flags=re.IGNORECASE,
        )
        rewritten = rewritten.strip().strip('"').strip("'").strip()
        # Cap absurdly long output (some models ramble); trim at the first sentence break.
        if len(rewritten) > 200:
            cut = re.search(r"[.!?]\s", rewritten)
            if cut:
                rewritten = rewritten[: cut.start() + 1].strip()
        if 3 <= len(rewritten) <= 400:
            return rewritten
    except Exception:
        pass
    return question


@app.post("/api/vault/ask")
def api_vault_ask(body: dict):
    """RAG chat: answer a question using the user's saved conversation vault.

    Streams NDJSON lines:
      {"token": "..."} — during generation
      {"done": true, "sources": [...], "usage": {...}, "cost": ...} — final line with citations

    Body: {
        "question": "...",
        "history": [{"role": "user"|"assistant", "content": "..."}],
        "session_id": optional int — if omitted, a new session is created and returned
                      in the final 'done' line as session_id (+ session_title for new ones)
    }
    """
    question = (body.get("question") or "").strip()
    if not question:
        raise HTTPException(status_code=400, detail="Question is required")

    increment_stat("questions_asked")

    history = body.get("history") or []

    # Optional scope: restrict retrieval to a single collection (#10). An empty
    # collection (or unknown id) yields no context_ids → retrieval finds nothing,
    # which the weak-result gate reports cleanly.
    scope_context_ids: list[int] | None = None
    collection_id = body.get("collection_id")
    if collection_id is not None:
        try:
            scope_context_ids = get_context_ids_by_collection(int(collection_id))
        except Exception:
            scope_context_ids = None

    # Persistence: resolve or create the Ask Vault session.
    session_id = body.get("session_id")
    new_session_title: str | None = None
    if session_id is None:
        # Auto-title from the question — first 60 chars, single line.
        title_seed = " ".join(question.split())[:60].strip() or "Untitled"
        new_session_title = title_seed
        session = create_ask_session(title_seed)
        session_id = session["id"]
    else:
        # Validate it exists; treat unknown id as start-fresh
        existing = get_ask_session(int(session_id))
        if not existing:
            title_seed = " ".join(question.split())[:60].strip() or "Untitled"
            new_session_title = title_seed
            session = create_ask_session(title_seed)
            session_id = session["id"]
        else:
            session_id = int(session_id)

    # Persist the user turn now (before LLM call) so it survives crashes mid-stream.
    append_ask_message(session_id, "user", question)

    # Check provider availability
    active = get_active_provider()
    if not active["is_cloud"]:
        if not check_ollama_running():
            raise HTTPException(status_code=503, detail="Ollama is not running")

    # 1. Rewrite follow-up questions into standalone queries (skipped on first turn).
    #    The rewrite is *additive*: we run retrieval with both the original question
    #    and the rewritten one, then fuse — a bad rewrite can't poison results.
    rewritten = _rewrite_query_with_history(question, history) if history else question

    # 2. Embed both queries (Ollama, local)
    primary_vec = embed_text(question)
    rewritten_vec = embed_text(rewritten) if rewritten and rewritten != question else None

    # 3. Hybrid retrieval — fuse results from primary + rewritten queries.
    #    Retrieve a WIDER candidate pool here; the reranker (step 3b) narrows it
    #    to the final 8 by true relevance rather than fusion rank.
    primary_chunks = _hybrid_retrieve(question, primary_vec, top_k=15, context_ids=scope_context_ids)
    if rewritten_vec is not None:
        secondary_chunks = _hybrid_retrieve(rewritten, rewritten_vec, top_k=15, context_ids=scope_context_ids)
        # Fuse the two ranked lists with RRF (treat each as a single ranking)
        candidate_chunks = _rrf_fuse(primary_chunks, secondary_chunks)[:15]
    else:
        candidate_chunks = primary_chunks[:15]

    # 3b. Listwise LLM rerank → final top 8 by relevance (no-op if disabled/fails).
    top_chunks = _rerank_chunks(question, candidate_chunks, top_n=8)

    # 4. Neighbor expansion — pull adjacent chunks (chunk_index ± 1) for local coherence.
    #    Replaces the old "first 2 chunks of any matching context" fallback.
    if top_chunks:
        seen_ids = {ch.get("id") for ch in top_chunks}
        neighbors: list[dict] = []
        for ch in list(top_chunks):
            cid = ch.get("context_id")
            idx = ch.get("chunk_index")
            if cid is None or idx is None:
                continue
            for nb in get_chunk_neighbors(cid, idx):
                if nb.get("id") not in seen_ids:
                    nb["_score"] = (ch.get("_score") or 0.0) * 0.6
                    nb["_neighbor"] = True
                    neighbors.append(nb)
                    seen_ids.add(nb.get("id"))
        top_chunks.extend(neighbors)
        # Cap final feed to the LLM
        top_chunks = top_chunks[:12]

    # 5. Score-floor short-circuit: if nothing retrieved is meaningfully relevant,
    #    return a deterministic "I don't know" without invoking the LLM.
    #    Threshold is intentionally permissive — we'd rather feed weak context to
    #    the LLM (which can still say "I don't know") than miss a valid hit.
    weak_floor, _ = _embed_score_params()

    def _is_weak_result(chunks: list[dict]) -> bool:
        if not chunks:
            return True
        # Any keyword hit is a strong signal — never short-circuit
        if any(ch.get("_keyword_match") for ch in chunks):
            return False
        top_sem = max((ch.get("_score") or 0.0) for ch in chunks)
        return top_sem < weak_floor

    if _is_weak_result(top_chunks):
        empty_msg = "I don't have information about that in your vault."
        append_ask_message(session_id, "assistant", empty_msg, citations=[])

        def _empty_stream():
            for tok in empty_msg.split(" "):
                yield json.dumps({"token": tok + " "}) + "\n"
            final = {"done": True, "sources": [], "session_id": session_id}
            if new_session_title is not None:
                final["session_title"] = new_session_title
            yield json.dumps(final) + "\n"
        return StreamingResponse(_empty_stream(), media_type="application/x-ndjson")

    # 6. Build context blocks + chunk-level source citations.
    #    Each block is prefixed with a [n] marker the model cites inline (#9);
    #    the matching number is stored on each source so the UI can link them.
    #    The number of blocks + their length is provider-aware (#8).
    top_chunks = _dedup_near_duplicate_chunks(top_chunks)
    budget = _rag_context_budget(active)
    top_chunks = top_chunks[: budget["max_chunks"]]

    sources = []
    context_text_parts = []

    unique_cids = list({ch.get("context_id") for ch in top_chunks if ch.get("context_id")})
    ctx_map = get_contexts_by_ids(unique_cids)

    for ch in top_chunks:
        cid = ch.get("context_id")
        ctx = ctx_map.get(cid, {})
        tags = ctx.get("tags", [])
        if isinstance(tags, str):
            tags = [t.strip() for t in tags.split(",")]
        source_llm = next((t for t in tags if t in _KNOWN_SOURCES_SET), "")
        title = ctx.get("title", "Unknown")
        created_at = ctx.get("created_at", "")[:10]
        score = round(ch.get("_score") or 0.0, 2)

        cite_num = len(context_text_parts) + 1
        body_text = _truncate_at_sentence(ch.get("text", ""), budget["per_chunk_chars"])

        header = f'[{cite_num}] From "{title}"'
        if source_llm:
            header += f" ({source_llm})"
        header += f" — {created_at}, relevance {score}]"
        context_text_parts.append(f"{header}:\n{body_text}")

        snippet_raw = (ch.get("text") or "").strip().replace("\n", " ")
        snippet = _truncate_at_sentence(snippet_raw, 220) if snippet_raw else ""
        sources.append({
            "n": cite_num,
            "context_id": cid,
            "chunk_id": ch.get("id"),
            "chunk_index": ch.get("chunk_index"),
            "title": title,
            "score": score,
            "created_at": created_at,
            "source": source_llm,
            "snippet": snippet,
            "neighbor": bool(ch.get("_neighbor")),
        })

    retrieved_context = "\n\n".join(context_text_parts) if context_text_parts else "No relevant context found in your vault."

    # 7. Build the RAG prompt. The instructions + retrieved context + history go
    #    into a system prompt (role separation + Anthropic prompt caching, #7);
    #    the user's question is the user turn.
    history_text = ""
    if history:
        turns = []
        for msg in history[-6:]:  # last 6 messages for context window
            role = msg.get("role", "user").upper()
            turns.append(f"{role}: {msg.get('content', '')}")
        history_text = "\n".join(turns)

    system_prompt = f"""You are ContextVolt Assistant. You answer the user's question using ONLY the retrieved excerpts from their saved conversations below.

RULES:
- The excerpts are REFERENCE MATERIAL from past chats. Do NOT copy their wording, tone, persona, or formatting, and never role-play a voice from them (e.g. addressing the user as "Boss"). Write in your own neutral voice.
- Answer the user's CURRENT question directly and nothing else. For a yes/no question, begin with "Yes" or "No".
- Use ONLY facts present in the excerpts. Never invent details, names, features, or numbers. If the excerpts don't actually address the question, reply exactly: "I don't have information about that in your vault." — even if an excerpt is loosely related.
- Cite sources inline using the bracketed numbers from the context blocks, e.g. [1] or [2][3], placed right after the claim they support.
- Be concise. Use markdown (lists, code blocks) only when it helps.
- If multiple excerpts genuinely discuss the same topic, synthesize them — but never merge unrelated topics to force an answer.

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

    # Stream the response via the LLM router (Ollama or cloud).
    def _stream():
        accumulated: list[str] = []
        persisted = False
        try:
            for event in router_generate_stream(
                question, temperature=0.2, max_tokens=4000, system=system_prompt
            ):
                if event.get("token"):
                    accumulated.append(event["token"])
                    yield json.dumps({"token": event["token"]}) + "\n"
                elif event.get("error"):
                    yield json.dumps({"error": event["error"]}) + "\n"
                elif event.get("done"):
                    # Persist assistant turn with citations
                    if not persisted:
                        append_ask_message(
                            session_id, "assistant", "".join(accumulated), citations=sources
                        )
                        persisted = True
                    # Final line with sources + usage info
                    final = {"done": True, "sources": sources, "session_id": session_id}
                    if new_session_title is not None:
                        final["session_title"] = new_session_title
                    if event.get("usage"):
                        final["usage"] = event["usage"]
                    if event.get("cost") is not None:
                        final["cost"] = event["cost"]
                    if event.get("provider"):
                        final["provider"] = event["provider"]
                    if event.get("model"):
                        final["model"] = event["model"]
                    yield json.dumps(final) + "\n"
                    return
        except Exception as e:
            yield json.dumps({"error": str(e)}) + "\n"

        # Fallback final line if stream didn't send done
        if not persisted and accumulated:
            append_ask_message(
                session_id, "assistant", "".join(accumulated), citations=sources
            )
        final = {"done": True, "sources": sources, "session_id": session_id}
        if new_session_title is not None:
            final["session_title"] = new_session_title
        yield json.dumps(final) + "\n"

    return StreamingResponse(_stream(), media_type="application/x-ndjson")


# ---------------------------------------------------------------------------
# Ask Vault — sessions API
# ---------------------------------------------------------------------------

@app.get("/api/vault/sessions")
def api_vault_sessions_list():
    """Return all saved Ask Vault sessions (pinned first, then newest)."""
    return {"sessions": list_ask_sessions()}


@app.get("/api/vault/sessions/{session_id}")
def api_vault_session_get(session_id: int):
    """Return a single session with its full message history."""
    session = get_ask_session(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
    return session


@app.patch("/api/vault/sessions/{session_id}")
def api_vault_session_update(session_id: int, body: dict):
    """Rename or pin/unpin a session. Body: {title?: str, pinned?: bool}"""
    title = body.get("title")
    pinned = body.get("pinned")
    if title is None and pinned is None:
        raise HTTPException(status_code=400, detail="Nothing to update")
    updated = update_ask_session(session_id, title=title, pinned=pinned)
    if not updated:
        raise HTTPException(status_code=404, detail="Session not found")
    return updated


@app.delete("/api/vault/sessions/{session_id}")
def api_vault_session_delete(session_id: int):
    """Delete a session and its messages."""
    if not delete_ask_session(session_id):
        raise HTTPException(status_code=404, detail="Session not found")
    return {"deleted": True}


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
        prompt_size=body.size or "standard",
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

            # Build a lookup for fast chunk access by index (shared below).
            by_idx = {ch["chunk_index"]: ch for ch in all_chunks}
            seen_idx = {ch["chunk_index"] for ch in top_chunks}

            # Semantic neighbor expansion — pull adjacent chunks (±1) for
            # every semantic hit. Catches cases where the matched chunk is
            # beside the specific fact-bearing chunk (e.g. path in next turn).
            for ch in list(top_chunks):
                for ni in (ch["chunk_index"] - 1, ch["chunk_index"] + 1):
                    if ni in by_idx and ni not in seen_idx:
                        top_chunks.append(by_idx[ni])
                        seen_idx.add(ni)

            # Entity boost — if the query mentions an identifier-shaped
            # token (deploy key, ticket id, file path), pull the chunks
            # that contain it. These survive regardless of semantic score.
            entity_chunk_indices = find_entity_chunks_for_query(context_id, query.strip())
            if entity_chunk_indices:
                for idx in entity_chunk_indices:
                    if idx in by_idx and idx not in seen_idx:
                        top_chunks.append(by_idx[idx])
                        seen_idx.add(idx)

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

    # ── No-query path: full context prompt ──
    summary = ctx["summary"]
    if isinstance(summary, dict):
        all_chunks_static = get_chunks_by_context(context_id)
        lattice_entries = get_lattice_entries_by_context(context_id) or None
        prompt = generate_continuation_prompt(
            summary,
            ctx.get("original_chat", ""),
            important_snippets=important_notes,
            source_llm=source_llm,
            created_at=ctx.get("created_at", ""),
            prompt_size=effective_size,
            chunks=all_chunks_static or None,
            lattice=lattice_entries,
        )
        mode = "context" if all_chunks_static else "static"
        return {
            "prompt": prompt,
            "context_id": context_id,
            "title": ctx["title"],
            "mode": mode,
        }

    # Fallback for legacy string summaries
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
        r = _req.get(f"{OLLAMA_BASE}/api/tags", timeout=5)
        models = [m.get("name") for m in r.json().get("models", [])]
    except Exception as e:
        models = [f"ERROR: {e}"]
    return {"configured_model": DEFAULT_MODEL, "installed_models": models}


@app.get("/api/debug/logs")
def api_debug_logs(lines: int = 100):
    """Return the last N lines of contextvolt.log for in-app debugging.

    Provides both the raw ``lines`` (backward compatible) and ``entries`` —
    structured records parsed from the ``HH:MM:SS [LEVEL] message`` log format
    used by the file handler — so the System → Logs view can render a
    timestamp / level / message layout with per-level filtering. ``counts``
    gives a tally per level for the filter chips.
    """
    import re as _re
    from backend.paths import app_log_path as _app_log_path

    log_path = str(_app_log_path())
    if not os.path.exists(log_path):
        return {"lines": [], "entries": [], "counts": {}, "path": log_path, "exists": False}

    with open(log_path, "r", encoding="utf-8", errors="replace") as f:
        all_lines = f.readlines()
    tail = all_lines[-lines:]

    line_re = _re.compile(r"^(\d{2}:\d{2}:\d{2})\s+\[(\w+)\]\s*(.*)$")
    entries: list[dict] = []
    for raw in tail:
        line = raw.rstrip("\n")
        m = line_re.match(line)
        if m:
            entries.append({"ts": m.group(1), "level": m.group(2).upper(), "msg": m.group(3)})
        elif entries:
            # Continuation of a multi-line message (e.g. a traceback).
            entries[-1]["msg"] += "\n" + line
        elif line.strip():
            entries.append({"ts": "", "level": "INFO", "msg": line})

    counts: dict[str, int] = {}
    for e in entries:
        counts[e["level"]] = counts.get(e["level"], 0) + 1

    return {"lines": tail, "entries": entries, "counts": counts, "path": log_path, "exists": True}


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
            r = _req.get(f"{OLLAMA_BASE}/api/tags", timeout=5)
            installed_models = [m.get("name", "") for m in r.json().get("models", [])]
        except Exception:
            pass

    try:
        db = get_db_stats()
    except Exception:
        db = {"contexts": 0, "chunks": 0, "collections": 0, "size_mb": 0.0}

    active = get_active_provider()

    return {
        "backend":          {"status": "ok", "uptime_s": uptime_s},
        "ollama":           {"running": ollama_running, "url": OLLAMA_BASE},
        "model":            {"name": current_model, "ready": model_ready},
        "embed":            {"name": embed_model},
        "installed_models": installed_models,
        "database":         db,
        "active_provider":  {"provider": active["provider"], "model": active["model"], "is_cloud": active["is_cloud"]},
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
        # Pinned items live in their own rail — keep the recent list to
        # genuinely recent, unpinned contexts so nothing shows up twice.
        recent = get_contexts_paginated(page=1, per_page=20, sort="newest")
        recent_contexts = [c for c in recent["contexts"] if not c.get("starred")][:8]
    except Exception:
        recent_contexts = []

    try:
        pinned = get_starred_contexts(limit=20)
    except Exception:
        pinned = []

    try:
        from backend.database import get_activity_daily
        activity = get_activity_daily(days=14)
    except Exception:
        activity = []

    try:
        sessions = sorted(list_ask_sessions(), key=lambda s: s["updated_at"] or "", reverse=True)[:3]
    except Exception:
        sessions = []

    return {
        "stats": db,
        "recent": recent_contexts,
        "pinned": pinned,
        "activity": activity,
        "ask_sessions": sessions,
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


# ---------------------------------------------------------------------------
# ConVX-as-MCP-server — info for the in-app settings panel.
# Distinct namespace (`mcp_server`) from the host endpoints (`mcp`) above.
# ---------------------------------------------------------------------------

def _mcp_server_info_payload(request: Request) -> dict:
    """Build the full payload shown in the settings UI.

    Sensitive: includes the bearer token. Only return on requests bound to
    loopback — anyone hitting this endpoint from elsewhere shouldn't see it.
    """
    from backend.mcp_http import get_http_token, get_auth_required

    # Compose the local URL for the HTTP transport. /mcp lives on the dedicated
    # MCP app (its own loopback port), not on this REST app, so point at that
    # port. Falls back to this app's host only if the MCP port isn't published
    # (bare `uvicorn backend.main` with no run.py).
    if _mcp_port:
        http_url = f"http://127.0.0.1:{_mcp_port}/mcp"
    else:
        host = (request.headers.get("host") or f"127.0.0.1:{_active_port}").strip()
        http_url = f"http://{host}/mcp"

    # Detect the venv python actually running the app — that's exactly what
    # the user should put in their Claude Desktop config.
    python_path = sys.executable
    script_path = os.path.abspath(os.path.join(os.path.dirname(__file__), "mcp_server.py"))

    stdio_command = python_path
    stdio_args = [script_path]
    stdio_config_snippet = json.dumps({
        "mcpServers": {
            "contextvolt": {
                "command": stdio_command,
                "args": stdio_args,
            }
        }
    }, indent=2)

    return {
        "http": {
            "url": http_url,
            "auth_required": get_auth_required(),
            "token": get_http_token(),
        },
        "stdio": {
            "command": stdio_command,
            "args": stdio_args,
            "config_snippet": stdio_config_snippet,
        },
        "tools": ["search_vault", "get_context", "list_recent_contexts",
                  "get_chunks", "vault_stats"],
    }


def _is_loopback(request: Request) -> bool:
    # A request arriving through a Cloudflare tunnel reaches us from cloudflared,
    # which runs on localhost — so request.client.host alone would read 127.0.0.1
    # and wrongly pass. Cloudflare's edge stamps cf-connecting-ip / cf-ray on
    # every tunneled request and a client cannot strip them, so their presence is
    # a reliable "this came from the internet" signal. Use it to fail closed.
    # (Belt-and-suspenders: the tunnel is pointed at the MCP-only app, so these
    # admin endpoints aren't on the tunneled surface anyway.)
    headers = request.headers
    if headers.get("cf-connecting-ip") or headers.get("cf-ray"):
        return False
    client = request.client
    host = client.host if client else ""
    return host in ("127.0.0.1", "::1", "localhost")


@app.get("/api/mcp_server/info")
def mcp_server_info(request: Request):
    """Full info for the settings panel (URL + token + stdio snippet).

    Loopback-only — refuses requests from anywhere else.
    """
    if not _is_loopback(request):
        raise HTTPException(status_code=403, detail="loopback only")
    return _mcp_server_info_payload(request)


@app.post("/api/mcp_server/regenerate_token")
def mcp_server_regenerate_token(request: Request):
    """Generate a fresh bearer token, persist to config.json, return it."""
    if not _is_loopback(request):
        raise HTTPException(status_code=403, detail="loopback only")
    from backend.mcp_http import regenerate_http_token
    new_token = regenerate_http_token()
    return {"token": new_token}


@app.post("/api/mcp_server/auth_required")
def mcp_server_set_auth_required(request: Request, body: dict):
    """Toggle whether the HTTP transport requires a bearer token."""
    if not _is_loopback(request):
        raise HTTPException(status_code=403, detail="loopback only")
    if "required" not in body or not isinstance(body["required"], bool):
        raise HTTPException(status_code=400, detail="body must be {required: bool}")
    from backend.mcp_http import set_auth_required
    set_auth_required(body["required"])
    return {"auth_required": body["required"]}


# ---------------------------------------------------------------------------
# Cloudflare Tunnel — gives the local MCP server a public HTTPS URL so that
# remote LLMs (Grok, ChatGPT, Claude.ai) can reach it.
# ---------------------------------------------------------------------------

@app.get("/api/mcp_server/tunnel")
def mcp_tunnel_status(request: Request):
    """Return current tunnel state + public HTTPS MCP URL (if running)."""
    if not _is_loopback(request):
        raise HTTPException(status_code=403, detail="loopback only")
    from backend import cloudflare_tunnel
    return cloudflare_tunnel.get_status()


@app.post("/api/mcp_server/tunnel/start")
def mcp_tunnel_start(request: Request):
    """Download cloudflared if needed and start a Quick Tunnel.

    The tunnel is pointed at the MCP-only app's port (backend.mcp_app), never at
    this REST app — so the public HTTPS URL exposes /mcp + OAuth and nothing
    else. If that port isn't published (app started without run.py), we refuse
    rather than fall back to exposing the full API.
    """
    if not _is_loopback(request):
        raise HTTPException(status_code=403, detail="loopback only")
    if not _mcp_port:
        raise HTTPException(
            status_code=503,
            detail="MCP endpoint not running; remote tunnel unavailable in this mode.",
        )
    from backend import cloudflare_tunnel
    cloudflare_tunnel.start(port=_mcp_port)
    return {"ok": True, "status": cloudflare_tunnel.get_status()["status"]}


@app.post("/api/mcp_server/tunnel/stop")
def mcp_tunnel_stop(request: Request):
    """Terminate the tunnel process."""
    if not _is_loopback(request):
        raise HTTPException(status_code=403, detail="loopback only")
    from backend import cloudflare_tunnel
    cloudflare_tunnel.stop()
    return {"ok": True}


# OAuth 2.0 + PKCE for remote MCP clients (Grok, ChatGPT, Claude.ai) lives on the
# standalone MCP app (backend.oauth_routes / backend.mcp_app), which is the only
# surface the Cloudflare tunnel exposes. It is intentionally NOT registered on
# this REST app, which is loopback-only and never tunneled.


# ---------------------------------------------------------------------------
# Auto-update
# ---------------------------------------------------------------------------

@app.get("/api/update/check")
def update_check():
    """Check GitHub releases for a newer version."""
    from backend.updater import check_for_update
    return check_for_update()


@app.get("/api/update/download")
def update_download():
    """Stream installer download progress as SSE.

    The download URL is resolved server-side from the GitHub releases API — it is
    never taken from the request. This prevents a malicious page (which can reach
    127.0.0.1 cross-origin) from pointing the updater at an arbitrary executable
    and then triggering /api/update/apply to run it.
    """
    from backend.updater import check_for_update, download_update
    import json as _json

    info = check_for_update()
    url = info.get("download_url")
    size = info.get("asset_size", 0) or 0

    def _stream():
        if not url:
            yield f"data: {_json.dumps({'error': 'no installer available for this platform', 'done': True})}\n\n"
            return
        for chunk in download_update(url, size):
            yield f"data: {_json.dumps(chunk)}\n\n"

    return StreamingResponse(
        _stream(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@app.post("/api/update/apply")
def update_apply():
    """Launch the downloaded installer silently and exit."""
    from backend.updater import apply_update
    if not apply_update():
        raise HTTPException(status_code=400, detail="No downloaded update ready")
    return {"ok": True}
