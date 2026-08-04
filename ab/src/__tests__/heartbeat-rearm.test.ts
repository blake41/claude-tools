/**
 * Heartbeat re-arm regression tests — 2026-08-04 incident.
 *
 * chrome-supervisor.ts's WS heartbeat is the ONLY instant-death detector for
 * a shard; the periodic HTTP /json/version poll (startHealthCheck) is a much
 * slower backstop that a half-wedged Chrome (HTTP endpoint up, WS layer
 * broken) keeps passing. Before this fix, startHeartbeat's `ws.onclose`
 * handler, on a benign close (Chrome pid still alive), set
 * `rt.heartbeatWs = null` and returned WITHOUT ever re-establishing the
 * heartbeat — silently disabling instant-death detection for that shard
 * until the next full relaunch. Observed consequence: headless-0's
 * heartbeat closed at 16:28Z and the daemon believed the shard was healthy
 * for 5.5 hours while sessions pinned to it got CDP disconnects; recovery
 * only happened at 21:52Z.
 *
 * Two layers, matching this file's own established idiom (see
 * isProfileDirMissing / profileFreshAfterRecovery in chrome-supervisor.ts):
 *
 *  - Pure decision-logic tests for decideHeartbeatClose / shouldRearmHeartbeat
 *    — exhaustive coverage of the exact branching the real onclose handler
 *    uses, with no mocking required.
 *  - A wiring test that drives the REAL ensure() → launchChrome() →
 *    startHeartbeat() path (mocking only Bun.spawn / fetch / WebSocket /
 *    process.kill — the outermost boundaries) to prove the onclose handler
 *    actually calls startHeartbeat() again, not just that the pure function
 *    says it should.
 *
 * Safety note (mirrors teardown.test.ts / gc-sweep.test.ts): this machine
 * runs ONE shared ab-server daemon used by concurrently-running agents.
 * globalThis.fetch is fully replaced for the wiring tests, so no real
 * network call ever reaches a real Chrome shard's CDP port. The one target
 * exercised is "headed" (on-demand, profile-headed has no SingletonLock on
 * this machine), never headless-0/1/2 which the live daemon actively
 * supervises — so even the best-effort SingletonLock-cleanup fs check in
 * launchChrome touches nothing real.
 *
 * AB_HEARTBEAT_REARM_MS is set at module top, BEFORE chrome-supervisor is
 * ever imported (dynamically, in every test below) so the wiring tests
 * don't wait multiple real seconds per case. bun test --isolate runs each
 * test file in a fresh global env, so this can't leak into other files.
 */
process.env.AB_HEARTBEAT_REARM_MS = "20";

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { getRecentLogs } from "../logger";
import { resetAll } from "../state";

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function loadSupervisor() {
  return import("../chrome-supervisor");
}

// ---------------------------------------------------------------------------
// Layer 1 — pure decision-logic tests. No mocking: these call the exact
// functions the real onclose handler calls.
// ---------------------------------------------------------------------------

describe("decideHeartbeatClose", () => {
  test("dead pid → crash, regardless of close history", async () => {
    const { decideHeartbeatClose } = await loadSupervisor();
    expect(decideHeartbeatClose(false, 0)).toEqual({ action: "crash" });
    expect(decideHeartbeatClose(false, 4)).toEqual({ action: "crash" });
  });

  test("alive pid, first benign close → rearm with count 1", async () => {
    const { decideHeartbeatClose } = await loadSupervisor();
    expect(decideHeartbeatClose(true, 0, 5)).toEqual({
      action: "rearm",
      nextConsecutiveBenignCloses: 1,
    });
  });

  test("alive pid, below threshold → keeps re-arming", async () => {
    const { decideHeartbeatClose } = await loadSupervisor();
    // threshold=3: closes bringing the count to 1 and 2 both re-arm.
    expect(decideHeartbeatClose(true, 0, 3)).toEqual({
      action: "rearm",
      nextConsecutiveBenignCloses: 1,
    });
    expect(decideHeartbeatClose(true, 1, 3)).toEqual({
      action: "rearm",
      nextConsecutiveBenignCloses: 2,
    });
  });

  test("alive pid, the Nth rapid close hits the threshold → falls back to polling-only", async () => {
    const { decideHeartbeatClose } = await loadSupervisor();
    // threshold=3: the close that brings the count to 3 gives up re-arming.
    expect(decideHeartbeatClose(true, 2, 3)).toEqual({
      action: "fallback-to-polling",
      consecutiveBenignCloses: 3,
    });
  });

  test("uses the exported HEARTBEAT_BENIGN_CLOSE_THRESHOLD as its default", async () => {
    const { decideHeartbeatClose, HEARTBEAT_BENIGN_CLOSE_THRESHOLD } = await loadSupervisor();
    const justBelow = decideHeartbeatClose(true, HEARTBEAT_BENIGN_CLOSE_THRESHOLD - 2);
    expect(justBelow.action).toBe("rearm");
    const atThreshold = decideHeartbeatClose(true, HEARTBEAT_BENIGN_CLOSE_THRESHOLD - 1);
    expect(atThreshold.action).toBe("fallback-to-polling");
  });
});

