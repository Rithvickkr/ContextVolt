# ContextVolt — Homebrew Cask
#
# This file belongs in a SEPARATE GitHub repo named `homebrew-tap`, under a
# top-level `Casks/` directory:  Rithvickkr/homebrew-tap/Casks/contextvolt.rb
# It is kept here in the main repo as the source of truth — see README.md in
# this folder for the one-time tap setup and the release update workflow.
#
# Users install with:
#     brew install --cask rithvickkr/tap/contextvolt
#
# The `sha256` below is a placeholder until the first real release is built.
# Run installer/homebrew/update_cask.sh <version> to fill it in automatically.

cask "contextvolt" do
  version "2.3.0"
  sha256 "53c4c3bb3cce2ddb46266971276015b0f7c4943b07d7bfb419bd43555c6fb291"

  url "https://github.com/Rithvickkr/ContextVolt/releases/download/v#{version}/ContextVolt-#{version}-macOS.dmg",
      verified: "github.com/Rithvickkr/ContextVolt/"
  name "ContextVolt"
  desc "Local-first conversation context manager with MCP support"
  homepage "https://github.com/Rithvickkr/ContextVolt"

  livecheck do
    url :url
    strategy :github_latest
  end

  # Ollama provides the local LLM runtime. The CLI formula (not the GUI cask)
  # is what ContextVolt's wizard expects on PATH, and it runs headless.
  depends_on formula: "ollama"
  depends_on macos: ">= :big_sur" # matches LSMinimumSystemVersion 11.0

  app "ContextVolt.app"

  # The .app is ad-hoc signed, not notarized (no paid Apple Developer ID).
  # Stripping the quarantine attribute on install lets it launch without the
  # Gatekeeper "unidentified developer" prompt — the standard pattern for
  # unsigned apps distributed through a personal tap.
  postflight do
    system_command "/usr/bin/xattr",
                   args: ["-dr", "com.apple.quarantine", "#{appdir}/ContextVolt.app"]
  end

  # `brew uninstall --zap contextvolt` removes user data too.
  zap trash: [
    "~/Library/Application Support/ContextVolt",
    "~/Library/Saved Application State/com.contextvolt.app.savedState",
  ]

  caveats <<~EOS
    ContextVolt stores its database, config, logs, and downloaded models in:
      ~/Library/Application Support/ContextVolt

    On first launch a setup wizard pulls the local AI models (~2 GB) and opens
    a guide for installing the companion browser extension.
  EOS
end
