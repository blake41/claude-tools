/**
 * Session inventory, teardown and gc passes for `ab ps` / `ab gc` / `ab close`.
 *
 * The command handlers (`cmdPs`, `cmdGc`) stay in cli.ts; this module owns the
 * pieces they compose: session-file reaping, the 3-state session listing,
 * verified tab teardown, orphan-wrapper detection and the orphan-tab sweep.
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { ChromeState } from "./types";
import { closeCdpTarget, listCdpPages } from "./cdp-http";
import type { CdpPage } from "./cdp-http";
import { runAgentBrowser } from "./exec";
import type { ExecResult } from "./exec";
import {
  buildSessionName,
  clearSessionTargets,
  readSessionTargets,
  readShardAssignment,
  resolvePid,
} from "./session";

// ---------------------------------------------------------------------------
// ab ps + ab gc — session inventory and cleanup.
//
// Three-state liveness, derived from real daemon state (not just marker
// file existence):
//   - active — the per-session agent-browser daemon is alive
//     (~/.agent-browser/ab-<pid>.pid names a live OS pid)
//   - idle   — daemon is dead, marker age <= STALE_AGE_MS
//   - stale  — daemon is dead, marker age > STALE_AGE_MS
// CDP /json/list cross-check is explicitly deferred — pid-file check is
// sufficient for v1 and keeps this dependency-free.
// ---------------------------------------------------------------------------

export const SESSION_FILE_PREFIX = "/tmp/.ab-session-";
export const WRAPPER_PREFIX = "/tmp/ab-";
const STALE_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * Remove a session's marker, wrapper and the opaque `ab-<pid>.config` sidecar
 * its agent-browser daemon leaves behind (~1,936 had accumulated). Each is
 * best-effort: any of them may legitimately not exist.
 */
export function reapSessionFiles(
  pid: string,
  opts: { keepWrapper?: boolean; configDir?: string } = {},
): void {
  const configDir = opts.configDir ?? path.join(os.homedir(), ".agent-browser");
  const targets = [`${SESSION_FILE_PREFIX}${pid}`, path.join(configDir, `ab-${pid}.config`)];
  if (!opts.keepWrapper) targets.push(`${WRAPPER_PREFIX}${pid}`);
  for (const t of targets) {
    try { fs.unlinkSync(t); } catch { /* already gone */ }
  }
}

/** Grace window before an idle (daemon-dead, not-yet-stale) session is reaped by `ab gc`. */
export const IDLE_GRACE_MS = Number(process.env.AB_GC_IDLE_GRACE_MS ?? 30 * 60 * 1000);

function daemonPidFilePath(sessionPid: string): string {
  return path.join(os.homedir(), ".agent-browser", `ab-${sessionPid}.pid`);
}

/** Returns the per-session daemon's OS pid if alive, else null. */
function daemonPidAlive(sessionPid: string): number | null {
  let raw: string;
  try {
    raw = fs.readFileSync(daemonPidFilePath(sessionPid), "utf-8").trim();
  } catch {
    return null; // no pid file — daemon never started or already cleaned up
  }
  const pid = Number.parseInt(raw, 10);
  if (!Number.isFinite(pid) || pid <= 0) return null;
  try {
    process.kill(pid, 0); // signal 0: existence check only, doesn't kill
    return pid; // no throw — process exists and we can signal it
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === "EPERM") return pid; // exists, owned by another user — still alive
    return null; // ESRCH (or anything else) — dead
  }
}

export interface SessionEntry {
  pid: string;
  session: string;
  owner: "self" | "self (main-thread)" | "subagent" | "other-cc" | "other-cc (subagent)";
  mtimeIso: string;
  ageSeconds: number;
  state: "active" | "idle" | "stale";
  daemonPid: number | null;
  /** Headless shard this session is pinned to, or null if unassigned
   *  (legacy marker, headed-only session, or never touched Chrome). */
  shard: number | null;
}

