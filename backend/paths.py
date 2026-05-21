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
