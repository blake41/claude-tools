/**
 * Chrome process supervisor for the ab-server daemon.
 *
 * Manages Chrome lifecycle (launch, health-check, restart, idle-kill)
 * for both headless and headed targets. All launch/kill operations are
 * serialized through an async queue so concurrent callers share results.
 */

import * as path from "path";
import { existsSync, unlinkSync, rmSync, mkdirSync, readdirSync } from "fs";
import type { ChromeConfig, ChromePolicy, ChromeTarget, DetectionReason, HeartbeatMode, ShardDiagnostics } from "./types";
import { ALL_TARGETS, HEADLESS_POOL_SIZE, headlessTarget } from "./types";
import {
  getState,
  markLaunching,
  markUp,
  markCrashed,
  markIdle,
} from "./state";
import { Logger, withOpId, newOpId } from "./logger";
import { resetAuthState } from "./auth";

const log = new Logger({ component: "chrome" });

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** macOS-only — ab-server does not support other platforms. */
const CHROME_BIN =
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

/** Flags shared by both headless and headed Chrome. */
const SHARED_LAUNCH_ARGS: readonly string[] = [
  "--no-first-run",
  "--no-default-browser-check",
  "--disable-background-networking",
  "--disable-backgrounding-occluded-windows",
  "--disable-component-update",
  "--disable-domain-reliability",
  "--disable-sync",
  "--metrics-recording-only",
  "--disable-machine-learning-model-loader",
  "--disable-client-side-phishing-detection",
  "--safebrowsing-disable-auto-update",
  "--use-mock-keychain",
];

/**
 * Base CDP port for the headless pool. Shard i listens on HEADLESS_BASE_PORT + i.
 * Shard 0 reuses the pre-pool port (9333) and the pre-pool profile dir so
 * existing auth + zero-migration back-compat is preserved.
 */
const HEADLESS_BASE_PORT = 9333;

/**
 * Root directory for every Chrome profile dir. AB_PROFILE_ROOT is test-only —
 * read once at module load, matching the AB_* override pattern used elsewhere
 * in this file (AB_BACKOFF_INITIAL_MS etc.) — so a test can point every
 * target's profilePath at a disposable tmp dir instead of the real
 * ~/.agent-browser. This is the reason the original corruption-recovery test
 * (the one that drove backoffMs to BACKOFF_MAX_MS and asserted on the real
 * rmSync+mkdirSync path) was deleted: it had no way to avoid operating on a
 * real user profile. Default is unchanged production behavior.
 */
const PROFILE_ROOT = process.env.AB_PROFILE_ROOT || `${process.env.HOME}/.agent-browser`;

function buildConfigs(): Record<ChromeTarget, ChromeConfig> {
  const configs: Record<ChromeTarget, ChromeConfig> = {
    headed: {
      target: "headed",
      port: 9444,
      profilePath: `${PROFILE_ROOT}/profile-headed`,
      launchArgs: [...SHARED_LAUNCH_ARGS],
      policy: "on-demand",
    },
  } as Record<ChromeTarget, ChromeConfig>;

  for (let i = 0; i < HEADLESS_POOL_SIZE; i++) {
    const target = headlessTarget(i);
    configs[target] = {
      target,
      port: HEADLESS_BASE_PORT + i,
      profilePath:
        i === 0
          ? `${PROFILE_ROOT}/profile`
          : `${PROFILE_ROOT}/profile-${i}`,
      launchArgs: ["--headless=new", ...SHARED_LAUNCH_ARGS],
      policy: i === 0 ? "always-on" : "on-demand",
    };
  }

  return configs;
}

const CONFIGS: Record<ChromeTarget, ChromeConfig> = buildConfigs();

const DASHBOARD_PORT = 4848;

let dashboardProc: ReturnType<typeof Bun.spawn> | null = null;

// Health check tuning. AB_HEALTH_INTERVAL_MS is test-only — overridden to a
// tiny value so health-summary.test.ts can observe a real tick (lastHealthOkAt
// getting set) without waiting multiple real seconds.
const HEALTH_INTERVAL_MS = Number(process.env.AB_HEALTH_INTERVAL_MS) || 5_000;
const HEALTH_TIMEOUT_MS = 2_000;
const HEALTH_FAILURE_THRESHOLD = 3;

// Periodic per-target health summary log — diagnosability gap from the
// 2026-08-04 incident (heartbeat closed 16:28Z, nothing loggable until
// 21:52Z). ~36 lines/hour for 3 shards; AB_HEALTH_SUMMARY_MS is test-only.
const HEALTH_SUMMARY_INTERVAL_MS = Number(process.env.AB_HEALTH_SUMMARY_MS) || 5 * 60_000;

// Backoff tuning. AB_BACKOFF_INITIAL_MS / AB_BACKOFF_MAX_MS are test-only —
// let a test drive an on-demand shard all the way to the corruption-recovery
// gate (`rt.backoffMs >= BACKOFF_MAX_MS`) via a couple of fast crash cycles
// instead of the real ~31s (1s+2s+4s+8s+16s) of exponential real-time waits
// the production defaults would otherwise require.
const BACKOFF_INITIAL_MS = Number(process.env.AB_BACKOFF_INITIAL_MS) || 1_000;
const BACKOFF_MAX_MS = Number(process.env.AB_BACKOFF_MAX_MS) || 30_000;
// AB_BACKOFF_STABLE_RESET_MS is test-only, matching the established pattern
// (e.g. AB_HEARTBEAT_REARM_MS) — lets a test prove "spawn success alone
// doesn't reset backoff; only surviving this stable window does" without a
// real 60s wait.
const BACKOFF_STABLE_RESET_MS = Number(process.env.AB_BACKOFF_STABLE_RESET_MS) || 60_000;

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

// Threshold -> probe -> cooldown tuning (FINAL CONSENSUS SPEC). Hitting
// HEARTBEAT_BENIGN_CLOSE_THRESHOLD rapid closes no longer gives up on the
// heartbeat forever ("fallback-to-polling"): two independent fresh CDP
// probes (probeBrowserWs) distinguish "our heartbeat bookkeeping is the
// thing failing" from "Chrome's WS layer is actually dead" before deciding
// crash vs. cooldown. AB_PROBE_TIMEOUT_MS / AB_HEARTBEAT_COOLDOWN_MS are
// test-only overrides, matching the established pattern.
export const PROBE_TIMEOUT_MS = Number(process.env.AB_PROBE_TIMEOUT_MS) || 2_000;
export const HEARTBEAT_COOLDOWN_MS = Number(process.env.AB_HEARTBEAT_COOLDOWN_MS) || 5 * 60_000;

// Headed idle timeout
const HEADED_IDLE_TIMEOUT_MS = 90 * 60_000; // 90 minutes (covers oracle Pro runs up to 60m)

// ---------------------------------------------------------------------------
// Operation queue — serializes all state-mutating operations
// ---------------------------------------------------------------------------

class SerialQueue {
  private tail: Promise<void> = Promise.resolve();

  enqueue<T>(fn: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.tail = this.tail.then(async () => {
        try {
          resolve(await fn());
        } catch (err) {
          reject(err);
        }
      });
    });
  }
}

const opQueue = new SerialQueue();

// ---------------------------------------------------------------------------
// Per-target runtime state (not persisted — lives in-process only)
// ---------------------------------------------------------------------------

