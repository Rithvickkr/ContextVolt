<p align="center">
  <img src="main%20icon/CVsvg.svg" width="90" alt="ContextVolt Logo" />
</p>

<h1 align="center">ContextVolt</h1>

<p align="center">
  <strong>Save, summarize, and continue AI conversations across any LLM.</strong><br/>
  Self-hosted · 100% local · No cloud required · Your data stays on your device.
</p>

<p align="center">
  <a href="https://github.com/Rithvickkr/ContextVolt/releases"><img src="https://img.shields.io/github/v/release/Rithvickkr/ContextVolt?style=flat-square&color=4f46e5" alt="Latest Release" /></a>
  <img src="https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-blue?style=flat-square" alt="Platform" />
  <img src="https://img.shields.io/badge/license-MIT-green?style=flat-square" alt="License" />
  <img src="https://img.shields.io/badge/python-3.10%2B-yellow?style=flat-square" alt="Python 3.10+" />
</p>

<p align="center">
  <a href="#-features">Features</a> ·
  <a href="#-install">Install</a> ·
  <a href="#-browser-extension">Browser Extension</a> ·
  <a href="#-api-reference">API</a> ·
  <a href="#-tech-stack">Tech Stack</a>
</p>

---

## What is ContextVolt?

ContextVolt is a **local-first context manager for AI conversations**. It captures your chats from ChatGPT, Claude, Gemini, and more, summarizes them with a local or cloud LLM, and lets you pick up any conversation — in any AI tool — right where you left off.

No accounts. No API keys required. No data sent anywhere. Everything runs on your machine.

---

## Features

