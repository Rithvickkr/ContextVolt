"""
GPU / VRAM detection for VRAM-aware model recommendations.

Tries nvidia-smi first (most accurate), falls back to Windows WMI, then to
a "no GPU detected" result. Used by the setup wizard to recommend models
that fit the user's hardware instead of always defaulting to llama3.2:3b.
"""
from __future__ import annotations

import logging
import subprocess
import sys
from functools import lru_cache

_log = logging.getLogger("contextvolt.gpu_info")

_CREATE_NO_WINDOW = 0x08000000 if sys.platform == "win32" else 0


def _run(cmd: list[str], timeout: float = 4.0) -> str | None:
    try:
        r = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=timeout,
            creationflags=_CREATE_NO_WINDOW,
        )
        if r.returncode == 0:
            return r.stdout
    except (FileNotFoundError, subprocess.TimeoutExpired, OSError):
        return None
    except Exception as e:
        _log.debug("Command %s failed: %s", cmd[0], e)
    return None


def _try_nvidia_smi() -> tuple[str, int] | None:
    """Returns (gpu_name, vram_mb) for the largest NVIDIA GPU, or None."""
    out = _run(["nvidia-smi", "--query-gpu=name,memory.total", "--format=csv,noheader,nounits"])
    if not out:
        return None
    best: tuple[str, int] | None = None
    for line in out.strip().splitlines():
        parts = [p.strip() for p in line.split(",")]
        if len(parts) < 2:
            continue
        try:
            vram = int(parts[1])
        except ValueError:
            continue
        if best is None or vram > best[1]:
            best = (parts[0], vram)
    return best


def _try_windows_wmi() -> tuple[str, int] | None:
    """Fallback for systems without nvidia-smi (AMD/Intel GPUs, no NVIDIA driver)."""
    if sys.platform != "win32":
        return None
    # PowerShell CIM is more reliable than wmic (deprecated). AdapterRAM is capped
    # at ~4GB by Win32_VideoController, but it's the best we can get without vendor SDKs.
    ps_cmd = (
        "Get-CimInstance Win32_VideoController | "
        "Select-Object Name,AdapterRAM | "
        "ConvertTo-Json -Compress"
    )
    out = _run(["powershell", "-NoProfile", "-NonInteractive", "-Command", ps_cmd], timeout=6.0)
    if not out:
        return None
    import json as _json
    try:
        data = _json.loads(out)
    except Exception:
        return None
    if isinstance(data, dict):
        data = [data]
    best: tuple[str, int] | None = None
    for entry in data:
        name = (entry.get("Name") or "").strip()
        ram = entry.get("AdapterRAM") or 0
        if not isinstance(ram, (int, float)) or ram <= 0:
            continue
        vram_mb = int(ram) // (1024 * 1024)
        if vram_mb < 256:  # ignore weird virtual adapters
            continue
        if best is None or vram_mb > best[1]:
            best = (name, vram_mb)
    return best


@lru_cache(maxsize=1)
def detect_gpu() -> dict:
    """Detect the best GPU and its VRAM. Result is cached for the process lifetime."""
    info = _try_nvidia_smi()
    source = "nvidia-smi"
    if info is None:
        info = _try_windows_wmi()
        source = "wmi"
    if info is None:
        return {"detected": False, "name": None, "vram_mb": None, "source": None}
    name, vram_mb = info
    return {"detected": True, "name": name, "vram_mb": vram_mb, "source": source}


def _is_nvidia(gpu: dict) -> bool:
    """True if the detected GPU is an NVIDIA card."""
    return gpu.get("source") == "nvidia-smi" or "nvidia" in (gpu.get("name") or "").lower()


def has_nvidia() -> bool:
    """True if an NVIDIA GPU is present on this machine (cached via detect_gpu)."""
    return bool(_is_nvidia(detect_gpu()))


def nvidia_running_ollama() -> bool | None:
    """Whether an ollama process is currently computing on the NVIDIA GPU.

    Uses nvidia-smi's compute-app list — a version-independent signal that
    distinguishes "running on the NVIDIA card" from "running on the integrated
    GPU (via Vulkan)". Returns True/False, or None when nvidia-smi is
    unavailable (can't tell). Not cached — reflects live GPU state.
    """
    out = _run(["nvidia-smi", "--query-compute-apps=process_name", "--format=csv,noheader"])
    if out is None:
        return None
    return any("ollama" in line.lower() for line in out.splitlines())


# ── VRAM tiers ────────────────────────────────────────────────────────────────
# Peak GPU footprint of each pair when both are loaded simultaneously (Ollama
# loads weights + KV cache + compute graph). Numbers measured on RTX 3050 4GB
# during testing; conservative so we don't recommend a combo that evicts.
#
# tier name → (recommended_llm, recommended_embed, min_vram_mb)
_TIERS = [
    ("high",   "qwen3:4b",      "qwen3-embedding:0.6b", 8000),
    ("mid",    "llama3.2:3b",   "qwen3-embedding:0.6b", 6000),
    ("low",    "llama3.2:3b",   "nomic-embed-text",     5000),
    ("tight",  "qwen2.5:1.5b",  "nomic-embed-text",     0),     # <5GB or unknown
]


def recommend_models(vram_mb: int | None) -> dict:
    """Return the LLM+embed model pair best suited to this VRAM size."""
    if vram_mb is None:
        # Unknown GPU — recommend the conservative tier so we never propose
        # a combo that will evict on a small card.
        tier = _TIERS[-1]
        reason = "GPU not detected — recommending light models that run on any hardware."
    else:
        tier = next(t for t in _TIERS if vram_mb >= t[3])
        if tier[0] == "tight":
            reason = f"Your GPU has {vram_mb} MB VRAM. Recommending light models to avoid constant model reloads."
        elif tier[0] == "low":
            reason = f"Your GPU has {vram_mb} MB VRAM — enough for a 3B model with a small embedder."
        elif tier[0] == "mid":
            reason = f"Your GPU has {vram_mb} MB VRAM — comfortable for a 3B model with a 0.6B embedder."
        else:
            reason = f"Your GPU has {vram_mb} MB VRAM — plenty of headroom for a 4B model."
    return {
        "tier": tier[0],
        "llm": tier[1],
        "embed": tier[2],
        "reason": reason,
    }