interface TargetRuntime {
  proc: ReturnType<typeof Bun.spawn> | null;
  /** PID of an adopted Chrome we don't own the process handle for */
  adoptedPid: number | null;
  healthTimer: ReturnType<typeof setInterval> | null;
  consecutiveFailures: number;
  backoffMs: number;
  stableTimer: ReturnType<typeof setTimeout> | null;
  idleTimer: ReturnType<typeof setTimeout> | null;
  restartTimer: ReturnType<typeof setTimeout> | null;
  /** Guards against race between scheduleRestart and proc.exited */
  restartScheduled: boolean;
  /** In-flight launch promise — deduplicates concurrent ensure calls */
  inflight: Promise<{ pid: number; port: number }> | null;
  /** WebSocket heartbeat connection to Chrome's devtools endpoint */
  heartbeatWs: WebSocket | null;
  /**
   * Consecutive benign heartbeat closes (Chrome pid still alive at close
   * time) since the last stable period. Bounded by
   * HEARTBEAT_BENIGN_CLOSE_THRESHOLD so a wedged Chrome that keeps closing
   * the WS immediately after re-arm can't spin forever — see
   * decideHeartbeatClose.
   */
  consecutiveBenignCloses: number;
  /** Delayed re-arm timer scheduled after a benign heartbeat close. */
  heartbeatRearmTimer: ReturnType<typeof setTimeout> | null;
  /** Resets consecutiveBenignCloses once the heartbeat has stayed open for HEARTBEAT_STABLE_RESET_MS. */
  heartbeatStableTimer: ReturnType<typeof setTimeout> | null;
  /**
   * Bumped at the top of every startHeartbeat() call and inside
   * clearTimers(). startHeartbeat snapshots this counter before its
   * fetch/json awaits (~2s) and re-checks it afterward: if anything else
   * bumped it in the meantime — a competing fresh/rearm startHeartbeat call,
   * or a teardown (kill/handleCrashDetected/handleExit, all of which route
   * through clearTimers) — the in-flight call knows it's been superseded and
   * must not resurrect/orphan a heartbeat WS. See startHeartbeat's staleness
   * guard (2026-08-04 incident follow-up: the un-guarded version of this
   * race either resurrected a heartbeat on a torn-down target or orphaned
   * an open devtools WS for the life of the Chrome process).
   */
  heartbeatGeneration: number;
  /**
   * Epoch ms of the last successful checkCdp() poll inside the health-check
   * timer; null until the first successful poll. Surfaced on /status and in
   * the periodic health summary log (2026-08-04 incident: no signal existed
   * between a heartbeat close and the next crash — this closes that gap).
   */
  lastHealthOkAt: number | null;
  /**
   * Epoch ms since the current heartbeat WS was armed; null whenever no
   * heartbeat is open (closed, degraded to polling-only, or never
   * established). Paired with every `heartbeatWs = ws` / `heartbeatWs = null`
   * assignment.
   */
  heartbeatArmedSince: number | null;
  /** Periodic (every HEALTH_SUMMARY_INTERVAL_MS) per-target health summary log timer. */
  healthSummaryTimer: ReturnType<typeof setInterval> | null;
  /**
   * Current heartbeat transport mode — see HeartbeatMode's doc comment in
   * types.ts. Set alongside every heartbeatWs assignment / teardown so it
   * never drifts from the actual WS lifecycle.
   */
  heartbeatMode: HeartbeatMode;
  /**
   * The last exit handleExit observed for this target, verbatim (code XOR
   * signal, never synthesized). Written ONLY by handleExit — intentional
   * teardowns (doKill, idle timeout, heal) never reach it because they mark
   * idle before the exit fires, and handleExit's own idle/restartScheduled
   * guards make it a no-op for those paths.
   */
  lastExit: { code: number | null; signal: string | null; at: number } | null;
  /** The last crash-detection event handleCrashDetected recorded, with why. */
  lastDetection: { reason: DetectionReason; at: number } | null;
  /**
   * Epoch ms before which a fresh ensure() must fail fast with
   * RetryAfterError rather than attempt another launch. Set by the failure
   * accounting in handleExit/handleCrashDetected (now + backoffMs) so a
   * shard mid-crash-loop backoff can't be hammered by a caller's ensure()
   * blocking the shared serial opQueue.
   */
  retryNotBefore: number;
  /** Timer for the cooldown-mode retry (HEARTBEAT_COOLDOWN_MS after entering cooldown). */
  heartbeatCooldownTimer: ReturnType<typeof setTimeout> | null;
}

function buildRuntime(): Record<ChromeTarget, TargetRuntime> {
  const built: Record<ChromeTarget, TargetRuntime> = {} as Record<ChromeTarget, TargetRuntime>;
  for (const target of ALL_TARGETS) {
    built[target] = freshRuntime();
  }
  return built;
}

const runtime: Record<ChromeTarget, TargetRuntime> = buildRuntime();

function freshRuntime(): TargetRuntime {
  return {
    proc: null,
    adoptedPid: null,
    healthTimer: null,
    consecutiveFailures: 0,
    backoffMs: BACKOFF_INITIAL_MS,
    stableTimer: null,
    idleTimer: null,
    restartTimer: null,
    restartScheduled: false,
    inflight: null,
    heartbeatWs: null,
    consecutiveBenignCloses: 0,
    heartbeatRearmTimer: null,
    heartbeatStableTimer: null,
    heartbeatGeneration: 0,
    lastHealthOkAt: null,
    heartbeatArmedSince: null,
    healthSummaryTimer: null,
    heartbeatMode: "off",
    lastExit: null,
    lastDetection: null,
    retryNotBefore: 0,
    heartbeatCooldownTimer: null,
  };
}

// ---------------------------------------------------------------------------
// Runtime snapshot — for crash dumps
// ---------------------------------------------------------------------------

/** Capture the current runtime state of every supervised Chrome target for diagnostics. */
export function getRuntimeSnapshot(): Record<string, unknown> {
  const snapshot: Record<string, unknown> = {};
  for (const target of ALL_TARGETS) {
    const rt = runtime[target];
    const state = getState(target);
    snapshot[target] = {
      phase: state.phase,
      ...(state.phase === "chrome_up" ? { pid: state.pid, port: state.port } : {}),
      ...(state.phase === "chrome_crashed" ? { exitCode: state.exitCode } : {}),
      procPid: rt.proc?.pid ?? null,
      adoptedPid: rt.adoptedPid,
      consecutiveFailures: rt.consecutiveFailures,
      backoffMs: rt.backoffMs,
      restartScheduled: rt.restartScheduled,
      hasHealthTimer: rt.healthTimer !== null,
      hasStableTimer: rt.stableTimer !== null,
      hasIdleTimer: rt.idleTimer !== null,
      hasRestartTimer: rt.restartTimer !== null,
      hasHeartbeatWs: rt.heartbeatWs !== null,
      hasInflight: rt.inflight !== null,
      consecutiveBenignCloses: rt.consecutiveBenignCloses,
      hasHeartbeatRearmTimer: rt.heartbeatRearmTimer !== null,
      lastHealthOkAt: rt.lastHealthOkAt !== null ? new Date(rt.lastHealthOkAt).toISOString() : null,
      heartbeatArmedSince: rt.heartbeatArmedSince !== null ? new Date(rt.heartbeatArmedSince).toISOString() : null,
      heartbeatMode: rt.heartbeatMode,
      lastExit: rt.lastExit !== null ? { ...rt.lastExit, at: new Date(rt.lastExit.at).toISOString() } : null,
      lastDetection: rt.lastDetection !== null ? { ...rt.lastDetection, at: new Date(rt.lastDetection.at).toISOString() } : null,
      retryNotBefore: rt.retryNotBefore,
      hasHeartbeatCooldownTimer: rt.heartbeatCooldownTimer !== null,
    };
  }
  return snapshot;
}

