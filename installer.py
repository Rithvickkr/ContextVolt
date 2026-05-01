"""
ContextVolt — Professional Installer

A GUI-based installer that replaces the console setup experience.
Shows a sleek, step-by-step installation UI using pywebview.
"""

import os
import sys
import subprocess
import threading
import time
import json
import shutil
from pathlib import Path

import webview

# ─── Windows taskbar icon fix ─────────────────────────────────────
if sys.platform == "win32":
    try:
        import ctypes
        ctypes.windll.shell32.SetCurrentProcessExplicitAppUserModelID("ContextVolt.App.1")
    except Exception:
        pass

# ─────────────────────────────────────────────────────────────────
# Configuration
# ─────────────────────────────────────────────────────────────────

IS_WINDOWS = sys.platform == "win32"
IS_MAC = sys.platform == "darwin"

PROJECT_ROOT = Path(__file__).parent.absolute()
VENV_PATH = PROJECT_ROOT / "venv"
VENV_PYTHON = VENV_PATH / ("Scripts/python.exe" if IS_WINDOWS else "bin/python3")
VENV_PIP = VENV_PATH / ("Scripts/pip.exe" if IS_WINDOWS else "bin/pip3")
REQUIREMENTS_FILE = PROJECT_ROOT / "requirements.txt"
OLLAMA_MODEL = "qwen2.5:3b"  # Default; user selects during setup. Options: 1.5b/3b/7b
EMBED_MODEL = "nomic-embed-text"  # Default; user selects during setup

AVAILABLE_MODELS = [
    {
        "id": "llama3.2:3b",
        "name": "Llama 3.2 3B",
        "size": "~2 GB",
        "description": "Recommended — strong JSON adherence, faithful summaries, 128k context",
        "recommended": True,
    },
    {
        "id": "qwen3:4b",
        "name": "Qwen 3 4B",
        "size": "~2.6 GB",
        "description": "Highest quality — newest reasoning model, beats Qwen 2.5 7B at half the size",
        "recommended": False,
    },
    {
        "id": "qwen2.5:3b",
        "name": "Qwen 2.5 3B",
        "size": "~2 GB",
        "description": "Stable fallback — proven, multilingual, runs on most hardware",
        "recommended": False,
    },
    {
        "id": "qwen2.5:7b",
        "name": "Qwen 2.5 7B",
        "size": "~5 GB",
        "description": "High quality — richer summaries, needs 6 GB+ VRAM or 8 GB+ RAM",
        "recommended": False,
    },
    {
        "id": "qwen2.5:1.5b",
        "name": "Qwen 2.5 1.5B",
        "size": "~1 GB",
        "description": "Lightweight — minimal hardware, basic summary quality",
        "recommended": False,
    },
]

AVAILABLE_EMBED_MODELS = [
    {
        "id": "qwen3-embedding:0.6b",
        "name": "Qwen 3 Embedding 0.6B",
        "size": "~640 MB",
        "description": "Recommended — current SOTA local retrieval, top of MTEB at this size",
        "recommended": True,
    },
    {
        "id": "mxbai-embed-large",
        "name": "MixedBread Large",
        "size": "~670 MB",
        "description": "High-quality English embeddings — strong semantic search accuracy",
        "recommended": False,
    },
    {
        "id": "nomic-embed-text",
        "name": "Nomic Embed Text",
        "size": "~274 MB",
        "description": "Fast and accurate — small footprint, good baseline",
        "recommended": False,
    },
    {
        "id": "nomic-embed-text:v1.5",
        "name": "Nomic Embed v1.5",
        "size": "~274 MB",
        "description": "Improved Nomic with Matryoshka representation support",
        "recommended": False,
    },
    {
        "id": "bge-m3",
        "name": "BGE-M3",
        "size": "~1.2 GB",
        "description": "Multilingual support — best for non-English content",
        "recommended": False,
    },
]

# Store Ollama models within the project folder
OLLAMA_DIR = PROJECT_ROOT / ".ollama"
OLLAMA_MODELS_DIR = OLLAMA_DIR / "models"

