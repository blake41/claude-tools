/**
 * WebSocket heartbeat for a Chrome target: instant death detection, bounded
 * re-arm after benign closes, and the threshold -> probe -> cooldown ladder.
 *
 * The supervisor owns the per-target runtime, the serial op queue and crash
 * handling. This module reaches them only through `HeartbeatHost`, so the two
 * files never import each other at runtime.
 */

import type { ChromePolicy, ChromeTarget, DetectionReason, HeartbeatMode } from "./types";
import { Logger, withOpId, newOpId } from "./logger";

const log = new Logger({ component: "chrome" });

// Heartbeat re-arm tuning — a benign WS close (Chrome pid still alive) must
// re-arm the heartbeat, not leave the shard heartbeat-less (2026-08-04
// incident: shard ran 5.5h with no heartbeat, only the HTTP polling health
// check, which a half-wedged Chrome kept passing). The delay + bounded
// counter below stop a wedged Chrome from spinning the WS open/close loop —
// after HEARTBEAT_BENIGN_CLOSE_THRESHOLD rapid closes we give up re-arming
// and fall back to polling alone (same degraded mode as a setup failure).
// AB_HEARTBEAT_REARM_MS is test-only — overridden to a tiny value so
// heartbeat-rearm.test.ts doesn't need to wait multiple seconds per case.
const HEARTBEAT_REARM_DELAY_MS = Number(process.env.AB_HEARTBEAT_REARM_MS) || 3_000;
/** Exported so tests can drive exactly this many closes instead of duplicating the magic number. */
export const HEARTBEAT_BENIGN_CLOSE_THRESHOLD = 5;
const HEARTBEAT_STABLE_RESET_MS = 60_000;

/** The per-target runtime fields the heartbeat reads and writes; the supervisor's TargetRuntime satisfies it. */
export interface HeartbeatRuntime {
  heartbeatWs: WebSocket | null;
  consecutiveBenignCloses: number;
  heartbeatRearmTimer: ReturnType<typeof setTimeout> | null;
  heartbeatStableTimer: ReturnType<typeof setTimeout> | null;
  heartbeatGeneration: number;
  heartbeatArmedSince: number | null;
  heartbeatMode: HeartbeatMode;
  heartbeatCooldownTimer: ReturnType<typeof setTimeout> | null;
}

/** What the heartbeat needs from the supervisor. */
export interface HeartbeatHost {
  runtime(target: ChromeTarget): HeartbeatRuntime;
  /** Port and policy of the target's Chrome config. */
  config(target: ChromeTarget): { port: number; policy: ChromePolicy };
  /** PID of the Chrome the target is attached to, or null. */
  currentPid(target: ChromeTarget): number | null;
  /** Current state-machine phase of the target. */
  phase(target: ChromeTarget): string;
  /** Run `fn` on the supervisor's serial op queue. */
  enqueue<T>(fn: () => Promise<T>): Promise<T>;
  handleCrashDetected(target: ChromeTarget, reason: DetectionReason): void;
}

// Threshold -> probe -> cooldown tuning (FINAL CONSENSUS SPEC). Hitting
// HEARTBEAT_BENIGN_CLOSE_THRESHOLD rapid closes no longer gives up on the
// heartbeat forever ("fallback-to-polling"): two independent fresh CDP
// probes (probeBrowserWs) distinguish "our heartbeat bookkeeping is the
// thing failing" from "Chrome's WS layer is actually dead" before deciding
// crash vs. cooldown. AB_PROBE_TIMEOUT_MS / AB_HEARTBEAT_COOLDOWN_MS are
// test-only overrides, matching the established pattern.
export const PROBE_TIMEOUT_MS = Number(process.env.AB_PROBE_TIMEOUT_MS) || 2_000;
export const HEARTBEAT_COOLDOWN_MS = Number(process.env.AB_HEARTBEAT_COOLDOWN_MS) || 5 * 60_000;


