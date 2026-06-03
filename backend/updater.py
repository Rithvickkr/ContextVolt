"""
ContextVolt — Auto-updater.

Checks GitHub releases for a newer version, streams the download, and
launches the installer silently so the user doesn't have to do anything.
"""
from __future__ import annotations

import json
import logging
import os
import subprocess
import sys
import tempfile
import threading
import urllib.error
import urllib.request
from typing import Iterator

_log = logging.getLogger("contextvolt.updater")

APP_VERSION = "2.1.0"
GITHUB_REPO = "Rithvickkr/ContextVolt"
_API_URL = f"https://api.github.com/repos/{GITHUB_REPO}/releases/latest"

_dl_path: str | None = None
_dl_lock = threading.Lock()


def _parse_version(v: str) -> tuple[int, ...]:
    return tuple(int(x) for x in v.lstrip("v").split(".") if x.isdigit())


def check_for_update() -> dict:
    """Hit the GitHub releases API and return update info."""
    try:
        req = urllib.request.Request(
            _API_URL,
            headers={
                "User-Agent": f"ContextVolt/{APP_VERSION}",
                "Accept": "application/vnd.github+json",
            },
        )
        with urllib.request.urlopen(req, timeout=10) as resp:
            data = json.loads(resp.read())
    except urllib.error.URLError as e:
        _log.warning("Update check failed: %s", e)
        return {"update_available": False, "current_version": APP_VERSION, "error": str(e)}
    except Exception as e:
        _log.warning("Update check failed: %s", e)
        return {"update_available": False, "current_version": APP_VERSION, "error": str(e)}

    tag = data.get("tag_name", "")
    latest = _parse_version(tag)
    current = _parse_version(APP_VERSION)
    update_available = bool(latest) and latest > current

    download_url = None
    asset_size = 0
    for asset in data.get("assets", []):
        name: str = asset.get("name", "")
        if sys.platform == "win32" and name.endswith(".exe"):
            download_url = asset["browser_download_url"]
            asset_size = asset.get("size", 0)
            break
        if sys.platform == "darwin" and (name.endswith(".dmg") or "mac" in name.lower()):
            download_url = asset["browser_download_url"]
            asset_size = asset.get("size", 0)
            break

    return {
        "update_available": update_available,
        "current_version": APP_VERSION,
        "latest_version": tag.lstrip("v"),
        "tag": tag,
        "download_url": download_url,
        "asset_size": asset_size,
        "html_url": data.get("html_url", ""),
        "release_notes": (data.get("body") or "")[:600],
    }


def download_update(url: str, size: int = 0) -> Iterator[dict]:
    """Generator — downloads the installer and yields SSE-friendly progress dicts."""
    global _dl_path

    # The downloaded artifact must keep its real extension so the OS handler
    # recognizes it: .exe (silent install) on Windows, .dmg (mounted via `open`)
    # on macOS.
    if sys.platform == "win32":
        suffix = ".exe"
    elif sys.platform == "darwin":
        suffix = ".dmg"
    else:
        suffix = ""
    tmp = tempfile.mktemp(suffix=suffix, prefix="cv_update_")
    downloaded = 0

    try:
        req = urllib.request.Request(
            url,
            headers={"User-Agent": f"ContextVolt/{APP_VERSION}"},
        )
        with urllib.request.urlopen(req, timeout=300) as resp:
            total = int(resp.headers.get("Content-Length") or size or 0)
            with open(tmp, "wb") as f:
                while True:
                    buf = resp.read(65536)
                    if not buf:
                        break
                    f.write(buf)
                    downloaded += len(buf)
                    pct = int(downloaded * 100 / total) if total else -1
                    yield {"progress": pct, "downloaded": downloaded, "total": total, "done": False}

        with _dl_lock:
            _dl_path = tmp

        yield {"progress": 100, "downloaded": downloaded, "total": downloaded, "done": True}

    except Exception as e:
        _log.error("Download failed: %s", e)
        yield {"error": str(e), "done": True}
        try:
            os.remove(tmp)
        except Exception:
            pass


def apply_update() -> bool:
    """Launch the downloaded installer silently, then exit this process."""
    global _dl_path
    with _dl_lock:
        path = _dl_path

    if not path or not os.path.isfile(path):
        return False

    _log.info("Applying update from %s", path)

    if sys.platform == "win32":
        # /SILENT   — progress bar only, no wizard pages
        # /CLOSEAPPLICATIONS — auto-terminates running instances before installing
        subprocess.Popen([path, "/SILENT", "/CLOSEAPPLICATIONS"],
                         creationflags=subprocess.DETACHED_PROCESS | subprocess.CREATE_NEW_PROCESS_GROUP)
    elif sys.platform == "darwin":
        subprocess.Popen(["open", path])

    threading.Timer(1.5, lambda: os.kill(os.getpid(), 9)).start()
    return True
