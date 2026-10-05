/**
 * Session identity and its marker file /tmp/.ab-session-<pid>: line 1 is the
 * pid, then an optional `shard=<i>` line and any `target=<port>:<id>` lines.
 */
import * as fs from "fs";
import { CDP_TARGET_ID_RE } from "./cdp-http";

// ---------------------------------------------------------------------------
// Session pid resolution — the single source of truth.
//
// pid := AB_SESSION_PID (set by subagent hook) ?? CCO_SESSION_ID (main thread)
// file := /tmp/.ab-session-<pid>   (existence = initialized, content = pid)
//         line 2 is optional: `shard=<i>`, the session's sticky headless
//         pool shard (chrome-pool-plan.md Unit 2, decision 3). Written
//         lazily the first time a session needs headless Chrome.
// session := ab-<pid>               (agent-browser session identity)
// ---------------------------------------------------------------------------

/** Literal pid used when neither AB_SESSION_PID nor CCO_SESSION_ID is set. */
export const DEFAULT_PID = "default";

export function resolvePid(): string {
  return process.env.AB_SESSION_PID ?? process.env.CCO_SESSION_ID ?? DEFAULT_PID;
}

export function sessionFilePath(pid: string = resolvePid()): string {
  return `/tmp/.ab-session-${pid}`;
}

export function buildSessionName(pid: string = resolvePid()): string {
  return `ab-${pid}`;
}

/**
 * Read the shard a session is pinned to from its marker file's optional
 * second line. Returns null when the marker is missing, has no second line,
 * or the second line doesn't parse as `shard=<int>` — all treated as
 * "unassigned" so the caller can (re)assign or default.
 */
export function readShardAssignment(pid: string): number | null {
  let raw: string;
  try {
    raw = fs.readFileSync(sessionFilePath(pid), "utf-8");
  } catch {
    return null;
  }
  const line2 = raw.split("\n")[1];
  if (!line2) return null;
  const m = /^shard=(\d+)\s*$/.exec(line2);
  if (!m) return null;
  const n = Number.parseInt(m[1], 10);
  return Number.isFinite(n) ? n : null;
}

/**
 * Overwrite (or create) a session's marker with the given shard, preserving
 * line 1 (the pid) and any `target=` lines when the marker already exists
 * (tab-teardown-fix U1 — a shard rewrite must never destroy tab identity).
 */
export function writeShardAssignment(pid: string, shard: number): void {
  const fp = sessionFilePath(pid);
  let line1 = pid;
  let targetLines: string[] = [];
  try {
    const lines = fs.readFileSync(fp, "utf-8").split("\n");
    if (lines[0]) line1 = lines[0];
    targetLines = lines.filter((l) => l.startsWith(TARGET_LINE_PREFIX));
  } catch {
    // Marker doesn't exist yet — create it fresh below.
  }
  fs.writeFileSync(fp, [line1, `shard=${shard}`, ...targetLines, ""].join("\n"));
}

// ---------------------------------------------------------------------------
// Tab identity: `target=<cdpPort>:<targetId>` marker lines (tab-teardown-fix U1)
//
// WHY THIS EXISTS. Teardown used to ask agent-browser to close "the session's
// tab". Verified empirically 2026-08-04 against a live shard: on an attached
// shared CDP browser, `--session` does NOT scope tabs. A session-scoped `tab`
// listing enumerates every page on the shard (26 foreign tabs included), and a
// session-scoped `goto` navigates the browser's currently-focused target —
// which, after the per-invocation daemon respawn that every gc reap triggers,
// is routinely ANOTHER agent's tab. There is no other session→tab mapping
// anywhere in the system (the marker held pid+shard; `get cdp-url` returns the
// browser endpoint, not a page target; the `.config` sidecar is an opaque
// token).
//
// So identity is recorded at creation instead: `cmdOpen` diffs `/json/list`
// around its `tab new` and persists the target that appeared. Teardown closes
// exactly those ids over raw CDP. A session with no recorded target owns no
// tab and touches none — which is the common case (67 of 69 live markers had
// never used headless Chrome, yet all of them were aimed at shard 0, whose one
// page belonged to nobody; the binary's last-tab guard, not our code, is what
// had been preventing ~2,000 wrongful closures).
//
// The port is part of the key because a session can hold tabs on both a
// headless shard and headed Chrome; only the ones on the port being torn down
// are in scope.
// ---------------------------------------------------------------------------

