/**
 * stopAll() must stop the detached dashboard server via `agent-browser
 * dashboard stop`: the `dashboard start` launcher exits immediately, so a
 * process handle can never reach the real server. Bun.spawn is mocked; no real
 * agent-browser runs. Run with `bun test --isolate`.
 */
import { mkdtempSync, rmSync } from "fs";
import * as os from "os";
import * as path from "path";

const TMP_ROOT = mkdtempSync(path.join(os.tmpdir(), "ab-dashstop-"));
process.env.AB_PROFILE_ROOT = TMP_ROOT;

import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

const originalSpawn = Bun.spawn;
let spawnCalls: string[][] = [];
let spawnImpl: (cmd: string[]) => unknown;

beforeEach(() => {
  spawnCalls = [];
  spawnImpl = () => ({ pid: -1, exitCode: 0, exited: Promise.resolve(0), kill: mock(() => {}) });
  // @ts-expect-error — test mock, narrower than Bun.spawn's overload set
  Bun.spawn = mock((cmd: string[]) => {
    spawnCalls.push(cmd);
    return spawnImpl(cmd);
  });
});

afterEach(async () => {
  Bun.spawn = originalSpawn;
  const { __resetRuntimeForTest } = await import("../chrome-supervisor");
  __resetRuntimeForTest();
});

afterAll(() => {
  try { rmSync(TMP_ROOT, { recursive: true, force: true }); } catch { /* best effort */ }
});

const dashboardStops = () =>
  spawnCalls.filter((c) => c[0] === "agent-browser" && c[1] === "dashboard" && c[2] === "stop");

describe("stopAll dashboard teardown", () => {
  test("invokes `agent-browser dashboard stop` exactly once, with no extra args", async () => {
    const { stopAll } = await import("../chrome-supervisor");
    await stopAll();
    expect(dashboardStops()).toEqual([["agent-browser", "dashboard", "stop"]]);
  });

  test("a synchronous spawn failure does not make stopAll throw", async () => {
    spawnImpl = () => {
      throw new Error("ENOENT: agent-browser not found");
    };
    const { stopAll } = await import("../chrome-supervisor");
    await expect(stopAll()).resolves.toBeUndefined();
    expect(dashboardStops()).toHaveLength(1);
  });

  test("a rejected exit promise does not make stopAll throw", async () => {
    spawnImpl = () => ({ pid: -1, exitCode: null, exited: Promise.reject(new Error("boom")), kill: mock(() => {}) });
    const { stopAll } = await import("../chrome-supervisor");
    await expect(stopAll()).resolves.toBeUndefined();
  });

  // Must stay last: it leaves opQueue permanently blocked for this module instance.
  test("stops the dashboard even while a queued op blocks opQueue", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(() => new Promise<Response>(() => {})) as unknown as typeof fetch;
    spawnImpl = (cmd) =>
      cmd[0] === "agent-browser"
        ? { pid: -1, exitCode: 0, exited: Promise.resolve(0), kill: mock(() => {}) }
        : { pid: -1, exitCode: null, exited: new Promise<number>(() => {}), stdout: new ReadableStream(), stderr: null, kill: mock(() => {}) };
    try {
      const { ensure, stopAll } = await import("../chrome-supervisor");
      void ensure("headless-0").catch(() => {});
      await Bun.sleep(20);
      let queuedDone = false;
      void stopAll().then(() => { queuedDone = true; });
      await Bun.sleep(50);
      expect(queuedDone).toBe(false);
      expect(dashboardStops()).toHaveLength(1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
