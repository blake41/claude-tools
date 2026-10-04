/**
 * launchChrome's "CDP never answered" failure must account like any other
 * crash: arm retryNotBefore and escalate backoff, otherwise the ensure gate
 * never closes and profile recovery (backoff >= max) is unreachable.
 */
import { mkdtempSync, rmSync } from "fs";
import * as os from "os";
import * as path from "path";

const TMP_ROOT = mkdtempSync(path.join(os.tmpdir(), "ab-cdp-timeout-"));
process.env.AB_PROFILE_ROOT = TMP_ROOT;
process.env.AB_BACKOFF_INITIAL_MS = "5000";
process.env.AB_BACKOFF_MAX_MS = "20000";
process.env.AB_CDP_READY_TIMEOUT_MS = "50";

import { afterAll, afterEach, beforeEach, expect, mock, test } from "bun:test";
import { resetAll } from "../state";

const originalFetch = globalThis.fetch;
const originalSpawn = Bun.spawn;

beforeEach(() => {
  resetAll();
  globalThis.fetch = mock(() => Promise.resolve(new Response("", { status: 404 }))) as unknown as typeof fetch;
  const proc = {
    pid: 92001,
    exitCode: null as number | null,
    exited: new Promise<number>(() => {}),
    stdout: null,
    stderr: null,
    kill: mock(() => {}),
  };
  const lsof = { pid: -1, exitCode: 0, exited: Promise.resolve(0), stdout: null, stderr: null, kill: mock(() => {}) };
  // @ts-expect-error — test mock, narrower than Bun.spawn's overload set
  Bun.spawn = mock((cmd: string[]) => (cmd[0] === "/usr/sbin/lsof" ? lsof : proc));
});

afterEach(async () => {
  const { __resetRuntimeForTest } = await import("../chrome-supervisor");
  __resetRuntimeForTest();
  globalThis.fetch = originalFetch;
  Bun.spawn = originalSpawn;
  resetAll();
});

afterAll(() => {
  try { rmSync(TMP_ROOT, { recursive: true, force: true }); } catch { /* best effort */ }
});

test("CDP timeout arms retryNotBefore, escalates backoff, and gates the next ensure", async () => {
  const { ensure, getRuntimeSnapshot, RetryAfterError } = await import("../chrome-supervisor");
  const before = Date.now();

  await expect(ensure("headless-1")).rejects.toThrow(/failed to start/);

  const snap = (getRuntimeSnapshot() as Record<string, { backoffMs: number; retryNotBefore: number }>)["headless-1"];
  expect(snap.backoffMs).toBe(10_000);
  expect(snap.retryNotBefore).toBeGreaterThanOrEqual(before + 5_000);

  await expect(ensure("headless-1")).rejects.toBeInstanceOf(RetryAfterError);
}, 10_000);
