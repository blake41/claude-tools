/**
 * `ab gc` backstop orphan-tab sweep — tab-teardown-fix U2 (R4, R6).
 *
 * Covers the third gc pass: raw-CDP closure of Chrome pages that no live
 * session can claim, plus the `ab-<pid>.config` cleanup folded in with the
 * per-reaped-entry unlinks.
 *
 * Safety note (mirrors ps.test.ts:17-24 and teardown.test.ts): this machine
 * runs ONE shared ab-server serving concurrently-running agents, so nothing
 * here may close a real Chrome target:
 *   - Every close path is exercised through injected fake deps — no real
 *     fetch, no real shard, ever.
 *   - The one subprocess test is `ab gc --dry-run`, which closes nothing by
 *     construction, and pins AB_GC_IDLE_GRACE_MS to a 1-year grace so no
 *     real idle session can be reaped as a side effect.
 *   - The real-reap fixture test (config unlink) uses a by-construction-fake
 *     pid that is stale by 48h, and disables the sweep entirely via
 *     AB_GC_TAB_SWEEP=0 so the live pool is never even listed.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { CdpPage, SessionEntry, ShardSessionEvidence, SweepDeps } from "../cli";
import type { ChromeState } from "../types";
import {
  makeGcSweepEvidenceProvider,
  partitionOrphanTargets,
  recordSessionTarget,
  sessionFilePath,
  sweepOrphanTabs,
  sweepShards,
} from "../cli";

const AB = path.resolve(import.meta.dir, "../../ab");
const AGENT_BROWSER_HOME = path.join(os.homedir(), ".agent-browser");
const SAFE_LARGE_GRACE_MS = String(1000 * 60 * 60 * 24 * 365); // 1 year

const TEST_PREFIX = `abtest-gcsweep-${process.pid}-${Date.now()}`;

function page(id: string, url = "http://localhost:5173/app"): CdpPage {
  return { id, url, title: "t" };
}

function evidence(over: Partial<ShardSessionEvidence> = {}): ShardSessionEvidence {
  return { pid: "p", state: "active", shard: 0, targets: [], ...over };
}

// ---------------------------------------------------------------------------
// partitionOrphanTargets — the ownership rule (decision 9)
// ---------------------------------------------------------------------------

describe("partitionOrphanTargets", () => {
  test("a page recorded by a live session is owned, never an orphan", () => {
    const p = page("AAAA1111");
    const result = partitionOrphanTargets([p], [evidence({ pid: "sess-a", targets: ["AAAA1111"] })], 0);
    expect(result.owned).toEqual([{ page: p, pid: "sess-a" }]);
    expect(result.orphans).toEqual([]);
    expect(result.ambiguous).toEqual([]);
  });

  test("a page no live session can claim is an orphan", () => {
    const p = page("BBBB2222");
    const result = partitionOrphanTargets(
      [p],
      [evidence({ pid: "sess-a", state: "idle", targets: ["AAAA1111"] })],
      0,
    );
    expect(result.orphans).toEqual([p]);
    expect(result.owned).toEqual([]);
    expect(result.ambiguous).toEqual([]);
  });

  test("an ACTIVE session on this shard with no recorded tab identity makes every unclaimed page ambiguous", () => {
    const p = page("BBBB2222");
    const result = partitionOrphanTargets(
      [p],
      [evidence({ pid: "sess-blind", state: "active", shard: 1, targets: [] })],
      1,
    );
    expect(result.orphans).toEqual([]);
    expect(result.ambiguous.map((a) => a.page)).toEqual([p]);
    expect(result.ambiguous[0].reason).toContain("sess-blind");
  });

  test("an ACTIVE session that DID record a tab still blinds the shard's unclaimed pages", () => {
    // Recording one target does not prove a session owns nothing else: a
    // popup / target=_blank page it opened is never recorded, and closing one
    // mid-run is the exact failure decision 9 forbids.
    const owned = page("AAAA1111", "http://localhost:5173/app");
    const popup = page("CCCC3333", "http://localhost:5173/oauth-callback");
    const result = partitionOrphanTargets(
      [owned, popup],
      [evidence({ pid: "sess-live", state: "active", shard: 0, targets: ["AAAA1111"] })],
      0,
    );
    expect(result.owned).toEqual([{ page: owned, pid: "sess-live" }]);
    expect(result.orphans).toEqual([]);
    expect(result.ambiguous.map((a) => a.page)).toEqual([popup]);
  });

  test("an active blind session on a DIFFERENT shard does not block this shard's sweep", () => {
    const p = page("BBBB2222");
    const result = partitionOrphanTargets(
      [p],
      [evidence({ pid: "sess-blind", state: "active", shard: 2, targets: [] })],
      0,
    );
    expect(result.orphans).toEqual([p]);
    expect(result.ambiguous).toEqual([]);
  });

  test("a non-active session with no recorded identity does not make pages ambiguous", () => {
    // Idle/stale markers are pass 1's responsibility (teardown + grace window);
    // letting them freeze the sweep would make the backstop a permanent no-op.
    const p = page("BBBB2222");
    const result = partitionOrphanTargets(
      [p],
      [evidence({ pid: "sess-idle", state: "idle", shard: 0, targets: [] })],
      0,
    );
    expect(result.orphans).toEqual([p]);
    expect(result.ambiguous).toEqual([]);
  });

  test("an unclaimed page whose URL collides with a live session's tab is ambiguous, not an orphan", () => {
    // Owner is idle (so it doesn't blind the shard by itself) — this pins the
    // second, URL-based layer of doubt on its own.
    const ownedPage = page("AAAA1111", "http://localhost:5173/app");
    const collider = page("CCCC3333", "http://localhost:5173/app");
    const result = partitionOrphanTargets(
      [ownedPage, collider],
      [evidence({ pid: "sess-a", state: "idle", targets: ["AAAA1111"] })],
      0,
    );
    expect(result.owned).toEqual([{ page: ownedPage, pid: "sess-a" }]);
    expect(result.orphans).toEqual([]);
    expect(result.ambiguous.map((a) => a.page)).toEqual([collider]);
    expect(result.ambiguous[0].reason).toContain("http://localhost:5173/app");
  });

  test("about:blank residue is not treated as a URL collision", () => {
    const ownedBlank = page("AAAA1111", "about:blank");
    const leakedBlank = page("CCCC3333", "about:blank");
    const result = partitionOrphanTargets(
      [ownedBlank, leakedBlank],
      [evidence({ pid: "sess-a", state: "idle", targets: ["AAAA1111"] })],
      0,
    );
    expect(result.orphans).toEqual([leakedBlank]);
    expect(result.ambiguous).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// makeGcSweepEvidenceProvider — F1: the sweep's ownership evidence must never
// be built from a stale start-of-run `listSessionEntries()` snapshot. The reap
// loop between that snapshot and the sweep evaluating a shard can run 30-60+
// seconds under a backlog; a session created in that window would be
// invisible to a stale snapshot, and its freshly-recorded, legitimately-owned
// tab would read as unclaimed — closed live by the sweep for another agent.
// ---------------------------------------------------------------------------

describe("makeGcSweepEvidenceProvider", () => {
  const latePid = `${TEST_PREFIX}-late-session`;
  const lateMarker = sessionFilePath(latePid);

  afterEach(() => {
    try { fs.unlinkSync(lateMarker); } catch { /* already gone */ }
  });

  test("a session created AFTER the provider is built is still seen when evidenceFor is actually called — no captured snapshot", () => {
    // Simulates cmdGc's real sequence: some earlier snapshot (not modeled
    // here) saw nothing. `liveEntries` is what listSessionEntries() would
    // return if called again right now, at sweep time.
    let liveEntries: SessionEntry[] = [];
    const listEntries = () => liveEntries;

    // Provider built (mirrors cmdGc constructing the evidenceFor closure)
    // BEFORE the late session exists.
    const provider = makeGcSweepEvidenceProvider(new Set(), listEntries);

    // The session opens its tab and records its identity strictly AFTER the
    // provider was constructed — the exact live-repro window from F1.
    fs.writeFileSync(lateMarker, `${latePid}\nshard=0\n`);
    recordSessionTarget(latePid, 9333, "1A7E0001");
    liveEntries = [
      {
        pid: latePid,
        session: `ab-${latePid}`,
        owner: "other-cc",
        mtimeIso: new Date().toISOString(),
        ageSeconds: 0,
        state: "active",
        daemonPid: 4242,
        shard: 0,
      },
    ];

    // evidenceFor is invoked lazily, at actual sweep time — it must reflect
    // liveEntries as it is NOW, not as it was when the provider was built.
    const evidence = provider({ shard: 0, port: 9333 });
    expect(evidence).toEqual([{ pid: latePid, state: "active", shard: 0, targets: ["1A7E0001"] }]);

    // End-to-end through the real ownership rule: the freshly-opened tab must
    // be classified as owned, never an orphan the sweep would close.
    const p: CdpPage = { id: "1A7E0001", url: "http://localhost:5173/app", title: "t" };
    const partition = partitionOrphanTargets([p], evidence, 0);
    expect(partition.owned).toEqual([{ page: p, pid: latePid }]);
    expect(partition.orphans).toEqual([]);
  });

  test("a reaped pid is excluded from evidence even if listEntries still returns it", () => {
    let liveEntries: SessionEntry[] = [
      {
        pid: "reaped-1",
        session: "ab-reaped-1",
        owner: "other-cc",
        mtimeIso: new Date().toISOString(),
        ageSeconds: 999,
        state: "stale",
        daemonPid: null,
        shard: 0,
      },
    ];
    const provider = makeGcSweepEvidenceProvider(new Set(["reaped-1"]), () => liveEntries);
    expect(provider({ shard: 0, port: 9333 })).toEqual([]);
  });

  test("defaults to the real listSessionEntries when no override is given", () => {
    // Just proves the default parameter wires to the real function without
    // throwing — the fixture-driven tests above cover actual behavior.
    const provider = makeGcSweepEvidenceProvider(new Set());
    expect(() => provider({ shard: 0, port: 9333 })).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// sweepShards — which shards the sweep is even allowed to look at
// ---------------------------------------------------------------------------

describe("sweepShards", () => {
  test("only chrome_up shards are swept, carrying their pool index and port", () => {
    const pool: ChromeState[] = [
      { phase: "chrome_up", pid: 1, port: 9333 },
      { phase: "idle" },
      { phase: "chrome_up", pid: 3, port: 9335 },
    ];
    expect(sweepShards(pool, undefined)).toEqual([
      { shard: 0, port: 9333 },
      { shard: 2, port: 9335 },
    ]);
  });

  test("no shard up (or daemon status unavailable) yields nothing to sweep", () => {
    expect(sweepShards([{ phase: "idle" }, { phase: "chrome_crashed", exitCode: 1, lastCrash: new Date() }], undefined)).toEqual([]);
    expect(sweepShards(undefined, undefined)).toEqual([]);
  });

  test("a pre-pool daemon's single headless Chrome is swept exactly once, not once per shard", () => {
    expect(sweepShards(undefined, { phase: "chrome_up", pid: 7, port: 9333 })).toEqual([
      { shard: 0, port: 9333 },
    ]);
  });
});

// ---------------------------------------------------------------------------
// sweepOrphanTabs — the pass itself, driven entirely through injected deps so
// no real CDP endpoint is ever contacted.
// ---------------------------------------------------------------------------

interface Harness {
  deps: SweepDeps;
  listed: number[];
  closed: Array<{ port: number; id: string }>;
  out: string[];
  warn: string[];
}

function harness(
  byPort: Record<number, CdpPage[] | null>,
  closeResult: (port: number, id: string) => boolean | Promise<never> = () => true,
): Harness {
  const listed: number[] = [];
  const closed: Array<{ port: number; id: string }> = [];
  return {
    listed,
    closed,
    out: [],
    warn: [],
    deps: {
      listPages: async (port) => {
        listed.push(port);
        return byPort[port] ?? null;
      },
      closeTarget: async (port, id) => {
        closed.push({ port, id });
        return await closeResult(port, id);
      },
    },
  };
}

describe("sweepOrphanTabs", () => {
  test("closes orphans and leaves owned + ambiguous pages alone", async () => {
    const orphan = page("BBBB2222", "http://localhost:9999/leaked");
    const owned = page("AAAA1111", "http://localhost:5173/app");
    const ambiguous = page("CCCC3333", "http://localhost:5173/app"); // URL collision
    const h = harness({ 9333: [orphan, owned, ambiguous] });

    const summary = await sweepOrphanTabs({
      shards: [{ shard: 0, port: 9333 }],
      evidenceFor: () => [evidence({ pid: "sess-a", state: "idle", targets: ["AAAA1111"] })],
      dryRun: false,
      deps: h.deps,
      out: (l) => h.out.push(l),
      warn: (l) => h.warn.push(l),
    });

    expect(h.closed).toEqual([{ port: 9333, id: "BBBB2222" }]);
    expect(summary).toMatchObject({ scanned: 3, owned: 1, ambiguous: 1, closed: 1, failed: 0 });
    expect(h.warn.join("\n")).toContain("reaped orphan tab: shard=0 targetId=BBBB2222");
  });

  test("--dry-run prints would-close lines and provably closes nothing", async () => {
    const orphan = page("BBBB2222", "http://localhost:9999/leaked");
    const h = harness({ 9333: [orphan] });

    const summary = await sweepOrphanTabs({
      shards: [{ shard: 0, port: 9333 }],
      evidenceFor: () => [],
      dryRun: true,
      deps: h.deps,
      out: (l) => h.out.push(l),
      warn: (l) => h.warn.push(l),
    });

    expect(h.closed).toEqual([]);
    expect(summary.closed).toBe(0);
    expect(summary.wouldClose).toBe(1);
    expect(h.out).toContain(
      "orphan tab  action=close: shard=0 targetId=BBBB2222 url=http://localhost:9999/leaked",
    );
  });

  test("ambiguous targets are logged at normal verbosity and never closed", async () => {
    const p = page("BBBB2222", "http://localhost:9999/maybe-live");
    const h = harness({ 9333: [p] });

    const summary = await sweepOrphanTabs({
      shards: [{ shard: 0, port: 9333 }],
      evidenceFor: () => [evidence({ pid: "sess-live", state: "active", shard: 0, targets: [] })],
      dryRun: false,
      deps: h.deps,
      out: (l) => h.out.push(l),
      warn: (l) => h.warn.push(l),
    });

    expect(h.closed).toEqual([]);
    expect(summary.ambiguous).toBe(1);
    const line = h.warn.find((l) => l.includes("action=skip (ambiguous)"));
    expect(line).toContain("targetId=BBBB2222");
    expect(line).toContain("sess-live");
  });

  test("no chrome_up shard means no fetch is even attempted", async () => {
    const h = harness({});
    const summary = await sweepOrphanTabs({
      shards: [],
      evidenceFor: () => [],
      dryRun: false,
      deps: h.deps,
      out: (l) => h.out.push(l),
      warn: (l) => h.warn.push(l),
    });
    expect(h.listed).toEqual([]);
    expect(summary).toEqual({ scanned: 0, owned: 0, ambiguous: 0, wouldClose: 0, closed: 0, failed: 0, unreachable: 0 });
  });

  test("an unreachable shard is reported and does not stop the next shard", async () => {
    const orphan = page("CCCC3333", "http://localhost:9999/leaked");
    const h = harness({ 9333: null, 9334: [orphan] });

    const summary = await sweepOrphanTabs({
      shards: [
        { shard: 0, port: 9333 },
        { shard: 1, port: 9334 },
      ],
      evidenceFor: () => [],
      dryRun: false,
      deps: h.deps,
      out: (l) => h.out.push(l),
      warn: (l) => h.warn.push(l),
    });

    expect(summary.unreachable).toBe(1);
    expect(h.closed).toEqual([{ port: 9334, id: "CCCC3333" }]);
  });

  test("a failed close is logged and the loop continues to the next target", async () => {
    const a = page("AAAA1111", "http://localhost:9999/a");
    const b = page("BBBB2222", "http://localhost:9999/b");
    const h = harness({ 9333: [a, b] }, (_port, id) => id !== "AAAA1111");

    const summary = await sweepOrphanTabs({
      shards: [{ shard: 0, port: 9333 }],
      evidenceFor: () => [],
      dryRun: false,
      deps: h.deps,
      out: (l) => h.out.push(l),
      warn: (l) => h.warn.push(l),
    });

    expect(h.closed.map((c) => c.id)).toEqual(["AAAA1111", "BBBB2222"]);
    expect(summary).toMatchObject({ closed: 1, failed: 1 });
    expect(h.warn.join("\n")).toContain("warn: orphan tab close failed");
  });

  test("a throwing close never escapes the sweep", async () => {
    const a = page("AAAA1111", "http://localhost:9999/a");
    const b = page("BBBB2222", "http://localhost:9999/b");
    const h = harness({ 9333: [a, b] }, (_port, id) => {
      if (id === "AAAA1111") return Promise.reject(new Error("boom"));
      return true;
    });

    const summary = await sweepOrphanTabs({
      shards: [{ shard: 0, port: 9333 }],
      evidenceFor: () => [],
      dryRun: false,
      deps: h.deps,
      out: (l) => h.out.push(l),
      warn: (l) => h.warn.push(l),
    });

    expect(summary).toMatchObject({ closed: 1, failed: 1 });
    expect(h.closed.map((c) => c.id)).toEqual(["AAAA1111", "BBBB2222"]);
  });

  test("a throwing page listing never escapes the sweep", async () => {
    const h = harness({});
    h.deps.listPages = () => Promise.reject(new Error("boom"));
    const summary = await sweepOrphanTabs({
      shards: [{ shard: 0, port: 9333 }],
      evidenceFor: () => [],
      dryRun: false,
      deps: h.deps,
      out: (l) => h.out.push(l),
      warn: (l) => h.warn.push(l),
    });
    expect(summary.unreachable).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// R6 — `~/.agent-browser/ab-<pid>.config` is unlinked for reaped pids.
//
// Real (mutating) `ab gc` invocation, so it follows ps.test.ts:17-24 exactly:
// AB_GC_IDLE_GRACE_MS pinned to a 1-year grace, fixtures stale by construction
// (48h, so grace can't apply to them anyway), and AB_GC_TAB_SWEEP=0 so the
// shared pool is never listed, let alone closed against.
// ---------------------------------------------------------------------------

function runAbGc(args: string[], env: Record<string, string>): { code: number; stdout: string; stderr: string } {
  const scrubbed: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k !== "AB_SESSION_PID" && k !== "CCO_SESSION_ID" && k !== "AB_SUBAGENT_SESSION_ID" && v !== undefined) {
      scrubbed[k] = v;
    }
  }
  Object.assign(scrubbed, env);
  const r = spawnSync(AB, args, { env: scrubbed, encoding: "utf-8" });
  return { code: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

function cleanupFixtures(prefix: string): void {
  for (const name of fs.readdirSync("/tmp")) {
    if (name.startsWith(`.ab-session-${prefix}`) || name.startsWith(`ab-${prefix}`)) {
      try { fs.unlinkSync(`/tmp/${name}`); } catch { /* ignore */ }
    }
  }
  try {
    for (const name of fs.readdirSync(AGENT_BROWSER_HOME)) {
      if (name.startsWith(`ab-${prefix}`)) {
        try { fs.unlinkSync(path.join(AGENT_BROWSER_HOME, name)); } catch { /* ignore */ }
      }
    }
  } catch { /* ~/.agent-browser may not exist */ }
}

describe("ab gc (subprocess) — reaped-pid .config cleanup", () => {
  const stalePid = `${TEST_PREFIX}-config`;
  const configPath = path.join(AGENT_BROWSER_HOME, `ab-${stalePid}.config`);

  afterEach(() => cleanupFixtures(TEST_PREFIX));

  function makeStaleFixture(): void {
    const marker = `/tmp/.ab-session-${stalePid}`;
    fs.writeFileSync(marker, stalePid + "\n");
    const staleMtime = Date.now() - 48 * 60 * 60 * 1000; // >24h — stale regardless of grace
    const t = new Date(staleMtime);
    fs.utimesSync(marker, t, t);
    fs.writeFileSync(`/tmp/ab-${stalePid}`, "#!/bin/bash\nexec ab \"$@\"\n");
    fs.chmodSync(`/tmp/ab-${stalePid}`, 0o755);
    fs.mkdirSync(AGENT_BROWSER_HOME, { recursive: true });
    fs.writeFileSync(configPath, "opaque-token\n");
  }

  test("a real reap unlinks the pid's .config alongside its marker and wrapper", () => {
    makeStaleFixture();
    const r = runAbGc(["gc"], {
      CCO_SESSION_ID: `${TEST_PREFIX}-runner`,
      AB_GC_IDLE_GRACE_MS: SAFE_LARGE_GRACE_MS,
      AB_GC_TAB_SWEEP: "0",
    });
    expect(r.code).toBe(0);
    expect(fs.existsSync(`/tmp/.ab-session-${stalePid}`)).toBe(false);
    expect(fs.existsSync(`/tmp/ab-${stalePid}`)).toBe(false);
    expect(fs.existsSync(configPath)).toBe(false);
  });

  test("live: `ab gc --dry-run` reports orphan candidates against the real pool with zero side effects", async () => {
    // The only test that lets the sweep look at the real shared pool. It is
    // dry-run (closes nothing by construction) and the assertion below proves
    // it: the pages on every shard are counted read-only before and after.
    const ports = [9333, 9334, 9335];
    const snapshot = async (): Promise<Record<number, string[] | null>> => {
      const out: Record<number, string[] | null> = {};
      for (const port of ports) {
        try {
          const res = await fetch(`http://127.0.0.1:${port}/json/list`, {
            signal: AbortSignal.timeout(2000),
          });
          const body = (await res.json()) as Array<{ id?: unknown; type?: unknown }>;
          out[port] = body
            .filter((t) => t.type === "page" && typeof t.id === "string")
            .map((t) => t.id as string)
            .sort();
        } catch {
          out[port] = null; // shard down — nothing to protect there
        }
      }
      return out;
    };

    const before = await snapshot();
    const r = runAbGc(["gc", "--dry-run"], {
      CCO_SESSION_ID: `${TEST_PREFIX}-live-dry`,
      AB_GC_IDLE_GRACE_MS: SAFE_LARGE_GRACE_MS,
    });
    const after = await snapshot();

    expect(r.code).toBe(0);
    expect(after).toEqual(before); // dry-run closed nothing, anywhere
    expect(r.stdout).not.toContain("reaped orphan tab:");
    for (const line of r.stdout.split("\n").filter((l) => l.startsWith("orphan tab  action=close:"))) {
      expect(line).toMatch(/^orphan tab {2}action=close: shard=\d+ targetId=\S+ url=/);
    }
  });

  test("--dry-run leaves the .config in place", () => {
    makeStaleFixture();
    const r = runAbGc(["gc", "--dry-run"], {
      CCO_SESSION_ID: `${TEST_PREFIX}-runner`,
      AB_GC_IDLE_GRACE_MS: SAFE_LARGE_GRACE_MS,
      AB_GC_TAB_SWEEP: "0",
    });
    expect(r.code).toBe(0);
    expect(fs.existsSync(configPath)).toBe(true);
  });
});
