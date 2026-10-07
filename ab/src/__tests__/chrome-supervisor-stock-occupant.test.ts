/**
 * A responsive stock com.google.Chrome on one of ab's own profiles is evicted
 * (killed, then Beta is spawned) instead of adopted. Personal Chrome, which
 * also has the stock bundle id but a non-ab --user-data-dir, is NEVER signalled.
 *
 * Mocks only the outer boundaries (fetch, Bun.spawn for pgrep/lsof/Chrome,
 * WebSocket, process.kill). No real process is signalled.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import * as os from "os";
import * as path from "path";

const TMP_ROOT = mkdtempSync(path.join(os.tmpdir(), "ab-stockocc-"));
process.env.AB_PROFILE_ROOT = path.join(TMP_ROOT, "profiles");
process.env.AB_BACKOFF_INITIAL_MS = "60000";
process.env.AB_BACKOFF_MAX_MS = "600000";

import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { getState, resetAll } from "../state";

const TARGET = "headless-0" as const;
const OCCUPANT_PID = 424_242;
const SPAWNED_PID = 515_151;

function makeApp(name: string, bundleId: string, exe: string): string {
  const app = path.join(TMP_ROOT, `${name}.app`);
  mkdirSync(path.join(app, "Contents", "MacOS"), { recursive: true });
  writeFileSync(
    path.join(app, "Contents", "Info.plist"),
    `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>${bundleId}</string>
<key>CFBundleExecutable</key><string>${exe}</string>
<key>CFBundleShortVersionString</key><string>155.0.0.0</string>
</dict></plist>`,
  );
  writeFileSync(path.join(app, "Contents", "MacOS", exe), "#!/bin/sh\n", { mode: 0o755 });
  return app;
}

const STOCK = makeApp("Google Chrome", "com.google.Chrome", "Google Chrome");
const BETA = makeApp("Google Chrome Beta", "com.google.Chrome.beta", "Google Chrome Beta");
const PERSONAL_DIR = path.join(TMP_ROOT, "Library", "Application Support", "Google", "Chrome");

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
let listeningPid: number | null = OCCUPANT_PID;
let pgrepOutput = "";
let chromeSpawns: string[][] = [];

function cmdline(app: string, exe: string, userDataDir: string): string {
  return `${OCCUPANT_PID} ${app}/Contents/MacOS/${exe} --remote-debugging-port=9333 --user-data-dir=${userDataDir} --headless=new\n`;
}

const realSignalsTo = (pid: number) => killCalls.filter(([p, s]) => p === pid && s !== 0);

beforeEach(async () => {
  resetAll();
  killCalls = [];
  chromeSpawns = [];
  listeningPid = OCCUPANT_PID;
  FakeWebSocket.instances = [];
  const sup = await import("../chrome-supervisor");
  sup.__setChromeAppForTest(BETA);

  globalThis.fetch = mock((url: string | URL | Request) => {
    const u = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;
    if (!u.includes("/json/version")) return Promise.resolve(new Response("", { status: 404 }));
    // CDP answers while any Chrome (occupant or freshly spawned) holds the port.
    return listeningPid !== null || chromeSpawns.length > 0
      ? Promise.resolve(new Response(JSON.stringify({ webSocketDebuggerUrl: "ws://127.0.0.1:1/x" }), { status: 200 }))
      : Promise.reject(new Error("ECONNREFUSED"));
  }) as unknown as typeof fetch;

  // @ts-expect-error — test mock
  Bun.spawn = mock((cmd: string[]) => {
    if (cmd[0] === "/usr/bin/pgrep") {
      return { pid: -1, exitCode: 0, exited: Promise.resolve(0), stdout: new Response(pgrepOutput).body, stderr: null, kill: mock(() => {}) };
    }
    if (cmd[0] === "/usr/sbin/lsof") {
      const body = listeningPid === null ? "" : `${listeningPid}\n`;
      return { pid: -1, exitCode: 0, exited: Promise.resolve(0), stdout: new Response(body).body, stderr: null, kill: mock(() => {}) };
    }
    if (cmd[0] === "agent-browser") {
      return { pid: -1, exitCode: 0, exited: Promise.resolve(0), stdout: null, stderr: null, kill: mock(() => {}) };
    }
    chromeSpawns.push(cmd);
    return { pid: SPAWNED_PID, exitCode: null, exited: new Promise<number>(() => {}), stdout: null, stderr: null, kill: mock(() => {}) };
  });
  // @ts-expect-error — test mock
  globalThis.WebSocket = FakeWebSocket;
  process.kill = ((pid: number, signal?: string | number) => {
    killCalls.push([pid, signal]);
    if (signal !== 0 && pid === listeningPid) listeningPid = null;
    return true;
  }) as typeof process.kill;
});

afterEach(async () => {
  const sup = await import("../chrome-supervisor");
  sup.__resetRuntimeForTest();
  sup.__setChromeAppForTest(null);
  globalThis.fetch = originalFetch;
  Bun.spawn = originalSpawn;
  globalThis.WebSocket = originalWebSocket;
  process.kill = originalKill;
  resetAll();
});

afterAll(() => rmSync(TMP_ROOT, { recursive: true, force: true }));

describe("stock Chrome occupying an ab port", () => {
  test("stock Chrome on this target's own profile is killed and Beta is spawned, not adopted", async () => {
    const sup = await import("../chrome-supervisor");
    const profile = sup.__getProfilePathForTest(TARGET);
    if (!profile.startsWith(TMP_ROOT + path.sep)) throw new Error(`SAFETY GUARD: ${profile}`);
    pgrepOutput = cmdline(STOCK, "Google Chrome", profile);

    await sup.ensure(TARGET);

    expect(realSignalsTo(OCCUPANT_PID).map(([, s]) => s)).toEqual(["SIGKILL"]);
    expect(chromeSpawns).toHaveLength(1);
    expect(chromeSpawns[0][0]).toBe(path.join(BETA, "Contents", "MacOS", "Google Chrome Beta"));
    const snap = (sup.getRuntimeSnapshot() as Record<string, { adoptedPid: number | null; procPid: number | null }>)[TARGET];
    expect(snap.adoptedPid).toBeNull();
    expect(snap.procPid).toBe(SPAWNED_PID);
  });

  test("personal Chrome (stock bundle, non-ab user-data-dir) is NEVER signalled", async () => {
    const sup = await import("../chrome-supervisor");
    pgrepOutput = cmdline(STOCK, "Google Chrome", PERSONAL_DIR);

    await sup.ensure(TARGET);

    expect(realSignalsTo(OCCUPANT_PID)).toEqual([]);
    expect(chromeSpawns).toEqual([]);
    expect((sup.getRuntimeSnapshot() as Record<string, { adoptedPid: number | null }>)[TARGET].adoptedPid).toBe(OCCUPANT_PID);
    expect(getState(TARGET).phase).toBe("chrome_up");
  });

  test("a stock Chrome whose command line is unreadable is adopted and never signalled", async () => {
    const sup = await import("../chrome-supervisor");
    pgrepOutput = "";
    await sup.ensure(TARGET);
    expect(realSignalsTo(OCCUPANT_PID)).toEqual([]);
    expect((sup.getRuntimeSnapshot() as Record<string, { adoptedPid: number | null }>)[TARGET].adoptedPid).toBe(OCCUPANT_PID);
  });

  test("Beta on this target's own profile is adopted as before, not killed", async () => {
    const sup = await import("../chrome-supervisor");
    pgrepOutput = cmdline(BETA, "Google Chrome Beta", sup.__getProfilePathForTest(TARGET));
    await sup.ensure(TARGET);
    expect(realSignalsTo(OCCUPANT_PID)).toEqual([]);
    expect(chromeSpawns).toEqual([]);
    expect((sup.getRuntimeSnapshot() as Record<string, { adoptedPid: number | null }>)[TARGET].adoptedPid).toBe(OCCUPANT_PID);
  });
});
