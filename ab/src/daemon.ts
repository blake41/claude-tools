/**
 * ab-server daemon entry point.
 *
 * Initializes the Unix socket server and Chrome supervisor.
 * Handles graceful shutdown on SIGTERM/SIGINT.
 *
 * Exit conditions:
 *   - SIGTERM / SIGINT (graceful shutdown)
 *   - Unrecoverable socket bind error
 *   - Self-watchdog: 3 consecutive failed health checks (socket unresponsive)
 * The daemon survives Chrome crashes — the supervisor handles restarts.
 */

import * as fs from "fs";
import * as path from "path";
import { SOCKET_PATH, startServer, type AbServer } from "./server";
import * as supervisor from "./chrome-supervisor";
import { Logger } from "./logger";

const log = new Logger({ component: "daemon" });

/** PID lockfile — prevents TOCTOU race in daemon detection */
const LOCK_PATH = path.join(
  SOCKET_PATH.substring(0, SOCKET_PATH.lastIndexOf("/")),
  "ab-server.pid",
);

// ---------------------------------------------------------------------------
// PID lockfile-based daemon detection
// ---------------------------------------------------------------------------

/**
 * Atomically claim the PID lockfile using O_CREAT|O_EXCL (via 'wx' flag).
 * Returns true if we own the lock, false if another live daemon does.
 */
function claimLockfile(): boolean {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const fd = fs.openSync(LOCK_PATH, "wx");
      fs.writeSync(fd, String(process.pid));
      fs.closeSync(fd);
      return true;
    } catch (err: unknown) {
      const code = err instanceof Error && "code" in err
        ? (err as NodeJS.ErrnoException).code
        : null;
      if (code !== "EEXIST") throw err;

      // File exists — check if the owning PID is alive
      try {
        const raw = fs.readFileSync(LOCK_PATH, "utf-8").trim();
        const pid = parseInt(raw, 10);
        if (!Number.isNaN(pid)) {
          try {
            process.kill(pid, 0);
            return false; // PID alive — another daemon owns it
          } catch { /* PID dead — fall through to remove */ }
        }
      } catch { /* unreadable — fall through to remove */ }

      // Stale lockfile — remove and retry
      try { fs.unlinkSync(LOCK_PATH); } catch { /* already gone */ }
    }
  }
  return false; // Exhausted retries — assume contention
}

function writeLockfile(): void {
  fs.writeFileSync(LOCK_PATH, String(process.pid), "utf-8");
}

function removeLockfile(): void {
  try {
    fs.unlinkSync(LOCK_PATH);
  } catch {
    // Already gone — fine
  }
}

// ---------------------------------------------------------------------------
// Stale socket cleanup
// ---------------------------------------------------------------------------

function cleanStaleSocket(): void {
  try {
    fs.unlinkSync(SOCKET_PATH);
    log.info("Removed stale socket file", { path: SOCKET_PATH });
  } catch (err: unknown) {
    // ENOENT is fine — no stale socket to clean
    if (err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code !== "ENOENT") {
      throw err;
    }
  }
}

// ---------------------------------------------------------------------------
// Ensure socket directory exists
// ---------------------------------------------------------------------------

function ensureSocketDir(): void {
  const dir = SOCKET_PATH.substring(0, SOCKET_PATH.lastIndexOf("/"));
  fs.mkdirSync(dir, { recursive: true });
}

// ---------------------------------------------------------------------------
// Self-watchdog
// ---------------------------------------------------------------------------

const WATCHDOG_INTERVAL_MS = 30_000;
const WATCHDOG_MAX_FAILURES = 3;
const WATCHDOG_FETCH_TIMEOUT_MS = 5_000;

let watchdogTimer: ReturnType<typeof setInterval> | null = null;
let watchdogFailures = 0;

