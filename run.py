"""
ContextVolt — Application Entry Point.

Starts the FastAPI backend on a background thread, then opens a native
window via pywebview.
"""

import sys
import os
import threading
import time

# Ensure project root is on the path
PROJECT_ROOT = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, PROJECT_ROOT)

# Configure Ollama models path
OLLAMA_MODELS_DIR = os.path.join(PROJECT_ROOT, ".ollama", "models")
os.environ["OLLAMA_MODELS"] = OLLAMA_MODELS_DIR

import uvicorn
import webview

import backend.main as _main_module
from backend.main import app  # noqa: F401  — triggers DB init

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
    # Start the first server instance
    server_thread = threading.Thread(target=_launch_server, daemon=True)
    server_thread.start()

    # Give the server a moment to boot before pointing the webview at it
    time.sleep(1.5)

    # Open native window — blocks until the window is closed
    webview.create_window(
        title="ContextVolt",
        url="http://127.0.0.1:8000",
        width=1200,
        height=800,
        min_size=(800, 600),
        background_color="#0a0a0f",
        text_select=True,
    )
    webview.start(debug=False)
    sys.exit(0)


if __name__ == "__main__":
    main()
