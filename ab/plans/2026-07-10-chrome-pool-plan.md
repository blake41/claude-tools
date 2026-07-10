---
title: ab Headless Chrome Pool — Shard Sessions Across N Instances
date: 2026-07-10
origin: live investigation, Terra session a473d4e0 (contention in QA sessions 8415fe01 / 85998a2a)
status: draft
---

# ab Headless Chrome Pool — Shard Sessions Across N Instances

## Overview

Shard ab sessions across N headless Chrome instances (default 3) instead of one, with sticky
session→shard mapping persisted in the session marker file, shard-aware `gc`/`close`/`reauth`,
and the leftover launchd gc timer from the session-reaper plan. Removes the single-Chrome
concurrency ceiling that blocked two QA sessions with `os error 35` under 10-15 concurrent
sessions.

## Problem Frame

Every ab session — across all Claude Code windows and subagents — is one tab in a single
shared headless Chrome (:9333). Under 10-15 concurrent sessions the per-session daemons stall
on CDP, and clients fail with `os error 35` after a 5×200ms retry budget. Machine has
16 cores / 128 GB; the ceiling is architectural, not hardware.

Evidence: sessions `8415fe01-d29b` (sales-dashboard QA, blocked 7/8 criteria) and
`85998a2a-488b` (miniapp-middleman QA, blocked, sessions climbing 9→15). Control-plane RPC
stayed healthy both times; only CDP/tab operations died — isolating the bottleneck to the
single Chrome process.

## Requirements

- R1: N headless Chrome instances, each with own CDP port and profile dir; N configurable.
- R2: A session's tab commands always hit the same instance (sticky mapping), persisted
  across CLI invocations, load-balanced at assignment time.
- R3: `ab gc` / `ab close` tear down a session's tab on that session's shard.
- R4: `ab reauth` authenticates the session's shard (each profile = separate cookie jar).
- R5: Idle-session reaping runs automatically (launchd timer — carryover Unit 4 of
  `plans/2026-07-09-session-reaper-plan.md`, everything else there is already implemented).
- R6: QA subagents release their tab on completion (`ab close` instruction in qa-operator).
- R7: No changes to the external `agent-browser` Rust binary or the global subagent hook.

## Scope Boundaries

- IN: `tools/ab` TypeScript (supervisor, server, state, cli, types, tests), one launchd
  plist, one-line prose edit to `~/.claude/agents/qa-operator.md`, doc updates.
- OUT: admission control / backpressure (deferred — revisit only if contention recurs after
  pool + reaping land); per-session *user identities* (auth identity stays global by design);
  headed Chrome (stays single, :9444); the dashboard (external binary, unaffected — confirmed
  it queries CDP directly, not `/status`); the Rust `agent-browser` binary (port already
  arrives via `--cdp` flag, `cli.ts:103-109`).
- **Scoping reversal, explicit:** `docs/session-isolation.md:58` declared per-session Chrome
  profiles "explicitly out of scope today". This plan crosses that boundary deliberately
  (per-*shard* profiles, not per-session) — update that doc, don't silently contradict it.

## Context (research-verified)

- Supervisor is already multi-instance-shaped: `CONFIGS`/`runtime` are
  `Record<ChromeTarget, ...>`, every function takes `target` (`chrome-supervisor.ts:48,126`).
  `policy: "always-on" | "on-demand"` already exists (headed is on-demand).
- `cdpPort` is threaded as a parameter through every CLI command (`cli.ts:1043-1124`); the
  Rust binary receives it as `--cdp <port>` (`cli.ts:103-109`). Binary lives at
  `~/.bun/bin/agent-browser`, external — untouched.
- Marker file `/tmp/.ab-session-<pid>` is plain text `pid\n`, written only by
  `cmdNewSession` (`cli.ts:587-595`), read only by this repo. The subagent wrapper
  `/tmp/ab-<pid>` is owned by the *global* hook `~/.claude/hooks/ab-subagent-hook` (repo-root
  copy is stale) and only pins `AB_SESSION_PID` — shard state must NOT live there.
