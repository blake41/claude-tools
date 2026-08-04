/**
 * Chrome process supervisor for the ab-server daemon.
 *
 * Manages Chrome lifecycle (launch, health-check, restart, idle-kill)
 * for both headless and headed targets. All launch/kill operations are
 * serialized through an async queue so concurrent callers share results.
 */

import * as path from "path";
import { existsSync, unlinkSync, rmSync, mkdirSync, readdirSync } from "fs";
import type { ChromeConfig, ChromeTarget, ShardDiagnostics } from "./types";
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

function buildConfigs(): Record<ChromeTarget, ChromeConfig> {
  const configs: Record<ChromeTarget, ChromeConfig> = {
    headed: {
      target: "headed",
      port: 9444,
      profilePath: `${process.env.HOME}/.agent-browser/profile-headed`,
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
          ? `${process.env.HOME}/.agent-browser/profile`
          : `${process.env.HOME}/.agent-browser/profile-${i}`,
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

// Backoff tuning
const BACKOFF_INITIAL_MS = 1_000;
const BACKOFF_MAX_MS = 30_000;
const BACKOFF_STABLE_RESET_MS = 60_000;

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
}

/**
 * Pure builder for the periodic per-target health summary log line. Exported
 * for direct unit testing — same rationale as isProfileDirMissing /
 * decideHeartbeatClose: keep the file's timer/process-heavy code as thin
 * wiring around small pure functions.
 */
export function buildHealthSummaryPayload(
  target: ChromeTarget,
  phase: string,
  pid: number | null,
  heartbeatArmed: boolean,
  heartbeatArmedSince: number | null,
  consecutiveFailures: number,
  lastHealthOkAt: number | null,
): HealthSummaryPayload {
  return {
    target,
    phase,
    pid,
    heartbeatArmed,
    heartbeatArmedSinceIso: heartbeatArmedSince !== null ? new Date(heartbeatArmedSince).toISOString() : null,
    consecutiveFailures,
    lastHealthOkAtIso: lastHealthOkAt !== null ? new Date(lastHealthOkAt).toISOString() : null,
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
export async function startSupervision(): Promise<void> {
  return opQueue.enqueue(() =>
    withOpId(newOpId(), async () => {
      if (process.platform !== "darwin") {
        log.error("ab-server only supports macOS");
        throw new Error("Unsupported platform: " + process.platform);
      }
      log.info("Starting Chrome supervision");
      for (const target of ALL_TARGETS) {
        if (CONFIGS[target].policy !== "always-on") continue;
        const state = getState(target);
        if (state.phase !== "chrome_up") {
          await launchChrome(target);
        }
      }
      startDashboard();
      log.info("Chrome supervision active");
    }),
  ) as Promise<void>;
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

async function launchChrome(
  target: ChromeTarget,
): Promise<{ pid: number; port: number; profileFresh: boolean }> {
  const config = CONFIGS[target];
  const rt = runtime[target];

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
  proc.exited.then((exitCode) => {
    const exitedPid = proc.pid;
    // Captured now, before Bun reaps the handle — lets handleExit log
    // whether the OS delivered a signal (e.g. exit 137 from SIGKILL), so an
    // exit with NO preceding "killedBy: supervisor" log line is provably
    // external (OOM etc.) rather than an ambiguous crash.
    const exitSignal = proc.signalCode ?? null;
    opQueue.enqueue(() =>
      withOpId(newOpId(), async () => {
        // If a different Chrome is now running, this exit is stale
        const currentPid = rt.proc?.pid ?? rt.adoptedPid;
        if (currentPid !== exitedPid && getState(target).phase !== "idle") {
          log.info(`[${target}] Ignoring stale exit for PID ${exitedPid}`);
          return;
        }
        handleExit(target, exitCode ?? 1, exitSignal);
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
              handleCrashDetected(target);
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
            handleCrashDetected(target);
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
 *   close in a row, in which case give up and fall back to polling-only
 *   (the same degraded mode as a heartbeat setup failure).
 */
export type HeartbeatCloseDecision =
  | { action: "crash" }
  | { action: "rearm"; nextConsecutiveBenignCloses: number }
  | { action: "fallback-to-polling"; consecutiveBenignCloses: number };

export function decideHeartbeatClose(
  pidAlive: boolean,
  consecutiveBenignCloses: number,
  threshold: number = HEARTBEAT_BENIGN_CLOSE_THRESHOLD,
): HeartbeatCloseDecision {
  if (!pidAlive) return { action: "crash" };
  const next = consecutiveBenignCloses + 1;
  if (next >= threshold) {
    return { action: "fallback-to-polling", consecutiveBenignCloses: next };
  }
  return { action: "rearm", nextConsecutiveBenignCloses: next };
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
    if (!info.webSocketDebuggerUrl) return;

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
              handleCrashDetected(target);
              return;
            }
            if (decision.action === "fallback-to-polling") {
              rt.consecutiveBenignCloses = decision.consecutiveBenignCloses;
              log.warn(
                `[${target}] ${decision.consecutiveBenignCloses} rapid benign heartbeat closes — falling back to polling-only`,
                { pid: deadPid },
              );
              return;
            }

            // action === "rearm" — still alive, WebSocket close was benign.
            // Re-arm after a short delay so a wedged Chrome that closes the
            // WS immediately again doesn't spin in a tight loop.
            rt.consecutiveBenignCloses = decision.nextConsecutiveBenignCloses;
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
  }
}

// ---------------------------------------------------------------------------
// Crash / exit handling
// ---------------------------------------------------------------------------

function handleExit(target: ChromeTarget, exitCode: number, exitSignal: string | null = null): void {
  const rt = runtime[target];
  const state = getState(target);

  // If we already marked idle (intentional kill), ignore
  if (state.phase === "idle") return;

  // If a restart is already scheduled (e.g. from handleCrashDetected), don't double-schedule
  if (rt.restartScheduled) return;

  // Log profile diagnostics on non-zero exit to help root-cause crashes.
  // `signal` is included whenever the OS reports one (e.g. SIGKILL -> 137):
  // this handler only ever runs for exits nobody attributed to
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
  markCrashed(target, exitCode);
  resetAuthState();

  if (CONFIGS[target].policy === "always-on") {
    scheduleRestart(target);
  } else {
    // Headed: on-demand — just mark idle, don't restart
    markIdle(target);
    log.info(`[${target}] On-demand Chrome exited — not restarting`);
  }
}

function handleCrashDetected(target: ChromeTarget): void {
  const rt = runtime[target];

  // Force-kill the unresponsive process
  if (rt.proc) {
    const pid = rt.proc.pid;
    rt.proc.kill();
    rt.proc = null;
    log.info(`[${target}] Killed unresponsive Chrome (PID ${pid})`, {
      killedBy: "supervisor",
      reason: "crash-detected",
    });
  } else if (rt.adoptedPid) {
    // Kill adopted Chrome we don't have a proc handle for
    try {
      process.kill(rt.adoptedPid, "SIGKILL");
      log.info(`[${target}] Killed adopted Chrome (PID ${rt.adoptedPid})`, {
        killedBy: "supervisor",
        reason: "crash-detected",
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
  const delay = rt.backoffMs;

  log.info(`[${target}] Scheduling restart in ${delay}ms`, {
    backoffMs: delay,
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

  // Exponential backoff: 1s → 2s → 4s → ... → 30s max
  rt.backoffMs = Math.min(rt.backoffMs * 2, BACKOFF_MAX_MS);
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
  // Close heartbeat WebSocket
  if (rt.heartbeatWs) {
    try { rt.heartbeatWs.close(); } catch { /* ignore */ }
    rt.heartbeatWs = null;
  }
  rt.heartbeatArmedSince = null;
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
