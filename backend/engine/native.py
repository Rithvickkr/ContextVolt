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
import sys
import tempfile
import threading
import time
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
    "qwen3:4b": {
        "repo": "bartowski/Qwen_Qwen3-4B-GGUF",
        "filename": "Qwen_Qwen3-4B-Q4_K_M.gguf",
        "kind": "chat",
        "n_ctx": int(os.getenv("OLLAMA_NUM_CTX", "32768")),
    },
    "qwen2.5:3b": {
        "repo": "Qwen/Qwen2.5-3B-Instruct-GGUF",
        "filename": "qwen2.5-3b-instruct-q4_k_m.gguf",
        "kind": "chat",
        "n_ctx": int(os.getenv("OLLAMA_NUM_CTX", "32768")),
    },
    "qwen2.5:1.5b": {
        "repo": "Qwen/Qwen2.5-1.5B-Instruct-GGUF",
        "filename": "qwen2.5-1.5b-instruct-q4_k_m.gguf",
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
    "mxbai-embed-large": {
        "repo": "ChristianAzinn/mxbai-embed-large-v1-gguf",
        "filename": "mxbai-embed-large-v1.Q4_K_M.gguf",
        "kind": "embed",
        "n_ctx": 512,
    },
    "nomic-embed-text": {
        "repo": "nomic-ai/nomic-embed-text-v1.5-GGUF",
        "filename": "nomic-embed-text-v1.5.Q4_K_M.gguf",
        "kind": "embed",
        "n_ctx": 2048,
    },
    "nomic-embed-text:v1.5": {
        "repo": "nomic-ai/nomic-embed-text-v1.5-GGUF",
        "filename": "nomic-embed-text-v1.5.Q4_K_M.gguf",
        "kind": "embed",
        "n_ctx": 2048,
    },
    "bge-m3": {
        "repo": "gpustack/bge-m3-GGUF",
        "filename": "bge-m3-Q4_K_M.gguf",
        "kind": "embed",
        "n_ctx": 8192,
    },
}

# Models offered by installer.py's AVAILABLE_MODELS that don't have a GGUF
# entry above yet — ensure_model() returns False for these today (installer
# falls back to reporting the failure, doesn't crash).
# TODO: qwen2.5:7b — its Q4_K_M quant ships as two split GGUF files
# (-00001-of-00002 / -00002-of-00002); ensure_model() only fetches one file
# per model today, needs multi-part download support first.

_THINK_BLOCK_RE = re.compile(r"<think>[\s\S]*?</think>\s*", re.IGNORECASE)

# ── Loaded-model cache ────────────────────────────────────────────────
# Reloading a multi-GB GGUF costs seconds, so instances stay resident. Two
# invariants this cache has to hold, both of which bite hard if ignored:
#
#  1. THREAD SAFETY. A llama_cpp.Llama instance is NOT safe to call from two
#     threads at once — it mutates one shared llama_context. ContextVolt
#     absolutely does this: capture summarizes on a background thread while
#     the user searches (embeds) from a request thread. Every inference call
#     therefore runs under that instance's own lock.
#  2. BOUNDED MEMORY. One chat model (~2 GB) + one embed model is fine;
#     silently keeping every model the user has ever selected resident is
#     not. Loading a new model of a kind evicts the previous one of that kind.
#     Eviction only drops the dict reference — a call already in flight holds
#     its own reference, so the instance stays alive until that call returns.
_loaded: dict[str, object] = {}          # cache key -> Llama
_model_locks: dict[str, threading.Lock] = {}   # cache key -> per-instance lock
_cache_lock = threading.Lock()           # guards _loaded / _model_locks

# Models with a download in flight. The setup screen polls readiness every 2s
# and fires /api/setup/pull-model whenever the model is missing, so without
# this guard a single missing model spawns a new thread — and a new full
# multi-GB HTTP download — every couple of seconds until it finishes.
_downloading: set[str] = set()
_downloading_lock = threading.Lock()


def _model_path(model: str) -> Path | None:
    entry = MODEL_REGISTRY.get(model)
    filename = entry["filename"] if entry else f"{model}.gguf"
    path = native_models_dir() / filename
    return path if path.exists() else None


# A .part older than this is from a download that died (crash, kill, network
# drop) rather than one in flight, so it's safe to reclaim the disk.
_STALE_PART_AGE_S = 6 * 60 * 60


