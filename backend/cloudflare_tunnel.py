"""
Manages a Cloudflare Quick Tunnel for ConVX's MCP HTTP endpoint.

Downloads the cloudflared binary on first use (~40 MB, platform-specific).
Starts a Quick Tunnel pointing at http://localhost:<port> and parses the
assigned https://xxx.trycloudflare.com URL from process output.

No Cloudflare account required for Quick Tunnels. The URL changes on each
restart; users who want a stable URL can set a named tunnel token via
config.json::cf_tunnel_token or the CONVX_CF_TUNNEL_TOKEN env var.
"""

from __future__ import annotations

import logging
import os
import platform
import re
import subprocess
import threading
import urllib.request
from typing import Optional

_log = logging.getLogger("contextvolt.cloudflare_tunnel")

# ── Binary location ───────────────────────────────────────────────────────────

from backend.paths import cloudflared_dir as _cloudflared_dir
_BIN_DIR = str(_cloudflared_dir())


def _binary_url() -> str:
    system = platform.system().lower()
    machine = platform.machine().lower()
    base = "https://github.com/cloudflare/cloudflared/releases/latest/download"
    if system == "windows":
        return f"{base}/cloudflared-windows-amd64.exe"
    if system == "darwin":
        arch = "arm64" if ("arm" in machine or "aarch" in machine) else "amd64"
        return f"{base}/cloudflared-darwin-{arch}"
    # Linux
    arch = "arm64" if ("arm" in machine or "aarch" in machine) else "amd64"
    return f"{base}/cloudflared-linux-{arch}"


def _binary_path() -> str:
    name = "cloudflared.exe" if platform.system() == "Windows" else "cloudflared"
    return os.path.join(_BIN_DIR, name)


def _ensure_binary() -> str:
    """Return the path to the cloudflared binary, downloading if absent."""
    path = _binary_path()
    if os.path.isfile(path) and os.path.getsize(path) > 100_000:
        return path
    os.makedirs(_BIN_DIR, exist_ok=True)
    url = _binary_url()
    _log.info("Downloading cloudflared from %s …", url)
    tmp = path + ".tmp"
    try:
        urllib.request.urlretrieve(url, tmp)
        os.replace(tmp, path)
        if platform.system() != "Windows":
            os.chmod(path, 0o755)
        _log.info("cloudflared ready (%d bytes)", os.path.getsize(path))
    except Exception as exc:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise RuntimeError(f"cloudflared download failed: {exc}") from exc
    return path


# ── State ─────────────────────────────────────────────────────────────────────

STOPPED = "stopped"
DOWNLOADING = "downloading"
STARTING = "starting"
RUNNING = "running"
ERROR = "error"

_lock = threading.Lock()
_state: str = STOPPED
_tunnel_url: Optional[str] = None
_mcp_url: Optional[str] = None      # _tunnel_url + "/mcp"
_error_msg: Optional[str] = None
_proc: Optional[subprocess.Popen] = None
_active_port: int = 8000

_URL_RE = re.compile(r"https://[a-z0-9\-]+\.trycloudflare\.com", re.IGNORECASE)


def get_status() -> dict:
    with _lock:
        return {
            "status": _state,
            "tunnel_url": _tunnel_url,
            "mcp_url": _mcp_url,
            "error": _error_msg,
        }


def _set(state: str, *, url: Optional[str] = None, error: Optional[str] = None) -> None:
    global _state, _tunnel_url, _mcp_url, _error_msg
    _state = state
    if url is not None:
        _tunnel_url = url
        _mcp_url = url.rstrip("/") + "/mcp"
    if error is not None:
        _error_msg = error


# ── Reader thread ─────────────────────────────────────────────────────────────

def _reader(proc: subprocess.Popen, port: int) -> None:
    found = False
    try:
        for raw in proc.stderr:
            line = raw.decode("utf-8", errors="replace").strip()
            if not line:
                continue
            _log.debug("cloudflared: %s", line)
            if not found:
                m = _URL_RE.search(line)
                if m:
                    found = True
                    url = m.group(0)
                    with _lock:
                        _set(RUNNING, url=url)
                    _log.info("Tunnel ready: %s -> http://localhost:%d", url, port)
    except Exception as exc:
        _log.warning("cloudflared reader error: %s", exc)
    finally:
        with _lock:
            if _state in (RUNNING, STARTING):
                _set(ERROR, error="tunnel process exited unexpectedly")


# ── Public API ────────────────────────────────────────────────────────────────

def start(port: int = 8000) -> None:
    """Start a Quick Tunnel (no-op if already running or starting)."""
    global _active_port
    with _lock:
        if _state in (RUNNING, STARTING, DOWNLOADING):
            return
        _set(DOWNLOADING)
        _active_port = port

    def _bg() -> None:
        global _proc
        try:
            with _lock:
                _set(DOWNLOADING)
            binary = _ensure_binary()

            # Support named tunnel token for stable URLs
            from backend.mcp_http import _read_config as _read_cfg
            cfg = _read_cfg()
            token = (
                cfg.get("cf_tunnel_token")
                or os.environ.get("CONVX_CF_TUNNEL_TOKEN", "")
            ).strip()

            if token:
                cmd = [binary, "tunnel", "--no-autoupdate", "run", "--token", token]
            else:
                cmd = [
                    binary, "tunnel", "--no-autoupdate",
                    "--url", f"http://localhost:{port}",
                ]

            with _lock:
                _set(STARTING)

            proc = subprocess.Popen(
                cmd,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.PIPE,
                stdin=subprocess.DEVNULL,
            )
            with _lock:
                _proc = proc

            _reader(proc, port)
        except Exception as exc:
            _log.error("Tunnel start failed: %s", exc)
            with _lock:
                _set(ERROR, error=str(exc))

    threading.Thread(target=_bg, daemon=True, name="cf-tunnel").start()


def stop() -> None:
    """Terminate the tunnel process and reset state."""
    global _proc, _tunnel_url, _mcp_url
    with _lock:
        proc = _proc
        _proc = None
        _tunnel_url = None
        _mcp_url = None
        _set(STOPPED)

    if proc:
        try:
            proc.terminate()
            proc.wait(timeout=5)
        except Exception:
            try:
                proc.kill()
            except Exception:
                pass
