/**
 * Threshold → probe → cooldown + backoff/retryNotBefore tests — FINAL
 * CONSENSUS SPEC (2026-08-04 heartbeat-close-storm follow-up).
 *
 * Covers the landmines the design review explicitly flagged:
 *  - Failure accounting (backoffMs bump + retryNotBefore) happens exactly
 *    once per process generation, in handleExit XOR handleCrashDetected —
 *    never both, for the same death.
 *  - Intentional teardown (doKill) never bumps backoff or writes lastExit.
 *  - Spawn success never resets backoff — only the stable-uptime timer does.
 *  - The ensure() gate fails fast (RetryAfterError) instead of sleeping on
 *    the shared opQueue, so one target's backoff window never blocks
 *    another target's ensure()/kill().
 *  - A stale probe result (generation bumped mid-probe, e.g. by a teardown)
 *    is discarded silently — never resurrects a decision for dead state.
 *  - Probe success -> cooldown; both probes failing -> recycle (handleCrashDetected,
 *    reason "ws-probe-failed").
 *  - The cooldown retry timer is gated by shouldRearmHeartbeat, same as the
 *    short re-arm timer — a stale cooldown can't resurrect anything either.
 *
 * Env overrides set BEFORE chrome-supervisor is ever imported (dynamically,
 * in every test below), matching heartbeat-rearm.test.ts's established
 * pattern, so these run in milliseconds instead of real minutes.
 * bun test --isolate runs this file in a fresh global env.
 */
process.env.AB_HEARTBEAT_REARM_MS = "15";
process.env.AB_PROBE_TIMEOUT_MS = "300";
process.env.AB_HEARTBEAT_COOLDOWN_MS = "300";
process.env.AB_BACKOFF_STABLE_RESET_MS = "50";

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { getRecentLogs } from "../logger";
import { getState, resetAll } from "../state";

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitUntil(cond: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error("waitUntil timed out");
    await sleepMs(5);
  }
}

async function loadSupervisor() {
  return import("../chrome-supervisor");
}

// ---------------------------------------------------------------------------
// Fakes — a WebSocket capable enough for BOTH the heartbeat connection
// (onclose-driven) and probeBrowserWs's request/response protocol
// (onopen -> send -> onmessage with matching id). Real production code
// never distinguishes these; a probe just opens its own fresh WebSocket.
// ---------------------------------------------------------------------------

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  url: string;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  closed = false;
  sent: string[] = [];
  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
    // Simulate an async connect — fires after the constructor's caller has
    // finished assigning onopen/onmessage/onerror/onclose synchronously.
    queueMicrotask(() => {
      if (!this.closed) this.onopen?.();
    });
  }
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.closed = true;
  }
  /** Test helper: reply to whatever CDP request was last sent, with a matching id (probe success). */
  respondToLastSend(): void {
    const last = this.sent[this.sent.length - 1];
    if (!last) return;
    const parsed = JSON.parse(last) as { id: number };
    this.onmessage?.({ data: JSON.stringify({ id: parsed.id, result: {} }) });
  }
}

const originalFetch = globalThis.fetch;
const originalSpawn = Bun.spawn;
const originalWebSocket = globalThis.WebSocket;
const originalKill = process.kill;

let killShouldThrow = false;
// FIX 2 regression knob: when true, the /json/version fetch used by
// startHeartbeat's cooldown retry rejects outright (outer catch path), so a
// test can prove a failed cooldown-retry setup still re-arms a new cooldown
// timer instead of leaving heartbeatMode stuck at "cooldown" forever.
let failVersionFetch = false;

