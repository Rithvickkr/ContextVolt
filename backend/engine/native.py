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

# model key -> (HF repo, filename, kind, n_ctx). "kind" picks embedding=True
# at load time; "n_ctx" is this model's own trained/supported context — do
# NOT default embedding models to the chat context size, llama.cpp will
# warn ("n_ctx_seq > n_ctx_train") and may misbehave near the limit.
MODEL_REGISTRY: dict[str, dict] = {
    # Chat — "llama3.2:3b" is AVAILABLE_MODELS' recommended default in installer.py.
    "llama3.2:3b": {
        "repo": "bartowski/Llama-3.2-3B-Instruct-GGUF",
        "filename": "Llama-3.2-3B-Instruct-Q4_K_M.gguf",
        "kind": "chat",
        "n_ctx": int(os.getenv("OLLAMA_NUM_CTX", "32768")),
    },
    "qwen2.5:3b": {
        "repo": "Qwen/Qwen2.5-3B-Instruct-GGUF",
        "filename": "qwen2.5-3b-instruct-q4_k_m.gguf",
        "kind": "chat",
        "n_ctx": int(os.getenv("OLLAMA_NUM_CTX", "32768")),
    },
    # Embed — "qwen3-embedding:0.6b" is AVAILABLE_EMBED_MODELS' recommended default.
    "qwen3-embedding:0.6b": {
        "repo": "Qwen/Qwen3-Embedding-0.6B-GGUF",
        "filename": "Qwen3-Embedding-0.6B-Q8_0.gguf",
        "kind": "embed",
        "n_ctx": 32768,
    },
    "nomic-embed-text": {
        "repo": "nomic-ai/nomic-embed-text-v1.5-GGUF",
        "filename": "nomic-embed-text-v1.5.Q4_K_M.gguf",
        "kind": "embed",
        "n_ctx": 2048,
    },
}

# Models offered by installer.py's AVAILABLE_MODELS / AVAILABLE_EMBED_MODELS
# that don't have a GGUF entry above yet — ensure_model() returns False for
# these today (installer falls back to reporting the failure, doesn't crash).
# TODO: qwen3:4b, qwen2.5:7b, qwen2.5:1.5b, mxbai-embed-large,
#       nomic-embed-text:v1.5, bge-m3.

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
    """-1 offloads every layer to GPU; 0 keeps inference on CPU.

    Checks the *installed llama_cpp build*, not just whether an NVIDIA GPU
    is present — today's packaged wheel is CPU-only (see requirements.txt),
    so llama_supports_gpu_offload() is False even on a GPU machine. Asking
    for GPU layers on a CPU-only build is harmless (llama.cpp ignores it and
    runs on CPU), but claiming acceleration that isn't there is misleading —
    this makes "no GPU wheel yet" explicit instead of silently no-op'ing.
    A CUDA-enabled wheel needs no other code change here — but note the CUDA
    wheel is NOT a drop-in "swap the index URL" fix (tested against
    abetlen.github.io/llama-cpp-python/whl/cu121 on this machine's RTX 3050):
    it installs but its llama.dll fails to load with a missing-dependency
    error, because it links against CUDA runtime DLLs (cudart/cublas) that
    the wheel does NOT bundle and this machine doesn't have installed
    separately. Shipping GPU support means either (a) bundling those
    redistributable DLLs alongside the wheel in the installer build, or
    (b) requiring users to install the NVIDIA CUDA Toolkit themselves —
    (a) is the only realistic option for a consumer installer.
    """
    try:
        import llama_cpp
        if not llama_cpp.llama_supports_gpu_offload():
            return 0
        from backend.gpu_info import has_nvidia
        return -1 if has_nvidia() else 0
    except Exception:
        return 0


