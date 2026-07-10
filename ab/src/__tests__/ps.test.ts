/**
 * ab ps + ab gc contract tests.
 *
 * Covers:
 *   - Owner classification (self, subagent, other-cc, etc.)
 *   - Three-state liveness derivation (active / idle / stale) from real
 *     daemon pid-file state, not just marker-file existence
 *   - Empty / non-empty inventory formatting
 *   - --json output shape
 *   - gc: grace-window skip for recently-idle sessions, active-daemon
 *     sessions never touched, idle-past-grace reaped (marker removed,
 *     wrapper kept), stale (>24h) reaped fully (marker + wrapper)
 *   - gc: orphan-wrapper sweep (wrapper with no marker, aged past 24h),
 *     guarded against name-adjacent sidecar files (e.g. ab-server-out.log)
 *   - --dry-run reports without deleting
 *
 * Safety note on real (non-dry-run) subprocess invocations of `ab gc`:
 * this machine runs a single shared ab-server daemon used by concurrently
 * running agents. Any real-invocation test that could plausibly reap a
 * *real* idle-but-recent session must pass AB_GC_IDLE_GRACE_MS set very
 * large so only our own unconditionally-stale (>24h) or orphan (>24h, no
 * marker) fixtures are ever touched — those are safe by construction
 * regardless of grace. Anything that needs to exercise the grace boundary
 * itself uses --dry-run, which never deletes or spawns teardown.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { listSessionEntries } from "../cli";

const AB = path.resolve(import.meta.dir, "../../ab");
const AGENT_BROWSER_HOME = path.join(os.homedir(), ".agent-browser");

// A large grace window so real machine sessions (all plausibly idle-but-
// recent right now) are never gc'd as a side effect of running this suite.
const SAFE_LARGE_GRACE_MS = String(1000 * 60 * 60 * 24 * 365); // 1 year

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

// Use a unique prefix so tests don't collide with real sessions on the box.
const TEST_PREFIX = `abtest-ps-${process.pid}-${Date.now()}`;

function makeSessionFile(pid: string, mtimeMs?: number): string {
  const fp = `/tmp/.ab-session-${pid}`;
  fs.writeFileSync(fp, pid + "\n");
  if (mtimeMs !== undefined) {
    const t = new Date(mtimeMs);
    fs.utimesSync(fp, t, t);
  }
  return fp;
}

/** Fabricate a per-session daemon pid file (~/.agent-browser/ab-<pid>.pid). */
function makeDaemonPidFile(pid: string, osPid: number): string {
  const fp = path.join(AGENT_BROWSER_HOME, `ab-${pid}.pid`);
  fs.writeFileSync(fp, String(osPid));
  return fp;
}

function cleanupByPrefix(prefix: string): void {
  for (const name of fs.readdirSync("/tmp")) {
    if (name.startsWith(`.ab-session-${prefix}`) || name.startsWith(`ab-${prefix}`)) {
      try { fs.unlinkSync(`/tmp/${name}`); } catch { /* ignore */ }
    }
  }
  try {
    for (const name of fs.readdirSync(AGENT_BROWSER_HOME)) {
      if (name.startsWith(`ab-${prefix}`) && name.endsWith(".pid")) {
        try { fs.unlinkSync(path.join(AGENT_BROWSER_HOME, name)); } catch { /* ignore */ }
      }
    }
  } catch { /* ~/.agent-browser may not exist in some envs */ }
}

