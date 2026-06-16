# ContextVolt v2.3.0 Release Notes

**Release Date:** June 9, 2026  
**Status:** Stable Release

---

## ⚡ What's New in v2.3.0 — Smarter Retrieval, Redesigned UI, Guided Onboarding

This release sharpens the core "Ask Your Vault" experience with a ground-up
retrieval overhaul, ships a redesigned desktop UI with a native frameless
window, and adds a guided first-run onboarding that walks you through the
whole app.

---

### 🔍 Ask Your Vault — Retrieval & Generation Overhaul

**Retrieval**
- **Asymmetric query/document prefixes** for embed models (nomic, qwen3,
  mxbai) — fixes a silent recall loss that affected every search.
- **FTS5 + BM25 keyword index** (trigger-synced) replaces the old `LIKE`
  scan, with a versioned migration that rebuilds any prior index.
- **Listwise LLM reranker** over a widened candidate pool (`rag_rerank`).
- **Per-model score calibration**, near-duplicate chunk dedup, and chunk
  sub-split overlap.
- **Collection scoping** — restrict an answer to a single collection from
  the Ask UI selector.

**Generation**
- Inline **numbered `[n]` citations** with clickable links back to the
  source context.
- Fixed the qwen3 `<think>` leak in the streaming path.
- System-prompt threading through cloud providers (role separation +
  Anthropic prompt caching), provider-aware context budgets, and a lower
  RAG temperature (0.3 → 0.2) for steadier answers.

**Robustness**
- **Re-embed guard** detects embed-model/scheme changes and surfaces a
  `reembed_needed` flag in the UI.
- Sub-batched embeddings (32/request) so large contexts no longer time out.

> **After upgrading**, rebuild your vectors once with the new prefixes +
> overlap. The app flags this for you (`reembed_needed`); you can also run
> a full re-chunk from Settings.

---

### 🎨 Redesigned Desktop UI

- **Frameless window** with a custom title bar (drag + min/max/close),
  native edge-resize & Aero Snap, and maximize clamped to the work area so
  the taskbar stays visible.
- **Ask Vault redesign** — left-aligned hero + orb, inline multiline
  composer, custom "All contexts" dropdown, starter cards, and inline
  message editing (Claude/ChatGPT style).
- **Sidebar overhaul** — version label, searchable "Show all" collections
  modal, Tools moved into Settings, System/Restart into the status menu.
- **Detail view** — smooth section collapse and an insights "Show all"
  popup.
- **Vibe toggle** — three moods: **Volt** (default), **Space** (deep
  cosmic), and **Noir** (minimal), plus refreshed dialog styling.
- App-wide motion polish with a reduced-motion guard.

---

### 👋 Guided Onboarding

- **First-run name capture** — new users are asked their name up front and
  greeted by it on the dashboard.
- **Guided tour** that now walks through the real pages — Dashboard, the
  Library (search, view/sort, opening a context), the Context Detail view,
  and Ask Vault — navigating each view live instead of just pointing at the
  sidebar.
- Replayable any time from **Settings → Take the Tour**.

---

### 📦 Install / Upgrade

- **Windows:** download **ContextVolt-Setup.exe** from the release assets
  and run the wizard. Existing installs are offered the update in-app.
- **macOS:** `brew upgrade --cask contextvolt`.

The in-app updater compares against this release, so existing 2.2.0 users
will be prompted to update automatically.
