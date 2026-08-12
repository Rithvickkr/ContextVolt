"""
ContextVolt — pluggable local inference engine.

get_engine() selects an InferenceEngine implementation via the
INFERENCE_BACKEND setting (env var, default "native"): "native" runs GGUF
models in-process via llama-cpp-python, "ollama" talks to a separate Ollama
server over HTTP.

Route readiness checks through local_engine_ready()/local_engine_label()
rather than calling ollama_client.check_ollama_running() directly — the
latter is always False under the native backend, which would 503 every
local-inference endpoint.
"""

from __future__ import annotations

import json
import os

from backend.engine.base import InferenceEngine
from backend.paths import config_path as _config_path

_VALID_BACKENDS = ("ollama", "native")


DEFAULT_BACKEND = "native"


def get_inference_backend() -> str:
    """Priority: INFERENCE_BACKEND env var -> config.json -> DEFAULT_BACKEND.

    The default is "native": a fresh install runs GGUF models in-process
    instead of downloading and shelling out to a separate Ollama app. Existing
    installs are unaffected — they have an explicit `inference_backend` in
    config.json, which wins over this default. "ollama" stays selectable from
    Settings as a fallback for platforms where the native wheel misbehaves.
    """
    env = os.getenv("INFERENCE_BACKEND")
    if env in _VALID_BACKENDS:
        return env
    try:
        with open(str(_config_path()), "r", encoding="utf-8") as f:
            cfg = json.load(f)
            if isinstance(cfg, dict) and cfg.get("inference_backend") in _VALID_BACKENDS:
                return cfg["inference_backend"]
    except Exception:
        pass
    return DEFAULT_BACKEND


def is_native_backend() -> bool:
    return get_inference_backend() == "native"


def get_engine(backend: str | None = None) -> InferenceEngine:
    """Return the InferenceEngine for `backend` (or the configured default)."""
    backend = backend or get_inference_backend()
    if backend == "native":
        from backend.engine.native import NativeEngine
        return NativeEngine()
    from backend.engine.ollama import OllamaEngine
    return OllamaEngine()


def local_engine_ready() -> bool:
    """Can the active LOCAL backend serve inference right now?

    Use this instead of ollama_client.check_ollama_running() when gating an
    endpoint — under the native backend Ollama is legitimately absent, so a
    raw check_ollama_running() gate turns every local-inference route into a
    503 even though inference works fine.
    """
    try:
        return get_engine().is_ready()
    except Exception:
        return False


def local_engine_label() -> str:
    """Short display name for the active local engine.

    Deliberately a bare noun ("Built-in", not "Local engine") because the UI
    nests it inside other text — the provider card renders "Local (<label>)",
    which read as "Local (Local engine)" before this. Prose that needs a full
    sentence subject should phrase around it rather than interpolating this.
    """
    return "Built-in" if is_native_backend() else "Ollama"


def local_model_available(model: str | None = None) -> bool:
    """Is `model` (default: the configured chat model) installed locally?

    Native uses exact registry-key matching; Ollama keeps its historical
    fuzzy base-name match (so "qwen2.5:7b" still matches an installed
    "qwen2.5:latest"), which is why this isn't a single shared code path.
    """
    from backend.ollama_client import _get_default_model
    model = model or _get_default_model()
    try:
        if is_native_backend():
            return model in get_engine().list_models()
        from backend.ollama_client import check_model_available
        return check_model_available(model)
    except Exception:
        return False


def local_model_missing_detail(model: str) -> str:
    """The 503 detail string to show when local_model_available() is False."""
    if is_native_backend():
        return f"Model '{model}' is not downloaded. Download it from Settings."
    return f"Model '{model}' is not available. Pull it with 'ollama pull {model}'."


def local_engine_unready_detail() -> str:
    """The 503 detail string to show when local_engine_ready() is False."""
    if is_native_backend():
        return (
            "Local engine is not ready — no model files found. "
            "Download a model from Settings."
        )
    return "Ollama is not running. Please start it with 'ollama serve'."
