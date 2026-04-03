# Agent Browser: Confirmed Failure Modes & Fixes

Deterministic reference for every confirmed failure mode, its root cause, reproduction steps, and fix.

## Architecture

```
CLI (ab) → Unix Socket (default.sock) → Daemon (agent-browser-d) → CDP WebSocket → Chrome
```

- **CLI → Daemon** (Unix socket): Always works. Never observed to fail.
- **Daemon → Chrome** (CDP WebSocket): This is the channel that breaks.
- Daemon has auto-reconnect for Chrome crashes but NOT for profile corruption.

**Key files:**
- Config: `~/.agent-browser/config.json`
- Profile: `~/.agent-browser/profile/`
- Daemon PID: `~/.agent-browser/default.pid`
- Daemon socket: `~/.agent-browser/default.sock`
- Sessions: `~/.agent-browser/sessions/<name>-default.json`

---

## F1: Profile Corruption (Root Cause of Daily Crashes)

**Symptom:** "CDP response channel closed" — daemon is alive but Chrome can't start.

**Root cause:** `agent-browser close` kills Chrome ungracefully, corrupting the profile (stale GPU cache, bad lock files, corrupt IndexedDB). Next daemon spawn tries to launch Chrome on corrupted profile → Chrome exits immediately → daemon becomes a zombie.

**Reproduction:**
```bash
# 1. Verify healthy
ab get url  # ✓ returns URL

# 2. Trigger corruption
agent-browser --session-name terra close

# 3. Attempt reconnect
agent-browser --session-name terra open "https://example.com"
# ✗ "CDP response channel closed"
```

**Fix:**
```bash
ab heal
# Kills all daemons, backs up auth cookies, nukes profile, restores cookies, tests launch
```

**Prevention:** Never run `agent-browser close`. The `ab` wrapper blocks this command.

**Confirmed:** 2025-08. Root cause identified through stability testing. The daemon DOES auto-recover from `kill -9` on Chrome (tested) — the failure is specifically profile corruption from `close`.

---

## F2: `get url` Hangs Indefinitely

**Symptom:** `agent-browser --session-name terra get url` never returns. Shell appears frozen.

**Root cause:** When the daemon exists but Chrome is dead/unresponsive, `get url` sends a CDP message and waits forever for a response that will never come. No timeout on the CLI side.

**Reproduction:**
```bash
# 1. Have a healthy session
ab get url  # ✓ works

# 2. Kill Chrome (simulating crash)
kill -9 $(pgrep "Google Chrome" | head -1)

# 3. Immediately try get url (before daemon detects the crash)
agent-browser --session-name terra get url
# Hangs indefinitely
```

**Fix:** Always use `ab` which wraps with `timeout 5`:
```bash
ab get url  # Returns within 5 seconds or fails
```

**Prevention:** The `ab` wrapper adds `timeout 5` to all health checks. The `cco-permissions` function uses `ab ensure` which has this built in.

**Confirmed:** 2026-03-20. Caused `cco-permissions` to hang, blocking session resume.

---

## F3: Multiple Daemons Pile Up

**Symptom:** Slow responses, commands go to wrong daemon, inconsistent behavior.

**Root cause:** `agent-browser-heal` (before fix) only killed one daemon PID when `pgrep` returned multiple PIDs. The variable `pid=$(pgrep "agent-browser-d")` captures all PIDs as one string, and `kill` treats it as a single argument.

**Reproduction:**
```bash
# 1. Start a daemon
agent-browser --session-name terra open "about:blank"

# 2. Heal (old version - only kills one)
agent-browser-heal --force

# 3. Immediately start another
agent-browser --session-name terra open "about:blank"

# 4. Check
pgrep "agent-browser-d" | wc -l  # > 1
```

**Fix:** Updated `agent-browser-heal` to kill all daemons:
```bash
pgrep "agent-browser-d" | while read -r pid; do
  kill "$pid" 2>/dev/null
done
```

**Prevention:** `ab heal` uses the fixed `agent-browser-heal`.

**Confirmed:** 2026-03-20. Found 3 stale daemons running simultaneously.

---

## F4: Headed Launch Fails When Chrome Is Running

**Symptom:** "Chrome exited early (exit code: 0) without writing DevToolsActivePort"

**Root cause:** `--headed` tries to launch a new Chrome instance, but Chrome is already running with the user's personal profile. Chrome exits immediately because it detects another instance.

**Reproduction:**
```bash
# 1. Have Chrome open (user's personal browser)
# 2. Try headed launch with a new session
agent-browser --session-name test --headed open "https://example.com"
# ✗ Chrome exited early (exit code: 0)
```

