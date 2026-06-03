#!/bin/bash
# ═══════════════════════════════════════════════════════════════
# ContextVolt — Homebrew cask updater
#
# Downloads a released .dmg, computes its SHA-256, and rewrites the
# `version` and `sha256` lines in contextvolt.rb so the cask points at
# that release.
#
# Usage:
#     bash installer/homebrew/update_cask.sh 1.2.0
#
# Then copy the updated contextvolt.rb into your homebrew-tap repo:
#     cp installer/homebrew/contextvolt.rb \
#        ../homebrew-tap/Casks/contextvolt.rb
#     (cd ../homebrew-tap && git commit -am "contextvolt 1.2.0" && git push)
# ═══════════════════════════════════════════════════════════════

set -euo pipefail

if [ $# -lt 1 ]; then
    echo "Usage: $0 <version>   (e.g. $0 1.2.0)"
    exit 1
fi

VERSION="$1"
CASK="$(dirname "$0")/contextvolt.rb"
DMG="ContextVolt-${VERSION}-macOS.dmg"
URL="https://github.com/Rithvickkr/ContextVolt/releases/download/v${VERSION}/${DMG}"

echo "  Fetching ${URL}"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
curl -fSL "$URL" -o "$TMP/$DMG"

SHA="$(shasum -a 256 "$TMP/$DMG" | awk '{print $1}')"
echo "  sha256 = $SHA"

# Rewrite version + sha256. Works with both the placeholder (sha256 :no_check)
# and a previously filled-in digest.
#   - macOS sed needs the empty-string -i argument; this script is macOS-only.
sed -i '' -E "s/^([[:space:]]*version )\"[^\"]*\"/\1\"${VERSION}\"/" "$CASK"
sed -i '' -E "s/^([[:space:]]*sha256 ).*/\1\"${SHA}\"/" "$CASK"

echo "  Updated $CASK to version ${VERSION}"
echo ""
echo "  Next: copy into the tap repo and push:"
echo "    cp \"$CASK\" ../homebrew-tap/Casks/contextvolt.rb"
echo "    (cd ../homebrew-tap && git commit -am \"contextvolt ${VERSION}\" && git push)"
