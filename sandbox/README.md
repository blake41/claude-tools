# claude-sandbox

Thin Seatbelt (macOS) / bubblewrap (Linux) wrapper that runs Claude Code in a write-fenced sandbox. Claude gets `--dangerously-skip-permissions` but can only write to explicitly allowlisted directories.

## How it works

Generates a macOS Seatbelt policy at launch:
- **Allow all reads** (Claude can see everything)
- **Deny all writes** (kernel-enforced)
- **Whitelist specific write paths** from the dirs file

Network is unrestricted. Claude runs as your user with full Keychain access.

**Process inheritance:** Any process Claude spawns inherits the Seatbelt policy. Processes can execute freely but can only write to allowlisted paths. Chrome works inside the sandbox as long as its write paths (`~/.agent-browser`, `~/Library/Caches`, `~/Library/Application Support`, `/tmp`) are in the allowlist.

## Files

| File | Location | Purpose |
|------|----------|---------|
| `claude-sandbox` | `~/.local/bin/claude-sandbox` (symlink) | Seatbelt/bwrap sandbox launcher |
| `sandbox-request` | `~/.local/bin/sandbox-request` (symlink) | Request sandbox expansion from inside a session |
| `cco-cmux-claude` | `~/.local/bin/cco-cmux-claude` (symlink) | cmux's claude wrapper with the `--resume` transcript lookup fixed |
| `cco-claude-shim` | `~/.local/bin/cco-claude-shim` (symlink) | Routes cmux auto-resume into the fish `claude()` interceptor |
| `dirs` | `tools/sandbox/dirs` (this directory) | Write allowlist |

## Dirs file format

```
~/Documents/Development/          # read-write (default)
~/Library/Preferences:ro          # read-only
~/Documents/Development/tools/sandbox:ro  # read-only (protects this directory)
```

Suffix `:ro` for read-only, `:rw` or no suffix for read-write. Lines starting with `#` are comments.

**Security:** The dirs file marks its own directory (`tools/sandbox/`) as `:ro`. Since `~/Documents/Development/` is rw but `tools/sandbox/` is explicitly `:ro`, Seatbelt applies the more specific rule — Claude can't edit the allowlist or the sandbox script.

## Launch wrapper

`cco-permissions` in `~/.config/fish/config.fish` handles:
1. Browser preflight (`ab ensure`)
2. cmux session auto-resume
3. Reading the dirs file into `--write`/`--read-only` flags
4. Adding `~/.claude` and `~/.claude.json` as always-writable
5. Calling `claude-sandbox -- claude --dangerously-skip-permissions`
6. Expansion loop (see below)

## Fast resume inside cmux

cmux's `cmux-claude-wrapper` checks `--resume <id>` by expanding five deep globs over `~/.claude/projects` in one `for` list, so every resume walks the whole tree (1-4s). Inside cmux, `cco-permissions` launches `cco-cmux-claude` instead of `claude`. It patches that one loop in memory (~50ms), runs the patched text with `$0` set to the real wrapper, and falls back to cmux's stock shim if the wrapper changed. Nothing is written to disk and `/Applications/cmux.app` is not touched.

`CCO_FASTWRAP_DISABLE=1` forces the stock path. `cco-claude-shim` starts its inner fish with `--no-config` and sources only `cco-permissions.fish`.

Startup trace (on by default, `CCO_STARTUP_TRACE=0` turns it off): `<epoch> <session-id> <point> [detail]` lines in `~/.cmux/cco-startup-trace.log`. Points: `enter` (mode, load average, debug-file path), `ab-ensure-start`, `ab-ensure-done`, `exec`, `wrapper-done`, then `session-start` and `prompt-submit` from hooks in `~/.claude/settings.json` that run only when `CCO_SESSION_ID` is set. claude also gets `--debug-file /tmp/cco-startup-debug-<session>-<epoch>.log`.

## Sandbox expansion

When Claude hits `Operation not permitted` on a path it needs:

1. Claude runs `sandbox-request <path>` (queues a request in `/tmp`)
2. User types `/exit`
3. The fish wrapper shows the requested paths and asks for approval
4. If approved, the wrapper creates the directory and relaunches with `--resume` and the wider Seatbelt policy
5. Claude's conversation state is preserved; the write now succeeds

On approval, expansions are **permanent by default** (appended to the dirs file). Press `s` for session-only, `n` to deny.

```
sandbox-request <path>          # Request read-write access
sandbox-request <path> --ro     # Request read-only access
```

## Statusline indicator

`~/.claude/statusline.sh` shows a lock icon based on `CCO_SESSION_ID` env var:
- `🔒 sandbox` — running inside `cco-permissions`
- `🔓 no sandbox` — running bare Claude

## Origin

Extracted from [cco](https://github.com/nikvdp/cco) (the `sandbox` script). The rest of cco (Docker, credential bridging, image management) was unused on macOS with native Seatbelt.

## Updating

This is a standalone 390-line bash script with no dependencies beyond `sandbox-exec` (macOS built-in) or `bwrap` (Linux). It rarely needs updates.
