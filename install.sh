#!/usr/bin/env bash
# Idempotent symlink installer for the CLIs in this repo.
#
#   ./install.sh                    # default set (terra-toolkit: render, infisical, langsmith)
#   ./install.sh --extras           # default set + the optional extras
#   ./install.sh --tools linear,c7  # exactly these tools
#   ./install.sh --all              # everything in the map
#   ./install.sh --list             # show the tool → binary map and exit
#
# Symlinks executables into ~/.local/bin (created if missing) with absolute
# targets, so the scripts' own `readlink`-based lib resolution keeps working.
# Safe to re-run: existing correct links are left alone, wrong ones re-pointed.
#
# NOT handled here (each has its own installer):
#   - ab / agent-browser  → ab/install.ts (builds a Rust binary; see shipyard DEPENDENCIES.md item 6)
#   - session-explorer    → shipyard's scripts/install-recall.sh (launchd service)
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BIN_DIR="$HOME/.local/bin"

# tool-name → space-separated executables, path relative to repo root
tool_files() {
  case "$1" in
    render)           echo "render/render-services render/render-logs render/render-postgres render/render-projects render/render-envgroups render/render-workspace render/render-clone" ;;
    infisical)        echo "infisical/infisical-api" ;;
    langsmith)        echo "langsmith/lsmith" ;;
    linear)           echo "linear/linear-cli" ;;
    notion)           echo "notion/notion-cc" ;;
    cloudflare)       echo "cloudflare/cf-workers cloudflare/cf-logs" ;;
    c7)               echo "c7/c7" ;;
    db-safe)          echo "db-safe/db-safe" ;;
    git-prune-merged) echo "git-prune-merged/git-prune-merged" ;;
    codex-ask)        echo "codex-ask/codex-ask" ;;
    api-probe)        echo "api-probe/api-probe" ;;
    skill-gen)        echo "skill-gen/skill-gen" ;;
    watch-deploy)     echo "watch-deploy/watch-deploy" ;;
    tmux)             echo "tmux/tmux-monitor" ;;
    beam)             echo "beam/beam" ;;
    *)                return 1 ;;
  esac
}

DEFAULT_TOOLS="render infisical langsmith"
EXTRA_TOOLS="linear notion cloudflare c7 db-safe git-prune-merged codex-ask api-probe skill-gen watch-deploy tmux beam"

list_map() {
  for t in $DEFAULT_TOOLS; do printf '%-18s (default) %s\n' "$t" "$(tool_files "$t")"; done
  for t in $EXTRA_TOOLS;   do printf '%-18s (extra)   %s\n' "$t" "$(tool_files "$t")"; done
}

TOOLS="$DEFAULT_TOOLS"
case "${1:-}" in
  --list)   list_map; exit 0 ;;
  --all)    TOOLS="$DEFAULT_TOOLS $EXTRA_TOOLS" ;;
  --extras) TOOLS="$DEFAULT_TOOLS $EXTRA_TOOLS" ;;
  --tools)  TOOLS="$(echo "${2:?usage: --tools name,name}" | tr ',' ' ')" ;;
  -h|--help) sed -n '2,15p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
  "")       ;;
  *)        echo "unknown arg: $1 (try --help)"; exit 1 ;;
esac

mkdir -p "$BIN_DIR"

linked=0; skipped=0; missing=0
for tool in $TOOLS; do
  files="$(tool_files "$tool")" || { echo "unknown tool: $tool (see --list)"; exit 1; }
  for rel in $files; do
    src="$REPO_DIR/$rel"
    name="$(basename "$rel")"
    dst="$BIN_DIR/$name"
    if [ ! -f "$src" ]; then
      echo "WARN  $rel not found in repo — skipped"
      missing=$((missing + 1)); continue
    fi
    if [ -e "$dst" ] && [ ! -L "$dst" ]; then
      echo "WARN  $dst exists and is not a symlink — left alone (move it aside and re-run to manage it here)"
      skipped=$((skipped + 1)); continue
    fi
    if [ "$(readlink "$dst" 2>/dev/null || true)" = "$src" ]; then
      skipped=$((skipped + 1)); continue
    fi
    ln -sf "$src" "$dst"
    echo "LINK  $dst → $src"
    linked=$((linked + 1))
  done
done

echo
echo "done: $linked linked, $skipped already in place, $missing missing from repo"
case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) echo "WARN  $BIN_DIR is not on your PATH — add it to your shell profile" ;;
esac
