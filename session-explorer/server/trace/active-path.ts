// Active-path pre-filter for Claude Code JSONL transcripts.
//
// Ports the branch/DAG RULES (not the code) from claude-code-log's
// `claude_code_log/dag.py` into a standalone, pure filter that runs in
// FRONT of the vendored claude-devtools pipeline (server/trace/index.ts),
// which parses records in raw file order and has no branch semantics.
//
// See ACTIVE-PATH.md for the rule-by-rule provenance mapping and
// documented divergences from upstream.

// ── Types ──────────────────────────────────────────────────────────

interface ToolResultBlock {
  type: "tool_result";
  [key: string]: unknown;
}

interface RawRecord {
  type?: string;
  uuid?: string;
  parentUuid?: string | null;
  timestamp?: string;
  leafUuid?: string;
  message?: {
    role?: string;
    content?: unknown;
  };
  [key: string]: unknown;
}

/** One parsed line: the original raw text plus (if parseable) its record. */
interface ParsedLine {
  index: number;
  raw: string;
  record: RawRecord | null;
}

/** A node in the parentUuid → uuid DAG, after orphan/cycle fixups. */
export interface DagNode {
  uuid: string;
  parentUuid: string | null;
  timestamp: string;
  lineIndex: number;
  /** type === "user" with content that is ONLY tool_result block(s). */
  isToolResultCarrier: boolean;
  /** type !== "user" && type !== "assistant" (system, progress, ...). */
  isStructural: boolean;
  /** type === "user" with real (non-tool-result) content — a human prompt. */
  isHumanPrompt: boolean;
}

export interface ActivePathDiagnostics {
  /** Total records with a resolvable uuid. */
  nodeCount: number;
  /** uuid of the record chosen as the active leaf, or null if no nodes. */
  leafUuid: string | null;
  /** uuids whose parentUuid was cleared because it pointed at a cycle. */
  cyclesBroken: string[];
  /** uuids kept because their whole subtree is plumbing (tool-result
   *  carriers / structural entries), not because they're on the leaf's
   *  ancestor chain. */
  plumbingKept: string[];
  /** uuids kept because they belong to a compaction-replay sibling
   *  group (same timestamp as a canonical sibling). */
  replayKept: string[];
  /** uuids whose subtree was dropped as a genuinely abandoned branch. */
  droppedRoots: string[];
}

// ── Helpers ────────────────────────────────────────────────────────

function isRecordWithUuid(record: RawRecord | null): record is RawRecord & { uuid: string } {
  return !!record && typeof record.uuid === "string" && record.uuid.length > 0;
}

function hasOnlyToolResultContent(content: unknown): boolean {
  if (!Array.isArray(content) || content.length === 0) return false;
  return content.every(
    (block): block is ToolResultBlock =>
      !!block && typeof block === "object" && (block as ToolResultBlock).type === "tool_result",
  );
}

function classify(record: RawRecord): {
  isToolResultCarrier: boolean;
  isStructural: boolean;
  isHumanPrompt: boolean;
} {
  const type = record.type;
  const isUser = type === "user";
  const isAssistant = type === "assistant";
  const isToolResultCarrier = isUser && hasOnlyToolResultContent(record.message?.content);
  const isStructural = !isUser && !isAssistant;
  const isHumanPrompt = isUser && !isToolResultCarrier;
  return { isToolResultCarrier, isStructural, isHumanPrompt };
}

/**
 * A divergent (off-canonical) subtree is a genuinely ABANDONED rewind
 * branch only when a human re-prompted — i.e. the subtree contains a real
 * user prompt. Anything else hanging off the canonical chain is
 * machine-generated work: tool-result plumbing, structural records, or —
 * critically — PARALLEL Task/subagent dispatches, which Claude Code
 * encodes as sibling parent→child chains (only one sibling can carry the
 * chain onward; the others dead-end structurally while being completed,
 * live work). An earlier rule ("keep only pure-plumbing subtrees")
 * dropped those parallel dispatches — verified against real transcripts
 * where every inspected dropped assistant record was a parallel Task
 * dispatch, not a rewind. Trade-off: an assistant reply abandoned by a
 * rewind-retry (no new user prompt in the dropped branch) is now KEPT as
 * a near-duplicate — acceptable; never-lose-content wins, and the
 * downstream pipeline dedups streamed responses by requestId.
 */
