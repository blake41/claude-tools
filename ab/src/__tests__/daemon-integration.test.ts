/**
 * Daemon integration tests — exercises the REAL daemon process.
 *
 * Each test spawns an isolated daemon subprocess with HOME redirected
 * to a temp directory so it doesn't stomp the user's running daemon.
 * Tests exercise failure modes and verify runtime invariants.
 *
 * These tests are slow (seconds each) because they manage real processes.
 * The socket-deletion test is especially slow (~35s) due to the watchdog interval.
 */
import { describe, test, expect, afterAll } from "bun:test";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

// ---------------------------------------------------------------------------
// Chrome availability guard
// ---------------------------------------------------------------------------

const CHROME_BIN =
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

const CHROME_AVAILABLE = fs.existsSync(CHROME_BIN);

// ---------------------------------------------------------------------------
// Daemon project root (so we can spawn `bun run src/daemon.ts`)
// ---------------------------------------------------------------------------

const PROJECT_ROOT = path.resolve(import.meta.dir, "..", "..");

// ---------------------------------------------------------------------------
// RPC helper — Bun's fetch with unix socket support
// ---------------------------------------------------------------------------

async function rpc(
  socketPath: string,
  method: "GET" | "POST",
  pathname: string,
  body?: unknown,
): Promise<{ status: number; data: any }> {
  const resp = await fetch(`http://localhost${pathname}`, {
    method,
    unix: socketPath,
    signal: AbortSignal.timeout(30_000),
    ...(body !== undefined
      ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }
      : {}),
  });
  const data = await resp.json();
  return { status: resp.status, data };
}

// ---------------------------------------------------------------------------
// Wait for daemon to become responsive
// ---------------------------------------------------------------------------

async function waitForDaemon(
  socketPath: string,
  timeoutMs = 20_000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const resp = await fetch("http://localhost/health", {
        unix: socketPath,
        signal: AbortSignal.timeout(1_000),
      });
      if (resp.ok) return true;
    } catch {
      // not ready yet
    }
    await Bun.sleep(500);
  }
  return false;
}

// ---------------------------------------------------------------------------
// Wait for headless Chrome to reach chrome_up phase
// ---------------------------------------------------------------------------

async function waitForChromeUp(
  socketPath: string,
  target: "headless" | "headed" = "headless",
  timeoutMs = 30_000,
): Promise<{ pid: number; port: number } | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const { data } = await rpc(socketPath, "GET", "/status");
      const state = data[target];
      if (state?.phase === "chrome_up") {
        return { pid: state.pid, port: state.port };
      }
    } catch {
      // socket not ready
    }
    await Bun.sleep(500);
  }
  return null;
}

/** Same as waitForChromeUp, but for an arbitrary headless pool shard index. */
async function waitForShardUp(
  socketPath: string,
  shard: number,
  timeoutMs = 30_000,
): Promise<{ pid: number; port: number } | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const { data } = await rpc(socketPath, "GET", "/status");
      const state = data.headlessPool?.[shard];
      if (state?.phase === "chrome_up") {
        return { pid: state.pid, port: state.port };
      }
    } catch {
      // socket not ready
    }
    await Bun.sleep(500);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Daemon harness — isolated temp HOME, subprocess lifecycle
// ---------------------------------------------------------------------------

interface DaemonHandle {
  proc: ReturnType<typeof Bun.spawn>;
  socketPath: string;
  pidPath: string;
  homeDir: string;
  abDir: string;
  cleanup: () => Promise<void>;
}

/** All spawned daemons — cleaned up in afterAll as a safety net. */
const activeDaemons: DaemonHandle[] = [];

