#!/usr/bin/env bash
# Install a pinned release of cass (coding_agent_session_search) into ~/.local/bin.
#
#   ./cass/install.sh                 # install the pinned version
#   CASS_VERSION=0.10.0 ./cass/install.sh
#   CASS_BIN_DIR=/some/dir ./cass/install.sh
#   ./cass/install.sh --force         # reinstall even if the installed version is >= the pinned one
#
# Downloads the release archive and its .sha256 from GitHub Releases, verifies the
# checksum, and installs the single `cass` binary. It does not vendor or build the
# source. Later upgrades: `cass upgrade --force --yes` (cass's own checksum-verified installer).
#
# Leaves a newer installed version alone unless --force is given.
set -euo pipefail

VERSION="${CASS_VERSION:-0.10.0}"
BIN_DIR="${CASS_BIN_DIR:-$HOME/.local/bin}"
REPO="Dicklesworthstone/coding_agent_session_search"
FORCE=0
[ "${1:-}" = "--force" ] && FORCE=1

case "$(uname -s)/$(uname -m)" in
  Darwin/arm64)                 PLATFORM="darwin-arm64" ;;
  Linux/x86_64)                 PLATFORM="linux-amd64" ;;
  Linux/aarch64 | Linux/arm64)  PLATFORM="linux-arm64" ;;
  *) echo "error: no cass release for $(uname -s)/$(uname -m) (Intel macOS has no build)" >&2; exit 1 ;;
esac

installed_version() {
  [ -x "$BIN_DIR/cass" ] || return 1
  "$BIN_DIR/cass" --version 2>/dev/null | awk '{print $2}'
}

if current="$(installed_version)" && [ -n "$current" ] && [ "$FORCE" -eq 0 ]; then
  newest="$(printf '%s\n%s\n' "$current" "$VERSION" | sort -V | tail -n 1)"
  if [ "$newest" = "$current" ]; then
    echo "cass $current already installed at $BIN_DIR/cass (>= pinned $VERSION); nothing to do"
    exit 0
  fi
fi

ASSET="cass-${PLATFORM}.tar.gz"
BASE="https://github.com/${REPO}/releases/download/v${VERSION}"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/cass-install.XXXXXX")"
trap 'rm -f "$TMP/$ASSET" "$TMP/$ASSET.sha256" "$TMP/cass"; rmdir "$TMP" 2>/dev/null || true' EXIT

echo "downloading cass v${VERSION} (${PLATFORM})"
curl -fsSL "$BASE/$ASSET" -o "$TMP/$ASSET"
curl -fsSL "$BASE/$ASSET.sha256" -o "$TMP/$ASSET.sha256"

expected="$(awk '{print $1}' "$TMP/$ASSET.sha256")"
if command -v shasum >/dev/null 2>&1; then
  actual="$(shasum -a 256 "$TMP/$ASSET" | awk '{print $1}')"
else
  actual="$(sha256sum "$TMP/$ASSET" | awk '{print $1}')"
fi
if [ -z "$expected" ] || [ "$expected" != "$actual" ]; then
  echo "error: checksum mismatch for $ASSET (expected ${expected:-<empty>}, got $actual)" >&2
  exit 1
fi
echo "checksum verified"

tar -xzf "$TMP/$ASSET" -C "$TMP" cass
got="$("$TMP/cass" --version | awk '{print $2}')"
if [ "$got" != "$VERSION" ]; then
  echo "error: archive contains cass $got, expected $VERSION" >&2
  exit 1
fi

mkdir -p "$BIN_DIR"
install -m 0755 "$TMP/cass" "$BIN_DIR/cass"
echo "installed cass $got to $BIN_DIR/cass"
case ":$PATH:" in *":$BIN_DIR:"*) ;; *) echo "note: $BIN_DIR is not on PATH" ;; esac
