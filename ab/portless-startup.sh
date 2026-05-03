#!/usr/bin/env bash
#
# ab-startup — launched by launchd on login
#
# Chrome + dashboard are handled by the ab-server daemon (com.clay.ab-server)
# via supervisor.startSupervision(). This script only starts portless.
#

set -euo pipefail

# Wait a few seconds for the system to settle after login
sleep 3

# Start portless proxy (named .localhost URLs for dev servers)
if command -v portless &>/dev/null; then
  portless proxy start 2>/dev/null || true
fi

echo "ab-startup: portless ready" >&2