# Detect if running from embedded/bundled Python (no venv module)
def is_embedded_python():
    try:
        import venv  # noqa: F401
        return False
    except ImportError:
        return True

EMBEDDED_MODE = is_embedded_python()


# ─────────────────────────────────────────────────────────────────
# Installation State & Logic
# ─────────────────────────────────────────────────────────────────

class InstallState:
    """Holds installation state."""
    def __init__(self):
        self.steps = [
            {"id": "python", "label": "Python Environment", "status": "pending"},
            {"id": "venv", "label": "Virtual Environment", "status": "pending"},
            {"id": "deps", "label": "Dependencies", "status": "pending"},
            {"id": "ollama", "label": "Ollama Service", "status": "pending"},
            {"id": "model", "label": "AI Model", "status": "pending"},
            {"id": "embed", "label": "Embed Model", "status": "pending"},
            {"id": "extension", "label": "Browser Extension", "status": "pending"},
        ]
        self.logs = []
        self.log_cursor = 0
        self.current_step = 0
        self.is_installing = False
        self.has_error = False
        self.error_step = None
        self.installation_complete = False
        self.window = None

    def log(self, message):
        timestamp = time.strftime("%H:%M:%S")
        self.logs.append({"time": timestamp, "message": message})


# Global state instance
state = InstallState()