/**
 * Per-target health diagnostics for the /status RPC — the 2026-08-04
 * incident diagnosability gap (a heartbeat closed at 16:28Z and nothing
 * loggable existed until the next crash at 21:52Z). Kept separate from
 * getRuntimeSnapshot (crash-dump-shaped, `Record<string, unknown>`) so
 * server.ts gets a typed, additive shape it can attach to StatusResponse
 * without touching ChromeState itself.
 */
export function getHealthDiagnostics(): Record<ChromeTarget, ShardDiagnostics> {
  const result: Record<ChromeTarget, ShardDiagnostics> = {} as Record<ChromeTarget, ShardDiagnostics>;
  for (const target of ALL_TARGETS) {
    const rt = runtime[target];
    result[target] = {
      lastHealthOkAt: rt.lastHealthOkAt !== null ? new Date(rt.lastHealthOkAt).toISOString() : null,
      heartbeatArmedSince: rt.heartbeatArmedSince !== null ? new Date(rt.heartbeatArmedSince).toISOString() : null,
      heartbeatMode: rt.heartbeatMode,
      lastExit: rt.lastExit !== null ? { ...rt.lastExit, at: new Date(rt.lastExit.at).toISOString() } : null,
      lastDetection: rt.lastDetection !== null ? { ...rt.lastDetection, at: new Date(rt.lastDetection.at).toISOString() } : null,
    };
  }
  return result;
}

// ---------------------------------------------------------------------------
// Health summary — pure payload builder (testable without timers)
// ---------------------------------------------------------------------------

export interface HealthSummaryPayload {
  target: ChromeTarget;
  phase: string;
  pid: number | null;
  heartbeatArmed: boolean;
  heartbeatArmedSinceIso: string | null;
  consecutiveFailures: number;
  lastHealthOkAtIso: string | null;
  heartbeatMode: HeartbeatMode;
  lastExit: { code: number | null; signal: string | null; at: string } | null;
  lastDetection: { reason: DetectionReason; at: string } | null;
}

/**
 * Pure builder for the periodic per-target health summary log line. Exported
 * for direct unit testing — same rationale as isProfileDirMissing /
 * decideHeartbeatClose: keep the file's timer/process-heavy code as thin
 * wiring around small pure functions. heartbeatMode/lastExit/lastDetection
 * are the same additive diagnostics surfaced on /status (getHealthDiagnostics)
 * — carried through here too so the periodic log line and doctor never
 * disagree about a shard's crash evidence.
 */
export function buildHealthSummaryPayload(
  target: ChromeTarget,
  phase: string,
  pid: number | null,
  heartbeatArmed: boolean,
  heartbeatArmedSince: number | null,
  consecutiveFailures: number,
  lastHealthOkAt: number | null,
  heartbeatMode: HeartbeatMode,
  lastExit: { code: number | null; signal: string | null; at: number } | null,
  lastDetection: { reason: DetectionReason; at: number } | null,
): HealthSummaryPayload {
  return {
    target,
    phase,
    pid,
    heartbeatArmed,
    heartbeatArmedSinceIso: heartbeatArmedSince !== null ? new Date(heartbeatArmedSince).toISOString() : null,
    consecutiveFailures,
    lastHealthOkAtIso: lastHealthOkAt !== null ? new Date(lastHealthOkAt).toISOString() : null,
    heartbeatMode,
    lastExit: lastExit !== null ? { code: lastExit.code, signal: lastExit.signal, at: new Date(lastExit.at).toISOString() } : null,
    lastDetection: lastDetection !== null ? { reason: lastDetection.reason, at: new Date(lastDetection.at).toISOString() } : null,
  };
}

