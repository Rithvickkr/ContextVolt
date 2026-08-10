#!/bin/bash
# ═══════════════════════════════════════════════════════════════
# ContextVolt — macOS Build Script
#
# Produces:  ContextVolt.dmg  (unsigned, ad-hoc codesigned)
#
# Usage (locally on a Mac):
#     bash installer/build_mac.sh
#
# Or in CI: see .github/workflows/build-mac.yml
#
# Requirements:
#   - macOS (uses sips + iconutil + codesign — all built-in)
#   - Python 3.10+
#   - create-dmg from Homebrew (auto-installed if missing)
# ═══════════════════════════════════════════════════════════════

set -euo pipefail

cd "$(dirname "$0")/.."

if [[ "$OSTYPE" != "darwin"* ]]; then
    echo "  This script only runs on macOS."
    exit 1
fi

VERSION="${CONTEXTVOLT_VERSION:-2.2.0}"
DMG_NAME="ContextVolt-${VERSION}-macOS.dmg"

echo ""
echo "  ╔══════════════════════════════════════════╗"
echo "  ║  ContextVolt macOS Build (v${VERSION})         ║"
echo "  ╚══════════════════════════════════════════╝"
echo ""

# ─── Step 1: Generate icon.icns from icon.png ───────────────────
echo "  [1/7] Generating icon.icns…"
if [ ! -f "icon.png" ]; then
    echo "  ERROR: icon.png not found at repo root."
    exit 1
fi

ICONSET="icon.iconset"
rm -rf "$ICONSET" icon.icns
mkdir -p "$ICONSET"
for size in 16 32 64 128 256 512; do
    sips -z $size $size icon.png --out "$ICONSET/icon_${size}x${size}.png" >/dev/null
    sips -z $((size*2)) $((size*2)) icon.png --out "$ICONSET/icon_${size}x${size}@2x.png" >/dev/null
done
iconutil -c icns "$ICONSET" -o icon.icns
rm -rf "$ICONSET"
echo "         icon.icns created"

# ─── Step 2: Build venv + install deps + py2app ─────────────────
echo "  [2/7] Setting up build venv…"
BUILD_VENV="venv-build"
rm -rf "$BUILD_VENV"
# sqlite-vec is loaded via conn.enable_load_extension() at runtime. macOS's
# system Python (and actions/setup-python's macOS build) ship a sqlite3 module
# compiled WITHOUT loadable-extension support, so the bundle would crash on
# first DB open. Build with a Python that supports it (Homebrew's does) — pass
# it as PYTHON_BIN, default to python3 for local Homebrew-based builds.
PYTHON_BIN="${PYTHON_BIN:-python3}"
echo "         using interpreter: $PYTHON_BIN"
"$PYTHON_BIN" -m venv "$BUILD_VENV"
# shellcheck disable=SC1090
source "$BUILD_VENV/bin/activate"
# Fail loudly at build time rather than shipping a bundle that dies at launch.
python -c "import sqlite3; sqlite3.connect(':memory:').enable_load_extension(True)" \
    || { echo "  ERROR: build Python lacks SQLite loadable-extension support (needed for sqlite-vec)."; \
         echo "         Use Homebrew Python: brew install python@3.12 and set PYTHON_BIN to it."; exit 1; }
pip install --upgrade pip --quiet --disable-pip-version-check
# cmake fallback for llama-cpp-python: if no prebuilt wheel matches this
# runner's macOS/Python combo, pip falls back to a source build, which needs it.
command -v cmake >/dev/null 2>&1 || brew install cmake --quiet
pip install -r requirements.txt --quiet --disable-pip-version-check
pip install py2app --quiet --disable-pip-version-check
echo "         build venv ready"

# ─── Step 3: Clean previous build ───────────────────────────────
echo "  [3/7] Cleaning previous build artifacts…"
rm -rf build dist

# ─── Step 4: Build the .app via py2app ──────────────────────────
echo "  [4/7] Building ContextVolt.app (this takes a minute)…"
python setup_mac.py py2app

if [ ! -d "dist/ContextVolt.app" ]; then
    echo "  ERROR: py2app did not produce dist/ContextVolt.app"
    exit 1
fi
echo "         dist/ContextVolt.app built"

# ─── Step 5: Ad-hoc codesign ────────────────────────────────────
# Free signing — uses no certificate. Doesn't bypass Gatekeeper, but prevents
# the "ContextVolt is damaged" error on Apple Silicon when downloaded.
echo "  [5/7] Ad-hoc codesigning…"
codesign --force --deep --sign - dist/ContextVolt.app
codesign --verify --deep --strict dist/ContextVolt.app
echo "         signed"

# ─── Step 6: Make sure create-dmg is available ──────────────────
if ! command -v create-dmg >/dev/null 2>&1; then
    echo "  [6/7] Installing create-dmg via Homebrew…"
    if ! command -v brew >/dev/null 2>&1; then
        echo "  ERROR: Homebrew not installed and create-dmg missing."
        echo "  Install Homebrew from https://brew.sh and rerun."
        exit 1
    fi
    brew install create-dmg
else
    echo "  [6/7] create-dmg already installed"
fi

# ─── Step 7: Build the .dmg ─────────────────────────────────────
echo "  [7/7] Creating ${DMG_NAME}…"
rm -f "$DMG_NAME"
create-dmg \
    --volname "ContextVolt" \
    --volicon icon.icns \
    --window-size 600 400 \
    --icon-size 100 \
    --icon "ContextVolt.app" 175 190 \
    --app-drop-link 425 190 \
    "$DMG_NAME" \
    dist/ContextVolt.app

echo ""
echo "  ═══════════════════════════════════════════"
echo "  ✅ Build complete!"
echo "     ${PWD}/${DMG_NAME}"
echo "  ═══════════════════════════════════════════"
echo ""
echo "  First-launch instructions for users (direct .dmg download):"
echo "    1. Open the .dmg, drag ContextVolt.app to Applications"
echo "    2. Open it once — Gatekeeper will block it"
echo "    3. System Settings → Privacy & Security → 'Open Anyway'"
echo "       (older macOS: right-click ContextVolt.app → Open)"
echo "       (one-time only; the app is ad-hoc signed, not notarized)"
echo ""
echo "  Tip: the Homebrew cask avoids this step entirely —"
echo "       brew install --cask rithvickkr/tap/contextvolt"
echo ""