async function spawnDaemon(opts?: {
  /** Extra env vars for the subprocess */
  env?: Record<string, string>;
  /** Wait for the daemon to be ready (default: true) */
  waitReady?: boolean;
}): Promise<DaemonHandle> {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "ab-test-"));
  const abDir = path.join(homeDir, ".agent-browser");
  fs.mkdirSync(abDir, { recursive: true });

  const socketPath = path.join(abDir, "ab-server.sock");
  const pidPath = path.join(abDir, "ab-server.pid");

  const proc = Bun.spawn(["bun", "run", "src/daemon.ts"], {
    cwd: PROJECT_ROOT,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      HOME: homeDir,
      // Suppress pino pretty-printing if any
      NODE_ENV: "test",
      ...(opts?.env ?? {}),
    },
  });

  const handle: DaemonHandle = {
    proc,
    socketPath,
    pidPath,
    homeDir,
    abDir,
    cleanup: async () => {
      // Kill process if still alive
      try {
        if (proc.exitCode === null) {
          proc.kill("SIGTERM");
          await Promise.race([proc.exited, Bun.sleep(5_000)]);
          if (proc.exitCode === null) {
            proc.kill(9);
            await Promise.race([proc.exited, Bun.sleep(2_000)]);
          }
        }
      } catch {
        // already dead
      }

      // Remove temp directory
      try {
        fs.rmSync(homeDir, { recursive: true, force: true });
      } catch {
        // best effort
      }

      // Remove from active list
      const idx = activeDaemons.indexOf(handle);
      if (idx >= 0) activeDaemons.splice(idx, 1);
    },
  };

  activeDaemons.push(handle);

  if (opts?.waitReady !== false) {
    const ready = await waitForDaemon(socketPath);
    if (!ready) {
      // Dump stderr for diagnostics before failing
      const stderr = await collectStderr(proc, 2_000);
      await handle.cleanup();
      throw new Error(
        `Daemon did not become ready within timeout.\nstderr: ${stderr}`,
      );
    }
  }

  return handle;
}

/**
 * Collect stderr output from a subprocess. Reads until timeout or stream end.
 */
async function collectStderr(
  proc: ReturnType<typeof Bun.spawn>,
  timeoutMs = 5_000,
): Promise<string> {
  if (!proc.stderr || typeof proc.stderr === "number") return "";
  try {
    const resp = new Response(proc.stderr);
    const text = await Promise.race([
      resp.text(),
      Bun.sleep(timeoutMs).then(() => "[timeout reading stderr]"),
    ]);
    return text;
  } catch {
    return "[error reading stderr]";
  }
}

