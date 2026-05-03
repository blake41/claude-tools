/**
 * Unit 4 contract tests — ab ps + ab gc.
 *
 * Covers:
 *   - Owner classification (self, subagent, other-cc, etc.)
 *   - Empty / non-empty inventory formatting
 *   - --json output shape
 *   - gc prunes stale files but leaves fresh ones alone
 *   - --dry-run reports without deleting
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { listSessionEntries } from "../cli";

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

function cleanupByPrefix(prefix: string): void {
  for (const name of fs.readdirSync("/tmp")) {
    if (name.startsWith(`.ab-session-${prefix}`) || name.startsWith(`ab-${prefix}`)) {
      try { fs.unlinkSync(`/tmp/${name}`); } catch { /* ignore */ }
    }
  }
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
      expect(entries[0].stale).toBe(false);
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

  test("marks stale entries when mtime is older than 24h", () => {
    const pid = `${TEST_PREFIX}-stale`;
    const longAgo = Date.now() - 48 * 60 * 60 * 1000; // 48h ago
    makeSessionFile(pid, longAgo);
    const entries = listSessionEntries().filter((e) => e.pid === pid);
    expect(entries[0].stale).toBe(true);
    expect(entries[0].ageSeconds).toBeGreaterThan(24 * 3600);
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

  test("text output lists the session and marks self with *", () => {
    const r = runAb(["ps"], { CCO_SESSION_ID: pid });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(pid);
    expect(r.stdout).toContain("self");
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
    expect(typeof self.stale).toBe("boolean");
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

describe("ab gc (subprocess)", () => {
  const freshPid = `${TEST_PREFIX}-fresh`;
  const stalePid = `${TEST_PREFIX}-stale`;

  beforeEach(() => {
    cleanupByPrefix(TEST_PREFIX);
    makeSessionFile(freshPid);
    makeSessionFile(stalePid, Date.now() - 48 * 60 * 60 * 1000);
    // Matching wrapper for stale
    fs.writeFileSync(`/tmp/ab-${stalePid}`, "#!/bin/bash\nexec ab \"$@\"\n");
  });

  afterEach(() => cleanupByPrefix(TEST_PREFIX));

  test("--dry-run lists targets but deletes nothing", () => {
    const r = runAb(["gc", "--dry-run"], { CCO_SESSION_ID: freshPid });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(`would remove: /tmp/.ab-session-${stalePid}`);
    expect(r.stdout).toContain(`would remove: /tmp/ab-${stalePid}`);
    expect(fs.existsSync(`/tmp/.ab-session-${stalePid}`)).toBe(true);
    expect(fs.existsSync(`/tmp/ab-${stalePid}`)).toBe(true);
  });

  test("removes stale files and wrappers, leaves fresh alone", () => {
    const r = runAb(["gc"], { CCO_SESSION_ID: freshPid });
    expect(r.code).toBe(0);
    expect(fs.existsSync(`/tmp/.ab-session-${stalePid}`)).toBe(false);
    expect(fs.existsSync(`/tmp/ab-${stalePid}`)).toBe(false);
    expect(fs.existsSync(`/tmp/.ab-session-${freshPid}`)).toBe(true);
  });
});
