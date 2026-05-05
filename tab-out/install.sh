#!/usr/bin/env bash
# Tab Out one-shot installer.
#
# What this does:
#   1. Copies the extension folder path to your clipboard.
#   2. Opens chrome://extensions so you can Load Unpacked.
#   3. After you give it the extension ID, installs the native messaging
#      host manifest so cross-profile snapshots work.
#
# Usage:
#   ./install.sh                # interactive
#   ./install.sh <extension-id> # skip the extension-loading hand-hold

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")" && pwd)"
EXT_DIR="$REPO_ROOT/extension"
NATIVE_INSTALL="$REPO_ROOT/native-host/install.sh"

if [[ ! -d "$EXT_DIR" ]]; then
  echo "Error: extension dir missing at $EXT_DIR"
  exit 1
fi

EXT_ID="${1:-}"

if [[ -z "$EXT_ID" ]]; then
  echo "Step 1 of 2: Load the unpacked extension in Chrome"
  echo "============================================================"
  echo

  # Copy path to clipboard (macOS) so the user can paste in Chrome's file picker
  if command -v pbcopy >/dev/null 2>&1; then
    printf '%s' "$EXT_DIR" | pbcopy
    echo "Path copied to your clipboard:"
  else
    echo "Path:"
  fi
  echo "    $EXT_DIR"
  echo

  echo "  1. About to open chrome://extensions"
  echo "  2. Toggle 'Developer mode' (top-right) ON if it isn't already"
  echo "  3. Click 'Load unpacked'"
  echo "  4. Press Cmd+Shift+G in the file picker, paste the path, hit Enter, then Select"
  echo "  5. Find the Tab Out tile and copy the 32-char ID under it"
  echo

  if command -v open >/dev/null 2>&1; then
    open "chrome://extensions" || true
  fi

  read -r -p "Paste the extension ID and press Enter: " EXT_ID
  EXT_ID="$(printf '%s' "$EXT_ID" | tr -d '[:space:]')"
fi

if [[ -z "$EXT_ID" ]]; then
  echo "No extension ID provided — skipping native host install."
  echo "Run ./native-host/install.sh <id> later to enable cross-profile snapshots."
  exit 0
fi

echo
echo "Step 2 of 2: Install the native messaging host"
echo "============================================================"
"$NATIVE_INSTALL" "$EXT_ID"

echo
echo "Done. Reload Tab Out at chrome://extensions, then open a new tab."
echo
echo "To enable cross-profile snapshots in another Chrome profile:"
echo "  1. Switch to that profile, load the same folder as unpacked"
echo "     (the extension ID stays the same — it's path-derived)"
echo "  2. Reload Tab Out there"
echo "  3. After ~2s of tab activity, both profiles' snapshots will appear"
