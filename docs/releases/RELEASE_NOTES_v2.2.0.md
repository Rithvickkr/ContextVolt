# ContextVolt v2.2.0 Release Notes

**Release Date:** June 3, 2026  
**Status:** Stable Release

---

## 🍎 What's New in v2.2.0 — Native macOS Support

ContextVolt now runs natively on macOS, alongside the existing Windows build.
Apple Silicon gets a one-command Homebrew install, and all user data lives in
the standard macOS location.

### ✨ Major Features

#### 1. **Native macOS App**
- Real `.app` bundle built with py2app, packaged as a `.dmg`
- Apple-styled app icon (rounded squircle, transparent corners)
- Data stored at `~/Library/Application Support/ContextVolt/`

#### 2. **Homebrew Install**
```bash
brew install --cask rithvickkr/tap/contextvolt
```
- Installs Ollama automatically (declared dependency)
- Places the app in /Applications
- Clears Gatekeeper quarantine — opens on first click, no warning
- Update any time with `brew upgrade --cask contextvolt`

#### 3. **macOS-Aware Setup**
- The first-run wizard installs Ollama via the Homebrew CLI (instead of the
  Linux-only install script) and starts it headless
- Cross-platform Ollama discovery (Homebrew, `/Applications/Ollama.app`, PATH)

---

## 🔧 Technical Improvements

### Cross-platform paths
- New `backend/paths.py` is the single source of truth for writable state
- macOS / Linux redirect config, database, logs, models, lock files, and the
  cloudflared binary to the platform-standard user-data directory
- **Windows behavior is unchanged** — every path still resolves next to the
  project root, exactly as before

### Packaging & distribution
- `installer/build_mac.sh` — builds the `.app`, ad-hoc signs it, and creates a
  `.dmg` with a custom volume icon
- `.github/workflows/build-mac.yml` — builds and attaches the `.dmg` to the
  GitHub Release on every `v*` tag (Apple Silicon runner)
- `installer/homebrew/` — Homebrew cask, tap setup docs, and a release helper

### In-app updater
- Now downloads the correct artifact per platform (`.dmg` on macOS, `.exe` on
  Windows)

---

## 📦 Installation & Updates

### macOS

**Homebrew (recommended, Apple Silicon)**
```bash
brew install --cask rithvickkr/tap/contextvolt
```

**Direct `.dmg` (Apple Silicon)**
Download `ContextVolt-2.2.0-macOS.dmg`, drag to Applications. The build is
ad-hoc signed (not yet notarized), so the first launch needs a one-time bypass:
**System Settings → Privacy & Security → "Open Anyway."**

**From source (Apple Silicon + Intel)**
```bash
curl -fsSL https://raw.githubusercontent.com/Rithvickkr/ContextVolt/master/install.sh | bash
```

### Windows
Download `ContextVolt-Setup.exe` from the [Releases page](https://github.com/Rithvickkr/ContextVolt/releases) and run the installer. (Unchanged from v2.0.)

---

## ⚠️ Notes & Limitations

- The `.dmg` and Homebrew cask are **Apple Silicon only**. Intel Macs are
  supported via the source install.
- Not yet notarized (no paid Apple Developer ID) — the direct `.dmg` requires
  the one-time "Open Anyway" step. The Homebrew cask avoids it entirely.
- **Windows is fully unaffected** — all changes are platform-gated.

### Uninstall (macOS)
```bash
brew uninstall --zap contextvolt        # Homebrew (also removes user data)
# or for direct installs:
rm -rf /Applications/ContextVolt.app ~/Library/Application\ Support/ContextVolt
```

---

## 🙏 Feedback

macOS coverage relies on community testers — please
[open an issue](https://github.com/Rithvickkr/ContextVolt/issues) if anything
breaks on your setup.
