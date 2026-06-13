# ContextVolt v2.4.0 Release Notes

**Release Date:** June 13, 2026  
**Status:** Stable Release

---

## ⚡ What's New in v2.4.0 — Modular Frontend, Redesigned Ask, Responsive Window

This release rebuilds the frontend into focused ES modules, reworks the Ask
Vault into a reading-first layout with a command-palette session switcher,
adds a tabbed Context Detail view, and introduces a proper responsive system
so the app stays usable as the window narrows.

---

### 🧩 Modular Frontend

- The single 7,500-line `app.js` is split into focused ES modules — `ask`,
  `library`, `dashboard`, `detail`, `settings`, `collections`, `composer`,
  `onboarding`, `shell`, `nav`, and more — so each view loads and reasons in
  isolation. No behavior change for users; a much faster surface to build on.

---

### 💬 Ask Vault Redesign (Frame 1)

- **Reading-first layout** — the question reads as a heading with a volt
  accent rule; the answer sits in its own card with a 760px reading column.
- **Numbered sources row** above each answer that pairs with the inline
  `[n]` citations, plus a copy · re-ask · model footer.
- **Command-palette session switcher** — past chats open as a centered
  palette over a scrim, with `Ctrl/Cmd+H` to summon it, type-to-filter, and
  full `↑`/`↓`/`↵` keyboard navigation.

---

### 📄 Context Detail — Tabbed View

- The detail view now splits into **Overview · Conversation · Code** tabs,
  with cleaner tag display, replacing the old long-scroll aside rows.

---

### 📐 Responsive Window System

- A consolidated responsive layer for the frameless desktop window with
  tiers from ultrawide down to phone-width.
- **Sidebar auto-collapses** on narrow windows and restores your manual
  preference when the window widens again.
- **Library rail degrades gracefully** as it narrows — the breadcrumb drops
  first, then the sort caption, then Quick Capture iconifies, with the
  Grid/Rows/Select labels staying visible until the rail is genuinely
  cramped.

---

### 🔧 Backend & Capture

- `/api/dashboard` now exposes **pinned contexts**.
- Capture API improvements for context briefs and updates to imported
  contexts, backed by a new test suite.
- `ollama_client` refinements.

---

### 📦 Install / Upgrade

- **Windows:** download **ContextVolt-Setup.exe** from the release assets
  and run the wizard. Existing installs are offered the update in-app.
- **macOS:** `brew upgrade --cask contextvolt`.

The in-app updater compares against this release, so existing 2.3.0 users
will be prompted to update automatically.
