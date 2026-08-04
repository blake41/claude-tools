/**
 * teardownSession contract tests — tab-teardown-fix U1.
 *
 * Covers the identity-based teardown: a session's Chrome targets are
 * recorded in its marker at `ab open` time and closed by exact targetId
 * over raw CDP at teardown, with the outcome verified against
 * `/json/list` rather than trusted from an exit code.
 *
 * Safety note (mirrors ps.test.ts:17-24): this machine runs ONE shared
 * ab-server used by concurrently-running agents. Nothing in this file may
 * close, blank, or reap anything it did not create:
 *   - All CDP unit tests run against a local Bun.serve fake, never a shard.
 *   - teardownSession unit tests inject fake deps — no real agent-browser,
 *     no real fetch.
 *   - The one live E2E creates its own session + tab and closes only that
 *     session; it is skipped unless AB_LIVE_E2E=1 so CI/other agents are
 *     never exposed to it.
 *   - No test invokes a real (non-dry-run) `ab gc`.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import type { CdpPage, OpenTabDeps, TeardownDeps } from "../cli";
import {
  MAX_RECORDED_TARGETS,
  assignShard,
  closeCdpTarget,
  formatTeardownWarning,
  listCdpPages,
  openTabAndRecordTarget,
  readSessionTargets,
  readShardAssignment,
  recordSessionTarget,
  sessionFilePath,
  teardownSession,
} from "../cli";
import { HEADLESS_POOL_SIZE } from "../types";

// ---------------------------------------------------------------------------
// Local CDP fake — a real HTTP server on an ephemeral port, so the helpers'
// fetch/timeout/parse behavior is exercised for real without touching a shard.
// ---------------------------------------------------------------------------

interface CdpFake {
  port: number;
  stop: () => void;
  closed: string[];
}

function startCdpFake(opts: {
  list?: unknown;
  status?: number;
  hangMs?: number;
  closeStatus?: number;
}): CdpFake {
  const closed: string[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (opts.hangMs) await Bun.sleep(opts.hangMs);
      if (url.pathname === "/json/list") {
        if (opts.status && opts.status !== 200) {
          return new Response("nope", { status: opts.status });
        }
        return Response.json(opts.list ?? []);
      }
      if (url.pathname.startsWith("/json/close/")) {
        closed.push(url.pathname.slice("/json/close/".length));
        return new Response("Target is closing", { status: opts.closeStatus ?? 200 });
      }
      return new Response("not found", { status: 404 });
    },
  });
  return { port: Number(server.port), stop: () => server.stop(true), closed };
}

const servers: CdpFake[] = [];
function fake(opts: Parameters<typeof startCdpFake>[0]): CdpFake {
  const s = startCdpFake(opts);
  servers.push(s);
  return s;
}

afterEach(() => {
  while (servers.length) servers.pop()!.stop();
});

// A closed port nothing listens on. 1 is privileged/unused for CDP; using a
// high port we immediately free is more reliable than guessing.
function deadPort(): number {
  const s = Bun.serve({ port: 0, fetch: () => new Response("x") });
  const p = Number(s.port);
  s.stop(true);
  return p;
}

describe("listCdpPages", () => {
  test("returns page entries (id/url/title), filtering out non-page targets", async () => {
    const s = fake({
      list: [
        { id: "AAA", type: "page", url: "http://a/", title: "A" },
        { id: "BBB", type: "service_worker", url: "http://sw/", title: "SW" },
        { id: "CCC", type: "page", url: "about:blank", title: "" },
      ],
    });
    const pages = await listCdpPages(s.port);
    expect(pages).toEqual([
      { id: "AAA", url: "http://a/", title: "A" },
      { id: "CCC", url: "about:blank", title: "" },
    ]);
  });

  test("returns null (fails soft, no throw) when the shard is unreachable", async () => {
    const pages = await listCdpPages(deadPort());
    expect(pages).toBeNull();
  });

  test("returns null on a non-OK response", async () => {
    const s = fake({ status: 500 });
    expect(await listCdpPages(s.port)).toBeNull();
  });

  test("returns null on a non-array body instead of throwing", async () => {
    const s = fake({ list: { nope: true } });
    expect(await listCdpPages(s.port)).toBeNull();
  });

  test("times out rather than hanging gc", async () => {
    const s = fake({ hangMs: 5_000, list: [] });
    const started = Date.now();
    const pages = await listCdpPages(s.port, 150);
    expect(pages).toBeNull();
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});

describe("closeCdpTarget", () => {
  test("GETs /json/close/<targetId> and reports success", async () => {
    const s = fake({});
    expect(await closeCdpTarget(s.port, "68C98CC0AB")).toBe(true);
    expect(s.closed).toEqual(["68C98CC0AB"]);
  });

  test("reports failure on a non-OK response", async () => {
    const s = fake({ closeStatus: 404 });
    expect(await closeCdpTarget(s.port, "DEADBEEF")).toBe(false);
  });

  test("fails soft when the shard is unreachable", async () => {
    expect(await closeCdpTarget(deadPort(), "DEADBEEF")).toBe(false);
  });

  test("refuses a targetId that is not bare hex — never builds an injected path", async () => {
    const s = fake({});
    expect(await closeCdpTarget(s.port, "../../json/close/all")).toBe(false);
    expect(await closeCdpTarget(s.port, "")).toBe(false);
    expect(s.closed).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Session-marker target recording. Fixture pids are unique per run and always
// cleaned up; they never collide with a real session on the box.
// ---------------------------------------------------------------------------

const TEST_PREFIX = `abtest-teardown-${process.pid}-${Date.now()}`;
const madeMarkers: string[] = [];

function markerPid(suffix: string): string {
  const pid = `${TEST_PREFIX}-${suffix}`;
  madeMarkers.push(sessionFilePath(pid));
  return pid;
}

afterEach(() => {
  while (madeMarkers.length) {
    try { fs.unlinkSync(madeMarkers.pop()!); } catch { /* already gone */ }
  }
});