def run_installation():
    """Execute all installation steps sequentially."""
    def step_check_python():
        state.log("Checking Python environment...")
        version = sys.version.split()[0]
        state.log(f"  Python {version} detected")
        return True

    def step_create_venv():
        if EMBEDDED_MODE:
            state.log("Using bundled Python — skipping venv")
            return True
        state.log("Setting up virtual environment...")
        if VENV_PYTHON.exists():
            state.log("  Virtual environment already exists")
            return True
        state.log("  Creating new virtual environment...")
        result = subprocess.run(
            [sys.executable, "-m", "venv", str(VENV_PATH)],
            capture_output=True, text=True, cwd=str(PROJECT_ROOT)
        )
        if result.returncode != 0:
            state.log(f"  Error: {result.stderr}")
            return False
        state.log("  Virtual environment created")
        return True

    def step_install_deps():
        if EMBEDDED_MODE:
            state.log("Dependencies pre-installed — verifying...")
            try:
                import fastapi, uvicorn, webview, numpy, sqlite_vec  # noqa: F401
                state.log("  All dependencies verified ✓")
                return True
            except ImportError as e:
                state.log(f"  Missing: {e.name} — installing...")
                # Fall through to pip install below
        else:
            state.log("Installing dependencies...")
        if not REQUIREMENTS_FILE.exists():
            state.log("  requirements.txt not found")
            return False
        with open(REQUIREMENTS_FILE, "r") as f:
            deps = [l.strip() for l in f if l.strip() and not l.startswith("#")]
        state.log(f"  Installing {len(deps)} packages...")
        pip_exe = str(VENV_PIP) if not EMBEDDED_MODE else sys.executable
        pip_args = (
            [pip_exe, "install", "-r", str(REQUIREMENTS_FILE), "--quiet", "--disable-pip-version-check"]
            if not EMBEDDED_MODE else
            [pip_exe, "-m", "pip", "install", "-r", str(REQUIREMENTS_FILE), "--quiet", "--disable-pip-version-check"]
        )
        result = subprocess.run(
            pip_args,
            capture_output=True, text=True, cwd=str(PROJECT_ROOT)
        )
        if result.returncode != 0:
            state.log(f"  Error: {result.stderr[:200]}")
            return False
        state.log("  Dependencies installed successfully")
        return True

    def step_check_ollama():
        state.log("Checking Ollama...")
        
        # Configure Ollama models path
        state.log(f"  Setting models path: {OLLAMA_MODELS_DIR}")
        OLLAMA_MODELS_DIR.mkdir(parents=True, exist_ok=True)
        os.environ["OLLAMA_MODELS"] = str(OLLAMA_MODELS_DIR)
        
        # Persist env var (Windows: registry, Mac: shell profile)
        if IS_WINDOWS:
            try:
                import winreg
                env_key = winreg.OpenKey(
                    winreg.HKEY_CURRENT_USER, r"Environment",
                    0, winreg.KEY_ALL_ACCESS
                )
                winreg.SetValueEx(env_key, "OLLAMA_MODELS", 0, winreg.REG_SZ, str(OLLAMA_MODELS_DIR))
                winreg.CloseKey(env_key)
                state.log("  Configured models storage path")
            except Exception as e:
                state.log(f"  Note: Could not persist env var: {str(e)[:30]}")
        else:
            # macOS/Linux: add to shell profile
            try:
                profile = Path.home() / (".zshrc" if IS_MAC else ".bashrc")
                export_line = f'export OLLAMA_MODELS="{OLLAMA_MODELS_DIR}"'
                if profile.exists():
                    content = profile.read_text()
                    if "OLLAMA_MODELS" not in content:
                        with open(profile, "a") as f:
                            f.write(f"\n# ContextVolt Ollama models path\n{export_line}\n")
                        state.log(f"  Added OLLAMA_MODELS to {profile.name}")
                    else:
                        state.log(f"  OLLAMA_MODELS already in {profile.name}")
                else:
                    state.log("  Shell profile not found, env var set for this session")
            except Exception:
                pass
        
        # Find Ollama executable
        ollama_path = shutil.which("ollama")
        if not ollama_path and IS_WINDOWS:
            local = Path(os.environ.get("LOCALAPPDATA", "")) / "Programs" / "Ollama" / "ollama.exe"
            if local.exists():
                ollama_path = str(local)
        if not ollama_path and IS_MAC:
            # Common Homebrew / manual install paths on macOS
            for p in ["/usr/local/bin/ollama", "/opt/homebrew/bin/ollama"]:
                if Path(p).exists():
                    ollama_path = p
                    break
        
        if not ollama_path:
            state.log("  Ollama not found, downloading...")
            try:
                import urllib.request
                import tempfile
                
                if IS_WINDOWS:
                    installer_url = "https://ollama.com/download/OllamaSetup.exe"
                    installer_path = Path(tempfile.gettempdir()) / "OllamaSetup.exe"
                    state.log("  Downloading from ollama.com...")
                    urllib.request.urlretrieve(installer_url, str(installer_path))
                    if installer_path.exists():
                        state.log("  Installing Ollama silently...")
                        install_env = os.environ.copy()
                        install_env["OLLAMA_MODELS"] = str(OLLAMA_MODELS_DIR)
                        subprocess.run(
                            [str(installer_path), "/S"],
                            capture_output=True, timeout=120, env=install_env,
                        )
                        time.sleep(3)
                        try:
                            installer_path.unlink()
                        except Exception:
                            pass
                        local = Path(os.environ.get("LOCALAPPDATA", "")) / "Programs" / "Ollama" / "ollama.exe"
                        if local.exists():
                            ollama_path = str(local)
                            state.log("  Ollama installed successfully")
                        else:
                            state.log("  Please install manually from ollama.com")
                            return True
                    else:
                        state.log("  Download failed. Install from ollama.com")
                        return True
                else:
                    # macOS / Linux: use the official install script
                    state.log("  Running Ollama install script...")
                    result = subprocess.run(
                        ["bash", "-c", "curl -fsSL https://ollama.com/install.sh | sh"],
                        capture_output=True, text=True, timeout=180,
                    )
                    if result.returncode == 0:
                        ollama_path = shutil.which("ollama")
                        if ollama_path:
                            state.log("  Ollama installed successfully")
                        else:
                            state.log("  Install completed but ollama not found in PATH")
                            state.log("  Try: brew install ollama")
                            return True
                    else:
                        state.log("  Install script failed")
                        state.log("  Try: brew install ollama")
                        return True
                    
            except subprocess.TimeoutExpired:
                state.log("  Installation timed out")
                state.log("  Please install manually from ollama.com")
                return True
            except Exception as e:
                state.log(f"  Could not install Ollama: {str(e)[:50]}")
                state.log("  Please install manually from ollama.com")
                return True
        
        if ollama_path:
            state.log(f"  Ollama found")
            
            # Windows-only: disable auto-start and kill tray process
            if IS_WINDOWS:
                try:
                    import winreg
                    startup_key = winreg.OpenKey(
                        winreg.HKEY_CURRENT_USER,
                        r"Software\\Microsoft\\Windows\\CurrentVersion\\Run",
                        0, winreg.KEY_ALL_ACCESS
                    )
                    try:
                        winreg.DeleteValue(startup_key, "Ollama")
                        state.log("  Disabled Ollama auto-start")
                    except FileNotFoundError:
                        pass
                    winreg.CloseKey(startup_key)
                except Exception:
                    pass
                
                try:
                    subprocess.run(
                        ["taskkill", "/F", "/IM", "Ollama.exe"],
                        capture_output=True, creationflags=subprocess.CREATE_NO_WINDOW
                    )
                except Exception:
                    pass
            
            # Prepare environment
            ollama_env = os.environ.copy()
            ollama_env["OLLAMA_MODELS"] = str(OLLAMA_MODELS_DIR)
            
            # Start Ollama service if not running
            try:
                import urllib.request
                urllib.request.urlopen("http://localhost:11434/api/tags", timeout=2)
                state.log("  Ollama API is running")
            except Exception:
                state.log("  Starting Ollama service...")
                popen_kwargs = {
                    "stdout": subprocess.DEVNULL,
                    "stderr": subprocess.DEVNULL,
                    "stdin": subprocess.DEVNULL,
                    "env": ollama_env,
                }
                if IS_WINDOWS:
                    popen_kwargs["creationflags"] = subprocess.CREATE_NO_WINDOW | subprocess.DETACHED_PROCESS
                subprocess.Popen([ollama_path, "serve"], **popen_kwargs)
                time.sleep(3)
                state.log("  Ollama API started")
        return True

    def step_pull_model():
        state.log(f"Checking AI model ({OLLAMA_MODEL})...")
        ollama_path = shutil.which("ollama")
        if not ollama_path and IS_WINDOWS:
            local = Path(os.environ.get("LOCALAPPDATA", "")) / "Programs" / "Ollama" / "ollama.exe"
            if local.exists():
                ollama_path = str(local)
        if not ollama_path and IS_MAC:
            for p in ["/usr/local/bin/ollama", "/opt/homebrew/bin/ollama"]:
                if Path(p).exists():
                    ollama_path = p
                    break
        if not ollama_path:
            state.log("  Ollama not available, skipping model pull")
            state.log(f"  You can pull the model later with: ollama pull {OLLAMA_MODEL}")
            return True
        
        # Environment with E: drive models path
        ollama_env = os.environ.copy()
        ollama_env["OLLAMA_MODELS"] = str(OLLAMA_MODELS_DIR)
        
        # Make sure Ollama service is running
        import urllib.request
        service_running = False
        for attempt in range(5):
            try:
                urllib.request.urlopen("http://localhost:11434/api/tags", timeout=2)
                service_running = True
                break
            except Exception:
                if attempt == 0:
                    state.log("  Starting Ollama service...")
                    serve_kwargs = {
                        "stdout": subprocess.DEVNULL,
                        "stderr": subprocess.DEVNULL,
                        "env": ollama_env,
                    }
                    if IS_WINDOWS:
                        serve_kwargs["creationflags"] = subprocess.CREATE_NO_WINDOW
                    subprocess.Popen([ollama_path, "serve"], **serve_kwargs)
                time.sleep(2)
        
        if not service_running:
            state.log("  Could not start Ollama service")
            state.log(f"  You can pull the model later with: ollama pull {OLLAMA_MODEL}")
            return True
        
        # Check if model already exists
        try:
            with urllib.request.urlopen("http://localhost:11434/api/tags", timeout=5) as r:
                data = json.loads(r.read().decode())
                installed_names = [m.get("name", "") for m in data.get("models", [])]
                # Match full name ("qwen2.5:7b") OR base name ("phi3" matching "phi3:latest")
                already_installed = any(
                    name == OLLAMA_MODEL
                    or name.startswith(OLLAMA_MODEL + ":")
                    or name.split(":")[0] == OLLAMA_MODEL
                    for name in installed_names
                )
                if already_installed:
                    state.log(f"  Model {OLLAMA_MODEL} already installed")
                    state.log(f"  Models stored at: {OLLAMA_MODELS_DIR}")
                    return True
        except Exception as e:
            state.log(f"  Could not check models: {str(e)[:30]}")

        # Pull the model
        size_hint = next((m["size"] for m in AVAILABLE_MODELS if m["id"] == OLLAMA_MODEL), "?")
        state.log(f"  Pulling {OLLAMA_MODEL} ({size_hint}, this may take a few minutes)...")
        try:
            process = subprocess.Popen(
                [ollama_path, "pull", OLLAMA_MODEL],
                stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                encoding='utf-8', errors='replace',  # type: ignore[call-overload]
                env=ollama_env,
                **(dict(creationflags=subprocess.CREATE_NO_WINDOW) if IS_WINDOWS else {})
            )

            # Ollama uses \r for in-place progress updates — read char-by-char
            last_log: str = ""
            buf: str = ""
            stdout = process.stdout
            if stdout is not None:
                while True:
                    ch: str = str(stdout.read(1))
                    if not ch:
                        if process.poll() is not None:
                            break
                        continue
                    if ch in ('\n', '\r'):
                        line: str = str(buf).strip()
                        buf = ""
                        if line and line != last_log:
                            state.log("  " + line[0:80])  # type: ignore[index]
                            last_log = line
                    else:
                        buf = buf + ch
                # Flush any remaining buffer
                flushed: str = str(buf).strip()
                if flushed and flushed != last_log:
                    state.log("  " + flushed[0:80])  # type: ignore[index]

            if process.returncode == 0:
                state.log(f"  Model {OLLAMA_MODEL} ready!")
                state.log(f"  Stored at: {OLLAMA_MODELS_DIR}")
            else:
                state.log(f"  Model pull failed (exit code: {process.returncode})")
                state.log(f"  You can retry with: ollama pull {OLLAMA_MODEL}")
        except Exception as e:
            state.log(f"  Error pulling model: {str(e)[:80]}")
            state.log(f"  You can retry manually with: ollama pull {OLLAMA_MODEL}")

        return True

    def step_pull_embed_model():
        state.log(f"Checking embedding model ({EMBED_MODEL})...")
        ollama_path = shutil.which("ollama")
        if not ollama_path and IS_WINDOWS:
            local = Path(os.environ.get("LOCALAPPDATA", "")) / "Programs" / "Ollama" / "ollama.exe"
            if local.exists():
                ollama_path = str(local)
        if not ollama_path and IS_MAC:
            for p in ["/usr/local/bin/ollama", "/opt/homebrew/bin/ollama"]:
                if Path(p).exists():
                    ollama_path = p
                    break
        if not ollama_path:
            state.log("  Ollama not available, skipping embed model pull")
            state.log(f"  You can pull it later with: ollama pull {EMBED_MODEL}")
            return True

        ollama_env = os.environ.copy()
        ollama_env["OLLAMA_MODELS"] = str(OLLAMA_MODELS_DIR)

        import urllib.request
        service_running = False
        for attempt in range(5):
            try:
                urllib.request.urlopen("http://localhost:11434/api/tags", timeout=2)
                service_running = True
                break
            except Exception:
                if attempt == 0:
                    state.log("  Starting Ollama service...")
                    serve_kwargs = {"stdout": subprocess.DEVNULL, "stderr": subprocess.DEVNULL, "env": ollama_env}
                    if IS_WINDOWS:
                        serve_kwargs["creationflags"] = subprocess.CREATE_NO_WINDOW
                    subprocess.Popen([ollama_path, "serve"], **serve_kwargs)
                time.sleep(2)

        if not service_running:
            state.log("  Could not start Ollama service")
            state.log(f"  You can pull it later with: ollama pull {EMBED_MODEL}")
            return True

        # Check if already installed
        try:
            with urllib.request.urlopen("http://localhost:11434/api/tags", timeout=5) as r:
                data = json.loads(r.read().decode())
                installed_names = [m.get("name", "") for m in data.get("models", [])]
                already_installed = any(
                    name == EMBED_MODEL
                    or name.startswith(EMBED_MODEL + ":")
                    or name.split(":")[0] == EMBED_MODEL
                    for name in installed_names
                )
                if already_installed:
                    state.log(f"  {EMBED_MODEL} already installed")
                    return True
        except Exception as e:
            state.log(f"  Could not check models: {str(e)[:30]}")

        # Pull with real-time progress
        size_hint = next((m["size"] for m in AVAILABLE_EMBED_MODELS if m["id"] == EMBED_MODEL), "?")
        state.log(f"  Pulling {EMBED_MODEL} ({size_hint})...")
        try:
            process = subprocess.Popen(
                [ollama_path, "pull", EMBED_MODEL],
                stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                encoding='utf-8', errors='replace',  # type: ignore[call-overload]
                env=ollama_env,
                **(dict(creationflags=subprocess.CREATE_NO_WINDOW) if IS_WINDOWS else {})
            )
            last_log: str = ""
            buf: str = ""
            stdout = process.stdout
            if stdout is not None:
                while True:
                    ch: str = str(stdout.read(1))
                    if not ch:
                        if process.poll() is not None:
                            break
                        continue
                    if ch in ('\n', '\r'):
                        line: str = str(buf).strip()
                        buf = ""
                        if line and line != last_log:
                            state.log("  " + line[:80])
                            last_log = line
                    else:
                        buf = buf + ch
                flushed: str = str(buf).strip()
                if flushed and flushed != last_log:
                    state.log("  " + flushed[:80])

            if process.returncode == 0:
                state.log(f"  {EMBED_MODEL} ready!")
            else:
                state.log(f"  Pull failed (exit code: {process.returncode})")
                state.log(f"  You can retry with: ollama pull {EMBED_MODEL}")
        except Exception as e:
            state.log(f"  Error pulling model: {str(e)[:80]}")
            state.log(f"  You can retry manually with: ollama pull {EMBED_MODEL}")

        return True

    def step_install_extension():
        state.log("Setting up browser extension...")
        ext_dir = PROJECT_ROOT / "extension"
        if not ext_dir.exists():
            state.log("  Extension folder not found, skipping")
            return True

        ext_path = str(ext_dir.resolve())
        # Escape backslashes for embedding in JS strings
        ext_path_js = ext_path.replace("\\", "\\\\")

        # Write a local HTML guide that opens in the browser
        guide_path = PROJECT_ROOT / "extension_install_guide.html"
        # Load the standalone guide template and substitute the actual extension path.
        guide_template_path = PROJECT_ROOT / "extension_install_guide.html"
        try:
            template = guide_template_path.read_text(encoding="utf-8")
        except Exception:
            template = ""
        import re
        guide_html = re.sub(
            r'(<span class="path-text" id="pathText">)[^<]*(</span>)',
            lambda m: m.group(1) + ext_path + m.group(2),
            template, count=1,
        )
        guide_html = re.sub(
            r'(const path = ")[^"]*(";)',
            lambda m: m.group(1) + ext_path_js + m.group(2),
            guide_html, count=1,
        )

        try:
            guide_path.write_text(guide_html, encoding="utf-8")
        except Exception as e:
            state.log(f"  Could not write guide page: {str(e)[:50]}")

        # Open the guide in the default browser
        import webbrowser
        try:
            webbrowser.open(guide_path.as_uri())
            state.log("  Opened install guide in your browser")
        except Exception:
            state.log("  Could not open browser automatically")
            state.log(f"  Open manually: {guide_path}")

        state.log(f"  Extension folder: {ext_path}")
        state.log("  Follow the steps in the browser tab to finish.")

        return True

    steps = [step_check_python, step_create_venv, step_install_deps, step_check_ollama, step_pull_model, step_pull_embed_model, step_install_extension]
    
    try:
        for i in range(state.current_step, len(steps)):
            state.current_step = i
            state.steps[i]["status"] = "running"
            try:
                if steps[i]():
                    state.steps[i]["status"] = "completed"
                else:
                    state.steps[i]["status"] = "error"
                    state.has_error = True
                    state.error_step = i
                    state.is_installing = False
                    return
            except Exception as e:
                state.log(f"Error: {e}")
                state.steps[i]["status"] = "error"
                state.has_error = True
                state.error_step = i
                state.is_installing = False
                return
            time.sleep(0.3)
        
        state.is_installing = False
        state.installation_complete = True
        state.log("Installation complete!")
        # Create marker file so launcher knows to run app directly next time
        try:
            (PROJECT_ROOT / ".installed").write_text("ok")
        except Exception:
            pass
    except Exception as e:
        state.log(f"Installation failed: {e}")
        state.has_error = True
        state.is_installing = False