export function listSessionEntries(now: Date = new Date()): SessionEntry[] {
  const dir = "/tmp";
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const prefix = ".ab-session-";
  const selfPid = resolvePid();
  const cco = process.env.CCO_SESSION_ID;
  const entries: SessionEntry[] = [];
  for (const name of names) {
    if (!name.startsWith(prefix)) continue;
    const pid = name.slice(prefix.length);
    if (!pid) continue;
    const fp = `${dir}/${name}`;
    let stat: fs.Stats;
    try {
      stat = fs.statSync(fp);
    } catch {
      continue;
    }
    if (!stat.isFile()) continue;
    const ageMs = now.getTime() - stat.mtimeMs;
    const daemonPid = daemonPidAlive(pid);
    const state: SessionEntry["state"] =
      daemonPid !== null ? "active" : ageMs > STALE_AGE_MS ? "stale" : "idle";
    entries.push({
      pid,
      session: `ab-${pid}`,
      owner: classifyOwner(pid, selfPid, cco),
      mtimeIso: new Date(stat.mtimeMs).toISOString(),
      ageSeconds: Math.max(0, Math.floor(ageMs / 1000)),
      state,
      daemonPid,
      shard: readShardAssignment(pid),
    });
  }
  entries.sort((a, b) => {
    // self first, then lexicographic by pid
    if (a.owner === "self" && b.owner !== "self") return -1;
    if (b.owner === "self" && a.owner !== "self") return 1;
    return a.pid.localeCompare(b.pid);
  });
  return entries;
}

function classifyOwner(
  pid: string,
  selfPid: string,
  cco: string | undefined,
): SessionEntry["owner"] {
  if (pid === selfPid) return "self";
  if (cco && pid === cco) return "self (main-thread)";
  if (cco && pid.startsWith(cco + "-")) return "subagent";
  return pid.includes("-") ? "other-cc (subagent)" : "other-cc";
}

