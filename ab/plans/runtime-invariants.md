---
title: ab-server Runtime Invariants
date: 2026-04-08
status: implemented
origin: adversarial review session (Codex gpt-5.4 + Claude)
---

# ab-server Runtime Invariants

## Context: What happened

The ab-server daemon has been failing intermittently — users run `cco-permissions` and get "ab-server not running" even though the daemon process is alive. We've been debugging this over multiple sessions and the pattern is clear: each fix reveals the next bug. The failures are all in the same class — silent state corruption that only surfaces when a user trips over it.

### Bug history (chronological)

1. **Chrome exit 133 crash loop** — Chrome crashed with SIGTRAP due to stale SingletonLock files. Fixed: remove SingletonLock before launch, profile nuke after max backoff.

2. **No crash diagnostics** — `fs.readdirSync` called without importing `fs`, silently caught by empty `catch`. Crashpad report logging never worked. Fixed: import `readdirSync` directly.

3. **Socket deleted by sidecar cleanup** — `cleanAgentBrowserSessions()` deleted `ab-server.sock` because it matched the `ab-*` + `.sock` glob. Daemon alive but unreachable. Fixed: skip `ab-server.sock` in cleanup.

4. **Zombie daemon processes** — Old daemon (from Tuesday) stayed alive alongside new daemon. Two processes, one socket. Fixed: added PID lockfile (`ab-server.pid`) at startup.

5. **Codex adversarial review found 5 more bugs:**
   - P1: Stale in-flight launch promises survive heal/shutdown → Fixed: null out `rt.inflight` in `clearTimers()`
   - P1: Adopted Chrome can't be killed (no proc handle) → Fixed: added `adoptedPid` field, kill on shutdown
   - P1: Socket stale-check TOCTOU race between daemons → Fixed: PID lockfile replaces connect-probe
   - P2: `kill()` doesn't verify Chrome exited → Fixed: SIGKILL escalation after 5s
   - P3: Timer leak in `withTimeout()` → Fixed: try/finally around Promise.race

6. **Heal handler hangs** — `agent-browser close --all` is `Bun.spawnSync` (synchronous, blocking). When it hangs, the entire daemon event loop freezes. Watchdog, health checks, and all RPC calls stop. This is the current unresolved bug.

### The pattern

Every bug is the same class: state silently corrupts, nothing detects it, the user discovers it minutes or hours later when `cco-permissions` fails. By then the root cause is gone from logs. We need runtime invariants that catch corruption the moment it happens.

## Approach

Add continuous self-checks to the daemon's existing watchdog loop. Every invariant violation should:
1. Log an actionable error explaining exactly what went wrong
2. Attempt self-repair where possible
3. Exit cleanly (for launchd restart) when self-repair isn't possible

## Invariants to Implement

### 1. Heal handler: async with timeout, no external process

**File:** `src/server.ts` — `handleHeal()`
**Priority:** Do this first — it's the current unresolved bug.

The heal handler calls `Bun.spawnSync(["agent-browser", "close", "--all"])`. This:
- Blocks the event loop (no other requests served, watchdog frozen)
- Can hang forever if agent-browser is stuck
- Is redundant — the daemon owns Chrome lifecycle via `supervisor.stopAll()`

**Fix:**
- Replace `Bun.spawnSync` with `Bun.spawn()` + 5s timeout + kill on timeout
- OR remove `agent-browser close --all` entirely and use the existing `cleanAgentBrowserSessions()` (pure filesystem ops, no external process) for session cleanup
- The supervisor's `stopAll()` already handles Chrome — the external close is belt-and-suspenders that causes more problems than it solves

### 2. No spawnSync in request handlers

**File:** `src/server.ts`, audit all handlers
**Why:** Any `spawnSync` in a request handler blocks the event loop. The daemon becomes a zombie — process alive, socket bound, but unresponsive to all requests including the watchdog's self-check.

**Fix:** Grep for `spawnSync` in `server.ts` and `chrome-supervisor.ts`. Replace with async `Bun.spawn()` + timeout everywhere in the request path. `spawnSync` is acceptable in startup/shutdown code (runs once), not in handlers.

### 3. Socket existence self-check

