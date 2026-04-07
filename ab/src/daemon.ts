/**
 * ab-server daemon entry point.
 *
 * Initializes the Unix socket server and Chrome supervisor.
 * Handles graceful shutdown on SIGTERM/SIGINT.
 *
 * Exit conditions:
 *   - SIGTERM / SIGINT (graceful shutdown)
 *   - Unrecoverable socket bind error
 * The daemon survives Chrome crashes — the supervisor handles restarts.
 */

import * as fs from "fs";
import * as net from "net";
import { SOCKET_PATH, startServer, type AbServer } from "./server";
import * as supervisor from "./chrome-supervisor";
import { Logger } from "./logger";

const log = new Logger({ component: "daemon" });

// ---------------------------------------------------------------------------
// Live-daemon detection
// ---------------------------------------------------------------------------

function isSocketAlive(): Promise<boolean> {
  return new Promise((resolve) => {
    if (!fs.existsSync(SOCKET_PATH)) {
      resolve(false);
      return;
    }
    const client = net.createConnection({ path: SOCKET_PATH }, () => {
      // Connected — a live daemon owns this socket
      client.destroy();
      resolve(true);
    });
    client.on("error", () => {
      // Connection refused or broken pipe — socket is stale
      resolve(false);
    });
    // Don't hang forever
    client.setTimeout(1000, () => {
      client.destroy();
      resolve(false);
    });
  });
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
// Shutdown
// ---------------------------------------------------------------------------

let shuttingDown = false;

async function shutdown(signal: string, server: AbServer): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;

  log.info(`Received ${signal} — shutting down`);

  // 1. Stop accepting new requests
  server.stop();

  // 2. Kill all Chrome processes
  await supervisor.stopAll();

  // 3. Clean up socket file
  try {
    fs.unlinkSync(SOCKET_PATH);
    log.info("Cleaned up socket file");
  } catch {
    // Already gone — fine
  }

  log.info("Daemon shutdown complete");
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  log.info("ab-server daemon starting", { pid: process.pid });

  // Prepare socket
  ensureSocketDir();

  // Guard: don't stomp a live daemon's socket
  if (await isSocketAlive()) {
    log.error("Another ab-server daemon is already running — refusing to start", {
      socket: SOCKET_PATH,
    });
    process.exit(1);
  }

  cleanStaleSocket();

  // Start HTTP server on Unix socket
  let server: AbServer;
  try {
    server = startServer();
  } catch (err) {
    log.error("Failed to bind socket — exiting", {
      err: String(err),
      path: SOCKET_PATH,
    });
    process.exit(1);
  }

  // Register signal handlers
  process.on("SIGTERM", () => shutdown("SIGTERM", server));
  process.on("SIGINT", () => shutdown("SIGINT", server));

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