- Literal `.headless`/`.headed` consumers outside the supervisor: `cmdDoctor`
  (`cli.ts:251-264`), `cmdGc` (`cli.ts:814-815`), `close` (`cli.ts:1134`), watchdog
  `/health` fetch (`daemon.ts:162`), tests (`server.test.ts:79-90,190-213`,
  `daemon-integration.test.ts:398-401,484`, `state.test.ts:54-55`).
- `authenticate()` runs **inside the ab-server daemon** (`server.ts:218` → `auth.ts:95`),
  takes `port` + `apiBaseUrl`/`appBaseUrl`; `cmdReauth` (`cli.ts:471-506`) resolves base URLs
  CLI-side and passes `port: cdpPort` — shard-awareness is just resolving the right port.
- Auth spike (2026-07-10): auth = opaque Clerk cookies set by the dev-login ticket flow;
  lazy reauth per shard chosen over profile-copy (copy plausible via `--use-mock-keychain`
  but unverified — Chrome died under tool sandbox before cookie inspection; also 1.6 GB/copy).
- Session-reaper plan units 0-3 are implemented, tested (127/127), **uncommitted** in
  `src/cli.ts` + `src/__tests__/ps.test.ts`. Also uncommitted: one-line
  `HEADED_IDLE_TIMEOUT_MS` 10→90 min bump in `chrome-supervisor.ts` (frees that file's
  "don't touch" constraint once committed). `sandbox/cco-permissions.fish` diff is unrelated
  — leave alone.
- `plans/runtime-invariants.md`: Invariant 5 is single-*daemon* (pool of Chromes under one
  daemon is fine); Invariant 4 (PID liveness) and SerialQueue generalize per-shard. Past
  incident: orphan-wrapper glob nearly ate `ab-server.sock` — keep `ORPHAN_WRAPPER_NAME_RE`
  guards intact (`cli.ts:759`).

## Key Technical Decisions

1. **Target model: widen `ChromeTarget` to `"headed" | "headless-<i>"`.** Generate headless
   configs at module init: port `9333+i`, profile `~/.agent-browser/profile-<i>`, shard 0
   reuses the EXISTING `~/.agent-browser/profile` and port 9333 (preserves current auth +
   zero-migration back-compat). Shard 0 policy `always-on`; shards ≥1 `on-demand` (reuses
   existing policy machinery) so idle machines run one Chrome, not N.
   Pool size: `AB_HEADLESS_POOL_SIZE` env, default 3, clamped 1-8. Ports 9333..9340 —
   no collision with headed 9444 / user 9222 / dashboard 4848.
2. **Status/health shapes extend additively.** Keep `headless` (= shard 0) and `headed`
   keys so the daemon watchdog and any external readers keep working; add
   `headlessPool: ChromeState[]`. `cmdDoctor`/`cmdGc`/`close` rewritten to use the pool
   array. Alternative (rejected): breaking rename to `shards[]` — churns every consumer and
   the watchdog for no functional gain.
3. **Sticky mapping lives in the session marker file**, format `pid\nshard=<i>\n`
   (line 2 optional). Written when a session first needs Chrome; missing line = unassigned
   (legacy markers parse as shard 0 for teardown purposes, matching where their tabs
   actually are). Assignment = least-loaded: count shard= lines across current non-stale
   markers, pick min index (ties → lowest). Computed CLI-side from /tmp — no new RPC, no
   daemon state, naturally self-corrects as gc removes markers.
   Alternative (rejected): hash(pid)→shard — zero state but load-blind and unfixable
   hotspots. Alternative (rejected): daemon-side assignment table — daemon restarts lose it
   (state.ts is in-memory by design); marker files already survive restarts.
4. **`/chrome/ensure` takes optional `{shard?: number}`** (default 0, validated
   0..poolSize-1) rather than N new routes. `ensureChromePort()` resolves the session's
   shard first (marker → or assign now), then ensures that shard.
