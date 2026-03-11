#!/bin/bash
# ═══════════════════════════════════════════════════════════
# ContextVolt — macOS/Linux Launcher
# Equivalent of start.bat for Unix systems
# ═══════════════════════════════════════════════════════════

set -e
cd "$(dirname "$0")"

echo ""
echo "  ╔══════════════════════════════════════════╗"
echo "  ║         ContextVolt                    ║"
echo "  ╚══════════════════════════════════════════╝"
echo ""

# ─── Check Python ────────────────────────────────────────────────
if ! command -v python3 &> /dev/null; then
    echo "  ContextVolt requires Python 3.10 or higher."
    echo ""
    if [[ "$OSTYPE" == "darwin"* ]]; then
        echo "  Install with Homebrew:  brew install python"
    else
        echo "  Install with:  sudo apt install python3 python3-venv"
    fi
    echo "  Or download from: https://www.python.org/downloads/"
    echo ""
    exit 1
fi

PYTHON_VERSION=$(python3 --version 2>&1)
echo "  $PYTHON_VERSION detected"

# ─── Bootstrap virtual environment ───────────────────────────────
VENV_PYTHON="./venv/bin/python3"
VENV_PIP="./venv/bin/pip3"

if [ ! -f "$VENV_PYTHON" ]; then
    echo "  Initializing ContextVolt..."
    python3 -m venv venv
    if [ $? -ne 0 ]; then
        echo "  Failed to create virtual environment."
        echo "  Make sure python3-venv is installed:"
        echo "    sudo apt install python3-venv  (Linux)"
        echo "    brew install python             (macOS)"
        exit 1
    fi
fi

# ─── Install pywebview if needed ─────────────────────────────────
"$VENV_PYTHON" -c "import webview" 2>/dev/null
if [ $? -ne 0 ]; then
    echo "  Installing pywebview..."
    
    # macOS: pywebview needs pyobjc for the native WebKit backend
    if [[ "$OSTYPE" == "darwin"* ]]; then
        "$VENV_PIP" install pywebview pyobjc-core pyobjc-framework-WebKit \
            --quiet --disable-pip-version-check 2>/dev/null
    else
        # Linux: pywebview needs GTK
        "$VENV_PIP" install pywebview \
            --quiet --disable-pip-version-check 2>/dev/null
    fi
    
    if [ $? -ne 0 ]; then
        echo "  Failed to install pywebview."
        if [[ "$OSTYPE" == "darwin"* ]]; then
            echo "  Try: pip3 install pywebview pyobjc-core pyobjc-framework-WebKit"
        else
            echo "  Make sure GTK3 is installed:"
            echo "    sudo apt install python3-gi gir1.2-webkit2-4.0"
        fi
        exit 1
    fi
fi

# ─── Launch the GUI installer ────────────────────────────────────
echo "  Launching ContextVolt..."
"$VENV_PYTHON" installer.py
EXIT_CODE=$?

if [ $EXIT_CODE -ne 0 ]; then
    echo ""
    echo "  Installer encountered an error (exit code: $EXIT_CODE)"
    echo ""
fi