// Safety net — clean up any daemons left alive after all tests
afterAll(async () => {
  const remaining = [...activeDaemons];
  for (const daemon of remaining) {
    await daemon.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("daemon integration", () => {
  test(
    "daemon starts and responds to health check",
    async () => {
      if (!CHROME_AVAILABLE) {
        console.log("SKIP: Chrome not available");
        return;
      }

      const daemon = await spawnDaemon();
      try {
        const { status, data } = await rpc(daemon.socketPath, "GET", "/health");
        expect(status).toBe(200);
        expect(data.ok).toBe(true);

        // PID file should exist
        expect(fs.existsSync(daemon.pidPath)).toBe(true);
        const pidContent = fs.readFileSync(daemon.pidPath, "utf-8").trim();
        const pid = parseInt(pidContent, 10);
        expect(pid).toBe(daemon.proc.pid);
      } finally {
        await daemon.cleanup();
      }
    },
    30_000,
  );

  test(
    "heal completes without killing the daemon",
    async () => {
      if (!CHROME_AVAILABLE) {
        console.log("SKIP: Chrome not available");
        return;
      }

      const daemon = await spawnDaemon();
      try {
        // Send heal
        const { status, data } = await rpc(daemon.socketPath, "POST", "/heal");
        expect(status).toBe(200);
        expect(data.ok).toBe(true);
        expect(Array.isArray(data.actions)).toBe(true);
        expect(data.actions.length).toBeGreaterThan(0);

        // Daemon should still be alive
        expect(daemon.proc.exitCode).toBeNull();

        // Should still respond to health
        const health = await rpc(daemon.socketPath, "GET", "/health");
        expect(health.status).toBe(200);
        expect(health.data.ok).toBe(true);
      } finally {
        await daemon.cleanup();
      }
    },
    60_000,
  );

  test(
    "second daemon refuses to start when lockfile is held",
    async () => {
      if (!CHROME_AVAILABLE) {
        console.log("SKIP: Chrome not available");
        return;
      }

      const daemon = await spawnDaemon();
      try {
        // Verify first daemon is healthy
        const health = await rpc(daemon.socketPath, "GET", "/health");
        expect(health.status).toBe(200);

        // Try to start a second daemon with the same HOME
        const proc2 = Bun.spawn(["bun", "run", "src/daemon.ts"], {
          cwd: PROJECT_ROOT,
          stdout: "pipe",
          stderr: "pipe",
          env: {
            ...process.env,
            HOME: daemon.homeDir,
            NODE_ENV: "test",
          },
        });

        // Wait for it to exit — it should refuse and exit with code 1
        const exitCode = await Promise.race([
          proc2.exited,
          Bun.sleep(15_000).then(() => null),
        ]);

        // Read stderr
        const stderr = await collectStderr(proc2, 2_000);

        expect(exitCode).toBe(1);
        expect(stderr).toContain("already running");

        // First daemon should still be alive
        expect(daemon.proc.exitCode).toBeNull();
        const healthAfter = await rpc(daemon.socketPath, "GET", "/health");
        expect(healthAfter.status).toBe(200);
      } finally {
        await daemon.cleanup();
      }
    },
    30_000,
  );

  test(
    "daemon detects and recovers from socket deletion",
    async () => {
      if (!CHROME_AVAILABLE) {
        console.log("SKIP: Chrome not available");
        return;
      }

      const daemon = await spawnDaemon();
      try {
        // Verify daemon is healthy
        const health = await rpc(daemon.socketPath, "GET", "/health");
        expect(health.status).toBe(200);

        // Delete the socket file
        expect(fs.existsSync(daemon.socketPath)).toBe(true);
        fs.unlinkSync(daemon.socketPath);
        expect(fs.existsSync(daemon.socketPath)).toBe(false);

        // Wait for watchdog to detect and re-create (runs every 30s)
        const recovered = await waitForDaemon(daemon.socketPath, 40_000);
        expect(recovered).toBe(true);

        // Verify RPC works again
        const healthAfter = await rpc(daemon.socketPath, "GET", "/health");
        expect(healthAfter.status).toBe(200);
        expect(healthAfter.data.ok).toBe(true);

        // Daemon process should still be alive
        expect(daemon.proc.exitCode).toBeNull();
      } finally {
        await daemon.cleanup();
      }
    },
    50_000,
  );

  test(
    "daemon detects Chrome PID death and restarts",
    async () => {
      if (!CHROME_AVAILABLE) {
        console.log("SKIP: Chrome not available");
        return;
      }

      const daemon = await spawnDaemon();
      try {
        // Wait for Chrome to be fully up before getting its PID
        const chromeBefore = await waitForChromeUp(daemon.socketPath);
        expect(chromeBefore).not.toBeNull();
        const originalPid = chromeBefore!.pid;

        // Kill Chrome with SIGKILL
        try {
          process.kill(originalPid, "SIGKILL");
        } catch {
          // Chrome may have already exited
        }

        // Wait for supervisor to detect death and restart Chrome (up to 30s)
        const deadline = Date.now() + 30_000;
        let newPid: number | null = null;

        while (Date.now() < deadline) {
          await Bun.sleep(1_000);
          try {
            const { data } = await rpc(daemon.socketPath, "GET", "/status");
            if (
              data.headless.phase === "chrome_up" &&
              data.headless.pid !== originalPid
            ) {
              newPid = data.headless.pid;
              break;
            }
          } catch {
            // socket may be temporarily unresponsive
          }
        }

        expect(newPid).not.toBeNull();
        expect(newPid).not.toBe(originalPid);

        // Daemon should still be running
        expect(daemon.proc.exitCode).toBeNull();
      } finally {
        await daemon.cleanup();
      }
    },
    45_000,
  );

  test(
    "heal does not interfere with concurrent ensure requests",
    async () => {
      if (!CHROME_AVAILABLE) {
        console.log("SKIP: Chrome not available");
        return;
      }

      const daemon = await spawnDaemon();
      try {
        // Send heal and ensure concurrently
        const [healResult, ensureResult] = await Promise.all([
          rpc(daemon.socketPath, "POST", "/heal"),
          rpc(daemon.socketPath, "POST", "/chrome/ensure"),
        ]);

        // Both should succeed (queue serializes them)
        expect(healResult.status).toBe(200);
        expect(healResult.data.ok).toBe(true);

        expect(ensureResult.status).toBe(200);
        expect(ensureResult.data.ok).toBe(true);
        expect(typeof ensureResult.data.pid).toBe("number");
        expect(typeof ensureResult.data.port).toBe("number");

        // Chrome should be up after both complete (may need time to stabilize in test env)
        const chrome = await waitForChromeUp(daemon.socketPath, "headless", 15_000);
        expect(chrome).not.toBeNull();

        // Daemon should still be alive
        expect(daemon.proc.exitCode).toBeNull();
      } finally {
        await daemon.cleanup();
      }
    },
    60_000,
  );

  test(
    "operation queue serializes concurrent kills",
    async () => {
      if (!CHROME_AVAILABLE) {
        console.log("SKIP: Chrome not available");
        return;
      }

      const daemon = await spawnDaemon();
      try {
        // Ensure headed Chrome is up
        const ensureResult = await rpc(
          daemon.socketPath,
          "POST",
          "/chrome/ensure-headed",
        );
        expect(ensureResult.status).toBe(200);
        expect(ensureResult.data.ok).toBe(true);

        // Verify headed Chrome is up
        const { data: statusBefore } = await rpc(
          daemon.socketPath,
          "GET",
          "/status",
        );
        expect(statusBefore.headed.phase).toBe("chrome_up");

        // Send two heal requests concurrently (heal kills all chrome)
        const [heal1, heal2] = await Promise.all([
          rpc(daemon.socketPath, "POST", "/heal"),
          rpc(daemon.socketPath, "POST", "/heal"),
        ]);

        // Both should succeed without errors (queue serializes them)
        expect(heal1.status).toBe(200);
        expect(heal1.data.ok).toBe(true);
        expect(heal2.status).toBe(200);
        expect(heal2.data.ok).toBe(true);

        // After heal, headed should be idle (only headless restarts via heal)
        // Wait for headless Chrome to finish launching after heal
        const chromeAfterHeal = await waitForChromeUp(daemon.socketPath, "headless", 30_000);
        expect(chromeAfterHeal).not.toBeNull();

        // Daemon should still be alive
        expect(daemon.proc.exitCode).toBeNull();
      } finally {
        await daemon.cleanup();
      }
    },
    60_000,
  );

  // -------------------------------------------------------------------------
  // Headless Chrome pool (plan: 2026-07-10-chrome-pool-plan.md, Unit 1)
  // -------------------------------------------------------------------------

  test(
    "status/health report a pool of 3 by default — shard 0 up, shards 1-2 idle",
    async () => {
      if (!CHROME_AVAILABLE) {
        console.log("SKIP: Chrome not available");
        return;
      }

      const daemon = await spawnDaemon();
      try {
        const shard0 = await waitForShardUp(daemon.socketPath, 0);
        expect(shard0).not.toBeNull();

        const { data: status } = await rpc(daemon.socketPath, "GET", "/status");
        expect(Array.isArray(status.headlessPool)).toBe(true);
        expect(status.headlessPool.length).toBe(3);
        expect(status.headlessPool[0].phase).toBe("chrome_up");
        expect(status.headlessPool[1].phase).toBe("idle");
        expect(status.headlessPool[2].phase).toBe("idle");
        // Back-compat alias: headless === headlessPool[0]
        expect(status.headless).toEqual(status.headlessPool[0]);

        const { data: health } = await rpc(daemon.socketPath, "GET", "/health");
        expect(health.headlessPool.length).toBe(3);
        expect(health.headlessPool[0].phase).toBe("chrome_up");
        expect(health.headless).toEqual(health.headlessPool[0]);

        // Out-of-range shard on the default pool (size 3) -> 400
        const badShard = await rpc(daemon.socketPath, "POST", "/chrome/ensure", { shard: 3 });
        expect(badShard.status).toBe(400);
        expect(badShard.data.ok).toBe(false);
      } finally {
        await daemon.cleanup();
      }
    },
    45_000,
  );

  test(
    "ensure {shard:1} boots a second Chrome on 9334 with its own profile dir, idempotently, and the daemon survives a shard-1 crash",
    async () => {
      if (!CHROME_AVAILABLE) {
        console.log("SKIP: Chrome not available");
        return;
      }

      // NOTE: this test does not assert shard 0's PID stays pinned across the
      // whole scenario. Under repeated real-Chrome cycling in this sandbox,
      // even the pre-existing always-on target independently hits Chrome's
      // documented exit-133 (SIGTRAP) profile-corruption crash loop — see
      // chrome-supervisor.ts's "resetting profile to recover from possible
      // corruption" handling. That's a pre-existing environmental flake this
      // Unit's changes don't introduce (reproduced with an unmodified
      // always-on target under heavy sequential real-Chrome load). The
      // *code-level* isolation guarantee (crashing one target's state machine
      // cannot mutate another target's state) is covered deterministically,
      // without real Chrome, in chrome-supervisor.test.ts.
      const daemon = await spawnDaemon();
      try {
        const shard0Before = await waitForShardUp(daemon.socketPath, 0);
        expect(shard0Before).not.toBeNull();
        expect(shard0Before!.port).toBe(9333);

        const first = await rpc(daemon.socketPath, "POST", "/chrome/ensure", { shard: 1 });
        expect(first.status).toBe(200);
        expect(first.data.ok).toBe(true);
        expect(first.data.port).toBe(9334);
        expect(first.data.alreadyRunning).toBe(false);
        // This daemon's HOME is a fresh temp dir (see spawnDaemon), so shard
        // 1's profile genuinely doesn't exist before this first ensure —
        // real end-to-end coverage of the profileFresh signal (chrome-pool-
        // plan Unit 3, decision 5), complementing the mocked/pure-function
        // coverage in chrome-supervisor.test.ts.
        expect(first.data.profileFresh).toBe(true);

        const profile1 = path.join(daemon.homeDir, ".agent-browser", "profile-1");
        expect(fs.existsSync(profile1)).toBe(true);

        // Idempotent: second ensure for the same shard returns alreadyRunning
        // and, since Chrome is already up, profileFresh: false.
        const second = await rpc(daemon.socketPath, "POST", "/chrome/ensure", { shard: 1 });
        expect(second.status).toBe(200);
        expect(second.data.alreadyRunning).toBe(true);
        expect(second.data.pid).toBe(first.data.pid);
        expect(second.data.port).toBe(9334);
        expect(second.data.profileFresh).toBe(false);

        // --- Kill shard 1's Chrome directly ---
        try {
          process.kill(second.data.pid, "SIGKILL");
        } catch {
          // may have already exited
        }

        // Wait for the supervisor to detect the crash and settle shard 1
        // (on-demand policy: no auto-restart, it goes to idle/crashed — same
        // semantics as the pre-pool headed target).
        const deadline = Date.now() + 10_000;
        let shard1Settled = false;
        while (Date.now() < deadline) {
          const { data } = await rpc(daemon.socketPath, "GET", "/status");
          const phase = data.headlessPool[1]?.phase;
          if (phase === "idle" || phase === "chrome_crashed") {
            shard1Settled = true;
            break;
          }
          await Bun.sleep(300);
        }
        expect(shard1Settled).toBe(true);

        // Daemon itself survives shard 1's crash
        expect(daemon.proc.exitCode).toBeNull();
      } finally {
        await daemon.cleanup();
      }
    },
    45_000,
  );

  test(
    "AB_HEADLESS_POOL_SIZE=1 reproduces today's single-Chrome behavior",
    async () => {
      if (!CHROME_AVAILABLE) {
        console.log("SKIP: Chrome not available");
        return;
      }

      const daemon = await spawnDaemon({ env: { AB_HEADLESS_POOL_SIZE: "1" } });
      try {
        const shard0 = await waitForShardUp(daemon.socketPath, 0);
        expect(shard0).not.toBeNull();
        expect(shard0!.port).toBe(9333);

        const { data: status } = await rpc(daemon.socketPath, "GET", "/status");
        expect(status.headlessPool.length).toBe(1);

        // Shard 1 doesn't exist in a pool of size 1 -> 400
        const badShard = await rpc(daemon.socketPath, "POST", "/chrome/ensure", { shard: 1 });
        expect(badShard.status).toBe(400);
      } finally {
        await daemon.cleanup();
      }
    },
    45_000,
  );

  test(
    "AB_HEADLESS_POOL_SIZE=9 clamps to the 8-shard maximum",
    async () => {
      if (!CHROME_AVAILABLE) {
        console.log("SKIP: Chrome not available");
        return;
      }

      const daemon = await spawnDaemon({ env: { AB_HEADLESS_POOL_SIZE: "9" } });
      try {
        const { data: status } = await rpc(daemon.socketPath, "GET", "/status");
        expect(status.headlessPool.length).toBe(8);

        // Shard 8 is out of range for a clamped pool of 8 (valid indices 0-7) -> 400
        const badShard = await rpc(daemon.socketPath, "POST", "/chrome/ensure", { shard: 8 });
        expect(badShard.status).toBe(400);
      } finally {
        await daemon.cleanup();
      }
    },
    45_000,
  );
});
