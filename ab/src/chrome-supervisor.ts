/**
 * Chrome process supervisor for the ab-server daemon.
 *
 * Manages Chrome lifecycle (launch, health-check, restart, idle-kill)
 * for both headless and headed targets. All launch/kill operations are
 * serialized through an async queue so concurrent callers share results.
 */

import * as path from "path";
import { existsSync, unlinkSync, rmSync, mkdirSync, readdirSync } from "fs";
import type { ChromeConfig, ChromeTarget } from "./types";
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
];

const CONFIGS: Record<ChromeTarget, ChromeConfig> = {
  headless: {
    target: "headless",
    port: 9333,
    profilePath: `${process.env.HOME}/.agent-browser/profile`,
    launchArgs: ["--headless=new", ...SHARED_LAUNCH_ARGS],
    policy: "always-on",
  },
  headed: {
    target: "headed",
    port: 9444,
    profilePath: `${process.env.HOME}/.agent-browser/profile-headed`,
    launchArgs: [...SHARED_LAUNCH_ARGS],
    policy: "on-demand",
  },
};

const DASHBOARD_PORT = 4848;

let dashboardProc: ReturnType<typeof Bun.spawn> | null = null;

// Health check tuning
const HEALTH_INTERVAL_MS = 5_000;
const HEALTH_TIMEOUT_MS = 2_000;
const HEALTH_FAILURE_THRESHOLD = 3;

// Backoff tuning
const BACKOFF_INITIAL_MS = 1_000;
const BACKOFF_MAX_MS = 30_000;
const BACKOFF_STABLE_RESET_MS = 60_000;

// Headed idle timeout
const HEADED_IDLE_TIMEOUT_MS = 10 * 60_000; // 10 minutes

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
}

const runtime: Record<ChromeTarget, TargetRuntime> = {
  headless: freshRuntime(),
  headed: freshRuntime(),
};

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
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Ensure Chrome is running for `target`. If already up, returns immediately.
 * Serialized through the operation queue — concurrent calls wait their turn.
 */