def _purge_stale_parts() -> None:
    """Delete abandoned *.part temp files. Multi-GB each — without this a few
    interrupted downloads quietly eat tens of gigabytes."""
    try:
        now = time.time()
        for p in native_models_dir().glob("*.part"):
            try:
                if now - p.stat().st_mtime > _STALE_PART_AGE_S:
                    p.unlink()
                    _log.info("Removed stale partial download %s", p.name)
            except Exception:
                pass
    except Exception:
        pass


_cuda_path_ready = False


def _prepare_cuda_dll_path() -> None:
    """Put the pip-installed CUDA runtime DLLs on the DLL search path.

    MUST run before `import llama_cpp`. The CUDA build of llama-cpp-python
    links against cudart/cublas/nvrtc, which its wheel does NOT bundle; we
    install them as the `nvidia-*-cu12` wheels instead of making users install
    the multi-GB CUDA Toolkit.

    Why PATH and not os.add_dll_directory(): llama_cpp loads llama.dll with an
    explicit `winmode=RTLD_GLOBAL`. Passing winmode makes CPython call
    LoadLibraryExW with exactly those flags, dropping the
    LOAD_LIBRARY_SEARCH_USER_DIRS flag that makes add_dll_directory() apply —
    so directories registered that way are silently ignored and the load fails
    with a bare "could not find module". The legacy PATH search order is still
    honoured under those flags, so PATH is what actually works here. (Verified
    both ways on an RTX 3050: add_dll_directory -> import fails; PATH -> import
    succeeds and the GPU is detected.)

    No-op on non-Windows and when the packages aren't installed (CPU build).
    """
    global _cuda_path_ready
    if _cuda_path_ready or os.name != "nt":
        return
    _cuda_path_ready = True
    try:
        import glob
        roots: list[str] = []
        # Primary: ask the installed `nvidia` namespace package where it lives.
        # Works under the embedded Python used by the packaged build, where
        # site.getsitepackages() is unreliable (and absent in some embeds).
        try:
            import nvidia  # type: ignore
            for base in list(getattr(nvidia, "__path__", [])):
                roots.extend(glob.glob(os.path.join(base, "*", "bin")))
        except Exception:
            pass
        if not roots:
            import site
            bases = []
            try:
                bases.extend(site.getsitepackages())
            except Exception:
                pass
            try:
                bases.append(site.getusersitepackages())
            except Exception:
                pass
            bases.append(os.path.join(sys.prefix, "Lib", "site-packages"))
            for base in set(bases):
                roots.extend(glob.glob(os.path.join(base, "nvidia", "*", "bin")))
        if not roots:
            return
        existing = os.environ.get("PATH", "")
        missing = [d for d in roots if d not in existing]
        if missing:
            os.environ["PATH"] = os.pathsep.join(missing) + os.pathsep + existing
            _log.info("Added %d CUDA runtime dir(s) to PATH for llama.cpp", len(missing))
    except Exception as e:
        _log.debug("CUDA DLL path setup skipped: %s", e)


def gpu_available() -> bool:
    """True when the installed llama_cpp build can actually offload to a GPU.

    Checks the *build*, not just whether an NVIDIA card exists: the default
    packaged wheel is CPU-only, so a GPU machine still reports False until the
    CUDA variant is installed. Claiming acceleration that isn't there would be
    misleading, and asking a CPU-only build for GPU layers silently no-ops.
    """
    try:
        _prepare_cuda_dll_path()
        import llama_cpp
        if not llama_cpp.llama_supports_gpu_offload():
            return False
        from backend.gpu_info import has_nvidia
        return bool(has_nvidia())
    except Exception:
        return False


def _gpu_layer_ladder() -> list[int]:
    """GPU offload attempts, most-accelerated first, always ending at CPU.

    -1 means "every layer on the GPU". That's ideal but not always possible:
    this laptop's RTX 3050 has 4 GB, which holds a 3B Q4 model fine but not a
    7B one, and llama.cpp errors out rather than degrading when the weights
    don't fit. So fall back to partial offload, then to pure CPU, instead of
    failing the request — the same shape as the Ollama path's context ladder.
    """
    if not gpu_available():
        return [0]
    try:
        from backend.gpu_info import detect_gpu
        vram_mb = detect_gpu().get("vram_mb") or 0
    except Exception:
        vram_mb = 0
    if vram_mb and vram_mb < 6000:
        # Small card: don't even try full offload for larger models — start
        # partial so the common case doesn't pay a failed load first.
        return [-1, 20, 10, 0]
    return [-1, 20, 0]