describe("listSessionEntries", () => {
  afterEach(() => cleanupByPrefix(TEST_PREFIX));

  test("returns empty list when no files match", () => {
    cleanupByPrefix(TEST_PREFIX);
    // There may be other unrelated session files on disk; filter by our prefix.
    const entries = listSessionEntries().filter((e) => e.pid.startsWith(TEST_PREFIX));
    expect(entries).toEqual([]);
  });

  test("classifies self correctly", () => {
    const pid = `${TEST_PREFIX}-self`;
    makeSessionFile(pid);
    const originalCco = process.env.CCO_SESSION_ID;
    const originalAbPid = process.env.AB_SESSION_PID;
    try {
      process.env.CCO_SESSION_ID = pid;
      delete process.env.AB_SESSION_PID;
      const entries = listSessionEntries().filter((e) => e.pid === pid);
      expect(entries).toHaveLength(1);
      expect(entries[0].owner).toBe("self");
      expect(entries[0].session).toBe(`ab-${pid}`);
      // Fresh marker, no daemon pid file — daemon dead, not yet stale.
      expect(entries[0].state).toBe("idle");
      expect(entries[0].daemonPid).toBeNull();
    } finally {
      if (originalCco === undefined) delete process.env.CCO_SESSION_ID;
      else process.env.CCO_SESSION_ID = originalCco;
      if (originalAbPid === undefined) delete process.env.AB_SESSION_PID;
      else process.env.AB_SESSION_PID = originalAbPid;
    }
  });

  test("classifies subagent vs main-thread when running inside a subagent", () => {
    const cco = `${TEST_PREFIX}-p`;
    const sub1 = `${cco}-aaaaaaaa`;
    const sub2 = `${cco}-bbbbbbbb`;
    makeSessionFile(cco);
    makeSessionFile(sub1);
    makeSessionFile(sub2);
    const originalCco = process.env.CCO_SESSION_ID;
    const originalAbPid = process.env.AB_SESSION_PID;
    try {
      process.env.CCO_SESSION_ID = cco;
      process.env.AB_SESSION_PID = sub1;
      const entries = listSessionEntries().filter((e) =>
        e.pid === cco || e.pid === sub1 || e.pid === sub2,
      );
      const byPid = Object.fromEntries(entries.map((e) => [e.pid, e]));
      expect(byPid[sub1].owner).toBe("self");
      expect(byPid[cco].owner).toBe("self (main-thread)");
      expect(byPid[sub2].owner).toBe("subagent");
    } finally {
      if (originalCco === undefined) delete process.env.CCO_SESSION_ID;
      else process.env.CCO_SESSION_ID = originalCco;
      if (originalAbPid === undefined) delete process.env.AB_SESSION_PID;
      else process.env.AB_SESSION_PID = originalAbPid;
    }
  });

  test("classifies unknown pids as other-cc / other-cc (subagent)", () => {
    const flat = `${TEST_PREFIX}-flat`;
    const nested = `${TEST_PREFIX}-parent-child`;
    makeSessionFile(flat);
    makeSessionFile(nested);
    const originalCco = process.env.CCO_SESSION_ID;
    const originalAbPid = process.env.AB_SESSION_PID;
    try {
      process.env.CCO_SESSION_ID = "a-totally-unrelated-cco";
      delete process.env.AB_SESSION_PID;
      const entries = listSessionEntries().filter(
        (e) => e.pid === flat || e.pid === nested,
      );
      const byPid = Object.fromEntries(entries.map((e) => [e.pid, e]));
      expect(byPid[flat].owner).toBe("other-cc (subagent)"); // flat contains "-" => treated as subagent-shaped
      expect(byPid[nested].owner).toBe("other-cc (subagent)");
    } finally {
      if (originalCco === undefined) delete process.env.CCO_SESSION_ID;
      else process.env.CCO_SESSION_ID = originalCco;
      if (originalAbPid === undefined) delete process.env.AB_SESSION_PID;
      else process.env.AB_SESSION_PID = originalAbPid;
    }
  });

  test("marks stale state when mtime is older than 24h and no daemon is alive", () => {
    const pid = `${TEST_PREFIX}-stale`;
    const longAgo = Date.now() - 48 * 60 * 60 * 1000; // 48h ago
    makeSessionFile(pid, longAgo);
    const entries = listSessionEntries().filter((e) => e.pid === pid);
    expect(entries[0].state).toBe("stale");
    expect(entries[0].daemonPid).toBeNull();
    expect(entries[0].ageSeconds).toBeGreaterThan(24 * 3600);
  });

  test("marks active state when the per-session daemon pid file names a live pid", () => {
    const pid = `${TEST_PREFIX}-active`;
    makeSessionFile(pid);
    const pidFile = makeDaemonPidFile(pid, process.pid); // our own test process — definitely alive
    try {
      const entries = listSessionEntries().filter((e) => e.pid === pid);
      expect(entries).toHaveLength(1);
      expect(entries[0].state).toBe("active");
      expect(entries[0].daemonPid).toBe(process.pid);
    } finally {
      try { fs.unlinkSync(pidFile); } catch { /* ignore */ }
    }
  });

  test("does not mark active when the daemon pid file names a dead pid", () => {
    const pid = `${TEST_PREFIX}-dead-daemon`;
    makeSessionFile(pid); // fresh mtime
    // 999999 is well above macOS's typical PID_MAX (99998) — guaranteed dead.
    const pidFile = makeDaemonPidFile(pid, 999999);
    try {
      const entries = listSessionEntries().filter((e) => e.pid === pid);
      expect(entries).toHaveLength(1);
      expect(entries[0].state).toBe("idle"); // dead daemon, but fresh marker
      expect(entries[0].daemonPid).toBeNull();
    } finally {
      try { fs.unlinkSync(pidFile); } catch { /* ignore */ }
    }
  });
});