- **One-click capture** — Browser extension grabs full conversations from ChatGPT, Claude, and more
- **Local summarization** — Powered by [Ollama](https://ollama.com) (phi3, Mistral, Llama 3, Gemma 2, and others)
- **Cloud LLM support** — Optionally route summarization through OpenAI, Anthropic, or Google APIs
- **Semantic search** — Vector-embedded context library with hybrid keyword + semantic retrieval
- **RAG-powered prompts** — Generate structured continuation prompts grounded in your saved context
- **Collections** — Organize contexts into named groups
- **Starred contexts** — Pin your most important conversations
- **Export** — Download any context as Markdown
- **Cross-context Q&A** — Ask questions across multiple saved conversations at once
- **Dark glassmorphism UI** — Clean, native desktop app feel via PyWebView


---

## Install

### Windows

**Option A — Installer (recommended)**

Download [`ContextVolt-Setup.exe`](https://github.com/Rithvickkr/ContextVolt/releases) from the Releases page, run it, and launch from the Desktop shortcut.

**Option B — From source**

```bat
git clone https://github.com/Rithvickkr/ContextVolt.git
cd ContextVolt
start.bat
```

### macOS / Linux

```bash
curl -fsSL https://raw.githubusercontent.com/Rithvickkr/ContextVolt/main/install.sh | bash
```

This clones the project to `~/.contextvolt` and adds a `contextvolt` shell command.

```bash
contextvolt        # launch
```

```bash
cd ~/.contextvolt && git pull    # update
```

### Prerequisites

| Dependency | Required | Notes |
|---|---|---|
| **Python 3.10+** | Yes | [python.org](https://www.python.org/downloads/) or `brew install python` |
| **Git** | Yes | Pre-installed on macOS/Linux. Windows: [git-scm.com](https://git-scm.com/) |
| **Ollama** | Auto-installed | Downloaded automatically on first run |
| **LLM model (phi3)** | Auto-installed | Pulled automatically (~600 MB) |

> Cloud providers (OpenAI, Anthropic, Google) are optional — configure them in-app after setup.

---

## Browser Extension

Capture full AI conversations from your browser with a single click.

**Supported browsers:** Chrome, Edge, Brave, Arc, and any Chromium-based browser

### Install

1. Open `chrome://extensions` (or `edge://extensions`)
2. Enable **Developer Mode** (toggle, top-right)
3. Click **Load unpacked**
4. Select the `extension/` folder from your ContextVolt directory

The extension adds a toolbar button. Click it while viewing a ChatGPT or Claude conversation to send it directly to your ContextVolt library.

> Safari is not supported. macOS users should use Chrome or any Chromium browser.

---

## Configuration

Switch the active LLM model or connect a cloud provider from the in-app settings panel.

To change the default local model, edit `config.json`:

```json
{
  "ollama_model": "mistral"
}
```

Supported local models: `phi3`, `mistral`, `llama3`, `gemma2`, and any model available in your local Ollama installation.

To use a cloud provider, open the **Settings** panel in the app and enter your API key. Supported providers:

| Provider | Models |
|---|---|
| OpenAI | GPT-4o, GPT-4 Turbo, GPT-3.5 Turbo |
| Anthropic | Claude 3.5 Sonnet, Claude 3 Haiku |
| Google | Gemini 1.5 Pro, Gemini 1.5 Flash |

Embeddings always run locally via Ollama regardless of the active provider.

---

## API Reference

ContextVolt runs a local FastAPI server at `http://127.0.0.1:8000`.

### Health & Setup

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/health` | Health check |
| `GET` | `/api/setup/status` | Setup wizard status |
| `POST` | `/api/setup/pull-model` | Trigger model download |

### Contexts

| Method | Endpoint | Description |
|---|---|---|
| `POST` | `/api/contexts` | Save a new context |
| `GET` | `/api/contexts` | List all contexts (supports `?q=` search) |
| `GET` | `/api/contexts/{id}` | Get a single context |
| `PUT` | `/api/contexts/{id}` | Update a context |
| `DELETE` | `/api/contexts/{id}` | Delete a context |
| `POST` | `/api/contexts/{id}/prompt` | Generate a continuation prompt |
| `GET` | `/api/contexts/{id}/export` | Export as Markdown |

### Summarization & Search

| Method | Endpoint | Description |
|---|---|---|
| `POST` | `/api/summarize` | Summarize a conversation |
| `POST` | `/api/search/semantic` | Semantic vector search |
| `POST` | `/api/ask` | Cross-context Q&A session |

### Collections

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/collections` | List all collections |
| `POST` | `/api/collections` | Create a collection |
| `PUT` | `/api/collections/{id}` | Update a collection |
| `DELETE` | `/api/collections/{id}` | Delete a collection |

---

## Tech Stack

| Layer | Technology |
|---|---|
| Backend | Python, FastAPI |
| Frontend | Vanilla HTML / CSS / JS, dark glassmorphism UI |
| Desktop shell | PyWebView (native OS WebView) |
| Database | SQLite |
| Local LLM & embeddings | Ollama |
| Cloud LLM routing | OpenAI / Anthropic / Google APIs (optional) |
| Browser extension | Chrome Manifest V3 |
| Installer (Windows) | Inno Setup |

---

## Project Structure

```
ContextVolt/
├── run.py                 # Entry point — FastAPI + PyWebView
├── installer.py           # GUI setup wizard
├── start.bat              # Windows launcher
├── start.sh               # macOS / Linux launcher
├── install.sh             # One-line curl installer
├── requirements.txt
├── config.json            # Runtime config (model, provider, etc.)
├── backend/
│   ├── main.py            # FastAPI routes
│   ├── database.py        # SQLite — contexts, chunks, collections, sessions
│   ├── ollama_client.py   # Local LLM + embeddings
│   ├── cloud_client.py    # OpenAI / Anthropic / Google routing
│   ├── llm_router.py      # Provider selection layer
│   └── models.py          # Pydantic schemas
├── frontend/
│   ├── index.html         # Main dashboard
│   ├── installer.html     # Setup wizard UI
│   ├── css/               # Styles
│   └── js/app.js          # SPA logic
├── extension/             # Chrome / Edge browser extension
└── installer/             # Windows .exe build artifacts (Inno Setup)
```

---

## License

[MIT](LICENSE)

---

<p align="center">
  Built with ❤️ by <a href="https://github.com/Rithvickkr">Rithvick</a>
</p>