function installFetchMock(): void {
  globalThis.fetch = mock((url: string | URL | Request) => {
    const urlStr = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;
    if (urlStr.includes("/json/version")) {
      if (failVersionFetch) {
        return Promise.reject(new Error("mocked /json/version fetch failure"));
      }
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
    signalCode: null as string | null,
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

/**
 * A Chrome proc mock that lets the test simulate either an intentional kill
 * (via `.kill()`, which resolves `exited` — mirrors installKillableSpawnMock
 * in heartbeat-rearm.test.ts) or Chrome dying on its own (via
 * `triggerExit`, which never goes through `.kill()`). `exitCode`/`signalCode`
 * are updated before `exited` resolves, matching Bun's real behavior — this
 * is what lets handleExit's lastExit recording be exercised faithfully.
 */
function installExitableSpawnMock(chromePid: number): {
  triggerExit: (exitCode: number | null, signalCode: string | null) => void;
} {
  let resolveExited: ((code: number) => void) | null = null;
  const exited = new Promise<number>((resolve) => {
    resolveExited = resolve;
  });
  const mockChromeProc = {
    pid: chromePid,
    exitCode: null as number | null,
    signalCode: null as string | null,
    exited,
    stdout: null,
    stderr: null,
    kill: mock((signal?: number) => {
      mockChromeProc.exitCode = signal === 9 ? null : 0;
      mockChromeProc.signalCode = signal === 9 ? "SIGKILL" : null;
      resolveExited?.(mockChromeProc.exitCode ?? 0);
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
  return {
    triggerExit: (exitCode, signalCode) => {
      mockChromeProc.exitCode = exitCode;
      mockChromeProc.signalCode = signalCode;
      resolveExited?.(exitCode ?? 0);
    },
  };
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
  failVersionFetch = false;
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
// RetryAfterError / ensure gate (item 7)
// ---------------------------------------------------------------------------

describe("ensure() gate — RetryAfterError, fail-fast, never sleeps the shared opQueue", () => {
  test("ensure() rejects immediately with RetryAfterError while retryNotBefore is in the future", async () => {
    installSpawnMock(71001);
    const { ensure, RetryAfterError, getRuntimeSnapshot } = await loadSupervisor();

    await ensure("headless-1");
    const heartbeat = FakeWebSocket.instances[0];

    // Dead pid on close -> handleCrashDetected -> bumps backoff/retryNotBefore.
    killShouldThrow = true;
    heartbeat.onclose?.();
    await sleepMs(50);

    const snap = getRuntimeSnapshot() as Record<string, { retryNotBefore: number }>;
    expect(snap["headless-1"].retryNotBefore).toBeGreaterThan(Date.now());

    const start = Date.now();
    let caught: unknown = null;
    try {
      await ensure("headless-1");
    } catch (err) {
      caught = err;
    }
    const elapsed = Date.now() - start;

    expect(caught).toBeInstanceOf(RetryAfterError);
    expect((caught as InstanceType<typeof RetryAfterError>).retryAfterMs).toBeGreaterThan(0);
    // Fail-fast: rejects near-instantly, never sleeps for the backoff window.
    expect(elapsed).toBeLessThan(200);
  }, 10_000);

  test("a target in backoff never blocks a concurrent ensure() for a different target (opQueue not held)", async () => {
    installSpawnMock(71002);
    const { ensure, RetryAfterError } = await loadSupervisor();

    await ensure("headless-1");
    const heartbeat = FakeWebSocket.instances[0];
    killShouldThrow = true;
    heartbeat.onclose?.();
    await sleepMs(50);

    // headless-1 is now backing off. A concurrent ensure() for headless-2
    // must still complete quickly — proving the RetryAfterError throw
    // inside launchChrome never blocks opQueue's shared serial tail.
    const start = Date.now();
    const [r1, r2] = await Promise.allSettled([ensure("headless-1"), ensure("headless-2")]);
    const elapsed = Date.now() - start;

    expect(r1.status).toBe("rejected");
    if (r1.status === "rejected") expect(r1.reason).toBeInstanceOf(RetryAfterError);
    expect(r2.status).toBe("fulfilled");
    expect(elapsed).toBeLessThan(500);
  }, 10_000);
});

// ---------------------------------------------------------------------------
// Failure accounting — exactly once per generation (item 6)
// ---------------------------------------------------------------------------

describe("failure accounting bumps backoff/retryNotBefore exactly once per death", () => {
  test("crash-detected path (dead pid via heartbeat close): the cascading exit never double-bumps", async () => {
    installSpawnMock(71003);
    const { ensure, getRuntimeSnapshot } = await loadSupervisor();

    await ensure("headless-1");
    const before = (getRuntimeSnapshot() as Record<string, { backoffMs: number }>)["headless-1"];
    expect(before.backoffMs).toBe(1_000);

    killShouldThrow = true;
    FakeWebSocket.instances[0].onclose?.();
    await sleepMs(50);

    const after = (getRuntimeSnapshot() as Record<
      string,
      { backoffMs: number; lastDetection: { reason: string } | null }
    >)["headless-1"];
    // Doubled exactly once (1000 -> 2000), not twice (would be 4000 if both
    // handleCrashDetected AND the cascading proc.exited's handleExit bumped).
    expect(after.backoffMs).toBe(2_000);
    expect(after.lastDetection?.reason).toBe("heartbeat-close-pid-dead");
  }, 10_000);

  test("exit path only (Chrome dies on its own, not via supervisor kill): bumps once, records lastExit verbatim (never synthesized)", async () => {
    const ctrl = installExitableSpawnMock(71004);
    const { ensure, getRuntimeSnapshot } = await loadSupervisor();

    await ensure("headless-1");
    const before = (getRuntimeSnapshot() as Record<string, { backoffMs: number }>)["headless-1"];
    expect(before.backoffMs).toBe(1_000);

    ctrl.triggerExit(null, "SIGKILL"); // signal death: code null XOR signal set
    await sleepMs(50);

    const after = (getRuntimeSnapshot() as Record<
      string,
      { backoffMs: number; lastExit: { code: number | null; signal: string | null; at: string } | null }
    >)["headless-1"];
    expect(after.backoffMs).toBe(2_000);
    expect(after.lastExit).not.toBeNull();
    expect(after.lastExit?.code).toBeNull();
    expect(after.lastExit?.signal).toBe("SIGKILL");
  }, 10_000);

  test("intentional kill() never bumps backoff or writes lastExit", async () => {
    installSpawnMock(71005);
    const { ensure, kill, getRuntimeSnapshot } = await loadSupervisor();

    await ensure("headless-1");
    const before = (getRuntimeSnapshot() as Record<string, { backoffMs: number }>)["headless-1"];
    expect(before.backoffMs).toBe(1_000);

    await kill("headless-1");
    await sleepMs(50);

    const after = (getRuntimeSnapshot() as Record<
      string,
      { backoffMs: number; lastExit: unknown; retryNotBefore: number }
    >)["headless-1"];
    expect(after.backoffMs).toBe(1_000);
    expect(after.lastExit).toBeNull();
    expect(after.retryNotBefore).toBe(0);
  }, 10_000);
});

// ---------------------------------------------------------------------------
// Spawn success does not reset backoff (item 6) — only the stable timer does.
// ---------------------------------------------------------------------------

describe("spawn success never resets backoff — only surviving the stable window does", () => {
  test("a fresh successful relaunch after a crash keeps the bumped backoff until AB_BACKOFF_STABLE_RESET_MS elapses", async () => {
    installSpawnMock(71006);
    const { ensure, getRuntimeSnapshot } = await loadSupervisor();

    await ensure("headless-1");
    killShouldThrow = true;
    FakeWebSocket.instances[0].onclose?.();
    await sleepMs(50);

    let snap = (getRuntimeSnapshot() as Record<string, { backoffMs: number; retryNotBefore: number }>)["headless-1"];
    expect(snap.backoffMs).toBe(2_000);

    // Wait past retryNotBefore (backoffMs was 1000 at bump time) so ensure() doesn't hit the gate.
    await waitUntil(() => Date.now() >= snap.retryNotBefore, 3_000);
    killShouldThrow = false;

    await ensure("headless-1"); // spawn success
    snap = (getRuntimeSnapshot() as Record<string, { backoffMs: number; retryNotBefore: number }>)["headless-1"];
    // Immediately after a successful relaunch, backoff is UNCHANGED — spawn
    // success alone never resets it.
    expect(snap.backoffMs).toBe(2_000);

    // Only after surviving AB_BACKOFF_STABLE_RESET_MS (50ms) does it reset.
    await waitUntil(() => {
      const s = (getRuntimeSnapshot() as Record<string, { backoffMs: number }>)["headless-1"];
      return s.backoffMs === 1_000;
    }, 3_000);
  }, 10_000);
});

// ---------------------------------------------------------------------------
// Probe wiring on a headless (probe-eligible) target.
// ---------------------------------------------------------------------------

async function driveToThreshold(_target: "headless-1", threshold: number): Promise<void> {
  for (let i = 0; i < threshold; i++) {
    const latest = FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
    latest.onclose?.();
    await sleepMs(50);
  }
}

describe("threshold -> probe wiring (headless target, probe-eligible)", () => {
  test("both probes fail -> recycle: handleCrashDetected fires with reason ws-probe-failed", async () => {
    installSpawnMock(71007);
    const { ensure, HEARTBEAT_BENIGN_CLOSE_THRESHOLD, getHealthDiagnostics } = await loadSupervisor();

    await ensure("headless-1");
    await driveToThreshold("headless-1", HEARTBEAT_BENIGN_CLOSE_THRESHOLD);

    // Two probe attempts follow (neither ever gets a respondToLastSend()),
    // each timing out after AB_PROBE_TIMEOUT_MS (40ms).
    await waitUntil(() => FakeWebSocket.instances.length >= HEARTBEAT_BENIGN_CLOSE_THRESHOLD + 2, 3_000);
    await waitUntil(() => getState("headless-1").phase !== "chrome_up", 3_000);

    expect(getState("headless-1").phase).not.toBe("chrome_up");
    expect(getHealthDiagnostics()["headless-1"].lastDetection?.reason).toBe("ws-probe-failed");

    const logs = getRecentLogs();
    expect(logs.some((e) => typeof e.msg === "string" && e.msg.includes("probing browser WS"))).toBe(true);
    expect(logs.some((e) => typeof e.msg === "string" && e.msg.includes("Browser WS probes failed"))).toBe(true);
  }, 10_000);

  test("probe 1 succeeds (short-circuit) -> cooldown: Chrome is NOT recycled, cooldown timer armed", async () => {
    installSpawnMock(71008);
    const { ensure, HEARTBEAT_BENIGN_CLOSE_THRESHOLD, getRuntimeSnapshot } = await loadSupervisor();

    await ensure("headless-1");
    await driveToThreshold("headless-1", HEARTBEAT_BENIGN_CLOSE_THRESHOLD);

    // The probe's own WebSocket appears after the threshold close.
    await waitUntil(() => FakeWebSocket.instances.length > HEARTBEAT_BENIGN_CLOSE_THRESHOLD, 3_000);
    const probeWs = FakeWebSocket.instances[HEARTBEAT_BENIGN_CLOSE_THRESHOLD];
    await waitUntil(() => probeWs.sent.length > 0, 3_000); // wait for onopen -> send
    probeWs.respondToLastSend(); // probe 1 succeeds

    await waitUntil(() => {
      const s = (getRuntimeSnapshot() as Record<string, { heartbeatMode: string }>)["headless-1"];
      return s.heartbeatMode === "cooldown";
    }, 3_000);

    // Only probe 1 ran — decideProbeOutcome short-circuits on first success.
    expect(FakeWebSocket.instances.length).toBe(HEARTBEAT_BENIGN_CLOSE_THRESHOLD + 1);
    expect(getState("headless-1").phase).toBe("chrome_up"); // never killed
    const snap = (getRuntimeSnapshot() as Record<string, { hasHeartbeatCooldownTimer: boolean }>)["headless-1"];
    expect(snap.hasHeartbeatCooldownTimer).toBe(true);

    const logs = getRecentLogs();
    expect(logs.some((e) => typeof e.msg === "string" && e.msg.includes("probe succeeded despite"))).toBe(true);
  }, 10_000);

  test("stale probe result (teardown mid-probe bumps generation) is discarded silently", async () => {
    installSpawnMock(71009);
    const { ensure, HEARTBEAT_BENIGN_CLOSE_THRESHOLD, kill, getRuntimeSnapshot } = await loadSupervisor();

    await ensure("headless-1");
    await driveToThreshold("headless-1", HEARTBEAT_BENIGN_CLOSE_THRESHOLD);

    // Probe 1 is now in flight (never resolved yet — no respondToLastSend()).
    await waitUntil(() => FakeWebSocket.instances.length > HEARTBEAT_BENIGN_CLOSE_THRESHOLD, 3_000);

    // Teardown races ahead of the in-flight probe — bumps heartbeatGeneration.
    await kill("headless-1");
    expect(getState("headless-1").phase).toBe("idle");

    // Let the probe's timeout (and any success, if we resolved it) play out
    // and its continuation re-enqueue onto opQueue.
    await sleepMs(150);

    // Teardown's outcome must be untouched by whatever the probe decided.
    expect(getState("headless-1").phase).toBe("idle");
    const snap = (getRuntimeSnapshot() as Record<string, { heartbeatMode: string; hasHeartbeatWs: boolean }>)[
      "headless-1"
    ];
    // The probe's eventual outcome (recycle or cooldown, whichever it was)
    // must never have been applied — teardown's "off"/idle state is final.
    // (Not asserting on the "Stale probe result" log line itself: it's
    // logged at debug level, which this file's Logger filters below its
    // default minLevel — same reason no other test in this repo asserts on
    // a log.debug call. State is the load-bearing assertion here.)
    expect(snap.heartbeatMode).toBe("off");
    expect(snap.hasHeartbeatWs).toBe(false);
  }, 10_000);
});

// ---------------------------------------------------------------------------
// Cooldown retry — gated by shouldRearmHeartbeat, same as the short re-arm.
// ---------------------------------------------------------------------------

describe("cooldown retry timer is gated by shouldRearmHeartbeat", () => {
  test("fires startHeartbeat and re-arms when nothing has changed (headed, direct cooldown)", async () => {
    installSpawnMock(71010);
    const { ensure, HEARTBEAT_BENIGN_CLOSE_THRESHOLD, getRuntimeSnapshot } = await loadSupervisor();

    await ensure("headed"); // headed always skips probing -> cooldown directly
    for (let i = 0; i < HEARTBEAT_BENIGN_CLOSE_THRESHOLD; i++) {
      const latest = FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
      latest.onclose?.();
      await sleepMs(50);
    }

    let snap = (getRuntimeSnapshot() as Record<string, { heartbeatMode: string }>).headed;
    expect(snap.heartbeatMode).toBe("cooldown");
    const countBeforeRetry = FakeWebSocket.instances.length;

    // AB_HEARTBEAT_COOLDOWN_MS=300ms — wait for the retry timer to fire.
    await waitUntil(() => FakeWebSocket.instances.length > countBeforeRetry, 3_000);
    await waitUntil(() => {
      snap = (getRuntimeSnapshot() as Record<string, { heartbeatMode: string }>).headed;
      return snap.heartbeatMode === "armed";
    }, 3_000);
  }, 10_000);

  test("kill() while in cooldown cancels the pending retry — clearTimers clears heartbeatCooldownTimer, no stray re-arm after teardown", async () => {
    installSpawnMock(71011);
    const { ensure, kill, HEARTBEAT_BENIGN_CLOSE_THRESHOLD, getRuntimeSnapshot } = await loadSupervisor();

    await ensure("headed");
    for (let i = 0; i < HEARTBEAT_BENIGN_CLOSE_THRESHOLD; i++) {
      const latest = FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
      latest.onclose?.();
      await sleepMs(50);
    }
    let snap = (getRuntimeSnapshot() as Record<string, { heartbeatMode: string; hasHeartbeatCooldownTimer: boolean }>)
      .headed;
    expect(snap.heartbeatMode).toBe("cooldown");
    expect(snap.hasHeartbeatCooldownTimer).toBe(true);
    const countBeforeTeardown = FakeWebSocket.instances.length;

    // Teardown while the retry timer is still pending — clearTimers (item 4)
    // must cancel it, not just leave it to no-op later via shouldRearmHeartbeat.
    await kill("headed");
    snap = (getRuntimeSnapshot() as Record<string, { heartbeatMode: string; hasHeartbeatCooldownTimer: boolean }>)
      .headed;
    expect(snap.heartbeatMode).toBe("off");
    expect(snap.hasHeartbeatCooldownTimer).toBe(false);

    // Past what would have been the retry point — no stray WebSocket from a
    // timer that should have been cancelled, not merely guarded.
    await sleepMs(400); // > AB_HEARTBEAT_COOLDOWN_MS (300ms)
    expect(FakeWebSocket.instances.length).toBe(countBeforeTeardown);
  }, 10_000);
});

// ---------------------------------------------------------------------------
// FIX 2 — cooldown is never terminal, even if the retry's OWN setup fails.
// ---------------------------------------------------------------------------

describe("cooldown retry setup failure re-arms a new cooldown timer (FIX 2 — never terminal)", () => {
  test("cooldown timer fires, mocked fetch fails -> mode stays cooldown AND a fresh cooldown timer is armed (not stuck)", async () => {
    installSpawnMock(71012);
    const { ensure, HEARTBEAT_BENIGN_CLOSE_THRESHOLD, getRuntimeSnapshot } = await loadSupervisor();

    await ensure("headed"); // headed always skips probing -> cooldown directly
    for (let i = 0; i < HEARTBEAT_BENIGN_CLOSE_THRESHOLD; i++) {
      const latest = FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
      latest.onclose?.();
      await sleepMs(50);
    }

    let snap = (getRuntimeSnapshot() as Record<string, { heartbeatMode: string; hasHeartbeatCooldownTimer: boolean }>)
      .headed;
    expect(snap.heartbeatMode).toBe("cooldown");
    expect(snap.hasHeartbeatCooldownTimer).toBe(true);

    // Make the cooldown retry's own /json/version fetch fail (outer catch
    // branch of startHeartbeat) — this is the scenario where, before the
    // fix, heartbeatMode stayed "cooldown" but heartbeatCooldownTimer was
    // never re-armed: permanently stuck with zero pending timers.
    failVersionFetch = true;

    // AB_HEARTBEAT_COOLDOWN_MS=300ms — wait for the retry timer to fire and fail.
    await waitUntil(() => {
      const logs = getRecentLogs();
      return logs.some((e) => typeof e.msg === "string" && e.msg.includes("Cooldown retry setup failed"));
    }, 3_000);

    snap = (getRuntimeSnapshot() as Record<string, { heartbeatMode: string; hasHeartbeatCooldownTimer: boolean }>)
      .headed;
    // Never terminal: still "cooldown" (not stuck in some other mode), AND a
    // brand-new cooldown timer is armed — proof the retry-on-retry-failure
    // path actually re-entered cooldown instead of just returning.
    expect(snap.heartbeatMode).toBe("cooldown");
    expect(snap.hasHeartbeatCooldownTimer).toBe(true);

    // Prove the re-armed timer is a REAL, live retry — not just a mode flag
    // that happens to say "cooldown" — by letting the NEXT cooldown cycle
    // succeed and observing the heartbeat actually come back up.
    failVersionFetch = false;
    await waitUntil(() => {
      const s = (getRuntimeSnapshot() as Record<string, { heartbeatMode: string }>).headed;
      return s.heartbeatMode === "armed";
    }, 3_000);
  }, 10_000);
});