def _load(model: str, embedding: bool) -> object:
    entry = MODEL_REGISTRY.get(model)
    filename = entry["filename"] if entry else f"{model}.gguf"
    n_ctx = entry["n_ctx"] if entry else (2048 if embedding else int(os.getenv("OLLAMA_NUM_CTX", "32768")))
    path = native_models_dir() / filename
    if not path.exists():
        raise FileNotFoundError(f"Model not downloaded: {model} (expected {path})")

    n_gpu_layers = 0 if embedding else _gpu_layers()
    key = (str(path), n_gpu_layers)
    if key not in _loaded:
        from llama_cpp import Llama
        _log.info("Loading native model %s (gpu_layers=%d, n_ctx=%d, embedding=%s)", path.name, n_gpu_layers, n_ctx, embedding)
        _loaded[key] = Llama(
            model_path=str(path),
            n_gpu_layers=n_gpu_layers,
            n_ctx=n_ctx,
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
        """Model keys present on disk, using the same identifiers as config.json
        / the Ollama backend (e.g. "llama3.2:3b"), not raw GGUF filenames —
        callers compare these against model ids picked in Settings."""
        try:
            present = {p.name for p in native_models_dir().glob("*.gguf")}
        except Exception:
            return []
        found = [key for key, entry in MODEL_REGISTRY.items() if entry["filename"] in present]
        registered_files = {entry["filename"] for entry in MODEL_REGISTRY.values()}
        unregistered = [p.stem for p in native_models_dir().glob("*.gguf") if p.name not in registered_files]
        return sorted(found + unregistered)

    def delete_model(self, model: str) -> bool:
        """Remove `model`'s GGUF file from disk. Evicts it from the loaded-model
        cache first — on Windows, deleting a file still mmap'd by a live Llama
        instance (the default) raises PermissionError."""
        path = _model_path(model)
        if path is None:
            return False
        for key in [k for k in _loaded if k[0] == str(path)]:
            del _loaded[key]
        try:
            path.unlink()
            return True
        except Exception as e:
            _log.warning("Failed to delete native model %r: %s", model, e)
            return False

    def ensure_model(self, model: str, on_progress=None) -> bool:
        """Download `model`'s GGUF file if not already present.

        `on_progress`, if given, is called with a human-readable status line
        for each ~10% step (e.g. for wiring into installer.py's state.log UI).
        Always also logged to the app logger regardless of `on_progress`.
        """
        def _emit(msg: str) -> None:
            _log.info(msg)
            if on_progress:
                on_progress(msg)

        if _model_path(model) is not None:
            return True
        entry = MODEL_REGISTRY.get(model)
        if not entry:
            _log.warning("No download source registered for native model %r", model)
            return False

        native_models_dir().mkdir(parents=True, exist_ok=True)
        dest = native_models_dir() / entry["filename"]
        url = f"https://huggingface.co/{entry['repo']}/resolve/main/{entry['filename']}"
        _emit(f"Downloading {model} from Hugging Face...")

        last_pct = -1

        def _report(block_num: int, block_size: int, total_size: int) -> None:
            nonlocal last_pct
            if total_size <= 0:
                return
            pct = min(100, block_num * block_size * 100 // total_size)
            if pct >= last_pct + 10 or pct == 100:
                last_pct = pct
                mb = block_num * block_size / (1024 * 1024)
                total_mb = total_size / (1024 * 1024)
                _emit(f"  Downloading {entry['filename']}... {pct}% ({mb:.0f}/{total_mb:.0f} MB)")

        tmp_fd, tmp_path = tempfile.mkstemp(dir=str(native_models_dir()), suffix=".part")
        os.close(tmp_fd)
        try:
            urllib.request.urlretrieve(url, tmp_path, reporthook=_report)
            os.replace(tmp_path, dest)
            _emit(f"  {model} ready!")
            return True
        except Exception as e:
            _emit(f"  Download failed: {str(e)[:80]}")
            try:
                os.unlink(tmp_path)
            except Exception:
                pass
            return False

    def download_progress(self, model: str):
        """Yield {"status": "downloading", "completed": bytes, "total": bytes}
        while fetching `model`'s GGUF, then a final {"status": "success"} or
        {"status": "error", "error": str}. Byte-granular (unlike ensure_model's
        ~10%-step text log) for main.py's /api/setup/pull-model-stream, whose
        frontend consumer computes completed/total itself for a progress bar."""
        if _model_path(model) is not None:
            yield {"status": "success"}
            return
        entry = MODEL_REGISTRY.get(model)
        if not entry:
            yield {"status": "error", "error": f"No download source registered for {model!r}"}
            return

        import requests
        native_models_dir().mkdir(parents=True, exist_ok=True)
        dest = native_models_dir() / entry["filename"]
        url = f"https://huggingface.co/{entry['repo']}/resolve/main/{entry['filename']}"

        tmp_fd, tmp_path = tempfile.mkstemp(dir=str(native_models_dir()), suffix=".part")
        try:
            with os.fdopen(tmp_fd, "wb") as f:
                resp = requests.get(url, stream=True, timeout=60)
                resp.raise_for_status()
                total = int(resp.headers.get("content-length", 0))
                completed = 0
                for chunk in resp.iter_content(chunk_size=1024 * 1024):
                    if not chunk:
                        continue
                    f.write(chunk)
                    completed += len(chunk)
                    yield {"status": "downloading", "completed": completed, "total": total}
            os.replace(tmp_path, dest)
            yield {"status": "success"}
        except Exception as e:
            try:
                os.unlink(tmp_path)
            except Exception:
                pass
            yield {"status": "error", "error": str(e)[:200]}

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

    def generate_stream(self, prompt: str, model: str, **kwargs):
        """Yield text chunks as they're generated. Not part of InferenceEngine —
        an extra capability llm_router.py uses for streaming responses.

        Filters <think>...</think> the same way generate() does, but across
        chunk boundaries (a tag can straddle two chunks), buffering by holding
        back a short tail until each chunk is known not to end mid-tag.
        """
        llm = _load(model, embedding=False)
        stream = llm(
            prompt,
            max_tokens=kwargs.get("max_tokens", 2000),
            temperature=kwargs.get("temperature", 0.2),
            stop=kwargs.get("stop") or [],
            stream=True,
        )
        in_think = False
        pending = ""
        for chunk in stream:
            tok = chunk["choices"][0]["text"]
            if not tok:
                continue
            buf = pending + tok
            pending = ""
            out = []
            while buf:
                if in_think:
                    end = buf.find("</think>")
                    if end == -1:
                        pending = buf[-8:] if len(buf) > 8 else buf
                        buf = ""
                        break
                    buf = buf[end + len("</think>"):]
                    in_think = False
                else:
                    start = buf.find("<think>")
                    if start == -1:
                        if len(buf) > 7:
                            out.append(buf[:-7])
                            pending = buf[-7:]
                        else:
                            pending = buf
                        buf = ""
                        break
                    out.append(buf[:start])
                    buf = buf[start + len("<think>"):]
                    in_think = True
            if out:
                yield "".join(out)
        if pending and not in_think:
            yield pending

    def embed(self, texts: list[str], model: str) -> list[list[float]]:
        if not texts:
            return []
        llm = _load(model, embedding=True)
        result = llm.embed(texts, normalize=True)
        # llama-cpp-python returns a flat list[float] for single input, list[list[float]] for batches.
        if texts and result and isinstance(result[0], float):
            return [result]
        return result
