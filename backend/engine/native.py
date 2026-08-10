"""
NativeEngine — in-process local inference via llama-cpp-python.

No subprocess, no HTTP, no companion app to install: GGUF models load
directly into this process. Model files live in backend.paths.native_models_dir()
and are downloaded from Hugging Face on first use.

Model keys reuse the existing Ollama-era names ("qwen2.5:3b",
"nomic-embed-text") so config.json / OLLAMA_MODEL / OLLAMA_EMBED_MODEL
values already in use keep working unchanged when a user switches
INFERENCE_BACKEND to "native".
"""

from __future__ import annotations

import logging
import os
import re
import tempfile
import urllib.request
from pathlib import Path

from backend.paths import native_models_dir

_log = logging.getLogger("contextvolt")

# model key -> (HF repo, filename, kind). "kind" picks embedding=True at load time.
MODEL_REGISTRY: dict[str, dict] = {
    "qwen2.5:3b": {
        "repo": "Qwen/Qwen2.5-3B-Instruct-GGUF",
        "filename": "qwen2.5-3b-instruct-q4_k_m.gguf",
        "kind": "chat",
    },
    "nomic-embed-text": {
        "repo": "nomic-ai/nomic-embed-text-v1.5-GGUF",
        "filename": "nomic-embed-text-v1.5.Q4_K_M.gguf",
        "kind": "embed",
    },
}

_THINK_BLOCK_RE = re.compile(r"<think>[\s\S]*?</think>\s*", re.IGNORECASE)

# Loaded Llama instances, keyed by (model_path, n_gpu_layers) — reload is
# expensive (seconds), so keep resident models across calls within one process.
_loaded: dict[tuple[str, int], object] = {}


def _model_path(model: str) -> Path | None:
    entry = MODEL_REGISTRY.get(model)
    filename = entry["filename"] if entry else f"{model}.gguf"
    path = native_models_dir() / filename
    return path if path.exists() else None


def _gpu_layers() -> int:
    """-1 offloads every layer to GPU; 0 keeps inference on CPU."""
    try:
        from backend.gpu_info import has_nvidia
        return -1 if has_nvidia() else 0
    except Exception:
        return 0


def _load(model: str, embedding: bool) -> object:
    entry = MODEL_REGISTRY.get(model)
    filename = entry["filename"] if entry else f"{model}.gguf"
    path = native_models_dir() / filename
    if not path.exists():
        raise FileNotFoundError(f"Model not downloaded: {model} (expected {path})")

    n_gpu_layers = 0 if embedding else _gpu_layers()
    key = (str(path), n_gpu_layers)
    if key not in _loaded:
        from llama_cpp import Llama
        _log.info("Loading native model %s (gpu_layers=%d, embedding=%s)", path.name, n_gpu_layers, embedding)
        _loaded[key] = Llama(
            model_path=str(path),
            n_gpu_layers=n_gpu_layers,
            n_ctx=int(os.getenv("OLLAMA_NUM_CTX", "32768")),
            embedding=embedding,
            verbose=False,
        )
    return _loaded[key]


class NativeEngine:
    """InferenceEngine implementation backed by an in-process llama.cpp model."""

    def is_ready(self) -> bool:
        try:
            import llama_cpp  # noqa: F401
        except Exception:
            return False
        return any(native_models_dir().glob("*.gguf"))

    def list_models(self) -> list[str]:
        try:
            return sorted(p.stem for p in native_models_dir().glob("*.gguf"))
        except Exception:
            return []

    def ensure_model(self, model: str) -> bool:
        if _model_path(model) is not None:
            return True
        entry = MODEL_REGISTRY.get(model)
        if not entry:
            _log.warning("No download source registered for native model %r", model)
            return False

        native_models_dir().mkdir(parents=True, exist_ok=True)
        dest = native_models_dir() / entry["filename"]
        url = f"https://huggingface.co/{entry['repo']}/resolve/main/{entry['filename']}"
        _log.info("Downloading native model %s from %s", model, url)

        last_pct = -1

        def _report(block_num: int, block_size: int, total_size: int) -> None:
            nonlocal last_pct
            if total_size <= 0:
                return
            pct = min(100, block_num * block_size * 100 // total_size)
            if pct >= last_pct + 10 or pct == 100:
                last_pct = pct
                _log.info("  Downloading %s... %d%%", entry["filename"], pct)

        tmp_fd, tmp_path = tempfile.mkstemp(dir=str(native_models_dir()), suffix=".part")
        os.close(tmp_fd)
        try:
            urllib.request.urlretrieve(url, tmp_path, reporthook=_report)
            os.replace(tmp_path, dest)
            return True
        except Exception as e:
            _log.warning("Failed to download native model %r: %s", model, e)
            try:
                os.unlink(tmp_path)
            except Exception:
                pass
            return False

    def generate(self, prompt: str, model: str, **kwargs) -> str:
        llm = _load(model, embedding=False)
        result = llm(
            prompt,
            max_tokens=kwargs.get("max_tokens", 2000),
            temperature=kwargs.get("temperature", 0.2),
            stop=kwargs.get("stop") or [],
        )
        text = result["choices"][0]["text"]
        return _THINK_BLOCK_RE.sub("", text).strip()

    def embed(self, texts: list[str], model: str) -> list[list[float]]:
        if not texts:
            return []
        llm = _load(model, embedding=True)
        result = llm.embed(texts, normalize=True)
        # llama-cpp-python returns a flat list[float] for single input, list[list[float]] for batches.
        if texts and result and isinstance(result[0], float):
            return [result]
        return result