# ─────────────────────────────────────────────────────────────────
# Minimal API for pywebview (avoids introspection issues)
# ─────────────────────────────────────────────────────────────────

class Api:
    """Minimal API exposed to JavaScript."""
    
    def get_state(self):
        """Get current installation state."""
        new_logs = state.logs[state.log_cursor:]  # type: ignore[index]
        state.log_cursor = len(state.logs)
        return {
            "steps": state.steps,
            "newLogs": new_logs,
            "currentStep": state.current_step,
            "isInstalling": state.is_installing,
            "hasError": state.has_error,
            "errorStep": state.error_step,
            "installationComplete": state.installation_complete,
        }
    
    def get_available_models(self):
        """Return list of available model options."""
        return AVAILABLE_MODELS

    def get_available_embed_models(self):
        """Return list of available embedding model options."""
        return AVAILABLE_EMBED_MODELS

    def get_saved_config(self):
        """Return the currently saved model + embed_model from config.json."""
        global OLLAMA_MODEL, EMBED_MODEL
        config_path = PROJECT_ROOT / "config.json"
        try:
            if config_path.exists():
                with open(config_path, "r", encoding="utf-8") as f:
                    cfg = json.load(f)
                saved_model = cfg.get("model", OLLAMA_MODEL)
                saved_embed = cfg.get("embed_model", EMBED_MODEL)
                # Update globals so installation uses whatever was persisted
                OLLAMA_MODEL = saved_model
                EMBED_MODEL = saved_embed
                return {"model": saved_model, "embed_model": saved_embed}
        except Exception:
            pass
        return {"model": OLLAMA_MODEL, "embed_model": EMBED_MODEL}

    def set_selected_embed_model(self, model_id: str):
        """Set the embedding model to install and persist to config.json."""
        global EMBED_MODEL
        valid_ids = [m["id"] for m in AVAILABLE_EMBED_MODELS]
        if model_id not in valid_ids:
            return {"success": False, "error": "Unknown model"}
        EMBED_MODEL = model_id
        try:
            config_path = PROJECT_ROOT / "config.json"
            config = {}
            if config_path.exists():
                with open(config_path, "r", encoding="utf-8") as f:
                    config = json.load(f)
            config["embed_model"] = model_id  # type: ignore[index]
            with open(config_path, "w", encoding="utf-8") as f:
                json.dump(config, f, indent=2)
        except Exception:
            pass
        return {"success": True}

    def set_cloud_config(self, provider: str, api_key: str, cloud_model: str):
        """Save cloud provider, API key, and model to config.json."""
        try:
            config_path = PROJECT_ROOT / "config.json"
            config = {}
            if config_path.exists():
                with open(config_path, "r", encoding="utf-8") as f:
                    config = json.load(f)
            config["provider"] = provider
            if "cloud_keys" not in config:
                config["cloud_keys"] = {}
            if api_key:
                config["cloud_keys"][provider] = api_key
            if "cloud_models" not in config:
                config["cloud_models"] = {}
            if cloud_model:
                config["cloud_models"][provider] = cloud_model
            with open(config_path, "w", encoding="utf-8") as f:
                json.dump(config, f, indent=2)
        except Exception:
            pass
        return {"success": True}

    def set_selected_model(self, model_id: str):
        """Set the model to install and persist to config.json."""
        global OLLAMA_MODEL
        valid_ids = [m["id"] for m in AVAILABLE_MODELS]
        if model_id not in valid_ids:
            return {"success": False, "error": "Unknown model"}
        OLLAMA_MODEL = model_id
        # Persist to config.json so the backend picks it up at runtime
        try:
            config_path = PROJECT_ROOT / "config.json"
            config = {}
            if config_path.exists():
                with open(config_path, "r", encoding="utf-8") as f:
                    config = json.load(f)
            config["model"] = model_id  # type: ignore[index]
            with open(config_path, "w", encoding="utf-8") as f:
                json.dump(config, f, indent=2)
        except Exception:
            pass
        return {"success": True}

    def start_installation(self):
        """Start installation in background thread."""
        if state.is_installing:
            return {"success": False}
        state.is_installing = True
        state.has_error = False
        state.error_step = None
        threading.Thread(target=run_installation, daemon=True).start()
        return {"success": True}
    
    def retry_from_error(self):
        """Retry from failed step."""
        if state.error_step is not None:
            state.current_step = state.error_step
            state.has_error = False
            state.error_step = None
            for i in range(state.current_step, len(state.steps)):
                state.steps[i]["status"] = "pending"
            return self.start_installation()
        return {"success": False}
    
    def launch_app(self):
        """Launch the main application."""
        state.log("Launching ContextVolt...")
        if EMBEDDED_MODE:
            python_exe = sys.executable
        else:
            # Prefer pythonw.exe (windowless) so no console appears when launching the app
            pythonw = VENV_PATH / ("Scripts/pythonw.exe" if IS_WINDOWS else "bin/python3")
            python_exe = str(pythonw) if pythonw.exists() else str(VENV_PYTHON)
        popen_kwargs = {"cwd": str(PROJECT_ROOT)}
        if IS_WINDOWS:
            popen_kwargs["creationflags"] = subprocess.CREATE_NO_WINDOW
        subprocess.Popen([python_exe, str(PROJECT_ROOT / "run.py")], **popen_kwargs)
        if state.window:
            state.window.destroy()
        return {"success": True}


