# cmux — Claude Code Session Persistence

Auto-resume Claude Code sessions after cmux restarts. Maps workspace/surface names to Claude session IDs so `cco-permissions` can `--resume` the right session in each tab.

## How It Works

```
cco-permissions starts
  → captures workspace + surface name via `cmux identify` (BEFORE claude changes terminal title)
  → hashes "workspace_name/surface_name" → checks ~/.cmux/claude-sessions/<hash>
  → if mapping exists: injects --resume <session_id>
  → exports CMUX_SESSION_KEY_HASH for the hook
  → launches cco → claude starts

Claude SessionStart hook fires
  → reads session_id from stdin JSON
  → writes session_id to ~/.cmux/claude-sessions/$CMUX_SESSION_KEY_HASH

Next launch in same tab
  → same workspace/surface name → same hash → finds mapping → resumes
```

## Files

| File | Purpose |
|------|---------|
| `cmux-session-persist` | SessionStart hook — writes session ID to mapping file |
| `~/.config/fish/config.fish` | `cco-permissions` function — resume logic + hash computation |
| `~/.claude/settings.json` | Hook registration (SessionStart) |
| `~/.config/cco/dirs` | Includes `~/.cmux` for sandbox write access |
| `~/.cmux/claude-sessions/` | Mapping files: `<hash>` → session ID |
| `~/.cmux/session-persist.log` | Debug log |

## Installation

```bash
# Symlink the hook
ln -sf ~/Documents/Development/tools/cmux/cmux-session-persist ~/.local/bin/cmux-session-persist

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
  [ -f "$f" ] && echo "$(basename $f) → $(cat $f)"
done

# Clear stale mappings
find ~/.cmux/claude-sessions -type f -not -name "*.log" -delete
```

## Key Constraints

- **cmux UUIDs don't survive restarts** — panel/tab/workspace IDs are regenerated. Only human-set names persist.
- **Surface names change when Claude starts** — Claude sets terminal title to "✳ Claude Code". The hash must be computed BEFORE launching claude (in fish shell, not in the hook).
- **cco sandbox blocks `~/.cmux` writes** — must be in `~/.config/cco/dirs`.
- **`com.apple.provenance` xattr** — files created by Claude Code get this attribute which blocks sandbox execution. Clear with `xattr -d com.apple.provenance <file>`.
- **cmux wrapper is bypassed inside cco** — `~/.local/bin/claude` (real binary) comes first in PATH. Our hook uses `settings.json` instead.
