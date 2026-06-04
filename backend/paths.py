"""
ContextVolt — Cross-platform path resolution.

Single source of truth for where writable user data lives.

Windows behavior is preserved exactly: every helper returns a path next to the
project root (the same location used since v1). Mac and Linux redirect to the
platform-standard user data directory so a future signed/notarized .app or
read-only install location works without rewriting the source tree.

Read-only assets (frontend/, backend/, icon.ico, requirements.txt) always
resolve from PROJECT_ROOT — they ship with the app and are never written to.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

# Project root = parent of the backend package (works whether imported as
# `backend.paths` from run.py / installer.py or directly within backend/).
PROJECT_ROOT: Path = Path(__file__).resolve().parent.parent


# ---------------------------------------------------------------------------
# Server bind config — single source of truth for host/port.
#
# The app binds the first free port in PORT_CANDIDATES (preferring the one it
# used last, for stickiness). That bounded range is the contract: the browser
# extension probes the SAME range to discover the live backend, so the port
# can move without anyone editing files.
#
# CONVX_PORT pins the port explicitly (power users / scripted setups). When set,
# the app uses ONLY that port and errors if it's taken — no auto-fallback.
# ---------------------------------------------------------------------------
SERVER_HOST: str = os.environ.get("CONVX_HOST", "127.0.0.1")

# Candidate ports for auto-selection. Keep this small and in sync with the
# extension's PORT_CANDIDATES (extension/background.js).
PORT_CANDIDATES: list[int] = list(range(8000, 8010))  # 8000..8009

DEFAULT_PORT: int = PORT_CANDIDATES[0]

# Explicit pin via env, or None to enable auto-selection.
try:
    _env_port = os.environ.get("CONVX_PORT")
    EXPLICIT_PORT: int | None = int(_env_port) if _env_port else None
except ValueError:
    EXPLICIT_PORT = None

# Best-effort default used by import-time consumers before run.py has actually
# chosen a port. The authoritative runtime value lives in backend.main._active_port.
SERVER_PORT: int = EXPLICIT_PORT or DEFAULT_PORT


def server_origin(host: str | None = None, port: int | None = None) -> str:
    """Return the backend's own origin, e.g. 'http://127.0.0.1:8000'."""
    return f"http://{host or SERVER_HOST}:{port or SERVER_PORT}"


def last_port_path() -> Path:
    """Small file remembering the last successfully-bound port (stickiness)."""
    return user_data_dir() / ".last_port"


def read_last_port() -> int | None:
    """Return the last-bound port if recorded and within the candidate range."""
    try:
        port = int(last_port_path().read_text(encoding="utf-8").strip())
    except (OSError, ValueError):
        return None
    return port if port in PORT_CANDIDATES else None


def write_last_port(port: int) -> None:
    try:
        last_port_path().write_text(str(port), encoding="utf-8")
    except OSError:
        pass


def user_data_dir() -> Path:
    """Return the directory for writable per-user state.

    - Windows: PROJECT_ROOT (legacy — keeps existing installs untouched)
    - macOS:   ~/Library/Application Support/ContextVolt
    - Linux:   $XDG_DATA_HOME/ContextVolt or ~/.local/share/ContextVolt
    """
    if sys.platform == "win32":
        return PROJECT_ROOT
    if sys.platform == "darwin":
        path = Path.home() / "Library" / "Application Support" / "ContextVolt"
    else:
        xdg = os.environ.get("XDG_DATA_HOME")
        base = Path(xdg) if xdg else Path.home() / ".local" / "share"
        path = base / "ContextVolt"
    path.mkdir(parents=True, exist_ok=True)
    return path


def db_path() -> Path:
    return user_data_dir() / "context_volt.db"


def config_path() -> Path:
    return user_data_dir() / "config.json"


def log_path() -> Path:
    """Crash log for run.py / pythonw.exe (uncaught exceptions)."""
    return user_data_dir() / "cv_error.log"


def app_log_path() -> Path:
    """Application log for backend modules (ollama_client, main, etc)."""
    return user_data_dir() / "contextvolt.log"


def lock_path() -> Path:
    return user_data_dir() / ".cv_lock"


def installed_marker_path() -> Path:
    return user_data_dir() / ".installed"


def ollama_dir() -> Path:
    return user_data_dir() / ".ollama"


def ollama_models_dir() -> Path:
    return ollama_dir() / "models"


def cloudflared_dir() -> Path:
    return user_data_dir() / ".cloudflared"


def extension_guide_path() -> Path:
    """Where the personalized extension-install HTML guide is written.

    On Windows this is PROJECT_ROOT (legacy: same file as the template). On
    Mac/Linux it's the user data dir, since the bundle's Resources/ is
    read-only inside a signed .app.
    """
    return user_data_dir() / "extension_install_guide.html"
