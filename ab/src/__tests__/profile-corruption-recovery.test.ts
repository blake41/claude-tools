/**
 * Profile corruption-recovery — restored coverage (FIX 3).
 *
 * The original version of this test drove a real Chrome profile all the way
 * to launchChrome's backoff-max corruption-recovery block (rmSync +
 * mkdirSync of `config.profilePath`) and got deleted after it wiped a REAL
 * `~/.agent-browser/profile-*` directory — CONFIGS' profilePath was
 * hardcoded to `${HOME}/.agent-browser/...` with no way for a test to point
 * it anywhere else. chrome-supervisor.test.ts's `profileFreshAfterRecovery`
 * describe block is the pure-helper substitute that has covered the DECISION
 * (does recovery override profileFresh) ever since, with an explicit doc
 * comment explaining the real path was considered too risky to test.
 *
 * AB_PROFILE_ROOT now lets every target's profilePath be redirected to a
 * disposable tmp dir at module load, so this restores real coverage of the
 * actual rmSync+mkdirSync block — against a throwaway path, never a real
 * profile.
 *
 * SAFETY: this test asserts the resolved profile path is under the tmp root
 * BEFORE calling ensure() a second time (the call that triggers the
 * destructive recovery). If that assertion doesn't hold, the test throws
 * immediately and never proceeds to any destructive step.
 *
 * bun test --isolate runs this file in a fresh global env.
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "fs";
import * as os from "os";
import * as path from "path";

const TMP_ROOT = mkdtempSync(path.join(os.tmpdir(), "ab-profile-root-"));
// A sibling directory OUTSIDE TMP_ROOT — proof nothing the recovery block
// touches ever escapes the tmp root it was given.
const CANARY_DIR = mkdtempSync(path.join(os.tmpdir(), "ab-profile-canary-"));
const CANARY_FILE = path.join(CANARY_DIR, "do-not-touch.txt");
writeFileSync(CANARY_FILE, "outside the tmp root — must survive");

process.env.AB_PROFILE_ROOT = TMP_ROOT;
// Small overrides so ONE crash cycle is enough to reach BACKOFF_MAX_MS
// (BACKOFF_INITIAL_MS doubles once: 5 -> 10 === BACKOFF_MAX_MS) instead of
// needing the real ~31s of exponential backoff.
process.env.AB_BACKOFF_INITIAL_MS = "5";
process.env.AB_BACKOFF_MAX_MS = "10";

import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { resetAll } from "../state";

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

afterAll(() => {
  try { rmSync(TMP_ROOT, { recursive: true, force: true }); } catch { /* best effort */ }
  try { rmSync(CANARY_DIR, { recursive: true, force: true }); } catch { /* best effort */ }
});

describe("launchChrome — profile corruption recovery against a disposable AB_PROFILE_ROOT (FIX 3)", () => {
  test("crash-loop backoff at max nukes and recreates the profile dir, touching nothing outside the tmp root", async () => {
    const { ensure, __getProfilePathForTest, getRuntimeSnapshot } = await import("../chrome-supervisor");

    // --- SAFETY GUARD — must run before ANY destructive step. ---
    const profilePath = __getProfilePathForTest("headless-1"); // on-demand target
    if (!profilePath.startsWith(TMP_ROOT + path.sep) && profilePath !== TMP_ROOT) {
      throw new Error(
        `SAFETY GUARD FAILED: resolved profile path "${profilePath}" is not under the disposable ` +
          `tmp root "${TMP_ROOT}" — refusing to run a destructive recovery test against it.`,
      );
    }
    expect(existsSync(CANARY_FILE)).toBe(true); // sanity: canary present before we start

    // Simulate a pre-existing (possibly corrupt) profile with real content.
    mkdirSync(profilePath, { recursive: true });
    const markerPath = path.join(profilePath, "marker.txt");
    writeFileSync(markerPath, "pre-crash profile data");
    expect(existsSync(markerPath)).toBe(true);

    // First launch: backoffMs is still AB_BACKOFF_INITIAL_MS (5ms) — not in
    // crash loop yet, so no recovery runs.
    installSpawnMock(91001);
    await ensure("headless-1");
    let snap = (getRuntimeSnapshot() as Record<string, { backoffMs: number }>)["headless-1"];
    expect(snap.backoffMs).toBe(5);
    expect(existsSync(markerPath)).toBe(true); // untouched by a healthy launch

    // Crash it: dead pid on heartbeat close -> handleCrashDetected -> bumps
    // backoffMs 5 -> 10, which equals AB_BACKOFF_MAX_MS.
    killShouldThrow = true;
    FakeWebSocket.instances[0].onclose?.();
    await sleepMs(50);

    snap = (getRuntimeSnapshot() as Record<string, { backoffMs: number; retryNotBefore: number }>)["headless-1"];
    expect(snap.backoffMs).toBe(10);
    const retryNotBefore = (getRuntimeSnapshot() as Record<string, { retryNotBefore: number }>)["headless-1"]
      .retryNotBefore;

    // Wait past the backoff window, then relaunch — THIS is the destructive
    // call: rt.backoffMs (10) >= BACKOFF_MAX_MS (10) so launchChrome's
    // corruption-recovery block runs rmSync + mkdirSync on profilePath.
    await waitUntil(() => Date.now() >= retryNotBefore, 3_000);
    killShouldThrow = false;
    const result = await ensure("headless-1");

    // Recovery ran: the old marker is gone, the dir exists fresh and empty.
    expect(existsSync(markerPath)).toBe(false);
    expect(existsSync(profilePath)).toBe(true);
    expect(readdirSync(profilePath)).toEqual([]);
    expect(result.profileFresh).toBe(true); // profileFreshAfterRecovery override

    // Backoff was reset by the recovery block itself.
    snap = (getRuntimeSnapshot() as Record<string, { backoffMs: number }>)["headless-1"];
    expect(snap.backoffMs).toBe(5);

    // Nothing outside the tmp root was ever touched.
    expect(existsSync(CANARY_FILE)).toBe(true);
    expect(profilePath.startsWith(TMP_ROOT)).toBe(true);
  }, 10_000);
});
