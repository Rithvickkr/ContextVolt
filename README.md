# Context Vault

A desktop application for saving, summarizing, and repurposing AI conversations using a self-hosted local LLM.

**Double-click `start.bat` and everything sets up automatically.**

---

## What It Does

1. **Paste** any AI conversation (ChatGPT, Claude, Gemini, etc.)
2. **Summarize** automatically using a local LLM via Ollama
3. **Store** summaries in a local context library (SQLite)
4. **Generate** structured continuation prompts
5. **Copy** the prompt and continue the conversation in any other LLM

Everything runs 100% locally on your machine. No cloud APIs, no data leaves your device.

---

## Quick Start

### Prerequisites

- **Python 3.10+** — [Download](https://www.python.org/downloads/) (check "Add to PATH" during install)

That's it. **Ollama and the AI model are installed automatically.**

### Run

```
Double-click:  start.bat
```

The script will:
1. ✅ Check Python
2. ✅ Install Python dependencies (`fastapi`, `pywebview`, etc.)
3. ✅ Check/install Ollama (downloads installer if needed)
4. ✅ Start Ollama service
5. ✅ Begin pulling the AI model (phi3) in background
6. 🚀 Launch Context Vault in a native window

A **Setup Wizard** inside the app shows real-time progress while the model downloads.

---

## Manual Run (Alternative)

```bash
# Install dependencies
pip install -r requirements.txt

# Make sure Ollama is running with phi3
ollama serve          # (in one terminal)
ollama pull phi3      # (in another terminal)

# Launch the app
python run.py
```

---

## Project Structure

```
ConVX/
├── start.bat              # One-click launcher
├── run.py                 # Entry point (FastAPI + pywebview)
├── requirements.txt       # Python dependencies
├── backend/
│   ├── main.py            # FastAPI server + all API routes
│   ├── database.py        # SQLite CRUD operations
│   ├── ollama_client.py   # Ollama REST API client
│   └── models.py          # Pydantic schemas
└── frontend/
    ├── index.html         # App shell
    ├── css/styles.css     # Dark theme + glassmorphism
    └── js/app.js          # SPA logic
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