describe("session-marker target recording", () => {
  test("records a target and reads it back, scoped to the CDP port", () => {
    const pid = markerPid("record");
    fs.writeFileSync(sessionFilePath(pid), `${pid}\nshard=1\n`);

    recordSessionTarget(pid, 9334, "AAA111");
    recordSessionTarget(pid, 9444, "BBB222");

    expect(readSessionTargets(pid, 9334)).toEqual(["AAA111"]);
    expect(readSessionTargets(pid, 9444)).toEqual(["BBB222"]);
    expect(readSessionTargets(pid, 9333)).toEqual([]);
  });

  test("keeps every tab a session opened on one port, in order, deduped", () => {
    const pid = markerPid("multi");
    fs.writeFileSync(sessionFilePath(pid), `${pid}\n`);
    recordSessionTarget(pid, 9333, "AAA111");
    recordSessionTarget(pid, 9333, "BBB222");
    recordSessionTarget(pid, 9333, "AAA111"); // duplicate — must not double-record
    expect(readSessionTargets(pid, 9333)).toEqual(["AAA111", "BBB222"]);
  });

  test("preserves the pid line and the shard line", () => {
    const pid = markerPid("preserve");
    fs.writeFileSync(sessionFilePath(pid), `${pid}\nshard=2\n`);
    recordSessionTarget(pid, 9335, "CCC333");
    const lines = fs.readFileSync(sessionFilePath(pid), "utf-8").split("\n");
    expect(lines[0]).toBe(pid);
    expect(lines[1]).toBe("shard=2");
    expect(lines).toContain("target=9335:CCC333");
  });

  test("a later shard rewrite does not destroy recorded targets", () => {
    // assignShard() rewrites the marker via writeShardAssignment; before U1
    // that rewrite emitted only pid+shard and would have dropped target lines.
    const pid = markerPid("rewrite");
    fs.writeFileSync(sessionFilePath(pid), `${pid}\nshard=0\n`);
    recordSessionTarget(pid, 9333, "DDD444");
    assignShard(pid, 3, []);
    expect(readSessionTargets(pid, 9333)).toEqual(["DDD444"]);
  });

  test("ignores garbage lines and non-hex ids rather than returning them", () => {
    const pid = markerPid("garbage");
    fs.writeFileSync(
      sessionFilePath(pid),
      [pid, "shard=0", "target=", "target=nope", "target=9333:../evil", "target=9333:EEE555", "junk"].join("\n") + "\n",
    );
    expect(readSessionTargets(pid, 9333)).toEqual(["EEE555"]);
  });

  test("returns [] for a missing marker instead of throwing", () => {
    expect(readSessionTargets(`${TEST_PREFIX}-absent`, 9333)).toEqual([]);
  });

  test("caps recorded targets so a long-lived session can't grow the marker without bound", () => {
    const pid = markerPid("cap");
    fs.writeFileSync(sessionFilePath(pid), `${pid}\n`);
    for (let i = 0; i < MAX_RECORDED_TARGETS + 5; i++) {
      recordSessionTarget(pid, 9333, (0x100000 + i).toString(16).toUpperCase());
    }
    const kept = readSessionTargets(pid, 9333);
    expect(kept.length).toBe(MAX_RECORDED_TARGETS);
    // Oldest dropped, newest kept — a fresh tab is likelier to still exist.
    expect(kept[kept.length - 1]).toBe((0x100000 + MAX_RECORDED_TARGETS + 4).toString(16).toUpperCase());
  });
});

