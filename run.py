"""
ContextVolt — Application Entry Point.

Starts the FastAPI backend on a background thread, then opens a native
window via pywebview.
"""

import sys
import os
import socket
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

    # Prevent the grey/blank surface after minimize→restore. Chromium (WebView2's
    # engine) marks a minimized window "occluded" and suspends GPU compositing;
    # on restore it sometimes fails to resume, leaving a blank client area until
    # the window is clicked or resized. Disabling the occlusion calculation keeps
    # it painting. Must be set before the WebView2 environment is created.
    # See https://github.com/MicrosoftEdge/WebView2Feedback/issues/5171
    _existing_args = os.environ.get("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS", "")
    _occlusion_flag = "--disable-features=CalculateNativeWinOcclusion"
    if _occlusion_flag not in _existing_args:
        os.environ["WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS"] = (
            f"{_existing_args} {_occlusion_flag}".strip()
        )

_current_server: uvicorn.Server | None = None
_server_lock = threading.Lock()

# The port we actually bound, decided once at startup by _select_port().
_chosen_port: int | None = None


def _port_is_free(host: str, port: int) -> bool:
    """True if we can bind host:port right now (i.e. nothing else holds it)."""
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        try:
            sock.bind((host, port))
            return True
        except OSError:
            return False


def _select_port() -> int | None:
    """Pick the port to bind, or None if every candidate is taken.

    - CONVX_PORT set  -> use only that port (no fallback).
    - otherwise       -> first free port in PORT_CANDIDATES, preferring the one
                         used last so the port stays stable across launches.
    """
    host = _paths.SERVER_HOST

    if _paths.EXPLICIT_PORT is not None:
        return _paths.EXPLICIT_PORT if _port_is_free(host, _paths.EXPLICIT_PORT) else None

    last = _paths.read_last_port()
    candidates = _paths.PORT_CANDIDATES
    if last is not None:
        candidates = [last] + [p for p in candidates if p != last]

    for port in candidates:
        if _port_is_free(host, port):
            return port
    return None


def _fatal(message: str) -> None:
    """Surface a fatal startup error to the user, then exit.

    pythonw.exe has no console, so we use a native dialog where possible and
    always record the reason in the crash log.
    """
    logging.error(message)
    try:
        if sys.platform == "win32":
            import ctypes
            # MB_OK | MB_ICONERROR
            ctypes.windll.user32.MessageBoxW(0, message, "ContextVolt", 0x10)
        else:
            webview.create_window(
                "ContextVolt — Cannot Start",
                html=(
                    "<body style='font-family:-apple-system,sans-serif;background:#0a0a0f;"
                    "color:#e5e7eb;padding:24px;line-height:1.5'>"
                    f"<h2 style='color:#ef4444'>ContextVolt couldn't start</h2><p>{message}</p></body>"
                ),
            )
            webview.start()
    except Exception:
        pass
    sys.exit(1)


def _launch_server() -> None:
    """Create and run a fresh uvicorn server instance. Blocks until server exits."""
    global _current_server
    config = uvicorn.Config(
        app, host=_paths.SERVER_HOST, port=_chosen_port, log_level="warning"
    )
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


# ─── Frameless window: resize + Aero Snap (Win32) ────────────────
# pywebview frameless windows use FormBorderStyle.None, which strips the
# native resize border and Aero Snap. We restore both by re-adding the sizing
# window styles, eating the non-client frame in WM_NCCALCSIZE (so no visible
# border returns), and reporting the window edges as resize handles in
# WM_NCHITTEST. The WNDPROC callbacks must outlive this function or the GC
# will free them and crash the app, so we stash them in a module global.
_wndproc_keepalive: list = []

# HWND of the main window, set once found, used by the JS-driven resize handles.
_main_hwnd: int = 0

# Private messages handled inside the window's own WndProc (UI thread).
_WM_CV_RESIZE = 0x0400 + 0x51    # begin a native resize, direction = wparam
_WM_CV_REWINDOW = 0x0400 + 0x52  # restore phase 1: drop a maximized window to windowed
_WM_CV_REMAX = 0x0400 + 0x53     # restore phase 2: re-maximize it (windowed→full)


