/**
 * Per-shard tab-count visibility in `ab status` / `ab doctor` —
 * tab-teardown-fix U3 (R5).
 *
 * Covers:
 *   - `buildTabCountChecks`: the pure, exported doctor-check builder
 *     (mirrors `buildHeadlessDoctorChecks`'s test seam) — binary ok/fail per
 *     Decision 7, threshold boundary pinned, null → ok "unreachable/idle".
 *   - `fetchTabCounts`: the pure-ish async helper that turns a `/status`
 *     snapshot into a `tabCounts` array, with an injectable `listPages` dep
 *     so no test ever contacts the real shared CDP pool.
 *   - Wiring: `ab status` (subprocess, read-only) actually includes a
 *     `tabCounts` field aligned with `headlessPool`; `ab doctor` (subprocess,
 *     read-only) actually renders a "Chrome tabs" line per shard.
 *
 * Safety note (mirrors ps.test.ts:17-24 and gc-sweep.test.ts): the two
 * subprocess tests below run `ab status` / `ab doctor` with NO mutating
 * flags — both commands only ever GET `/json/list` (read-only) and never
 * close, gc, or reap anything, so they are safe to run against the real
 * shared daemon/pool used by other concurrently-running agents.
 */
import { describe, expect, test } from "bun:test";
import { spawnSync } from "child_process";
import * as path from "path";
import {
  buildTabCountChecks,
  fetchTabCounts,
  TAB_WARN_THRESHOLD,
} from "../cli";
import type { CdpPage } from "../cli";
import type { ChromeState } from "../types";

const AB = path.resolve(import.meta.dir, "../../ab");

function runAb(args: string[]): { code: number; stdout: string; stderr: string } {
  const result = spawnSync(AB, args, { encoding: "utf8" });
  return { code: result.status ?? 1, stdout: result.stdout, stderr: result.stderr };
}

// ---------------------------------------------------------------------------
// buildTabCountChecks — pure decision logic (Decision 6/7/8)
// ---------------------------------------------------------------------------

describe("buildTabCountChecks", () => {
  test("one check per known count, all ok, details carry the count / idle wording", () => {
    const checks = buildTabCountChecks([3, null, 7]);
    expect(checks).toHaveLength(3);
    expect(checks[0]).toMatchObject({ ok: true, detail: "3 open pages" });
    expect(checks[1]).toMatchObject({ ok: true, detail: "unreachable/idle" });
    expect(checks[2]).toMatchObject({ ok: true, detail: "7 open pages" });
    // Every check must carry a shard-identifying label — otherwise a doctor
    // run with 3 shards prints 3 indistinguishable lines.
    expect(checks[0].label).not.toBe(checks[2].label);
  });

  test("boundary: exactly TAB_WARN_THRESHOLD is ok, one over is not (with the ab gc fix string)", () => {
    const [atThreshold, overThreshold] = buildTabCountChecks([TAB_WARN_THRESHOLD, TAB_WARN_THRESHOLD + 1]);
    expect(atThreshold.ok).toBe(true);
    expect(atThreshold.fix).toBeUndefined();
    expect(overThreshold.ok).toBe(false);
    expect(overThreshold.fix).toBe("ab gc   # or: ab heal");
    expect(overThreshold.detail).toBe(`${TAB_WARN_THRESHOLD + 1} open pages`);
  });

  test("a null count is a passing 'unreachable/idle' line, never a failure", () => {
    const [check] = buildTabCountChecks([null]);
    expect(check.ok).toBe(true);
    expect(check.fix).toBeUndefined();
    expect(check.detail).toBe("unreachable/idle");
  });
});

// ---------------------------------------------------------------------------
// fetchTabCounts — the async CDP-fetching helper, driven by an injected
// listPages dep so no test ever contacts the real shared pool.
// ---------------------------------------------------------------------------

function pool(...states: ChromeState[]): ChromeState[] {
  return states;
}

function pages(...ids: string[]): CdpPage[] {
  return ids.map((id) => ({ id, url: "http://localhost:5173/app", title: "t" }));
}

describe("fetchTabCounts", () => {
  test("pool-aware: chrome_up shards get their real page count, others get null", async () => {
    const headlessPool = pool(
      { phase: "chrome_up", pid: 1, port: 9333 },
      { phase: "idle" },
      { phase: "chrome_up", pid: 3, port: 9335 },
    );
    const byPort: Record<number, CdpPage[] | null> = {
      9333: pages("AAAA1111", "AAAA2222", "AAAA3333"),
      9335: pages("CCCC1111"),
    };
    const counts = await fetchTabCounts(headlessPool, undefined, async (port) => byPort[port] ?? null);
    expect(counts).toEqual([3, null, 1]);
  });

  test("a CDP fetch failure for one shard yields null for that shard only — others unaffected", async () => {
    const headlessPool = pool(
      { phase: "chrome_up", pid: 1, port: 9333 },
      { phase: "chrome_up", pid: 2, port: 9334 },
    );
    const counts = await fetchTabCounts(headlessPool, undefined, async (port) =>
      port === 9333 ? null /* simulated timeout/unreachable */ : pages("BBBB1111", "BBBB2222"),
    );
    expect(counts).toEqual([null, 2]);
  });

  test("legacy daemon (no headlessPool): falls back to a single-shard count from legacyHeadless", async () => {
    const legacyHeadless: ChromeState = { phase: "chrome_up", pid: 1, port: 9333 };
    const counts = await fetchTabCounts(undefined, legacyHeadless, async () => pages("DDDD1111"));
    expect(counts).toEqual([1]);
  });

  test("legacy daemon reporting Chrome down: single-shard null, no fetch attempted", async () => {
    const legacyHeadless: ChromeState = { phase: "idle" };
    let fetchAttempted = false;
    const counts = await fetchTabCounts(undefined, legacyHeadless, async () => {
      fetchAttempted = true;
      return pages("should-not-be-fetched");
    });
    expect(counts).toEqual([null]);
    expect(fetchAttempted).toBe(false);
  });

  test("no pool and no legacy headless: empty array, no fetch attempted", async () => {
    let fetchAttempted = false;
    const counts = await fetchTabCounts(undefined, undefined, async () => {
      fetchAttempted = true;
      return pages("x");
    });
    expect(counts).toEqual([]);
    expect(fetchAttempted).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Wiring — real subprocess, read-only, safe against the shared live daemon.
// ---------------------------------------------------------------------------

describe("ab status / ab doctor — tab-count wiring (subprocess, read-only)", () => {
  test("ab status JSON includes a tabCounts array aligned with headlessPool", () => {
    const r = runAb(["status"]);
    expect(r.code).toBe(0);
    const parsed = JSON.parse(r.stdout);
    expect(Array.isArray(parsed.tabCounts)).toBe(true);
    if (Array.isArray(parsed.headlessPool)) {
      expect(parsed.tabCounts).toHaveLength(parsed.headlessPool.length);
    }
    for (const count of parsed.tabCounts) {
      expect(count === null || typeof count === "number").toBe(true);
    }
  });

  test("ab doctor renders a 'Chrome tabs' line per shard", () => {
    const r = runAb(["doctor"]);
    expect(r.stdout).toContain("Chrome tabs (headless-0,");
  });
});
