"""
Optional CUDA acceleration for the native engine.

The default install ships the CPU-only llama-cpp-python wheel, because the
CUDA build is very large (~900 MB for ggml-cuda.dll alone, plus ~630 MB of
NVIDIA runtime DLLs) and useless without an NVIDIA GPU. Users who do have one
get roughly a 10x speedup, so we offer the upgrade instead of forcing the
download on everyone:

    CPU  qwen2.5-1.5b Q4_K_M ->  10.1 tok/s
    GPU  same model, RTX 3050 -> 97.8 tok/s

The CUDA wheel links against cudart/cublas/nvrtc, which it does NOT bundle.
Rather than making users install the multi-GB NVIDIA CUDA Toolkit, we pull
those DLLs from NVIDIA's own PyPI wheels and put them on PATH at import time
(see native._prepare_cuda_dll_path).
"""

from __future__ import annotations

import logging
import subprocess
import sys

_log = logging.getLogger("contextvolt")

CUDA_WHEEL_INDEX = "https://abetlen.github.io/llama-cpp-python/whl/cu124"
# Pinned to the same version as the CPU wheel in requirements.txt so switching
# builds never also changes llama-cpp-python's behaviour.
LLAMA_CPP_VERSION = "0.3.34"
# cu12 runtime DLLs the CUDA build needs: cudart64_12, cublas64_12/cublasLt64_12,
# and nvrtc (llama.cpp JIT-compiles some kernels).
CUDA_RUNTIME_PACKAGES = [
    "nvidia-cuda-runtime-cu12",
    "nvidia-cublas-cu12",
    "nvidia-cuda-nvrtc-cu12",
]
# Roughly what the user is committing to downloading; surfaced in the UI so the
# choice is informed rather than a surprise 1.5 GB.
APPROX_DOWNLOAD_MB = 1550


def gpu_upgrade_available() -> bool:
    """True when this machine would benefit: NVIDIA present, CUDA not yet active."""
    try:
        from backend.gpu_info import has_nvidia
        if not has_nvidia():
            return False
        from backend.engine.native import gpu_available
        return not gpu_available()
    except Exception:
        return False


def install_cuda_support(on_progress=None) -> tuple[bool, str]:
    """Replace the CPU llama-cpp-python wheel with the CUDA build + runtime DLLs.

    Returns (ok, message). Never raises — a failed GPU upgrade must leave the
    working CPU install alone rather than break inference entirely, so the
    CUDA wheel is installed only after the runtime DLLs are already in place.
    """
    def emit(msg: str) -> None:
        _log.info(msg)
        if on_progress:
            on_progress(msg)

    def pip(args: list[str]) -> tuple[int, str]:
        cmd = [sys.executable, "-m", "pip", "install", "--disable-pip-version-check", *args]
        kwargs: dict = {"capture_output": True, "text": True}
        if sys.platform == "win32":
            kwargs["creationflags"] = subprocess.CREATE_NO_WINDOW
        p = subprocess.run(cmd, **kwargs)
        return p.returncode, (p.stderr or p.stdout or "")[-400:]

    emit(f"  Installing CUDA runtime (~{APPROX_DOWNLOAD_MB} MB, one time)...")
    rc, err = pip(CUDA_RUNTIME_PACKAGES)
    if rc != 0:
        return False, f"CUDA runtime install failed: {err[:200]}"

    emit("  Installing GPU build of the inference engine...")
    rc, err = pip([
        f"llama-cpp-python=={LLAMA_CPP_VERSION}",
        "--force-reinstall", "--no-deps",
        "--extra-index-url", CUDA_WHEEL_INDEX,
    ])
    if rc != 0:
        return False, f"CUDA engine install failed: {err[:200]}"

    emit("  GPU support installed — restart ContextVolt to use it.")
    return True, "GPU support installed. Restart ContextVolt to enable it."


def uninstall_cuda_support() -> tuple[bool, str]:
    """Fall back to the CPU wheel (for when a GPU install misbehaves)."""
    cmd = [
        sys.executable, "-m", "pip", "install", "--disable-pip-version-check",
        f"llama-cpp-python=={LLAMA_CPP_VERSION}", "--force-reinstall", "--no-deps",
        "--extra-index-url", "https://abetlen.github.io/llama-cpp-python/whl/cpu",
    ]
    kwargs: dict = {"capture_output": True, "text": True}
    if sys.platform == "win32":
        kwargs["creationflags"] = subprocess.CREATE_NO_WINDOW
    p = subprocess.run(cmd, **kwargs)
    if p.returncode != 0:
        return False, (p.stderr or "")[-200:]
    return True, "Reverted to the CPU engine. Restart ContextVolt."