function isAbandonedBranch(
  root: string,
  nodes: Map<string, DagNode>,
  children: Map<string, string[]>,
): boolean {
  const stack = [root];
  const seen = new Set<string>();
  while (stack.length > 0) {
    const uuid = stack.pop()!;
    if (seen.has(uuid)) continue;
    seen.add(uuid);
    const node = nodes.get(uuid);
    if (!node) continue;
    if (node.isHumanPrompt) return true;
    for (const child of children.get(uuid) ?? []) stack.push(child);
  }
  return false;
}

// ── Step 1: parse + index ─────────────────────────────────────────

function parseLines(lines: string[]): ParsedLine[] {
  return lines.map((raw, index) => {
    const trimmed = raw.trim();
    if (!trimmed) return { index, raw, record: null };
    try {
      return { index, raw, record: JSON.parse(trimmed) as RawRecord };
    } catch {
      // Malformed line: pass through untouched (rule #5 tolerance,
      // extended defensively to parse failures — we can't classify it,
      // so dropping it would risk losing real content for free).
      return { index, raw, record: null };
    }
  });
}

// ── Step 2: build DAG nodes, clear dangling parents, break cycles ──

function buildNodes(parsed: ParsedLine[]): Map<string, DagNode> {
  const nodes = new Map<string, DagNode>();
  for (const p of parsed) {
    if (!isRecordWithUuid(p.record)) continue;
    const record = p.record;
    const { isToolResultCarrier, isStructural, isHumanPrompt } = classify(record);
    nodes.set(record.uuid, {
      uuid: record.uuid,
      parentUuid: record.parentUuid ?? null,
      timestamp: record.timestamp ?? "",
      lineIndex: p.index,
      isToolResultCarrier,
      isStructural,
      isHumanPrompt,
    });
  }

  // Clear dangling parentUuids (pointing outside the loaded node set) —
  // ported from dag.py build_dag Step 1. Such nodes become roots.
  for (const node of nodes.values()) {
    if (node.parentUuid !== null && !nodes.has(node.parentUuid)) {
      node.parentUuid = null;
    }
  }

  return nodes;
}

/**
 * Break parentUuid cycles before anything walks the chain, so a
 * rewind/replay cycle can never hang a backward walk. Ported from
 * dag.py build_dag Step 2: each node's chain is walked once; a node
 * revisited within the SAME walk is a cycle — its parentUuid is
 * cleared, promoting it to root. `acyclic` memoizes nodes already
 * proven to reach a root so the whole pass is amortized O(n) rather
 * than O(n·depth).
 */
function breakCycles(nodes: Map<string, DagNode>): string[] {
  const acyclic = new Set<string>();
  const broken: string[] = [];

  for (const start of nodes.keys()) {
    const visited = new Set<string>();
    let current: string | undefined = start;
    while (current !== undefined && !acyclic.has(current)) {
      if (visited.has(current)) {
        nodes.get(current)!.parentUuid = null;
        broken.push(current);
        break;
      }
      visited.add(current);
      const node: DagNode | undefined = nodes.get(current);
      if (!node) break;
      current = node.parentUuid ?? undefined;
    }
    for (const uuid of visited) acyclic.add(uuid);
  }

  return broken;
}

function buildChildrenMap(nodes: Map<string, DagNode>): Map<string, string[]> {
  const children = new Map<string, string[]>();
  for (const node of nodes.values()) {
    if (node.parentUuid === null) continue;
    const list = children.get(node.parentUuid);
    if (list) list.push(node.uuid);
    else children.set(node.parentUuid, [node.uuid]);
  }
  return children;
}

