"""
ContextVolt — py2app build configuration (macOS only).

Run via:  python setup_mac.py py2app
Or use the wrapper:  bash installer/build_mac.sh

Produces:  dist/ContextVolt.app

Notes:
  - Entry point is installer.py (the wizard handles first-run Ollama/model
    setup, then hands off to run.main() in-process — see installer.py).
  - We bundle the *runtime* deps from requirements.txt into the .app, so the
    wizard's venv/deps steps short-circuit (EMBEDDED_MODE=True via IS_FROZEN).
  - Architecture follows the runner: macos-14 GitHub runner is arm64, which
    covers Apple Silicon. Intel users can use install.sh as a fallback.
"""
from __future__ import annotations

import sys

if sys.platform != "darwin":
    sys.exit("setup_mac.py is for macOS only — use installer/build.ps1 on Windows.")

from setuptools import setup  # noqa: E402

APP = ["installer.py"]

PLIST = {
    "CFBundleName": "ContextVolt",
    "CFBundleDisplayName": "ContextVolt",
    "CFBundleIdentifier": "com.contextvolt.app",
    "CFBundleVersion": "1.1.0",
    "CFBundleShortVersionString": "1.1.0",
    "CFBundleExecutable": "ContextVolt",
    "LSMinimumSystemVersion": "11.0",
    "NSHighResolutionCapable": True,
    "LSApplicationCategoryType": "public.app-category.developer-tools",
    "NSHumanReadableCopyright": "© 2026 ContextVolt",
    # The bundled FastAPI server listens on 127.0.0.1; allow local networking
    # so WebKit can reach it without ATS friction.
    "NSAppTransportSecurity": {
        "NSAllowsLocalNetworking": True,
    },
}

OPTIONS = {
    "iconfile": "icon.icns",
    "plist": PLIST,
    # Python packages that py2app's static analyzer often misses — uvicorn /
    # starlette / pydantic do a lot of dynamic imports. List them explicitly.
    "packages": [
        "backend",
        "fastapi",
        "starlette",
        "uvicorn",
        "pydantic",
        "pydantic_core",
        "anyio",
        "sniffio",
        "h11",
        "click",
        "requests",
        "urllib3",
        "charset_normalizer",
        "idna",
        "certifi",
        "numpy",
        "sqlite_vec",
        "mcp",
        "webview",
        # PyObjC bridge modules required by pywebview's Cocoa backend.
        "objc",
        "Foundation",
        "AppKit",
        "WebKit",
    ],
    "includes": [
        "sqlite3",
        "asyncio",
        "json",
        "logging",
        "ssl",
    ],
    # Read-only assets shipped inside Contents/Resources/.
    # Writable state (db, config, logs, .ollama, lock) goes through paths.py.
    "resources": [
        "frontend",
        "extension",
        "icon.png",
        "icon.ico",
        "extension_install_guide.html",
        "main icon",
        "run.py",
        "requirements.txt",
    ],
    "argv_emulation": False,  # must be False with PyObjC/WebKit
    "strip": False,            # strip can break embedded C extensions
    "optimize": 0,             # uvicorn/starlette use docstrings — don't strip them
    "semi_standalone": False,  # bundle Python itself
}

setup(
    name="ContextVolt",
    app=APP,
    options={"py2app": OPTIONS},
    setup_requires=["py2app"],
)