function startWatchdog(): void {
  watchdogTimer = setInterval(async () => {
    if (shuttingDown) return;

    // Invariant 5: single-daemon — verify we still own the lockfile
    try {
      const raw = fs.readFileSync(LOCK_PATH, "utf-8").trim();
      const lockPid = parseInt(raw, 10);
      if (!Number.isNaN(lockPid) && lockPid !== process.pid) {
        log.error("PID lockfile mismatch — another daemon owns the lock, exiting", {
          ourPid: process.pid,
          lockPid,
        });
        process.exit(1);
      }
    } catch {
      // Lockfile gone — re-claim it
      writeLockfile();
    }

    // Invariant 3: socket existence — re-create if deleted by external tool
    if (!fs.existsSync(SOCKET_PATH)) {
      log.error("Socket file disappeared — re-creating", { path: SOCKET_PATH });
      try {
        currentServer?.stop();
        currentServer = startServer();
        watchdogFailures = 0;
        log.info("Socket re-created successfully");
        return; // Skip fetch this tick — socket just re-created
      } catch (err) {
        log.error("Failed to re-create socket — exiting for launchd restart", {
          err: String(err),
        });
        process.exit(1);
      }
    }

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), WATCHDOG_FETCH_TIMEOUT_MS);

      const res = await fetch("http://localhost/health", {
        unix: SOCKET_PATH,
        signal: controller.signal,
      } as RequestInit);

      clearTimeout(timeout);

      if (res.ok) {
        if (watchdogFailures > 0) {
          log.info("Watchdog: socket recovered", { previousFailures: watchdogFailures });
        }
        watchdogFailures = 0;
        return;
      }

      watchdogFailures++;
      log.warn("Watchdog: health check returned non-OK", {
        status: res.status,
        consecutive: watchdogFailures,
      });
    } catch (err) {
      watchdogFailures++;
      log.warn("Watchdog: health check failed", {
        err: String(err),
        consecutive: watchdogFailures,
      });
    }

    if (watchdogFailures >= WATCHDOG_MAX_FAILURES) {
      log.error("Watchdog: socket unresponsive after consecutive failures — exiting for launchd restart", {
        failures: watchdogFailures,
      });
      process.exit(1);
    }
  }, WATCHDOG_INTERVAL_MS);

  // Don't let the watchdog timer keep the process alive during shutdown
  if (typeof watchdogTimer === "object" && "unref" in watchdogTimer) {
    (watchdogTimer as NodeJS.Timeout).unref();
  }

  log.info("Watchdog started", {
    intervalMs: WATCHDOG_INTERVAL_MS,
    maxFailures: WATCHDOG_MAX_FAILURES,
  });
}

// ---------------------------------------------------------------------------
// Shutdown
// ---------------------------------------------------------------------------

let shuttingDown = false;
let currentServer: AbServer | null = null;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;

  // Stop the watchdog so it doesn't fire during teardown
  if (watchdogTimer) {
    clearInterval(watchdogTimer);
    watchdogTimer = null;
  }

  log.info(`Received ${signal} — shutting down`);

  // 1. Stop accepting new requests
  currentServer?.stop();

  // 2. Kill all Chrome processes
  await supervisor.stopAll();

  // 3. Clean up socket file and lockfile
  try {
    fs.unlinkSync(SOCKET_PATH);
    log.info("Cleaned up socket file");
  } catch {
    // Already gone — fine
  }
  removeLockfile();

  log.info("Daemon shutdown complete");
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Event loop lag monitor (Invariant 6)
// ---------------------------------------------------------------------------

function startEventLoopMonitor(): void {
  let lastTick = Date.now();
  const timer = setInterval(() => {
    const now = Date.now();
    const lag = now - lastTick - 1000;
    if (lag > 60_000) {
      // System likely slept — don't alarm, just note it
      log.info("Woke from system sleep", { lagMs: lag });
    } else if (lag > 2000) {
      log.warn("Event loop blocked", { lagMs: lag });
    }
    lastTick = now;
  }, 1000);
  if (typeof timer === "object" && "unref" in timer) {
    (timer as NodeJS.Timeout).unref();
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  log.info("ab-server daemon starting", { pid: process.pid });

  // Prepare socket
  ensureSocketDir();

  // Atomically claim PID lockfile (O_EXCL prevents TOCTOU race)
  if (!claimLockfile()) {
    log.error("Another ab-server daemon is already running — refusing to start", {
      socket: SOCKET_PATH,
      lockfile: LOCK_PATH,
    });
    process.exit(1);
  }
  cleanStaleSocket();

  // Start HTTP server on Unix socket
  try {
    currentServer = startServer();
  } catch (err) {
    log.error("Failed to bind socket — exiting", {
      err: String(err),
      path: SOCKET_PATH,
    });
    process.exit(1);
  }

  // Register signal handlers
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  // Start self-watchdog (detects unresponsive socket handler)
  startWatchdog();

  // Start event loop lag monitor (Invariant 6)
  startEventLoopMonitor();

  // Start Chrome supervision (launches headless Chrome)
  try {
    await supervisor.startSupervision();
    log.info("Daemon ready", { socket: SOCKET_PATH });
  } catch (err) {
    log.error("Chrome supervision failed to start", { err: String(err) });
    // Don't exit — the daemon stays up. Supervisor will retry via backoff.
    log.warn("Daemon running without Chrome — supervisor will retry");
  }
}

main().catch((err) => {
  log.error("Unhandled error in daemon main", { err: String(err) });
  process.exit(1);
});
