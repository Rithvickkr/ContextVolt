# ContextVolt v2.6.1 Release Notes

**Release Date:** June 23, 2026  
**Status:** Stable Release (macOS fix)

---

## 🐛 Fix — macOS app starting cleanly

This is a macOS-only patch. v2.6.0 (and earlier macOS beta builds) shipped
without `anyio`'s asyncio backend, which the app loads dynamically — so the
bundler silently dropped it. Without it, Starlette's request middleware failed
on **every** request and the window showed a blank **"Internal Server Error"**
page.

- The macOS build now force-includes `anyio._backends._asyncio`, so the bundled
  server handles requests normally and the app launches cleanly.
- This was a packaging issue only — no application logic changed. Windows builds
  were never affected.

If you hand-patched a v2.6.0 install, just upgrade and you can drop the manual
`anyio/_backends` copy.

---

## 📦 Install / Upgrade

- **macOS:** `brew upgrade --cask contextvolt` (or download the new `.dmg`).
- **Windows:** unchanged from 2.6.0; download `ContextVolt-Setup.exe` if needed.

---

**Full changelog:** https://github.com/Rithvickkr/ContextVolt/compare/v2.6.0...v2.6.1
