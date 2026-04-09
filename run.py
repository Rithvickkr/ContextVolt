"""
ContextVolt — Application Entry Point.

Starts the FastAPI backend on a background thread, then opens a native
window via pywebview.
"""

import sys
import os
import threading
import time
import traceback
import logging

# Ensure project root is on the path
PROJECT_ROOT = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, PROJECT_ROOT)

# ─── Crash logging (pythonw.exe has no console) ──────────────────
_LOG_FILE = os.path.join(PROJECT_ROOT, "cv_error.log")
logging.basicConfig(
    filename=_LOG_FILE,
    level=logging.ERROR,
    format="%(asctime)s %(levelname)s %(message)s",
)

def _excepthook(exc_type, exc_value, exc_tb):
    logging.error("Unhandled exception:\n" + "".join(traceback.format_exception(exc_type, exc_value, exc_tb)))
    sys.__excepthook__(exc_type, exc_value, exc_tb)

sys.excepthook = _excepthook

# ─── Single instance enforcement ─────────────────────────────────
import atexit

_LOCK_FILE = os.path.join(PROJECT_ROOT, ".cv_lock")

def _pid_alive(pid: int) -> bool:
    """Non-destructive PID existence check — Windows-safe via OpenProcess."""
    if sys.platform == "win32":
        import ctypes
        SYNCHRONIZE = 0x00100000
        handle = ctypes.windll.kernel32.OpenProcess(SYNCHRONIZE, False, pid)
        if handle:
            ctypes.windll.kernel32.CloseHandle(handle)
            return True
        return False
    else:
        try:
            os.kill(pid, 0)
            return True
        except OSError:
            return False

def _acquire_lock() -> bool:
    if os.path.exists(_LOCK_FILE):
        try:
            with open(_LOCK_FILE) as f:
                pid = int(f.read().strip())
            if _pid_alive(pid):
                return False  # another instance is running
        except Exception:
            pass  # stale or unreadable lock — proceed
    with open(_LOCK_FILE, "w") as f:
        f.write(str(os.getpid()))
    atexit.register(_release_lock)
    return True

def _release_lock():
    try:
        os.remove(_LOCK_FILE)
    except Exception:
        pass

# Configure Ollama models path
OLLAMA_MODELS_DIR = os.path.join(PROJECT_ROOT, ".ollama", "models")
os.environ["OLLAMA_MODELS"] = OLLAMA_MODELS_DIR

import uvicorn
import webview

import backend.main as _main_module
from backend.main import app  # noqa: F401  — triggers DB init

# ─── Windows taskbar icon fix ─────────────────────────────────────
# Without this, Windows groups the window under the Python taskbar icon.
# Setting a unique AppUserModelID tells Windows to treat this as its own app.
if sys.platform == "win32":
    try:
        import ctypes
        ctypes.windll.shell32.SetCurrentProcessExplicitAppUserModelID("ContextVolt.App.1")
    except Exception:
        pass

_current_server: uvicorn.Server | None = None
_server_lock = threading.Lock()


def _launch_server() -> None:
    """Create and run a fresh uvicorn server instance. Blocks until server exits."""
    global _current_server
    config = uvicorn.Config(app, host="127.0.0.1", port=8000, log_level="warning")
    srv = uvicorn.Server(config)

    with _server_lock:
        _current_server = srv

    # Update the mutable start-time token so /api/health returns a new value
    # after each restart (the module-level dict persists across restarts).
    _main_module._server_token["started_at"] = time.time()

    # Expose restart callback so the API endpoint can trigger it
    _main_module._restart_uvicorn = _restart_uvicorn

    srv.run()  # blocks until force_exit / should_exit is set


def _restart_uvicorn() -> None:
    """Stop the running uvicorn instance and start a fresh one (in-process).

    Called from the /api/restart endpoint via _main_module._restart_uvicorn().
    The pywebview window is untouched — only the HTTP server cycles.
    """
    with _server_lock:
        old = _current_server

    if old:
        old.force_exit = True  # immediate shutdown, don't wait for keep-alive connections

    def _delayed_relaunch() -> None:
        time.sleep(0.8)  # brief pause for OS to release the port
        thread = threading.Thread(target=_launch_server, daemon=True)
        thread.start()

    threading.Thread(target=_delayed_relaunch, daemon=True).start()


def main():
    if not _acquire_lock():
        # Another instance is already running — just exit silently
        sys.exit(0)

    # Start the first server instance
    server_thread = threading.Thread(target=_launch_server, daemon=True)
    server_thread.start()

    # Give the server a moment to boot before pointing the webview at it
    time.sleep(1.5)

    # Resolve icon path (works both from source and installed builds)
    _icon = os.path.join(PROJECT_ROOT, "icon.ico")
    _icon_arg = _icon if os.path.exists(_icon) else None

    # Open native window — blocks until the window is closed
    window = webview.create_window(
        title="ContextVolt",
        url="http://127.0.0.1:8000",
        width=1200,
        height=800,
        min_size=(800, 600),
        background_color="#0a0a0f",
        text_select=True,
    )

    # pywebview on Windows hardcodes sys.executable as the icon source and ignores
    # the icon= parameter. Override via the shown event using System.Drawing.Icon.
    if _icon_arg and sys.platform == "win32":
        def _set_icon():
            try:
                from System.Drawing import Icon  # type: ignore
                window.native.Icon = Icon(_icon_arg)
            except Exception:
                pass
        window.events.shown += _set_icon

    webview.start(debug=False, icon=_icon_arg)
    sys.exit(0)


if __name__ == "__main__":
    main()
