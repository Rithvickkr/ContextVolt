# Context Vault

A desktop application for saving, summarizing, and repurposing AI conversations using a self-hosted local LLM.

Everything runs 100% locally on your machine. No cloud APIs, no data leaves your device.

---

## What It Does

1. **Save** conversations from ChatGPT, Claude, and more via browser extension
2. **Summarize** automatically using a local LLM via Ollama
3. **Store** summaries in a local context library (SQLite)
4. **Generate** structured continuation prompts
5. **Continue** the conversation in any other LLM

---

## Install

### Windows

**Option A — Installer (.exe)**
Download `ConVX-Setup.exe` from the [Releases](https://github.com/Rithvickkr/ConVX/releases) page.

**Option B — From source**
```
git clone https://github.com/Rithvickkr/ConVX.git
cd ConVX
start.bat
```

### macOS / Linux

```bash
curl -fsSL https://raw.githubusercontent.com/Rithvickkr/ConVX/main/install.sh | bash
```

This installs to `~/.convx` and creates a `convx` command. To launch anytime:
```bash
convx
```

### Prerequisites

- **Python 3.10+** — [python.org](https://www.python.org/downloads/) or `brew install python`
- **Git** — pre-installed on macOS (`xcode-select --install` if missing)

Ollama and the AI model are installed automatically during setup.

---

## Browser Extension

The browser extension captures conversations from **ChatGPT** and **Claude** with one click.

After running the installer, load it manually:
1. Open `chrome://extensions` (or `edge://extensions`)
2. Enable **Developer Mode**
3. Click **Load unpacked** → select the `extension/` folder

---

## Project Structure

```
ConVX/
├── start.bat              # Windows launcher
├── start.sh               # macOS/Linux launcher
├── install.sh             # One-line installer for Mac/Linux
├── run.py                 # Entry point (FastAPI + pywebview)
├── installer.py           # GUI setup wizard
├── requirements.txt       # Python dependencies
├── backend/
│   ├── main.py            # FastAPI server + all API routes
│   ├── database.py        # SQLite CRUD operations
│   ├── ollama_client.py   # Ollama REST API client
│   └── models.py          # Pydantic schemas
├── frontend/
│   ├── index.html         # App shell
│   ├── installer.html     # Setup wizard UI
│   ├── css/               # Dark theme + glassmorphism
│   └── js/app.js          # SPA logic
├── extension/             # Chrome/Edge browser extension
├── vscode-extension/      # VS Code sidebar extension
└── installer/             # Windows .exe build scripts
```

---

## Tech Stack

| Component | Technology |
|-----------|-----------|
| Backend | Python FastAPI |
| Frontend | Vanilla HTML/CSS/JS |
| Desktop Window | PyWebView (native OS WebView) |
| Database | SQLite |
| Local LLM | Ollama (phi3 model) |

---

## API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/health` | Health check |
| GET | `/api/setup/status` | Setup wizard status |
| POST | `/api/setup/pull-model` | Trigger model download |
| POST | `/api/summarize` | Summarize conversation via Ollama |
| POST | `/api/contexts` | Create new context |
| GET | `/api/contexts` | List all (supports `?q=` search) |
| GET | `/api/contexts/{id}` | Get single context |
| PUT | `/api/contexts/{id}` | Update context |
| DELETE | `/api/contexts/{id}` | Delete context |
| POST | `/api/contexts/{id}/prompt` | Generate continuation prompt |
| GET | `/api/contexts/{id}/export` | Export as Markdown |

---

## Configuration

To use a different model, edit `DEFAULT_MODEL` in `backend/ollama_client.py`:

```python
DEFAULT_MODEL = "mistral"   # or "llama3", "gemma2", etc.
```

---

## License

MIT