**File:** `src/daemon.ts` — add to watchdog tick
**Why:** The socket file can be deleted by external tools, rogue cleanup scripts, or filesystem operations. If it disappears, the daemon is alive but unreachable.

**Check:** Every watchdog tick (30s), verify `ab-server.sock` exists via `fs.existsSync()`. If missing:
- Log error: `"Socket file disappeared — re-creating"`
- Stop the current server: `server.stop()`
- Clean up the path, re-create: `startServer()`
- This is self-healing — the daemon recovers without a restart

The watchdog currently checks socket health via HTTP fetch. Add the file existence check BEFORE the fetch — no point fetching if the file is gone.

### 4. Chrome PID liveness accounting

**File:** `src/chrome-supervisor.ts` — add to health check tick
**Why:** State says Chrome is `chrome_up` with PID X, but the process may have died without triggering `proc.exited` (SIGKILL from OOM, adopted PID exited, process handle lost).

**Check:** On each health check tick (5s), if state is `chrome_up`:
- Verify PID is alive: `process.kill(state.pid, 0)` (signal 0 = existence check, no actual signal sent)
- If dead: log error with PID and state details, mark crashed, trigger restart
- This is especially important for adopted Chrome (where `rt.proc` is null and there's no `proc.exited` handler)

### 5. Single-daemon invariant

**File:** `src/daemon.ts` — add to watchdog tick
**Why:** Multiple daemons can accumulate (launchd race, manual starts, surviving zombies). The PID lockfile helps at startup but doesn't catch a second daemon appearing later.

**Check:** Every watchdog tick, read `ab-server.pid` and compare to `process.pid`. If mismatch:
- Another daemon overwrote our lockfile — we're the zombie
- Log: `"PID lockfile mismatch — another daemon owns the lock, exiting"`
- `process.exit(1)` — let launchd NOT restart us (the other daemon is the owner)

### 6. Event loop lag monitor

**File:** `src/daemon.ts` — new interval
**Why:** When the event loop is blocked (by spawnSync, heavy computation, or Chrome stderr flooding), the daemon is alive but frozen. The watchdog can't detect this because it's also blocked. An independent lag detector provides observability.

**Implementation:**
```typescript
let lastTick = Date.now();
setInterval(() => {
  const lag = Date.now() - lastTick - 1000;
  if (lag > 2000) {
    log.warn("Event loop blocked", { lagMs: lag });
  }
  lastTick = Date.now();
}, 1000);
```

Also consider `monitorEventLoopDelay` from `node:perf_hooks` if Bun supports it — gives P50/P99 percentiles.

## Implementation Order

1. **Invariant 1** (heal handler async) — fixes the current hang bug
2. **Invariant 2** (no spawnSync) — prevents future hangs
3. **Invariant 3** (socket existence) — self-heals the most common failure mode
4. **Invariant 4** (Chrome PID liveness) — catches silent Chrome death
5. **Invariant 5** (single-daemon) — prevents zombie accumulation
6. **Invariant 6** (event loop monitor) — observability for future issues

## Verification

After implementing each invariant, test it:

1. `ab heal` completes in <5s, doesn't block other RPC calls during heal
2. No `spawnSync` calls in request handlers (grep to confirm)
3. Delete `ab-server.sock` manually → daemon detects within 30s, re-creates, RPC works again
4. `kill -9 <chrome-pid>` → daemon detects within 5s, logs "PID dead", restarts Chrome
5. Start a second `bun run src/daemon.ts` manually → refuses to start OR original detects and exits
6. Check logs during normal operation for event loop lag warnings (should be zero)

## Files to Modify

- `src/daemon.ts` — watchdog enhancements (invariants 3, 5, 6), pass server ref to watchdog
- `src/server.ts` — heal handler async (invariant 1), spawnSync audit (invariant 2)
- `src/chrome-supervisor.ts` — PID liveness check in health tick (invariant 4)

## How to Start

```
cd ~/Documents/Development/tools/ab
```

Read this plan, then implement invariants in order (1→6). After each one:
- `bun build src/daemon.ts --no-bundle` to verify compilation
- `launchctl stop com.clay.ab-server && sleep 1 && launchctl start com.clay.ab-server` to restart
- Run the verification test for that invariant
- Move to the next one
