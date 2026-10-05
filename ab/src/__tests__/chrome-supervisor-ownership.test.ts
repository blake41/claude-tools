/**
 * Ownership rule: the supervisor never signals a Chrome it did not spawn.
 *
 * Incident (see /tmp/ab-server-error.log, 2026-10): a second ab-server (a
 * test daemon on the same CDP ports) adopted the live daemon's Chrome via
 * launchChrome's "Adopting existing Chrome" path, then SIGKILLed it from
 * doKill on shutdown. The live daemon saw "Chrome exited ... SIGKILL" with no
 * `killedBy: supervisor` line. The reverse also happened: the occupant branch
 * killed a still-booting Chrome it took for "unresponsive".
 *
 * These tests drive the real ensure()/stopAll()/heartbeat paths and mock only
 * the outermost boundaries: fetch (CDP /json/version), Bun.spawn (lsof and
 * Chrome), WebSocket (heartbeat), and process.kill. No real process is ever
 * signalled; no real network call reaches a CDP port.
 *
 * Safety: AB_PROFILE_ROOT points every target's profile at a tmp dir, set
 * before chrome-supervisor is imported, and a guard refuses to run if the
 * resolved headless-0 profile is not under it. Run this file with
 * `bun test --isolate` (or alone) so module-level env knobs are honoured.
 */
import { mkdtempSync, rmSync } from "fs";
import * as os from "os";
import * as path from "path";

const TMP_ROOT = mkdtempSync(path.join(os.tmpdir(), "ab-ownership-"));
process.env.AB_PROFILE_ROOT = TMP_ROOT;
// Large initial backoff: a scheduled restart must not fire mid-test.
process.env.AB_BACKOFF_INITIAL_MS = "60000";
process.env.AB_BACKOFF_MAX_MS = "600000";
// Fast heartbeat re-arm and WS probes so the ws-probe-failed path runs in well under a second.
process.env.AB_HEARTBEAT_REARM_MS = "15";
process.env.AB_PROBE_TIMEOUT_MS = "100";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { getState, resetAll } from "../state";

const TARGET = "headless-0" as const;
const FOREIGN_PID = 424_242;
const SPAWNED_PID = 515_151;

async function loadSupervisor() {
  return import("../chrome-supervisor");
}

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitUntil(cond: () => boolean, timeoutMs = 8_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error("waitUntil timed out");
    await sleepMs(10);
  }
}

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  url: string;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }
  close(): void {}
}

const originalFetch = globalThis.fetch;
const originalSpawn = Bun.spawn;
const originalWebSocket = globalThis.WebSocket;
const originalKill = process.kill;

/** Every process.kill call: [pid, signal]. */
let killCalls: Array<[number, string | number | undefined]> = [];
/** When true, process.kill(pid, 0) throws ESRCH (the pid is gone). */
let pidGone = false;
/** CDP /json/version answers only when this returns true. */
let cdpUp: () => boolean = () => true;
/** PID lsof reports as listening on the port, or null for "nothing bound". */
let listeningPid: number | null = FOREIGN_PID;
let chromeProc: { pid: number; kill: ReturnType<typeof mock>; exitCode: number | null } | null = null;
/** What `pgrep -lf` prints ("<pid> <args>" lines). Empty: no command line is readable. */
let pgrepOutput = "";
let pgrepCalls = 0;