# ─────────────────────────────────────────────────────────────────
# Main Entry Point
# ─────────────────────────────────────────────────────────────────

def main():
    # If already installed, skip the installer and launch the app directly
    if (PROJECT_ROOT / ".installed").exists():
        if EMBEDDED_MODE:
            python_exe = sys.executable
        else:
            pythonw = VENV_PATH / ("Scripts/pythonw.exe" if IS_WINDOWS else "bin/python3")
            python_exe = str(pythonw) if pythonw.exists() else str(VENV_PYTHON)
        popen_kwargs = {"cwd": str(PROJECT_ROOT)}
        if IS_WINDOWS:
            popen_kwargs["creationflags"] = subprocess.CREATE_NO_WINDOW
        subprocess.Popen([python_exe, str(PROJECT_ROOT / "run.py")], **popen_kwargs)
        return

    api = Api()

    html_path = str(PROJECT_ROOT / "frontend" / "installer.html")
    
    window = webview.create_window(
        title="ContextVolt",
        url=html_path,
        width=880,
        height=600,
        resizable=False,
        background_color="#09090b",
        js_api=api,
    )

    state.window = window

    _icon = str(PROJECT_ROOT / "icon.ico")
    webview.start(icon=_icon if os.path.exists(_icon) else None)


if __name__ == "__main__":
    main()

