/**
 * Health-summary observability tests (2026-08-04 incident follow-up).
 *
 * The incident: headless-0's heartbeat closed at 16:28Z and the daemon had
 * no loggable signal about it until the next crash at 21:52Z. Unit B closes
 * that gap with (a) a pure per-target summary payload builder, (b)
 * lastHealthOkAt tracking updated on every successful checkCdp() poll inside
 * the health-check timer, and (c) heartbeatArmedSince tracking paired with
 * every heartbeatWs assignment.
 *
 * AB_HEALTH_INTERVAL_MS is set BEFORE chrome-supervisor is ever imported
 * (dynamically, in every test below) so the lifecycle test can observe a
 * real health-check tick without waiting multiple real seconds.
 * bun test --isolate runs this file in a fresh global env, so this can't
 * leak into other test files.
 */
process.env.AB_HEALTH_INTERVAL_MS = "30";

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { resetAll } from "../state";

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function loadSupervisor() {
  return import("../chrome-supervisor");
}

// ---------------------------------------------------------------------------
// Layer 1 — pure payload builder. No mocking required.
// ---------------------------------------------------------------------------

describe("buildHealthSummaryPayload", () => {
  test("reports armed heartbeat and a known lastHealthOkAt as ISO strings", async () => {
    const { buildHealthSummaryPayload } = await loadSupervisor();
    const armedSince = Date.parse("2026-08-04T16:00:00.000Z");
    const lastOk = Date.parse("2026-08-04T16:05:00.000Z");

    const payload = buildHealthSummaryPayload(
      "headless-0", "chrome_up", 12345, true, armedSince, 0, lastOk,
      "armed", null, null,
    );

    expect(payload).toEqual({
      target: "headless-0",
      phase: "chrome_up",
      pid: 12345,
      heartbeatArmed: true,
      heartbeatArmedSinceIso: "2026-08-04T16:00:00.000Z",
      consecutiveFailures: 0,
      lastHealthOkAtIso: "2026-08-04T16:05:00.000Z",
      heartbeatMode: "armed",
      lastExit: null,
      lastDetection: null,
    });
  });

  test("reports a disarmed heartbeat with null timestamps distinctly from an armed one", async () => {
    const { buildHealthSummaryPayload } = await loadSupervisor();

    const disarmed = buildHealthSummaryPayload(
      "headed", "chrome_up", 999, false, null, 2, null,
      "cooldown", null, null,
    );

    expect(disarmed.heartbeatArmed).toBe(false);
    expect(disarmed.heartbeatArmedSinceIso).toBeNull();
    expect(disarmed.lastHealthOkAtIso).toBeNull();
    expect(disarmed.consecutiveFailures).toBe(2);
  });

  test("carries pid through as null when there is none (never launched)", async () => {
    const { buildHealthSummaryPayload } = await loadSupervisor();
    const payload = buildHealthSummaryPayload(
      "headless-1", "idle", null, false, null, 0, null,
      "off", null, null,
    );
    expect(payload.pid).toBeNull();
  });

  // FINAL CONSENSUS SPEC — mode + lastExit + lastDetection rendered, and
  // lastExit never contains a synthesized code+signal pair (a signal death
  // reports code:null, never a fabricated exit code).
  test("renders heartbeatMode, lastExit, and lastDetection as ISO-stamped, verbatim (never synthesized)", async () => {
    const { buildHealthSummaryPayload } = await loadSupervisor();
    const exitAt = Date.parse("2026-08-04T16:05:00.000Z");
    const detectAt = Date.parse("2026-08-04T16:06:00.000Z");

    const payload = buildHealthSummaryPayload(
      "headless-1", "chrome_crashed", null, false, null, 0, null,
      "off",
      { code: null, signal: "SIGKILL", at: exitAt },
      { reason: "pid-gone", at: detectAt },
    );

    expect(payload.heartbeatMode).toBe("off");
    expect(payload.lastExit).toEqual({ code: null, signal: "SIGKILL", at: "2026-08-04T16:05:00.000Z" });
    expect(payload.lastDetection).toEqual({ reason: "pid-gone", at: "2026-08-04T16:06:00.000Z" });
  });
});

