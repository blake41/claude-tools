# cmux — Claude Code Session Persistence

Auto-resume Claude Code sessions after cmux restarts. Each cmux panel has a stable UUID (`$CMUX_PANEL_ID`) that survives renames and restarts; we use it as the persistence key so each tab remembers which Claude session it belongs to.

## How It Works

```
cco-permissions starts
  → reads $CMUX_PANEL_ID from env (cmux exports it into every shell)
  → checks ~/.cmux/claude-sessions/<panel-uuid>
  → if mapping exists and session JSONL is on disk: injects --resume <session_id>
  → launches cco → claude starts

Claude SessionStart hook fires
  → reads session_id from stdin JSON
  → writes session_id to ~/.cmux/claude-sessions/$CMUX_PANEL_ID
  → also writes a metadata entry under by-session/ for cmux-session-history

Next launch in same panel
  → same panel UUID → finds mapping → resumes
```

The panel UUID is set by cmux when the panel is created and persisted in cmux's session file. It doesn't change when you rename the tab. It doesn't change when cmux restarts. It only changes if you close the tab and create a new one.

## Files

| File | Purpose |
|------|---------|
| `cmux-session-persist` | SessionStart hook — writes session ID to mapping file under `$CMUX_PANEL_ID` |
| `cmux-session-history` | Inspector — list every persisted session with workspace/surface name + content hint |
| `~/.config/fish/config.fish` | `cco-permissions` function — looks up `$CMUX_PANEL_ID` mapping on launch |
| `~/.claude/settings.json` | Hook registration (SessionStart) |
| `~/.config/cco/dirs` | Includes `~/.cmux` for sandbox write access |
| `~/.cmux/claude-sessions/<panel-uuid>` | Primary mapping: panel UUID → session ID |
| `~/.cmux/claude-sessions/by-session/<sid>` | Reverse index with workspace/surface display names |
| `~/.cmux/session-persist.log` | Debug log |

## Installation

```bash
# Symlink the hook
ln -sf ~/Documents/Development/tools/cmux/cmux-session-persist ~/.local/bin/cmux-session-persist

# Optional: symlink the inspector
ln -sf ~/Documents/Development/tools/cmux/cmux-session-history ~/.local/bin/cmux-session-history

# Ensure ~/.cmux is in cco sandbox write paths
grep -q '~/.cmux' ~/.config/cco/dirs || echo '~/.cmux' >> ~/.config/cco/dirs

# Hook is registered in ~/.claude/settings.json under SessionStart
```

## Debugging

```bash
# Check recent hook activity
tail -20 ~/.cmux/session-persist.log

# List all mappings
for f in ~/.cmux/claude-sessions/*; do
  [ -f "$f" ] || continue
  echo "$(basename $f) → $(cat $f)"
done

# Browse by session_id with workspace/surface display names
cmux-session-history             # all
cmux-session-history terra       # filter by workspace name (substring)
cmux-session-history --unmapped  # only sessions not currently bound to a panel

# Manually rebind: set this panel's mapping to a different session
echo "<sid>" > ~/.cmux/claude-sessions/$CMUX_PANEL_ID
```

## Key Constraints

- **`$CMUX_PANEL_ID` must be set** — cmux exports it into every terminal it spawns. If unset, you're not running inside cmux and persistence is skipped.
- **Closing a tab loses its mapping** — UUIDs are per-panel. A new tab named "manager mode ship" is not the same panel as a previous tab with that name. Use `cmux-session-history` to find the prior session and rebind manually if needed.
- **cco sandbox blocks `~/.cmux` writes** — must be in `~/.config/cco/dirs`.
- **`com.apple.provenance` xattr** — files created by Claude Code get this attribute which blocks sandbox execution. Clear with `xattr -d com.apple.provenance <file>`.

## Migrating from the old hash-keyed design

Previous versions hashed `workspace_name/surface_name` and used the hash as the persistence key. That design lost mappings when:
- A tab was renamed (different name → different hash → no match)
- The pre-Claude tab title was an auto-title (rejected by the human-name filter, no mapping written)

The new design keys on the cmux panel UUID directly. UUIDs are workspace-/title-independent. The one-time migration script walked `by-session/` and rewrote mappings under their panel UUIDs where the workspace+surface still matched a current cmux panel; orphans (panel renamed/closed since SessionStart) were dropped.
