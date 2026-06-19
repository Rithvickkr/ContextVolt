# ContextVolt v2.5.0 Release Notes

**Release Date:** June 20, 2026  
**Status:** Stable Release

---

## ⚡ What's New in v2.5.0 — Light/Dark Themes, Floating-Ball Capture, Hardened Security & Faster Search

This release swaps the old vibe picker for a proper light/dark theme, turns
in-page capture into a draggable floating ball, rebuilds Settings and the
System modal, closes two security holes in the updater and MCP surface, and
removes a multi-second latency tax that was paid on every local-model call.

---

### 🎨 Light / Dark Mode

- A real **light/dark toggle** replaces the Noir/Volt/Space vibes, with a
  smooth sliding thumb on the topbar (light no longer snaps), a **System**
  option that follows the OS, and an avatar colour picker.
- Theme choice persists to local storage and stays consistent across every
  view; onboarding now introduces light/dark instead of visual vibes.

---

### 🟣 Floating-Ball Capture (Extension)

- The fixed Send/Import buttons become a **draggable floating ball** that
  reveals **Import from Vault** / **Send to Vault**, snaps to the nearest
  screen edge, and remembers its position between sessions.

---

### ⚙️ Redesigned Settings & System

- **Settings** rebuilt as a grouped rail with a dynamic per-tab header and a
  conditional footer; Tools restyled as grouped row-cards.
- **System modal** reworked into a **Health** view (overall status pill, hero
  strip, grouped icon cards) and a **Logs** view with level filters and search
  over structured entries. `/api/debug/logs` now returns parsed entries
  (timestamp / level / message) plus per-level counts.
- The sidebar status badge opens the System modal directly.

---

### 🔒 Security Hardening

- **Updater:** the installer URL is now resolved **server-side** from the
  GitHub release, and non-GitHub hosts are rejected — closing a CSRF→RCE where
  a local web page could point the updater at an arbitrary `.exe`.
- **MCP isolation:** `/mcp` and OAuth are served from a dedicated MCP-only app
  on a separate loopback port, so the Cloudflare tunnel exposes **only** that
  surface and never the REST API. Loopback detection fails closed on tunnel
  headers, tunnel start refuses when the MCP port is unavailable, and the
  bearer-token comparison is constant-time.

---

### 🚀 Performance — Faster Search & Local-Model Calls

- Fixed a **~2-second penalty paid on every Ollama call** (chat, summarization,
  embeddings, search): on Windows, `requests` resolved `localhost` to IPv6
  `::1` first and waited for it to fail before falling back to IPv4. Calls now
  target `127.0.0.1` directly (override with `OLLAMA_HOST`).
- The **embed model is kept warm** (`keep_alive`) and pre-loaded at startup, so
  the first library search after an idle period is no longer a cold-start
  freeze. Trivial single-character queries skip the embed entirely.
- Net effect: library search drops from multi-second (or frozen on cold start)
  to roughly **0.3s**, with no change to search quality or stored embeddings.

---

### 📦 Install / Upgrade

- **Windows:** download **ContextVolt-Setup.exe** from the release assets and
  run the wizard. Existing installs are offered the update in-app.
- **macOS:** `brew upgrade --cask contextvolt`.

The in-app updater compares against this release, so existing 2.4.0 users will
be prompted to update automatically.
