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
  resolveReauthBaseUrls,
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

describe("resolveReauthBaseUrls", () => {
  test("no flags and no env → undefined (auth.ts defaults to localhost)", () => {
    const r = resolveReauthBaseUrls([], {});
    expect(r.apiBaseUrl).toBeUndefined();
    expect(r.appBaseUrl).toBeUndefined();
    expect(r.error).toBeUndefined();
  });

  test("--staging maps both URLs to staging", () => {
    const r = resolveReauthBaseUrls(["--staging"], {});
    expect(r.apiBaseUrl).toBe("https://slack-feedback-staging.onrender.com");
    expect(r.appBaseUrl).toBe("https://slack-feedback-staging.onrender.com");
  });

  test("--dev maps both URLs to development render env", () => {
    const r = resolveReauthBaseUrls(["--dev"], {});
    expect(r.apiBaseUrl).toBe("https://slack-feedback-development.onrender.com");
    expect(r.appBaseUrl).toBe("https://slack-feedback-development.onrender.com");
  });

  test("--local is explicit no-op (undefined → localhost defaults)", () => {
    const r = resolveReauthBaseUrls(["--local"], {});
    expect(r.apiBaseUrl).toBeUndefined();
    expect(r.appBaseUrl).toBeUndefined();
  });

  test("env vars override preset", () => {
    const r = resolveReauthBaseUrls(["--staging"], {
      AB_API_BASE_URL: "https://custom-api.example.com",
      AB_APP_BASE_URL: "https://custom-app.example.com",
    });
    expect(r.apiBaseUrl).toBe("https://custom-api.example.com");
    expect(r.appBaseUrl).toBe("https://custom-app.example.com");
  });

  test("env vars apply without any preset flag", () => {
    const r = resolveReauthBaseUrls([], {
      AB_API_BASE_URL: "https://foo.example.com",
      AB_APP_BASE_URL: "https://bar.example.com",
    });
    expect(r.apiBaseUrl).toBe("https://foo.example.com");
    expect(r.appBaseUrl).toBe("https://bar.example.com");
  });

  test("--prod returns error (dev-login gated off in prod)", () => {
    const r = resolveReauthBaseUrls(["--prod"], {});
    expect(r.error).toContain("--prod is not supported");
  });

  test("--production returns same error", () => {
    const r = resolveReauthBaseUrls(["--production"], {});
    expect(r.error).toContain("--prod is not supported");
  });

  test("conflicting presets return error", () => {
    const r = resolveReauthBaseUrls(["--staging", "--dev"], {});
    expect(r.error).toContain("Conflicting env flags");
  });

  test("unrelated flags are ignored", () => {
    const r = resolveReauthBaseUrls(["--verbose", "--staging"], {});
    expect(r.apiBaseUrl).toBe("https://slack-feedback-staging.onrender.com");
    expect(r.error).toBeUndefined();
  });

  test("--host <*.localhost> targets portless HTTPS:1355 directly", () => {
    // Portless serves *.localhost subdomains on HTTPS:1355 with a self-signed
    // cert. Going through HTTP:80 would 302 to the same URL but drop the POST
    // body, so we address :1355 directly.
    const r = resolveReauthBaseUrls(["--host", "worktree-foo.terra.localhost"], {});
    expect(r.apiBaseUrl).toBe("https://worktree-foo.terra.localhost:1355");
    expect(r.appBaseUrl).toBe("https://worktree-foo.terra.localhost:1355");
    expect(r.error).toBeUndefined();
  });

  test("--host=<hostname> equals form works the same", () => {
    const r = resolveReauthBaseUrls(["--host=worktree-bar.terra.localhost"], {});
    expect(r.apiBaseUrl).toBe("https://worktree-bar.terra.localhost:1355");
    expect(r.appBaseUrl).toBe("https://worktree-bar.terra.localhost:1355");
  });

  test("--host bare `localhost` stays HTTP (no portless involved)", () => {
    const r = resolveReauthBaseUrls(["--host", "localhost"], {});
    expect(r.apiBaseUrl).toBe("http://localhost");
    expect(r.appBaseUrl).toBe("http://localhost");
  });

  test("--host non-localhost domain stays HTTP", () => {
    const r = resolveReauthBaseUrls(["--host", "example.com"], {});
    expect(r.apiBaseUrl).toBe("http://example.com");
  });

  test("--host preserves explicit scheme", () => {
    const r = resolveReauthBaseUrls(["--host", "https://my-host.example.com"], {});
    expect(r.apiBaseUrl).toBe("https://my-host.example.com");
    expect(r.appBaseUrl).toBe("https://my-host.example.com");
  });

  test("--host with no value → error", () => {
    const r = resolveReauthBaseUrls(["--host"], {});
    expect(r.error).toContain("--host requires a hostname");
  });

  test("--host=<empty> → error", () => {
    const r = resolveReauthBaseUrls(["--host="], {});
    expect(r.error).toContain("--host requires a hostname");
  });

  test("two --host with different values → error", () => {
    const r = resolveReauthBaseUrls(["--host", "a.localhost", "--host", "b.localhost"], {});
    expect(r.error).toContain("Conflicting --host values");
  });

  test("--host combined with --staging → error", () => {
    const r = resolveReauthBaseUrls(["--host", "foo.terra.localhost", "--staging"], {});
    expect(r.error).toContain("Cannot combine --host with --staging");
  });

  test("--host combined with --local is allowed (--local is no-op)", () => {
    const r = resolveReauthBaseUrls(["--host", "foo.terra.localhost", "--local"], {});
    expect(r.apiBaseUrl).toBe("https://foo.terra.localhost:1355");
    expect(r.error).toBeUndefined();
  });

  test("env vars still win over --host", () => {
    const r = resolveReauthBaseUrls(["--host", "foo.terra.localhost"], {
      AB_API_BASE_URL: "https://override.example.com",
    });
    expect(r.apiBaseUrl).toBe("https://override.example.com");
    expect(r.appBaseUrl).toBe("https://foo.terra.localhost:1355");
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