export function formatAge(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86400)}d`;
}

export interface TeardownResult {
  /** True when every recorded target for this port is confirmed absent from
   *  CDP afterwards (including the "owned nothing" case). Never inferred
   *  from an exit code — see tab-teardown-fix decision 4. */
  ok: boolean;
  reason:
    | "no-recorded-target" // session owns no tab here — nothing was touched
    | "already-gone"       // its tabs were already closed by someone else
    | "closed"             // closed and verified gone
    | "target-survived"    // close didn't take — tab is still open
    | "cdp-unreachable";   // couldn't observe the shard — outcome unverified
  port: number;
  /** Recorded targets this teardown was responsible for. */
  targets: string[];
  /** Recorded targets still present after the attempt. */
  survivors: string[];
  pagesBefore: number | null;
  pagesAfter: number | null;
}

/** Seams for tests — production callers use the defaults. Injecting these is
 *  what lets the teardown contract be tested without an agent-browser binary
 *  or any contact with the shared shard pool. */
export interface TeardownDeps {
  listPages: (port: number) => Promise<CdpPage[] | null>;
  closeTarget: (port: number, targetId: string) => Promise<boolean>;
  runAb: (port: number, sessionName: string | null, args: string[]) => Promise<ExecResult>;
  readTargets: (pid: string, port: number) => string[];
  clearTargets: (pid: string, port: number) => void;
}

const DEFAULT_TEARDOWN_DEPS: TeardownDeps = {
  listPages: (port) => listCdpPages(port),
  closeTarget: (port, id) => closeCdpTarget(port, id),
  runAb: (port, sessionName, args) => runAgentBrowser(port, sessionName, args),
  readTargets: readSessionTargets,
  clearTargets: clearSessionTargets,
};

/**
 * Tear down a session's Chrome tabs (tab-teardown-fix U1).
 *
 * Closes ONLY the CDP targets this session recorded at `ab open` time (see
 * the tab-identity block above), by exact targetId over raw CDP, then shuts
 * the per-session daemon down as before, then re-queries `/json/list` and
 * confirms those ids are actually gone.
 *
 * Two properties matter more than the close itself:
 *  - A session with no recorded target closes NOTHING. The previous
 *    implementation asked agent-browser to close "the session's tab" on a
 *    shard where that session had never opened one, which aimed a close at
 *    whatever tab happened to be focused — another agent's, in the measured
 *    case. Only the binary's last-tab guard prevented ~2,000 such closures.
 *  - The result is verified, never assumed. The original bug survived ~2,342
 *    reaps because nothing ever looked at the tab state afterwards.
 *
 * Never boots Chrome; callers must already know the shard is up (via
 * `portForShard`/status). Fail-soft throughout: an unreachable shard yields
 * an unverified failure result, never a throw and never a hang.
 */
export async function teardownSession(
  sessionPid: string,
  cdpPort: number,
  deps: TeardownDeps = DEFAULT_TEARDOWN_DEPS,
): Promise<TeardownResult> {
  try {
    return await teardownSessionInner(sessionPid, cdpPort, deps);
  } catch {
    // Belt-and-braces: gc reaps entries in a loop and one wedged session must
    // never abort the rest of the run (tab-teardown-fix U1).
    return {
      ok: false,
      reason: "cdp-unreachable",
      port: cdpPort,
      targets: [],
      survivors: [],
      pagesBefore: null,
      pagesAfter: null,
    };
  }
}

async function teardownSessionInner(
  sessionPid: string,
  cdpPort: number,
  deps: TeardownDeps,
): Promise<TeardownResult> {
  const sessionName = buildSessionName(sessionPid);
  const targets = deps.readTargets(sessionPid, cdpPort);

  // Bare `close` only shuts down the per-session daemon — in attached-CDP
  // mode it never closes the Chrome tab (verified 2026-07-10 via
  // `/json/list`: the tab survives). It's still correct and still cheap, so
  // it runs on every path; the tab itself is handled over CDP above it.
  const closeDaemon = () => deps.runAb(cdpPort, sessionName, ["close"]);

  if (targets.length === 0) {
    await closeDaemon();
    return {
      ok: true,
      reason: "no-recorded-target",
      port: cdpPort,
      targets: [],
      survivors: [],
      pagesBefore: null,
      pagesAfter: null,
    };
  }

  const before = await deps.listPages(cdpPort);
  if (before === null) {
    // Can't see the shard — do NOT close blindly, and don't claim success.
    await closeDaemon();
    return {
      ok: false,
      reason: "cdp-unreachable",
      port: cdpPort,
      targets,
      survivors: targets,
      pagesBefore: null,
      pagesAfter: null,
    };
  }

  const presentIds = new Set(before.map((p) => p.id));
  const present = targets.filter((id) => presentIds.has(id));
  for (const id of present) {
    await deps.closeTarget(cdpPort, id);
  }

  await closeDaemon();

  const after = await deps.listPages(cdpPort);
  if (after === null) {
    return {
      ok: false,
      reason: "cdp-unreachable",
      port: cdpPort,
      targets,
      survivors: present,
      pagesBefore: before.length,
      pagesAfter: null,
    };
  }

  const afterIds = new Set(after.map((p) => p.id));
  const survivors = targets.filter((id) => afterIds.has(id));
  const ok = survivors.length === 0;
  if (ok) deps.clearTargets(sessionPid, cdpPort);

  return {
    ok,
    reason: ok ? (present.length > 0 ? "closed" : "already-gone") : "target-survived",
    port: cdpPort,
    targets,
    survivors,
    pagesBefore: before.length,
    pagesAfter: after.length,
  };
}

/**
 * One-line teardown-failure warning shared by both call sites (`ab gc` and
 * `ab close`). Carries shard, port, and expected-vs-observed page counts so
 * `/tmp/ab-gc.log` shows what actually happened, per the plan's requirement
 * that failures be visible rather than fatal.
 */
export function formatTeardownWarning(
  sessionPid: string,
  /** Headless shard index, or null for headed Chrome (which has no shard —
   *  reporting "shard=0" there would send a reader to the wrong browser). */
  shard: number | null,
  r: TeardownResult,
): string {
  const closedCount = r.targets.length - r.survivors.length;
  const expected = r.pagesBefore === null ? "?" : String(r.pagesBefore - closedCount);
  const observed = r.pagesAfter === null ? "?" : String(r.pagesAfter);
  return (
    `warn: teardown unverified for ${sessionPid} — ${r.reason}; ` +
    `shard=${shard === null ? "headed" : shard} port=${r.port} pages ${observed} (expected ${expected}); ` +
    `targets=[${r.targets.join(",")}] survived=[${r.survivors.join(",")}]`
  );
}

/** Guard regex for orphan-wrapper sweep: hex-ish session pid shapes only.
 *  Deliberately excludes name-adjacent sidecar files like
 *  `ab-server-out.log` / `ab-server-error.log` (see plan history: a prior
 *  glob-based cleanup deleted `ab-server.sock` this way). */
const ORPHAN_WRAPPER_NAME_RE = /^ab-[0-9a-f][0-9a-f-]*$/i;

/**
 * Second gc pass: wrapper shims in /tmp with no matching session marker
 * (already reaped, or never had one) that are old enough (> STALE_AGE_MS)
 * to be confidently orphaned. Guarded hard against non-session sidecar
 * files sharing the `/tmp/ab-*` prefix.
 */
export function findOrphanWrappers(entries: SessionEntry[], now: Date = new Date()): string[] {
  const dir = "/tmp";
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const knownPids = new Set(entries.map((e) => e.pid));
  const orphans: string[] = [];
  for (const name of names) {
    if (!ORPHAN_WRAPPER_NAME_RE.test(name)) continue;
    const pid = name.slice("ab-".length);
    if (knownPids.has(pid)) continue; // has a marker — not orphaned
    const fp = `${dir}/${name}`;
    let stat: fs.Stats;
    try {
      stat = fs.statSync(fp);
    } catch {
      continue;
    }
    if (!stat.isFile()) continue;
    const isExecutable = (stat.mode & 0o111) !== 0;
    if (!isExecutable) continue; // real wrapper shims are chmod +x
    if (now.getTime() - stat.mtimeMs <= STALE_AGE_MS) continue;
    orphans.push(fp);
  }
  return orphans;
}

// ---------------------------------------------------------------------------
// Third gc pass: backstop orphan-tab sweep (tab-teardown-fix U2 — genuine
// backstop: raw CDP has no last-tab guard; only path that reaches zero leaked
// pages, per decision 3).
//
// It exists because per-session teardown structurally cannot reach every
// leaked page: a session whose marker is already gone has no teardown path at
// all, and a page created before tab-identity recording existed was never
// attributable to its session in the first place.
//
// Ownership rule (decision 9 — the highest-consequence constraint in the
// plan). The shared shard pool serves concurrently-running agents, so closing
// a live agent's tab mid-QA-run is far worse than missing a leaked tab for one
// 30-minute gc cycle. A page is therefore only ever closed when NOTHING can
// claim it, and every uncertain case is skipped and logged instead.
// ---------------------------------------------------------------------------

/** What a still-live session contributes to attribution on ONE shard. */
export interface ShardSessionEvidence {
  pid: string;
  state: SessionEntry["state"];
  /** Shard the marker pins this session to, or null when unassigned. */
  shard: number | null;
  /** Target ids this session recorded on the swept shard's CDP port
   *  (`readSessionTargets`) — the only precise session→tab mapping that
   *  exists (tab-teardown-fix U1). */
  targets: string[];
}

export interface OrphanPartition {
  /** Attributable to nobody — safe to close. */
  orphans: CdpPage[];
  /** Might belong to a live agent — skipped and logged, NEVER closed. */
  ambiguous: Array<{ page: CdpPage; reason: string }>;
  /** Claimed by a live session's recorded tab identity. */
  owned: Array<{ page: CdpPage; pid: string }>;
}

/** Only real navigations can collide meaningfully; `about:blank` and
 *  devtools/chrome-internal URLs are shared by every leaked residue tab and
 *  would make the collision rule swallow the entire sweep. */
function isAttributableUrl(url: string): boolean {
  return /^https?:\/\//i.test(url);
}

/**
 * Partition one shard's CDP pages into owned / ambiguous / orphan.
 *
 * Pure and exported as the unit-test seam, modeled on `findOrphanWrappers`.
 *
 * Attribution uses the `target=<port>:<id>` marker lines U1 records at `ab
 * open` time. (The plan's preferred mechanism — a per-active-session
 * agent-browser `tab` listing — was ruled out by U1's empirical finding that
 * `--session` does NOT scope tab listings on an attached shared browser: it
 * enumerates every page on the shard, so it attributes nothing.)
 *
 * Two distinct sources of doubt both resolve to `ambiguous`:
 *  1. ANY active session pinned to this shard freezes every unclaimed page on
 *     it. Recorded identity proves what a session DOES own, never what it
 *     doesn't: a pre-U1 marker recorded nothing at all, and a page the site
 *     itself spawned (window.open, target=_blank, an OAuth popup) is created
 *     without going through `ab open`, so it is never recorded. We cannot tell
 *     WHICH unclaimed page might be that agent's, so none of them are touched.
 *     Cost: the sweep is a no-op on a shard with a live agent on it, and drains
 *     that shard on a later cycle instead. That is the trade decision 9 makes
 *     explicitly — missing a leaked tab for a cycle is cheap; closing a tab out
 *     from under a running QA agent is not.
 *  2. An unclaimed page whose URL matches a page a live session does own —
 *     plausibly that same agent's untracked second tab on the same app.
 */
export function partitionOrphanTargets(
  pages: CdpPage[],
  evidence: ShardSessionEvidence[],
  shard: number,
): OrphanPartition {
  const ownerById = new Map<string, string>();
  for (const e of evidence) {
    for (const id of e.targets) {
      if (!ownerById.has(id)) ownerById.set(id, e.pid);
    }
  }

  const activeHere = evidence
    .filter((e) => e.state === "active" && (e.shard ?? 0) === shard)
    .map((e) => e.pid);

  const claimedUrls = new Set<string>();
  for (const p of pages) {
    if (ownerById.has(p.id) && isAttributableUrl(p.url)) claimedUrls.add(p.url);
  }

  const result: OrphanPartition = { orphans: [], ambiguous: [], owned: [] };
  for (const p of pages) {
    const pid = ownerById.get(p.id);
    if (pid !== undefined) {
      result.owned.push({ page: p, pid });
      continue;
    }
    if (activeHere.length > 0) {
      result.ambiguous.push({
        page: p,
        reason: `active session(s) [${activeHere.join(",")}] pinned to shard ${shard} — unrecorded ownership cannot be ruled out`,
      });
      continue;
    }
    if (isAttributableUrl(p.url) && claimedUrls.has(p.url)) {
      result.ambiguous.push({
        page: p,
        reason: `url collides with a live session's tab (${p.url}) — could be that agent's untracked tab`,
      });
      continue;
    }
    result.orphans.push(p);
  }
  return result;
}

export interface SweepShard {
  shard: number;
  port: number;
}

/**
 * The shards the sweep may touch: `phase === "chrome_up"` only, matching
 * `portForShard`'s gating — a shard that isn't up has no pages and must not
 * be fetched (and must certainly never be booted by gc).
 *
 * Differs from `portForShard` in one deliberate way: a pre-pool daemon (no
 * `headlessPool` on /status) runs ONE headless Chrome that `portForShard`
 * reports for every shard index. Sweeping it once per shard would list and
 * close the same pages N times, so it collapses to a single entry here.
 */
export function sweepShards(
  headlessPool: ChromeState[] | undefined,
  legacyHeadless: ChromeState | undefined,
): SweepShard[] {
  const out: SweepShard[] = [];
  if (headlessPool) {
    for (let i = 0; i < headlessPool.length; i++) {
      const state = headlessPool[i];
      if (state && state.phase === "chrome_up") out.push({ shard: i, port: state.port });
    }
    return out;
  }
  if (legacyHeadless && legacyHeadless.phase === "chrome_up") {
    out.push({ shard: 0, port: legacyHeadless.port });
  }
  return out;
}

/** Seams for tests — production passes the raw-CDP defaults. Injecting these
 *  is what lets the sweep's close path be tested without any contact with the
 *  shared shard pool serving other live agents. */
export interface SweepDeps {
  listPages: (port: number) => Promise<CdpPage[] | null>;
  closeTarget: (port: number, targetId: string) => Promise<boolean>;
}

const DEFAULT_SWEEP_DEPS: SweepDeps = {
  listPages: (port) => listCdpPages(port),
  closeTarget: (port, id) => closeCdpTarget(port, id),
};

export interface SweepSummary {
  scanned: number;
  owned: number;
  ambiguous: number;
  /** Orphans reported under --dry-run (nothing was closed). */
  wouldClose: number;
  closed: number;
  failed: number;
  /** Shards whose `/json/list` couldn't be read — skipped, never guessed at. */
  unreachable: number;
}

export interface SweepOptions {
  shards: SweepShard[];
  /** Attribution evidence for one shard, resolved lazily so a shard that
   *  can't be listed costs no marker reads. */
  evidenceFor: (shard: SweepShard) => ShardSessionEvidence[];
  dryRun: boolean;
  deps?: SweepDeps;
  /** --dry-run report lines (stdout). */
  out: (line: string) => void;
  /** Normal-verbosity operational lines (stderr → /tmp/ab-gc.log). */
  warn: (line: string) => void;
}

/**
 * Run the backstop sweep across the given shards (tab-teardown-fix U2).
 *
 * Fail-soft at every step: an unreachable shard is skipped rather than
 * guessed at, a close failure is logged and the loop continues, and nothing
 * throws out of here — gc must always finish its run.
 */
export async function sweepOrphanTabs(opts: SweepOptions): Promise<SweepSummary> {
  const deps = opts.deps ?? DEFAULT_SWEEP_DEPS;
  const summary: SweepSummary = {
    scanned: 0,
    owned: 0,
    ambiguous: 0,
    wouldClose: 0,
    closed: 0,
    failed: 0,
    unreachable: 0,
  };
  // Informational lines go to stdout in dry-run (where they ARE the report)
  // and stderr otherwise (where the gc log lives).
  const emit = (line: string) => (opts.dryRun ? opts.out(line) : opts.warn(line));

  for (const s of opts.shards) {
    let pages: CdpPage[] | null;
    try {
      pages = await deps.listPages(s.port);
    } catch {
      pages = null;
    }
    if (pages === null) {
      summary.unreachable += 1;
      emit(`orphan tab  action=skip (unreadable): shard=${s.shard} port=${s.port} — CDP list failed`);
      continue;
    }
    summary.scanned += pages.length;

    const { orphans, ambiguous, owned } = partitionOrphanTargets(pages, opts.evidenceFor(s), s.shard);
    summary.owned += owned.length;
    summary.ambiguous += ambiguous.length;

    for (const a of ambiguous) {
      emit(
        `orphan tab  action=skip (ambiguous): shard=${s.shard} targetId=${a.page.id} url=${a.page.url} reason=${a.reason}`,
      );
    }

    for (const p of orphans) {
      const where = `shard=${s.shard} targetId=${p.id} url=${p.url}`;
      if (opts.dryRun) {
        summary.wouldClose += 1;
        opts.out(`orphan tab  action=close: ${where}`);
        continue;
      }
      let ok = false;
      try {
        ok = await deps.closeTarget(s.port, p.id);
      } catch {
        ok = false;
      }
      if (ok) {
        summary.closed += 1;
        opts.warn(`reaped orphan tab: ${where}`);
      } else {
        summary.failed += 1;
        opts.warn(`warn: orphan tab close failed: ${where}`);
      }
    }
  }
  return summary;
}

/**
 * Builds the gc sweep's `evidenceFor` callback (F1 fix, tab-teardown-fix
 * follow-up).
 *
 * Must NOT close over a start-of-run `listSessionEntries()` snapshot: the
 * reap loop between that snapshot and the sweep evaluating a given shard can
 * run 30-60+ seconds under a backlog (up to two 2s-timeout CDP lists and a
 * spawned `agent-browser close` per idle/stale entry). A session created
 * during that window would be invisible to a stale snapshot, so its
 * freshly-opened, correctly-recorded tab would read as unclaimed —
 * `sweepOrphanTabs` would close it live, mid-QA-run, for another agent.
 *
 * `evidenceFor` is already invoked lazily, once per shard, by design — this
 * just makes each call re-scan `listSessionEntries()` fresh instead of
 * reusing an old array, so evidence reflects the world as it is at the
 * moment each shard is actually evaluated.
 */
export function makeGcSweepEvidenceProvider(
  reapedPids: Set<string>,
  poolSize: number,
  listEntries: () => SessionEntry[] = listSessionEntries,
): (shard: SweepShard) => ShardSessionEvidence[] {
  return ({ port }) =>
    listEntries()
      .filter((e) => !reapedPids.has(e.pid))
      .map((e) => ({
        pid: e.pid,
        state: e.state,
        // Clamp exactly like resolveTeardownShard, but WITHOUT its marker
        // rewrite — the sweep must not mutate other agents' markers.
        shard: e.shard === null ? null : e.shard % poolSize,
        targets: readSessionTargets(e.pid, port),
      }));
}
