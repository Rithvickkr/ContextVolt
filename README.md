<p align="center">
  <img src="main%20icon/CVsvg.svg" width="80" alt="ContextVolt Logo" />
</p>

<h1 align="center">ContextVolt</h1>

<p align="center">
  <strong>Save, summarize, and continue AI conversations across any LLM.</strong><br/>
  Self-hosted · 100% local · No cloud APIs · Your data stays on your device.
</p>

<p align="center">
  <a href="#install">Install</a> ·
  <a href="#how-it-works">How It Works</a> ·
  <a href="#browser-extension">Extension</a> ·
  <a href="#tech-stack">Tech Stack</a> ·
  <a href="#api">API</a>
</p>

---

## How It Works

1. **Save** conversations from ChatGPT, Claude, and more — via browser extension or paste
2. **Summarize** automatically using a local LLM (Ollama)
3. **Store** summaries in a searchable context library
4. **Generate** structured continuation prompts
5. **Continue** the conversation in any other LLM — with full context

> No accounts. No API keys. No data collection. Everything runs on your machine.

---

## Install

### Windows

**Option A — Installer**

Download [`ContextVolt-Setup.exe`](https://github.com/Rithvickkr/ContextVolt/releases) from the Releases page → run it → launch from Desktop shortcut.

**Option B — From source**

```
git clone https://github.com/Rithvickkr/ContextVolt.git
cd ContextVolt
start.bat
```

### macOS / Linux

```bash
curl -fsSL https://raw.githubusercontent.com/Rithvickkr/ContextVolt/main/install.sh | bash
```

This clones the project to `~/.contextvolt` and creates a `contextvolt` command. To launch anytime:

```bash
contextvolt
```

To update:

```bash
cd ~/.contextvolt && git pull
```

### Prerequisites

|                     | Required                                                                    | Auto-installed                          |
| ------------------- | --------------------------------------------------------------------------- | --------------------------------------- |
| **Python 3.10+**    | ✅ [python.org](https://www.python.org/downloads/) or `brew install python` | —                                       |
| **Git**             | ✅ Pre-installed on macOS. Windows: [git-scm.com](https://git-scm.com/)     | —                                       |
| **Ollama**          | —                                                                           | ✅ Downloaded & installed automatically |
| **AI Model (phi3)** | —                                                                           | ✅ Pulled automatically (~600MB)        |

---

## Browser Extension

The browser extension lets you capture full conversations from **ChatGPT** and **Claude** with one click.

**Supported browsers:** Chrome, Edge, Brave, Arc (Chromium-based)

### Install the extension

1. Open `chrome://extensions` (or `edge://extensions`)
2. Enable **Developer Mode** (toggle in top-right)
3. Click **Load unpacked**
4. Select the `extension/` folder from your ContextVolt directory

> **macOS users:** Safari is not supported. Use Chrome or any Chromium browser — most Mac developers already have one installed.

---

## VS Code Extension

Use your saved contexts directly in VS Code.

1. Open the `vscode-extension/` folder in VS Code
2. Press **F5** to launch the Extension Development Host
3. Click the 📖 icon in the sidebar to browse your contexts
4. Click any context to insert the continuation prompt at your cursor

---

## Tech Stack

| Component         | Technology                                         |
| ----------------- | -------------------------------------------------- |
| Backend           | Python, FastAPI                                    |
| Frontend          | Vanilla HTML/CSS/JS, Dark theme with glassmorphism |
| Desktop Window    | PyWebView (native OS WebView)                      |
| Database          | SQLite                                             |
| Local LLM         | Ollama (phi3)                                      |
| Browser Extension | Chrome Manifest V3                                 |

---

## API

ContextVolt runs a local FastAPI server on `http://127.0.0.1:8000`.

| Method   | Endpoint                    | Description                               |
| -------- | --------------------------- | ----------------------------------------- |
| `GET`    | `/api/health`               | Health check                              |
| `GET`    | `/api/setup/status`         | Setup wizard status                       |
| `POST`   | `/api/setup/pull-model`     | Trigger model download                    |
| `POST`   | `/api/summarize`            | Summarize conversation via Ollama         |
| `POST`   | `/api/contexts`             | Save a new context                        |
| `GET`    | `/api/contexts`             | List all contexts (supports `?q=` search) |
| `GET`    | `/api/contexts/{id}`        | Get a single context                      |
| `PUT`    | `/api/contexts/{id}`        | Update a context                          |
| `DELETE` | `/api/contexts/{id}`        | Delete a context                          |
| `POST`   | `/api/contexts/{id}/prompt` | Generate continuation prompt              |
| `GET`    | `/api/contexts/{id}/export` | Export as Markdown                        |

---

## Configuration

To use a different LLM model, edit `OLLAMA_MODEL` in `installer.py`:

```python
OLLAMA_MODEL = "mistral"   # or "llama3", "gemma2", "phi3", etc.
```

---

## Project Structure

```
ContextVolt/
├── start.bat              # Windows launcher
├── start.sh               # macOS / Linux launcher
├── install.sh             # One-line Mac/Linux installer (curl | bash)
├── run.py                 # App entry point (FastAPI + PyWebView)
├── installer.py           # GUI setup wizard (cross-platform)
├── requirements.txt
├── backend/
│   ├── main.py            # FastAPI server + routes
│   ├── database.py        # SQLite operations
│   ├── ollama_client.py   # Ollama API client
│   └── models.py          # Pydantic schemas
├── frontend/
│   ├── index.html         # Dashboard
│   ├── installer.html     # Setup wizard UI
│   ├── css/               # Styles (dark theme + glassmorphism)
│   └── js/app.js          # SPA logic
├── extension/             # Chrome / Edge browser extension
├── vscode-extension/      # VS Code sidebar extension
└── installer/             # Windows .exe build (Inno Setup)
```

---

## License

MIT

---

<p align="center">
  Built with ❤️ by <a href="https://github.com/Rithvickkr">Rithvick</a>
</p>