def _post_to_window(msg: int, wparam: int = 0) -> None:
    """Post a private message to our window's WndProc (runs on the UI thread)."""
    if sys.platform != "win32" or not _main_hwnd:
        return
    try:
        import ctypes
        from ctypes import wintypes

        post = ctypes.windll.user32.PostMessageW
        post.argtypes = [wintypes.HWND, wintypes.UINT, wintypes.WPARAM, wintypes.LPARAM]
        post(_main_hwnd, msg, wparam, 0)
    except Exception:
        logging.exception("PostMessage failed")


def _start_native_resize(edge: str) -> None:
    """Hand off to the OS resize loop (smooth, DPI-correct, snap-aware).

    The WebView2 control covers the client area and grabs the mouse on
    mousedown, so native edge hit-testing never fires and the capture blocks
    the OS resize loop. The JS edge handles call this on mousedown; we post a
    private message that our WndProc handles on the UI thread, where it can
    release the capture and enter the system SC_SIZE loop.
    """
    # WMSZ_* direction codes (added to SC_SIZE inside the WndProc).
    directions = {
        "left": 1, "right": 2, "top": 3, "topleft": 4, "topright": 5,
        "bottom": 6, "bottomleft": 7, "bottomright": 8,
    }
    code = directions.get(edge)
    if code:
        _post_to_window(_WM_CV_RESIZE, code)


def _revive_webview() -> None:
    """Wake WebView2's compositor after a restore by posting a synthetic click.

    On some configs (seen on a 144 Hz laptop panel) WebView2's frame scheduler
    stalls after the window is restored from minimized while maximized: the page
    is rendered but never *presented*, so the client area stays blank-grey until a
    real mouse click wakes Chromium. We replicate that click by posting a left
    button down/up to Chromium's input window (Chrome_RenderWidgetHostHWND) at the
    top-left title-bar drag area — no window controls live there and there's no
    mouse movement, so the click has no visible effect beyond forcing the repaint.
    """
    if sys.platform != "win32" or not _main_hwnd:
        return
    try:
        import ctypes
        from ctypes import wintypes

        user32 = ctypes.windll.user32
        target = ctypes.c_void_p(0)
        buf = ctypes.create_unicode_buffer(256)
        EnumProc = ctypes.WINFUNCTYPE(ctypes.c_bool, ctypes.c_void_p, ctypes.c_void_p)

        def _find(hwnd, _):
            user32.GetClassNameW(hwnd, buf, 256)
            if buf.value == "Chrome_RenderWidgetHostHWND":
                target.value = hwnd
                return False  # found it — stop
            return True

        # EnumChildWindows recurses through all descendants.
        user32.EnumChildWindows(_main_hwnd, EnumProc(_find), 0)
        h = target.value
        if not h:
            return

        WM_LBUTTONDOWN, WM_LBUTTONUP, MK_LBUTTON = 0x0201, 0x0202, 0x0001
        x, y = 8, 8
        lparam = (y << 16) | x
        post = user32.PostMessageW
        post.argtypes = [wintypes.HWND, wintypes.UINT, wintypes.WPARAM, wintypes.LPARAM]
        post(h, WM_LBUTTONDOWN, MK_LBUTTON, lparam)
        post(h, WM_LBUTTONUP, 0, lparam)
    except Exception:
        logging.exception("WebView2 revive click failed")


def _find_own_hwnd(timeout: float = 3.0) -> int:
    """Return the HWND of this process's visible window, or 0 if not found."""
    if sys.platform != "win32":
        return 0
    import ctypes

    user32 = ctypes.windll.user32
    pid = os.getpid()
    found = ctypes.c_void_p(0)
    EnumWindowsProc = ctypes.WINFUNCTYPE(ctypes.c_bool, ctypes.c_void_p, ctypes.c_void_p)

    def _enum(hwnd, _):
        lp_pid = ctypes.c_ulong(0)
        user32.GetWindowThreadProcessId(hwnd, ctypes.byref(lp_pid))
        if lp_pid.value == pid and user32.IsWindowVisible(hwnd):
            found.value = hwnd
            return False  # stop enumeration
        return True

    cb = EnumWindowsProc(_enum)
    deadline = time.time() + timeout
    while time.time() < deadline:
        time.sleep(0.5)
        user32.EnumWindows(cb, 0)
        if found.value:
            break
    return found.value or 0


