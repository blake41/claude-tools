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
  assignShard,
  buildSessionName,
  parseFlags,
  pickLeastLoadedShard,
  readShardAssignment,
  resolveOrAssignShard,
  resolvePid,
  resolveReauthBaseUrls,
  resolveTeardownShard,
  sessionFilePath,
  shardForPort,
} from "../cli";
import type { SessionEntry } from "../cli";

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

  test("--host <*.localhost> targets portless HTTPS (443) directly", () => {
    // Portless serves *.localhost subdomains on HTTPS (443) with a self-signed
    // cert. Going through HTTP:80 would 302 to the same URL but drop the POST
    // body, so we address https (443) directly.
    const r = resolveReauthBaseUrls(["--host", "worktree-foo.terra.localhost"], {});
    expect(r.apiBaseUrl).toBe("https://worktree-foo.terra.localhost");
    expect(r.appBaseUrl).toBe("https://worktree-foo.terra.localhost");
    expect(r.error).toBeUndefined();
  });

  test("--host=<hostname> equals form works the same", () => {
    const r = resolveReauthBaseUrls(["--host=worktree-bar.terra.localhost"], {});
    expect(r.apiBaseUrl).toBe("https://worktree-bar.terra.localhost");
    expect(r.appBaseUrl).toBe("https://worktree-bar.terra.localhost");
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
    expect(r.apiBaseUrl).toBe("https://foo.terra.localhost");
    expect(r.error).toBeUndefined();
  });

  test("env vars still win over --host", () => {
    const r = resolveReauthBaseUrls(["--host", "foo.terra.localhost"], {
      AB_API_BASE_URL: "https://override.example.com",
    });
    expect(r.apiBaseUrl).toBe("https://override.example.com");
    expect(r.appBaseUrl).toBe("https://foo.terra.localhost");
  });

  // ---------------------------------------------------------------------------
  // Part A — auto-detect from browser URL (third optional parameter)
  // ---------------------------------------------------------------------------

  test("browserUrl *.terra.localhost → portless HTTPS (443) when no flags set", () => {
    const r = resolveReauthBaseUrls([], {}, "https://worktree-foo.terra.localhost/home");
    expect(r.apiBaseUrl).toBe("https://worktree-foo.terra.localhost");
    expect(r.appBaseUrl).toBe("https://worktree-foo.terra.localhost");
    expect(r.error).toBeUndefined();
  });

  test("browserUrl terra.localhost (exact) → portless HTTPS (443)", () => {
    const r = resolveReauthBaseUrls([], {}, "https://terra.localhost/home");
    expect(r.apiBaseUrl).toBe("https://terra.localhost");
    expect(r.appBaseUrl).toBe("https://terra.localhost");
  });

  test("browserUrl non-terra → undefined (fall back to localhost defaults)", () => {
    const r = resolveReauthBaseUrls([], {}, "https://example.com/page");
    expect(r.apiBaseUrl).toBeUndefined();
    expect(r.appBaseUrl).toBeUndefined();
    expect(r.error).toBeUndefined();
  });

  test("browserUrl localhost:5173 → undefined (not a terra.localhost, fall back)", () => {
    const r = resolveReauthBaseUrls([], {}, "http://localhost:5173/home");
    expect(r.apiBaseUrl).toBeUndefined();
    expect(r.appBaseUrl).toBeUndefined();
  });

  test("explicit --host flag overrides browserUrl auto-detect", () => {
    const r = resolveReauthBaseUrls(
      ["--host", "worktree-bar.terra.localhost"],
      {},
      "https://worktree-foo.terra.localhost/home",
    );
    expect(r.apiBaseUrl).toBe("https://worktree-bar.terra.localhost");
    expect(r.appBaseUrl).toBe("https://worktree-bar.terra.localhost");
  });

  test("--staging flag overrides browserUrl auto-detect", () => {
    const r = resolveReauthBaseUrls(
      ["--staging"],
      {},
      "https://worktree-foo.terra.localhost/home",
    );
    expect(r.apiBaseUrl).toBe("https://slack-feedback-staging.onrender.com");
    expect(r.appBaseUrl).toBe("https://slack-feedback-staging.onrender.com");
  });

  test("env vars win over browserUrl auto-detect", () => {
    const r = resolveReauthBaseUrls(
      [],
      { AB_API_BASE_URL: "https://override.example.com", AB_APP_BASE_URL: "https://override.example.com" },
      "https://worktree-foo.terra.localhost/home",
    );
    expect(r.apiBaseUrl).toBe("https://override.example.com");
    expect(r.appBaseUrl).toBe("https://override.example.com");
  });

  test("undefined browserUrl does not change behavior (same as no third arg)", () => {
    const r = resolveReauthBaseUrls([], {}, undefined);
    expect(r.apiBaseUrl).toBeUndefined();
    expect(r.appBaseUrl).toBeUndefined();
    expect(r.error).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Unit 2 — sticky shard mapping (chrome-pool-plan.md Unit 2, decisions 3 & 6)
//
// readShardAssignment / assignShard / resolveOrAssignShard / resolveTeardownShard
// are pure/marker-only (no RPC), so they're tested directly here rather than
// through a subprocess. assignShard and pickLeastLoadedShard both take the
// candidate pool as an explicit parameter (SessionEntry[] / number[]) instead
// of always scanning real /tmp state — this machine runs other real ab
// sessions concurrently (see ps.test.ts's safety notes), so a test that
// asserted an *absolute* shard index from a live /tmp scan would be flaky by
// construction. Fabricating the peer list keeps these deterministic while
// still exercising the exact counting/tie-break logic assignShard uses in
// production (its default parameter *is* the real listSessionEntries() scan).
// ---------------------------------------------------------------------------

const SHARD_TEST_PREFIX = `abtest-shard-${process.pid}-${Date.now()}`;

function shardMarkerPath(pid: string): string {
  return `/tmp/.ab-session-${pid}`;
}

function writeMarker(pid: string, body: string): void {
  fs.writeFileSync(shardMarkerPath(pid), body);
}

function mkEntry(pid: string, shard: number | null, state: SessionEntry["state"] = "active"): SessionEntry {
  return {
    pid,
    session: `ab-${pid}`,
    owner: "other-cc",
    mtimeIso: new Date().toISOString(),
    ageSeconds: 0,
    state,
    daemonPid: null,
    shard,
  };
}

describe("readShardAssignment", () => {
  const pid = `${SHARD_TEST_PREFIX}-read`;

  afterEach(() => {
    try { fs.unlinkSync(shardMarkerPath(pid)); } catch { /* ignore */ }
  });

  test("returns null when the marker file doesn't exist", () => {
    expect(readShardAssignment(pid)).toBeNull();
  });

  test("returns null for a legacy pid-only marker (no second line)", () => {
    writeMarker(pid, pid + "\n");
    expect(readShardAssignment(pid)).toBeNull();
  });

  test("returns the shard index from a well-formed second line", () => {
    writeMarker(pid, `${pid}\nshard=2\n`);
    expect(readShardAssignment(pid)).toBe(2);
  });

  test("returns null for a garbled second line (treated as unassigned)", () => {
    writeMarker(pid, `${pid}\nnotashard!!\n`);
    expect(readShardAssignment(pid)).toBeNull();
  });

  test("returns null for a non-numeric shard value", () => {
    writeMarker(pid, `${pid}\nshard=abc\n`);
    expect(readShardAssignment(pid)).toBeNull();
  });
});

describe("pickLeastLoadedShard", () => {
  test("picks the shard with the fewest sessions", () => {
    expect(pickLeastLoadedShard([2, 0, 1])).toBe(1);
  });

  test("ties break to the lowest index when no identity is given (back-compat)", () => {
    expect(pickLeastLoadedShard([0, 0, 0])).toBe(0);
    expect(pickLeastLoadedShard([3, 1, 1])).toBe(1);
  });

  test("single-shard pool always picks shard 0", () => {
    expect(pickLeastLoadedShard([5])).toBe(0);
  });

  // ---------------------------------------------------------------------------
  // Fix 3 — burst tiebreak must not collapse onto shard 0. When N sessions
  // start simultaneously they all see the same zero-count snapshot; breaking
  // every tie to the lowest index means every one of them picks shard 0,
  // reproducing the exact single-Chrome contention incident the pool exists
  // to fix. The fix: among tied shards, pick deterministically by
  // hash(identity) % tiedCount. These three literal pid strings were hashed
  // directly (`bun -e` running the same djb2 algorithm as the implementation)
  // to get real, verified outputs rather than assuming/guessing them:
  //   hash("abtest-tiebreak-a") % 3 === 0
  //   hash("abtest-tiebreak-c") % 3 === 1
  //   hash("abtest-tiebreak-b") % 3 === 2
  // ---------------------------------------------------------------------------

  test("non-tied case picks the true minimum even with an identity given (hash tiebreak never applies)", () => {
    expect(pickLeastLoadedShard([2, 0, 1], "abtest-tiebreak-b")).toBe(1);
  });

  test("tied shards spread across different identities instead of collapsing onto shard 0", () => {
    expect(pickLeastLoadedShard([0, 0, 0], "abtest-tiebreak-a")).toBe(0);
    expect(pickLeastLoadedShard([0, 0, 0], "abtest-tiebreak-c")).toBe(1);
    expect(pickLeastLoadedShard([0, 0, 0], "abtest-tiebreak-b")).toBe(2);
  });

  test("same identity is stable across repeated calls under the same load", () => {
    const first = pickLeastLoadedShard([0, 0, 0], "abtest-tiebreak-b");
    const second = pickLeastLoadedShard([0, 0, 0], "abtest-tiebreak-b");
    expect(second).toBe(first);
  });
});

describe("shardForPort (chrome-pool-plan Fix 2)", () => {
  test("maps a pool port back to its shard index", () => {
    expect(shardForPort(9333, 3)).toBe(0);
    expect(shardForPort(9334, 3)).toBe(1);
    expect(shardForPort(9335, 3)).toBe(2);
  });

  test("a port outside the pool's range resolves to shard 0 (legacy single Chrome)", () => {
    expect(shardForPort(9333, 3)).toBe(0);
    expect(shardForPort(9999, 3)).toBe(0);
    expect(shardForPort(1, 3)).toBe(0);
  });
});

describe("assignShard", () => {
  const pidA = `${SHARD_TEST_PREFIX}-assign-a`;
  const pidB = `${SHARD_TEST_PREFIX}-assign-b`;
  const pidC = `${SHARD_TEST_PREFIX}-assign-c`;

  afterEach(() => {
    for (const pid of [pidA, pidB, pidC]) {
      try { fs.unlinkSync(shardMarkerPath(pid)); } catch { /* ignore */ }
    }
  });

  test("with no peers, assigns the shard the hash tiebreak picks for this pid, and persists it", () => {
    // Fix 3: with an all-zero load snapshot every shard is tied, so the
    // result is whatever pickLeastLoadedShard's hash tiebreak picks for
    // pidA — not hardcoded to 0. Ground truth for the tiebreak itself is
    // covered by pickLeastLoadedShard's own dedicated tests (fixed literal
    // pids with hand-verified hash outputs); this test verifies assignShard
    // wires the counting + persistence around that correctly.
    const expected = pickLeastLoadedShard([0, 0, 0], pidA);
    const shard = assignShard(pidA, 3, []);
    expect(shard).toBe(expected);
    expect(readShardAssignment(pidA)).toBe(expected);
  });

  test("spreads sessions by excluding previously-assigned peers from the load count", () => {
    const a = assignShard(pidA, 3, []);
    expect(a).toBe(pickLeastLoadedShard([0, 0, 0], pidA));

    const countsForB = [0, 0, 0];
    countsForB[a] = 1;
    const b = assignShard(pidB, 3, [mkEntry(pidA, a)]);
    expect(b).toBe(pickLeastLoadedShard(countsForB, pidB));

    const countsForC = [0, 0, 0];
    countsForC[a] += 1;
    countsForC[b] += 1;
    const c = assignShard(pidC, 3, [mkEntry(pidA, a), mkEntry(pidB, b)]);
    expect(c).toBe(pickLeastLoadedShard(countsForC, pidC));
  });

  test("does not count stale peers toward load", () => {
    // Both peers claim shard 0, but are stale — every shard has zero
    // non-stale sessions, so this is the same all-tied case as "no peers".
    const expected = pickLeastLoadedShard([0, 0, 0], pidA);
    const shard = assignShard(pidA, 3, [
      mkEntry(pidB, 0, "stale"),
      mkEntry(pidC, 0, "stale"),
    ]);
    expect(shard).toBe(expected);
  });

  test("does not count the assigning session's own (stale) entry", () => {
    // Self-entry excluded -> all shards at 0 load -> same all-tied case.
    const expected = pickLeastLoadedShard([0, 0, 0], pidA);
    const shard = assignShard(pidA, 3, [mkEntry(pidA, 1, "idle")]);
    expect(shard).toBe(expected);
  });

  test("non-tied case still picks the true minimum shard regardless of pid hash", () => {
    const shard = assignShard(pidA, 3, [mkEntry(pidB, 0), mkEntry(pidC, 2)]);
    expect(shard).toBe(1); // shard 1 has 0 sessions vs 1 each on 0 and 2 — no tie
  });
});

describe("resolveOrAssignShard", () => {
  const pid = `${SHARD_TEST_PREFIX}-resolve-or-assign`;

  afterEach(() => {
    try { fs.unlinkSync(shardMarkerPath(pid)); } catch { /* ignore */ }
  });

  test("assigns on first resolution, then a second resolution reuses the persisted value", () => {
    const first = resolveOrAssignShard(pid, 3);
    const second = resolveOrAssignShard(pid, 3);
    expect(second).toBe(first);
    expect(readShardAssignment(pid)).toBe(first);
  });

  test("clamps an existing out-of-range marker instead of reassigning", () => {
    writeMarker(pid, `${pid}\nshard=7\n`);
    expect(resolveOrAssignShard(pid, 3)).toBe(1); // 7 % 3
    expect(readShardAssignment(pid)).toBe(1); // rewritten
  });
});

describe("resolveTeardownShard", () => {
  const pid = `${SHARD_TEST_PREFIX}-teardown`;

  afterEach(() => {
    try { fs.unlinkSync(shardMarkerPath(pid)); } catch { /* ignore */ }
  });

  test("missing marker resolves to shard 0 without creating one", () => {
    expect(resolveTeardownShard(pid, 3)).toBe(0);
    expect(fs.existsSync(shardMarkerPath(pid))).toBe(false);
  });

  test("legacy pid-only marker resolves to shard 0", () => {
    writeMarker(pid, pid + "\n");
    expect(resolveTeardownShard(pid, 3)).toBe(0);
  });

  test("garbled second line resolves to shard 0 (treated as unassigned)", () => {
    writeMarker(pid, `${pid}\n???\n`);
    expect(resolveTeardownShard(pid, 3)).toBe(0);
  });

  test("in-range shard resolves as-is without rewriting the marker", () => {
    writeMarker(pid, `${pid}\nshard=2\n`);
    const before = fs.statSync(shardMarkerPath(pid)).mtimeMs;
    expect(resolveTeardownShard(pid, 3)).toBe(2);
    const after = fs.statSync(shardMarkerPath(pid)).mtimeMs;
    expect(after).toBe(before);
  });

  test("out-of-range shard clamps to shard % poolSize and rewrites the marker", () => {
    writeMarker(pid, `${pid}\nshard=7\n`);
    expect(resolveTeardownShard(pid, 3)).toBe(1); // 7 % 3
    expect(readShardAssignment(pid)).toBe(1);
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