// ── Step 3: pick the active leaf ───────────────────────────────────

/**
 * Leaf preference: the LAST uuid-bearing record in file order.
 *
 * Divergence from the task brief (documented in ACTIVE-PATH.md): an
 * earlier hypothesis was that an explicit `leafUuid` marker (the
 * `type: "summary"` record's field) should take priority. Investigation
 * of upstream showed `leafUuid` points at the tail of the segment a
 * compaction just SUMMARIZED (i.e. content being compacted OUT of
 * context) — using it as "the active leaf" would walk backward into
 * stale pre-compaction context instead of the live tail. `last-prompt`
 * carries no uuid at all and can't serve as a leaf pointer either. So
 * this function does not consult either.
 *
 * "Deepest leaf" (this repo's existing `canonicalBranch` in strip.ts)
 * is deliberately NOT used here: an abandoned pre-rewind branch is
 * often deeper than the live one. File order is authoritative because
 * Claude Code appends to the transcript in write order — whatever was
 * written last is definitionally the current tip.
 */
function pickLeafUuid(parsed: ParsedLine[], nodes: Map<string, DagNode>): string | null {
  for (let i = parsed.length - 1; i >= 0; i--) {
    const record = parsed[i].record;
    if (isRecordWithUuid(record) && nodes.has(record.uuid)) {
      return record.uuid;
    }
  }
  return null;
}

/**
 * Walk backward from `leaf` to the root via parentUuid, collecting the
 * ancestor chain. Assumes cycles have already been broken, so this
 * always terminates.
 */
function walkAncestors(leaf: string, nodes: Map<string, DagNode>): Set<string> {
  const canonical = new Set<string>();
  let current: string | undefined = leaf;
  while (current !== undefined && !canonical.has(current)) {
    canonical.add(current);
    const node: DagNode | undefined = nodes.get(current);
    current = node?.parentUuid ?? undefined;
  }
  return canonical;
}

// ── Step 4: expand canonical set with plumbing / replay siblings ──

/**
 * Collect uuid + all descendants reachable via `children`, guarded
 * against cycles (defense in depth — children is derived from an
 * already-acyclic parent map, but a future bug shouldn't be able to
 * hang this walk).
 */
function collectSubtree(root: string, children: Map<string, string[]>, into: Set<string>): void {
  const stack = [root];
  while (stack.length > 0) {
    const uuid = stack.pop()!;
    if (into.has(uuid)) continue;
    into.add(uuid);
    for (const child of children.get(uuid) ?? []) stack.push(child);
  }
}

/**
 * Expand the canonical ancestor set with siblings that must be kept
 * even though they aren't on the leaf's direct ancestor chain:
 *
 *  - Rule #3 (compaction-replay): when 2+ children of a canonical node
 *    share the EXACT same timestamp, they're a replay group, not
 *    competing rewind forks — every member (and its subtree) is kept.
 *    This is a deliberate divergence from upstream's own dag.py, which
 *    collapses replay groups down to only the first child (see
 *    ACTIVE-PATH.md).
 *  - Rules #4 + parallel-dispatch: any other divergent subtree is kept
 *    UNLESS it contains a human prompt (see isAbandonedBranch) — that
 *    covers tool-result plumbing, structural records, AND parallel
 *    Task/subagent dispatch chains, which only structurally dead-end
 *    because a single sibling must carry the chain onward.
 *
 * Only a divergent subtree containing a real human re-prompt is an
 * abandoned rewind branch, and only those are left out of `keep`.
 */