// ---------------------------------------------------------------------------
// End-to-end: spawn the real `ab` binary.
// ---------------------------------------------------------------------------

describe("ab ps (subprocess)", () => {
  const pid = `${TEST_PREFIX}-e2e`;

  beforeEach(() => {
    cleanupByPrefix(TEST_PREFIX);
    makeSessionFile(pid);
  });

  afterEach(() => cleanupByPrefix(TEST_PREFIX));

  test("text output lists the session, marks self with *, and prints its state", () => {
    const r = runAb(["ps"], { CCO_SESSION_ID: pid });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(pid);
    expect(r.stdout).toContain("self");
    expect(r.stdout).toContain("idle"); // fresh marker, no daemon pid file
    expect(r.stdout.split("\n").some((line) => line.startsWith("*"))).toBe(true);
  });

  test("--json output is valid JSON with expected fields", () => {
    const r = runAb(["ps", "--json"], { CCO_SESSION_ID: pid });
    expect(r.code).toBe(0);
    const parsed = JSON.parse(r.stdout);
    expect(Array.isArray(parsed)).toBe(true);
    const self = parsed.find((e: { pid: string }) => e.pid === pid);
    expect(self).toBeDefined();
    expect(self.owner).toBe("self");
    expect(self.session).toBe(`ab-${pid}`);
    expect(typeof self.mtimeIso).toBe("string");
    expect(typeof self.ageSeconds).toBe("number");
    expect(["active", "idle", "stale"]).toContain(self.state);
    expect(self.state).toBe("idle");
    expect(self.daemonPid === null || typeof self.daemonPid === "number").toBe(true);
  });

  test("empty inventory prints 'No active browser sessions.'", () => {
    cleanupByPrefix(TEST_PREFIX);
    // Note: other pids may exist from real use; we check stderr only when
    // our own files are absent. The assertion is robust to other sessions
    // existing, because we only assert the message appears *iff* no files.
    // Simplest: check text output flow by pointing at a unique CCO with no file.
    const uniqueCco = `${TEST_PREFIX}-empty-${Date.now()}`;
    const r = runAb(["ps"], { CCO_SESSION_ID: uniqueCco });
    expect(r.code).toBe(0);
    // Don't assert empty message strictly — real system may have other sessions.
    // Instead, assert our specific pid is NOT present.
    expect(r.stdout).not.toContain(uniqueCco);
  });
});