def _enable_frameless_chrome(hwnd: int) -> None:
    """Restore edge-resize and Aero Snap on a frameless (borderless) window."""
    if sys.platform != "win32" or not hwnd:
        return
    global _main_hwnd
    _main_hwnd = hwnd
    try:
        import ctypes
        from ctypes import wintypes

        user32 = ctypes.windll.user32
        LONG_PTR = ctypes.c_ssize_t

        GWL_STYLE = -16
        GWLP_WNDPROC = -4
        WS_THICKFRAME = 0x00040000
        WS_MAXIMIZEBOX = 0x00010000
        WS_MINIMIZEBOX = 0x00020000
        WS_CAPTION = 0x00C00000
        WS_SYSMENU = 0x00080000

        WM_NCCALCSIZE = 0x0083
        WM_NCHITTEST = 0x0084
        WM_GETMINMAXINFO = 0x0024
        WM_SYSCOMMAND = 0x0112
        WM_SIZE = 0x0005
        SC_SIZE = 0xF000

        SIZE_RESTORED, SIZE_MINIMIZED, SIZE_MAXIMIZED = 0, 1, 2
        SW_MAXIMIZE, SW_RESTORE = 3, 9

        HTLEFT, HTRIGHT = 10, 11
        HTTOP, HTTOPLEFT, HTTOPRIGHT = 12, 13, 14
        HTBOTTOM, HTBOTTOMLEFT, HTBOTTOMRIGHT = 15, 16, 17

        SM_CXFRAME, SM_CXPADDEDBORDER = 32, 92
        MONITOR_DEFAULTTONEAREST = 2

        if ctypes.sizeof(ctypes.c_void_p) == 8:
            get_long, set_long = user32.GetWindowLongPtrW, user32.SetWindowLongPtrW
        else:
            get_long, set_long = user32.GetWindowLongW, user32.SetWindowLongW
        get_long.restype = LONG_PTR
        get_long.argtypes = [wintypes.HWND, ctypes.c_int]
        set_long.restype = LONG_PTR
        set_long.argtypes = [wintypes.HWND, ctypes.c_int, LONG_PTR]

        # (1) Restore the full native window styles so Windows gives us back
        #     resize, Aero Snap, and the maximize/restore/minimize animations.
        #     WS_CAPTION/WS_SYSMENU would normally draw a title bar, but the
        #     WM_NCCALCSIZE handler below eats the entire non-client area, so
        #     nothing visible returns — only the native behaviour.
        style = get_long(hwnd, GWL_STYLE)
        set_long(
            hwnd,
            GWL_STYLE,
            style | WS_THICKFRAME | WS_CAPTION | WS_SYSMENU | WS_MAXIMIZEBOX | WS_MINIMIZEBOX,
        )

        WNDPROC = ctypes.WINFUNCTYPE(
            LONG_PTR, wintypes.HWND, wintypes.UINT, wintypes.WPARAM, wintypes.LPARAM
        )

        call_wndproc = user32.CallWindowProcW
        call_wndproc.restype = LONG_PTR
        call_wndproc.argtypes = [
            WNDPROC, wintypes.HWND, wintypes.UINT, wintypes.WPARAM, wintypes.LPARAM
        ]
        user32.GetWindowRect.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.RECT)]
        user32.IsZoomed.argtypes = [wintypes.HWND]
        user32.MonitorFromWindow.restype = ctypes.c_void_p
        user32.MonitorFromWindow.argtypes = [wintypes.HWND, wintypes.DWORD]

        class MONITORINFO(ctypes.Structure):
            _fields_ = [
                ("cbSize", wintypes.DWORD),
                ("rcMonitor", wintypes.RECT),
                ("rcWork", wintypes.RECT),
                ("dwFlags", wintypes.DWORD),
            ]

        class MINMAXINFO(ctypes.Structure):
            _fields_ = [
                ("ptReserved", wintypes.POINT),
                ("ptMaxSize", wintypes.POINT),
                ("ptMaxPosition", wintypes.POINT),
                ("ptMinTrackSize", wintypes.POINT),
                ("ptMaxTrackSize", wintypes.POINT),
            ]

        class NCCALCSIZE_PARAMS(ctypes.Structure):
            _fields_ = [("rgrc", wintypes.RECT * 3), ("lppos", ctypes.c_void_p)]

        user32.GetMonitorInfoW.restype = wintypes.BOOL
        user32.GetMonitorInfoW.argtypes = [ctypes.c_void_p, ctypes.POINTER(MONITORINFO)]

        border = (
            user32.GetSystemMetrics(SM_CXFRAME) + user32.GetSystemMetrics(SM_CXPADDEDBORDER)
        ) or 8

        def _monitor_info(h):
            mi = MONITORINFO()
            mi.cbSize = ctypes.sizeof(MONITORINFO)
            mon = user32.MonitorFromWindow(h, MONITOR_DEFAULTTONEAREST)
            if mon and user32.GetMonitorInfoW(mon, ctypes.byref(mi)):
                return mi
            return None

        old_proc = WNDPROC(get_long(hwnd, GWLP_WNDPROC))

        # Restore behaviour state. "min" tracks that we're minimized; "transition"
        # suppresses the WM_SIZE messages our own ShowWindow calls generate.
        _sz = {"min": False, "transition": False}

        def _wndproc(h, msg, wparam, lparam):
            if msg == _WM_CV_REWINDOW:
                # Phase 1 (posted, so it runs after the maximize finished): drop the
                # just-restored maximized window down to windowed.
                user32.ShowWindow(h, SW_RESTORE)
                threading.Timer(0.5, lambda: _post_to_window(_WM_CV_REMAX)).start()
                return 0
            if msg == _WM_CV_REMAX:
                # Phase 2: re-maximize, so the window arrives via the windowed→full
                # transition (which presents correctly, unlike a direct restore).
                user32.ShowWindow(h, SW_MAXIMIZE)
                _sz["transition"] = False
                # Belt-and-suspenders present nudge (cheap, harmless click on the
                # empty drag region) in case the maximize alone doesn't repaint.
                threading.Timer(0.10, _revive_webview).start()
                return 0
            if msg == WM_SIZE and not _sz["transition"]:
                if wparam == SIZE_MINIMIZED:
                    _sz["min"] = True
                elif wparam == SIZE_MAXIMIZED and _sz["min"]:
                    # Was maximized before minimizing → run the windowed→maximize
                    # transition. Done async (posted) so this maximize message
                    # finishes cleanly first; the flag suppresses the WM_SIZEs our
                    # own ShowWindow calls then generate.
                    _sz["min"] = False
                    _sz["transition"] = True
                    _post_to_window(_WM_CV_REWINDOW)
                elif wparam == SIZE_RESTORED and _sz["min"]:
                    # Was windowed before minimizing → leave it windowed as-is.
                    _sz["min"] = False
                # fall through to default sizing behaviour
            if msg == _WM_CV_RESIZE:
                # Runs on the UI thread, so ReleaseCapture() now actually frees
                # the capture WebView2 grabbed on mousedown, letting the OS
                # resize loop take the mouse. wparam is the WMSZ_* direction.
                user32.ReleaseCapture()
                return call_wndproc(old_proc, h, WM_SYSCOMMAND, SC_SIZE + wparam, 0)
            if msg == WM_NCCALCSIZE and wparam:
                # Eat the non-client frame so the client fills the window. When
                # maximized, a borderless window's rect overhangs the monitor by
                # the frame width — clamp the client straight to the work area so
                # nothing is pushed off-screen and the taskbar stays visible.
                if user32.IsZoomed(h):
                    mi = _monitor_info(h)
                    if mi:
                        p = ctypes.cast(
                            ctypes.c_void_p(lparam), ctypes.POINTER(NCCALCSIZE_PARAMS)
                        ).contents
                        p.rgrc[0].left = mi.rcWork.left
                        p.rgrc[0].top = mi.rcWork.top
                        p.rgrc[0].right = mi.rcWork.right
                        p.rgrc[0].bottom = mi.rcWork.bottom
                return 0
            if msg == WM_GETMINMAXINFO:
                # Clamp the maximized size/position to the work area so a
                # maximized window leaves the taskbar visible.
                res = call_wndproc(old_proc, h, msg, wparam, lparam)
                mi = _monitor_info(h)
                if mi:
                    mmi = ctypes.cast(
                        ctypes.c_void_p(lparam), ctypes.POINTER(MINMAXINFO)
                    ).contents
                    work, full = mi.rcWork, mi.rcMonitor
                    mmi.ptMaxPosition.x = work.left - full.left
                    mmi.ptMaxPosition.y = work.top - full.top
                    mmi.ptMaxSize.x = work.right - work.left
                    mmi.ptMaxSize.y = work.bottom - work.top
                    mmi.ptMaxTrackSize.x = work.right - work.left
                    mmi.ptMaxTrackSize.y = work.bottom - work.top
                return res
            if msg == WM_NCHITTEST and not user32.IsZoomed(h):
                rect = wintypes.RECT()
                user32.GetWindowRect(h, ctypes.byref(rect))
                x = ctypes.c_short(lparam & 0xFFFF).value
                y = ctypes.c_short((lparam >> 16) & 0xFFFF).value
                on_left = x < rect.left + border
                on_right = x >= rect.right - border
                on_top = y < rect.top + border
                on_bottom = y >= rect.bottom - border
                if on_top and on_left: return HTTOPLEFT
                if on_top and on_right: return HTTOPRIGHT
                if on_bottom and on_left: return HTBOTTOMLEFT
                if on_bottom and on_right: return HTBOTTOMRIGHT
                if on_left: return HTLEFT
                if on_right: return HTRIGHT
                if on_top: return HTTOP
                if on_bottom: return HTBOTTOM
                # not on an edge — fall through to the default handler
            return call_wndproc(old_proc, h, msg, wparam, lparam)

        new_proc = WNDPROC(_wndproc)
        _wndproc_keepalive.extend((new_proc, old_proc))
        set_long(hwnd, GWLP_WNDPROC, ctypes.cast(new_proc, ctypes.c_void_p).value)

        # Force a frame recalc so WM_NCCALCSIZE runs right away.
        SWP_FLAGS = 0x0002 | 0x0001 | 0x0004 | 0x0020  # NOMOVE|NOSIZE|NOZORDER|FRAMECHANGED
        user32.SetWindowPos(hwnd, 0, 0, 0, 0, 0, SWP_FLAGS)
    except Exception:
        logging.exception("Failed to enable frameless window chrome")


