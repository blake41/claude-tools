/**
 * The CLI maps ports to shards from what the daemon reports, never from its
 * own AB_* env: the launchd daemon does not see the shell env, so the two can
 * disagree. Run with `bun test --isolate`: AB_BASE_PORT is set before cli.ts
 * (and config.ts) are imported.
 *
 * No test here contacts the live daemon or a live CDP port: RPC goes through
 * a mocked fetch, and the subprocess test runs the CLI with HOME pointed at a
 * temp dir whose socket is served by a fake daemon.
 */
process.env.AB_BASE_PORT = "9500";

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import * as fs from "fs";
import * as path from "path";
import type { ChromeState, StatusResponse } from "../types";

const originalFetch = globalThis.fetch;

const UP_POOL: ChromeState[] = [
  { phase: "chrome_up", pid: 101, port: 9333 },
  { phase: "chrome_up", pid: 102, port: 9334 },
  { phase: "chrome_up", pid: 103, port: 9335 },
];

function pathOf(url: unknown): string {
  const s = typeof url === "string" ? url : url instanceof URL ? url.toString() : (url as Request).url;
  return new URL(s, "http://localhost").pathname;
}

describe("ensureChromePort with a CLI env base port that differs from the daemon's", () => {
  const testPid = `abtest-shardmap-${process.pid}`;
  const markerPath = `/tmp/.ab-session-${testPid}`;
  const originalAbPid = process.env.AB_SESSION_PID;
  const originalCco = process.env.CCO_SESSION_ID;

  beforeEach(() => {
    process.env.AB_SESSION_PID = testPid;
    delete process.env.CCO_SESSION_ID;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    try { fs.unlinkSync(markerPath); } catch { /* ignore */ }
    if (originalAbPid === undefined) delete process.env.AB_SESSION_PID;
    else process.env.AB_SESSION_PID = originalAbPid;
    if (originalCco === undefined) delete process.env.CCO_SESSION_ID;
    else process.env.CCO_SESSION_ID = originalCco;
  });

  test("CLI base 9500, daemon pool on 9333-9335: port 9334 is shard 1 and the marker is not rewritten", async () => {
    fs.writeFileSync(markerPath, `${testPid}\nshard=1\n`);
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(markerPath, old, old);
    const before = fs.statSync(markerPath).mtimeMs;

    globalThis.fetch = mock(async (url: unknown) => {
      const p = pathOf(url);
      if (p === "/status") {
        return new Response(JSON.stringify({ ok: true, headless: UP_POOL[0], headlessPool: UP_POOL }), { status: 200 });
      }
      if (p === "/chrome/ensure") {
        return new Response(
          JSON.stringify({ ok: true, pid: 102, port: 9334, alreadyRunning: true, profileFresh: false }),
          { status: 200 },
        );
      }
      return new Response("{}", { status: 404 });
    }) as unknown as typeof fetch;

    const { ensureChromePort } = await import("../cli");
    const { readShardAssignment } = await import("../session");
    const { HEADLESS_BASE_PORT } = await import("../config");
    expect(HEADLESS_BASE_PORT).toBe(9500);

    const port = await ensureChromePort(false);

    expect(port).toBe(9334);
    expect(readShardAssignment(testPid)).toBe(1);
    expect(fs.statSync(markerPath).mtimeMs).toBe(before);
  });
});

describe("shardForPort reads the daemon's pool, not the CLI env", () => {
  test("matches an up shard's port; shards that are down take base+i from an up shard", async () => {
    const { shardForPort } = await import("../shard-ports");
    const pool: ChromeState[] = [UP_POOL[0], { phase: "idle" }, { phase: "idle" }];
    expect(shardForPort(9333, pool)).toBe(0);
    expect(shardForPort(9334, pool)).toBe(1);
    expect(shardForPort(9335, pool)).toBe(2);
  });

  test("a port outside the daemon's pool, or no up shard to anchor on, is unknown (null)", async () => {
    const { shardForPort } = await import("../shard-ports");
    expect(shardForPort(9500, UP_POOL)).toBeNull();
    expect(shardForPort(9334, [{ phase: "idle" }, { phase: "idle" }])).toBeNull();
    expect(shardForPort(9333, undefined)).toBeNull();
  });
});

describe("doctor labels come from the daemon's ports", () => {
  test("headless checks label shards with the daemon's ports, not CLI base 9500", async () => {
    const { buildHeadlessDoctorChecks } = await import("../doctor");
    const pool: ChromeState[] = [UP_POOL[0], { phase: "chrome_crashed", exitCode: 1, lastCrash: new Date() }, { phase: "idle" }];
    const labels = buildHeadlessDoctorChecks({ headless: pool[0], headlessPool: pool }).map((c) => c.label);
    expect(labels).toEqual([
      "Chrome (headless-0, 9333)",
      "Chrome (headless-1, 9334)",
      "Chrome (headless-2, 9335)",
    ]);
  });

  test("tab-count checks label shards with the daemon's ports", async () => {
    const { buildTabCountChecks } = await import("../doctor");
    const { headlessPortsFromPool } = await import("../shard-ports");
    const labels = buildTabCountChecks([1, null, 2], headlessPortsFromPool(UP_POOL)).map((c) => c.label);
    expect(labels).toEqual([
      "Chrome tabs (headless-0, 9333)",
      "Chrome tabs (headless-1, 9334)",
      "Chrome tabs (headless-2, 9335)",
    ]);
  });
});

describe("an invalid AB_* port in the CLI env", () => {
  test("does not crash `ab status` at import; status still prints the daemon's JSON", async () => {
    const home = fs.mkdtempSync("/tmp/abcfg-");
    const sockDir = path.join(home, ".agent-browser");
    fs.mkdirSync(sockDir, { recursive: true });
    const socket = path.join(sockDir, "ab-server.sock");
    const idle: ChromeState = { phase: "idle" };
    const status: Partial<StatusResponse> & { ok: boolean; version: string } = {
      ok: true,
      version: "fake",
      uptime: 1,
      headless: idle,
      headed: idle,
      headlessPool: [idle, idle, idle],
    };
    const server = Bun.serve({
      unix: socket,
      fetch: (req) =>
        new URL(req.url).pathname === "/status"
          ? new Response(JSON.stringify(status), { headers: { "Content-Type": "application/json" } })
          : new Response("{}", { status: 404 }),
    });
    try {
      const env: Record<string, string> = {};
      for (const [k, v] of Object.entries(process.env)) {
        if (v !== undefined && !k.startsWith("AB_") && k !== "CCO_SESSION_ID") env[k] = v;
      }
      env.HOME = home;
      env.AB_BASE_PORT = "not-a-port";
      env.AB_SESSION_PID = `abtest-badcfg-${process.pid}`;
      const proc = Bun.spawn(["bun", path.resolve(import.meta.dir, "../cli.ts"), "status"], {
        env,
        stdout: "pipe",
        stderr: "pipe",
      });
      const [code, out, err] = await Promise.all([
        proc.exited,
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);
      expect({ code, err: code === 0 ? "" : err }).toEqual({ code: 0, err: "" });
      expect(JSON.parse(out)).toMatchObject({ version: "fake", headlessPool: [idle, idle, idle] });
      expect(err).toContain("AB_BASE_PORT must be an integer port");
    } finally {
      server.stop(true);
      fs.rmSync(home, { recursive: true, force: true });
    }
  }, 20_000);
});
