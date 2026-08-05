/**
 * server.ts's RetryAfterError -> 503 mapping + per-shard ensure logging —
 * FINAL CONSENSUS SPEC item 15.
 *
 * `handleEnsure`/`handleEnsureHeadless` are exported directly (no live HTTP
 * socket needed) so this can drive the REAL crash-loop-backoff path through
 * chrome-supervisor (same outermost-boundary mocks as threshold-probe.test.ts
 * — Bun.spawn / fetch / WebSocket / process.kill) and assert on the actual
 * Response server.ts produces, rather than re-describing the shape by hand.
 *
 * server.test.ts deliberately does NOT import the real server.ts (its own
 * doc comment: avoids needing Chrome/the supervisor) — this file is the
 * one place that exercises the real handleEnsure/handleEnsureHeadless.
 *
 * bun test --isolate runs this file in a fresh global env.
 */
process.env.AB_HEARTBEAT_REARM_MS = "15";

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { getRecentLogs } from "../logger";
import { resetAll } from "../state";

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  url: string;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;
  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }
  close(): void {
    this.closed = true;
  }
}

const originalFetch = globalThis.fetch;
const originalSpawn = Bun.spawn;
const originalWebSocket = globalThis.WebSocket;
const originalKill = process.kill;

let killShouldThrow = false;

function installFetchMock(): void {
  globalThis.fetch = mock((url: string | URL | Request) => {
    const urlStr = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;
    if (urlStr.includes("/json/version")) {
      return Promise.resolve(
        new Response(
          JSON.stringify({ webSocketDebuggerUrl: "ws://127.0.0.1:9999/devtools/browser/FAKE" }),
          { status: 200 },
        ),
      );
    }
    return Promise.resolve(new Response("", { status: 404 }));
  }) as unknown as typeof fetch;
}

function installSpawnMock(chromePid: number): void {
  const mockChromeProc = {
    pid: chromePid,
    exitCode: null as number | null,
    exited: new Promise<number>(() => {
      /* never resolves — Chrome "stays up" for the duration of the test */
    }),
    stdout: null,
    stderr: null,
    kill: mock(() => {}),
  };
  const mockLsofProc = {
    pid: -1,
    exitCode: 0,
    exited: Promise.resolve(0),
    stdout: null,
    stderr: null,
    kill: mock(() => {}),
  };
  // @ts-expect-error — test mock, narrower than Bun.spawn's real overload set
  Bun.spawn = mock((cmd: string[]) => {
    if (cmd[0] === "/usr/sbin/lsof") return mockLsofProc;
    return mockChromeProc;
  });
}

function installKillMock(): void {
  process.kill = ((_pid: number, signal?: string | number) => {
    if (signal === 0) {
      if (killShouldThrow) {
        const err = new Error("kill ESRCH") as NodeJS.ErrnoException;
        err.code = "ESRCH";
        throw err;
      }
      return true;
    }
    return true;
  }) as typeof process.kill;
}

beforeEach(() => {
  resetAll();
  FakeWebSocket.instances = [];
  killShouldThrow = false;
  installFetchMock();
  // @ts-expect-error — test mock
  globalThis.WebSocket = FakeWebSocket;
  installKillMock();
});

afterEach(async () => {
  const { __resetRuntimeForTest } = await import("../chrome-supervisor");
  __resetRuntimeForTest();
  globalThis.fetch = originalFetch;
  Bun.spawn = originalSpawn;
  globalThis.WebSocket = originalWebSocket;
  process.kill = originalKill;
  resetAll();
});