def _model_n_ctx(model: str, embedding: bool) -> int:
    entry = MODEL_REGISTRY.get(model)
    if entry:
        return int(entry["n_ctx"])
    return 2048 if embedding else int(os.getenv("OLLAMA_NUM_CTX", "32768"))


def _load(model: str, embedding: bool) -> tuple[object, threading.Lock, int]:
    """Return (llama_instance, its_lock, n_ctx).

    Callers MUST hold the returned lock for the duration of any inference
    call on the instance — see the cache invariants above.
    """
    entry = MODEL_REGISTRY.get(model)
    filename = entry["filename"] if entry else f"{model}.gguf"
    n_ctx = _model_n_ctx(model, embedding)
    path = native_models_dir() / filename
    if not path.exists():
        raise FileNotFoundError(f"Model not downloaded: {model} (expected {path})")

    kind = "embed" if embedding else "chat"
    # Embeddings stay on CPU: they're small and fast there, and on a 4 GB card
    # co-loading them would evict the chat model's weights. This also matches
    # the existing "Run embeddings on CPU" setting the Ollama path honours.
    ladder = [0] if embedding else _gpu_layer_ladder()
    key = f"{kind}|{path}"

    with _cache_lock:
        cached = _loaded.get(key)
        if cached is not None:
            return cached, _model_locks[key], n_ctx

        _prepare_cuda_dll_path()
        from llama_cpp import Llama

        llm = None
        last_err: Exception | None = None
        for n_gpu_layers in ladder:
            kwargs: dict = {
                "model_path": str(path),
                "n_gpu_layers": n_gpu_layers,
                "n_ctx": n_ctx,
                "embedding": embedding,
                "verbose": False,
            }
            if embedding:
                # Embedding models pool over the whole sequence, so a batch
                # smaller than the input silently drops tokens (or errors).
                # Keep n_batch at the context size, but cap it — a 32k-token
                # batch for qwen3-embedding costs far more memory than we need.
                kwargs["n_batch"] = min(n_ctx, 4096)
            try:
                _log.info(
                    "Loading native model %s (kind=%s, gpu_layers=%d, n_ctx=%d)",
                    path.name, kind, n_gpu_layers, n_ctx,
                )
                llm = Llama(**kwargs)
                break
            except Exception as e:
                last_err = e
                _log.warning(
                    "Load failed at gpu_layers=%d (%s) — trying next tier",
                    n_gpu_layers, str(e)[:120],
                )
        if llm is None:
            raise RuntimeError(f"Could not load model {model}: {last_err}")

        # Evict the previous model of this kind (bounded memory).
        for stale in [k for k in _loaded if k.startswith(f"{kind}|") and k != key]:
            _log.info("Evicting cached native model %s", stale.split("|", 1)[1])
            _loaded.pop(stale, None)
            _model_locks.pop(stale, None)

        _loaded[key] = llm
        _model_locks[key] = threading.Lock()
        return llm, _model_locks[key], n_ctx