function expandWithPlumbingAndReplays(
  canonical: Set<string>,
  nodes: Map<string, DagNode>,
  children: Map<string, string[]>,
): { keep: Set<string>; plumbingKept: string[]; replayKept: string[] } {
  const keep = new Set(canonical);
  const plumbingKept: string[] = [];
  const replayKept: string[] = [];

  for (const uuid of canonical) {
    const kids = children.get(uuid) ?? [];
    if (kids.length === 0) continue;

    const byTimestamp = new Map<string, string[]>();
    for (const kid of kids) {
      const ts = nodes.get(kid)?.timestamp ?? "";
      const group = byTimestamp.get(ts);
      if (group) group.push(kid);
      else byTimestamp.set(ts, [kid]);
    }

    for (const group of byTimestamp.values()) {
      if (group.length > 1) {
        // Compaction-replay group: keep every member's full subtree.
        for (const member of group) {
          if (!keep.has(member)) replayKept.push(member);
          collectSubtree(member, children, keep);
        }
        continue;
      }
      const [child] = group;
      if (keep.has(child)) continue;
      if (!isAbandonedBranch(child, nodes, children)) {
        plumbingKept.push(child);
        collectSubtree(child, children, keep);
      }
      // else: subtree contains a human re-prompt — a real abandoned
      // rewind fork. Left out of `keep`.
    }
  }

  return { keep, plumbingKept, replayKept };
}

// ── Public API ──────────────────────────────────────────────────────

/**
 * Filter raw Claude Code JSONL transcript lines down to the active
 * conversational path, dropping genuinely abandoned rewind branches
 * while preserving everything else (tool-result plumbing, compaction
 * replays, non-DAG records) in ORIGINAL file order.
 *
 * Pure function: no I/O, no mutation of the input array.
 */
export function filterActivePath(lines: string[]): string[] {
  const { keep, parsed } = computeActivePath(lines);
  const output: string[] = [];
  for (const p of parsed) {
    if (!isRecordWithUuid(p.record)) {
      // No uuid (legacy format / non-DAG record types) or unparseable —
      // always pass through in place (rule #5).
      output.push(p.raw);
      continue;
    }
    if (keep.has(p.record.uuid)) output.push(p.raw);
  }
  return output;
}

/**
 * Same computation as `filterActivePath`, but returns the intermediate
 * state (which lines are kept, plus diagnostics) so tests can assert on
 * *why* a line was kept or dropped, not just the final output.
 */
export function computeActivePath(lines: string[]): {
  parsed: ParsedLine[];
  keep: Set<string>;
  diagnostics: ActivePathDiagnostics;
} {
  const parsed = parseLines(lines);
  const nodes = buildNodes(parsed);

  if (nodes.size === 0) {
    return {
      parsed,
      keep: new Set(),
      diagnostics: {
        nodeCount: 0,
        leafUuid: null,
        cyclesBroken: [],
        plumbingKept: [],
        replayKept: [],
        droppedRoots: [],
      },
    };
  }

  const cyclesBroken = breakCycles(nodes);
  const children = buildChildrenMap(nodes);
  const leafUuid = pickLeafUuid(parsed, nodes);

  if (leafUuid === null) {
    // Every uuid'd record is unreachable as a "last leaf" candidate —
    // shouldn't happen given nodes.size > 0, but stay defensive.
    return {
      parsed,
      keep: new Set(nodes.keys()),
      diagnostics: {
        nodeCount: nodes.size,
        leafUuid: null,
        cyclesBroken,
        plumbingKept: [],
        replayKept: [],
        droppedRoots: [],
      },
    };
  }

  const canonical = walkAncestors(leafUuid, nodes);
  const { keep, plumbingKept, replayKept } = expandWithPlumbingAndReplays(canonical, nodes, children);

  const droppedRoots: string[] = [];
  for (const uuid of nodes.keys()) {
    if (keep.has(uuid)) continue;
    const node = nodes.get(uuid)!;
    if (node.parentUuid === null || keep.has(node.parentUuid)) {
      droppedRoots.push(uuid);
    }
  }

  return {
    parsed,
    keep,
    diagnostics: {
      nodeCount: nodes.size,
      leafUuid,
      cyclesBroken,
      plumbingKept,
      replayKept,
      droppedRoots,
    },
  };
}
