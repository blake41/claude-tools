# Handoff: cco-permissions sandbox-mode fix + oracle CLI upgrade

Written by a previous Claude Code session that diagnosed both issues but hit
a permission wall implementing them. Run this from a session launched with:

```
cco-permissions --no-sandbox
```

(Task 2 specifically needs this — bare `cco-permissions` sandboxes writes to
some of the paths below via kernel-level Seatbelt, and that can't be lifted
mid-session. Task 1 alone could run sandboxed, but just use `--no-sandbox`
for both.)

---

## Task 1 — Finish installing the patched `oracle` CLI

**Why:** User wants oracle's PR #323 fix (effort/thinking-level not sticking
on `--browser-model-strategy current`, merged 2026-07-13 to `steipete/oracle`
main). It is NOT in the latest published npm version (`@steipete/oracle@0.16.0`,
published 2026-07-12, one day *before* the fix merged). `bun add -g` can't get
it either way — bun's `minimum-release-age` policy (7 days) blocks anything
that recent even once npm catches up.

**State already done:**
- Source cloned + built at `/tmp/oracle-src` (commit `8e3456e7f2d...`, the
  exact PR #323 merge commit). Check it's still there — `/tmp` can get wiped
  between sessions:
  ```
  ls /tmp/oracle-src/dist/bin/oracle-cli.js
  ```
  If missing, redo it:
  ```
  git clone --depth 1 https://github.com/steipete/oracle.git /tmp/oracle-src
  cd /tmp/oracle-src
  git log -1 --format='%H %s'   # confirm it mentions PR #323 / current-model-ignore-inherited-effort
  bun install
  bun run build
  ```
- `~/.bun/bin/oracle` currently points at the *wrong* thing: npm `0.15.2`
  (accidentally downgraded from `0.16.0` by an earlier `bun update` attempt
  that hit the minimum-release-age block and silently resolved to an older
  version instead of erroring cleanly). Worth flagging to the user as a bun
  footgun, but not fixing bun itself — just fixing the oracle install.

**What to do:**

1. Copy the built source to a persistent, already-writable location —
   `~/.bun` is on the cco allowlist read-write, so use a subdir there (avoids
   needing any new allowlist entry):
   ```
   cp -R /tmp/oracle-src ~/.bun/oracle-src
   ```
2. Repoint the global bins directly at the built files (bypasses bun's
   package-management tracking entirely, which is fine — this is a manual
   override until npm publishes a version containing the fix):
   ```
   ln -sf ~/.bun/oracle-src/dist/bin/oracle-cli.js ~/.bun/bin/oracle
   ln -sf ~/.bun/oracle-src/dist/bin/oracle-mcp.js ~/.bun/bin/oracle-mcp
   ```
3. Verify:
   ```
   oracle --version          # should print 0.16.0 (package.json version)
   readlink ~/.bun/bin/oracle  # should point into ~/.bun/oracle-src
   ```
4. Tell the user this is a manual pin — the next `bun add -g @steipete/oracle`
   or `bun update -g` will silently revert to whatever npm has published,
   which may not include the fix yet. Once npm publishes a version built
   from a commit at or after `8e3456e7f2d...`, switch back to normal
   `bun add -g @steipete/oracle@latest` and remove `~/.bun/oracle-src`.

---

## Task 2 — Make cco-permissions preserve sandbox mode across cmux auto-resume

**Background:** `~/Documents/Development/tools/sandbox/cco-permissions.fish`
defines two fish functions: `cco-permissions` (the thing the user types) and
`claude` (an interceptor that only matters inside cmux panes, via
`$CMUX_SURFACE_ID`).

The user's **only** manual invocations, ever, are:
```
cco-permissions
cco-permissions --resume <id>
cco-permissions --no-sandbox --resume <id>
cco-permissions --no-sandbox
```
They never type bare `claude` themselves. So every time the `claude()`
interceptor fires, it's cmux's `terminal.autoResumeAgentSessions` (see
`~/.config/cmux/cmux.json`) silently retyping `claude --resume <id>` into an
existing pane to restore a dropped session — cmux only ever types that exact
bare form, no flags.

**The bug:** `claude()` currently *always* routes auto-resume through bare
`cco-permissions --resume <id>` (see lines 179-184 in the current file),
discarding whatever mode (`--no-sandbox` or sandboxed) the session was
originally launched in. A session that the user explicitly ran with
`--no-sandbox` silently comes back sandboxed after any auto-resume, with no
visible relaunch — looks like the running session just "became" sandboxed
mid-conversation.

**The fix:** persist the mode chosen at every `cco-permissions` invocation,
keyed by session id, in a small state file. Have `claude()` read that file on
auto-resume instead of hardcoding sandboxed. This covers the fact that
auto-resume and casual manual bare-resume are indistinguishable at the shell
level — both fall back to "whatever mode this session id was last run in,"
which is exactly the desired behavior for all four of the user's invocation
forms above (an explicit `--no-sandbox` or its absence always updates the
stored mode for that session id, so the *next* auto-resume replays it
correctly).

Mode files live under `~/.cmux/claude-sessions/mode/<session_id>` —
`~/.cmux` is already on the cco write-allowlist, and this mirrors the
existing `~/.cmux/claude-sessions/by-session/` convention from
`~/.cmux/cmux-session-watch`.

### Edit 1 — write the mode file on every `cco-permissions` launch

In the `cco-permissions` function, current lines 58-62:

```fish
    set -gx CCO_SESSION_ID $session_id

    if not contains $HOME/.local/bin $PATH
        set -x PATH $HOME/.local/bin $PATH
    end
```

Replace with:

```fish
    set -gx CCO_SESSION_ID $session_id

    # Persist the chosen mode so a later auto-resume (cmux's
    # autoResumeAgentSessions, via the claude() interceptor below) can boot
    # back into the same mode instead of always forcing sandboxed.
    set -l mode_dir ~/.cmux/claude-sessions/mode
    mkdir -p $mode_dir
    if $skip_sandbox
        echo "no-sandbox" >$mode_dir/$session_id
    else
        echo "sandboxed" >$mode_dir/$session_id
    end

    if not contains $HOME/.local/bin $PATH
        set -x PATH $HOME/.local/bin $PATH
    end
```

### Edit 2 — read the mode file in the `claude()` interceptor

Current lines 174-186:

```fish
            if test "$flag" = --resume -o "$flag" = -r -o "$flag" = --continue -o "$flag" = -c
                # Pass only the resume flag + session ID to cco-permissions — drop
                # any other flags cmux replayed from the original launch (e.g.
                # --no-sandbox, --dangerously-skip-permissions) so resumed sessions
                # always start sandboxed.
                set -l next (math $i + 1)
                if test $next -le (count $argv)
                    cco-permissions $flag $argv[$next]
                else
                    cco-permissions $flag
                end
                return
            end
```

Replace with:

```fish
            if test "$flag" = --resume -o "$flag" = -r -o "$flag" = --continue -o "$flag" = -c
                # Pass the resume flag + session ID to cco-permissions, restoring
                # whatever mode (sandboxed / --no-sandbox) that session id was
                # last explicitly launched with — see Task 2 in
                # HANDOFF-sandbox-mode-persistence.md for why this can't
                # distinguish cmux auto-resume from a bare manual resume (both
                # are byte-identical at the shell level), and why that's fine.
                set -l next (math $i + 1)
                set -l resume_id ""
                if test $next -le (count $argv)
                    set resume_id $argv[$next]
                end
                set -l resume_extra
                set -l mode_file ~/.cmux/claude-sessions/mode/$resume_id
                if test -f $mode_file
                    if test (cat $mode_file) = "no-sandbox"
                        set resume_extra --no-sandbox
                    end
                end
                if test -n "$resume_id"
                    cco-permissions $resume_extra $flag $resume_id
                else
                    cco-permissions $resume_extra $flag
                end
                return
            end
```

Also update the misleading comment on line 166-169 (file header above
`function claude`) — it currently says "restored sessions run inside the
seatbelt sandbox" unconditionally; change to something like "restored
sessions boot back into whichever mode (sandboxed or --no-sandbox) they were
last launched with."

### Why no other changes are needed

- Sessions with no mode file yet (started before this fix) fall through to
  the `else` branch → `resume_extra` stays empty → sandboxed. Same as today's
  behavior, so nothing regresses for old sessions.
- `--no-sandbox` and `--resume` in the same launch (the user's 3rd form)
  already goes through `cco-permissions` directly, never through `claude()` —
  Edit 1 alone (over)writes the mode file back to `no-sandbox` for that
  session id on every explicit manual invocation, which is exactly the
  "latest explicit choice wins" behavior wanted.

### Verification steps

1. `cco-permissions --no-sandbox` → note the printed session id (or
   `echo $CCO_SESSION_ID` inside the session). Exit.
   ```
   cat ~/.cmux/claude-sessions/mode/<id>   # expect: no-sandbox
   ```
2. Simulate an auto-resume outside of cmux (since `claude()` only intercepts
   when `$CMUX_SURFACE_ID` is set):
   ```
   set -x CMUX_SURFACE_ID test-probe
   claude --resume <id>
   ```
   Confirm it launches unsandboxed — e.g. `CCO_SANDBOX_OFF` should be `1` in
   that session's env, and a write to a normally-blocked path (e.g.
   `touch ~/test-probe`) should succeed.
3. Repeat with a plain `cco-permissions` (no `--no-sandbox`) launch → mode
   file should say `sandboxed` → simulated resume should stay sandboxed
   (`touch ~/test-probe` should fail with EPERM).
4. Toggle test: launch `cco-permissions --no-sandbox`, exit, then manually
   `cco-permissions --resume <id>` (no `--no-sandbox`) → mode file should
   flip to `sandboxed` → a subsequent simulated auto-resume should be
   sandboxed too (confirms "latest explicit choice wins").

Unset `$CMUX_SURFACE_ID` and clean up any `~/test-probe` files after testing.
