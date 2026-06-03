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

from backend import paths as _paths  # noqa: E402  — must follow sys.path setup

# ─── Crash logging (pythonw.exe has no console) ──────────────────
_LOG_FILE = str(_paths.log_path())
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

_LOCK_FILE = str(_paths.lock_path())

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
OLLAMA_MODELS_DIR = str(_paths.ollama_models_dir())
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

    # Resolve icon path (works both from source and installed builds).
    # Mac uses the .icns set by py2app via CFBundleIconFile — no runtime icon needed.
    if sys.platform == "win32":
        _icon = os.path.join(PROJECT_ROOT, "icon.ico")
        _icon_arg = _icon if os.path.exists(_icon) else None
    else:
        _icon_arg = None

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

    def _set_large_taskbar_icon():
        if sys.platform != "win32" or not _icon_arg:
            return
        try:
            import ctypes
            import ctypes.wintypes

            user32 = ctypes.windll.user32
            SM_CXICON, SM_CXSMICON = 11, 49
            LR_LOADFROMFILE = 0x0010
            IMAGE_ICON = 1
            WM_SETICON = 0x0080
            ICON_SMALL, ICON_BIG = 0, 1

            # Use system metrics so sizes are correct at any DPI
            big_sz = user32.GetSystemMetrics(SM_CXICON)    # typically 32 or 48
            small_sz = user32.GetSystemMetrics(SM_CXSMICON) # typically 16 or 20

            # Find our window by process ID — more reliable than window title
            pid = os.getpid()
            hwnd_found = ctypes.c_void_p(0)

            EnumWindowsProc = ctypes.WINFUNCTYPE(ctypes.c_bool, ctypes.c_void_p, ctypes.c_void_p)

            def _enum(hwnd, _):
                lp_pid = ctypes.c_ulong(0)
                user32.GetWindowThreadProcessId(hwnd, ctypes.byref(lp_pid))
                if lp_pid.value == pid and user32.IsWindowVisible(hwnd):
                    hwnd_found.value = hwnd
                    return False  # stop enumeration
                return True

            # Retry up to 3 seconds for the window to appear
            for _ in range(6):
                time.sleep(0.5)
                user32.EnumWindows(EnumWindowsProc(_enum), 0)
                if hwnd_found.value:
                    break

            hwnd = hwnd_found.value
            if not hwnd:
                return

            icon_path_w = ctypes.c_wchar_p(_icon_arg)
            hicon_big = user32.LoadImageW(None, icon_path_w, IMAGE_ICON, big_sz, big_sz, LR_LOADFROMFILE)
            hicon_small = user32.LoadImageW(None, icon_path_w, IMAGE_ICON, small_sz, small_sz, LR_LOADFROMFILE)
            if hicon_big:
                user32.SendMessageW(hwnd, WM_SETICON, ICON_BIG, hicon_big)
            if hicon_small:
                user32.SendMessageW(hwnd, WM_SETICON, ICON_SMALL, hicon_small)
        except Exception:
            pass

    threading.Thread(target=_set_large_taskbar_icon, daemon=True).start()
    webview.start(debug=True, private_mode=True)  # private_mode forces a clean cache — bust WebView2's stale index.html
    sys.exit(0)


if __name__ == "__main__":
    main()