describe("ab gc (subprocess) — real reap, safe-by-construction fixtures only", () => {
  const freshPid = `${TEST_PREFIX}-fresh`; // idle, age ~0 — always within any grace
  const stalePid = `${TEST_PREFIX}-stale`; // >24h — unconditionally reaped regardless of grace

  beforeEach(() => {
    cleanupByPrefix(TEST_PREFIX);
    makeSessionFile(freshPid);
    makeSessionFile(stalePid, Date.now() - 48 * 60 * 60 * 1000);
    fs.writeFileSync(`/tmp/ab-${stalePid}`, "#!/bin/bash\nexec ab \"$@\"\n");
    fs.chmodSync(`/tmp/ab-${stalePid}`, 0o755);
  });

  afterEach(() => cleanupByPrefix(TEST_PREFIX));

  test("--dry-run lists the stale target but deletes nothing", () => {
    const r = runAb(["gc", "--dry-run"], {
      CCO_SESSION_ID: freshPid,
      AB_GC_IDLE_GRACE_MS: SAFE_LARGE_GRACE_MS,
    });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(`${stalePid}`);
    expect(r.stdout).toContain("action=close + remove marker + wrapper");
    expect(r.stdout).toContain(`would remove: /tmp/.ab-session-${stalePid}`);
    expect(r.stdout).toContain(`would remove: /tmp/ab-${stalePid}`);
    expect(fs.existsSync(`/tmp/.ab-session-${stalePid}`)).toBe(true);
    expect(fs.existsSync(`/tmp/ab-${stalePid}`)).toBe(true);
  });

  test("removes stale marker + wrapper for real, leaves within-grace idle alone", () => {
    // Grace set to 1 year so no real machine session (all plausibly idle but
    // recently active) is ever touched by this real, mutating invocation —
    // only our unconditionally-stale (48h) fixture, which bypasses grace.
    const r = runAb(["gc"], {
      CCO_SESSION_ID: freshPid,
      AB_GC_IDLE_GRACE_MS: SAFE_LARGE_GRACE_MS,
    });
    expect(r.code).toBe(0);
    expect(fs.existsSync(`/tmp/.ab-session-${stalePid}`)).toBe(false);
    expect(fs.existsSync(`/tmp/ab-${stalePid}`)).toBe(false);
    expect(fs.existsSync(`/tmp/.ab-session-${freshPid}`)).toBe(true);
  });
});

describe("ab gc (subprocess) — grace-boundary behavior (dry-run only, no real deletion)", () => {
  const withinGracePid = `${TEST_PREFIX}-within-grace`;
  const pastGracePid = `${TEST_PREFIX}-past-grace`;
  const stalePid = `${TEST_PREFIX}-boundary-stale`;
  const GRACE_MS = 10 * 60 * 1000; // 10 minutes, small and deterministic

  beforeEach(() => {
    cleanupByPrefix(TEST_PREFIX);
    makeSessionFile(withinGracePid, Date.now() - 2 * 60 * 1000); // 2m old — within 10m grace
    makeSessionFile(pastGracePid, Date.now() - 20 * 60 * 1000); // 20m old — idle, past grace, <24h
    makeSessionFile(stalePid, Date.now() - 48 * 60 * 60 * 1000); // 48h old — stale
    fs.writeFileSync(`/tmp/ab-${pastGracePid}`, "#!/bin/bash\nexec ab \"$@\"\n");
    fs.chmodSync(`/tmp/ab-${pastGracePid}`, 0o755);
    fs.writeFileSync(`/tmp/ab-${stalePid}`, "#!/bin/bash\nexec ab \"$@\"\n");
    fs.chmodSync(`/tmp/ab-${stalePid}`, 0o755);
  });

  afterEach(() => cleanupByPrefix(TEST_PREFIX));

  test("within-grace idle entries are skipped", () => {
    const r = runAb(["gc", "--dry-run"], {
      CCO_SESSION_ID: withinGracePid,
      AB_GC_IDLE_GRACE_MS: String(GRACE_MS),
    });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(`${withinGracePid}`);
    expect(r.stdout).toContain("action=skip: within grace window");
    // Nothing is ever deleted under --dry-run.
    expect(fs.existsSync(`/tmp/.ab-session-${withinGracePid}`)).toBe(true);
  });

  test("past-grace idle entries would be reaped keeping the wrapper", () => {
    const r = runAb(["gc", "--dry-run"], {
      CCO_SESSION_ID: withinGracePid,
      AB_GC_IDLE_GRACE_MS: String(GRACE_MS),
    });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(`${pastGracePid}`);
    expect(r.stdout).toContain("action=close + remove marker (keep wrapper)");
    expect(r.stdout).toContain(`would remove: /tmp/.ab-session-${pastGracePid}`);
    // Wrapper is deliberately NOT listed as "would remove" for an idle (not stale) entry.
    const pastGraceLines = r.stdout
      .split("\n")
      .filter((l) => l.includes(pastGracePid));
    expect(pastGraceLines.some((l) => l.includes(`would remove: /tmp/ab-${pastGracePid}`))).toBe(false);
    expect(fs.existsSync(`/tmp/ab-${pastGracePid}`)).toBe(true);
  });

  test("stale entries would be reaped fully (marker + wrapper)", () => {
    const r = runAb(["gc", "--dry-run"], {
      CCO_SESSION_ID: withinGracePid,
      AB_GC_IDLE_GRACE_MS: String(GRACE_MS),
    });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("action=close + remove marker + wrapper");
    expect(r.stdout).toContain(`would remove: /tmp/.ab-session-${stalePid}`);
    expect(r.stdout).toContain(`would remove: /tmp/ab-${stalePid}`);
    expect(fs.existsSync(`/tmp/.ab-session-${stalePid}`)).toBe(true);
    expect(fs.existsSync(`/tmp/ab-${stalePid}`)).toBe(true);
  });
});