def main():
    if not _acquire_lock():
        # Another instance is already running — just exit silently
        sys.exit(0)

    # Decide which port to bind BEFORE opening the window, so we never point the
    # webview at a port some other app is holding.
    global _chosen_port
    _chosen_port = _select_port()
    if _chosen_port is None:
        if _paths.EXPLICIT_PORT is not None:
            _fatal(
                f"Port {_paths.EXPLICIT_PORT} (set via CONVX_PORT) is already in use.\n\n"
                "Free that port or choose a different one, then relaunch ContextVolt."
            )
        else:
            lo, hi = _paths.PORT_CANDIDATES[0], _paths.PORT_CANDIDATES[-1]
            _fatal(
                f"All ports from {lo} to {hi} are in use, so ContextVolt has nowhere to run.\n\n"
                "Close one of the apps using those ports, or set CONVX_PORT to a free "
                "port (and set the same port in the browser extension's options), then relaunch."
            )
        return  # _fatal exits, but keep control flow explicit

    # Publish the live port so the backend (tunnel, MCP URL) and next launch agree.
    _main_module._active_port = _chosen_port
    _paths.write_last_port(_chosen_port)

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

    # Open native window — blocks until the window is closed.
    # frameless=True drops the white OS title bar; we draw our own dark one in
    # the page and drive it through the exposed window-control callbacks below.
    # easy_drag=False so only elements marked .pywebview-drag-region move the
    # window (otherwise a click anywhere drags it).
    window = webview.create_window(
        title="ContextVolt",
        url=_paths.server_origin(port=_chosen_port),
        width=1200,
        height=800,
        min_size=(800, 600),
        background_color="#0a0a0f",
        text_select=True,
        frameless=True,
        easy_drag=False,
    )

    # ─── Custom title-bar window controls (exposed to JS) ─────────────
    # JS calls these via window.pywebview.api.cv_minimize() etc.
    _win_state = {"maximized": False}

    def cv_minimize():
        window.minimize()

    def cv_toggle_maximize():
        # Read the live zoom state so the button stays correct no matter how the
        # window got maximized/restored (button, OS gesture, or our restore
        # transition) rather than trusting a tracked bool that can desync.
        zoomed = False
        if sys.platform == "win32" and _main_hwnd:
            import ctypes
            zoomed = bool(ctypes.windll.user32.IsZoomed(_main_hwnd))
        else:
            zoomed = _win_state["maximized"]
        if zoomed:
            window.restore()
            _win_state["maximized"] = False
        else:
            window.maximize()
            _win_state["maximized"] = True
        return _win_state["maximized"]

    def cv_close():
        window.destroy()

    def cv_start_resize(edge):
        _start_native_resize(edge)

    window.expose(cv_minimize, cv_toggle_maximize, cv_close, cv_start_resize)

    def _setup_native_window():
        if sys.platform != "win32":
            return
        hwnd = _find_own_hwnd()
        if not hwnd:
            return

        # Restore edge-resize + Aero Snap lost to frameless mode.
        _enable_frameless_chrome(hwnd)

        # Launch windowed, hold a beat so the small window is clearly visible,
        # then maximize so the app opens with a smooth small→full-screen
        # transition. Done after the WndProc is installed so the maximize clamps
        # to the work area (taskbar stays visible).
        try:
            time.sleep(0.6)  # let the windowed state show before maximizing
            window.maximize()
            _win_state["maximized"] = True
            # Keep the custom title-bar button in its "Restore" state.
            window.evaluate_js(
                "(function(){var m=document.getElementById('cv-win-max');"
                "if(m){m.classList.add('is-maximized');"
                "m.setAttribute('aria-label','Restore');"
                "m.setAttribute('title','Restore');}})()"
            )
        except Exception:
            logging.exception("Auto-maximize on startup failed")

        # Set the large/small taskbar + Alt-Tab icons.
        if not _icon_arg:
            return
        try:
            import ctypes

            user32 = ctypes.windll.user32
            SM_CXICON, SM_CXSMICON = 11, 49
            LR_LOADFROMFILE = 0x0010
            IMAGE_ICON = 1
            WM_SETICON = 0x0080
            ICON_SMALL, ICON_BIG = 0, 1

            # Use system metrics so sizes are correct at any DPI
            big_sz = user32.GetSystemMetrics(SM_CXICON)    # typically 32 or 48
            small_sz = user32.GetSystemMetrics(SM_CXSMICON) # typically 16 or 20

            icon_path_w = ctypes.c_wchar_p(_icon_arg)
            hicon_big = user32.LoadImageW(None, icon_path_w, IMAGE_ICON, big_sz, big_sz, LR_LOADFROMFILE)
            hicon_small = user32.LoadImageW(None, icon_path_w, IMAGE_ICON, small_sz, small_sz, LR_LOADFROMFILE)
            if hicon_big:
                user32.SendMessageW(hwnd, WM_SETICON, ICON_BIG, hicon_big)
            if hicon_small:
                user32.SendMessageW(hwnd, WM_SETICON, ICON_SMALL, hicon_small)
        except Exception:
            pass

    threading.Thread(target=_setup_native_window, daemon=True).start()
    # debug opens DevTools — keep it off for normal users, enable with CONVX_DEBUG=1.
    # private_mode forces a clean cache — bust WebView2's stale index.html.
    _debug = os.environ.get("CONVX_DEBUG") == "1"
    webview.start(debug=_debug, private_mode=True)
    sys.exit(0)


if __name__ == "__main__":
    main()
