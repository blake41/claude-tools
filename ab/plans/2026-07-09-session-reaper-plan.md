---
title: ab Session Reaper — 3-State Liveness + Active gc
date: 2026-07-09
status: planned
origin: fable advisory session (session bookkeeping investigation, 2026-07-09)
---

# ab Session Reaper — 3-State Liveness + Active gc

## Context: What happened

Post-`ab heal`, ground truth was measured directly: **82 marker files in /tmp, but only 1
live per-session agent-browser daemon and 2 real Chrome pages** (CDP `/json/list` on port
9333). `ab ps` reported all 82 as "live". The liveness bookkeeping is marker-file-based
and never reconciled against actual daemon or Chrome state.

### Root cause (verified in source)

All in `src/cli.ts`:

- `listSessionEntries()` + `SessionEntry` (**cli.ts:608-658**) — liveness is binary:
  file exists = "live", `mtime > STALE_AGE_MS` = "stale". The code's own comment
  (cli.ts:599-601) admits this: *"We don't query the daemon for liveness... For now,
  file exists = live."*
- Constants (**cli.ts:604-606**): `SESSION_FILE_PREFIX = "/tmp/.ab-session-"`,
  `WRAPPER_PREFIX = "/tmp/ab-"`, `STALE_AGE_MS = 24h`.
- `cmdGc` (**cli.ts:708-731**) only ever removes `stale` entries. There is no reaping
  at any shorter interval, and nothing ever runs gc automatically.
- Staleness is computed from `stat.mtimeMs` (**cli.ts:641**), and nothing ever touches
  the marker after creation (`cmdNewSession`, cli.ts:586-594, is the only writer). So
  "age" tracks *creation time*, not last activity — a session used continuously for
  23h and one abandoned after 1 minute look identical.
- `ab-subagent-hook` (`~/.claude/hooks/ab-subagent-hook`) mints a fresh
  session/marker/wrapper for **every** subagent spawn, no reuse. This is where the 82
  markers came from.
- `browser-skill-cleanup` (`~/.claude/hooks/browser-skill-cleanup`, Stop hook) cleans
  only the main-thread marker; its own comment defers subagent cleanup pending
  confirmation of SubagentStop park-vs-terminate semantics.

### What already exists and can be reused

- The `close` command (**cli.ts:981-1002**) is exactly the safe teardown a reaper
  needs: check ab-server daemon via `rpc.status()`, only if `chrome_up` run the
  agent-browser close passthrough, then unlink both markers. Never boots Chrome,
  no-ops cleanly when nothing is running.
