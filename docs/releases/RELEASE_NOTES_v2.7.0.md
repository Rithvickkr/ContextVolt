# ContextVolt v2.7.0 Release Notes

**Release Date:** June 26, 2026  
**Status:** Stable Release

---

## ✨ Ask Vault — sharper, better-formatted answers

- **Richer markdown rendering.** Answers now render headings, numbered lists,
  links, blockquotes, horizontal rules, and strikethrough — not just bold and
  bullets. Code blocks are protected, so markdown characters inside a code
  sample (e.g. `a ** b`) stay literal instead of getting reformatted.
- **Less hallucination.** The retrieval prompt was hardened so the assistant
  answers your *current* question directly, never copies the wording or persona
  of older saved chats, and clearly says when your vault doesn't contain the
  answer instead of inventing one.

## 🔔 Notification center redesign

- **Swipe to dismiss** a notification (drag it aside).
- Smooth **animated dismiss** and **staggered clear-all**.
- Refined panel styling — gradient background, branded accent, cleaner header
  and buttons.

## ⚡ Ollama runs itself now

- **Auto-start:** if Ollama isn't running when you open ContextVolt, the app
  starts it for you. When you close ContextVolt, it shuts down the Ollama it
  started (an Ollama you launched yourself is left alone).
- **No more flashing command windows (Windows):** Ollama's model-loader
  processes no longer pop console windows while summarizing or searching.

## 🎮 Smarter GPU handling (laptops with switchable graphics)

- **Prefers your dedicated NVIDIA GPU** over the integrated one when starting
  Ollama, so inference runs on the faster card.
- A **diagnostic banner** detects when a model ended up on the integrated GPU
  and offers a one-click **"Switch to NVIDIA."**
- **New "Run embeddings on CPU" option** (Settings → Embedding): frees graphics
  memory so a larger chat model fits on small GPUs (~4 GB). Opt-in — leave it
  off if your GPU has memory to spare.

---

## 📦 Install / Upgrade

- **macOS:** `brew upgrade --cask contextvolt` (or download the new `.dmg`).
- **Windows:** download and run `ContextVolt-Setup.exe`.

---

**Full changelog:** https://github.com/Rithvickkr/ContextVolt/compare/v2.6.1...v2.7.0