const TARGET_LINE_PREFIX = "target=";

/** Upper bound on `target=` lines kept per marker. A session that opened more
 *  tabs than this is pathological; the oldest are dropped (a newer tab is more
 *  likely to still exist) and the U2 CDP sweep is the backstop for the rest. */
export const MAX_RECORDED_TARGETS = 200;

/** `target=<port>:<hex targetId>` — anything else in the marker is ignored. */
const TARGET_LINE_RE = /^target=(\d+):([0-9A-Fa-f]{4,})\s*$/;

function readMarkerLines(pid: string): string[] {
  try {
    return fs.readFileSync(sessionFilePath(pid), "utf-8").split("\n");
  } catch {
    return [];
  }
}

/**
 * The CDP target ids this session created on `cdpPort`, oldest first.
 * Returns [] for a missing marker, a marker with no target lines, or lines
 * that don't parse — all meaning "this session owns no known tab here", which
 * teardown must treat as "touch nothing".
 */
export function readSessionTargets(pid: string, cdpPort: number): string[] {
  const out: string[] = [];
  for (const line of readMarkerLines(pid)) {
    const m = TARGET_LINE_RE.exec(line);
    if (m && Number.parseInt(m[1], 10) === cdpPort) out.push(m[2]);
  }
  return out;
}

/**
 * Append `targetId` to the session's marker as a `target=<port>:<id>` line.
 * Best-effort and idempotent: a duplicate is a no-op, a malformed id is
 * refused, and any fs failure is swallowed (losing identity degrades teardown
 * to a no-op, which is safe — it must never break `ab open`).
 */
export function recordSessionTarget(pid: string, cdpPort: number, targetId: string): void {
  if (!CDP_TARGET_ID_RE.test(targetId)) return;
  const line = `${TARGET_LINE_PREFIX}${cdpPort}:${targetId}`;
  try {
    const lines = readMarkerLines(pid);
    if (lines.length === 0) {
      // No marker yet (session never ran `new-session`) — create a minimal one
      // rather than dropping identity on the floor.
      fs.writeFileSync(sessionFilePath(pid), [pid, line, ""].join("\n"));
      return;
    }
    if (lines.includes(line)) return;
    const kept = lines.filter((l) => l !== "" && !l.startsWith(TARGET_LINE_PREFIX));
    const targets = [...lines.filter((l) => l.startsWith(TARGET_LINE_PREFIX)), line];
    const capped = targets.slice(Math.max(0, targets.length - MAX_RECORDED_TARGETS));
    fs.writeFileSync(sessionFilePath(pid), [...kept, ...capped, ""].join("\n"));
  } catch {
    /* marker unwritable — teardown will simply have nothing to close */
  }
}

/** Drop every `target=` line for `cdpPort` (called after teardown closed
 *  them, so a marker that outlives the reap can't re-target dead ids). */
export function clearSessionTargets(pid: string, cdpPort: number): void {
  try {
    const lines = readMarkerLines(pid);
    if (lines.length === 0) return;
    const kept = lines.filter((l) => {
      if (l === "") return false;
      const m = TARGET_LINE_RE.exec(l);
      return !(m && Number.parseInt(m[1], 10) === cdpPort);
    });
    fs.writeFileSync(sessionFilePath(pid), [...kept, ""].join("\n"));
  } catch {
    /* best effort */
  }
}