describe("handleEnsureHeadless / handleEnsure — RetryAfterError -> 503 (item 15)", () => {
  test("a shard in crash backoff returns 503 with a readable error + retryAfterMs, and the request logs its resolved shard", async () => {
    installSpawnMock(81001);
    const { ensure } = await import("../chrome-supervisor");
    const { handleEnsureHeadless } = await import("../server");

    await ensure("headless-1");
    // Dead pid on close -> handleCrashDetected -> bumps backoff/retryNotBefore into the future.
    killShouldThrow = true;
    FakeWebSocket.instances[0].onclose?.();
    await sleepMs(50);

    const req = new Request("http://localhost/chrome/ensure", {
      method: "POST",
      body: JSON.stringify({ shard: 1 }),
    });
    const resp = await handleEnsureHeadless(req);

    expect(resp.status).toBe(503);
    const body = (await resp.json()) as { ok: boolean; error: string; retryAfterMs: number };
    expect(body.ok).toBe(false);
    expect(typeof body.retryAfterMs).toBe("number");
    expect(body.retryAfterMs).toBeGreaterThan(0);
    // Readable stderr-bound message: cli.ts's generic rpc-error surfacing
    // only propagates `error`/`message` as a flat string, so the retry
    // seconds have to be embedded in the text itself, not just retryAfterMs.
    expect(body.error).toMatch(/retry in \d+s/);

    const logs = getRecentLogs();
    expect(logs.some((e) => typeof e.msg === "string" && e.msg === "POST /chrome/ensure shard=1")).toBe(true);
  }, 10_000);

  test("a healthy shard still ensures normally (200, ok:true) — the gate only fires inside backoff", async () => {
    installSpawnMock(81002);
    const { handleEnsureHeadless } = await import("../server");

    const req = new Request("http://localhost/chrome/ensure", {
      method: "POST",
      body: JSON.stringify({ shard: 2 }),
    });
    const resp = await handleEnsureHeadless(req);

    expect(resp.status).toBe(200);
    const body = (await resp.json()) as { ok: boolean };
    expect(body.ok).toBe(true);

    const logs = getRecentLogs();
    expect(logs.some((e) => typeof e.msg === "string" && e.msg === "POST /chrome/ensure shard=2")).toBe(true);
  }, 10_000);
});

describe("startSupervision — always-on backoff must not abort supervision (FIX 1)", () => {
  // Regression for: an always-on shard crash-looping (backoff armed) ->
  // `ab heal` -> handleHeal's stopAll()/resetAll()/startSupervision() ->
  // startSupervision awaited launchChrome with no try/catch -> the
  // ensure-gate's RetryAfterError went uncaught -> generic 500,
  // startSupervision aborted before relaunching AND before startDashboard(),
  // leaving the always-on shard down with no timer at all. Not calling the
  // real handleHeal() here deliberately — it also runs
  // cleanAgentBrowserSessions() against the real ~/.agent-browser directory
  // (readdir/unlink), which this fast unit-test file has no business
  // touching; startSupervision() is the unit the fix actually lives in, and
  // the task's own note ("heal (or startSupervision directly)") allows this.
  test("does not throw when the always-on shard is in crash backoff, and surfaces the skip", async () => {
    installSpawnMock(81003);
    const { ensure, startSupervision, getRuntimeSnapshot } = await import("../chrome-supervisor");

    await ensure("headless-0"); // headless-0 is the always-on target by default
    const heartbeat = FakeWebSocket.instances[0];
    // Dead pid on close -> handleCrashDetected -> bumps backoff/retryNotBefore into the future.
    killShouldThrow = true;
    heartbeat.onclose?.();
    await sleepMs(50);

    const snap = getRuntimeSnapshot() as Record<string, { retryNotBefore: number }>;
    expect(snap["headless-0"].retryNotBefore).toBeGreaterThan(Date.now());

    // Must not throw — before the fix, launchChrome's RetryAfterError
    // propagated straight out of startSupervision's loop.
    let caught: unknown = null;
    let result: { skippedBackoff: Array<{ target: string; retryAfterMs: number }> } | null = null;
    try {
      result = await startSupervision();
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeNull();
    expect(result).not.toBeNull();

    // The backoff skip is surfaced, not swallowed.
    expect(result!.skippedBackoff.length).toBeGreaterThan(0);
    const skip = result!.skippedBackoff.find((s) => s.target === "headless-0");
    expect(skip).toBeDefined();
    expect(skip!.retryAfterMs).toBeGreaterThan(0);

    // startDashboard() still ran — proof the loop didn't abort before it.
    const logs = getRecentLogs();
    expect(logs.some((e) => typeof e.msg === "string" && e.msg.includes("Starting dashboard"))).toBe(true);
    expect(logs.some((e) => typeof e.msg === "string" && e.msg.includes("Chrome supervision active"))).toBe(true);
    expect(
      logs.some(
        (e) =>
          typeof e.msg === "string" &&
          e.msg.includes("startSupervision skipping launch") &&
          e.msg.includes("headless-0"),
      ),
    ).toBe(true);
  }, 10_000);
});
