# ContextVolt v2.8.0 Release Notes

**Release Date:** August 10, 2026
**Status:** Stable Release

---

## ⚡ Installer: Ollama download progress

- On a fresh install where Ollama isn't already present, the installer now
  reports real download progress ("Downloading... 40% (280/700 MB)") every
  ~10% instead of a single static "Downloading from ollama.com..." line for
  the whole transfer. Makes it clear the installer is still working during
  the ~700 MB download rather than appearing stuck.