// ---------------------------------------------------------------------------
// Layer 2 — getHealthDiagnostics() shape (the /status RPC's data source).
// ---------------------------------------------------------------------------

describe("getHealthDiagnostics", () => {
  test("reports null/off for every target before anything has ever run", async () => {
    const { getHealthDiagnostics, __resetRuntimeForTest } = await loadSupervisor();
    __resetRuntimeForTest();
    resetAll();

    const diag = getHealthDiagnostics();
    expect(diag.headed).toEqual({
      lastHealthOkAt: null,
      heartbeatArmedSince: null,
      heartbeatMode: "off",
      lastExit: null,
      lastDetection: null,
    });
    expect(diag["headless-0"]).toEqual({
      lastHealthOkAt: null,
      heartbeatArmedSince: null,
      heartbeatMode: "off",
      lastExit: null,
      lastDetection: null,
    });
  });
});

// ---------------------------------------------------------------------------
// Layer 3 — lifecycle: lastHealthOkAt updates on a real successful checkCdp()
// tick inside the health-check timer; heartbeatArmedSince tracks the real
// heartbeat WS lifecycle. Mocks only the outermost boundaries (Bun.spawn,
// fetch, WebSocket) — same idiom as heartbeat-rearm.test.ts.
// ---------------------------------------------------------------------------

class FakeWebSocket {
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;
  constructor(_url: string) {}
  close(): void {
    this.closed = true;
  }
}

const originalFetch = globalThis.fetch;
const originalSpawn = Bun.spawn;
const originalWebSocket = globalThis.WebSocket;
const originalKill = process.kill;

function installKillMock(): void {
  // The health-check timer's PID-alive probe (`process.kill(pid, 0)`) must
  // not throw for our fake pids, or it marks the target crashed before the
  // timer's own checkCdp() branch ever runs.
  process.kill = ((_pid: number, signal?: string | number) => {
    if (signal === 0) return true;
    return true;
  }) as typeof process.kill;
}

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

beforeEach(() => {
  resetAll();
  installFetchMock();
  // @ts-expect-error — test mock
  globalThis.WebSocket = FakeWebSocket;
  installKillMock();
});

afterEach(async () => {
  const { __resetRuntimeForTest } = await loadSupervisor();
  __resetRuntimeForTest();
  globalThis.fetch = originalFetch;
  Bun.spawn = originalSpawn;
  globalThis.WebSocket = originalWebSocket;
  process.kill = originalKill;
  resetAll();
});

describe("lastHealthOkAt / heartbeatArmedSince lifecycle (real ensure() -> health-check timer)", () => {
  test("lastHealthOkAt stays null until the health-check timer's first successful checkCdp() tick", async () => {
    installSpawnMock(70001);
    const { ensure, getHealthDiagnostics } = await loadSupervisor();

    await ensure("headed");

    // Immediately after ensure(), the health-check *timer* hasn't ticked yet
    // (only launchChrome's own waitForCdp poll has run) — lastHealthOkAt is
    // specifically about the timer's checkCdp, not the launch-time poll.
    expect(getHealthDiagnostics().headed.lastHealthOkAt).toBeNull();

    // Wait past one AB_HEALTH_INTERVAL_MS tick (30ms).
    await sleepMs(100);

    const diag = getHealthDiagnostics().headed;
    expect(diag.lastHealthOkAt).not.toBeNull();
    expect(new Date(diag.lastHealthOkAt as string).getTime()).toBeLessThanOrEqual(Date.now());
  }, 10_000);

  test("heartbeatArmedSince is set once the heartbeat arms and cleared once it closes", async () => {
    installSpawnMock(70002);
    const { ensure, getHealthDiagnostics } = await loadSupervisor();

    await ensure("headed");
    const armed = getHealthDiagnostics().headed;
    expect(armed.heartbeatArmedSince).not.toBeNull();
  }, 10_000);
});