// ---------------------------------------------------------------------------
// teardownSession — fully injected. No real agent-browser, no real fetch, no
// shard contact, so this can never touch another agent's tab.
// ---------------------------------------------------------------------------

interface Recorder {
  deps: TeardownDeps;
  closed: string[];
  abCalls: string[][];
  cleared: number;
}

function recorder(opts: {
  targets?: string[];
  before?: CdpPage[] | null;
  after?: CdpPage[] | null;
  closeOk?: boolean;
}): Recorder {
  const closed: string[] = [];
  const abCalls: string[][] = [];
  let listCall = 0;
  const rec: Recorder = {
    closed,
    abCalls,
    cleared: 0,
    deps: {
      readTargets: () => opts.targets ?? [],
      clearTargets: () => { rec.cleared += 1; },
      listPages: async () => {
        listCall += 1;
        // Explicit `null` means "shard unreachable" — must not be coalesced.
        const v = listCall === 1
          ? ("before" in opts ? opts.before : [])
          : ("after" in opts ? opts.after : []);
        return v ?? null;
      },
      closeTarget: async (_port, id) => {
        closed.push(id);
        return opts.closeOk ?? true;
      },
      runAb: async (_port, _session, args) => {
        abCalls.push(args);
        return { exitCode: 0 };
      },
    },
  };
  return rec;
}

const page = (id: string): CdpPage => ({ id, url: `http://x/${id}`, title: id });

describe("teardownSession", () => {
  test("closes exactly the recorded target and verifies it is gone", async () => {
    const r = recorder({
      targets: ["AAA111"],
      before: [page("AAA111"), page("FOREIGN1"), page("FOREIGN2")],
      after: [page("FOREIGN1"), page("FOREIGN2")],
    });
    const result = await teardownSession("pid-1", 9333, r.deps);

    expect(result.ok).toBe(true);
    expect(result.reason).toBe("closed");
    expect(r.closed).toEqual(["AAA111"]);
    expect(result.pagesBefore).toBe(3);
    expect(result.pagesAfter).toBe(2);
    // Daemon still gets shut down, exactly as before U1.
    expect(r.abCalls).toEqual([["close"]]);
    // Identity consumed — a surviving marker can't re-target a dead id.
    expect(r.cleared).toBe(1);
  });

  test("a session with no recorded target touches NO tab (the 67-of-69 case)", async () => {
    const r = recorder({
      targets: [],
      before: [page("SOMEONE_ELSES_ONLY_TAB")],
      after: [page("SOMEONE_ELSES_ONLY_TAB")],
    });
    const result = await teardownSession("pid-markerless", 9333, r.deps);

    expect(r.closed).toEqual([]);
    expect(r.abCalls).toEqual([["close"]]); // daemon only
    expect(result.reason).toBe("no-recorded-target");
    expect(result.ok).toBe(true); // owning no tab is success, not failure
  });

  test("never closes a target it did not record, even when the shard is full of tabs", async () => {
    const r = recorder({
      targets: ["MINE01"],
      before: [page("FOREIGN1"), page("MINE01"), page("FOREIGN2"), page("FOREIGN3")],
      after: [page("FOREIGN1"), page("FOREIGN2"), page("FOREIGN3")],
    });
    await teardownSession("pid-2", 9333, r.deps);
    expect(r.closed).toEqual(["MINE01"]);
  });

  test("a recorded target already gone reports success without a close call", async () => {
    const r = recorder({
      targets: ["GONE01"],
      before: [page("FOREIGN1")],
      after: [page("FOREIGN1")],
    });
    const result = await teardownSession("pid-3", 9333, r.deps);
    expect(r.closed).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.reason).toBe("already-gone");
  });

  test("a surviving target is reported as failure (never inferred from exit code)", async () => {
    const r = recorder({
      targets: ["STUCK1"],
      before: [page("STUCK1"), page("FOREIGN1")],
      after: [page("STUCK1"), page("FOREIGN1")], // close silently did nothing
      closeOk: false,
    });
    const result = await teardownSession("pid-4", 9333, r.deps);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("target-survived");
    expect(result.survivors).toEqual(["STUCK1"]);
    expect(result.pagesBefore).toBe(2);
    expect(result.pagesAfter).toBe(2);
    expect(r.cleared).toBe(0); // identity kept so a later gc pass can retry
  });

  test("an unreachable shard fails soft: failure result, daemon still closed, no throw", async () => {
    const r = recorder({ targets: ["AAA111"], before: null, after: null });
    const result = await teardownSession("pid-5", 9333, r.deps);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("cdp-unreachable");
    expect(result.pagesBefore).toBeNull();
    expect(r.closed).toEqual([]); // can't see the shard → close nothing blindly
    expect(r.abCalls).toEqual([["close"]]);
  });

  test("a shard that vanishes mid-teardown reports unverified, not success", async () => {
    const r = recorder({
      targets: ["AAA111"],
      before: [page("AAA111")],
      after: null,
    });
    const result = await teardownSession("pid-6", 9333, r.deps);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("cdp-unreachable");
    expect(r.closed).toEqual(["AAA111"]);
  });

  test("closes every tab a multi-open session recorded", async () => {
    const r = recorder({
      targets: ["AAA111", "BBB222"],
      before: [page("AAA111"), page("BBB222"), page("FOREIGN1")],
      after: [page("FOREIGN1")],
    });
    const result = await teardownSession("pid-7", 9333, r.deps);
    expect(r.closed).toEqual(["AAA111", "BBB222"]);
    expect(result.ok).toBe(true);
  });
});

