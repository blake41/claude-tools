/**
 * Unit 1 contract tests — pid primitive resolution + idempotent new-session.
 *
 * Covers the session identity rules in cli.ts:
 *   pid := AB_SESSION_PID ?? CCO_SESSION_ID ?? null
 *   file := /tmp/.ab-session-<pid>
 *   session := ab-<pid>  (or "ab-default" when pid is null)
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import {
  RemovedFlagError,
  buildSessionName,
  parseFlags,
  resolvePid,
  sessionFilePath,
} from "../cli";

const AB = path.resolve(import.meta.dir, "../../ab");

function runAb(
  args: string[],
  env: Record<string, string | undefined>,
): { code: number; stdout: string; stderr: string } {
  const scrubbed: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k !== "AB_SESSION_PID" && k !== "CCO_SESSION_ID" && k !== "AB_SUBAGENT_SESSION_ID" && v !== undefined) {
      scrubbed[k] = v;
    }
  }
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete scrubbed[k];
    else scrubbed[k] = v;
  }
  const result = spawnSync(AB, args, { env: scrubbed, encoding: "utf-8" });
  return {
    code: result.status ?? -1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

// ---------------------------------------------------------------------------
// Pure function tests
// ---------------------------------------------------------------------------

describe("resolvePid", () => {
  const originalAbPid = process.env.AB_SESSION_PID;
  const originalCco = process.env.CCO_SESSION_ID;

  afterEach(() => {
    if (originalAbPid === undefined) delete process.env.AB_SESSION_PID;
    else process.env.AB_SESSION_PID = originalAbPid;
    if (originalCco === undefined) delete process.env.CCO_SESSION_ID;
    else process.env.CCO_SESSION_ID = originalCco;
  });

  test("returns AB_SESSION_PID when set (subagent)", () => {
    process.env.AB_SESSION_PID = "abc123-deadbeef";
    process.env.CCO_SESSION_ID = "abc123";
    expect(resolvePid()).toBe("abc123-deadbeef");
  });

  test("falls back to CCO_SESSION_ID on the main thread", () => {
    delete process.env.AB_SESSION_PID;
    process.env.CCO_SESSION_ID = "abc123";
    expect(resolvePid()).toBe("abc123");
  });

  test("falls back to literal 'default' when neither env var is set", () => {
    delete process.env.AB_SESSION_PID;
    delete process.env.CCO_SESSION_ID;
    expect(resolvePid()).toBe("default");
  });
});

describe("sessionFilePath", () => {
  test("returns /tmp/.ab-session-<pid> for a given pid", () => {
    expect(sessionFilePath("abc123")).toBe("/tmp/.ab-session-abc123");
    expect(sessionFilePath("abc123-deadbeef")).toBe("/tmp/.ab-session-abc123-deadbeef");
    expect(sessionFilePath("default")).toBe("/tmp/.ab-session-default");
  });
});

describe("buildSessionName", () => {
  test("returns ab-<pid> for a given pid", () => {
    expect(buildSessionName("abc123")).toBe("ab-abc123");
    expect(buildSessionName("abc123-deadbeef")).toBe("ab-abc123-deadbeef");
    expect(buildSessionName("default")).toBe("ab-default");
  });
});

describe("parseFlags", () => {
  test("parses --headed and --user-chrome", () => {
    const f = parseFlags(["--headed", "open", "https://example.com"]);
    expect(f.headed).toBe(true);
    expect(f.args).toEqual(["open", "https://example.com"]);
  });

  test("throws RemovedFlagError on --session-name", () => {
    expect(() => parseFlags(["--session-name", "foo", "open"])).toThrow(RemovedFlagError);
  });

  test("throws RemovedFlagError on --session", () => {
    expect(() => parseFlags(["--session", "foo", "open"])).toThrow(RemovedFlagError);
  });
});

// ---------------------------------------------------------------------------
// End-to-end subprocess tests — verify actual `ab` binary behavior.
//
// We use `ab new-session` because it exits without needing a live daemon
// (doesn't hit the RPC). Session files live under a temp-specific pid so
// the tests don't collide with a real session.
// ---------------------------------------------------------------------------

describe("ab new-session (idempotency + pid wiring)", () => {
  let testPids: string[] = [];

  beforeEach(() => {
    testPids = [];
  });

  afterEach(() => {
    for (const pid of testPids) {
      try {
        fs.unlinkSync(`/tmp/.ab-session-${pid}`);
      } catch {
        // ignore
      }
    }
  });

  test("writes pid to file and prints pid (CCO_SESSION_ID path)", () => {
    const pid = `abtest-${Date.now()}-cco`;
    testPids.push(pid);
    const r = runAb(["new-session"], { CCO_SESSION_ID: pid });
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toBe(pid);
    expect(fs.readFileSync(`/tmp/.ab-session-${pid}`, "utf-8").trim()).toBe(pid);
  });

  test("writes to subagent pid file when AB_SESSION_PID is set", () => {
    const cco = `abtest-${Date.now()}-parent`;
    const pid = `${cco}-deadbeef`;
    testPids.push(pid, cco);
    const r = runAb(["new-session"], {
      CCO_SESSION_ID: cco,
      AB_SESSION_PID: pid,
    });
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toBe(pid);
    expect(fs.existsSync(`/tmp/.ab-session-${pid}`)).toBe(true);
    // parent CCO file should NOT be written — only the pid-file is
    expect(fs.existsSync(`/tmp/.ab-session-${cco}`)).toBe(false);
  });

  test("is idempotent: calling twice produces identical pid + unchanged file", () => {
    const pid = `abtest-${Date.now()}-idem`;
    testPids.push(pid);
    const r1 = runAb(["new-session"], { CCO_SESSION_ID: pid });
    const mtime1 = fs.statSync(`/tmp/.ab-session-${pid}`).mtimeMs;
    // Give the filesystem a moment so a re-write would produce a different mtime
    Bun.sleepSync(20);
    const r2 = runAb(["new-session"], { CCO_SESSION_ID: pid });
    const mtime2 = fs.statSync(`/tmp/.ab-session-${pid}`).mtimeMs;
    expect(r1.stdout).toBe(r2.stdout);
    expect(mtime1).toBe(mtime2);
  });

  test("falls back to 'default' pid when neither env var is set", () => {
    testPids.push("default");
    // Pre-clean so the run exercises the write path deterministically.
    try { fs.unlinkSync("/tmp/.ab-session-default"); } catch { /* ignore */ }
    const r = runAb(["new-session"], {});
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toBe("default");
    expect(fs.readFileSync("/tmp/.ab-session-default", "utf-8").trim()).toBe("default");
  });
});

