---
title: ab Tab Teardown Fix — Close the Leaked Chrome Tabs
date: 2026-08-04
origin: plans/2026-07-09-session-reaper-plan.md (closes that plan's Unit-0 open risk; requirements supplied by a confirmed live diagnosis, no brainstorm doc)
status: shipped (2026-08-04, commit 9d90f2c) — approach for U1 pivoted during implementation; see "Implementation Note" below
---

# ab Tab Teardown Fix — Close the Leaked Chrome Tabs

## Overview

Fix a confirmed tab-leak bug in the `ab` CLI: `teardownSession` never actually closes a session's Chrome tab because the compiled `agent-browser` binary refuses to close a session's last remaining tab, so every reap leaks a live tab into the shared 3-shard headless Chrome pool. This plan (1) fixes the teardown sequence so the tab really closes and is CDP-verified, (2) adds a CDP-level orphan-tab backstop sweep to `ab gc`, and (3) adds per-shard tab-count visibility to `ab status`/`ab doctor` — plus a small fold-in fix for leaked `~/.agent-browser/ab-<pid>.config` files.

## Implementation Note: U1's Approach Pivoted (added post-ship)

R1/R2 and Decision 5 below describe the approach as originally planned:
blank-navigate the tab, defeat the last-tab guard by opening a throwaway
`about:blank` tab and closing the original by a runtime-discovered index,
then close the daemon. **That is not what shipped.** Two empirical findings
during U1 forced a different design, described here so the rest of this
document can be read as the historical record of what was planned rather
than a false account of what runs today:

1. **`agent-browser --session <name> tab` does not scope its listing to the
   session.** It enumerates every page on the shard regardless of
   `--session`, so a listing-based parser can never determine which index is
   "this session's tab" on a shard with more than one live session — the
   entire premise of Decision 5's runtime index discovery. Confirmed via
   cli.ts:1640-1644.
2. **Closing via raw CDP (`GET /json/close/<targetId>`) never touches the
   agent-browser binary's `tab close` command at all**, so the last-tab
   guard (`✗ Cannot close the last tab`) that R2 was designed to defeat
   simply never fires on this path — there is nothing to defeat. No
   blank-navigate step, no throwaway tab, no guard-defeat sequence exists in
   the shipped code.

**What shipped instead:** tab identity is captured once, at `ab open` time,
not rediscovered at teardown. `openTabAndRecordTarget` (cli.ts:1105-1124)
diffs the shard's `/json/list` before and after `tab new`; if exactly one
page appeared, that CDP `targetId` is recorded on the session's marker as a
`target=<port>:<id>` line (`recordSessionTarget`, cli.ts:387-406). If zero or
more than one page appeared — a concurrent agent opened a tab on the same
shard in that instant — nothing is recorded (skip-when-ambiguous: an
unrecorded tab leaks until U2's gc sweep collects it, which is safe;
mis-recording another agent's tab and later closing it is not).
`teardownSession` (cli.ts:1424-1523) closes exactly the recorded target ids
via raw CDP `closeCdpTarget`, then re-queries `/json/list` and confirms those
specific ids are gone (R3, unchanged from the original plan) — no index
guessing, no navigation, no binary-level guard interaction at all.

R1 (blank-before-close) and R3 (CDP-verified teardown) are satisfied by the
shipped design for the reasons above, R3 literally as originally specified.
R2 (guard-defeat via blank tab + index close) is satisfied in spirit — no
tab is left holding a live dev-server socket, and the guard never blocks a
close — but by a structurally different, simpler mechanism than R2
describes. Decision 5 (runtime index discovery) was superseded outright by
capture-at-open-time identity. U2's attribution mechanism (Deferred
question 2) resolved to marker-based recorded-target matching, not the
per-active-session `tab`-listing mechanism the plan preferred — precisely
because finding 1 above ruled that mechanism out.

## Problem Frame

The 2026-07-09 session-reaper plan shipped 3-state liveness (active/idle/stale) and left one explicit open risk unconfirmed: "whether the per-session agent-browser daemon closes its Chrome target when it self-exits" (plans/2026-07-09-session-reaper-plan.md:52-53). That risk is now **CONFIRMED as a real, actively-occurring bug** via direct log/CDP evidence:

**Confirmed root cause.** `teardownSession` (src/cli.ts:1043-1053) calls `tab close` then `close` on a session's per-session agent-browser daemon, but the compiled agent-browser Rust binary REFUSES to close a session's last remaining tab. This is logged as `✗ Cannot close the last tab` — 2,037 occurrences grepped in /tmp/ab-gc.log against ~2,342 total idle-session reaps logged since the file started (it fails on nearly every single reap). The session/marker bookkeeping IS working correctly — the reaper's gc (launchd-scheduled via `~/Library/LaunchAgents/com.clay.ab-gc.plist`, running every 30 minutes, `IDLE_GRACE_MS` = 30 min) is confirmed loaded, actively running, and correctly removing session markers/wrappers. The bug is ONE LEVEL BELOW that: the underlying Chrome tab is never actually closed, so it leaks into the shared 3-shard headless Chrome pool (ports 9333/9334/9335, managed by src/chrome-supervisor.ts) indefinitely, invisible to `ab ps` (which only reports session/marker state, not underlying Chrome tab state).

**Live impact confirmed 2026-08-03.** CDP `/json/list` queried directly against the 3 shards showed 39 total open pages, with ~35 still pointed at one specific worktree's dev server (each holding a live Vite HMR websocket connection). This was independently diagnosed as the root cause of a real dev-server outage: `lsof -iTCP:5229` showed ~80 ESTABLISHED connections choking a single-threaded Vite process, causing `curl`/`ab open` to hang or land on about:blank for many minutes until `pm2 restart` cleared it. The mechanism: idle leaked tabs hold live sockets to whatever dev server they last visited, and THAT exhausts the target server's connection capacity — not Chrome's own CPU/memory.

**Why the bug went undetected for ~2,342 reaps.** `teardownSession` trusts the agent-browser command invocation and never verifies the tab actually closed — the failure isn't surfaced loudly on the ab side. Closing that verification gap is an explicit requirement of this plan (R3), not an afterthought.

**Bonus finding.** ~1,936 leaked `ab-<pid>.config` files (measured live 2026-08-04; ~1,994 at diagnosis time) accumulated under `~/.agent-browser/` because gc never cleans them for reaped pids. Disk-only cost, non-urgent, folded into U2 as a ~3-line addition (R6).

## Requirements Trace

| Req | Statement | Unit(s) |
|-----|-----------|---------|
| R1 | `teardownSession` navigates the session's tab to `about:blank` BEFORE any close attempt, so even a failed close leaves no live socket to a real dev server | U1 |
| R2 | `teardownSession` defeats the last-tab guard: open a new `about:blank` tab in the session, close the ORIGINAL tab (index/target discovered at runtime, never assumed), then close the session daemon normally | U1 |
| R3 | Teardown success is VERIFIED by re-querying the shard's CDP `/json/list` page count and confirming it dropped — never trusted from the command's exit code | U1 |
| R4 | `ab gc` gains a backstop orphan-tab sweep: enumerate each shard's CDP `/json/list`, diff against currently-live sessions, close unowned targets via CDP `/json/close/<targetId>` (a code path independent of `teardownSession`) | U2 |
| R5 | `ab status` and `ab doctor` gain per-shard open-page counts, with a warn indicator above a named threshold (`TAB_WARN_THRESHOLD = 15`) | U3 |
| R6 | `ab gc` unlinks `~/.agent-browser/ab-<pid>.config` for pids it reaps | U2 |

## Scope Boundaries

**In scope:** src/cli.ts (teardown sequence, gc sweep, doctor/status checks), new/extended tests under src/__tests__/, at most trivial one-line comment corrections adjacent to touched code.

**Out of scope / DO NOT TOUCH:**
- `~/.claude/hooks/*` — a different repo/location entirely, not part of this tool's codebase.
- The Terra blueprint-wizard work in a separate worktree — unrelated; just the environment where the 2026-08-03 outage was observed.
- The 30-minute `IDLE_GRACE_MS` interval (src/cli.ts:899) — it is correct, not the bug. No scheduler changes.
- The 3-state liveness classification logic from the 2026-07-09 plan — it works correctly; only the underlying tab-close mechanism it eventually triggers is broken.
- `~/Library/LaunchAgents/com.clay.ab-gc.plist` — confirmed loaded and firing on schedule; nothing to change.
- The `agent-browser` binary itself (`~/.bun/bin/agent-browser`) — separately installed, not in this repo; its last-tab guard is worked around, not patched.

**Explicitly rejected alternatives** (decision-with-rationale, carried verbatim from the diagnosis so no implementer re-litigates them):

1. **REJECTED: building a `/workflows`-style live TUI/dashboard for `ab` session observability.** Direct empirical proof from the diagnosis session: `ab ps` showed a perfectly healthy-looking 13-session picture (mostly under 30 minutes old, consistent with the working 30-min gc) at the EXACT SAME TIME 39 tabs were silently piling up across the shard pool and actively starving a dev server. A session-level view — no matter how well presented — structurally cannot see a bug that lives one layer below session bookkeeping, at the Chrome-tab level. The fix belongs in making tab-teardown actually work and adding tab-level counts to existing health-check surfaces (`ab doctor`/`ab status`), not in building a prettier view of a pile of session markers that were already being correctly reaped. U3 is explicitly *instead of* a new observability surface, not in addition to one.

2. **REJECTED: pursuing the `SubagentStop`-hook "per-pid cleanup at true termination" hardening** noted as deliberately deferred future work in `~/.claude/hooks/browser-skill-cleanup`'s own code comments (that hook only cleans the MAIN session's marker on the Stop hook, explicitly declining to touch subagent session files because SubagentStop's fire semantics are ambiguous between "subagent truly done" and "subagent parked awaiting a background message"; premature cleanup would break a still-parked subagent mid-run with exit 127). Rationale for rejecting this as a fix vector: **it is MOOT.** Even a hypothetically-perfect per-subagent close-on-true-termination hook would invoke the exact same buggy `teardownSession`/last-tab-guard code path and leak the tab anyway. Fixing `teardownSession` itself (U1) fixes BOTH the periodic-gc path AND any future subagent-triggered close path simultaneously, so there is no independent value in solving the hook-timing-ambiguity problem first or instead.

3. **REJECTED framing: "GC is broken, missing, or runs only every 24 hours."** This is FALSE and must not drive any implementation choice — it would send an implementer toward rewriting the scheduler or shortening an already-correct interval instead of fixing the actual bug in the tab-close call sequence. The ACTUAL idle grace period is 30 minutes (`IDLE_GRACE_MS`, src/cli.ts:899), launchd runs gc every 30 minutes (confirmed via `launchctl print`), and it is DEMONSTRABLY WORKING on schedule (2,342 successful idle-session-marker reaps logged). The 24-hour figure that appears in some stale comments describes the idle→stale LABEL boundary / orphan-wrapper threshold (`STALE_AGE_MS`, src/cli.ts:897), not the reap trigger — a documentation-drift artifact. One such stale comment lives in this repo at src/cli.ts:1459 ("instead of waiting for the 24h gc"); U1 may correct it as a trivial one-line touch-up since that code is being edited anyway, but the plan's diagnosis must not be reframed around it. The stale comment in `~/.claude/hooks/browser-skill-cleanup` is out of scope entirely (different repo).

### Deferred to Follow-Up Work

- **One-time cleanup of the existing ~1,936 `.config` backlog.** R6/U2 stops the leak going forward (unlink on reap), but files for already-reaped pids have no future reap event to clean them. A one-time manual sweep (e.g. deleting `~/.agent-browser/ab-*.config` files whose pid has no session marker and no live daemon pid file) can be run by hand after U2 ships; building an automated orphan-config sweep into gc is not worth it for a one-time disk-only backlog.
- **Broader stale-comment audit** for other 24h-figure drift outside the lines U1 touches.
- **A `warn`-level field on `DoctorCheck`** (three-state ok/warn/fail rendering) if the binary ok model ever pinches beyond the tab-count check — not needed now (see Decision 7).

## Context

- **Repo:** `/Users/blake/Documents/Development/tools/ab`. Entry point src/cli.ts (1,576 lines); talks to a long-lived `ab-server` daemon over Unix-socket RPC (src/rpc.ts) for Chrome lifecycle, and shells out to the separately-installed `agent-browser` binary for browser automation. src/chrome-supervisor.ts manages the 3-shard headless pool (`CDP_PORT_HEADLESS = 9333`, src/cli.ts:26; shard i on `9333 + i`; pool size default 3, clamped 1-8 in src/types.ts).
- **The broken function:** `teardownSession` (src/cli.ts:1043-1053) — runs `tab close` then `close` via `runAgentBrowser`. Its docblock (src/cli.ts:1035-1042) already records the *prior* discovery that bare `close` never closes the tab in attached-CDP mode; this bug is one layer further down (the `tab close` call itself silently fails on the last tab). Two call sites: `cmdGc` (src/cli.ts:1149-1153) and the `close` command handler (src/cli.ts:1437-1463).
- **Exec helpers cannot capture output:** `execInherit` (src/cli.ts:89-103) and `runAgentBrowser` (src/cli.ts:119-129) spawn with `stdio: "inherit"`. There is no output-capturing exec helper anywhere in the file — anything that needs to *read* agent-browser output (tab listing) or tab state (page counts) needs a new capture helper and/or direct CDP fetches.
- **CDP fetch pattern to copy:** `checkCdp` in src/chrome-supervisor.ts:621-632 — `fetch("http://127.0.0.1:" + port + "/json/version", { signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS) })`. No code in the repo currently calls `/json/list` or `/json/close`; the comment at src/cli.ts:891 explicitly deferred the CDP cross-check ("pid-file check is sufficient for v1") — this plan is where that deferral ends.
- **agent-browser tab commands** (docs/agent-browser-reference/references/commands.md:168-175): `tab` (list), `tab new [url]`, `tab 2` (switch by index), `tab close` (close current), `tab close 2` (close by index). `open`/`goto`/`navigate` are plain-navigate aliases with no implicit new-tab behavior — the new-tab-per-session behavior is ab's own `cmdOpen` (src/cli.ts:800-821, which runs `tab new` first). So step R1's blank-navigation must call `runAgentBrowser(port, session, ["goto", "about:blank"])` directly, NOT reuse `cmdOpen` (which would open a second tab instead of blanking the current one).
- **Why the guard fires on ~87% of reaps:** session isolation gives each `--session` context its own independent tab set (docs/agent-browser-reference/references/session-management.md); a session typically holds exactly one tab (created by `cmdOpen`'s `tab new`), so teardown is "closing the context's only tab" almost every time. (Inference — implementer verifies empirically against a live session, see U1.)
- **gc structure:** `cmdGc` (src/cli.ts:1097-1171) fetches `rpc.status()` once per run (:1112-1121) for `headlessPool`/`legacyHeadless`; resolves per-entry shard via `resolveTeardownShard` (:324-328) + `portForShard` (:344-354, returns a port only for `phase === "chrome_up"` shards); per-reaped-entry cleanup block at :1154-1157 unlinks `sessionFile` and (stale only) `wrapper`. `findOrphanWrappers` (src/cli.ts:1055-1095) is the structural model for a second, independent gc pass with hard guards (see its regex-guard comment about a prior sidecar-file deletion incident).
- **Doctor/status seams:** `buildHeadlessDoctorChecks` (src/cli.ts:491-516) is pure and exported specifically as the unit-test seam ("cmdDoctor itself talks to the live daemon over RPC and writes straight to stdout, so this is the only test seam without a larger refactor" — :487-490). `cmdStatus` (src/cli.ts:433-437) dumps `rpc.status()` as JSON. `DoctorCheck` interface at :471-476 (`label/ok/detail/fix`).
- **Test conventions:** src/__tests__/ps.test.ts imports pure helpers directly from `../cli` for unit tests, and `spawnSync`s the compiled `ab` wrapper for end-to-end tests. **Critical shared-daemon safety rule (ps.test.ts:17-24):** this machine runs one shared `ab-server` used by concurrently-running agents; any real (non-`--dry-run`) `ab gc` invocation in tests MUST pin `AB_GC_IDLE_GRACE_MS` to `SAFE_LARGE_GRACE_MS` (1 year, ps.test.ts:45) so only the test's own by-construction-stale fixtures can be reaped. Tests run with `bun test` from the `ab/` directory.
- **Prior-plan citation style:** cli.ts comments cite decisions as "chrome-pool-plan Fix N / decision N" (e.g. :311-328, :344-354). New code should cite this plan similarly ("tab-teardown-fix U1/decision N").
- **Immediate relief (already recommended, NOT an implementation unit):** running `ab heal` (when no QA agents are actively mid-run) clears the currently-accumulated tab backlog as a stopgap while this fix ships.

## Key Technical Decisions

1. **Blank-before-close ordering (R1 first, guard-defeat second).** The `goto about:blank` step runs BEFORE any close attempt because it alone eliminates the outage mechanism even if every subsequent step fails: a blank tab holds no live socket to a real dev server. This makes the fix fail-soft — the worst case degrades from "leaked tab starving a dev server" to "leaked inert blank tab".

2. **Defeat the last-tab guard rather than patch the binary.** The guard lives in the compiled agent-browser Rust binary (not this repo). The workaround — `tab new about:blank`, then close the ORIGINAL tab, then `close` the daemon — uses only documented commands (commands.md:168-175). **Residual-leak caveat, stated honestly:** this sequence converts "1 leaked tab holding a live dev-server socket" into, at worst, "1 leaked `about:blank` tab" if the final daemon `close` still leaves the new blank tab behind (harmless — no socket — but a real Chrome page). That residual is exactly why Decision 3's backstop is genuine and not redundant.

3. **The gc CDP sweep is a genuine backstop, not redundancy.** It closes targets via raw CDP `/json/close/<targetId>` — a completely different code path from `teardownSession` (no agent-browser binary, no session daemon, no app-level last-tab guard). It is therefore the only path that can reach zero leaked pages, and it survives any edge case U1 misses (e.g. the dead-daemon reap case where a respawned per-session daemon may not re-adopt the orphan tab — the existing docblock caveat at src/cli.ts:1047-1049).

4. **CDP-verified teardown, never exit-code-trusted (R3).** The current bug survived ~2,342 reaps precisely because nothing checked the actual tab state after teardown. `teardownSession` will re-query the shard's `/json/list` and confirm the page count dropped (and/or the original targetId disappeared). This is an explicit, testable unit requirement of U1.

5. **Runtime tab-index/target discovery — never assume index 0.** The original tab's identity is discovered at teardown time (via a new output-capturing exec helper parsing `agent-browser tab` listing, and/or CDP `/json/list` diffing — see U1 Approach), because `stdio: "inherit"` helpers can't observe anything and no evidence establishes agent-browser's index base or ordering. The implementer must verify the discovery mechanism empirically against a live session before finalizing.

6. **`TAB_WARN_THRESHOLD = 15` per shard (named constant).** Justification: healthy steady-state is roughly one tab per active session spread across 3 shards, and the observed healthy session count was ~13 total; 15 on ONE shard is ~3x the expected per-shard share and well below the 35-39 seen during the confirmed outage, so it fires early without false-positives during normal parallel QA. A named constant makes it a one-line tune.

7. **Threshold breach = `ok: false` doctor check (exit 1), not a new warn level.** `DoctorCheck` is binary (ok/fail) and doctor's contract is "✗ with the exact fix command". A shard above threshold is genuinely unhealthy (that state caused a real outage) and now has a real fix command (`ab gc`, which U2 makes effective). Adding a three-state warn level is a rendering-model change out of proportion to this plan (deferred to follow-up).

8. **Surface split: `status` = raw data, `doctor` = interpretation.** `ab status` gains a per-shard `tabCounts` field in its JSON dump (lowest-effort data surface, cli-side augmentation of `rpc.status()`); `ab doctor` gains the threshold interpretation via the established pure/exported check-builder seam so the logic gets unit coverage without touching the live daemon.

9. **Conservative ownership rule for the orphan sweep: skip-when-ambiguous.** No targetId-to-session mapping exists anywhere in the repo. The shared shard pool serves concurrently-running agents (ps.test.ts:17-24), so an over-aggressive diff could close a tab belonging to an agent actively mid-QA-run. The sweep only closes a CDP target when it CANNOT be attributed to any currently-live (active-state) session; when attribution is ambiguous, it skips the target and logs it rather than closing it. It honors `--dry-run` and only sweeps `phase === "chrome_up"` shards (matching the existing `portForShard` gating). Missing a leaked tab for one 30-minute gc cycle is cheap; killing a live QA run is not.

10. **`.config` cleanup folded into U2, not its own unit.** It is a ~3-line best-effort `fs.unlinkSync` in `cmdGc`'s existing per-reaped-entry cleanup block (src/cli.ts:1154-1157); a separate unit would cost more bookkeeping than the fix. Keeps the plan within the Lightweight 2-4 unit budget.

11. **`ab close` keeps exit 0 on verification failure (loud stderr warning instead).** Callers (hooks, scripts) treat `ab close` as best-effort teardown today; making a residual-tab warning flip the exit code could break them for a condition the U2 backstop will clean up within one gc cycle anyway. Failures are made VISIBLE (stderr + gc log), not made fatal.

## Open Questions

### Resolved During Planning

- **Tab-count warn threshold** → 15 per shard, named `TAB_WARN_THRESHOLD` (Decision 6).
- **Orphan-sweep ownership heuristic** → conservative skip-when-ambiguous, live-session attribution, dry-run honored, chrome_up shards only (Decision 9).
- **Doctor vs status for tab visibility** → both, split by role (Decision 8).
- **`.config` cleanup placement** → folded into U2 (Decision 10).
- **Original-tab index determination** → discovered at runtime, never hardcoded; CDP page-count re-query confirms the close (Decision 5, R2/R3).
- **`tab close <n>` syntax** → confirmed real at docs/agent-browser-reference/references/commands.md:173 (`agent-browser tab close 2`).

### Deferred to Implementation

- **agent-browser `tab` listing output format and index base (0- vs 1-based).** RESOLVED — moot: see "Implementation Note" above. `--session` doesn't scope the listing, so no listing-based parser was built; identity is captured via CDP diff at open time instead.
- **Exact attribution mechanism for the U2 sweep** (which live-session evidence to use: per-active-session `tab` listings via the capture helper vs. URL-set matching vs. targetId snapshots). RESOLVED — see "Implementation Note" above: recorded `target=` marker lines from U1's open-time capture, not `tab` listings (ruled out) — with URL-collision as a secondary ambiguity check (`isAttributableUrl`, cli.ts:1628-1633).
- **Whether a respawned per-session daemon re-adopts the orphan tab on dead-daemon (idle) reaps** — the existing docblock caveat (src/cli.ts:1047-1049). The 2,037 "Cannot close the last tab" errors strongly suggest the respawned daemon DOES see the session's tab (the guard fires, meaning it found exactly one tab to refuse to close), but verify empirically. If it does not re-adopt in some case, U1 logs the verification failure and the U2 sweep is the designed catch-all.
- **Verification-failure message wording and gc log format** — implementer's call; must include shard, port, expected vs. observed page count.

## Implementation Units

Sizing: **Lightweight (3 units)** — single-repo bug fix with a confirmed root cause; no external research (internal tooling; CDP protocol and command patterns already established in this codebase).

### U1. Fix `teardownSession`: blank, defeat the last-tab guard, CDP-verify

- **Goal:** A reaped or closed session's Chrome tab is actually closed (or at minimum blanked), and the outcome is verified against CDP rather than assumed — on both call paths (`ab gc` and `ab close`).
- **Requirements:** R1, R2, R3
- **Dependencies:** none
- **Files:** modify `src/cli.ts` (teardownSession :1043-1053 and small new helpers; touch neither call site's surrounding logic beyond consuming the new return value); test `src/__tests__/teardown.test.ts` (new)
- **Approach:**
  - Add small CDP helpers modeled on `checkCdp` (chrome-supervisor.ts:621-632), colocated in cli.ts and exported for tests and for U2/U3 reuse: `listCdpPages(port)` → parsed `/json/list` entries filtered to `type === "page"` (id, url, title), and `closeCdpTarget(port, targetId)` → GET `/json/close/<targetId>`. Both use `AbortSignal.timeout` with a short timeout and fail soft (return null/false) — teardown must never hang gc.
  - Add an output-capturing sibling of `execInherit`/`runAgentBrowser` (e.g. `runAgentBrowserCapture`) using `stdio: ["ignore", "pipe", "pipe"]`, since no existing helper can read agent-browser output (src/cli.ts:89-129 are all `stdio: "inherit"`).
  - Rework `teardownSession` to, in order: (1) snapshot the shard's page count via `listCdpPages`; (2) `runAgentBrowser(port, session, ["goto", "about:blank"])` — blank the session's current tab FIRST (Decision 1); must NOT go through `cmdOpen`, which would `tab new` instead of navigating; (3) `runAgentBrowser(port, session, ["tab", "new", "about:blank"])` so the original tab is no longer the last; (4) discover the ORIGINAL tab's index at runtime (capture helper parsing the session's `tab` listing — format/base verified empirically per Deferred question 1; CDP `/json/list` diff as the fallback identification mechanism) and `runAgentBrowser(port, session, ["tab", "close", String(index)])`; (5) `runAgentBrowser(port, session, ["close"])` as today; (6) re-query `listCdpPages` and confirm the page count dropped below the snapshot (R3). Return a success/failure result instead of `void`.
  - Callers: `cmdGc` (src/cli.ts:1152) logs a loud stderr warning on verification failure (shard, port, expected vs observed count) but continues reaping other entries; the `close` handler (src/cli.ts:1454) prints the same warning but keeps exit 0 (Decision 11) and still unlinks its markers as today.
  - While editing the `close` handler's neighborhood, correct the stale one-line comment at src/cli.ts:1459 ("24h gc" → 30-min gc) — trivial touch-up only, per Scope Boundaries item 3.
  - Comment the new sequence citing this plan ("tab-teardown-fix U1"), matching the existing chrome-pool-plan citation style.
- **Execution note:** before writing the index-discovery parser, verify `agent-browser tab` listing output and the guard-defeat sequence empirically against one live throwaway session (open → blank → tab new → tab close <n> → close, watching `/json/list` between steps).
- **Test scenarios:**
  - Happy path: with a mocked/injected `listCdpPages`, teardownSession reports success when the post-close page count is lower than the snapshot; the verification helper (pure part) returns success for `before=3, after=2`.
  - Happy path (parser): the tab-listing parser extracts the correct index for the original (non-blank) tab from a captured fixture of real `agent-browser tab` output.
  - Edge case: page count unchanged after the sequence → teardownSession reports failure; gc path logs the warning and continues (no throw).
  - Edge case: CDP fetch times out / shard unreachable mid-teardown → fail soft (failure result, no hang, no unhandled rejection).
  - Error: `tab` listing output unparseable → teardown falls back (blank happened already, so worst case is an inert blank tab) and reports failure rather than closing a guessed index.
  - End-to-end (live, following ps.test.ts safety rules — `AB_GC_IDLE_GRACE_MS` pinned to `SAFE_LARGE_GRACE_MS` for any real gc invocation): create a real session, `ab open` a local URL, run `ab close`, assert via direct `/json/list` that the shard's page count returned to its pre-test value.
- **Verification:** `bun test` in `ab/` passes; live E2E above shows the count actually dropping; `/tmp/ab-gc.log` stops accumulating `✗ Cannot close the last tab` after deploy (spot-check after one or two gc cycles).

### U2. gc backstop: CDP orphan-tab sweep + `.config` cleanup

- **Goal:** `ab gc` closes leaked Chrome tabs that per-session teardown missed — via raw CDP, independent of the agent-browser binary — and stops the `ab-<pid>.config` file leak for reaped pids.
- **Requirements:** R4, R6
- **Dependencies:** U1 (reuses `listCdpPages`/`closeCdpTarget` and, if the chosen attribution mechanism needs it, the capture helper)
- **Files:** modify `src/cli.ts` (cmdGc :1097-1171 plus a new pure sweep-partition function near `findOrphanWrappers` :1055-1095); test extend `src/__tests__/ps.test.ts` or new `src/__tests__/gc-sweep.test.ts`
- **Approach:**
  - Add a pure, exported partition function (e.g. `partitionOrphanTargets(pages, liveSessionEvidence)` → `{ orphans, ambiguous, owned }`) modeled structurally on `findOrphanWrappers` — this is the unit-test seam. Ownership rule per Decision 9: a page is an orphan only if it CANNOT be attributed to any state-`active` session; ambiguous → `ambiguous` (skipped, logged), never closed. Attribution mechanism is Deferred question 2 (per-active-session tab listing preferred).
  - Wire a third gc pass into `cmdGc` after the existing entry/wrapper loops: for each shard in the already-fetched `headlessPool` with `phase === "chrome_up"` (same gating as `portForShard`), `listCdpPages(port)`, partition against live-session evidence from the already-computed `entries` (`listSessionEntries()` :1099), and `closeCdpTarget` each orphan. Honor `--dry-run` exactly like the existing passes (print `orphan tab  action=close: shard=<i> targetId=<id> url=<url>` / skip lines; close nothing). Log ambiguous skips at normal verbosity so a stuck-ambiguous target is visible in `/tmp/ab-gc.log`.
  - Fold in R6: in the existing per-reaped-entry cleanup block (src/cli.ts:1154-1157), add a third best-effort `try { fs.unlinkSync(path.join(os.homedir(), ".agent-browser", "ab-" + e.pid + ".config")); } catch { /* may not exist */ }`.
  - Comment the sweep citing "tab-teardown-fix U2 — genuine backstop: raw CDP has no last-tab guard; only path that reaches zero leaked pages" (Decision 3).
- **Test scenarios:**
  - Happy path: `partitionOrphanTargets` classifies a page owned by an active session as `owned`, an unattributable page as `orphans`, a URL-collision/uncertain page as `ambiguous`.
  - Happy path: reaping a fixture entry unlinks its `ab-<pid>.config` alongside sessionFile/wrapper (fixture file in a temp `AGENT_BROWSER_HOME`-style dir or the real home path with a by-construction-fake pid, matching ps.test.ts fixture conventions).
  - Edge case: shard not `chrome_up` → sweep skips it entirely (no fetch attempted); daemon status fetch failed → sweep no-ops.
  - Edge case: `--dry-run` prints would-close lines and provably closes nothing (page set unchanged).
  - Error: `/json/close` returns non-OK / fetch throws → logged, loop continues to next target (no throw out of cmdGc).
  - End-to-end (live, `AB_GC_IDLE_GRACE_MS=SAFE_LARGE_GRACE_MS` — mandatory per ps.test.ts:17-24; prefer mocked fetch for the close path so the shared pool serving other live agents is never touched by tests): dry-run against the real pool lists plausible targets without side effects.
- **Verification:** `bun test` in `ab/` passes; `ab gc --dry-run` on the real machine lists orphan candidates sanely (no active agent's tab listed as orphan); after one real gc cycle, `/json/list` totals across shards drop to ≈ active-session count; `ls ~/.agent-browser/*.config | wc -l` stops growing.

### U3. Tab-count visibility in `ab status` and `ab doctor`

- **Goal:** The existing health-check surfaces expose per-shard open-page counts so a tab-level leak can never again hide behind healthy session bookkeeping.
- **Requirements:** R5
- **Dependencies:** U1 (reuses `listCdpPages`)
- **Files:** modify `src/cli.ts` (cmdStatus :433-437, cmdDoctor :518+, new pure check-builder beside `buildHeadlessDoctorChecks` :491-516); test extend `src/__tests__/ps.test.ts` (where `buildHeadlessDoctorChecks` tests live) or sibling test file
- **Approach:**
  - Define `export const TAB_WARN_THRESHOLD = 15;` with a justification comment (Decision 6's rationale, citing "tab-teardown-fix U3").
  - `cmdStatus`: after `rpc.status()`, fetch `listCdpPages` per `chrome_up` shard (null for down/idle shards) and print the result augmented with a `tabCounts: Array<number | null>` field aligned with `headlessPool` order. Fail soft: a CDP timeout yields null for that shard, never an error exit.
  - `cmdDoctor`: add a pure, exported sibling builder (e.g. `buildTabCountChecks(tabCounts: Array<number | null>): DoctorCheck[]`) following `buildHeadlessDoctorChecks`'s documented pure/exported test-seam pattern — one check per known count: `ok: count <= TAB_WARN_THRESHOLD` (Decision 7), `detail` like `"<n> open pages"`, `fix: "ab gc   # or: ab heal"` when failing; a null count renders as an ok "unreachable/idle" line rather than a failure (an idle on-demand shard has no pages by definition — mirror the existing shards>=1 idle-is-healthy treatment). cmdDoctor fetches the counts (only when the daemon is up) and appends these checks after the existing headless checks.
- **Test scenarios:**
  - Happy path: `buildTabCountChecks([3, null, 7])` → three checks, all ok, details carrying the counts / idle wording.
  - Edge case: count exactly `TAB_WARN_THRESHOLD` → ok; `TAB_WARN_THRESHOLD + 1` → not ok, with the `ab gc` fix string (boundary pinned so threshold semantics can't silently drift).
  - Edge case: legacy daemon (no `headlessPool`) → single-shard counts still render (mirror `buildHeadlessDoctorChecks`'s legacy fallback) or checks are omitted cleanly — implementer picks, test pins the choice.
  - Error: CDP fetch failure for one shard → that shard's count is null; other shards unaffected; doctor still exits per remaining checks.
- **Verification:** `bun test` in `ab/` passes; on the live machine `ab status` shows a `tabCounts` array matching a manual `curl http://127.0.0.1:9333/json/list | jq length` per shard, and `ab doctor` renders the per-shard page-count lines (all ✓ after U1/U2 have drained the backlog).

## Risks

- **The U2 sweep closes a live agent's tab mid-QA-run.** Highest-consequence risk; mitigated by Decision 9 (skip-when-ambiguous, active-session attribution, `--dry-run` honored, chrome_up-only) and by shipping the sweep with dry-run-first verification on the real machine. Residual: an attribution mechanism bug — covered by the pure-function unit tests and the live dry-run check in U2's verification.
- **The guard-defeat sequence closes the wrong tab** (index base or ordering assumption wrong). Mitigated by Decision 5: runtime discovery, empirical verification before finalizing the parser, and R3's page-count verification which detects (not prevents) a miss. Worst case is bounded by step-order: the original tab was already blanked, so a mis-close leaves an inert blank tab, not a socket-holder.
- **Dead-daemon reaps where the respawned daemon doesn't re-adopt the orphan tab** — U1's per-session path can't reach such a tab at all. Accepted and designed-for: U1 logs the verification failure loudly, and U2's raw-CDP sweep (no session daemon involved) is the catch-all. This is the core reason U2 exists (Decision 3).
- **Added teardown latency** (extra navigations + CDP polls per reap, ~2,300 reaps/month). Bounded by short `AbortSignal.timeout`s on every CDP call and fail-soft returns; gc is a background launchd job where seconds don't matter, and `ab close` adds at most a few round-trips.
- **Tests interfering with the shared live daemon.** Real risk called out by the repo's own test file; mitigated by strictly following ps.test.ts:17-24 (SAFE_LARGE_GRACE_MS on any real gc run, mocked CDP fetch for close paths, by-construction-fake fixtures).
- **agent-browser binary behavior differs from its docs** (e.g. `tab close <n>` semantics). Mitigated by the empirical-verification execution notes in U1; the docs file was written from the binary's actual help output, and the sequence degrades safely (blank-first) if a step misbehaves.

## Sources

- src/cli.ts — teardownSession :1035-1053; call sites :1149-1153, :1437-1463; execInherit/runAgentBrowser :89-129; cmdOpen :800-821; three-state liveness + deferral comment :882-899; findOrphanWrappers :1055-1095; cmdGc :1097-1171; cmdStatus :433-437; DoctorCheck/buildHeadlessDoctorChecks :471-516; cmdDoctor :518+; stale 24h comment :1459; CDP_PORT_HEADLESS :26; buildSessionName :62
- src/chrome-supervisor.ts — checkCdp :621-632 (CDP fetch pattern), HEADLESS_BASE_PORT :54
- src/types.ts — pool size default/clamp :26-46
- src/__tests__/ps.test.ts — shared-daemon test safety rules :17-24, SAFE_LARGE_GRACE_MS :45, exported-helper and spawnSync test patterns
- docs/agent-browser-reference/references/commands.md :5-10, :168-175 — navigate aliases; `tab` / `tab new` / `tab close [n]` syntax
- docs/agent-browser-reference/references/session-management.md — per-session tab isolation
- plans/2026-07-09-session-reaper-plan.md :52-53 — the open risk this plan closes; plans/2026-07-10-chrome-pool-plan.md — shard pool design + citation style
- Live evidence (2026-08-03/04 diagnosis session): /tmp/ab-gc.log grep (2,037 `Cannot close the last tab` / ~2,342 reaps); CDP `/json/list` across shards (39 pages, ~35 on one dev server); `lsof -iTCP:5229` (~80 ESTABLISHED); `launchctl print` on com.clay.ab-gc; `ls ~/.agent-browser/*.config | wc -l` → 1,936
- Chrome DevTools Protocol HTTP endpoints (`/json/list`, `/json/close/<targetId>`) — standard CDP, same family as the `/json/version` call already in chrome-supervisor.ts