- Per-session daemon liveness is checkable for free: agent-browser writes
  `~/.agent-browser/ab-<pid>.pid` (contains the daemon's OS pid) while the daemon is
  alive, removed on exit. Verified: the one live session has `.pid`/`.sock` files;
  the 20+ dead ones have only `.version` remnants.
- `AGENT_BROWSER_IDLE_TIMEOUT_MS` is already injected on every passthrough
  (**cli.ts:121**, default 600000 = 10 min) — agent-browser's own per-session daemon
  idle timeout. **Unconfirmed** whether that daemon closes its Chrome target when it
  self-exits (see Unit 0).
- launchd already runs `com.clay.ab-server.plist`
  (`~/Library/LaunchAgents/com.clay.ab-server.plist`) — the pattern to copy for a
  gc timer.

## Approach

Three-state liveness (`active` / `idle` / `stale`) computed from real daemon state, an
`ab gc` that actively reaps *idle* sessions after a grace window by reusing the `close`
teardown, mtime-touch on every invocation so idle time means last-activity, and a
launchd interval timer as the enforcement mechanism. **No new daemon RPC surface, no new
hooks.**

### Explicit non-goals (record the reasoning, don't relitigate later)

1. **No SubagentStop hook.** The reaper covers everything a SubagentStop hook would
   (session ended → daemon exits at idle timeout → entry goes idle → gc reaps it),
   *plus* cases a hook can never catch: crashed agents, `kill -9`'d sessions, sandbox
   teardown without hook execution. And SubagentStop's park-vs-terminate semantics are
   still unconfirmed (see browser-skill-cleanup's own comment) — a hook that fires on
   *park* would destroy a live parked agent's session. The reaper's grace window
   handles parking gracefully; a hook cannot.
2. **No `ab heal` on any timer.** `heal` is machine-wide destructive (kills every
   session's Chrome). Manual-only, forever.

## Constraint: pre-existing user WIP in this repo

`git status` shows uncommitted modifications to **`src/chrome-supervisor.ts`** and
**`sandbox/cco-permissions.fish`** (plus untracked `SETUP.md`), unrelated to this work.
Implementation must not touch, revert, stage, or conflict with those files. All changes
in this plan live in `src/cli.ts`, `src/__tests__/ps.test.ts`, and a new launchd plist —
verify with `git diff --stat` before finishing that only those are modified.

## Units

### Unit 0 — Spike: does agent-browser self-reap its Chrome target? (~15 min, do first)

**Why:** This determines what the reaper is *for*. If the per-session daemon closes its
Chrome target when it hits `AGENT_BROWSER_IDLE_TIMEOUT_MS`, then tabs were never the
resource drain (today's contention was concurrent-active daemons on one CDP socket) and
this plan's value is fixing false-diagnosis bookkeeping + defense in depth. If it does
NOT, the reaper is load-bearing for tab leakage. Either way the plan proceeds unchanged
— but the answer must be recorded.

**Procedure:**
1. `curl -s localhost:9333/json/list | jq length` — baseline target count.
2. In a throwaway session: `ab new-session && ab open https://example.com` (or via a
   wrapper). Confirm target count +1 and `~/.agent-browser/ab-<pid>.pid` exists.
3. Wait 11 minutes (timeout is 10). Re-check: is the `.pid` file gone (daemon
   self-exited)? Is the target count back to baseline (tab closed) or still +1
   (orphan tab)?

**Deliverable:** update this plan's status notes with the observed answer
(`self-reaps: yes/no`). No code.

### Unit 1 — 3-state model in `listSessionEntries` + `ab ps`

**File:** `src/cli.ts` (cli.ts:596-706), tests in `src/__tests__/ps.test.ts`.

1. Add helper:
   ```ts
   /** Returns the per-session daemon's OS pid if alive, else null. */
   function daemonPidAlive(sessionPid: string): number | null
   ```
   Reads `~/.agent-browser/ab-<sessionPid>.pid`; parse int; `process.kill(pid, 0)` in
   try/catch (ESRCH = dead, EPERM = alive). Missing file or dead pid → null.
2. Extend `SessionEntry` (cli.ts:608-615): replace `stale: boolean` with
   `state: "active" | "idle" | "stale"` and add `daemonPid: number | null`.
   Derivation in `listSessionEntries` (cli.ts:617-658):
   - `active` — `daemonPidAlive()` returned a pid
   - `stale` — daemon dead AND `ageMs > STALE_AGE_MS`
   - `idle` — daemon dead, not yet stale
   (CDP `/json/list` cross-check is explicitly deferred — pid-file check is sufficient
   for v1 and keeps this unit dependency-free.)
3. `cmdPs` (cli.ts:678-706): STATUS column prints the state; the "Run `ab gc`" hint
   fires when any entry is `idle` or `stale`.
4. Update `ps.test.ts` (`Unit 4 contract tests`) for the new `--json` shape and
   status words. Add a case: marker + fake alive pid file (write own `process.pid`)
   → `active`; marker with no pid file → `idle`/`stale` by age.

**Verify:** `cd ~/Documents/Development/tools/ab && bun test src/__tests__/ps.test.ts`;
then live: `ab ps` must show exactly the sessions whose `~/.agent-browser/ab-*.pid`
pids are alive as `active`.

### Unit 2 — Touch marker mtime on every real invocation

**File:** `src/cli.ts`, in `main()` right after session identity resolution
(cli.ts:889-891).

```ts
const NO_TOUCH_COMMANDS = new Set(["ps", "gc", "new-session"]);
// after: const pid = resolvePid();
if (command && !NO_TOUCH_COMMANDS.has(command)) {
  try {
    const now = new Date();
    fs.utimesSync(sessionFilePath(pid), now, now);
  } catch { /* marker not initialized — fine */ }
}
```

- `new-session` excluded because it creates the file itself; `ps`/`gc` excluded so the
  launchd-driven gc (which resolves to pid `"default"`) can never keep a marker
  perpetually fresh, and inspecting state doesn't count as activity.
- After this, `ageSeconds` means "seconds since last use", which is what both the
  grace window and the 24h threshold actually want.

**Verify:** `touch -t 202601010000 /tmp/.ab-session-<self>`, run `ab status`, then
`ab ps` — own entry's age must have reset to seconds.

### Unit 3 — `ab gc` becomes an active reaper

**File:** `src/cli.ts` — `cmdGc` (cli.ts:708-731) becomes `async`; update the dispatch
call at cli.ts:942 to `await cmdGc(rest)`.

Constants (next to cli.ts:604-606):
```ts
const IDLE_GRACE_MS = Number(process.env.AB_GC_IDLE_GRACE_MS ?? 30 * 60 * 1000);
```

New behavior, per entry from `listSessionEntries()`:

| state | action |
|---|---|
| `active` | never touched |
| `idle`, age ≤ grace | skipped (parked-agent protection) |
| `idle`, age > grace | **close teardown** + unlink session marker; **keep wrapper shim** |
| `stale` (>24h) | close teardown + unlink marker **and** wrapper |

- **Close teardown** = the `close` command's existing logic (cli.ts:981-1002),
  extracted so gc can reuse it:
  ```ts
  async function teardownSession(sessionPid: string, chromeUp: boolean, cdpPort: number): Promise<void>
  ```
  gc calls `rpc.status()` **once** before the loop (headless state only; `chrome_up` →
  use its port), then per entry runs
  `runAgentBrowser(cdpPort, buildSessionName(entry.pid), ["close"])` when Chrome is up.
  Same guarantee as `close`: never boots Chrome, no-op when nothing runs. Note: for an
  idle entry this transiently spawns a per-session daemon to close the orphan tab —
  acceptable, it exits immediately after. Refactor `close` (cli.ts:981-1002) to call
  the extracted helper so there is one teardown path.
- **Wrapper retention rationale:** a parked background agent's only *hard* break is
  losing its wrapper shim mid-park (its next command literally won't execute). Losing
  the tab/marker is a soft break (fresh tab on resume). So the wrapper survives until
  the 24h stale threshold.
- **Orphan-wrapper pass:** because idle-reap unlinks the marker but keeps the wrapper,
  `listSessionEntries` (which enumerates markers) will no longer see it. Add a second
  pass: enumerate `/tmp/ab-*` where basename matches `/^ab-[0-9a-f][0-9a-f-]*$/i`, is a
  regular executable file, has **no** matching `/tmp/.ab-session-<pid>` marker, and
  mtime > `STALE_AGE_MS` → unlink. **Guard hard against name-adjacent files** —
  `/tmp/ab-server-out.log`, `/tmp/ab-server-error.log` share the prefix. This is the
  exact bug class from `plans/runtime-invariants.md` history item 3 (sidecar glob
  deleted `ab-server.sock`); the regex + executable + no-extension checks are the
  defense.
- `--dry-run` prints per-entry: pid, state, age, and the action it *would* take
  (including "skip: within grace window").
- Headed sessions are out of scope: the ab-server daemon already manages headed
  Chrome's idle lifecycle (`rpc.touchHeaded()`, cli.ts:1010); gc reaps against the
  headless port only.

**Verify:** unit tests in `ps.test.ts` (or a new `gc.test.ts` beside it) with
fabricated markers/wrappers in a temp-controlled `/tmp` set: idle-young skipped,
idle-old reaped keeping wrapper, stale reaped fully, orphan wrapper aged out,
`ab-server-out.log` untouched. Then live: `ab gc --dry-run` against the real /tmp
mess and eyeball the verdicts before running `ab gc` for real; afterwards
`curl -s localhost:9333/json/list | jq length` should equal the active-session count
(+1 for about:blank if present).

### Unit 4 — launchd timer: `com.clay.ab-gc.plist`

**File (new):** `~/Library/LaunchAgents/com.clay.ab-gc.plist` — sibling of
`com.clay.ab-server.plist`, copy its `EnvironmentVariables`/log-path pattern but use
`StartInterval` (1800 = 30 min) instead of `KeepAlive`:

- `ProgramArguments`: `/Users/blake/.local/bin/ab gc` (symlink →
  `tools/ab/ab`, verified).
- `StandardOutPath`/`StandardErrorPath`: `/tmp/ab-gc.log` (both).
- No `KeepAlive`, no `RunAtLoad` needed (`StartInterval` fires on load anyway is fine
  either way).

With a 30 min grace window + 30 min timer, worst-case reap of an idle session is
~60 min after last activity. This — not a new daemon RPC surface or in-daemon timer —
is the idle-timeout enforcement, deliberately: gc is a one-shot CLI, trivially
testable, and the daemon (currently mid-WIP in `chrome-supervisor.ts`) stays untouched.

**Verify:** `launchctl load ~/Library/LaunchAgents/com.clay.ab-gc.plist`, then
`launchctl kickstart gui/$(id -u)/com.clay.ab-gc` (or wait a cycle); check
`/tmp/ab-gc.log` shows a run and `ab ps` reflects reaping. Confirm the log shows
"Nothing to prune."-style output on a clean steady state rather than errors.

**STATUS: blocked in-sandbox (2026-07-09).** Units 0-3 are implemented and verified
(127/127 tests pass in `bun test`; `git diff --stat` confirms only `src/cli.ts` and
`src/__tests__/ps.test.ts` changed, `src/chrome-supervisor.ts`/`sandbox/cco-permissions.fish`
untouched). Unit 4 is the only remaining step — writing to `~/Library/LaunchAgents/`
was blocked by the sandbox write-allowlist (`~/.config/cco/dirs` doesn't include that
path). To finish, in an unsandboxed session:

1. Write this exact file to `~/Library/LaunchAgents/com.clay.ab-gc.plist`:

   ```xml
   <?xml version="1.0" encoding="UTF-8"?>
   <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
   <plist version="1.0">
   <dict>
   	<key>Label</key>
   	<string>com.clay.ab-gc</string>
   	<key>StartInterval</key>
   	<integer>1800</integer>
   	<key>ProgramArguments</key>
   	<array>
   		<string>/Users/blake/.local/bin/ab</string>
   		<string>gc</string>
   	</array>
   	<key>StandardOutPath</key>
   	<string>/tmp/ab-gc.log</string>
   	<key>StandardErrorPath</key>
   	<string>/tmp/ab-gc.log</string>
   	<key>EnvironmentVariables</key>
   	<dict>
   		<key>HOME</key>
   		<string>/Users/blake</string>
   		<key>PATH</key>
   		<string>/Users/blake/.bun/bin:/Users/blake/.local/bin:/opt/homebrew/bin:/opt/homebrew/opt/node@22/bin:/usr/local/bin:/usr/bin:/usr/sbin:/bin</string>
   	</dict>
   </dict>
   </plist>
   ```

2. Sanity check first: `/Users/blake/.local/bin/ab gc --dry-run` — eyeball the output
   against the real `/tmp` state before loading the timer (per the plan's own ordering:
   Unit 4 only after a manual `ab gc` run has been eyeballed). A real (non-dry-run)
   `ab gc` is safe to run for real at this point too, if the dry-run output looks right —
   it only reaps idle/stale entries, never active ones.
3. `launchctl load ~/Library/LaunchAgents/com.clay.ab-gc.plist`
4. `launchctl kickstart gui/$(id -u)/com.clay.ab-gc` (or wait ~30 min for the first
   automatic run)
5. Confirm `/tmp/ab-gc.log` shows a clean run, then `ab ps` reflects the reaping.

## Accepted tradeoff: reaping a parked agent's in-page state

If a background agent is parked longer than grace + timer (~60 min worst case) *and*
its per-session daemon has idle-exited, gc will close its orphan Chrome tab — any
in-page state (form contents, scroll position, SPA state) is lost. On resume the agent
gets a fresh tab via its still-present wrapper; auth state survives (profile-level).
This is accepted. Mitigations already in the design: the grace window, mtime-touch
(any activity resets the clock), active-daemon entries are never touched, and the
wrapper shim survives until 24h so the resumed agent's commands still execute.

## Implementation order

0. Unit 0 (spike — record the answer in this file)
1. Unit 1 (3-state model) — everything else reads its output
2. Unit 2 (mtime touch) — must land before the reaper so ages are meaningful
3. Unit 3 (reaper)
4. Unit 4 (launchd) — only after a manual `ab gc` run has been eyeballed

After each unit: `bun test` in `~/Documents/Development/tools/ab`, and
`git diff --stat` to confirm no drift into `src/chrome-supervisor.ts` or
`sandbox/cco-permissions.fish`.

## Files to modify

- `src/cli.ts` — 3-state `SessionEntry`/`listSessionEntries`/`cmdPs` (596-706),
  mtime touch in `main()` (~890), async `cmdGc` rewrite (708-731) + dispatch (942),
  `teardownSession` extraction from `close` (981-1002)
- `src/__tests__/ps.test.ts` — new shape + state derivation + gc behavior tests
- `~/Library/LaunchAgents/com.clay.ab-gc.plist` — new
- **Must not touch:** `src/chrome-supervisor.ts`, `sandbox/cco-permissions.fish`
  (pre-existing uncommitted user WIP)

## Spike result (Unit 0)

**self-reaps: yes** (daemon-level, confirmed) — **Chrome-target-level: unconfirmed
(confounded)**.

Opened a throwaway session (`AB_SESSION_PID=spike-reaper-test`), confirmed
`~/.agent-browser/ab-spike-reaper-test.pid` existed with a live pid immediately after
open. The wait was interrupted mid-run (sandbox permission block on Unit 4, session
paused, resumed later) — elapsed time ended up well past the 10-minute
`AGENT_BROWSER_IDLE_TIMEOUT_MS`, likely 20-30+ min. On recheck, the pid file was gone
entirely (`ls` returned nothing) — the per-session daemon self-exited and removed its
own pid file, confirming `daemonPidAlive()` (Unit 1) correctly reads "dead" once the
daemon idles out.

CDP `/json/list` target count could not be cleanly attributed to this one session — the
long, interrupted wait window overlapped with substantial unrelated concurrent activity
on the same shared daemon (other QA agents opening/closing tabs, an earlier `ab heal`
during the same broader session). So whether the daemon closes its own Chrome tab on
self-exit (vs. leaving an orphan target) stays unconfirmed by this spike.

**Does this change the plan?** No. The daemon-level self-exit confirms the `idle` state
detection in Unit 1 is sound (dead pid file ⇒ correctly detected as not-active). Per the
plan's own framing, if Chrome tabs turn out to also self-close, the reaper's value shifts
toward "fix false-diagnosis bookkeeping + defense in depth"; if not, the orphan-tab
teardown in Unit 3's `idle` branch is load-bearing. The implementation is correct either
way — proceed unchanged.