describe("ab removed flags/envs", () => {
  test("--session-name exits non-zero with explanatory message", () => {
    const r = runAb(["--session-name", "foo", "status"], { CCO_SESSION_ID: "abtest-rm" });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("--session-name is removed");
  });

  test("--session exits non-zero with explanatory message", () => {
    const r = runAb(["--session", "foo", "status"], { CCO_SESSION_ID: "abtest-rm" });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("--session is removed");
  });

  test("AB_SUBAGENT_SESSION_ID is ignored (session identity comes from pid)", () => {
    // We can't easily assert the chosen session name from the outside without
    // mocking the daemon. The contract: no resolution path reads
    // AB_SUBAGENT_SESSION_ID anymore. Assert via `resolvePid` with the env var
    // set — it must fall through to CCO_SESSION_ID.
    const originalAbPid = process.env.AB_SESSION_PID;
    const originalCco = process.env.CCO_SESSION_ID;
    const originalSub = process.env.AB_SUBAGENT_SESSION_ID;
    try {
      delete process.env.AB_SESSION_PID;
      process.env.CCO_SESSION_ID = "main-thread";
      process.env.AB_SUBAGENT_SESSION_ID = "should-be-ignored";
      expect(resolvePid()).toBe("main-thread");
    } finally {
      if (originalAbPid === undefined) delete process.env.AB_SESSION_PID;
      else process.env.AB_SESSION_PID = originalAbPid;
      if (originalCco === undefined) delete process.env.CCO_SESSION_ID;
      else process.env.CCO_SESSION_ID = originalCco;
      if (originalSub === undefined) delete process.env.AB_SUBAGENT_SESSION_ID;
      else process.env.AB_SUBAGENT_SESSION_ID = originalSub;
    }
  });
});
