"""
ContextVolt — pluggable local inference engine.

get_engine() selects an InferenceEngine implementation via the
INFERENCE_BACKEND setting (env var, default "ollama"). Nothing in the rest
of the app calls this yet — ollama_client.py still talks to Ollama directly.
Wiring callers to go through this factory is a later, separate change so
each step stays independently verifiable.
"""

from __future__ import annotations

import json
import os

from backend.engine.base import InferenceEngine
from backend.paths import config_path as _config_path

_VALID_BACKENDS = ("ollama", "native")


def get_inference_backend() -> str:
    """Priority: INFERENCE_BACKEND env var -> config.json -> default 'ollama'."""
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
    return "ollama"


def get_engine(backend: str | None = None) -> InferenceEngine:
    """Return the InferenceEngine for `backend` (or the configured default)."""
    backend = backend or get_inference_backend()
    if backend == "native":
        from backend.engine.native import NativeEngine
        return NativeEngine()
    from backend.engine.ollama import OllamaEngine
    return OllamaEngine()