function installMocks(): void {
  globalThis.fetch = mock((url: string | URL | Request) => {
    const urlStr = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;
    if (!urlStr.includes("/json/version")) return Promise.resolve(new Response("", { status: 404 }));
    if (!cdpUp()) return Promise.reject(new Error("ECONNREFUSED"));
    return Promise.resolve(
      new Response(JSON.stringify({ webSocketDebuggerUrl: "ws://127.0.0.1:1/devtools/browser/FAKE" }), {
        status: 200,
      }),
    );
  }) as unknown as typeof fetch;

  // @ts-expect-error — test mock, narrower than Bun.spawn's overload set
  Bun.spawn = mock((cmd: string[]) => {
    if (cmd[0] === "/usr/bin/pgrep") {
      pgrepCalls++;
      return {
        pid: -1,
        exitCode: pgrepOutput ? 0 : 1,
        exited: Promise.resolve(pgrepOutput ? 0 : 1),
        stdout: new Response(pgrepOutput).body,
        stderr: null,
        kill: mock(() => {}),
      };
    }
    if (cmd[0] === "agent-browser") {
      return { pid: -1, exitCode: 0, exited: Promise.resolve(0), stdout: null, stderr: null, kill: mock(() => {}) };
    }
    if (cmd[0] === "/usr/sbin/lsof") {
      // getListeningPid reads `new Response(proc.stdout).text()` — needs a real stream.
      const body = listeningPid === null ? "" : `${listeningPid}\n`;
      return {
        pid: -1,
        exitCode: 0,
        exited: Promise.resolve(0),
        stdout: new Response(body).body,
        stderr: null,
        kill: mock(() => {}),
      };
    }
    let resolveExited: (code: number) => void = () => {};
    const proc = {
      pid: SPAWNED_PID,
      exitCode: null as number | null,
      exited: new Promise<number>((resolve) => {
        resolveExited = resolve;
      }),
      stdout: null,
      stderr: null,
      // Our own Chrome exits promptly when the supervisor kills it.
      kill: mock(() => {
        proc.exitCode = 0;
        resolveExited(0);
      }),
    };
    chromeProc = proc;
    return proc;
  });

  // @ts-expect-error — test mock
  globalThis.WebSocket = FakeWebSocket;

  process.kill = ((pid: number, signal?: string | number) => {
    killCalls.push([pid, signal]);
    if (signal !== 0 && pid === listeningPid) {
      // A real signal frees the port and lets the next Chrome's CDP answer.
      listeningPid = null;
      cdpUp = () => true;
    }
    if (signal === 0 && pidGone) {
      const err = new Error("kill ESRCH") as NodeJS.ErrnoException;
      err.code = "ESRCH";
      throw err;
    }
    return true;
  }) as typeof process.kill;
}

/** Real signals (anything but the signal-0 liveness probe) sent to `pid`. */
function realSignalsTo(pid: number): Array<string | number | undefined> {
  return killCalls.filter(([p, s]) => p === pid && s !== 0).map(([, s]) => s);
}

type Snap = {
  phase: string;
  adoptedPid: number | null;
  procPid: number | null;
  lastSpawnedPid: number | null;
  retryNotBefore: number;
  restartScheduled: boolean;
  hasRestartTimer: boolean;
  lastDetection: { reason: string } | null;
};

async function snap(): Promise<Snap> {
  const { getRuntimeSnapshot } = await loadSupervisor();
  return (getRuntimeSnapshot() as Record<string, Snap>)[TARGET];
}

beforeAll(async () => {
  const { __getProfilePathForTest } = await loadSupervisor();
  const profile = __getProfilePathForTest(TARGET);
  if (!profile.startsWith(TMP_ROOT)) {
    throw new Error(`SAFETY GUARD: ${TARGET} profile "${profile}" is not under ${TMP_ROOT} — run this file with --isolate`);
  }
});