**Fix:** Use `--auto-connect` instead, which attaches to the already-running Chrome:
```bash
agent-browser --session-name terra --auto-connect open "https://example.com"
```

**Prevention:** The `ab` wrapper tries this cascade automatically:
1. Existing session (already connected)
2. `--auto-connect` (attach to running Chrome)
3. `--headed` (launch new — only works if Chrome isn't running)
4. Auto-heal

**Confirmed:** 2026-03-21. `test-stale-chunk.sh` failed with this error.

---

## F5: `close` Recommended in Upstream Docs

**Symptom:** Users/agents follow upstream SKILL.md docs and run `close`, triggering F1.

**Root cause:** The official agent-browser SKILL.md recommends `agent-browser close` in multiple places (session persistence, cleanup, iOS). This is safe in ephemeral/CI environments but destructive in persistent daemon setups like ours.

**Fix:** Our `/browser` skill has safety rules at the top that override upstream. The `ab` wrapper blocks `close` with an error message.

**Prevention:** Always use `ab` instead of raw `agent-browser`. The wrapper blocks the command:
```bash
ab close
# ✗ BLOCKED: 'close' corrupts the browser profile and breaks daemon state.
#   To reset: ab heal
```

**Confirmed:** 2025-08 through 2026-03. Multiple incidents traced to `close` being run.

---

## F6: Sandbox Can't Spawn Chrome

**Symptom:** `cco-permissions --resume` fails with browser errors.

**Root cause:** The cco Seatbelt sandbox doesn't allow launching new processes. The daemon must be started BEFORE entering the sandbox.

**Fix:** `cco-permissions` calls `ab ensure` before launching `cco`, which starts the daemon outside the sandbox. The sandbox can then communicate with the daemon over the Unix socket.

**Prevention:** Always use `cco-permissions` to start Claude Code sessions that need browser access. Never try to start the daemon from within a cco session.

**Confirmed:** 2025-08. Architecture constraint, not a bug.

---

## F7: `claude` Not in PATH After `.zshrc` Changes

**Symptom:** `cco-permissions` starts but `cco` fails with "Error: claude not found in PATH"

**Root cause:** `~/.local/bin` (where the `claude` symlink lives) wasn't being added to PATH. This happened after `.zshrc` was restored from an older version that was missing the `export PATH="$HOME/.local/bin:$PATH"` line.

**Fix:** Add `export PATH="$HOME/.local/bin:$PATH"` to `.zshrc`.

**Prevention:** `.zshrc` is now committed to git (`~/.dotfiles`). PATH additions are explicit and version-controlled.

**Confirmed:** 2026-03-21. After `.zshrc` recovery.

---

## F8: Multiple Agents Compete for Same Browser Session

**Symptom:** One agent's `ab` command kills another agent's daemon mid-use. Browser becomes unresponsive for both.

**Root cause:** Multiple Claude Code sessions using `--session-name terra` share one CDP target. When one session runs heal (killing the daemon), the other session loses its connection. The heal cascade in `ab` is particularly destructive since it nukes the profile.

**Reproduction:**
```bash
# Terminal 1: Agent A is using the browser
ab open "https://example.com"

# Terminal 2: Agent B tries to use the browser (fails, triggers heal)
ab open "https://other-site.com"
# Heal kills the daemon Agent A was using
```

**Fix:** Auto-detect unique session names per Claude Code session:
```bash
# cco-permissions extracts --resume <session-id> and exports it
export CCO_SESSION_ID="abc12345-..."

# ab uses first 8 chars as session suffix
# Agent A → terra-abc12345
# Agent B → terra-def67890
```

**Prevention:** `ab` auto-detects session names from context:
1. `CCO_SESSION_ID` env var (set by `cco-permissions` from `--resume <id>`) → `terra-<first8>`
2. Worktree name (if in `.claude/worktrees/`) → `terra-<worktree>`
3. Fall back to `terra` (manual use only)

**Confirmed:** 2026-03-21. Observed in screenshot — `smarter-dual-write-warnings` session killed daemon used by `semantic-tokens` session.

---

## F9: `--disable-features` Commas Parsed as Arg Separators

**Symptom:** Chrome opens junk tabs with URLs like `optimizationguidelmodeldownloading/`, `translate/`, `sparerenderersforsiteperprocess/`.

**Root cause:** agent-browser's arg parser splits the `args` config string on both commas and newlines (source: `cli/src/main.rs:674`). The `--disable-features=X,Y,Z` flag uses commas to separate feature names, so `Y` and `Z` become separate Chrome arguments, which Chrome interprets as URLs.

**Reproduction:**
```json
// ~/.agent-browser/config.json
{
  "args": "--disable-features=Translate,MediaRouter,SpareRendererForSitePerProcess"
}
// Chrome opens tabs: translate/, mediarouter/, sparerenderersforsiteperprocess/
```

**Fix:** Remove `--disable-features` from config. The `args` field is `Option<String>` in the source — no array support, and comma-splitting is hardcoded.

**Prevention:** Never use comma-containing Chrome flags in the `args` config. If needed, pass via `AGENT_BROWSER_ARGS` env var where you can control the format, or accept that the ML model download prevention flags aren't critical.

**Confirmed:** 2026-03-21. Observed junk tabs in Chrome after every heal/launch.

---

## F10: `do_heal` Blocks When Output Piped Through `sed`

**Symptom:** `ab` hangs after heal reports "Browser is working!" — the post-heal health check never runs.

**Root cause:** `agent-browser-heal --force 2>&1 | sed 's/^/  /' >&2` — the pipe through `sed` holds file descriptors open. When `agent-browser-heal` spawns a background daemon process, that daemon inherits the pipe's FDs. `sed` waits for EOF on stdin, which never comes because the daemon is still running with the inherited FD.

**Reproduction:**
```bash
# In ab's do_heal function:
agent-browser-heal --force 2>&1 | sed 's/^/  /' >&2
echo "this line never prints"  # Blocked by sed waiting for daemon's inherited FD
```

**Fix:** Remove the `sed` pipe. Send heal output directly to stderr:
```bash
agent-browser-heal --force >&2 || true
```

**Prevention:** Never pipe long-running commands (or commands that spawn daemons) through `sed`/`grep`/`awk`. The daemon inherits the pipe FDs and blocks the pipeline.

**Confirmed:** 2026-03-21. Debug canary proved `do_heal` was not returning when piped through `sed`.

---

## Quick Reference: Recovery Playbook

| Symptom | Likely cause | Fix |
|---------|-------------|-----|
| "CDP response channel closed" | F1: Profile corruption | `ab heal` |
| Command hangs forever | F2: No timeout on dead Chrome | Ctrl+C, then `ab heal` |
| Slow/inconsistent responses | F3: Multiple daemons | `pkill -f agent-browser-d && ab heal` |
| "Chrome exited early (exit code: 0)" | F4: Chrome already running | `ab open <url>` (uses auto-connect) |
| "claude not found in PATH" | F7: Missing PATH entry | Check `~/.local/bin` is in PATH |
| Can't start browser from cco session | F6: Sandbox restriction | Exit session, run `ab ensure`, re-enter |
| Other agent killed my browser | F8: Shared session name | Auto-fixed: `ab` now uses per-session names |
| Chrome opens junk tabs | F9: Comma-separated args | Remove `--disable-features` from config |
| `ab` hangs after "Browser is working!" | F10: Pipe blocks on daemon FDs | Don't pipe heal output through sed |

---

## Diagnostic Commands

```bash
ab status                              # Overall health check (shows auto-detected session name)
ab ensure                              # Ensure browser is connected
pgrep -la "agent-browser-d"           # List daemon processes
pgrep -la "Google Chrome" | wc -l     # Count Chrome processes
cat ~/.agent-browser/default.pid       # Daemon PID
ls -la ~/.agent-browser/default.sock   # Socket exists?
ab get url                             # Current page (with timeout)
```

---

## Prevention Architecture

The `ab` wrapper (`~/.local/bin/ab`) encodes all of the above:

1. **Blocks `close`** → prevents F1
2. **Timeouts all health checks** → prevents F2
3. **`ab heal` kills ALL daemons** → prevents F3
4. **Auto-connect cascade** → prevents F4
5. **`ab ensure` before sandbox** → prevents F6
6. **Per-session browser names** → prevents F8
7. **No comma-containing args in config** → prevents F9
8. **No piped heal output** → prevents F10

## Session Name Auto-Detection

`ab` automatically assigns unique browser sessions to avoid conflicts:

| Context | Session name | How |
|---------|-------------|-----|
| `cco-permissions --resume abc12345-...` | `terra-abc12345` | `CCO_SESSION_ID` env var (first 8 chars) |
| Worktree `.claude/worktrees/foo` | `terra-foo` | Directory name detection |
| Manual terminal use | `terra` | Default fallback |
| Explicit override | anything | `AB_SESSION=custom ab open ...` |

Multiple agents can use the browser simultaneously — each gets its own CDP target in the shared daemon.
