/**
 * The stock-Chrome guard in launchChrome. A rejected binary must NEVER feed
 * crash backoff: backoff at max deletes the (logged-in) profile.
 * Fixture .app trees + mocked Bun.spawn only; no Chrome needed.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import * as os from "os";
import * as path from "path";

const TMP_ROOT = mkdtempSync(path.join(os.tmpdir(), "ab-binguard-"));
process.env.AB_PROFILE_ROOT = path.join(TMP_ROOT, "profiles");
process.env.AB_BACKOFF_INITIAL_MS = "5";
process.env.AB_BACKOFF_MAX_MS = "10";

import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { resetAll } from "../state";

function makeApp(name: string, bundleId: string, exe: string, version = "155.0.1.2"): string {
  const app = path.join(TMP_ROOT, `${name}.app`);
  mkdirSync(path.join(app, "Contents", "MacOS"), { recursive: true });
  writeFileSync(
    path.join(app, "Contents", "Info.plist"),
    `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>${bundleId}</string>
<key>CFBundleExecutable</key><string>${exe}</string>
<key>CFBundleShortVersionString</key><string>${version}</string>
</dict></plist>`,
  );
  writeFileSync(path.join(app, "Contents", "MacOS", exe), "#!/bin/sh\n", { mode: 0o755 });
  return app;
}

const STOCK = makeApp("stock", "com.google.Chrome", "Google Chrome");
const BETA = makeApp("beta", "com.google.Chrome.beta", "Google Chrome Beta", "155.0.1.2");
const MISSING = path.join(TMP_ROOT, "absent.app");

const originalFetch = globalThis.fetch;
const originalSpawn = Bun.spawn;
let spawnCalls: string[][] = [];

beforeEach(() => {
  resetAll();
  spawnCalls = [];
  // CDP answers only once a Chrome was "spawned"; before that nothing holds the port.
  globalThis.fetch = mock(() =>
    spawnCalls.some((c) => c[0].includes("Google Chrome"))
      ? Promise.resolve(
          new Response(JSON.stringify({ webSocketDebuggerUrl: "ws://127.0.0.1:9999/devtools/browser/FAKE" }), { status: 200 }),
        )
      : Promise.reject(new Error("no CDP")),
  ) as unknown as typeof fetch;
  // @ts-expect-error — test mock
  Bun.spawn = mock((cmd: string[]) => {
    spawnCalls.push(cmd);
    if (cmd[0] === "/usr/sbin/lsof") {
      return { pid: -1, exitCode: 0, exited: Promise.resolve(0), stdout: null, stderr: null, kill: mock(() => {}) };
    }
    return {
      pid: 91777,
      exitCode: null,
      exited: new Promise<number>(() => {}),
      stdout: null,
      stderr: null,
      kill: mock(() => {}),
    };
  });
});

afterEach(async () => {
  const sup = await import("../chrome-supervisor");
  sup.__resetRuntimeForTest();
  sup.__setChromeAppForTest(null);
  rmSync(process.env.AB_PROFILE_ROOT!, { recursive: true, force: true }); // tmp root only: tests share profile paths
  globalThis.fetch = originalFetch;
  Bun.spawn = originalSpawn;
  resetAll();
});

afterAll(() => rmSync(TMP_ROOT, { recursive: true, force: true }));

describe("launchChrome binary guard", () => {
  test("stock Chrome is refused with ChromeBinRejectedError and nothing is spawned", async () => {
    const sup = await import("../chrome-supervisor");
    sup.__setChromeAppForTest(STOCK);
    await expect(sup.ensure("headless-1")).rejects.toBeInstanceOf(sup.ChromeBinRejectedError);
    expect(spawnCalls.filter((c) => c[0].includes("Google Chrome"))).toEqual([]);
  });

  test("a missing Beta is refused too, with the app path in the message", async () => {
    const sup = await import("../chrome-supervisor");
    sup.__setChromeAppForTest(MISSING);
    await expect(sup.ensure("headless-1")).rejects.toThrow(MISSING);
  });

  test("a rejection never touches backoff, failure count or retry window, and never deletes the profile (even at max backoff)", async () => {
    const sup = await import("../chrome-supervisor");
    sup.__setChromeAppForTest(STOCK);
    const profile = sup.__getProfilePathForTest("headless-1");
    if (!profile.startsWith(TMP_ROOT + path.sep)) throw new Error(`SAFETY GUARD: ${profile} not under tmp root`);
    mkdirSync(profile, { recursive: true });
    const marker = path.join(profile, "logged-in-cookies");
    writeFileSync(marker, "precious");
    sup.__setBackoffForTest("headless-1", 10); // == AB_BACKOFF_MAX_MS: the nuke gate is armed

    const before = (sup.getRuntimeSnapshot() as Record<string, Record<string, unknown>>)["headless-1"];
    for (let i = 0; i < 3; i++) {
      await expect(sup.ensure("headless-1")).rejects.toBeInstanceOf(sup.ChromeBinRejectedError);
    }
    const after = (sup.getRuntimeSnapshot() as Record<string, Record<string, unknown>>)["headless-1"];

    expect(existsSync(marker)).toBe(true);
    expect(after.backoffMs).toBe(10);
    expect(after.backoffMs).toBe(before.backoffMs);
    expect(after.consecutiveFailures).toBe(before.consecutiveFailures);
    // Not in a backoff window either: a later ensure() with a good binary must not be blocked.
    sup.__setChromeAppForTest(BETA);
    await expect(sup.ensure("headless-1")).resolves.toMatchObject({ alreadyRunning: false });
  });

  test("a profile written by a newer Chrome than the binary is refused (no downgrade), profile untouched", async () => {
    const sup = await import("../chrome-supervisor");
    sup.__setChromeAppForTest(BETA); // 155.0.1.2
    const profile = sup.__getProfilePathForTest("headless-2");
    mkdirSync(profile, { recursive: true });
    writeFileSync(path.join(profile, "Last Version"), "999.0.0.1");
    await expect(sup.ensure("headless-2")).rejects.toThrow(/newer|downgrade/i);
    expect(existsSync(path.join(profile, "Last Version"))).toBe(true);
    expect(spawnCalls.filter((c) => c[0].includes("Google Chrome"))).toEqual([]);
  });

  test("Beta updating on disk between launches is not a downgrade; a real downgrade still is", async () => {
    const sup = await import("../chrome-supervisor");
    const app = makeApp("updating", "com.google.Chrome.beta", "Google Chrome Beta", "155.0.1.2");
    const plist = path.join(app, "Contents", "Info.plist");
    const setVersion = (v: string) => writeFileSync(plist, readFileSync(plist, "utf8").replace(/<string>\d+(\.\d+)+<\/string>/, `<string>${v}</string>`));
    sup.__setChromeAppForTest(app);
    const profile = sup.__getProfilePathForTest("headless-1");
    mkdirSync(profile, { recursive: true });

    writeFileSync(path.join(profile, "Last Version"), "155.0.1.2"); // Chrome wrote this on its last start
    await sup.ensure("headless-1");

    // Beta auto-updates on disk; the next Chrome start rewrites Last Version to match.
    sup.__resetRuntimeForTest();
    resetAll();
    spawnCalls = [];
    setVersion("156.0.0.1");
    writeFileSync(path.join(profile, "Last Version"), "156.0.0.1");
    await expect(sup.ensure("headless-1")).resolves.toMatchObject({ alreadyRunning: false });
    expect(spawnCalls.some((c) => c[0].includes("Google Chrome Beta"))).toBe(true);

    // A genuine downgrade (binary older than the profile) is still refused.
    sup.__resetRuntimeForTest();
    resetAll();
    spawnCalls = [];
    setVersion("154.0.0.1");
    await expect(sup.ensure("headless-1")).rejects.toBeInstanceOf(sup.ChromeBinRejectedError);
    expect(spawnCalls.filter((c) => c[0].includes("Google Chrome"))).toEqual([]);
  });

  test("startSupervision reports a rejected always-on launch in skippedRejected (what heal surfaces)", async () => {
    const sup = await import("../chrome-supervisor");
    sup.__setChromeAppForTest(STOCK);
    const result = await sup.startSupervision();
    expect(result.skippedBackoff).toEqual([]);
    expect(result.skippedRejected.map((r) => r.target)).toContain("headless-0");
    expect(result.skippedRejected[0].reason).toContain("com.google.Chrome");
    expect(spawnCalls.filter((c) => c[0].includes("Google Chrome"))).toEqual([]);
  });

  test("an accepted Beta spawns the plist-resolved executable", async () => {
    const sup = await import("../chrome-supervisor");
    sup.__setChromeAppForTest(BETA);
    await sup.ensure("headless-1");
    const chromeSpawn = spawnCalls.find((c) => c[0].includes("Google Chrome Beta"));
    expect(chromeSpawn?.[0]).toBe(path.join(BETA, "Contents", "MacOS", "Google Chrome Beta"));
    expect(chromeSpawn).toContain("--use-mock-keychain");
  });

  test("getChromeIdentityStatus reports app, bundle id and version", async () => {
    const sup = await import("../chrome-supervisor");
    sup.__setChromeAppForTest(BETA);
    expect(sup.getChromeIdentityStatus()).toEqual({
      chromeApp: BETA,
      chromeBundleId: "com.google.Chrome.beta",
      chromeVersion: "155.0.1.2",
      error: null,
    });
    sup.__setChromeAppForTest(STOCK);
    expect(sup.getChromeIdentityStatus()).toMatchObject({
      chromeApp: STOCK,
      chromeBundleId: "com.google.Chrome",
      error: expect.stringContaining("com.google.Chrome"),
    });
  });
});
