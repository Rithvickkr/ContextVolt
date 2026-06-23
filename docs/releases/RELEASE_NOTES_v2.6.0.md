# ContextVolt v2.6.0 Release Notes

**Release Date:** June 23, 2026  
**Status:** Stable Release

---

## ⚡ What's New in v2.6.0 — Continue in Any AI, a Redesigned Detail Page & a Smarter Installer

This release turns a saved context into a one-click hand-off: pack the
conversation into a ready-to-paste prompt or jump straight into ChatGPT, Claude,
Grok and more. The context detail page is rebuilt around an asymmetric
"spotlight" layout that stays alive even when a summary is short, and the
installer now recommends a model based on your GPU.

---

### 🚀 Continue the Conversation Anywhere

- A new **Continuation prompt** card packs the whole context — cold-start brief,
  key facts, conversation replay and instructions — into a single prompt sized
  for **Compact / Standard / Full** context windows.
- **Continue in \<LLM\>** opens a fresh chat in your default browser with the
  full prompt already on your clipboard — ChatGPT, Claude, Grok, Gemini,
  DeepSeek, Perplexity or Copilot, with the original source LLM offered first.
- A first-run explainer makes the paste step obvious, then stays out of the way.
- The captured **source thread** is now a clickable link — jump back to the
  exact original conversation in one click.

---

### 🎨 Redesigned Context Detail Page

- Insights are rebuilt as an **asymmetric spotlight**: a numbered **Key ideas**
  hero anchors the page, with tinted **Conclusion** and **Open question** cards
  in an accent rail — so a sparse summary reads as intentional, never empty.
- The **Open question** turns into the next action with a **"Pick up in a new
  chat"** button that jumps straight to the continuation card.
- A tighter top: the rail, hero title and tab row now share one clean left edge
  at every window width, and the capture date lives in a single place instead of
  being repeated three times.

---

### 🛠️ Smarter Installer & Branding

- The setup wizard now gives **GPU-aware model recommendations**, steering you
  to a local model that fits your hardware.
- **Custom title-bar controls** for a frameless, native-feeling window.
- A **premium app icon** and polished first-run setup screens.

---

### 🐛 Fixes

- The setup wizard reliably launches, and previously-silent startup crashes are
  now logged so they can be diagnosed.

---

## 📦 Install

- **Windows:** download `ContextVolt-Setup.exe` from the assets below.
- **macOS:** `brew install --cask rithvickkr/tap/contextvolt` (or grab the
  `.dmg` from the assets).

---

**Full changelog:** https://github.com/Rithvickkr/ContextVolt/compare/v2.5.0...v2.6.0