/** Logs the periodic per-target health summary. No-op for idle targets — keeps volume down. */
function logHealthSummary(target: ChromeTarget): void {
  const rt = runtime[target];
  const state = getState(target);
  if (state.phase === "idle") return;
  const pid = rt.proc?.pid ?? rt.adoptedPid ?? null;
  const payload = buildHealthSummaryPayload(
    target,
    state.phase,
    pid,
    rt.heartbeatWs !== null,
    rt.heartbeatArmedSince,
    rt.consecutiveFailures,
    rt.lastHealthOkAt,
    rt.heartbeatMode,
    rt.lastExit,
    rt.lastDetection,
  );
  log.info(`[${target}] Health summary`, payload as unknown as Record<string, unknown>);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Whether `profilePath` doesn't exist yet on disk — checked before any
 * launch/recovery logic touches it (mkdir during corruption recovery, or
 * Chrome itself creating the dir on first launch, would make a check
 * afterward meaningless). A true result means the shard's Chrome is about to
 * start from an empty profile: no cookies, i.e. logged out (chrome-pool-plan
 * Unit 3, decision 5). Exported for direct unit testing against a throwaway
 * path — see chrome-supervisor.test.ts's `isProfileDirMissing` block.
 */
export function isProfileDirMissing(profilePath: string): boolean {
  return !existsSync(profilePath);
}

/**
 * Whether a launch attempt's `profileFresh` result should be overridden to
 * `true` because crash-loop corruption recovery ran during this launch. The
 * recovery block (`rmSync` + `mkdirSync` of the profile dir, further down in
 * `launchChrome`) happens strictly after the early `isProfileDirMissing`
 * snapshot is taken, so that snapshot is stale by the time launch finishes —
 * without this override a shard that just got its profile nuked would
 * report `profileFresh: false` and suppress the reauth hint exactly when
 * it's most needed (chrome-pool-plan Fix 4). Pure and exported for direct
 * unit testing — the real crash-loop path itself needs real repeated Chrome
 * cycling to trigger and is documented elsewhere (daemon-integration.test.ts)
 * as flaky under sandboxed conditions, so integration coverage intentionally
 * stops at this helper.
 */
export function profileFreshAfterRecovery(preLaunchSnapshot: boolean, didRecover: boolean): boolean {
  return didRecover ? true : preLaunchSnapshot;
}

/**
 * Ensure Chrome is running for `target`. If already up, returns immediately.
 * Serialized through the operation queue — concurrent calls wait their turn.
 */
export async function ensure(
  target: ChromeTarget,
): Promise<{ pid: number; port: number; alreadyRunning: boolean; profileFresh: boolean }> {
  return opQueue.enqueue(() =>
    withOpId(newOpId(), async () => {
      // Check if already up FIRST (fast path, no launch needed). A
      // shard that's already up was, by construction, launched from a
      // profile that already existed at that point — never fresh here.
      const state = getState(target);
      if (state.phase === "chrome_up") {
        return { pid: state.pid, port: state.port, alreadyRunning: true, profileFresh: false };
      }
      const result = await launchChrome(target);
      return { ...result, alreadyRunning: false };
    }),
  ) as Promise<{ pid: number; port: number; alreadyRunning: boolean; profileFresh: boolean }>;
}

/**
 * Kill Chrome for a target. Cleans up health timers and idle timers.
 */
export async function kill(target: ChromeTarget): Promise<void> {
  return opQueue.enqueue(() =>
    withOpId(newOpId(), () => doKill(target)),
  ) as Promise<void>;
}

async function doKill(target: ChromeTarget): Promise<void> {
  const rt = runtime[target];
  const config = CONFIGS[target];
  clearTimers(target);

  if (rt.proc) {
    const proc = rt.proc; // Capture before await — handleExit may null rt.proc
    log.info(`[${target}] Killing Chrome (PID ${proc.pid})`, { killedBy: "supervisor", reason: "kill() requested" });
    proc.kill();
    // Wait for process exit (up to 5s)
    await Promise.race([proc.exited, sleep(5_000)]);
    // If Chrome didn't exit gracefully, escalate to SIGKILL
    if (proc.exitCode === null) {
      log.warn(`[${target}] Chrome did not exit gracefully — sending SIGKILL`, {
        killedBy: "supervisor",
        reason: "graceful-exit-timeout",
      });
      proc.kill(9); // SIGKILL
      await Promise.race([proc.exited, sleep(2_000)]);
    }
    rt.proc = null;
  } else if (rt.adoptedPid) {
    // Kill adopted Chrome we don't have a proc handle for
    log.info(`[${target}] Killing adopted Chrome (PID ${rt.adoptedPid})`, {
      killedBy: "supervisor",
      reason: "kill() requested",
    });
    try {
      process.kill(rt.adoptedPid, "SIGKILL");
    } catch { /* already dead */ }
    rt.adoptedPid = null;
  }

  // Clean up SingletonLock so next launch doesn't hit SIGTRAP
  const lockPath = path.join(config.profilePath, "SingletonLock");
  try {
    if (existsSync(lockPath)) unlinkSync(lockPath);
  } catch { /* best effort */ }

  if (getState(target).phase !== "idle") {
    markIdle(target);
  }
}

/**
 * Start the daemon's always-on supervision. Call once at daemon boot.
 * Launches every always-on target (today: headed is on-demand, so this
 * launches only headless shard 0), starts health checks, then launches
 * the dashboard. On-demand targets (headed, headless shards >= 1) stay
 * idle until their first ensure() so idle machines run one Chrome, not N.
 */
export interface StartSupervisionResult {
  /**
   * Always-on targets that were still inside their crash-loop backoff
   * window (RetryAfterError) when startSupervision ran, so their launch was
   * skipped this pass rather than left to throw and abort the whole
   * function. handleHeal surfaces these in its HealResponse.actions.
   */
  skippedBackoff: Array<{ target: ChromeTarget; retryAfterMs: number }>;
}

export async function startSupervision(): Promise<StartSupervisionResult> {
  return opQueue.enqueue(() =>
    withOpId(newOpId(), async () => {
      if (process.platform !== "darwin") {
        log.error("ab-server only supports macOS");
        throw new Error("Unsupported platform: " + process.platform);
      }
      log.info("Starting Chrome supervision");
      const skippedBackoff: Array<{ target: ChromeTarget; retryAfterMs: number }> = [];
      for (const target of ALL_TARGETS) {
        if (CONFIGS[target].policy !== "always-on") continue;
        const state = getState(target);
        if (state.phase !== "chrome_up") {
          // An always-on target's launch must never throw uncaught here — a
          // crash-looping shard (RetryAfterError from launchChrome's
          // ensure-gate) would otherwise abort this loop before later
          // always-on targets get a chance AND before startDashboard() runs
          // below. Scenario: `ab heal` on a crash-looping always-on shard —
          // without this catch, the shard stays down with no relaunch timer
          // and the dashboard never restarts either.
          try {
            await launchChrome(target);
          } catch (err) {
            if (err instanceof RetryAfterError) {
              log.warn(`[${target}] startSupervision skipping launch — crash backoff`, {
                retryAfterMs: err.retryAfterMs,
              });
              skippedBackoff.push({ target, retryAfterMs: err.retryAfterMs });
            } else {
              log.error(`[${target}] startSupervision launch failed`, { err: String(err) });
            }
          }
        }
      }
      startDashboard();
      log.info("Chrome supervision active");
      return { skippedBackoff };
    }),
  ) as Promise<StartSupervisionResult>;
}

/**
 * Teardown all supervised Chrome instances. Call on daemon shutdown.
 */
export async function stopAll(): Promise<void> {
  return opQueue.enqueue(() =>
    withOpId(newOpId(), async () => {
      log.info("Stopping all Chrome instances");
      if (dashboardProc && dashboardProc.exitCode === null) {
        log.info("Killing dashboard process");
        dashboardProc.kill();
        dashboardProc = null;
      }
      await Promise.all(ALL_TARGETS.map((target) => doKill(target)));
    }),
  ) as Promise<void>;
}

// ---------------------------------------------------------------------------
// Chrome launch
// ---------------------------------------------------------------------------

/**
 * Thrown by launchChrome's ensure-gate when a target is inside its
 * crash-loop backoff window (rt.retryNotBefore in the future). Deliberately
 * a fail-fast rejection, never a sleep: opQueue is a single global serial
 * queue (see SerialQueue above), so sleeping inside launchChrome for one
 * target's backoff would block every other target's ensure()/kill() until
 * the sleep finished. server.ts maps this to a 503 with retryAfterMs.
 */
export class RetryAfterError extends Error {
  constructor(public readonly retryAfterMs: number) {
    super(`Chrome ensure rejected — crash backoff, retry in ${Math.ceil(retryAfterMs / 1000)}s`);
    this.name = "RetryAfterError";
  }
}

async function launchChrome(
  target: ChromeTarget,
): Promise<{ pid: number; port: number; profileFresh: boolean }> {
  const config = CONFIGS[target];
  const rt = runtime[target];

  // Ensure gate (item 7): fail fast rather than let a backoff-window ensure
  // block the shared opQueue for every other target.
  const now = Date.now();
  if (now < rt.retryNotBefore) {
    const retryAfterMs = rt.retryNotBefore - now;
    log.warn(`[${target}] Ensure rejected — crash backoff`, { retryAfterMs });
    throw new RetryAfterError(retryAfterMs);
  }

  rt.restartScheduled = false;
  markLaunching(target);

  // Snapshot freshness before anything below can create/touch the profile
  // dir (SingletonLock cleanup, corruption-recovery mkdir, or Chrome itself
  // creating it on first launch) — see isProfileDirMissing's doc comment.
  // `let`, not `const`: the corruption-recovery block below can invalidate
  // this snapshot (see profileFreshAfterRecovery's doc comment, Fix 4).
  let profileFresh = isProfileDirMissing(config.profilePath);

  // --- Port conflict resolution ---
  // Check if something is already listening on our port before spawning.
  const inCrashLoop = rt.backoffMs >= BACKOFF_MAX_MS;
  const existingCdp = await checkCdp(config.port);
  if (existingCdp && !inCrashLoop) {
    // A responsive CDP is already on our port — adopt it instead of launching.
    const pid = await getListeningPid(config.port);
    if (pid) {
      log.info(`[${target}] Adopting existing Chrome on port ${config.port}`, { pid });
      rt.proc = null; // We don't own the process handle
      rt.adoptedPid = pid;
      markUp(target, pid, config.port);
      startHealthCheck(target);
      startHeartbeat(target);
      resetStableTimer(target);
      if (target === "headed") resetIdleTimer(target);
      return { pid, port: config.port, profileFresh };
    }
  } else if (inCrashLoop && existingCdp) {
    // In a crash loop — don't adopt, kill the occupant so we go through
    // the full recovery path (profile nuke below).
    const stalePid = await getListeningPid(config.port);
    if (stalePid) {
      log.warn(`[${target}] Crash loop — killing existing Chrome (PID ${stalePid}) instead of adopting`, {
        killedBy: "supervisor",
        reason: "crash-loop-recovery",
      });
      try {
        process.kill(stalePid, "SIGKILL");
      } catch {
        // Process may have already exited
      }
      const deadline = Date.now() + 3_000;
      while (Date.now() < deadline) {
        if (!(await getListeningPid(config.port))) break;
        await sleep(200);
      }
    }
  } else {
    // Port might be bound by a non-responsive process — kill the occupant.
    const stalePid = await getListeningPid(config.port);
    if (stalePid) {
      log.warn(`[${target}] Port ${config.port} occupied by unresponsive PID ${stalePid} — killing`, {
        killedBy: "supervisor",
        reason: "port-occupied",
      });
      try {
        process.kill(stalePid, "SIGKILL");
      } catch {
        // Process may have already exited
      }
      // Wait up to 3s for the port to free up
      const deadline = Date.now() + 3_000;
      while (Date.now() < deadline) {
        if (!(await getListeningPid(config.port))) break;
        await sleep(200);
      }
    }
  }

  // --- Stale lock cleanup ---
  // Chrome leaves SingletonLock when it crashes without cleanup. The lock is a
  // symlink pointing to "hostname-PID". If the PID is dead, Chrome will crash
  // with SIGTRAP (exit 133) on launch. Remove it unconditionally — we know no
  // other Chrome should be using this profile because we just killed any occupant.
  const lockPath = path.join(config.profilePath, "SingletonLock");
  if (existsSync(lockPath)) {
    try {
      unlinkSync(lockPath);
      log.info(`[${target}] Removed stale SingletonLock`);
    } catch {
      // Best effort — may fail if profile dir doesn't exist yet
    }
  }

  // --- Profile corruption recovery ---
  // If Chrome has been crash-looping (exit 133 = SIGTRAP, typically corrupt
  // profile), nuke the profile and let Chrome create a fresh one. We detect
  // this by checking if backoff has escalated, which means repeated crashes.
  if (rt.backoffMs >= BACKOFF_MAX_MS) {
    log.warn(`[${target}] Backoff at max — resetting profile to recover from possible corruption`);
    let recovered = false;
    try {
      rmSync(config.profilePath, { recursive: true, force: true });
      mkdirSync(config.profilePath, { recursive: true });
      rt.backoffMs = BACKOFF_INITIAL_MS;
      recovered = true;
    } catch (err) {
      log.error(`[${target}] Failed to reset profile`, { err: String(err) });
    }
    profileFresh = profileFreshAfterRecovery(profileFresh, recovered);
  }

  const args = [
    `--remote-debugging-port=${config.port}`,
    `--user-data-dir=${config.profilePath}`,
    ...config.launchArgs,
    "about:blank",
  ];

  log.info(`[${target}] Spawning Chrome`, { port: config.port, args });

  const proc = Bun.spawn([CHROME_BIN, ...args], {
    stdout: "ignore",
    stderr: "pipe",
  });

  // Capture Chrome stderr for crash diagnostics
  if (proc.stderr) {
    const reader = proc.stderr.getReader();
    const decoder = new TextDecoder();
    (async () => {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          const lines = decoder.decode(value, { stream: true }).trim();
          if (lines) {
            for (const line of lines.split("\n")) {
              log.info(`[${target}] chrome-stderr: ${line.trim()}`);
            }
          }
        }
      } catch {
        // Stream closed — normal on exit
      }
    })();
  }

  rt.proc = proc;
  rt.adoptedPid = null; // No longer adopted — we own the process

  // Watch for unexpected exit
  proc.exited.then(() => {
    const exitedPid = proc.pid;
    // Captured now, before Bun reaps the handle — read the raw nullable
    // fields (not the `.exited` promise's own numeric resolution) so
    // handleExit's lastExit records code XOR signal verbatim, never
    // synthesized: a signal death (e.g. SIGKILL) reports exitCode null and
    // signalCode "SIGKILL", not a fabricated 137. An exit with a signal
    // logged here and NO preceding "killedBy: supervisor" log line is
    // provably external (OOM etc.) rather than an ambiguous crash.
    const rawExitCode = proc.exitCode;
    const exitSignal = proc.signalCode ?? null;
    opQueue.enqueue(() =>
      withOpId(newOpId(), async () => {
        // If a different Chrome is now running, this exit is stale
        const currentPid = rt.proc?.pid ?? rt.adoptedPid;
        if (currentPid !== exitedPid && getState(target).phase !== "idle") {
          log.info(`[${target}] Ignoring stale exit for PID ${exitedPid}`);
          return;
        }
        handleExit(target, rawExitCode, exitSignal);
      }),
    );
  });

  // Wait for CDP to respond (up to 15s)
  const ready = await waitForCdp(config.port, 15_000);
  if (!ready) {
    log.error(`[${target}] Chrome did not respond within 15s`, {
      port: config.port,
    });
    proc.kill();
    rt.proc = null;
    markCrashed(target, -1);
    if (CONFIGS[target].policy === "always-on") {
      scheduleRestart(target);
    }
    throw new Error(`Chrome ${target} failed to start`);
  }

  markUp(target, proc.pid, config.port);

  // Start health checking
  startHealthCheck(target);
  startHeartbeat(target);

  // Reset backoff — start a stable-uptime timer
  resetStableTimer(target);

  // If headed, start idle timer
  if (target === "headed") {
    resetIdleTimer(target);
  }

  log.info(`[${target}] Chrome ready`, { pid: proc.pid, port: config.port });
  return { pid: proc.pid, port: config.port, profileFresh };
}

