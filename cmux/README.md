# cmux — Claude Code Session Persistence

Auto-resume Claude Code sessions after cmux restarts. Each cmux panel's
`(title, directory)` pair is hashed into a stable key, and a daemon
maintains a `key → session_id` mapping that survives cmux restart and tab
renames.

## How It Works

A single daemon (`cmux-session-watch`) does two things:

1. **Bind sessions to panels.** Polls `~/.claude/sessions/<pid>.json`. For
   each new interactive Claude lock file, reads `CMUX_PANEL_ID` from the
   claude process's launch environment via `ps -Ewww`, looks up the panel's
   current title and directory in cmux's persisted state, and writes
   `~/.cmux/claude-sessions/by-key/<hash>` = `<session_id>`.

2. **Move mappings on rename.** Polls cmux's session state JSON via mtime.
   When a panel's `(title, directory)` hash changes, moves
   `by-key/<old-hash>` → `by-key/<new-hash>`. The session_id payload
   travels with the tab.

```
cmux launches a panel
  → cmux exports CMUX_PANEL_ID into the panel's shell environment
  → user runs `claude` (via cco-permissions wrapper)
    → cco-permissions calls cmux-key to derive (title, dir) hash
    → reads ~/.cmux/claude-sessions/by-key/<hash>
    → if found: claude --resume <sid>
    → else: claude (fresh)
  → claude writes ~/.claude/sessions/<pid>.json with sessionId
  → daemon picks up the new lock file (within ~2s)
    → ps -E reads CMUX_PANEL_ID from claude's env
    → looks up panel title/dir in cmux state
    → writes by-key/<hash> = sessionId

User renames the tab
  → cmux's state JSON updates
  → daemon's mtime poll fires
  → daemon recomputes hash, moves by-key/<old> → by-key/<new>
```

The daemon needs no Claude Code hook. The previous design used a
SessionStart hook (`cmux-session-persist`) but that raced with cmux's lazy
JSON flush — fresh panels often weren't in the JSON when SessionStart
fired, so the by-key entry was never written. Reading `CMUX_PANEL_ID`
directly from the process env eliminates the race.

## Files

| File | Purpose |
|------|---------|
| `cmux-key` | Helper used by `cco-permissions` to derive `(title, dir)` hash for the current panel from cmux state |
| `cmux-session-history` | Inspector — list every persisted session with workspace/surface name + content hint |
| `com.blake.cmux-session-watch.plist` | LaunchAgent definition (deployed to `~/Library/LaunchAgents/`) |
| `~/.cmux/cmux-session-watch` | The daemon itself (lives outside `~/Documents` for TCC reasons; **canonical source**) |
| `~/.config/fish/config.fish` | `cco-permissions` invocation hooks |
| `~/.cmux/claude-sessions/by-key/<hash>` | Primary mapping: `(title, dir)` hash → session_id |
| `~/.cmux/claude-sessions/by-session/<sid>` | Reverse index with workspace/surface display names |
| `~/.cmux/claude-sessions/.watcher-snapshot.json` | Daemon's previous-state snapshot for diffing |
| `~/.cmux/session-watch.log` | Daemon debug log |

## Installation

```bash
# 1. Daemon source lives at ~/.cmux/cmux-session-watch (TCC requires it
#    outside ~/Documents). Edit it directly there; nothing else mirrors it.
ls ~/.cmux/cmux-session-watch

# 2. Install the launchd agent
cp ~/Documents/Development/tools/cmux/com.blake.cmux-session-watch.plist \
   ~/Library/LaunchAgents/
launchctl bootstrap "gui/$UID" ~/Library/LaunchAgents/com.blake.cmux-session-watch.plist

# 3. Symlink cmux-key for cco-permissions lookups
ln -sf ~/Documents/Development/tools/cmux/cmux-key ~/.local/bin/cmux-key

# 4. (optional) Symlink the inspector
ln -sf ~/Documents/Development/tools/cmux/cmux-session-history ~/.local/bin/cmux-session-history

# 5. Ensure ~/.cmux is in cco sandbox write paths
grep -q '~/.cmux' ~/.config/cco/dirs || echo '~/.cmux' >> ~/.config/cco/dirs
```

## Debugging

```bash
# Daemon health
launchctl print "gui/$UID/com.blake.cmux-session-watch" | grep state
tail -30 ~/.cmux/session-watch.log

# Restart daemon (after editing ~/.cmux/cmux-session-watch)
launchctl kickstart -k "gui/$UID/com.blake.cmux-session-watch"

# Verify a tab's mapping (run inside the tab in question)
~/Documents/Development/tools/cmux/cmux-key
ls -la ~/.cmux/claude-sessions/by-key/<hash-from-above>

# Browse all bound sessions
cmux-session-history             # all
cmux-session-history terra       # filter by workspace name (substring)
cmux-session-history --unmapped  # only sessions not currently bound to a panel

# Manually rebind: point a (title, dir) hash at a specific session
echo "<sid>" > ~/.cmux/claude-sessions/by-key/<hash>
```

## Key Constraints

- **`CMUX_PANEL_ID` must be set** — cmux exports it into every terminal it
  spawns. If unset, you're not running inside cmux and persistence is
  skipped.
- **`ps -E` must work for the daemon** — daemon reads claude's launch env
  to get `CMUX_PANEL_ID`. macOS lets you read env for own-uid processes
  outside the cco sandbox; LaunchAgents satisfy this.
- **cco sandbox blocks `~/.cmux` writes** — must be in `~/.config/cco/dirs`.
- **`com.apple.provenance` xattr** — files created by Claude Code get this
  attribute which blocks sandbox execution. Clear with
  `xattr -d com.apple.provenance <file>`.
- **TCC blocks launchd from `~/Documents`** — that's why the daemon lives
  at `~/.cmux/cmux-session-watch` rather than under this directory.

## Migration history

1. **First design** hashed `workspace_name/surface_name` and used the hash
   as the persistence key. Lost mappings on tab rename.
2. **Second design** keyed on cmux panel UUID directly. Turned out panel
   UUIDs regenerate on cmux restart, so mappings were lost there too.
3. **Third design** keyed on `(title, directory)` hash with a SessionStart
   hook + rename-watcher daemon. The hook raced with cmux's JSON flush.
4. **Current design** keeps the `(title, directory)` hash and the rename
   watcher, but moves session binding into the daemon (via `ps -E`) and
   removes the SessionStart hook entirely.

Stale `by-session/` entries with empty `title`/`key` left over from the
hook era are rebound automatically the next time the daemon sees the live
session.
