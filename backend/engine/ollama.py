"""
OllamaEngine — adapts the existing Ollama HTTP integration in
backend/ollama_client.py to the InferenceEngine Protocol.

Pure delegation: every method here calls straight into the existing,
already-tested functions in ollama_client.py. No behavior changes — this
just gives the rest of the app a backend-agnostic object to call instead of
importing ollama_client functions directly, so backend/engine/native.py can
be swapped in later without touching call sites.
"""

from __future__ import annotations

import requests

from backend import ollama_client as _oc


class OllamaEngine:
    """InferenceEngine implementation backed by a running Ollama server."""

    def is_ready(self) -> bool:
        return _oc.check_ollama_running()

    def list_models(self) -> list[str]:
        try:
            r = requests.get(f"{_oc.OLLAMA_BASE}/api/tags", timeout=5)
            r.raise_for_status()
            return [m.get("name", "") for m in r.json().get("models", []) if m.get("name")]
        except Exception:
            return []

    def ensure_model(self, model: str, on_progress=None) -> bool:
        # Downloading/pulling a model for Ollama is handled by the installer's
        # setup flow (installer.py step_pull_model), not the engine layer —
        # this just reports whether it's already available.
        return _oc.check_model_available(model)

    def generate(self, prompt: str, model: str, **kwargs) -> str:
        options = {
            "temperature": kwargs.get("temperature", 0.2),
            "num_predict": kwargs.get("max_tokens", 2000),
            "num_ctx": kwargs.get("num_ctx", _oc._NUM_CTX),
        }
        timeout = kwargs.get("timeout", 180)
        r = _oc._call_generate(model, prompt, options, timeout=timeout)
        r.raise_for_status()
        return _oc._strip_think_blocks(r.json().get("response", ""))

    def embed(self, texts: list[str], model: str) -> list[list[float]]:
        """Embed already-prepared texts.

        Contract note: `texts` arrive with the retrieval task prefix already
        applied and truncated to the model's limit (ollama_client does this,
        because the query-vs-document prefix differs per call site and only
        the caller knows which it is). Prefixing here as well would
        double-prefix and silently degrade recall, so this method must stay a
        thin passthrough — same as NativeEngine.embed().
        """
        if not texts:
            return []
        body: dict = {"model": model, "input": texts}
        if _oc._embed_on_cpu():
            body["options"] = {"num_gpu": 0}
        r = _oc._ollama_post(f"{_oc.OLLAMA_BASE}/api/embed", json=body, timeout=60)
        r.raise_for_status()
        return r.json().get("embeddings", [])