beforeEach(() => {
  resetAll();
  FakeWebSocket.instances = [];
  killCalls = [];
  pidGone = false;
  cdpUp = () => true;
  listeningPid = FOREIGN_PID;
  chromeProc = null;
  pgrepOutput = "";
  pgrepCalls = 0;
  installMocks();
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

afterAll(() => {
  try { rmSync(TMP_ROOT, { recursive: true, force: true }); } catch { /* best effort */ }
});

describe("adopted Chrome (responsive CDP already on our port)", () => {
  test("ensure adopts it without a process handle; stopAll leaves it idle and never signals the PID", async () => {
    const { ensure, stopAll } = await loadSupervisor();

    const result = await ensure(TARGET);
    expect(result.pid).toBe(FOREIGN_PID);
    expect(getState(TARGET).phase).toBe("chrome_up");
    const s = await snap();
    expect(s.procPid).toBeNull();
    expect(s.adoptedPid).toBe(FOREIGN_PID);

    await stopAll();

    expect(getState(TARGET).phase).toBe("idle");
    expect(realSignalsTo(FOREIGN_PID)).toEqual([]);
    expect((await snap()).adoptedPid).toBeNull();
  });
});

describe("crash detected on an adopted Chrome", () => {
  test("heartbeat close with the pid gone: no signal, crashed, backoff armed, restart scheduled", async () => {
    const { ensure } = await loadSupervisor();
    await ensure(TARGET);
    expect((await snap()).procPid).toBeNull();
    await waitUntil(() => FakeWebSocket.instances.length > 0);

    // The adopted Chrome dies: liveness probe (signal 0) now throws ESRCH.
    pidGone = true;
    const before = Date.now();
    FakeWebSocket.instances[0].onclose?.();
    await waitUntil(() => getState(TARGET).phase === "chrome_crashed");

    const s = await snap();
    expect(s.lastDetection?.reason).toBe("heartbeat-close-pid-dead");
    expect(s.adoptedPid).toBeNull();
    expect(s.procPid).toBeNull();
    expect(s.retryNotBefore).toBeGreaterThan(before);
    expect(s.restartScheduled).toBe(true);
    expect(s.hasRestartTimer).toBe(true);
    // Only the signal-0 liveness probe ever touched the PID.
    expect(killCalls.some(([p, sig]) => p === FOREIGN_PID && sig === 0)).toBe(true);
    expect(realSignalsTo(FOREIGN_PID)).toEqual([]);
  });

  test("unresponsive but alive adopted Chrome (ws-probe-failed path): released, never signalled", async () => {
    // Drives handleCrashDetected with the pid still alive: heartbeat closes
    // until the benign-close threshold, then both browser-WS probes fail
    // (FakeWebSocket never opens, probe times out) -> recycle.
    const { ensure } = await loadSupervisor();
    const { HEARTBEAT_BENIGN_CLOSE_THRESHOLD } = await import("../chrome-heartbeat");
    await ensure(TARGET);
    await waitUntil(() => FakeWebSocket.instances.length > 0);
    for (let i = 0; i < HEARTBEAT_BENIGN_CLOSE_THRESHOLD; i++) {
      const n = FakeWebSocket.instances.length;
      FakeWebSocket.instances[n - 1].onclose?.();
      if (i < HEARTBEAT_BENIGN_CLOSE_THRESHOLD - 1) {
        await waitUntil(() => FakeWebSocket.instances.length > n);
      }
    }
    await waitUntil(() => getState(TARGET).phase === "chrome_crashed", 15_000);

    const s = await snap();
    expect(s.lastDetection?.reason).toBe("ws-probe-failed");
    expect(s.adoptedPid).toBeNull();
    expect(s.restartScheduled).toBe(true);
    expect(realSignalsTo(FOREIGN_PID)).toEqual([]);
  }, 20_000);
});

describe("port occupant that is still booting (CDP not answering yet)", () => {
  test("waits for CDP, then adopts the occupant without a process handle and never signals it", async () => {
    const { ensure } = await loadSupervisor();
    // CDP refuses for the first ~1s of the launch, then answers.
    const cdpUpAt = Date.now() + 1_000;
    cdpUp = () => Date.now() >= cdpUpAt;

    const result = await ensure(TARGET);

    expect(Date.now()).toBeGreaterThanOrEqual(cdpUpAt);
    expect(result.pid).toBe(FOREIGN_PID);
    expect(getState(TARGET).phase).toBe("chrome_up");
    const s = await snap();
    expect(s.procPid).toBeNull();
    expect(s.adoptedPid).toBe(FOREIGN_PID);
    expect(chromeProc).toBeNull(); // no Chrome of our own was spawned
    expect(realSignalsTo(FOREIGN_PID)).toEqual([]);
  }, 10_000);
});

describe("port occupant whose CDP never answers", () => {
  test("not spawned by us: never signalled; launch refused with a retry window and a recorded conflict", async () => {
    const { ensure, RetryAfterError } = await loadSupervisor();
    cdpUp = () => false;
    const backoffBefore = (await snap() as Snap & { backoffMs: number }).backoffMs;
    const before = Date.now();

    await expect(ensure(TARGET)).rejects.toBeInstanceOf(RetryAfterError);

    expect(Date.now() - before).toBeGreaterThanOrEqual(5_000); // waited for CDP first
    expect(realSignalsTo(FOREIGN_PID)).toEqual([]);
    expect(chromeProc).toBeNull();
    expect(getState(TARGET).phase).toBe("chrome_crashed");
    const s = (await snap()) as Snap & {
      backoffMs: number;
      lastPortConflict: { port: number; pid: number; reason: string } | null;
    };
    expect(s.lastPortConflict).toMatchObject({ pid: FOREIGN_PID, reason: "port-occupied-foreign" });
    expect(s.retryNotBefore).toBeGreaterThan(before);
    expect(s.restartScheduled).toBe(true); // headless-0 is always-on
    // A foreign port holder must not push us toward the crash-loop profile nuke.
    expect(s.backoffMs).toBe(backoffBefore);
  }, 15_000);

  test("our own earlier Chrome (lost handle): SIGKILLed, then a fresh owned Chrome is spawned", async () => {
    const { ensure, kill } = await loadSupervisor();
    // First launch: port free, we spawn and own SPAWNED_PID.
    listeningPid = null;
    await ensure(TARGET);
    expect((await snap()).procPid).toBe(SPAWNED_PID);
    await kill(TARGET);
    expect(chromeProc?.kill).toHaveBeenCalled();
    // The handle is gone, but the pid is still remembered as ours.
    expect(await snap()).toMatchObject({ procPid: null, lastSpawnedPid: SPAWNED_PID });

    // Our old PID is somehow still bound to the port and not answering CDP.
    listeningPid = SPAWNED_PID;
    cdpUp = () => false;
    killCalls = [];

    const result = await ensure(TARGET);

    expect(realSignalsTo(SPAWNED_PID)).toEqual(["SIGKILL"]);
    expect(result.pid).toBe(SPAWNED_PID); // the fresh spawn (mock reuses the pid)
    const s = await snap();
    expect(s.procPid).toBe(SPAWNED_PID);
    expect(s.lastSpawnedPid).toBe(SPAWNED_PID);
  }, 15_000);
});

describe("unresponsive port occupant we did not spawn: rule B (command line decides)", () => {
  const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  const cmdline = (userDataDir: string) =>
    `${FOREIGN_PID} ${CHROME} --remote-debugging-port=9333 --user-data-dir=${userDataDir} --headless=new --no-first-run\n`;

  type ConflictSnap = Snap & {
    lastPortConflict: { pid: number; reason: string; detail: string } | null;
  };

  test("its --user-data-dir is this target's own profile: SIGKILLed after the CDP wait, then we spawn", async () => {
    const { ensure, __getProfilePathForTest } = await loadSupervisor();
    cdpUp = () => false;
    pgrepOutput = `999 ${CHROME} --user-data-dir=/elsewhere\n` + cmdline(__getProfilePathForTest(TARGET));
    const before = Date.now();

    const result = await ensure(TARGET);

    expect(Date.now() - before).toBeGreaterThanOrEqual(5_000);
    expect(realSignalsTo(FOREIGN_PID)).toEqual(["SIGKILL"]);
    expect(realSignalsTo(999)).toEqual([]);
    expect(result.pid).toBe(SPAWNED_PID);
    expect((await snap()).procPid).toBe(SPAWNED_PID);
  }, 15_000);

  test("another profile path (even a sibling shard's): left alone and refused", async () => {
    const { ensure, RetryAfterError, __getProfilePathForTest } = await loadSupervisor();
    cdpUp = () => false;
    const other = `${__getProfilePathForTest(TARGET)}-1`;
    pgrepOutput = cmdline(other);

    await expect(ensure(TARGET)).rejects.toBeInstanceOf(RetryAfterError);

    expect(realSignalsTo(FOREIGN_PID)).toEqual([]);
    expect(chromeProc).toBeNull();
    const s = (await snap()) as ConflictSnap;
    expect(s.lastPortConflict).toMatchObject({ pid: FOREIGN_PID, reason: "port-occupied-foreign" });
    expect(s.lastPortConflict?.detail).toContain(other);
  }, 15_000);

  test("unreadable command line: left alone and refused", async () => {
    const { ensure, RetryAfterError } = await loadSupervisor();
    cdpUp = () => false;
    pgrepOutput = "";

    await expect(ensure(TARGET)).rejects.toBeInstanceOf(RetryAfterError);

    expect(realSignalsTo(FOREIGN_PID)).toEqual([]);
    expect(chromeProc).toBeNull();
    const s = (await snap()) as ConflictSnap;
    expect(s.lastPortConflict).toMatchObject({ pid: FOREIGN_PID, reason: "port-occupied-foreign" });
    expect(s.lastPortConflict?.detail).toContain("command line unreadable");
  }, 15_000);

  test("the refusal shows in /status diagnostics", async () => {
    const { ensure, getHealthDiagnostics } = await loadSupervisor();
    cdpUp = () => false;
    await ensure(TARGET).catch(() => {});

    expect(getHealthDiagnostics()[TARGET].lastPortConflict).toMatchObject({
      pid: FOREIGN_PID,
      reason: "port-occupied-foreign",
      detail: expect.stringContaining("command line unreadable"),
    });
  }, 15_000);

  test("retrying against the same refused pid does not wait for CDP again (no 5s hold on the op queue)", async () => {
    const { ensure, RetryAfterError, __expireRetryWindowForTest } = await loadSupervisor();
    cdpUp = () => false;
    await expect(ensure(TARGET)).rejects.toBeInstanceOf(RetryAfterError);
    __expireRetryWindowForTest(TARGET);

    const before = Date.now();
    await expect(ensure(TARGET)).rejects.toBeInstanceOf(RetryAfterError);

    expect(Date.now() - before).toBeLessThan(1_000);
    expect(realSignalsTo(FOREIGN_PID)).toEqual([]);
  }, 15_000);
});

describe("commandLineUsesProfile", () => {
  test("matches the exact --user-data-dir token, not a longer path that starts with it", async () => {
    const { commandLineUsesProfile } = await import("../chrome-occupant");
    const p = "/Users/x/.agent-browser/profile";
    expect(commandLineUsesProfile(`Chrome --user-data-dir=${p} --headless=new`, p)).toBe(true);
    expect(commandLineUsesProfile(`Chrome --user-data-dir=${p}`, p)).toBe(true);
    expect(commandLineUsesProfile(`Chrome --user-data-dir=${p}-1 --headless=new`, p)).toBe(false);
    expect(commandLineUsesProfile(`Chrome --user-data-dir=${p}/sub`, p)).toBe(false);
    expect(commandLineUsesProfile("Chrome --headless=new", p)).toBe(false);
    const spaced = "/Users/x/Application Support/ab/profile";
    expect(commandLineUsesProfile(`Chrome --user-data-dir=${spaced} --x`, spaced)).toBe(true);
  });
});

describe("classifyOccupant", () => {
  const profilePath = "/Users/x/.agent-browser/profile";
  test.each([
    ["this target's own profile", `Chrome --user-data-dir=${profilePath} --headless=new`, { kind: "own-profile" }],
    ["unreadable command line", null, { kind: "foreign", detail: "command line unreadable" }],
    ["another profile", `Chrome --user-data-dir=${profilePath}-1`, { kind: "foreign", detail: `--user-data-dir ${profilePath}-1 is not this target's profile ${profilePath}` }],
    ["no --user-data-dir at all", "Chrome --headless=new", { kind: "foreign", detail: `--user-data-dir none is not this target's profile ${profilePath}` }],
  ] as const)("%s", async (_name, cmdline, expected) => {
    const { classifyOccupant } = await import("../chrome-occupant");
    expect(classifyOccupant({ cmdline, profilePath })).toEqual(expected);
  });
});