describe("formatTeardownWarning", () => {
  test("names shard, port, and expected vs observed page counts", () => {
    const msg = formatTeardownWarning("pid-9", 2, {
      ok: false,
      reason: "target-survived",
      port: 9335,
      targets: ["STUCK1"],
      survivors: ["STUCK1"],
      pagesBefore: 4,
      pagesAfter: 4,
    });
    expect(msg).toContain("shard=2");
    expect(msg).toContain("port=9335");
    expect(msg).toContain("pages 4");   // observed
    expect(msg).toContain("3");         // expected (before - closed)
    expect(msg).toContain("STUCK1");
  });

  test("labels a headed teardown as such instead of claiming shard 0", () => {
    const msg = formatTeardownWarning("pid-h", null, {
      ok: false,
      reason: "cdp-unreachable",
      port: 9444,
      targets: ["AAA111"],
      survivors: ["AAA111"],
      pagesBefore: null,
      pagesAfter: null,
    });
    expect(msg).toContain("shard=headed");
    expect(msg).not.toContain("shard=0");
  });
});

// ---------------------------------------------------------------------------
// openTabAndRecordTarget — the identity-capture half of `ab open`.
// ---------------------------------------------------------------------------

function openRecorder(opts: { before?: CdpPage[] | null; after?: CdpPage[] | null }): {
  deps: OpenTabDeps;
  abCalls: string[][];
  recorded: Array<{ pid: string; port: number; id: string }>;
} {
  const abCalls: string[][] = [];
  const recorded: Array<{ pid: string; port: number; id: string }> = [];
  let listCall = 0;
  return {
    abCalls,
    recorded,
    deps: {
      listPages: async () => {
        listCall += 1;
        const v = listCall === 1
          ? ("before" in opts ? opts.before : [])
          : ("after" in opts ? opts.after : []);
        return v ?? null;
      },
      runAb: async (_port, _session, args) => {
        abCalls.push(args);
        return { exitCode: 0 };
      },
      recordTarget: (pid, port, id) => { recorded.push({ pid, port, id }); },
    },
  };
}

