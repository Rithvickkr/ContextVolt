# Homebrew distribution for ContextVolt (macOS)

This folder is the **source of truth** for the Homebrew cask. The cask itself
must live in a separate public GitHub repo named `homebrew-tap` so Homebrew can
discover it.

```
brew install --cask rithvickkr/tap/contextvolt
```

That one command:

1. installs **Ollama** (declared `depends_on formula: "ollama"`),
2. downloads the released `.dmg`, mounts it, copies `ContextVolt.app` to
   `/Applications`,
3. **strips the quarantine attribute** (postflight) so it opens without a
   Gatekeeper prompt — no notarization needed,
4. and registers `brew upgrade` / `brew uninstall --zap` support.

---

## One-time setup of the tap

1. Create a new **public** GitHub repo named exactly `homebrew-tap` under your
   account (`Rithvickkr/homebrew-tap`). The `homebrew-` prefix is what lets
   `brew tap rithvickkr/tap` resolve it.
2. Add a `Casks/` directory and copy the cask in:
   ```bash
   mkdir -p Casks
   cp /path/to/ContextVolt/installer/homebrew/contextvolt.rb Casks/
   git add Casks/contextvolt.rb
   git commit -m "Add contextvolt cask"
   git push
   ```
3. Verify it resolves:
   ```bash
   brew tap rithvickkr/tap
   brew info --cask contextvolt
   ```

---

## Cutting a release

1. Tag the main repo (`vX.Y.Z`) — the `build-mac.yml` workflow builds the
   `.dmg` and attaches it to the GitHub Release automatically.
2. Once the release asset exists, update the cask digest:
   ```bash
   bash installer/homebrew/update_cask.sh X.Y.Z
   ```
   This downloads the published `.dmg`, computes its SHA-256, and rewrites the
   `version` + `sha256` lines in `contextvolt.rb`.
3. Copy the updated cask into the tap repo and push:
   ```bash
   cp installer/homebrew/contextvolt.rb ../homebrew-tap/Casks/contextvolt.rb
   (cd ../homebrew-tap && git commit -am "contextvolt X.Y.Z" && git push)
   ```
4. Users get the update with `brew upgrade --cask contextvolt`.

---

## Notes

- **Why a personal tap and not homebrew-cask (the official repo)?** The official
  repo requires notarized, stably-versioned apps and rejects `postflight`
  quarantine stripping. A personal tap has none of those constraints, which is
  exactly what makes the free (un-notarized) distribution smooth.
- **`depends_on formula: "ollama"`** pulls the headless CLI to the Homebrew
  prefix (`/opt/homebrew/bin/ollama` on Apple Silicon). ContextVolt's wizard
  finds it there and starts `ollama serve` itself — no GUI Ollama.app needed.
- This is Apple-Silicon only (matches the `.dmg`). Intel Macs should use the
  source install (`install.sh`).