// ---------------------------------------------------------------------------
// Health checking
// ---------------------------------------------------------------------------

function startHealthCheck(target: ChromeTarget): void {
  const rt = runtime[target];
  const config = CONFIGS[target];

  // Clear any existing timer
  if (rt.healthTimer) clearInterval(rt.healthTimer);
  if (rt.healthSummaryTimer) clearInterval(rt.healthSummaryTimer);

  rt.consecutiveFailures = 0;

  rt.healthTimer = setInterval(async () => {
    // Invariant 4: verify Chrome PID is still alive (catches OOM kills, adopted PIDs dying)
    const currentState = getState(target);
    if (currentState.phase === "chrome_up") {
      const pid = rt.proc?.pid ?? rt.adoptedPid;
      if (pid) {
        try {
          process.kill(pid, 0);
        } catch {
          log.error(`[${target}] Chrome PID ${pid} gone — marking crashed`, {
            hadProc: !!rt.proc,
            wasAdopted: !!rt.adoptedPid,
          });
          if (rt.healthTimer) clearInterval(rt.healthTimer);
          rt.healthTimer = null;
          const crashedPid = pid;
          opQueue.enqueue(() =>
            withOpId(newOpId(), async () => {
              const currentPid = rt.proc?.pid ?? rt.adoptedPid;
              if (currentPid !== crashedPid) {
                log.info(`[${target}] Ignoring stale crash for PID ${crashedPid}`);
                return;
              }
              handleCrashDetected(target, "pid-gone");
            }),
          );
          return;
        }
      }
    }

    const ok = await checkCdp(config.port);
    if (ok) {
      rt.consecutiveFailures = 0;
      rt.lastHealthOkAt = Date.now();
    } else {
      rt.consecutiveFailures++;
      log.warn(`[${target}] Health check failed`, {
        consecutive: rt.consecutiveFailures,
        threshold: HEALTH_FAILURE_THRESHOLD,
      });

      if (rt.consecutiveFailures >= HEALTH_FAILURE_THRESHOLD) {
        log.error(`[${target}] Chrome unresponsive — marking crashed`);
        if (rt.healthTimer) clearInterval(rt.healthTimer);
        rt.healthTimer = null;
        const crashedPid = rt.proc?.pid ?? rt.adoptedPid;
        opQueue.enqueue(() =>
          withOpId(newOpId(), async () => {
            const currentPid = rt.proc?.pid ?? rt.adoptedPid;
            if (currentPid !== crashedPid) {
              log.info(`[${target}] Ignoring stale crash for PID ${crashedPid}`);
              return;
            }
            handleCrashDetected(target, "health-poll-failures");
          }),
        );
      }
    }
  }, HEALTH_INTERVAL_MS);

  rt.healthSummaryTimer = setInterval(() => {
    logHealthSummary(target);
  }, HEALTH_SUMMARY_INTERVAL_MS);
}