describe("openTabAndRecordTarget", () => {
  test("records the single target that appeared around `tab new`", async () => {
    const r = openRecorder({
      before: [page("FOREIGN1")],
      after: [page("FOREIGN1"), page("NEW001")],
    });
    const id = await openTabAndRecordTarget("pid-o1", 9333, "ab-pid-o1", "http://localhost:1234/", r.deps);

    expect(id).toBe("NEW001");
    expect(r.recorded).toEqual([{ pid: "pid-o1", port: 9333, id: "NEW001" }]);
    expect(r.abCalls).toEqual([["tab", "new", "http://localhost:1234/"]]);
  });

  test("records nothing when two tabs appeared at once (concurrent agent) — never guesses", async () => {
    const r = openRecorder({
      before: [page("FOREIGN1")],
      after: [page("FOREIGN1"), page("NEW001"), page("OTHERAGENT")],
    });
    const id = await openTabAndRecordTarget("pid-o2", 9333, "ab-pid-o2", "http://x/", r.deps);
    expect(id).toBeNull();
    expect(r.recorded).toEqual([]);
  });

  test("records nothing when no new target appeared", async () => {
    const r = openRecorder({ before: [page("FOREIGN1")], after: [page("FOREIGN1")] });
    expect(await openTabAndRecordTarget("pid-o3", 9333, "ab-pid-o3", "http://x/", r.deps)).toBeNull();
    expect(r.recorded).toEqual([]);
  });

  test("still opens the tab when CDP is unreachable — identity is best-effort, open is not", async () => {
    const r = openRecorder({ before: null, after: null });
    const id = await openTabAndRecordTarget("pid-o4", 9333, "ab-pid-o4", "http://x/", r.deps);
    expect(id).toBeNull();
    expect(r.recorded).toEqual([]);
    expect(r.abCalls).toEqual([["tab", "new", "http://x/"]]);
  });
});

