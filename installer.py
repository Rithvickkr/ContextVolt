"""
Context Vault — Professional Installer

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

# ─────────────────────────────────────────────────────────────────
# Configuration
# ─────────────────────────────────────────────────────────────────

PROJECT_ROOT = Path(__file__).parent.absolute()
VENV_PATH = PROJECT_ROOT / "venv"
VENV_PYTHON = VENV_PATH / "Scripts" / "python.exe"
VENV_PIP = VENV_PATH / "Scripts" / "pip.exe"
REQUIREMENTS_FILE = PROJECT_ROOT / "requirements.txt"
OLLAMA_MODEL = "phi3"  # Better summarization quality, ~2.2GB

# Store Ollama models on E: drive within the project folder
OLLAMA_DIR = PROJECT_ROOT / ".ollama"
OLLAMA_MODELS_DIR = OLLAMA_DIR / "models"


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
        state.log("Installing dependencies...")
        if not REQUIREMENTS_FILE.exists():
            state.log("  requirements.txt not found")
            return False
        with open(REQUIREMENTS_FILE, "r") as f:
            deps = [l.strip() for l in f if l.strip() and not l.startswith("#")]
        state.log(f"  Installing {len(deps)} packages...")
        result = subprocess.run(
            [str(VENV_PIP), "install", "-r", str(REQUIREMENTS_FILE), "--quiet", "--disable-pip-version-check"],
            capture_output=True, text=True, cwd=str(PROJECT_ROOT)
        )
        if result.returncode != 0:
            state.log(f"  Error: {result.stderr[:200]}")
            return False
        state.log("  Dependencies installed successfully")
        return True

    def step_check_ollama():
        state.log("Checking Ollama...")
        
        # Configure Ollama to store models on E: drive
        state.log(f"  Setting models path: {OLLAMA_MODELS_DIR}")
        OLLAMA_MODELS_DIR.mkdir(parents=True, exist_ok=True)
        
        # Set environment variable for this process
        os.environ["OLLAMA_MODELS"] = str(OLLAMA_MODELS_DIR)
        
        # Set environment variable permanently in Windows registry
        try:
            import winreg
            env_key = winreg.OpenKey(
                winreg.HKEY_CURRENT_USER,
                r"Environment",
                0, winreg.KEY_ALL_ACCESS
            )
            winreg.SetValueEx(env_key, "OLLAMA_MODELS", 0, winreg.REG_SZ, str(OLLAMA_MODELS_DIR))
            winreg.CloseKey(env_key)
            state.log("  Configured models storage on E: drive")
        except Exception as e:
            state.log(f"  Note: Could not persist env var: {str(e)[:30]}")
        
        # Find Ollama executable
        ollama_path = shutil.which("ollama")
        if not ollama_path:
            local = Path(os.environ.get("LOCALAPPDATA", "")) / "Programs" / "Ollama" / "ollama.exe"
            if local.exists():
                ollama_path = str(local)
        
        if not ollama_path:
            state.log("  Ollama not found, downloading installer...")
            try:
                import urllib.request
                import tempfile
                
                # Download Ollama installer
                installer_url = "https://ollama.com/download/OllamaSetup.exe"
                installer_path = Path(tempfile.gettempdir()) / "OllamaSetup.exe"
                
                state.log("  Downloading from ollama.com...")
                urllib.request.urlretrieve(installer_url, str(installer_path))
                
                if installer_path.exists():
                    state.log("  Installing Ollama silently...")
                    
                    # Set env var before running installer
                    install_env = os.environ.copy()
                    install_env["OLLAMA_MODELS"] = str(OLLAMA_MODELS_DIR)
                    
                    # Run installer silently (/S flag for NSIS installers)
                    result = subprocess.run(
                        [str(installer_path), "/S"],
                        capture_output=True,
                        timeout=120,
                        env=install_env,
                    )
                    
                    # Wait for installation to complete
                    time.sleep(3)
                    
                    # Clean up installer
                    try:
                        installer_path.unlink()
                    except Exception:
                        pass
                    
                    # Check if Ollama was installed
                    local = Path(os.environ.get("LOCALAPPDATA", "")) / "Programs" / "Ollama" / "ollama.exe"
                    if local.exists():
                        ollama_path = str(local)
                        state.log("  Ollama installed successfully")
                    else:
                        state.log("  Ollama installation may have failed")
                        state.log("  Please install manually from ollama.com")
                        return True
                else:
                    state.log("  Failed to download Ollama installer")
                    state.log("  Please install manually from ollama.com")
                    return True
                    
            except subprocess.TimeoutExpired:
                state.log("  Installation timed out")
                state.log("  Please install manually from ollama.com")
                return True
            except Exception as e:
                state.log(f"  Could not download Ollama: {str(e)[:50]}")
                state.log("  Please install manually from ollama.com")
                return True
        
        if ollama_path:
            state.log(f"  Ollama found")
            
            # Disable Ollama auto-start tray icon (remove from Windows startup)
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
                    pass  # Not in startup, that's fine
                winreg.CloseKey(startup_key)
            except Exception:
                pass  # Registry access failed, continue anyway
            
            # Kill any existing Ollama UI/tray processes
            try:
                subprocess.run(
                    ["taskkill", "/F", "/IM", "Ollama.exe"],
                    capture_output=True, creationflags=subprocess.CREATE_NO_WINDOW
                )
            except Exception:
                pass
            
            # Prepare environment with E: drive models path
            ollama_env = os.environ.copy()
            ollama_env["OLLAMA_MODELS"] = str(OLLAMA_MODELS_DIR)
            
            # Start Ollama as headless background service (CLI only)
            try:
                import urllib.request
                urllib.request.urlopen("http://localhost:11434/api/tags", timeout=2)
                state.log("  Ollama API is running")
            except Exception:
                state.log("  Starting Ollama service (headless)...")
                subprocess.Popen(
                    [ollama_path, "serve"],
                    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                    stdin=subprocess.DEVNULL,
                    env=ollama_env,
                    creationflags=subprocess.CREATE_NO_WINDOW | subprocess.DETACHED_PROCESS if sys.platform == "win32" else 0
                )
                time.sleep(3)
                state.log("  Ollama API started")
        return True

    def step_pull_model():
        state.log(f"Checking AI model ({OLLAMA_MODEL})...")
        ollama_path = shutil.which("ollama")
        if not ollama_path:
            local = Path(os.environ.get("LOCALAPPDATA", "")) / "Programs" / "Ollama" / "ollama.exe"
            if local.exists():
                ollama_path = str(local)
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
                    subprocess.Popen(
                        [ollama_path, "serve"],
                        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                        env=ollama_env,
                        creationflags=subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0
                    )
                time.sleep(2)
        
        if not service_running:
            state.log("  Could not start Ollama service")
            state.log(f"  You can pull the model later with: ollama pull {OLLAMA_MODEL}")
            return True
        
        # Check if model already exists
        try:
            with urllib.request.urlopen("http://localhost:11434/api/tags", timeout=5) as r:
                data = json.loads(r.read().decode())
                models = [m.get("name", "").split(":")[0] for m in data.get("models", [])]
                if OLLAMA_MODEL in models:
                    state.log(f"  Model {OLLAMA_MODEL} already installed")
                    state.log(f"  Models stored at: {OLLAMA_MODELS_DIR}")
                    return True
        except Exception as e:
            state.log(f"  Could not check models: {str(e)[:30]}")
        
        # Pull the model
        state.log(f"  Pulling {OLLAMA_MODEL} model to E: drive...")
        state.log(f"  This may take several minutes (~600MB download)")
        try:
            process = subprocess.Popen(
                [ollama_path, "pull", OLLAMA_MODEL],
                stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
                env=ollama_env,
                creationflags=subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0
            )
            
            last_log = ""
            while True:
                line = process.stdout.readline()
                if not line and process.poll() is not None:
                    break
                if line:
                    line = line.strip()
                    # Log progress updates
                    if any(kw in line.lower() for kw in ["pulling", "downloading", "verifying", "writing", "success", "%"]):
                        # Avoid duplicate logs
                        if line != last_log:
                            state.log(f"  {line[:60]}")
                            last_log = line
            
            if process.returncode == 0:
                state.log(f"  Model {OLLAMA_MODEL} ready!")
                state.log(f"  Stored at: {OLLAMA_MODELS_DIR}")
            else:
                state.log(f"  Model pull may have failed (exit code: {process.returncode})")
                state.log(f"  You can retry with: ollama pull {OLLAMA_MODEL}")
        except Exception as e:
            state.log(f"  Error pulling model: {str(e)[:40]}")
            state.log(f"  You can retry manually with: ollama pull {OLLAMA_MODEL}")
        
        return True

    def step_install_extension():
        state.log("Installing browser extension...")
        ext_dir = PROJECT_ROOT / "extension"
        if not ext_dir.exists():
            state.log("  Extension folder not found, skipping")
            return True

        ext_path = str(ext_dir.resolve()).replace("\\", "/")

        # Try to register via Windows Registry for Chrome/Edge
        installed = False
        try:
            import winreg

            # Read the extension's manifest to get a stable key
            manifest_path = ext_dir / "manifest.json"
            with open(manifest_path, "r") as f:
                manifest = json.load(f)

            # Use a deterministic ID based on the path
            import hashlib
            ext_id = hashlib.sha256(ext_path.lower().encode()).hexdigest()[:32]
            # Chrome external extension IDs use a-p (first 16 letters)
            ext_id = ''.join(chr(ord('a') + int(c, 16)) for c in ext_id)

            # Register for Chrome
            chrome_key_path = "Software\\Google\\Chrome\\Extensions\\" + ext_id
            try:
                key = winreg.CreateKey(winreg.HKEY_CURRENT_USER, chrome_key_path)
                winreg.SetValueEx(key, "path", 0, winreg.REG_SZ, str(ext_dir.resolve()))
                winreg.SetValueEx(key, "version", 0, winreg.REG_SZ, manifest.get("version", "1.0"))
                winreg.CloseKey(key)
                state.log("  Registered for Chrome")
                installed = True
            except Exception as e:
                state.log(f"  Chrome registry: {str(e)[:50]}")

            # Also register for Edge
            edge_key_path = "Software\\Microsoft\\Edge\\Extensions\\" + ext_id
            try:
                key = winreg.CreateKey(winreg.HKEY_CURRENT_USER, edge_key_path)
                winreg.SetValueEx(key, "path", 0, winreg.REG_SZ, str(ext_dir.resolve()))
                winreg.SetValueEx(key, "version", 0, winreg.REG_SZ, manifest.get("version", "1.0"))
                winreg.CloseKey(key)
                state.log("  Registered for Edge")
                installed = True
            except Exception:
                pass

        except Exception as e:
            state.log(f"  Registry method failed: {str(e)[:50]}")

        if installed:
            state.log("  Extension will appear on next browser restart")
            state.log("  You may need to enable it in chrome://extensions")
        else:
            state.log(f"  Auto-install not available")
            state.log(f"  To install manually:")
            state.log(f"  1. Open chrome://extensions")
            state.log(f"  2. Enable Developer Mode")
            state.log(f"  3. Click 'Load unpacked' → select:")
            state.log(f"     {ext_dir.resolve()}")

        return True

    steps = [step_check_python, step_create_venv, step_install_deps, step_check_ollama, step_pull_model, step_install_extension]
    
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
        new_logs = state.logs[state.log_cursor:]
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
        state.log("Launching Context Vault...")
        subprocess.Popen(
            [str(VENV_PYTHON), str(PROJECT_ROOT / "run.py")],
            cwd=str(PROJECT_ROOT),
            creationflags=subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0
        )
        if state.window:
            state.window.destroy()
        return {"success": True}


# ─────────────────────────────────────────────────────────────────
# Main Entry Point
# ─────────────────────────────────────────────────────────────────

def main():
    api = Api()
    
    html_path = str(PROJECT_ROOT / "frontend" / "installer.html")
    
    window = webview.create_window(
        title="Context Vault — Setup",
        url=html_path,
        width=880,
        height=600,
        resizable=False,
        background_color="#09090b",
        js_api=api,
    )
    
    state.window = window
    webview.start()


if __name__ == "__main__":
    main()