async function checkCdp(port: number): Promise<boolean> {
  try {
    const resp = await fetch(`http://127.0.0.1:${port}/json/version`, {
      signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
    });
    const ok = resp.ok;
    await resp.body?.cancel();
    return ok;
  } catch {
    return false;
  }
}

async function waitForCdp(
  port: number,
  timeoutMs: number,
): Promise<boolean> {
  const start = Date.now();
  const cutoff = start + timeoutMs;
  while (Date.now() < cutoff) {
    if (await checkCdp(port)) return true;
    // Poll faster during initial startup, then back off
    const elapsed = Date.now() - start;
    await sleep(elapsed < 2_000 ? 250 : 1_000);
  }
  return false;
}

// ---------------------------------------------------------------------------
// WebSocket heartbeat — instant Chrome death detection
// ---------------------------------------------------------------------------

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
async function startHeartbeat(target: ChromeTarget, isRearm = false): Promise<void> {
  const rt = runtime[target];
  const config = CONFIGS[target];

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
  const capturedPid = rt.proc?.pid ?? rt.adoptedPid ?? null;
  const myGeneration = ++rt.heartbeatGeneration;

  try {
    const resp = await fetch(`http://127.0.0.1:${config.port}/json/version`, {
      signal: AbortSignal.timeout(2_000),
    });
    const info = await resp.json() as { webSocketDebuggerUrl?: string };
    if (!info.webSocketDebuggerUrl) {
      reenterCooldownIfStillUp(target, isRearm, myGeneration, capturedPid);
      return;
    }

    const ws = new WebSocket(info.webSocketDebuggerUrl);

    // Re-validate staleness now that the async boundary above has passed:
    // pid unchanged, nothing else already armed a heartbeat, no newer
    // startHeartbeat/teardown superseded us (generation), and the target is
    // still chrome_up. Any mismatch means we lost the race — close what we
    // just opened and abandon without touching rt.heartbeatWs.
    const currentPid = rt.proc?.pid ?? rt.adoptedPid ?? null;
    if (
      rt.heartbeatGeneration !== myGeneration ||
      currentPid !== capturedPid ||
      rt.heartbeatWs !== null ||
      getState(target).phase !== "chrome_up"
    ) {
      log.debug(`[${target}] Heartbeat setup stale after fetch — abandoning`, {
        capturedPid,
        currentPid,
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
      const deadPid = rt.proc?.pid ?? rt.adoptedPid;
      log.warn(`[${target}] Heartbeat WebSocket closed — Chrome may be dead`, { pid: deadPid });
      rt.heartbeatWs = null;
      rt.heartbeatArmedSince = null;
      if (rt.heartbeatStableTimer) {
        clearTimeout(rt.heartbeatStableTimer);
        rt.heartbeatStableTimer = null;
      }
      // Enqueue crash detection — the queue + PID check handles staleness
      if (deadPid) {
        opQueue.enqueue(() =>
          withOpId(newOpId(), async () => {
            const currentPid = rt.proc?.pid ?? rt.adoptedPid;
            if (currentPid !== deadPid) return;
            let pidAlive = true;
            try {
              process.kill(deadPid, 0);
            } catch {
              pidAlive = false; // PID dead — proceed to crash handling
            }

            const decision = decideHeartbeatClose(pidAlive, rt.consecutiveBenignCloses);
            if (decision.action === "crash") {
              handleCrashDetected(target, "heartbeat-close-pid-dead");
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
                enterCooldown(target, deadPid);
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
              runThresholdProbe(target, deadPid, probeGeneration, closesAtProbeTime).catch((err) => {
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
              const currentPidAtRearm = rt.proc?.pid ?? rt.adoptedPid;
              if (!shouldRearmHeartbeat(currentPidAtRearm, deadPid, rt.heartbeatWs, getState(target).phase)) {
                return;
              }
              startHeartbeat(target, true);
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
    reenterCooldownIfStillUp(target, isRearm, myGeneration, capturedPid);
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
  target: ChromeTarget,
  isRearm: boolean,
  myGeneration: number,
  capturedPid: number | null,
): void {
  if (!isRearm || capturedPid === null) return;
  const rt = runtime[target];
  if (rt.heartbeatGeneration !== myGeneration) return;
  const currentPid = rt.proc?.pid ?? rt.adoptedPid ?? null;
  if (currentPid !== capturedPid) return;
  if (getState(target).phase !== "chrome_up") return;
  log.warn(`[${target}] Cooldown retry setup failed — retrying in ${HEARTBEAT_COOLDOWN_MS / 1000}s`);
  enterCooldown(target, capturedPid);
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
  target: ChromeTarget,
  deadPid: number,
  generation: number,
  closes: number,
): Promise<void> {
  const config = CONFIGS[target];
  const probe1 = await probeBrowserWs(config.port, "Browser.getVersion");
  let probe2: ProbeResult = { ok: false };
  if (!probe1.ok) {
    probe2 = await probeBrowserWs(config.port, "Target.getTargets");
  }
  const outcome = decideProbeOutcome(probe1.ok, probe2.ok);

  await opQueue.enqueue(() =>
    withOpId(newOpId(), async () => {
      const rt = runtime[target];
      const currentPid = rt.proc?.pid ?? rt.adoptedPid;
      if (
        rt.heartbeatGeneration !== generation ||
        currentPid !== deadPid ||
        getState(target).phase !== "chrome_up"
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
        handleCrashDetected(target, "ws-probe-failed");
        return;
      }

      log.warn(
        `[${target}] Browser WS probe succeeded despite ${closes} heartbeat closes — cooldown, retry in ${HEARTBEAT_COOLDOWN_MS / 1000}s`,
        { pid: deadPid },
      );
      enterCooldown(target, deadPid);
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
function enterCooldown(target: ChromeTarget, pid: number): void {
  const rt = runtime[target];
  rt.heartbeatMode = "cooldown";
  if (rt.heartbeatCooldownTimer) clearTimeout(rt.heartbeatCooldownTimer);
  rt.heartbeatCooldownTimer = setTimeout(() => {
    rt.heartbeatCooldownTimer = null;
    const currentPid = rt.proc?.pid ?? rt.adoptedPid;
    if (!shouldRearmHeartbeat(currentPid, pid, rt.heartbeatWs, getState(target).phase)) {
      return;
    }
    startHeartbeat(target, true);
  }, HEARTBEAT_COOLDOWN_MS);
}

// ---------------------------------------------------------------------------
// Crash / exit handling
// ---------------------------------------------------------------------------

/**
 * Bump backoff (double, capped at BACKOFF_MAX_MS) and arm retryNotBefore —
 * the single failure-accounting step shared by handleExit and
 * handleCrashDetected, for every policy (item 6). Previously this only
 * happened inside scheduleRestart, which on-demand targets never call, so
 * an on-demand shard's backoffMs never escalated and the corruption-recovery
 * gate in launchChrome (`rt.backoffMs >= BACKOFF_MAX_MS`) was unreachable
 * for it. handleExit and handleCrashDetected are mutually exclusive per
 * process generation (a crash-detected kill nulls rt.proc/marks non-idle
 * before its own proc.exited fires, so handleExit's idle/restartScheduled
 * guards above already no-op that call) — so this always runs exactly once
 * per death.
 */
function bumpBackoffAndRetry(rt: TargetRuntime): void {
  rt.retryNotBefore = Date.now() + rt.backoffMs;
  rt.backoffMs = Math.min(rt.backoffMs * 2, BACKOFF_MAX_MS);
}

function handleExit(target: ChromeTarget, exitCode: number | null, exitSignal: string | null = null): void {
  const rt = runtime[target];
  const state = getState(target);

  // If we already marked idle (intentional kill), ignore
  if (state.phase === "idle") return;

  // If a restart is already scheduled (e.g. from handleCrashDetected), don't double-schedule
  if (rt.restartScheduled) return;

  bumpBackoffAndRetry(rt);
  // Verbatim exit evidence (item 2) — code XOR signal, exactly as the
  // runtime reported them, never synthesized. handleExit is the ONLY writer
  // of lastExit; intentional teardowns (doKill, idle timeout, heal) never
  // reach this point because they mark idle before their exit fires, and
  // the idle guard above turns this call into a no-op for them.
  rt.lastExit = { code: exitCode, signal: exitSignal, at: Date.now() };

  // Log profile diagnostics on non-zero exit to help root-cause crashes.
  // `signal` is included whenever the OS reports one (e.g. SIGKILL): this
  // handler only ever runs for exits nobody attributed to
  // killedBy: "supervisor" above, so an exit with a signal logged here and
  // no preceding supervisor-kill log line is provably external (OOM etc.).
  const config = CONFIGS[target];
  const diag: Record<string, unknown> = { exitCode, signal: exitSignal };
  if (exitCode !== 0) {
    try {
      const lockPath = path.join(config.profilePath, "SingletonLock");
      diag.singletonLockExists = existsSync(lockPath);
      const crashpadDir = path.join(config.profilePath, "Crashpad", "reports");
      if (existsSync(crashpadDir)) {
        const reports = readdirSync(crashpadDir);
        diag.crashpadReports = reports.length;
        if (reports.length > 0) {
          const newest = reports.sort().pop();
          diag.newestCrashReport = newest;
        }
      }
    } catch {
      // Best effort diagnostics
    }
  }
  log.warn(`[${target}] Chrome exited`, diag);
  rt.proc = null;
  clearTimers(target);
  markCrashed(target, exitCode ?? -1);
  resetAuthState();

  if (CONFIGS[target].policy === "always-on") {
    scheduleRestart(target);
  } else {
    // Headed: on-demand — just mark idle, don't restart
    markIdle(target);
    log.info(`[${target}] On-demand Chrome exited — not restarting`);
  }
}

function handleCrashDetected(target: ChromeTarget, reason: DetectionReason): void {
  const rt = runtime[target];
  rt.lastDetection = { reason, at: Date.now() };
  bumpBackoffAndRetry(rt);

  // Force-kill the unresponsive process
  if (rt.proc) {
    const pid = rt.proc.pid;
    rt.proc.kill();
    rt.proc = null;
    log.info(`[${target}] Killed unresponsive Chrome (PID ${pid})`, {
      killedBy: "supervisor",
      reason,
    });
  } else if (rt.adoptedPid) {
    // Kill adopted Chrome we don't have a proc handle for
    try {
      process.kill(rt.adoptedPid, "SIGKILL");
      log.info(`[${target}] Killed adopted Chrome (PID ${rt.adoptedPid})`, {
        killedBy: "supervisor",
        reason,
      });
    } catch { /* already dead */ }
    rt.adoptedPid = null;
  }

  clearTimers(target);
  markCrashed(target, -1);
  resetAuthState();

  if (CONFIGS[target].policy === "always-on") {
    scheduleRestart(target);
  } else {
    markIdle(target);
  }
}

function scheduleRestart(target: ChromeTarget): void {
  const rt = runtime[target];
  rt.restartScheduled = true;
  // retryNotBefore was already armed by bumpBackoffAndRetry (handleExit /
  // handleCrashDetected, called just before this) — reuse it as the single
  // source of truth for "when is it safe to retry" instead of a second,
  // independently-bumped delay. backoffMs itself was already doubled by
  // that same call, for the NEXT failure's baseline.
  const delay = Math.max(0, rt.retryNotBefore - Date.now());

  log.info(`[${target}] Scheduling restart in ${delay}ms`, {
    backoffMs: rt.backoffMs,
  });

  rt.restartTimer = setTimeout(async () => {
    rt.restartTimer = null;
    try {
      await ensure(target);
    } catch (err) {
      log.error(`[${target}] Restart failed`, {
        err: String(err),
      });
    }
  }, delay);
}

// ---------------------------------------------------------------------------
// Backoff reset after stable uptime
// ---------------------------------------------------------------------------

function resetStableTimer(target: ChromeTarget): void {
  const rt = runtime[target];
  if (rt.stableTimer) clearTimeout(rt.stableTimer);

  rt.stableTimer = setTimeout(() => {
    rt.backoffMs = BACKOFF_INITIAL_MS;
    log.info(`[${target}] Stable for ${BACKOFF_STABLE_RESET_MS / 1000}s — backoff reset`);
  }, BACKOFF_STABLE_RESET_MS);
}

// ---------------------------------------------------------------------------
// Headed idle timeout
// ---------------------------------------------------------------------------

function resetIdleTimer(target: ChromeTarget): void {
  const rt = runtime[target];
  if (rt.idleTimer) clearTimeout(rt.idleTimer);

  rt.idleTimer = setTimeout(async () => {
    log.info(`[${target}] Idle timeout (${HEADED_IDLE_TIMEOUT_MS / 60_000}m) — killing`);
    await kill(target);
  }, HEADED_IDLE_TIMEOUT_MS);
}

/**
 * Bump the headed idle timer (call on any headed Chrome activity).
 */
export function touchHeaded(): void {
  const state = getState("headed");
  if (state.phase === "chrome_up") {
    resetIdleTimer("headed");
  }
}

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------

function startDashboard(): void {
  log.info("Starting dashboard", { port: DASHBOARD_PORT });

  // Kill existing dashboard process if still alive
  if (dashboardProc && dashboardProc.exitCode === null) {
    log.info("Killing existing dashboard process");
    dashboardProc.kill();
    dashboardProc = null;
  }

  try {
    dashboardProc = Bun.spawn(
      ["agent-browser", "dashboard", "start", "--port", String(DASHBOARD_PORT)],
      { stdout: "ignore", stderr: "ignore" },
    );
  } catch (err) {
    log.warn("Dashboard failed to start", { err: String(err) });
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function clearTimers(target: ChromeTarget): void {
  const rt = runtime[target];
  // Bump the heartbeat generation on every teardown so any startHeartbeat()
  // call currently blocked on its fetch/json awaits discovers, once it
  // resumes, that it's been superseded — see heartbeatGeneration's doc
  // comment on TargetRuntime and the staleness guard in startHeartbeat.
  rt.heartbeatGeneration++;
  if (rt.healthTimer) {
    clearInterval(rt.healthTimer);
    rt.healthTimer = null;
  }
  if (rt.healthSummaryTimer) {
    clearInterval(rt.healthSummaryTimer);
    rt.healthSummaryTimer = null;
  }
  if (rt.stableTimer) {
    clearTimeout(rt.stableTimer);
    rt.stableTimer = null;
  }
  if (rt.idleTimer) {
    clearTimeout(rt.idleTimer);
    rt.idleTimer = null;
  }
  if (rt.restartTimer) {
    clearTimeout(rt.restartTimer);
    rt.restartTimer = null;
  }
  if (rt.heartbeatRearmTimer) {
    clearTimeout(rt.heartbeatRearmTimer);
    rt.heartbeatRearmTimer = null;
  }
  if (rt.heartbeatStableTimer) {
    clearTimeout(rt.heartbeatStableTimer);
    rt.heartbeatStableTimer = null;
  }
  if (rt.heartbeatCooldownTimer) {
    clearTimeout(rt.heartbeatCooldownTimer);
    rt.heartbeatCooldownTimer = null;
  }
  // Close heartbeat WebSocket
  if (rt.heartbeatWs) {
    try { rt.heartbeatWs.close(); } catch { /* ignore */ }
    rt.heartbeatWs = null;
  }
  rt.heartbeatArmedSince = null;
  // Every teardown path (kill/handleCrashDetected/handleExit) routes through
  // here — no residual mode should survive a torn-down heartbeat. This is
  // what lets a stale cooldown/probing/rearming mode never block a fresh
  // startHeartbeat() call after the target comes back up.
  rt.heartbeatMode = "off";
  // Invalidate any in-flight launch promise so ensure() doesn't await a stale one
  rt.inflight = null;
}

/**
 * Reset all in-memory runtime state (timers, heartbeat WS, counters, proc
 * handles) for every target. Test-only — production code never has a
 * reason to blow away timers without also killing the underlying Chrome
 * process (use kill()/stopAll() for that). Exists so heartbeat-rearm.test.ts
 * can fully isolate its mocked WebSocket/timer state between cases without
 * waiting on real process teardown for a fake proc that was never real.
 */
export function __resetRuntimeForTest(): void {
  for (const target of ALL_TARGETS) {
    clearTimers(target);
    runtime[target] = freshRuntime();
  }
}

/**
 * Resolved profilePath for `target`, exactly as launchChrome's
 * corruption-recovery block would rmSync+mkdirSync it. Test-only — lets a
 * test assert the resolved path is under a disposable AB_PROFILE_ROOT tmp
 * dir BEFORE triggering any destructive recovery flow, instead of trusting
 * that the env override was picked up.
 */
export function __getProfilePathForTest(target: ChromeTarget): string {
  return CONFIGS[target].profilePath;
}

/**
 * Return the PID of the process listening on `port`, or null if nothing is bound.
 */
async function getListeningPid(port: number): Promise<number | null> {
  const proc = Bun.spawn(["/usr/sbin/lsof", "-i", `:${port}`, "-sTCP:LISTEN", "-t"], {
    stdout: "pipe",
    stderr: "ignore",
  });
  // Detach the exit promise so Bun reaps the child even if we don't await it
  proc.exited.catch(() => {});
  const timer = setTimeout(() => proc.kill(), 5_000);
  try {
    const raw = await new Response(proc.stdout).text();
    const trimmed = raw.trim();
    if (!trimmed) return null;
    const pid = parseInt(trimmed, 10);
    return Number.isNaN(pid) ? null : pid;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Agent-browser session cleanup (for heal)
// ---------------------------------------------------------------------------

const AB_HOME = path.join(process.env.HOME ?? "", ".agent-browser");

/**
 * Clean up agent-browser daemon sessions without using `agent-browser close`.
 *
 * `agent-browser close --all` launches Chrome via the profile, which conflicts
 * with the daemon's managed Chrome. For --cdp sessions, close doesn't need
 * Chrome at all — we just need to kill the daemon PIDs and clean sidecar files.
 */
export async function cleanAgentBrowserSessions(): Promise<string[]> {
  const fs = await import("fs");
  const actions: string[] = [];

  // Find all ab-*.pid files
  let pidFiles: string[];
  try {
    const entries = fs.readdirSync(AB_HOME);
    pidFiles = entries.filter((f: string) =>
      f.startsWith("ab-") && f.endsWith(".pid") && f !== "ab-server.pid",
    );
  } catch {
    actions.push("no ~/.agent-browser directory");
    return actions;
  }

  // Kill each daemon PID
  const signaledPids: number[] = [];
  for (const pidFile of pidFiles) {
    const pidPath = path.join(AB_HOME, pidFile);
    try {
      const raw = fs.readFileSync(pidPath, "utf-8").trim();
      const pid = parseInt(raw, 10);
      if (!Number.isNaN(pid)) {
        try {
          process.kill(pid, "SIGTERM");
          signaledPids.push(pid);
          actions.push(`sent SIGTERM to PID ${pid} (${pidFile})`);
        } catch {
          actions.push(`PID ${pid} already dead (${pidFile})`);
        }
      }
    } catch {
      // File unreadable — will be cleaned up below
    }
  }

  // Wait for signaled PIDs to exit (up to 2s), then escalate to SIGKILL
  if (signaledPids.length > 0) {
    const alive = new Set(signaledPids);
    const deadline = Date.now() + 2_000;
    while (alive.size > 0 && Date.now() < deadline) {
      for (const pid of [...alive]) {
        try {
          process.kill(pid, 0);
        } catch {
          alive.delete(pid);
        }
      }
      if (alive.size > 0) await sleep(100);
    }
    for (const pid of alive) {
      try {
        process.kill(pid, "SIGKILL");
        actions.push(`escalated to SIGKILL for PID ${pid}`);
      } catch { /* already dead */ }
    }
  }

  // Clean up sidecar files (.pid, .sock, .stream, .engine)
  const sidecarExtensions = [".pid", ".sock", ".stream", ".engine"];
  try {
    const entries = fs.readdirSync(AB_HOME);
    for (const entry of entries) {
      if (!entry.startsWith("ab-")) continue;
      if (entry === "ab-server.sock" || entry === "ab-server.pid") continue; // Never touch daemon's own files
      if (!sidecarExtensions.some((ext) => entry.endsWith(ext))) continue;
      const fullPath = path.join(AB_HOME, entry);
      try {
        fs.unlinkSync(fullPath);
        actions.push(`removed ${entry}`);
      } catch {
        // Ignore — file may have been removed already
      }
    }
  } catch {
    // Directory read failed — already handled above
  }

  if (actions.length === 0) {
    actions.push("no agent-browser sessions to clean");
  }

  return actions;
}