describe("shouldRearmHeartbeat (staleness guards)", () => {
  test("re-arms when nothing has changed: same pid, no heartbeat WS yet, still chrome_up", async () => {
    const { shouldRearmHeartbeat } = await loadSupervisor();
    expect(shouldRearmHeartbeat(123, 123, null, "chrome_up")).toBe(true);
  });

  test("refuses when the pid changed (Chrome was relaunched during the delay)", async () => {
    const { shouldRearmHeartbeat } = await loadSupervisor();
    expect(shouldRearmHeartbeat(456, 123, null, "chrome_up")).toBe(false);
  });

  test("refuses when a new heartbeat WS was already established", async () => {
    const { shouldRearmHeartbeat } = await loadSupervisor();
    expect(shouldRearmHeartbeat(123, 123, {} /* a live WebSocket */, "chrome_up")).toBe(false);
  });

  test("refuses when the target's state moved on from chrome_up", async () => {
    const { shouldRearmHeartbeat } = await loadSupervisor();
    expect(shouldRearmHeartbeat(123, 123, null, "chrome_crashed")).toBe(false);
    expect(shouldRearmHeartbeat(123, 123, null, "idle")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Layer 2 — wiring test through the real ensure()/launchChrome()/
// startHeartbeat() path.
// ---------------------------------------------------------------------------

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
    stdout: null, // empty output → getListeningPid() parses this as "nobody listening"
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
    return true; // SIGKILL etc from cleanup paths — no real process to signal
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
  const { __resetRuntimeForTest } = await loadSupervisor();
  __resetRuntimeForTest();
  globalThis.fetch = originalFetch;
  Bun.spawn = originalSpawn;
  globalThis.WebSocket = originalWebSocket;
  process.kill = originalKill;
  resetAll();
});

// ---------------------------------------------------------------------------
// Layer 3 — adversarial-review race: teardown / a competing fresh relaunch
// during startHeartbeat's in-flight fetch/json awaits (~2s in production;
// mocked here). Before the staleness guard, the awaited call would
// unconditionally execute `rt.heartbeatWs = ws` once it resumed, regardless
// of what happened in the meantime.
// ---------------------------------------------------------------------------

/** Poll `cond` until true or `timeoutMs` elapses — used where exact timer/microtask ordering isn't controllable from the test. */
async function waitUntil(cond: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error("waitUntil timed out");
    await sleepMs(5);
  }
}

/**
 * Like installFetchMock, but /json/version calls can be deferred on demand:
 * while `defer` is true, each such call returns a promise this function's
 * caller must resolve explicitly via `resolveDeferred`. Lets a test hold a
 * startHeartbeat() call's fetch in flight while it drives teardown/relaunch
 * around it — the exact race this file's Layer 2 wiring tests can't reach
 * because their fetch mock always resolves immediately.
 */
function installControllableFetchMock(): {
  setDefer: (value: boolean) => void;
  resolveDeferred: (body?: { webSocketDebuggerUrl?: string }) => void;
  deferredCount: () => number;
} {
  let defer = false;
  const pending: Array<(r: Response) => void> = [];
  globalThis.fetch = mock((url: string | URL | Request) => {
    const urlStr = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;
    if (!urlStr.includes("/json/version")) {
      return Promise.resolve(new Response("", { status: 404 }));
    }
    const respond = (body: { webSocketDebuggerUrl?: string }) =>
      new Response(JSON.stringify(body), { status: 200 });
    if (defer) {
      return new Promise<Response>((resolve) => {
        pending.push(resolve);
      });
    }
    return Promise.resolve(respond({ webSocketDebuggerUrl: "ws://127.0.0.1:9999/devtools/browser/FAKE" }));
  }) as unknown as typeof fetch;

  return {
    setDefer: (value: boolean) => {
      defer = value;
    },
    resolveDeferred: (body = { webSocketDebuggerUrl: "ws://127.0.0.1:9999/devtools/browser/STALE" }) => {
      const resolve = pending.shift();
      resolve?.(new Response(JSON.stringify(body), { status: 200 }));
    },
    deferredCount: () => pending.length,
  };
}

/**
 * A Chrome proc mock whose `.kill()` resolves its own `exited` promise, so
 * the real `kill()`/doKill() path (which awaits `proc.exited`) completes
 * quickly instead of hanging on installSpawnMock's never-resolving `exited`.
 * `exitCode` intentionally stays null — matches Bun's real behavior of not
 * synchronously updating exitCode, and exercises doKill's SIGKILL escalation
 * branch too (harmless here: `exited` is already resolved by then).
 */
function installKillableSpawnMock(chromePid: number): void {
  let resolveExited: ((code: number) => void) | null = null;
  const exited = new Promise<number>((resolve) => {
    resolveExited = resolve;
  });
  const mockChromeProc = {
    pid: chromePid,
    exitCode: null as number | null,
    exited,
    stdout: null,
    stderr: null,
    kill: mock((signal?: number) => {
      resolveExited?.(signal === 9 ? 137 : 0);
    }),
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

describe("heartbeat re-arm race guard (adversarial review — teardown/relaunch during in-flight startHeartbeat)", () => {
  test("teardown mid-flight: a stale rearm resolving after kill() must not resurrect the heartbeat, and must close its own WS", async () => {
    const ctrl = installControllableFetchMock();
    installKillableSpawnMock(65010);
    const { ensure, kill, getRuntimeSnapshot } = await loadSupervisor();

    await ensure("headed");
    expect(FakeWebSocket.instances.length).toBe(1);

    // Benign close schedules a delayed re-arm (AB_HEARTBEAT_REARM_MS=20ms).
    // Defer its fetch so we can interleave teardown while it's in flight.
    ctrl.setDefer(true);
    FakeWebSocket.instances[0].onclose?.();
    await waitUntil(() => ctrl.deferredCount() > 0);

    // Teardown races ahead of the stale rearm's still-pending fetch.
    await kill("headed");

    // Now let the stale rearm's fetch resolve.
    ctrl.resolveDeferred();
    await sleepMs(50);

    const snapshot = getRuntimeSnapshot() as Record<string, { hasHeartbeatWs: boolean; phase: string }>;
    expect(snapshot.headed.hasHeartbeatWs).toBe(false);
    expect(snapshot.headed.phase).toBe("idle");
    // The stale call's own WebSocket got created, then closed on discovering staleness.
    expect(FakeWebSocket.instances.length).toBe(2);
    expect(FakeWebSocket.instances[1].closed).toBe(true);
  }, 10_000);

  test("fresh relaunch wins the race: a stale rearm resolving afterward must not replace or orphan the new heartbeat", async () => {
    const ctrl = installControllableFetchMock();
    installKillableSpawnMock(65020);
    const { ensure, kill, getRuntimeSnapshot } = await loadSupervisor();

    await ensure("headed");
    expect(FakeWebSocket.instances.length).toBe(1);

    ctrl.setDefer(true);
    FakeWebSocket.instances[0].onclose?.();
    await waitUntil(() => ctrl.deferredCount() > 0);

    // Teardown, then a fresh relaunch (new pid) races ahead and wins its own
    // heartbeat — all while the original rearm's fetch is still pending.
    await kill("headed");
    ctrl.setDefer(false);
    installKillableSpawnMock(65021);
    await ensure("headed");

    expect(FakeWebSocket.instances.length).toBe(2);
    const winningWs = FakeWebSocket.instances[1];
    expect(winningWs.closed).toBe(false);
    let snapshot = getRuntimeSnapshot() as Record<string, { hasHeartbeatWs: boolean }>;
    expect(snapshot.headed.hasHeartbeatWs).toBe(true);

    // Now let the STALE rearm (from the original, killed Chrome) resolve.
    ctrl.resolveDeferred();
    await sleepMs(50);

    // The winning WS must be untouched; the stale call's own WS (a 3rd
    // instance) must have been closed rather than replacing/orphaning it.
    expect(FakeWebSocket.instances.length).toBe(3);
    expect(FakeWebSocket.instances[1].closed).toBe(false);
    expect(FakeWebSocket.instances[2].closed).toBe(true);
    snapshot = getRuntimeSnapshot() as Record<string, { hasHeartbeatWs: boolean }>;
    expect(snapshot.headed.hasHeartbeatWs).toBe(true);
  }, 10_000);
});

describe("heartbeat re-arm wiring (real ensure() -> launchChrome() -> startHeartbeat())", () => {
  test("benign close (pid alive) re-arms the heartbeat — a new WebSocket is opened again", async () => {
    installSpawnMock(65001);
    const { ensure, getRuntimeSnapshot } = await loadSupervisor();

    await ensure("headed");
    expect(FakeWebSocket.instances.length).toBe(1);
    const first = FakeWebSocket.instances[0];
    expect(typeof first.onclose).toBe("function");

    // Simulate a benign close: Chrome's pid is still alive (killShouldThrow=false).
    first.onclose?.();

    // Give the queued crash-check + the (test-shortened) delayed re-arm timer
    // time to run.
    await sleepMs(300);

    expect(FakeWebSocket.instances.length).toBe(2);
    const snapshot = getRuntimeSnapshot() as Record<string, { hasHeartbeatWs: boolean; phase: string }>;
    expect(snapshot.headed.hasHeartbeatWs).toBe(true);
    expect(snapshot.headed.phase).toBe("chrome_up"); // benign close never touched Chrome's up state
  }, 10_000);

  test("N rapid benign closes fall back to polling-only and stop re-arming, with a warn log", async () => {
    installSpawnMock(65002);
    const { ensure, HEARTBEAT_BENIGN_CLOSE_THRESHOLD } = await loadSupervisor();

    await ensure("headed");

    for (let i = 0; i < HEARTBEAT_BENIGN_CLOSE_THRESHOLD; i++) {
      const latest = FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
      latest.onclose?.();
      await sleepMs(300);
    }

    // Closes 1..(threshold-1) each re-arm (one new WS per close); the
    // threshold-th close gives up instead of opening a (threshold+1)th WS.
    expect(FakeWebSocket.instances.length).toBe(HEARTBEAT_BENIGN_CLOSE_THRESHOLD);

    const logs = getRecentLogs();
    expect(
      logs.some(
        (e) => e.level === "warn" && typeof e.msg === "string" && e.msg.includes("falling back to polling-only"),
      ),
    ).toBe(true);
  }, 10_000);

  test("close with a dead pid triggers crash handling — never re-arms", async () => {
    installSpawnMock(65003);
    const { ensure, getRuntimeSnapshot } = await loadSupervisor();

    await ensure("headed");
    expect(FakeWebSocket.instances.length).toBe(1);

    killShouldThrow = true; // Chrome's pid now reads as dead
    FakeWebSocket.instances[0].onclose?.();
    await sleepMs(300);

    // No re-arm attempted — the WS instance count never grows past 1.
    expect(FakeWebSocket.instances.length).toBe(1);
    const snapshot = getRuntimeSnapshot() as Record<string, { phase: string; hasHeartbeatWs: boolean }>;
    // "headed" is on-demand policy: handleCrashDetected settles straight to
    // idle rather than scheduling a restart. Either way it must have left
    // chrome_up — that's the existing crash-handling behavior, unchanged.
    expect(snapshot.headed.phase).not.toBe("chrome_up");
    expect(snapshot.headed.hasHeartbeatWs).toBe(false);
  }, 10_000);
});