def _fit_to_context(llm, prompt: str, reserve_tokens: int, n_ctx: int) -> str:
    """Shrink `prompt` so prompt + reserve_tokens fits inside n_ctx.

    llama.cpp raises when a prompt exceeds the context window; the Ollama path
    never had to care because _call_generate() retries down a ladder of smaller
    contexts server-side. Here the exception would surface inside _synthesize's
    broad `except`, which returns an EMPTY summary — a silent quality failure
    rather than a visible error. So clamp proactively.

    The middle is what gets dropped: our prompts carry the task instructions at
    the top AND the required output format at the bottom, so trimming either end
    breaks the response format.
    """
    budget = n_ctx - reserve_tokens - 16  # 16: BOS/EOS + template slack
    if budget <= 64:
        budget = max(64, n_ctx // 2)
    try:
        toks = llm.tokenize(prompt.encode("utf-8", "ignore"), special=True)
    except Exception:
        return prompt  # tokenizer unavailable — let the caller's guard handle it
    if len(toks) <= budget:
        return prompt

    marker = "\n\n…[content truncated to fit the model's context window]…\n\n"
    try:
        marker_len = len(llm.tokenize(marker.encode("utf-8"), special=False))
    except Exception:
        marker_len = 16
    keep = max(32, budget - marker_len)
    head_n = keep // 2
    tail_n = keep - head_n
    try:
        head = llm.detokenize(toks[:head_n]).decode("utf-8", "ignore")
        tail = llm.detokenize(toks[-tail_n:]).decode("utf-8", "ignore")
    except Exception:
        # Fall back to a proportional character cut.
        ratio = budget / max(1, len(toks))
        cut = max(64, int(len(prompt) * ratio * 0.9))
        head, tail = prompt[: cut // 2], prompt[-(cut // 2):]
    _log.warning(
        "Native prompt %d tokens > budget %d (n_ctx=%d) — truncated middle",
        len(toks), budget, n_ctx,
    )
    return head + marker + tail


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
        with _cache_lock:
            for key in [k for k in _loaded if k.split("|", 1)[1] == str(path)]:
                _loaded.pop(key, None)
                _model_locks.pop(key, None)
        import gc
        gc.collect()  # drop the mmap before unlink, or Windows refuses
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

        with _downloading_lock:
            if model in _downloading:
                _log.debug("Download of %s already in progress — skipping duplicate", model)
                return False
            _downloading.add(model)
        try:
            return self._download(model, entry, _emit)
        finally:
            with _downloading_lock:
                _downloading.discard(model)

    def _download(self, model: str, entry: dict, _emit) -> bool:
        _purge_stale_parts()
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

        # Same guard as ensure_model(): the setup screen's auto-pull and a user
        # clicking Download in Settings can otherwise fetch the same multi-GB
        # file twice at once, racing on os.replace at the end.
        with _downloading_lock:
            if model in _downloading:
                yield {"status": "error", "error": f"{model} is already downloading"}
                return
            _downloading.add(model)

        import requests
        _purge_stale_parts()
        native_models_dir().mkdir(parents=True, exist_ok=True)
        dest = native_models_dir() / entry["filename"]
        url = f"https://huggingface.co/{entry['repo']}/resolve/main/{entry['filename']}"

        tmp_fd, tmp_path = tempfile.mkstemp(dir=str(native_models_dir()), suffix=".part")
        ok = False
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
            ok = True
            yield {"status": "success"}
        except Exception as e:
            yield {"status": "error", "error": str(e)[:200]}
        finally:
            # `finally`, not just `except Exception`: if the HTTP client hangs up
            # mid-download the consumer abandons this generator, which raises
            # GeneratorExit at the yield — a BaseException that `except
            # Exception` does NOT catch, orphaning a multi-GB .part file.
            if not ok:
                try:
                    os.unlink(tmp_path)
                except Exception:
                    pass
            with _downloading_lock:
                _downloading.discard(model)

    def generate(self, prompt: str, model: str, **kwargs) -> str:
        """Single-shot completion.

        `timeout` is accepted and ignored: inference runs in-process, so there
        is no socket to time out. Callers share a signature with the Ollama
        engine, which does use it.
        """
        llm, lock, n_ctx = _load(model, embedding=False)
        max_tokens = kwargs.get("max_tokens", 2000)
        with lock:
            prompt = _fit_to_context(llm, prompt, max_tokens, n_ctx)
            result = llm(
                prompt,
                max_tokens=max_tokens,
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
        llm, lock, n_ctx = _load(model, embedding=False)
        max_tokens = kwargs.get("max_tokens", 2000)
        in_think = False
        pending = ""
        # Held for the whole generator: the instance is single-threaded, so the
        # lock can only be released once the last token has been pulled. try/
        # finally (not `with`) so an abandoned generator still releases it —
        # GeneratorExit would otherwise leave the model locked forever.
        lock.acquire()
        try:
            prompt = _fit_to_context(llm, prompt, max_tokens, n_ctx)
            stream = llm(
                prompt,
                max_tokens=max_tokens,
                temperature=kwargs.get("temperature", 0.2),
                stop=kwargs.get("stop") or [],
                stream=True,
            )
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
        finally:
            lock.release()

    def embed(self, texts: list[str], model: str) -> list[list[float]]:
        if not texts:
            return []
        llm, lock, _n_ctx = _load(model, embedding=True)
        with lock:
            # truncate=True lets llama.cpp clamp anything still over the context
            # window; callers already trim by _get_embed_max_chars, this is the
            # backstop so one oversized chunk can't fail a whole batch.
            result = llm.embed(texts, normalize=True, truncate=True)
        # llama-cpp-python returns a flat list[float] for single input, list[list[float]] for batches.
        if result and isinstance(result[0], float):
            return [result]
        return result