describe("teardownSession resilience", () => {
  test("a dep that throws yields a failure result, not an unhandled rejection", async () => {
    const boom = async () => { throw new Error("boom"); };
    const result = await teardownSession("pid-boom", 9333, {
      readTargets: () => ["AAA111"],
      clearTargets: () => {},
      listPages: boom as unknown as TeardownDeps["listPages"],
      closeTarget: boom as unknown as TeardownDeps["closeTarget"],
      runAb: boom as unknown as TeardownDeps["runAb"],
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("cdp-unreachable");
  });
});

// ---------------------------------------------------------------------------
// Real-invocation tests. Both obey ps.test.ts:17-24 — any real `ab gc` pins
// AB_GC_IDLE_GRACE_MS to SAFE_LARGE_GRACE_MS so only by-construction-stale
// fixtures of ours can ever be reaped.
// ---------------------------------------------------------------------------

const AB = path.resolve(import.meta.dir, "../../ab");
const SAFE_LARGE_GRACE_MS = String(1000 * 60 * 60 * 24 * 365); // 1 year

function runAb(args: string[], env: Record<string, string | undefined>) {
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
  const r = spawnSync(AB, args, { env: scrubbed, encoding: "utf-8" });
  return { code: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

describe("ab gc (real invocation, stale fixture only)", () => {
  test("reaps a target-less stale session without warning and without touching any tab", () => {
    const pid = markerPid("gcstale");
    const fp = sessionFilePath(pid);
    fs.writeFileSync(fp, `${pid}\nshard=0\n`); // shard 0, no target= line
    const old = new Date(Date.now() - 48 * 60 * 60 * 1000); // stale by construction
    fs.utimesSync(fp, old, old);

    const r = runAb(["gc"], { AB_GC_IDLE_GRACE_MS: SAFE_LARGE_GRACE_MS });

    expect(r.code).toBe(0);
    expect(r.stderr).toContain(`reaped: ${pid}`);
    // A session that recorded no target owns no tab: no close is attempted,
    // so there is nothing to fail to verify.
    expect(r.stderr).not.toContain("teardown unverified");
    expect(fs.existsSync(fp)).toBe(false);
  });
});

// Live end-to-end against the real shared Chrome pool. Opt-in (AB_LIVE_E2E=1)
// so a routine `bun test` by another agent never drives real Chrome. It only
// ever opens and closes a tab it created itself, pointed at a throwaway local
// server — never at anyone's dev server.
const liveE2E = process.env.AB_LIVE_E2E === "1" ? test : test.skip;

describe("live E2E: ab open → ab close returns the shard to its baseline", () => {
  liveE2E("closes the tab it opened, verified via /json/list", async () => {
    const srv = fake({});
    const shardPorts = Array.from({ length: HEADLESS_POOL_SIZE }, (_, i) => 9333 + i);
    const MAX_ATTEMPTS = 3;
    // Every marker created across retry attempts, so the finally block can
    // sweep all of them (not just the one that ultimately succeeded).
    const attemptedPids: string[] = [];

    try {
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        const pid = attempt === 1 ? markerPid("live") : markerPid(`live-r${attempt}`);
        attemptedPids.push(pid);
        const env = { AB_SESSION_PID: pid, AB_VIEWPORT: "skip" };

        try {
          expect(runAb(["new-session"], env).code).toBe(0);

          // Shard is only known once new-session assigns it, so the baseline
          // is taken here — scoped to just this session's shard. This is what
          // eliminates false failures from concurrent agents opening tabs on
          // OTHER shards during the test's window (a pool-wide count would
          // pick those up; this scoped count can't).
          const shard = readShardAssignment(pid) ?? 0;
          const port = 9333 + shard;
          const shardBaseline = (await listCdpPages(port))?.length ?? 0;

          const opened = runAb(["open", `http://127.0.0.1:${srv.port}/json/list`], env);
          expect(opened.code).toBe(0);

          // Identity was captured at open time. openTabAndRecordTarget
          // (cli.ts) intentionally records nothing when its own before/after
          // /json/list diff on this shard is ambiguous — e.g. a concurrent
          // agent opens a tab on the SAME shard inside that window. That's
          // "skip-when-ambiguous" working as designed (see the doc comment
          // above openTabAndRecordTarget), not a bug. A concurrent tab landing
          // just outside cmdOpen's own diff window instead shows up here as
          // our shardBaseline/count going stale relative to reality (observed
          // live: baseline+2 instead of baseline+1 with targets.length still
          // 1). Both are the same underlying phenomenon — real concurrent
          // traffic on a live shared shard overlapping our measurement window
          // — so both retry with a fresh session rather than asserting on an
          // inherently racy snapshot.
          const targets = readSessionTargets(pid, port);
          if (targets.length !== 1) {
            throw new Error(
              `readSessionTargets returned ${targets.length} target(s) (expected 1) — same-shard ambiguity`,
            );
          }

          const midPages = await listCdpPages(port);
          expect(midPages?.map((p) => p.id)).toContain(targets[0]);
          if ((midPages?.length ?? 0) !== shardBaseline + 1) {
            throw new Error(
              `shard page count was ${midPages?.length ?? 0}, expected baseline+1 (${shardBaseline + 1}) — concurrent same-shard activity`,
            );
          }

          const closed = runAb(["close"], env);
          expect(closed.code).toBe(0);
          expect(closed.stderr).not.toContain("teardown unverified");

          const afterPages = await listCdpPages(port);
          expect(afterPages?.map((p) => p.id)).not.toContain(targets[0]);
          if ((afterPages?.length ?? 0) !== shardBaseline) {
            throw new Error(
              `shard page count after close was ${afterPages?.length ?? 0}, expected baseline (${shardBaseline}) — concurrent same-shard activity`,
            );
          }

          return; // clean attempt: opened, verified, closed, verified restored
        } catch (err) {
          runAb(["close"], env); // best-effort; safe no-op if nothing was recorded
          if (attempt === MAX_ATTEMPTS) {
            throw new Error(
              `live E2E did not reach a clean, uncontended attempt after ${MAX_ATTEMPTS} tries against the shared shard. Last error: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        }
      }
    } finally {
      // Never leave a tab behind, even on assertion failure. Sweep every
      // marker created across retry attempts, not just the last one.
      //
      // Known residual: if an attempt hit same-shard ambiguity, the real tab
      // it opened is genuinely untracked (by design — see the retry comment
      // above) and this sweep, like production teardown, can only close
      // targets it recorded. That tab leaks until the next `ab gc` CDP sweep,
      // mirroring production's accepted behavior. We deliberately do not hunt
      // for an unidentified page to close, since that risks closing a
      // different concurrent agent's legitimate tab.
      for (const attemptedPid of attemptedPids) {
        for (const p of shardPorts) {
          for (const id of readSessionTargets(attemptedPid, p)) await closeCdpTarget(p, id);
        }
        try { fs.unlinkSync(`/tmp/ab-${attemptedPid}`); } catch { /* may not exist */ }
      }
    }
  }, 60_000);
});