/**
 * Decide what to do when a target's heartbeat WebSocket closes.
 *
 * Pure and exported for direct unit testing — see the doc comment on
 * isProfileDirMissing for why this file's timer/process-heavy functions
 * push their branching logic into small pure helpers instead of testing
 * through a real WebSocket + Bun.spawn + timers.
 *
 * - Dead PID → always crash handling, regardless of close history.
 * - Alive PID → re-arm, UNLESS this is the `threshold`-th rapid benign
 *   close in a row, in which case the benign-close budget is exhausted and
 *   the caller must independently verify Chrome's WS layer (decideThresholdPlan
 *   / probeBrowserWs / decideProbeOutcome) before deciding crash vs. cooldown
 *   — never "crashed" for an alive pid, and never a silent give-up either.
 */
export type HeartbeatCloseDecision =
  | { action: "crash" }
  | { action: "rearm"; nextConsecutiveBenignCloses: number }
  | { action: "threshold-reached"; consecutiveBenignCloses: number };

export function decideHeartbeatClose(
  pidAlive: boolean,
  consecutiveBenignCloses: number,
  threshold: number = HEARTBEAT_BENIGN_CLOSE_THRESHOLD,
): HeartbeatCloseDecision {
  if (!pidAlive) return { action: "crash" };
  const next = consecutiveBenignCloses + 1;
  if (next >= threshold) {
    return { action: "threshold-reached", consecutiveBenignCloses: next };
  }
  return { action: "rearm", nextConsecutiveBenignCloses: next };
}

/**
 * Decide what the benign-close threshold means for `target`'s policy. Headed
 * Chrome is never killed by the supervisor (it's an interactive session the
 * user/agent is actively driving), so probing to justify a kill is pointless
 * — go straight to cooldown. Every headless target (always-on shard 0 or
 * on-demand shards 1+) gets probed: five correlated heartbeat closes alone
 * only prove "our heartbeat bookkeeping saw five closes," not that Chrome's
 * WS layer is actually dead (the repo's own 4d187a2 fixed a supervisor-side
 * race that produced exactly this kind of close storm).
 *
 * Takes a distinct "headed" policy value (not ChromePolicy) because
 * CONFIGS["headed"].policy is "on-demand" — identical to headless shards
 * 1+ — so ChromePolicy alone can't distinguish them. Callers pass "headed"
 * literally when target === "headed", and config.policy otherwise.
 */
export function decideThresholdPlan(
  policy: ChromePolicy | "headed",
): "probe" | "cooldown" {
  return policy === "headed" ? "cooldown" : "probe";
}

/** Outcome of the two-probe sequence — any single probe success means Chrome's WS layer is alive. */
export type ProbeOutcome = { action: "recycle" } | { action: "cooldown" };

export function decideProbeOutcome(probe1Ok: boolean, probe2Ok: boolean): ProbeOutcome {
  return probe1Ok || probe2Ok ? { action: "cooldown" } : { action: "recycle" };
}

/** Result of a single probeBrowserWs attempt — `error` is a short diagnostic string for logging, never thrown. */
export interface ProbeResult {
  ok: boolean;
  error?: string;
}

/**
 * One independent, fresh functional CDP probe against `port`: fetch
 * `/json/version` for the current `webSocketDebuggerUrl`, open a brand-new
 * WebSocket (not the heartbeat's — that one already closed), send exactly
 * one CDP request (`method`), and require a response carrying the matching
 * `id` within `timeoutMs`. Closes the WS unconditionally (success, failure,
 * or timeout) so a probe never leaks a connection. Sequential two-probe
 * calling convention (decideThresholdPlan's caller) short-circuits on the
 * first success — this function only ever runs one probe per call.
 */
