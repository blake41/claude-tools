#!/usr/bin/env bash
# Install Tab Out's native messaging host manifest so the extension can
# read/write cross-profile snapshots through ~/.tab-out/snapshots/.
#
# Usage: ./native-host/install.sh <chrome-extension-id>
#
# Find your extension ID at chrome://extensions (Developer mode on, look for
# the "ID: ..." line on the Tab Out tile). The ID is a 32-char a-p string.
#
# IMPORTANT — host script location:
#   The host runs OUT of ~/.tab-out/bin/, not from the repo. macOS TCC blocks
#   Chrome from spawning scripts under ~/Documents/ (and a few other dirs)
#   without explicit user consent — and there's no way for an extension to
#   prompt for it. So we copy the script to a location Chrome can always
#   reach. The copy happens on every install and is idempotent.

set -euo pipefail

EXT_ID="${1:-}"
if [[ -z "$EXT_ID" ]]; then
  echo "Usage: $0 <chrome-extension-id>"
  echo
  echo "Open chrome://extensions, enable Developer mode, and copy Tab Out's ID."
  exit 1
fi

if ! [[ "$EXT_ID" =~ ^[a-p]{32}$ ]]; then
  echo "Warning: '$EXT_ID' doesn't look like a Chrome extension ID (32 chars, a-p)."
  echo "Continuing anyway — pass the right ID if Chrome rejects the connection."
fi

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SOURCE_SCRIPT="$REPO_ROOT/native-host/snapshots-host.py"
HOST_NAME="com.zarazhangrui.tab_out_snapshots"

if [[ ! -f "$SOURCE_SCRIPT" ]]; then
  echo "Error: $SOURCE_SCRIPT not found"
  exit 1
fi

# Copy the host script outside ~/Documents/ to dodge macOS TCC sandboxing.
INSTALL_DIR="$HOME/.tab-out/bin"
HOST_SCRIPT="$INSTALL_DIR/snapshots-host.py"
mkdir -p "$INSTALL_DIR"
cp "$SOURCE_SCRIPT" "$HOST_SCRIPT"
chmod +x "$HOST_SCRIPT"

case "$(uname)" in
  Darwin)
    MANIFEST_DIR="$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"
    ;;
  Linux)
    MANIFEST_DIR="$HOME/.config/google-chrome/NativeMessagingHosts"
    ;;
  *)
    echo "Error: unsupported platform $(uname). Add the path manually."
    exit 1
    ;;
esac

mkdir -p "$MANIFEST_DIR"

MANIFEST_PATH="$MANIFEST_DIR/$HOST_NAME.json"
cat > "$MANIFEST_PATH" <<EOF
{
  "name": "$HOST_NAME",
  "description": "Tab Out cross-profile snapshot store",
  "path": "$HOST_SCRIPT",
  "type": "stdio",
  "allowed_origins": [
    "chrome-extension://$EXT_ID/"
  ]
}
EOF

echo "Host script: $HOST_SCRIPT"
echo "Manifest:    $MANIFEST_PATH"
echo "Snapshots:   $HOME/.tab-out/snapshots/"
echo
echo "Next steps:"
echo "  1. Reload Tab Out at chrome://extensions"
echo "  2. Open a new tab — that triggers the first snapshot write."
echo "  3. To include another Chrome profile: load the same extension folder"
echo "     unpacked in that profile (the path-derived ID stays the same, so"
echo "     this manifest already covers it)."
