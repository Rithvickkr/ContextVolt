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

import os
import sys

if sys.platform != "darwin":
    sys.exit("setup_mac.py is for macOS only — use installer/build.ps1 on Windows.")

from setuptools import setup  # noqa: E402

APP = ["installer.py"]

# Keep the bundle version in lockstep with the release tag (build_mac.sh / CI
# pass CONTEXTVOLT_VERSION); fall back to the current version for local builds.
_VERSION = os.environ.get("CONTEXTVOLT_VERSION", "2.4.0")

PLIST = {
    "CFBundleName": "ContextVolt",
    "CFBundleDisplayName": "ContextVolt",
    "CFBundleIdentifier": "com.contextvolt.app",
    "CFBundleVersion": _VERSION,
    "CFBundleShortVersionString": _VERSION,
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
    # Only force-include packages that py2app's static analyzer misses or that
    # ship binaries / data files. Pure-Python leaf libraries (anyio, sniffio,
    # h11, click, idna, charset_normalizer, urllib3 …) are discovered
    # automatically through the import graph — listing them here makes py2app's
    # collect_packagedirs choke (e.g. "No module named 'sniffio'").
    "packages": [
        "backend",
        "fastapi",       # dynamic imports
        "starlette",     # dynamic imports
        "uvicorn",       # dynamic protocol/loader imports
        "pydantic",
        "pydantic_core",  # compiled extension
        "requests",
        "certifi",        # bundles cacert.pem data file
        "numpy",          # compiled extension
        "sqlite_vec",     # bundles the loadable extension
        "mcp",            # dynamic imports
        "webview",        # pywebview loads its Cocoa backend dynamically
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
        # anyio/sniffio are normally auto-discovered, but list the entry points
        # explicitly so a missed dynamic import can't drop them.
        "anyio",
        "sniffio",
        "h11",
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