export async function probeBrowserWs(
  port: number,
  method: "Browser.getVersion" | "Target.getTargets",
  timeoutMs: number = PROBE_TIMEOUT_MS,
): Promise<ProbeResult> {
  let resp: Response;
  try {
    resp = await fetch(`http://127.0.0.1:${port}/json/version`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    return { ok: false, error: `fetch /json/version failed: ${String(err)}` };
  }
  let info: { webSocketDebuggerUrl?: string };
  try {
    info = (await resp.json()) as { webSocketDebuggerUrl?: string };
  } catch (err) {
    return { ok: false, error: `invalid /json/version body: ${String(err)}` };
  }
  if (!info.webSocketDebuggerUrl) {
    return { ok: false, error: "no webSocketDebuggerUrl in /json/version" };
  }

  return new Promise<ProbeResult>((resolve) => {
    let settled = false;
    const id = Date.now();
    let ws: WebSocket;
    const finish = (result: ProbeResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { ws.close(); } catch { /* close unconditionally, best effort */ }
      resolve(result);
    };
    const timer = setTimeout(() => {
      finish({ ok: false, error: `probe timed out after ${timeoutMs}ms` });
    }, timeoutMs);
    try {
      ws = new WebSocket(info.webSocketDebuggerUrl!);
    } catch (err) {
      clearTimeout(timer);
      resolve({ ok: false, error: `WebSocket construction failed: ${String(err)}` });
      return;
    }
    ws.onopen = () => {
      try {
        ws.send(JSON.stringify({ id, method }));
      } catch (err) {
        finish({ ok: false, error: `send failed: ${String(err)}` });
      }
    };
    ws.onmessage = (ev: MessageEvent) => {
      try {
        const data = JSON.parse(String(ev.data)) as { id?: number };
        if (data.id === id) finish({ ok: true });
      } catch {
        // Not our response — keep waiting for the timeout.
      }
    };
    ws.onerror = () => {
      finish({ ok: false, error: "WebSocket error during probe" });
    };
    ws.onclose = () => {
      finish({ ok: false, error: "WebSocket closed before a matching response" });
    };
  });
}

/**
 * Staleness guard for a delayed heartbeat re-arm: the world may have moved
 * on during the HEARTBEAT_REARM_DELAY_MS wait (pid changed, a new heartbeat
 * WS already got established some other way, or the target isn't chrome_up
 * anymore). Pure and exported for the same reason as decideHeartbeatClose.
 */
export function shouldRearmHeartbeat(
  currentPid: number | null,
  deadPid: number,
  currentHeartbeatWs: unknown,
  statePhase: string,
): boolean {
  if (currentPid !== deadPid) return false;
  if (currentHeartbeatWs !== null) return false;
  if (statePhase !== "chrome_up") return false;
  return true;
}

/**
 * Start (or re-arm) the heartbeat WebSocket for `target`.
 *
 * `isRearm` distinguishes a delayed re-arm after a benign close from a
 * fresh call at full launch/adopt time (lines ~385, ~533): only a fresh
 * call resets consecutiveBenignCloses — a re-arm must not reset its own
 * budget, or the bounded-spin guard in decideHeartbeatClose never bites.
 */
export async function startHeartbeat(host: HeartbeatHost, target: ChromeTarget, isRearm = false): Promise<void> {
  const rt = host.runtime(target);
  const config = host.config(target);

  if (!isRearm) {
    rt.consecutiveBenignCloses = 0;
  }

  if (rt.heartbeatRearmTimer) {
    clearTimeout(rt.heartbeatRearmTimer);
    rt.heartbeatRearmTimer = null;
  }
  if (rt.heartbeatStableTimer) {
    clearTimeout(rt.heartbeatStableTimer);
    rt.heartbeatStableTimer = null;
  }

  // Close existing heartbeat if any
  if (rt.heartbeatWs) {
    try { rt.heartbeatWs.close(); } catch { /* ignore */ }
    rt.heartbeatWs = null;
    rt.heartbeatArmedSince = null;
  }

  // Staleness guard setup — snapshot identity BEFORE the fetch/json awaits
  // below (~2s of async work). See heartbeatGeneration's doc comment on
  // TargetRuntime for why: without this, a re-arm (or even a fresh call)
  // whose fetch resolves after the world moved on would unconditionally
  // execute `rt.heartbeatWs = ws` further down, either resurrecting a
  // heartbeat on a torn-down target or orphaning whichever WS loses the
  // race (2026-08-04 incident follow-up).
  const capturedPid = host.currentPid(target);
  const myGeneration = ++rt.heartbeatGeneration;

  try {
    const resp = await fetch(`http://127.0.0.1:${config.port}/json/version`, {
      signal: AbortSignal.timeout(2_000),
    });
    const info = await resp.json() as { webSocketDebuggerUrl?: string };
    if (!info.webSocketDebuggerUrl) {
      reenterCooldownIfStillUp(host, target, isRearm, myGeneration, capturedPid);
      return;
    }

    const ws = new WebSocket(info.webSocketDebuggerUrl);

    // Re-validate staleness now that the async boundary above has passed:
    // pid unchanged, nothing else already armed a heartbeat, no newer
    // startHeartbeat/teardown superseded us (generation), and the target is
    // still chrome_up. Any mismatch means we lost the race — close what we
    // just opened and abandon without touching rt.heartbeatWs.
    if (
      rt.heartbeatGeneration !== myGeneration ||
      host.currentPid(target) !== capturedPid ||
      rt.heartbeatWs !== null ||
      host.phase(target) !== "chrome_up"
    ) {
      log.debug(`[${target}] Heartbeat setup stale after fetch — abandoning`, {
        capturedPid,
        currentPid: host.currentPid(target),
        isRearm,
      });
      try { ws.close(); } catch { /* ignore */ }
      return;
    }

    rt.heartbeatWs = ws;
    rt.heartbeatArmedSince = Date.now();
    rt.heartbeatMode = "armed";
    log.info(`[${target}] Heartbeat armed`, {
      rearm: isRearm,
      consecutiveBenignCloses: rt.consecutiveBenignCloses,
    });

    // Once the heartbeat has stayed open for a while, the shard is healthy
    // again — reset the benign-close budget so a close far in the future
    // doesn't inherit an old, unrelated close streak.
    rt.heartbeatStableTimer = setTimeout(() => {
      if (rt.heartbeatWs === ws) {
        rt.consecutiveBenignCloses = 0;
      }
    }, HEARTBEAT_STABLE_RESET_MS);

    ws.onclose = () => {
      if (rt.heartbeatWs !== ws) return; // Stale — we've moved on
      const deadPid = host.currentPid(target);
      log.warn(`[${target}] Heartbeat WebSocket closed — Chrome may be dead`, { pid: deadPid });
      rt.heartbeatWs = null;
      rt.heartbeatArmedSince = null;
      if (rt.heartbeatStableTimer) {
        clearTimeout(rt.heartbeatStableTimer);
        rt.heartbeatStableTimer = null;
      }
      // Enqueue crash detection — the queue + PID check handles staleness
      if (deadPid) {
        host.enqueue(() =>
          withOpId(newOpId(), async () => {
            if (host.currentPid(target) !== deadPid) return;
            let pidAlive = true;
            try {
              process.kill(deadPid, 0);
            } catch {
              pidAlive = false; // PID dead — proceed to crash handling
            }

            const decision = decideHeartbeatClose(pidAlive, rt.consecutiveBenignCloses);
            if (decision.action === "crash") {
              host.handleCrashDetected(target, "heartbeat-close-pid-dead");
              return;
            }
            if (decision.action === "threshold-reached") {
              // Threshold exhausted — independently verify Chrome's WS layer
              // (or skip straight to cooldown for headed) instead of just
              // giving up. Note: consecutiveBenignCloses is deliberately
              // left at the threshold value, not reset — if the eventual
              // cooldown-retry heartbeat closes again before it survives
              // HEARTBEAT_STABLE_RESET_MS, it's already at threshold and
              // probes/cooldowns again immediately (bounded, no spin).
              rt.consecutiveBenignCloses = decision.consecutiveBenignCloses;
              const effectivePolicy = target === "headed" ? "headed" : config.policy;
              const plan = decideThresholdPlan(effectivePolicy);
              if (plan === "cooldown") {
                log.warn(
                  `[${target}] Heartbeat threshold reached — headed skips probing, cooldown, retry in ${HEARTBEAT_COOLDOWN_MS / 1000}s`,
                  { pid: deadPid, closes: decision.consecutiveBenignCloses },
                );
                enterCooldown(host, target, deadPid);
                return;
              }
              rt.heartbeatMode = "probing";
              log.warn(
                `[${target}] Heartbeat close #${decision.consecutiveBenignCloses} with pid alive — probing browser WS`,
                { pid: deadPid, closes: decision.consecutiveBenignCloses },
              );
              // Detached from opQueue: the probe sequence (up to ~2x
              // PROBE_TIMEOUT_MS) must not block every other target's
              // ensure()/kill() on this shared serial queue. It re-enqueues
              // itself below once it has an outcome.
              const probeGeneration = rt.heartbeatGeneration;
              const closesAtProbeTime = decision.consecutiveBenignCloses;
              runThresholdProbe(host, target, deadPid, probeGeneration, closesAtProbeTime).catch((err) => {
                log.error(`[${target}] Threshold-probe cycle threw`, { err: String(err) });
              });
              return;
            }

            // action === "rearm" — still alive, WebSocket close was benign.
            // Re-arm after a short delay so a wedged Chrome that closes the
            // WS immediately again doesn't spin in a tight loop.
            rt.consecutiveBenignCloses = decision.nextConsecutiveBenignCloses;
            rt.heartbeatMode = "rearming";
            if (rt.heartbeatRearmTimer) clearTimeout(rt.heartbeatRearmTimer);
            rt.heartbeatRearmTimer = setTimeout(() => {
              rt.heartbeatRearmTimer = null;
              if (!shouldRearmHeartbeat(host.currentPid(target), deadPid, rt.heartbeatWs, host.phase(target))) {
                return;
              }
              startHeartbeat(host, target, true);
            }, HEARTBEAT_REARM_DELAY_MS);
          }),
        );
      }
    };

    ws.onerror = () => {
      // Error triggers close event — let onclose handle it
    };
  } catch {
    // CDP not ready or WebSocket failed — fall back to polling health check
    log.debug(`[${target}] Heartbeat WebSocket setup failed — relying on polling`);
    reenterCooldownIfStillUp(host, target, isRearm, myGeneration, capturedPid);
  }
}

/**
 * Re-arm the cooldown timer when a cooldown-triggered `startHeartbeat(target,
 * true)` retry itself fails during setup (no `webSocketDebuggerUrl` in
 * `/json/version`, or the outer catch — fetch/json/WebSocket-construction
 * throwing). Without this, `heartbeatMode` stays "cooldown" but no new
 * `heartbeatCooldownTimer` exists to ever retry again — a permanently stuck,
 * silent degraded state. FINAL CONSENSUS SPEC: cooldown is never terminal,
 * "the timer always retries" (see enterCooldown's doc comment). The cooldown
 * interval itself (HEARTBEAT_COOLDOWN_MS) bounds the retry cadence, so no
 * additional spin guard is needed here.
 *
 * No-op unless this really is a cooldown retry (`isRearm`) for a target that
 * hasn't been superseded (relaunch/teardown bumps heartbeatGeneration, or
 * changes the owning pid) while this attempt's fetch/json was in flight, and
 * is still chrome_up.
 */
function reenterCooldownIfStillUp(
  host: HeartbeatHost,
  target: ChromeTarget,
  isRearm: boolean,
  myGeneration: number,
  capturedPid: number | null,
): void {
  if (!isRearm || capturedPid === null) return;
  const rt = host.runtime(target);
  if (rt.heartbeatGeneration !== myGeneration) return;
  if (host.currentPid(target) !== capturedPid) return;
  if (host.phase(target) !== "chrome_up") return;
  log.warn(`[${target}] Cooldown retry setup failed — retrying in ${HEARTBEAT_COOLDOWN_MS / 1000}s`);
  enterCooldown(host, target, capturedPid);
}

/**
 * Run the two-probe sequence (sequential, short-circuit on first success —
 * see probeBrowserWs) for a target that just hit the benign-close threshold,
 * then re-enqueue onto opQueue to apply the outcome. Deliberately NOT
 * awaited by its caller (the ws.onclose opQueue task) — this function's own
 * awaits (fetch + WS round-trip, up to ~2x PROBE_TIMEOUT_MS) must happen
 * off the shared serial queue so they can't block every other target's
 * ensure()/kill() for that long.
 *
 * `generation`/`deadPid` are snapshotted by the caller before this function
 * starts running, so the re-enqueued continuation can detect whether the
 * world moved on (relaunch, teardown, a newer heartbeat cycle) while the
 * probes were in flight and discard a stale result silently — same
 * generation+pid+phase guard set as startHeartbeat's own staleness check.
 */
async function runThresholdProbe(
  host: HeartbeatHost,
  target: ChromeTarget,
  deadPid: number,
  generation: number,
  closes: number,
): Promise<void> {
  const config = host.config(target);
  const probe1 = await probeBrowserWs(config.port, "Browser.getVersion");
  let probe2: ProbeResult = { ok: false };
  if (!probe1.ok) {
    probe2 = await probeBrowserWs(config.port, "Target.getTargets");
  }
  const outcome = decideProbeOutcome(probe1.ok, probe2.ok);

  await host.enqueue(() =>
    withOpId(newOpId(), async () => {
      const rt = host.runtime(target);
      if (
        rt.heartbeatGeneration !== generation ||
        host.currentPid(target) !== deadPid ||
        host.phase(target) !== "chrome_up"
      ) {
        log.debug(`[${target}] Stale probe result — discarding`, { deadPid, generation });
        return;
      }

      if (outcome.action === "recycle") {
        log.error(`[${target}] Browser WS probes failed — recycling Chrome`, {
          pid: deadPid,
          probe1Err: probe1.error ?? null,
          probe2Err: probe2.error ?? null,
        });
        host.handleCrashDetected(target, "ws-probe-failed");
        return;
      }

      log.warn(
        `[${target}] Browser WS probe succeeded despite ${closes} heartbeat closes — cooldown, retry in ${HEARTBEAT_COOLDOWN_MS / 1000}s`,
        { pid: deadPid },
      );
      enterCooldown(host, target, deadPid);
    }),
  );
}

/**
 * Enter cooldown mode for `target`: heartbeat transport is degraded (no WS
 * armed), detection falls back to HTTP polling alone, and a
 * HEARTBEAT_COOLDOWN_MS timer is armed to attempt exactly one re-arm.
 * Reached either directly (headed skips probing per decideThresholdPlan) or
 * after a probe outcome of "cooldown". There is no terminal degraded state
 * — the timer always retries, gated by shouldRearmHeartbeat so a stale
 * cooldown (Chrome relaunched, target torn down) can't resurrect anything.
 */
function enterCooldown(host: HeartbeatHost, target: ChromeTarget, pid: number): void {
  const rt = host.runtime(target);
  rt.heartbeatMode = "cooldown";
  if (rt.heartbeatCooldownTimer) clearTimeout(rt.heartbeatCooldownTimer);
  rt.heartbeatCooldownTimer = setTimeout(() => {
    rt.heartbeatCooldownTimer = null;
    if (!shouldRearmHeartbeat(host.currentPid(target), pid, rt.heartbeatWs, host.phase(target))) {
      return;
    }
    startHeartbeat(host, target, true);
  }, HEARTBEAT_COOLDOWN_MS);
}