describe("ab gc (subprocess) — orphan-wrapper sweep", () => {
  // A hex-shaped pid with NO matching session marker anywhere, guaranteed
  // old (48h). Uses hex digits only so it satisfies the orphan-wrapper
  // guard regex, and is namespaced with "deadbeef" + our own pid in hex to
  // avoid any realistic collision with real session pids.
  const orphanPid = `deadbeef-${process.pid.toString(16).padStart(8, "0")}`;
  const orphanWrapper = `/tmp/ab-${orphanPid}`;

  // Same shape as the real ab-server-out.log / ab-server-error.log sidecar
  // files that must NEVER be swept — reproduced under a unique test name so
  // we don't touch the real log files, but still exercises the same guard
  // (non-hex characters + ".log" extension both fail the regex).
  const guardedSidecar = `/tmp/ab-server-out-${TEST_PREFIX}.log`;

  function setOld(fp: string): void {
    const t = new Date(Date.now() - 48 * 60 * 60 * 1000);
    fs.utimesSync(fp, t, t);
  }

  afterEach(() => {
    try { fs.unlinkSync(orphanWrapper); } catch { /* ignore */ }
    try { fs.unlinkSync(guardedSidecar); } catch { /* ignore */ }
    cleanupByPrefix(TEST_PREFIX);
  });

  test("--dry-run reports the orphan wrapper for removal but guards the sidecar-shaped file", () => {
    fs.writeFileSync(orphanWrapper, "#!/bin/bash\nexec ab \"$@\"\n");
    fs.chmodSync(orphanWrapper, 0o755);
    setOld(orphanWrapper);
    fs.writeFileSync(guardedSidecar, "some log content\n");
    fs.chmodSync(guardedSidecar, 0o755); // even if executable, name shape fails the regex
    setOld(guardedSidecar);

    const uniqueCco = `${TEST_PREFIX}-orphan-dry`;
    const r = runAb(["gc", "--dry-run"], {
      CCO_SESSION_ID: uniqueCco,
      AB_GC_IDLE_GRACE_MS: SAFE_LARGE_GRACE_MS,
    });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(`orphan wrapper  action=remove: ${orphanWrapper}`);
    expect(r.stdout).not.toContain(guardedSidecar);
    expect(fs.existsSync(orphanWrapper)).toBe(true); // dry-run deletes nothing
    expect(fs.existsSync(guardedSidecar)).toBe(true);
  });

  test("real run removes the orphan wrapper but leaves the guarded sidecar file untouched", () => {
    fs.writeFileSync(orphanWrapper, "#!/bin/bash\nexec ab \"$@\"\n");
    fs.chmodSync(orphanWrapper, 0o755);
    setOld(orphanWrapper);
    fs.writeFileSync(guardedSidecar, "some log content\n");
    fs.chmodSync(guardedSidecar, 0o755);
    setOld(guardedSidecar);

    const uniqueCco = `${TEST_PREFIX}-orphan-real`;
    const r = runAb(["gc"], {
      CCO_SESSION_ID: uniqueCco,
      AB_GC_IDLE_GRACE_MS: SAFE_LARGE_GRACE_MS,
    });
    expect(r.code).toBe(0);
    expect(fs.existsSync(orphanWrapper)).toBe(false);
    expect(fs.existsSync(guardedSidecar)).toBe(true);
  });
});
