/**
 * A Chrome we did not spawn keeps answering CDP on our port while its pid
 * flaps (dies, comes back). Each death bumps backoffMs. Once backoffMs reaches
 * BACKOFF_MAX_MS, launchChrome used to treat the responsive occupant as a
 * crash loop: refuse to adopt it and refuse to kill it (not ours), so the
 * shard stayed down for good and backoffMs never reset.
 *
 * Mocks only the outer boundaries (fetch, Bun.spawn for lsof, WebSocket,
 * process.kill), as in chrome-supervisor-ownership.test.ts. Run with
 * `bun test --isolate`: the backoff env knobs are read at module load.
 */
import { mkdtempSync, rmSync } from "fs";
import * as os from "os";
import * as path from "path";

const TMP_ROOT = mkdtempSync(path.join(os.tmpdir(), "ab-adopt-flap-"));
process.env.AB_PROFILE_ROOT = TMP_ROOT;
process.env.AB_BACKOFF_INITIAL_MS = "10";
process.env.AB_BACKOFF_MAX_MS = "40";
process.env.AB_BACKOFF_STABLE_RESET_MS = "300";

import { afterAll, afterEach, beforeAll, beforeEach, expect, mock, test } from "bun:test";
import { getState, resetAll } from "../state";

// On-demand shard: a crash marks it idle without scheduling a restart, so the
// test drives every relaunch itself.
const TARGET = "headless-1" as const;
const FOREIGN_PID = 434_343;

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitUntil(cond: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error("waitUntil timed out");
    await sleepMs(5);
  }
}

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public url: string) {
    FakeWebSocket.instances.push(this);
  }
  close(): void {}
}

const originalFetch = globalThis.fetch;
const originalSpawn = Bun.spawn;
const originalWebSocket = globalThis.WebSocket;
const originalKill = process.kill;

let killCalls: Array<[number, string | number | undefined]> = [];
let pidGone = false;
let chromeSpawned = false;

function installMocks(): void {
  globalThis.fetch = mock((url: string | URL | Request) => {
    const urlStr = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;
    if (!urlStr.includes("/json/version")) return Promise.resolve(new Response("", { status: 404 }));
    return Promise.resolve(
      new Response(JSON.stringify({ webSocketDebuggerUrl: "ws://127.0.0.1:1/devtools/browser/FAKE" }), { status: 200 }),
    );
  }) as unknown as typeof fetch;

  // @ts-expect-error — test mock, narrower than Bun.spawn's overload set
  Bun.spawn = mock((cmd: string[]) => {
    if (cmd[0] === "/usr/bin/pgrep") {
      // Occupant command line unreadable: the stock-Chrome check cannot match, so it is adopted.
      return { pid: -1, exitCode: 1, exited: Promise.resolve(1), stdout: new Response("").body, stderr: null, kill: mock(() => {}) };
    }
    if (cmd[0] !== "/usr/sbin/lsof") {
      chromeSpawned = true;
      throw new Error(`unexpected spawn: ${cmd[0]}`);
    }
    return {
      pid: -1,
      exitCode: 0,
      exited: Promise.resolve(0),
      stdout: new Response(`${FOREIGN_PID}\n`).body,
      stderr: null,
      kill: mock(() => {}),
    };
  });

  // @ts-expect-error — test mock
  globalThis.WebSocket = FakeWebSocket;

  process.kill = ((pid: number, signal?: string | number) => {
    killCalls.push([pid, signal]);
    if (signal === 0 && pidGone) {
      const err = new Error("kill ESRCH") as NodeJS.ErrnoException;
      err.code = "ESRCH";
      throw err;
    }
    return true;
  }) as typeof process.kill;
}

type Snap = { phase: string; adoptedPid: number | null; backoffMs: number; retryNotBefore: number };

let sup: typeof import("../chrome-supervisor");

function snap(): Snap {
  return (sup.getRuntimeSnapshot() as Record<string, Snap>)[TARGET];
}

beforeAll(async () => {
  sup = await import("../chrome-supervisor");
  if (!sup.__getProfilePathForTest(TARGET).startsWith(TMP_ROOT)) {
    throw new Error(`SAFETY GUARD: ${TARGET} profile is not under ${TMP_ROOT} — run with --isolate`);
  }
});

beforeEach(() => {
  resetAll();
  FakeWebSocket.instances = [];
  killCalls = [];
  pidGone = false;
  chromeSpawned = false;
  installMocks();
});

afterEach(() => {
  sup.__resetRuntimeForTest();
  globalThis.fetch = originalFetch;
  Bun.spawn = originalSpawn;
  globalThis.WebSocket = originalWebSocket;
  process.kill = originalKill;
  resetAll();
});

afterAll(() => {
  try { rmSync(TMP_ROOT, { recursive: true, force: true }); } catch { /* best effort */ }
});

test("a responsive foreign Chrome is re-adopted at max backoff, and the stable window resets backoff", async () => {
  const { ensure } = sup;

  // Adopt, then let the adopted pid "die" until backoff reaches the max (10 -> 20 -> 40).
  for (let cycle = 0; cycle < 2; cycle++) {
    const ws = FakeWebSocket.instances.length;
    const r = await ensure(TARGET);
    expect(r.pid).toBe(FOREIGN_PID);
    await waitUntil(() => FakeWebSocket.instances.length > ws);
    pidGone = true;
    FakeWebSocket.instances[FakeWebSocket.instances.length - 1].onclose?.();
    await waitUntil(() => getState(TARGET).phase === "idle");
    pidGone = false;
    const { retryNotBefore } = snap();
    await sleepMs(Math.max(0, retryNotBefore - Date.now()) + 5);
  }
  expect(snap().backoffMs).toBe(40);

  // The occupant still answers CDP: adopt it again instead of refusing.
  const result = await ensure(TARGET);
  expect(result.pid).toBe(FOREIGN_PID);
  expect(getState(TARGET).phase).toBe("chrome_up");
  expect(snap().adoptedPid).toBe(FOREIGN_PID);
  expect(chromeSpawned).toBe(false);
  expect(killCalls.filter(([p, s]) => p === FOREIGN_PID && s !== 0)).toEqual([]);

  // Staying up for the stable window resets backoff.
  await waitUntil(() => snap().backoffMs === 10, 2_000);
});
