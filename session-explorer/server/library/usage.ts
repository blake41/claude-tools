import db from "../db.js";
import type { LibraryArtifact } from "./types.js";

const skillUsageStmt = db.prepare(`
  SELECT m.session_id, m.timestamp
  FROM messages m
  WHERE m.tool_name = 'Skill'
    AND json_extract(m.tool_input, '$.skill') = ?
`);

const agentUsageStmt = db.prepare(`
  SELECT m.session_id, m.timestamp
  FROM messages m
  WHERE m.tool_name = 'Agent'
    AND json_extract(m.tool_input, '$.subagent_type') = ?
`);

const commandUsageStmt = db.prepare(`
  SELECT m.session_id, m.timestamp
  FROM messages m
  WHERE m.role = 'user'
    AND m.message_type = 'text'
    AND (m.content = ? OR m.content LIKE ?)
`);

const sessionInfoStmt = db.prepare(`
  SELECT s.id, s.title, s.started_at, w.display_name as workspace_name, w.path as workspace_path
  FROM sessions s
  LEFT JOIN workspaces w ON s.workspace_id = w.id
  WHERE s.id = ?
`);

export interface UsageRow {
  session_id: string;
  timestamp: string | null;
}

export interface UsageSession {
  session_id: string;
  title: string | null;
  count: number;
  last_used: string | null;
  workspace_name: string | null;
  workspace_path: string | null;
  started_at: string | null;
}

export interface UsageStats {
  kind: "stats";
  total_invocations: number;
  last_used: string | null;
  top_sessions: UsageSession[];
  daily_buckets: Array<{ day: string; count: number }>;
}

export interface AlwaysOnUsage {
  kind: "always-on";
}

export type UsageResult = UsageStats | AlwaysOnUsage;

function fetchRowsForArtifact(artifact: LibraryArtifact): UsageRow[] {
  // Union all three event sources by name — see bulkUsageStats for rationale.
  const exact = `/${artifact.name}`;
  const prefix = `/${artifact.name} %`;
  const rows: UsageRow[] = [];
  rows.push(...(skillUsageStmt.all(artifact.name) as UsageRow[]));
  rows.push(...(agentUsageStmt.all(artifact.name) as UsageRow[]));
  rows.push(...(commandUsageStmt.all(exact, prefix) as UsageRow[]));
  return rows;
}

export function isAlwaysOn(artifact: LibraryArtifact): boolean {
  return artifact.type === "rule" || artifact.type === "claude-md" || artifact.type === "hook";
}

export function computeUsage(artifact: LibraryArtifact): UsageResult {
  if (isAlwaysOn(artifact)) {
    return { kind: "always-on" };
  }

  const rows = fetchRowsForArtifact(artifact);
  if (rows.length === 0) {
    return {
      kind: "stats",
      total_invocations: 0,
      last_used: null,
      top_sessions: [],
      daily_buckets: build90DayBuckets([]),
    };
  }

  // Aggregate by session
  const bySession = new Map<string, { count: number; last: string | null }>();
  let lastUsed: string | null = null;
  for (const r of rows) {
    const existing = bySession.get(r.session_id) ?? { count: 0, last: null };
    existing.count++;
    if (r.timestamp && (!existing.last || r.timestamp > existing.last)) existing.last = r.timestamp;
    bySession.set(r.session_id, existing);
    if (r.timestamp && (!lastUsed || r.timestamp > lastUsed)) lastUsed = r.timestamp;
  }

  // Top 5 sessions
  const sorted = Array.from(bySession.entries())
    .sort(([, a], [, b]) => b.count - a.count)
    .slice(0, 5);
  const topSessions: UsageSession[] = sorted.map(([sessionId, info]) => {
    const sess = sessionInfoStmt.get(sessionId) as
      | { id: string; title: string | null; started_at: string | null; workspace_name: string | null; workspace_path: string | null }
      | undefined;
    return {
      session_id: sessionId,
      title: sess?.title ?? null,
      count: info.count,
      last_used: info.last,
      workspace_name: sess?.workspace_name ?? null,
      workspace_path: sess?.workspace_path ?? null,
      started_at: sess?.started_at ?? null,
    };
  });

  return {
    kind: "stats",
    total_invocations: rows.length,
    last_used: lastUsed,
    top_sessions: topSessions,
    daily_buckets: build90DayBuckets(rows),
  };
}

function build90DayBuckets(rows: UsageRow[]): Array<{ day: string; count: number }> {
  const counts = new Map<string, number>();
  for (const r of rows) {
    if (!r.timestamp) continue;
    const day = r.timestamp.slice(0, 10); // YYYY-MM-DD
    counts.set(day, (counts.get(day) ?? 0) + 1);
  }
  const buckets: Array<{ day: string; count: number }> = [];
  const today = new Date();
  for (let i = 89; i >= 0; i--) {
    const d = new Date(today);
    d.setUTCDate(d.getUTCDate() - i);
    const key = d.toISOString().slice(0, 10);
    buckets.push({ day: key, count: counts.get(key) ?? 0 });
  }
  return buckets;
}

