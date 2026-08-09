# ContextVolt v2.7.1 Release Notes

**Release Date:** August 9, 2026
**Status:** Stable Release (patch)

---

## 🐛 Fix: installer crash on first launch

- Fixed a startup crash (`UnboundLocalError: cannot access local variable
  'threading'`) that could hit the installer window on some machines. A
  leftover local `import threading` inside a CI-only code path was shadowing
  the module-level import for the whole function, so the unrelated call that
  sets the installer's taskbar icon failed before the window could open.

No other changes in this release.
