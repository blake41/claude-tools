/**
 * Chrome process supervisor for the ab-server daemon.
 *
 * Manages Chrome lifecycle (launch, health-check, restart, idle-kill)
 * for both headless and headed targets. All launch/kill operations are
 * serialized through an async queue so concurrent callers share results.
 */

import * as path from "path";
import type { ChromeConfig, ChromeTarget } from "./types";
import {
  getState,
  markLaunching,
  markUp,
  markCrashed,
  markIdle,
} from "./state";
import { Logger } from "./logger";
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
// Per-target runtime state (not persisted — lives in-process only)
// ---------------------------------------------------------------------------

interface TargetRuntime {
  proc: ReturnType<typeof Bun.spawn> | null;
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
}

const runtime: Record<ChromeTarget, TargetRuntime> = {
  headless: freshRuntime(),
  headed: freshRuntime(),
};

function freshRuntime(): TargetRuntime {
  return {
    proc: null,
    healthTimer: null,
    consecutiveFailures: 0,
    backoffMs: BACKOFF_INITIAL_MS,
    stableTimer: null,
    idleTimer: null,
    restartTimer: null,
    restartScheduled: false,
    inflight: null,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Ensure Chrome is running for `target`. If already up, returns immediately.
 * Concurrent calls coalesce — only one launch happens.
 */
export async function ensure(
  target: ChromeTarget,
): Promise<{ pid: number; port: number; alreadyRunning: boolean }> {
  const state = getState(target);
  if (state.phase === "chrome_up") {
    return { pid: state.pid, port: state.port, alreadyRunning: true };
  }

  // Coalesce concurrent calls
  const rt = runtime[target];
  if (rt.inflight) {
    const result = await rt.inflight;
    // Re-verify Chrome is still up (could have been healed/killed while waiting)
    const freshState = getState(target);
    if (freshState.phase === "chrome_up") {
      return { ...result, alreadyRunning: true };
    }
    // Chrome died while we were waiting — fall through to launch a new one
  }

  const promise = launchChrome(target);
  rt.inflight = promise;

  try {
    const result = await promise;
    return { ...result, alreadyRunning: false };
  } finally {
    rt.inflight = null;
  }
}

/**
 * Kill Chrome for a target. Cleans up health timers and idle timers.
 */
export async function kill(target: ChromeTarget): Promise<void> {
  const rt = runtime[target];
  clearTimers(target);

  if (rt.proc) {
    log.info(`[${target}] Killing Chrome (PID ${rt.proc.pid})`);
    rt.proc.kill();
    // Wait for process exit (up to 5s)
    await Promise.race([rt.proc.exited, sleep(5_000)]);
    rt.proc = null;
  }

  markIdle(target);
}

/**
 * Start the daemon's always-on supervision. Call once at daemon boot.
 * Launches headless Chrome, starts health checks, then launches the dashboard.
 */
export async function startSupervision(): Promise<void> {
  if (process.platform !== "darwin") {
    log.error("ab-server only supports macOS (Chrome path is macOS-specific)");
    throw new Error("Unsupported platform: " + process.platform);
  }

  log.info("Starting Chrome supervision");

  // Launch headless (always-on)
  await ensure("headless");

  // Start dashboard after headless is confirmed up
  startDashboard();

  log.info("Chrome supervision active");
}

/**
 * Teardown all supervised Chrome instances. Call on daemon shutdown.
 */
export async function stopAll(): Promise<void> {
  log.info("Stopping all Chrome instances");

  // Kill dashboard process if alive
  if (dashboardProc && dashboardProc.exitCode === null) {
    log.info("Killing dashboard process");
    dashboardProc.kill();
    dashboardProc = null;
  }

  await Promise.all([kill("headless"), kill("headed")]);
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
  const existingCdp = await checkCdp(config.port);
  if (existingCdp) {
    // A responsive CDP is already on our port — adopt it instead of launching.
    const pid = getListeningPid(config.port);
    if (pid) {
      log.info(`[${target}] Adopting existing Chrome on port ${config.port}`, { pid });
      rt.proc = null; // We don't own the process handle
      markUp(target, pid, config.port);
      startHealthCheck(target);
      resetStableTimer(target);
      if (target === "headed") resetIdleTimer(target);
      return { pid, port: config.port };
    }
  } else {
    // Port might be bound by a non-responsive process — kill the occupant.
    const stalePid = getListeningPid(config.port);
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
        if (!getListeningPid(config.port)) break;
        await sleep(200);
      }
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
    stderr: "ignore",
  });

  rt.proc = proc;

  // Watch for unexpected exit
  proc.exited.then((exitCode) => {
    handleExit(target, exitCode ?? 1);
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
        handleCrashDetected(target);
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
// Crash / exit handling
// ---------------------------------------------------------------------------

function handleExit(target: ChromeTarget, exitCode: number): void {
  const rt = runtime[target];
  const state = getState(target);

  // If we already marked idle (intentional kill), ignore
  if (state.phase === "idle") return;

  // If a restart is already scheduled (e.g. from handleCrashDetected), don't double-schedule
  if (rt.restartScheduled) return;

  log.warn(`[${target}] Chrome exited`, { exitCode });
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
}

/**
 * Return the PID of the process listening on `port`, or null if nothing is bound.
 */
function getListeningPid(port: number): number | null {
  const result = Bun.spawnSync(["/usr/sbin/lsof", "-i", `:${port}`, "-sTCP:LISTEN", "-t"]);
  const raw = result.stdout.toString().trim();
  if (!raw) return null;
  const pid = parseInt(raw, 10);
  return Number.isNaN(pid) ? null : pid;
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
    pidFiles = entries.filter((f: string) => f.startsWith("ab-") && f.endsWith(".pid"));
  } catch {
    actions.push("no ~/.agent-browser directory");
    return actions;
  }

  // Kill each daemon PID
  for (const pidFile of pidFiles) {
    const pidPath = path.join(AB_HOME, pidFile);
    try {
      const raw = fs.readFileSync(pidPath, "utf-8").trim();
      const pid = parseInt(raw, 10);
      if (!Number.isNaN(pid)) {
        try {
          process.kill(pid, "SIGTERM");
          actions.push(`killed PID ${pid} (${pidFile})`);
        } catch {
          actions.push(`PID ${pid} already dead (${pidFile})`);
        }
      }
    } catch {
      // File unreadable — will be cleaned up below
    }
  }

  // Clean up sidecar files (.pid, .sock, .stream, .engine)
  const sidecarExtensions = [".pid", ".sock", ".stream", ".engine"];
  try {
    const entries = fs.readdirSync(AB_HOME);
    for (const entry of entries) {
      if (!entry.startsWith("ab-")) continue;
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