// Bulk aggregate queries — one per tool type, indexed once per call.
// Far cheaper than scanning the messages table per-artifact.
const skillAggStmt = db.prepare(`
  SELECT json_extract(tool_input, '$.skill') AS name,
         COUNT(*) AS total,
         MAX(timestamp) AS last_used
  FROM messages
  WHERE tool_name = 'Skill'
  GROUP BY name
`);

const agentAggStmt = db.prepare(`
  SELECT json_extract(tool_input, '$.subagent_type') AS name,
         COUNT(*) AS total,
         MAX(timestamp) AS last_used
  FROM messages
  WHERE tool_name = 'Agent'
  GROUP BY name
`);

let commandAggCache: Map<string, { total: number; last_used: string | null }> | null = null;
let commandAggCacheAt = 0;

function getCommandAgg(): Map<string, { total: number; last_used: string | null }> {
  // Cache for 60s — slash command queries scan a lot of messages content.
  if (commandAggCache && Date.now() - commandAggCacheAt < 60_000) return commandAggCache;
  const rows = db
    .prepare(
      `SELECT content, timestamp
       FROM messages
       WHERE role = 'user'
         AND message_type = 'text'
         AND content LIKE '/%'`
    )
    .all() as Array<{ content: string; timestamp: string | null }>;
  const map = new Map<string, { total: number; last_used: string | null }>();
  for (const r of rows) {
    // Match exact "/<name>" or "/<name> ..."
    const m = r.content.match(/^\/([A-Za-z0-9:_\-]+)(?:\s|$)/);
    if (!m) continue;
    const name = m[1];
    const existing = map.get(name);
    if (!existing) {
      map.set(name, { total: 1, last_used: r.timestamp });
    } else {
      existing.total++;
      if (r.timestamp && (!existing.last_used || r.timestamp > existing.last_used)) {
        existing.last_used = r.timestamp;
      }
    }
  }
  commandAggCache = map;
  commandAggCacheAt = Date.now();
  return map;
}

export function invalidateUsageCache(): void {
  commandAggCache = null;
  commandAggCacheAt = 0;
}

export interface UsageBucket {
  total: number;
  // Sum of direct invocations of every artifact that references this one
  // (one-hop transitive credit, no cycle handling needed at depth 1). Lets
  // commands like /architect-tasks — never typed directly but invoked inside
  // /ship's body — surface their actual usage.
  indirect_total: number;
  last_used: string | null;
}

export function bulkUsageStats(artifacts: LibraryArtifact[]): Map<string, UsageBucket> {
  // One aggregate fetch per tool type, then map artifact → stats by name.
  const skillRows = skillAggStmt.all() as Array<{ name: string | null; total: number; last_used: string | null }>;
  const agentRows = agentAggStmt.all() as Array<{ name: string | null; total: number; last_used: string | null }>;
  const skillByName = new Map<string, { total: number; last_used: string | null }>();
  for (const r of skillRows) {
    if (r.name) skillByName.set(r.name, { total: r.total, last_used: r.last_used });
  }
  const agentByName = new Map<string, { total: number; last_used: string | null }>();
  for (const r of agentRows) {
    if (r.name) agentByName.set(r.name, { total: r.total, last_used: r.last_used });
  }
  const commandByName = getCommandAgg();

  // Pass 1: direct invocations per artifact. Sum across ALL three event
  // sources because Claude Code's harness routes commands through the Skill
  // tool too — e.g. when /ship's body says "use architect-tasks", a
  // Skill('architect-tasks') tool call fires even though architect-tasks
  // lives in commands/. Looking up only one source per type undercounted
  // those events. Slight double-count when the user types /foo and the
  // harness then routes it through Skill('foo') in the same session;
  // accepted as <5% noise.
  const direct = new Map<string, { total: number; last_used: string | null }>();
  for (const a of artifacts) {
    if (isAlwaysOn(a)) {
      direct.set(a.id, { total: 0, last_used: null });
      continue;
    }
    const sources = [
      skillByName.get(a.name),
      agentByName.get(a.name),
      commandByName.get(a.name),
    ];
    let total = 0;
    let last_used: string | null = null;
    for (const s of sources) {
      if (!s) continue;
      total += s.total;
      if (s.last_used && (!last_used || s.last_used > last_used)) last_used = s.last_used;
    }
    direct.set(a.id, { total, last_used });
  }

  // Pass 2: indirect = sum of direct totals of artifacts pointing at this one.
  const result = new Map<string, UsageBucket>();
  for (const a of artifacts) {
    const own = direct.get(a.id) ?? { total: 0, last_used: null };
    let indirect = 0;
    for (const ref of a.referencedByList) {
      indirect += direct.get(ref.targetId)?.total ?? 0;
    }
    result.set(a.id, { total: own.total, indirect_total: indirect, last_used: own.last_used });
  }
  return result;
}