5. **Auth: lazy reauth per shard, no profile copies, no auto-auth.** `cmdReauth` already
   passes the session's `cdpPort` through to daemon-side `authenticate()` — once sticky
   resolution feeds it, reauth is shard-correct for free. QA agents already run `reauth`
   when they hit login screens; a fresh shard profile behaves exactly like a logged-out
   browser, an already-handled state. Add a `profileFresh: true` field to the ensure
   response and print a one-line stderr hint ("fresh profile — `ab reauth` if you need
   auth") so agents aren't surprised. Auto-auth rejected: requires guessing the target
   host (apiBaseUrl) with no current-URL to detect it from.
6. **Pool size changes and shard>poolSize markers:** if a marker says `shard=5` but pool
   shrank to 3, resolution clamps to `shard % poolSize` and rewrites the marker (tab is
   lost; acceptable — same class as the reaper's accepted parked-tab tradeoff).

## Open Questions

### Resolved During Planning
- Rust binary changes needed? **No** — port arrives via `--cdp` flag.
- Where does shard state persist? **Marker file** (repo-owned; wrapper is hook-owned).
- Does the dashboard break on a new status shape? **No** — it queries CDP directly.
- Copy profiles or reauth? **Reauth** (spike 2026-07-10; copy unverified + 1.6 GB each).
- Does the pool violate runtime invariants? **No** — Invariant 5 is single-daemon only.

### Deferred to Implementation
- Exact `chrome_up` port-adoption behavior per shard (supervisor adopt-existing-Chrome path)
  — follow the existing single-target adoption tests in `chrome-supervisor.test.ts` and
  parameterize; if adoption semantics get ambiguous for shards ≥1, prefer kill+relaunch.
- Whether `cmdDoctor` should show all shards always or only launched ones — implementer's
  call; keep output scannable.

## Implementation Units

### Unit 0: Commit pending WIP (unblocks everything)
- [ ] **Goal:** clean tree so pool work doesn't entangle with prior features.
- **Requirements:** — (hygiene)
- **Dependencies:** none
- **Files:** commit existing modifications: `src/cli.ts` + `src/__tests__/ps.test.ts` as
  one commit (session-reaper units 1-3, message references
  `plans/2026-07-09-session-reaper-plan.md`); `src/chrome-supervisor.ts` one-liner as a
  second commit (headed idle timeout 10→90 min). Do NOT stage
  `sandbox/cco-permissions.fish` (unrelated, leave dirty). Do not push.
- **Approach:** verify first with `bun test` that the tree is green as-is (plan claims
  127/127); `git add` only the named files.
- **Test scenarios:** n/a (no code change).
- **Verification:** `git status --short` shows only `sandbox/cco-permissions.fish` dirty;
  `bun test` green.

### Unit 1: Supervisor/daemon pool (N headless targets)
- [ ] **Goal:** ab-server can launch, supervise, health-check, and report N headless
  Chromes.
- **Requirements:** R1
- **Dependencies:** Unit 0
- **Files:** modify `src/types.ts`, `src/chrome-supervisor.ts`, `src/state.ts`,
  `src/server.ts`, `src/daemon.ts`; tests `src/__tests__/chrome-supervisor.test.ts`,
  `state.test.ts`, `server.test.ts`, `daemon-integration.test.ts`.
- **Approach:** `ChromeTarget` = `"headed" | \`headless-${number}\``; `POOL_SIZE` from
  `AB_HEADLESS_POOL_SIZE` (default 3, clamp 1-8); generate `CONFIGS`/`runtime`/state
  `instances` entries in a loop (shard 0 = port 9333 + existing `profile` dir, `always-on`;
  shards ≥1 = 9333+i + `profile-<i>`, `on-demand`). `StatusResponse`/`HealthResponse` gain
  `headlessPool: ChromeState[]`; `headless` stays aliased to pool[0] (decision 2).
  `/chrome/ensure` accepts optional zod-validated `shard` (decision 4).
  `startSupervision()` launches only `always-on` targets. SerialQueue stays global (launch
  serialization across shards is correct — Chrome profile creation is disk-heavy).
- **Test scenarios:**
  - Happy: pool size 3 → status shows 3 pool entries, shard 0 `chrome_up`, 1-2 `idle`;
    `ensure {shard:1}` boots shard 1 on 9334 with `profile-1`; ensure is idempotent
    (`alreadyRunning`).
  - Edge: `AB_HEADLESS_POOL_SIZE=1` reproduces today's behavior exactly; size 9 clamps to 8;
    unset defaults to 3; shard out of range → 400.
  - Error: shard 1 crash → its state machine restarts it without touching shard 0
    (existing backoff tests, parameterized).
- **Verification:** `bun test`; live: restart daemon
  (`launchctl kickstart -k gui/$(id -u)/com.clay.ab-server`), `ab status` shows pool,
  `curl` ensure shard 1 via socket, see second Chrome on :9334.

### Unit 2: CLI sticky shard mapping + shard-aware gc/close
- [ ] **Goal:** every session resolves to one stable shard; teardown hits the right port.
- **Requirements:** R2, R3
- **Dependencies:** Unit 1
- **Files:** modify `src/cli.ts`; tests `src/__tests__/ps.test.ts`,
  `session-resolution.test.ts` (+ new cases).
- **Approach:** marker format `pid\nshard=<i>\n` (decision 3). New helpers:
  `readShardAssignment(pid): number | null`, `assignShard(pid): number` (least-loaded count
  over non-stale markers, write line 2), `resolveSessionCdpPort(pid, flags): number`.
  `ensureChromePort(headed)` becomes session-aware: resolve/assign shard → `rpc.ensureChrome
  ({shard})` → return that port. All `NEEDS_CHROME` commands flow through it already
  (`cli.ts:1077-1079`). `cmdGc`/`teardownSession`: resolve each entry's shard from its
  marker (missing → 0), group per-shard, only close tabs on shards whose Chrome is up
  (read `headlessPool` from status once). `cmdPs`: add SHARD column. Preserve
  `ORPHAN_WRAPPER_NAME_RE` guards untouched.
- **Test scenarios:**
  - Happy: fresh session assigned least-loaded shard, marker gains `shard=` line, second
    invocation reuses it; three sessions spread across shards 0,1,2 given equal load.
  - Edge: legacy marker (pid only) → teardown targets shard 0; gc reaps entries across two
    different shards, one shard down (skips close, still unlinks marker); `shard=7` with
    pool 3 → clamps to 1 and rewrites; concurrent first-command race (two processes assign
    simultaneously) → both write valid shard lines, last-writer-wins is acceptable
    (worst case: brief imbalance, tab still consistent per marker read-back — document).
  - Error: unreadable/garbled line 2 → treat as unassigned, reassign.
- **Verification:** `bun test`; live: two throwaway sessions
  (`AB_SESSION_PID=pool-test-{a,b} ab open https://example.com`), `ab ps` shows different
  shards, `curl :9333/json/list` + `:9334/json/list` each show one tab, `ab gc` (after
  aging markers with `touch -t`) closes both on correct ports.

### Unit 3: Shard-aware reauth + docs
- [ ] **Goal:** `ab reauth` authenticates the session's shard; docs reflect the new model.
- **Requirements:** R4
- **Dependencies:** Unit 2
- **Files:** modify `src/cli.ts` (`cmdReauth`, fresh-profile hint), `src/types.ts` +
  `src/server.ts` (`profileFresh` in ensure response), `docs/session-isolation.md`;
  tests `src/__tests__/auth.test.ts` (base-URL logic untouched — add port-resolution case),
  `server.test.ts`.
- **Approach:** `cmdReauth` calls `resolveSessionCdpPort()` instead of the constant
  (currently `cdpPort` from the flag block, `cli.ts:1086` — verify reauth is in
  `NEEDS_CHROME`; if not, add explicit resolution). Supervisor's launch path reports
  whether it had to `mkdir` the profile → `profileFresh` propagates through ensure → CLI
  prints the one-line hint (decision 5). Update `docs/session-isolation.md`: auth axis is
  now per-shard (N cookie jars, same identity), revise the ":58 out-of-scope" paragraph.
- **Test scenarios:**
  - Happy: session on shard 1 runs reauth → `rpc.authLogin` receives port 9334 (assert via
    mocked rpc).
  - Edge: fresh profile dir → ensure response `profileFresh: true` → hint printed once;
    existing profile → no hint.
  - Error: reauth on a shard whose Chrome is down → ensure boots it first (existing
    ensure-before-command flow).
- **Verification:** `bun test`; live: force a session onto shard 1, `ab reauth staging`,
  confirm logged-in page loads in that shard's Chrome.

### Unit 4: Enforcement + agent hygiene (launchd gc timer, qa-operator close)
- [ ] **Goal:** idle reaping runs unattended; QA agents release tabs.
- **Requirements:** R5, R6
- **Dependencies:** Unit 0 (timer); none for the prose edit. Independent of Units 1-3.
- **Files:** create `~/Library/LaunchAgents/com.clay.ab-gc.plist` (exact XML already in
  `plans/2026-07-09-session-reaper-plan.md:251-278`); modify `~/.claude/agents/qa-operator.md`.
- **Approach:** plist verbatim from the reaper plan (StartInterval 1800). qa-operator.md:
  after the existing wrapper-isolation paragraph, add instruction to run `<wrapper> close`
  as the final step of every QA run, pass or fail. **Sandbox note:** writing to
  `~/Library/LaunchAgents/` was blocked in-sandbox on 2026-07-09; if blocked again, stop
  and hand the user the two commands (write + `launchctl load`) rather than working around.
- **Test scenarios:** n/a (config + prose). Dry-run first: `ab gc --dry-run` eyeballed
  before loading the timer (reaper plan's own ordering).
- **Verification:** `launchctl load` + `launchctl kickstart gui/$(id -u)/com.clay.ab-gc`;
  `/tmp/ab-gc.log` shows a clean run; `ab ps` reflects reaping. qa-operator: read back the
  edited file.

## Requirements Trace
- R1 → Unit 1; R2, R3 → Unit 2; R4 → Unit 3; R5, R6 → Unit 4; R7 → decision 3 + scope
  boundaries (verified: no Rust/hook changes anywhere above).

## Risks
- **Status-shape consumers outside this repo** (scripts grepping `ab status` JSON): additive
  shape mitigates; `headless` key never disappears.
- **Fresh-profile logged-out surprises** in QA flows that assumed ambient auth: mitigated by
  `profileFresh` hint + reauth being an existing agent habit; worst case one extra reauth
  per shard lifetime.
- **Assignment race** (two first-commands in one session concurrently): last-writer-wins,
  documented in Unit 2; consequences are cosmetic (imbalance), not correctness (each
  invocation re-reads the marker before use).
- **Resource growth**: 3 Chromes idle ≈ 3× baseline RAM. Mitigated: shards ≥1 on-demand;
  pool size env-tunable to 1 (exact rollback to today's behavior without code revert).
- **Daemon restart mid-rollout**: launchd `KeepAlive` restarts with new code; markers
  survive; shard≥1 Chromes die with the daemon (`stopAll`) and relaunch on demand —
  sessions get fresh tabs, same as today's heal semantics.

## Sources
- `src/chrome-supervisor.ts`, `src/cli.ts`, `src/server.ts`, `src/rpc.ts`, `src/state.ts`,
  `src/daemon.ts`, `src/auth.ts`, `src/types.ts` (research pass 2026-07-10, file:line above)
- `plans/2026-07-09-session-reaper-plan.md` (implemented units 0-3; unit 4 carried here)
- `plans/runtime-invariants.md`, `docs/session-isolation.md`
- Auth spike + architecture investigation, Terra session a473d4e0 (2026-07-10)
