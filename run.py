"""
Context Vault — Application Entry Point.

Starts the FastAPI backend on a background thread, then opens a native
window via pywebview. This is the file that start.bat calls.
"""

import sys
import os
import threading
import time

# Ensure project root is on the path
PROJECT_ROOT = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, PROJECT_ROOT)

# Configure Ollama to use E: drive for models
OLLAMA_MODELS_DIR = os.path.join(PROJECT_ROOT, ".ollama", "models")
os.environ["OLLAMA_MODELS"] = OLLAMA_MODELS_DIR

import uvicorn
import webview

# Import to trigger DB init
from backend.main import app  # noqa: F401


def start_server():
    """Run the FastAPI server in a background thread."""
    uvicorn.run(
        "backend.main:app",
        host="127.0.0.1",
        port=8000,
        log_level="warning",
    )


def main():
    # Start FastAPI in background
    server_thread = threading.Thread(target=start_server, daemon=True)
    server_thread.start()

    # Give the server a moment to boot
    time.sleep(1.5)

    # Open native window
    window = webview.create_window(
        title="Context Vault",
        url="http://127.0.0.1:8000",
        width=1200,
        height=800,
        min_size=(800, 600),
        background_color="#0a0a0f",
        text_select=True,
    )

    # Start the webview event loop (blocks until window is closed)
    webview.start(debug=False)

    # When window is closed, exit
    sys.exit(0)


if __name__ == "__main__":
    main()