export async function ensure(
  target: ChromeTarget,
): Promise<{ pid: number; port: number; alreadyRunning: boolean }> {
  return opQueue.enqueue(() =>
    withOpId(newOpId(), async () => {
      // Check if already up FIRST (fast path, no launch needed)
      const state = getState(target);
      if (state.phase === "chrome_up") {
        return { pid: state.pid, port: state.port, alreadyRunning: true };
      }
      const result = await launchChrome(target);
      return { ...result, alreadyRunning: false };
    }),
  ) as Promise<{ pid: number; port: number; alreadyRunning: boolean }>;
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
    log.info(`[${target}] Killing Chrome (PID ${proc.pid})`);
    proc.kill();
    // Wait for process exit (up to 5s)
    await Promise.race([proc.exited, sleep(5_000)]);
    // If Chrome didn't exit gracefully, escalate to SIGKILL
    if (proc.exitCode === null) {
      log.warn(`[${target}] Chrome did not exit gracefully — sending SIGKILL`);
      proc.kill(9); // SIGKILL
      await Promise.race([proc.exited, sleep(2_000)]);
    }
    rt.proc = null;
  } else if (rt.adoptedPid) {
    // Kill adopted Chrome we don't have a proc handle for
    log.info(`[${target}] Killing adopted Chrome (PID ${rt.adoptedPid})`);
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
 * Launches headless Chrome, starts health checks, then launches the dashboard.
 */
export async function startSupervision(): Promise<void> {
  return opQueue.enqueue(() =>
    withOpId(newOpId(), async () => {
      if (process.platform !== "darwin") {
        log.error("ab-server only supports macOS");
        throw new Error("Unsupported platform: " + process.platform);
      }
      log.info("Starting Chrome supervision");
      const state = getState("headless");
      if (state.phase !== "chrome_up") {
        await launchChrome("headless");
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
      await Promise.all([doKill("headless"), doKill("headed")]);
    }),
  ) as Promise<void>;
}

// ---------------------------------------------------------------------------
// Chrome launch
// ---------------------------------------------------------------------------

async function launchChrome(
  target: ChromeTarget,
): Promise<{ pid: number; port: number }> {
  const config = CONFIGS[target];
  const rt = runtime[target];

  rt.restartScheduled = false;
  markLaunching(target);

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
      return { pid, port: config.port };
    }
  } else if (inCrashLoop && existingCdp) {
    // In a crash loop — don't adopt, kill the occupant so we go through
    // the full recovery path (profile nuke below).
    const stalePid = await getListeningPid(config.port);
    if (stalePid) {
      log.warn(`[${target}] Crash loop — killing existing Chrome (PID ${stalePid}) instead of adopting`);
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
      log.warn(`[${target}] Port ${config.port} occupied by unresponsive PID ${stalePid} — killing`);
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
    try {
      rmSync(config.profilePath, { recursive: true, force: true });
      mkdirSync(config.profilePath, { recursive: true });
      rt.backoffMs = BACKOFF_INITIAL_MS;
    } catch (err) {
      log.error(`[${target}] Failed to reset profile`, { err: String(err) });
    }
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
    opQueue.enqueue(() =>
      withOpId(newOpId(), async () => {
        // If a different Chrome is now running, this exit is stale
        const currentPid = rt.proc?.pid ?? rt.adoptedPid;
        if (currentPid !== exitedPid && getState(target).phase !== "idle") {
          log.info(`[${target}] Ignoring stale exit for PID ${exitedPid}`);
          return;
        }
        handleExit(target, exitCode ?? 1);
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
  return { pid: proc.pid, port: config.port };
}

// ---------------------------------------------------------------------------
// Health checking
// ---------------------------------------------------------------------------

function startHealthCheck(target: ChromeTarget): void {
  const rt = runtime[target];
  const config = CONFIGS[target];

  // Clear any existing timer
  if (rt.healthTimer) clearInterval(rt.healthTimer);

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

async function startHeartbeat(target: ChromeTarget): Promise<void> {
  const rt = runtime[target];
  const config = CONFIGS[target];

  // Close existing heartbeat if any
  if (rt.heartbeatWs) {
    try { rt.heartbeatWs.close(); } catch { /* ignore */ }
    rt.heartbeatWs = null;
  }

  try {
    const resp = await fetch(`http://127.0.0.1:${config.port}/json/version`, {
      signal: AbortSignal.timeout(2_000),
    });
    const info = await resp.json() as { webSocketDebuggerUrl?: string };
    if (!info.webSocketDebuggerUrl) return;

    const ws = new WebSocket(info.webSocketDebuggerUrl);
    rt.heartbeatWs = ws;

    ws.onclose = () => {
      if (rt.heartbeatWs !== ws) return; // Stale — we've moved on
      const deadPid = rt.proc?.pid ?? rt.adoptedPid;
      log.warn(`[${target}] Heartbeat WebSocket closed — Chrome may be dead`, { pid: deadPid });
      rt.heartbeatWs = null;
      // Enqueue crash detection — the queue + PID check handles staleness
      if (deadPid) {
        opQueue.enqueue(() =>
          withOpId(newOpId(), async () => {
            const currentPid = rt.proc?.pid ?? rt.adoptedPid;
            if (currentPid !== deadPid) return;
            // Verify Chrome is actually dead before marking crashed
            try {
              process.kill(deadPid, 0);
              return; // Still alive — WebSocket close was benign
            } catch { /* PID dead — proceed to crash handling */ }
            handleCrashDetected(target);
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

function handleExit(target: ChromeTarget, exitCode: number): void {
  const rt = runtime[target];
  const state = getState(target);

  // If we already marked idle (intentional kill), ignore
  if (state.phase === "idle") return;

  // If a restart is already scheduled (e.g. from handleCrashDetected), don't double-schedule
  if (rt.restartScheduled) return;

  // Log profile diagnostics on non-zero exit to help root-cause crashes
  const config = CONFIGS[target];
  const diag: Record<string, unknown> = { exitCode };
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
    rt.proc.kill();
    rt.proc = null;
  } else if (rt.adoptedPid) {
    // Kill adopted Chrome we don't have a proc handle for
    try {
      process.kill(rt.adoptedPid, "SIGKILL");
      log.info(`[${target}] Killed adopted Chrome (PID ${rt.adoptedPid})`);
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
  if (rt.healthTimer) {
    clearInterval(rt.healthTimer);
    rt.healthTimer = null;
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
  // Close heartbeat WebSocket
  if (rt.heartbeatWs) {
    try { rt.heartbeatWs.close(); } catch { /* ignore */ }
    rt.heartbeatWs = null;
  }
  // Invalidate any in-flight launch promise so ensure() doesn't await a stale one
  rt.inflight = null;
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
