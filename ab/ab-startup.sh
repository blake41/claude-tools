#!/usr/bin/env bash
#
# ab-startup — launched by launchd on login
#
# Starts the managed Chrome (headless, CDP 9333) and the agent-browser dashboard.
# Uses `ab` for all operations so config stays in one place.
#

set -euo pipefail

AB="$HOME/.local/bin/ab"

# Wait a few seconds for the system to settle after login
sleep 3

# Ensure Chrome is up (headless)
"$AB" ensure

# Start dashboard
"$AB" dashboard start

# Start portless proxy (named .localhost URLs for dev servers)
if command -v portless &>/dev/null; then
  portless proxy start 2>/dev/null || true
fi

echo "ab-startup: Chrome + dashboard + portless ready" >&2
