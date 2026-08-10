import { readFileSync } from "fs";

// ── Types ──────────────────────────────────────────────────────────

export interface SessionHeader {
  sessionId: string;
  date: string;
  branch: string;
  cwd: string;
  project: string;
}

export interface StrippedMessage {
  role: "user" | "assistant";
  content: string;
  timestamp: string | null;
  sequence: number;
  messageType: "text" | "tool_use" | "tool_result" | "system" | "subagent_prompt";
  // For tool_use and tool_result messages: the provider-assigned id that
  // links them together. Null on plain text/system messages.
  toolUseId?: string | null;
  // For tool_use only: the tool name (e.g. "Bash") and the full input JSON
  // so the UI can render per-tool views without re-parsing the content prefix.
  toolName?: string | null;
  toolInput?: string | null;
}

export interface FileReference {
  filePath: string;
  fileName: string;
  operation: 'write' | 'edit' | 'read';
  timestamp: string | null;
  sequence: number;
}

export interface ToolCall {
  toolName: string;
  inputSummary: string;
  timestamp: string | null;
  sequence: number;
}

interface ContentBlock {
  type: string;
  text?: string;
  name?: string;
  input?: { file_path?: string; [key: string]: unknown };
  [key: string]: unknown;
}

interface RawMessage {
  type?: string;
  cwd?: string;
  sessionId?: string;
  gitBranch?: string;
  timestamp?: string;
  uuid?: string;
  parentUuid?: string;
  message?: {
    role?: string;
    content?: string | ContentBlock[];
  };
  [key: string]: unknown;
}

/** type === "user" with content that is ONLY tool_result block(s). */
function hasOnlyToolResultContent(content: string | ContentBlock[] | undefined): boolean {
  if (!Array.isArray(content) || content.length === 0) return false;
  return content.every((block) => !!block && typeof block === "object" && block.type === "tool_result");
}

/** type === "user" with real (non-tool-result) content — a human prompt. */
function isHumanPrompt(m: RawMessage): boolean {
  return m.type === "user" && !hasOnlyToolResultContent(m.message?.content);
}

/**
 * A divergent (off-canonical) subtree is a genuinely ABANDONED rewind
 * branch only when a human re-prompted — i.e. the subtree contains a real
 * user prompt. Anything else hanging off the canonical chain is
 * machine-generated work: tool-result plumbing, structural records, or —
 * critically — PARALLEL Task/subagent dispatches, which Claude Code
 * encodes as sibling parent→child chains (only one sibling can carry the
 * chain onward; the others dead-end structurally while being completed,
 * live work). Ported from server/trace/active-path.ts's isAbandonedBranch,
 * which fixed the identical bug in the trace pipeline: the old
 * "keep only the single leaf's ancestor chain" rule silently dropped
 * completed parallel-dispatch content from this search index.
 */
function isAbandonedBranch(root: string, byUuid: Map<string, RawMessage>, childrenOf: Map<string, string[]>): boolean {
  const stack = [root];
  const seen = new Set<string>();
  while (stack.length > 0) {
    const uuid = stack.pop()!;
    if (seen.has(uuid)) continue;
    seen.add(uuid);
    const msg = byUuid.get(uuid);
    if (!msg) continue;
    if (isHumanPrompt(msg)) return true;
    for (const child of childrenOf.get(uuid) ?? []) stack.push(child);
  }
  return false;
}

function collectSubtree(root: string, childrenOf: Map<string, string[]>, into: Set<string>): void {
  const stack = [root];
  while (stack.length > 0) {
    const uuid = stack.pop()!;
    if (into.has(uuid)) continue;
    into.add(uuid);
    for (const child of childrenOf.get(uuid) ?? []) stack.push(child);
  }
}

/**
 * Expand the canonical ancestor set with sibling subtrees that must be
 * kept even though they aren't on the leaf's direct ancestor chain — see
 * isAbandonedBranch. Same-timestamp sibling groups (compaction replays)
 * are kept wholesale, mirroring active-path.ts's rule #3.
 */
function expandWithPlumbingAndReplays(
  canonical: Set<string>,
  byUuid: Map<string, RawMessage>,
  childrenOf: Map<string, string[]>
): Set<string> {
  const keep = new Set(canonical);

  for (const uuid of canonical) {
    const kids = childrenOf.get(uuid) ?? [];
    if (kids.length === 0) continue;

    const byTimestamp = new Map<string, string[]>();
    for (const kid of kids) {
      const ts = byUuid.get(kid)?.timestamp ?? "";
      const group = byTimestamp.get(ts);
      if (group) group.push(kid);
      else byTimestamp.set(ts, [kid]);
    }

    for (const group of byTimestamp.values()) {
      if (group.length > 1) {
        // Compaction-replay group: keep every member's full subtree.
        for (const member of group) collectSubtree(member, childrenOf, keep);
        continue;
      }
      const [child] = group;
      if (keep.has(child)) continue;
      if (!isAbandonedBranch(child, byUuid, childrenOf)) {
        collectSubtree(child, childrenOf, keep);
      }
      // else: subtree contains a human re-prompt — a real abandoned
      // rewind fork. Left out of `keep`.
    }
  }

  return keep;
}

/**
 * Filter msgs to the active branch plus any legitimate parallel-dispatch
 * or replay siblings.
 *
 * Claude Code stores ALL turns including rewound/abandoned branches.
 * Each message has a uuid and parentUuid forming a tree. The active
 * branch is the path from root to the deepest leaf. Anything else hanging
 * off that chain is dropped ONLY if it's a genuinely abandoned rewind
 * fork (contains a real human re-prompt) — plumbing, replays, and
 * parallel Task/subagent dispatch chains are kept (see isAbandonedBranch).
 *
 * If uuid/parentUuid are missing (older sessions), return msgs as-is.
 */
function canonicalBranch(msgs: RawMessage[]): RawMessage[] {
  // Need at least some messages with uuid to reconstruct
  const withIds = msgs.filter((m) => m.uuid);
  if (withIds.length < 2) return msgs;

  const byUuid = new Map<string, RawMessage>();
  const childrenOf = new Map<string, string[]>(); // parentUuid → [child uuids]

  for (const m of withIds) {
    if (m.uuid) byUuid.set(m.uuid, m);
  }
  for (const m of withIds) {
    if (!m.uuid) continue;
    const parent = m.parentUuid ?? "__root__";
    if (!childrenOf.has(parent)) childrenOf.set(parent, []);
    childrenOf.get(parent)!.push(m.uuid);
  }

  // Find the leaf of the active branch: latest timestamp wins, since a
  // rewind can leave an abandoned branch deeper than the live one. Depth
  // breaks ties (and covers legacy sessions with no timestamps). Visited
  // sets guard both walks — rewind/replay can produce parentUuid cycles.
  let bestLeaf: string | null = null;
  let bestTs = "";
  let bestDepth = -1;
  for (const uuid of byUuid.keys()) {
    const children = childrenOf.get(uuid);
    if (!children || children.length === 0) {
      const ts = byUuid.get(uuid)?.timestamp ?? "";
      let trueDepth = 0;
      const seen = new Set<string>();
      let cur: string | undefined = uuid;
      while (cur && !seen.has(cur)) {
        seen.add(cur);
        trueDepth++;
        const msg = byUuid.get(cur);
        cur = msg?.parentUuid && byUuid.has(msg.parentUuid) ? msg.parentUuid : undefined;
      }
      if (ts > bestTs || (ts === bestTs && trueDepth > bestDepth)) {
        bestTs = ts;
        bestDepth = trueDepth;
        bestLeaf = uuid;
      }
    }
  }

  if (!bestLeaf) return msgs;

  // Walk from leaf back to root, collecting canonical UUIDs
  const canonical = new Set<string>();
  let cur: string | undefined = bestLeaf;
  while (cur && !canonical.has(cur)) {
    canonical.add(cur);
    const msg = byUuid.get(cur);
    cur = msg?.parentUuid && byUuid.has(msg.parentUuid) ? msg.parentUuid : undefined;
  }

  // Expand with parallel-dispatch/plumbing/replay siblings — only a
  // genuinely abandoned rewind fork is left out.
  const keep = expandWithPlumbingAndReplays(canonical, byUuid, childrenOf);

  // Return only messages whose uuid is kept, plus any messages without a
  // uuid (preserve legacy format).
  return msgs.filter((m) => !m.uuid || keep.has(m.uuid));
}

// ── Helpers ────────────────────────────────────────────────────────

const SKIP_TYPES = new Set([
  "file-history-snapshot",
  "progress",
  "queue-operation",
  "system",
]);

// Classification below is marker-based, NOT size/header-based. The previous
// heuristic (>2000 chars + >5 headers → skill, >1500 chars + >3 headers →
// system) destroyed genuine user-pasted markdown (plans, design docs) that
// happened to be long and well-structured — real data loss, visible in the
// UI as "[Skill loaded: …]" over content the user actually typed.
//
// Markers below were grounded by inspecting real transcripts under
// ~/.claude/projects/**/*.jsonl (user-type messages, plain text blocks):
//
//  - "Base directory for this skill:" — literal prefix Claude Code emits
//    when auto-loading a SKILL.md body into a user turn (no <command-name>
//    wrapper, since these are description-triggered, not explicit slash
//    commands). Confirmed present verbatim in real sessions for the `cass`
//    skill (27,567 chars), the `claude-api` skill (464K–616K chars), and the
//    `create_handoff` skill (3,953 chars) — e.g.
//    ~/.claude/projects/-Users-blake--claude--claude-worktrees-parallelism-overhaul/158708a4-*.jsonl
//    and ~/.claude/projects/-Users-blake-Documents-Development-clay-keystone/9f4f5030-*.jsonl.
//
//  - "<system-reminder>" — wrapper tag the harness uses for injected
//    reminders of any size. Confirmed present verbatim, short form (~123
//    chars, e.g. `~/.claude/projects/.../a4cc76d7-*.jsonl`: "The user named
//    this session \"osman-sync\"...") and also found wrapping/adjacent to
//    large skill-load bodies in the same samples above.
//
//  - "# claudeMd" / "(user's private global instructions for all
//    projects)" / "(project instructions, checked into the codebase)" —
//    the literal heading and phrasing the harness uses when dumping
//    CLAUDE.md file contents into a system-reminder block. Not found via
//    disk grep across the sampled transcripts (this exact dump format
//    wasn't present in the older sessions searched), but directly observed
//    live in this very task's own injected context, which is the same
//    harness feature — included as defense-in-depth since the phrasing is
//    extremely distinctive and has effectively zero false-positive risk
//    against genuine user prose.
//
// A short length floor is applied ALONGSIDE the marker check (not instead
// of it). Verified against stripXmlNoise below: a short, complete
// "<system-reminder>...</system-reminder>" block (e.g. the 123-char
// session-name reminder above) is already dropped entirely by
// stripXmlNoise's full-block-removal regex when it falls through to the
// plain-text branch — correct existing behavior, since that kind of stub
// carries no real conversational content. Without the floor,
// isSystemContext would instead fire first and hand it to
// truncateSystemContext, which strips the closing tag in the process and
// leaves a bare "[system context truncated]" stub behind as a visible,
// meaningless message — a regression from "silently dropped" to "visible
// noise". The floor keeps that path length-gated to content where
// truncating to one line is actually worth doing (real skill/CLAUDE.md
// dumps, thousands of chars). It never causes a false positive: unmarked
// user content of any length still passes through untouched regardless of
// this floor.
const SKILL_INJECTION_MARKERS = ["Base directory for this skill:"];

const SYSTEM_CONTEXT_MARKERS = [
  "<system-reminder>",
  "# claudeMd",
  "(user's private global instructions for all projects)",
  "(project instructions, checked into the codebase)",
];

const TRUNCATION_WORTH_IT_FLOOR = 500;

// Markers must appear near the START of the message. Harness injections
// (skill loads, system-reminders, CLAUDE.md dumps) always lead with their
// marker; genuine user prose that merely QUOTES one of these strings
// mid-message (e.g. discussing Claude Code internals) must not be
// destroyed by truncation. Anywhere-in-message matching was a real
// data-loss path for exactly that kind of message.
const MARKER_HEAD_WINDOW = 500;

function hasLeadingMarker(text: string, markers: string[]): boolean {
  const head = text.slice(0, MARKER_HEAD_WINDOW);
  return markers.some((marker) => head.includes(marker));
}

function isSkillInjection(text: string): boolean {
  return (
    text.length > TRUNCATION_WORTH_IT_FLOOR &&
    hasLeadingMarker(text, SKILL_INJECTION_MARKERS)
  );
}

function isSystemContext(text: string): boolean {
  return (
    text.length > TRUNCATION_WORTH_IT_FLOOR &&
    hasLeadingMarker(text, SYSTEM_CONTEXT_MARKERS)
  );
}

function truncateSkill(text: string): string {
  for (const line of text.split("\n")) {
    const cleaned = line.trim().replace(/^#+\s*/, "");
    if (cleaned) return `[Skill loaded: ${cleaned}]`;
  }
  return "[Skill loaded: unknown]";
}

function truncateSystemContext(text: string): string {
  for (const line of text.split("\n")) {
    const cleaned = line.trim().replace(/^#+\s*/, "");
    if (cleaned) return `${cleaned} [system context truncated]`;
  }
  return "[system context truncated]";
}

/** Strip XML tags that leak into user/assistant text (task-notification, system-reminder, etc.) */
function stripXmlNoise(text: string): string {
  // Remove entire <task-notification>...</task-notification> blocks
  let cleaned = text.replace(/<task-notification>[\s\S]*?<\/task-notification>/g, "");
  // Remove entire <system-reminder>...</system-reminder> blocks
  cleaned = cleaned.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "");
  // Remove <output-file>...</output-file>, <tool-use-id>...</tool-use-id>, etc.
  cleaned = cleaned.replace(/<(?:output-file|tool-use-id|task-id|status|summary|result|available-deferred-tools)>[\s\S]*?<\/(?:output-file|tool-use-id|task-id|status|summary|result|available-deferred-tools)>/g, "");
  // Remove any remaining orphan XML-looking tags that are clearly not markdown
  cleaned = cleaned.replace(/<\/?(?:task-notification|system-reminder|output-file|tool-use-id|task-id|status|summary|result|available-deferred-tools)[^>]*>/g, "");
  return cleaned.trim();
}

function compactCommand(text: string): string | null {
  const cmdMatch = text.match(/<command-name>(.*?)<\/command-name>/);
  if (!cmdMatch) return null;

  const cmd = cmdMatch[1].trim().replace(/^\//, "");
  const argsMatch = text.match(/<command-args>([\s\S]*?)<\/command-args>/);
  const args = argsMatch ? argsMatch[1].trim().slice(0, 100) : "";
  return `/${cmd} ${args}`.trim();
}

function extractTextBlocks(content: string | ContentBlock[]): string[] {
  if (typeof content === "string") {
    return content.trim() ? [content] : [];
  }
  if (Array.isArray(content)) {
    return content
      .filter((b) => b.type === "text" && b.text?.trim())
      .map((b) => b.text!);
  }
  return [];
}

function hasOnlyToolResults(content: string | ContentBlock[]): boolean {
  if (!Array.isArray(content)) return false;
  const types = new Set(content.map((b) => b.type));
  return types.has("tool_result") && types.size === 1;
}

// ── Main ───────────────────────────────────────────────────────────

const FILE_TOOL_NAMES = new Set(["Write", "Edit", "Read", "write", "edit", "read"]);

function summarizeToolInput(toolName: string, input: Record<string, unknown>): string {
  switch (toolName) {
    case "Bash":
      return String(input.command || "").slice(0, 500);
    case "Read":
    case "Edit":
    case "Write":
    case "read":
    case "edit":
    case "write":
      return String(input.file_path || "");
    case "Grep":
    case "Glob":
    case "grep":
    case "glob":
      return String(input.pattern || "");
    case "Agent":
    case "agent":
      return String(input.description || input.prompt || "").slice(0, 200);
    case "ToolSearch":
      return String(input.query || "");
    default:
      try {
        return JSON.stringify(input).slice(0, 300);
      } catch {
        return "";
      }
  }
}

function extractFileName(filePath: string): string {
  const parts = filePath.split("/");
  return parts[parts.length - 1] || filePath;
}

export function stripSession(jsonlPath: string): {
  header: SessionHeader;
  messages: StrippedMessage[];
  files: FileReference[];
  toolCalls: ToolCall[];
} {
  const raw = readFileSync(jsonlPath, "utf-8");
  const lines = raw.split("\n");

  const msgs: RawMessage[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      msgs.push(JSON.parse(trimmed));
    } catch {
      // skip malformed lines
    }
  }

  // Extract header from first user message
  const header: SessionHeader = {
    sessionId: "",
    date: "",
    branch: "",
    cwd: "",
    project: "",
  };

  for (const m of msgs) {
    if (m.type === "user") {
      header.sessionId = m.sessionId || "unknown";
      header.date = (m.timestamp || "").slice(0, 10);
      header.branch = m.gitBranch || "";
      header.cwd = m.cwd || "";
      if (header.cwd) {
        const parts = header.cwd.split("/");
        header.project = parts[parts.length - 1] || "";
      }
      break;
    }
  }

  // Filter to canonical branch — drop rewound/abandoned turns.
  // Must run before sorting so the tree walk uses file order for tie-breaking.
  // Copy: canonicalBranch may return `msgs` itself (legacy sessions without
  // uuids), and the reassignment below would empty both aliased arrays.
  const canonical = [...canonicalBranch(msgs)];
  // Sort canonical branch by timestamp for correct sequence assignment.
  canonical.sort((a, b) => {
    if (!a.timestamp) return 1;
    if (!b.timestamp) return -1;
    return a.timestamp.localeCompare(b.timestamp);
  });
  // Reassign msgs to the filtered, sorted slice.
  msgs.length = 0;
  msgs.push(...canonical);

  // ── Extract file references and tool calls from tool_use blocks ──
  const fileMap = new Map<string, FileReference>(); // key: "filePath|operation"
  let fileSeq = 0;
  const toolCalls: ToolCall[] = [];
  let toolSeq = 0;

  for (const m of msgs) {
    if (m.type === "assistant" && Array.isArray(m.message?.content)) {
      for (const block of m.message!.content as ContentBlock[]) {
        if (block.type === "tool_use" && block.name) {
          // Extract tool call
          const input = (block.input || {}) as Record<string, unknown>;
          toolCalls.push({
            toolName: block.name,
            inputSummary: summarizeToolInput(block.name, input),
            timestamp: m.timestamp || null,
            sequence: toolSeq++,
          });

          // Extract file reference (existing logic)
          if (FILE_TOOL_NAMES.has(block.name)) {
            const filePath = block.input?.file_path;
            if (!filePath || typeof filePath !== "string") continue;
            const operation = block.name.toLowerCase() as "write" | "edit" | "read";
            const key = `${filePath}|${operation}`;
            if (!fileMap.has(key)) {
              fileMap.set(key, {
                filePath,
                fileName: extractFileName(filePath),
                operation,
                timestamp: m.timestamp || null,
                sequence: fileSeq++,
              });
            }
          }
        }
      }
    }
  }

  const files = Array.from(fileMap.values());

  // ── Extract stripped messages ──
  const messages: StrippedMessage[] = [];
  let sequence = 0;

  for (const m of msgs) {
    const mtype = m.type;
    if (!mtype || SKIP_TYPES.has(mtype)) continue;

    const content = m.message?.content;
    if (content === undefined || content === null) continue;

    if (mtype === "user") {
      // Extract tool_result blocks from user messages (array content)
      if (Array.isArray(content)) {
        for (const block of content as ContentBlock[]) {
          if (block.type === "tool_result" && (block as any).content) {
            let resultText = "";
            const blockContent = (block as any).content;
            if (typeof blockContent === "string") {
              resultText = blockContent;
            } else if (Array.isArray(blockContent)) {
              resultText = blockContent
                .filter((b: any) => b.type === "text" && b.text)
                .map((b: any) => b.text)
                .join("\n");
            }
            // Strip line-number prefixes and excessive whitespace, truncate
            resultText = resultText.replace(/^\s*\d+[→│|]\s*/gm, "").replace(/\s+/g, " ").trim().slice(0, 500);
            if (resultText) {
              messages.push({
                role: "user",
                content: resultText,
                timestamp: m.timestamp || null,
                sequence: sequence++,
                messageType: "tool_result",
                toolUseId: (block as any).tool_use_id ?? null,
              });
            }
          }
        }
        // If this message ONLY has tool_results, skip text extraction
        if (hasOnlyToolResults(content)) continue;
      }

      const texts = extractTextBlocks(content);
      for (const text of texts) {
        let processed: string;

        let msgType: StrippedMessage["messageType"] = "text";
        const compacted = compactCommand(text);
        if (compacted) {
          processed = compacted;
        } else if (isSkillInjection(text)) {
          processed = truncateSkill(text);
          msgType = "system";
        } else if (isSystemContext(text)) {
          processed = truncateSystemContext(text);
          msgType = "system";
        } else {
          processed = text.trim();
        }

        processed = stripXmlNoise(processed);
        if (processed) {
          messages.push({
            role: "user",
            content: processed,
            timestamp: m.timestamp || null,
            sequence: sequence++,
            messageType: msgType,
          });
        }
      }
    } else if (mtype === "assistant") {
      const texts = extractTextBlocks(content);
      for (const text of texts) {
        const trimmed = stripXmlNoise(text.trim());
        if (trimmed.length > 100) {
          messages.push({
            role: "assistant",
            content: trimmed,
            timestamp: m.timestamp || null,
            sequence: sequence++,
            messageType: "text",
          });
        }
      }

      // Emit tool_use messages for this assistant turn
      if (Array.isArray(content)) {
        for (const block of content as ContentBlock[]) {
          if (block.type === "tool_use" && block.name) {
            const input = (block.input || {}) as Record<string, unknown>;
            let toolInputJson: string | null = null;
            try {
              toolInputJson = JSON.stringify(input);
            } catch {
              // Circular / non-serializable — drop input, keep summary.
            }
            messages.push({
              role: "assistant",
              content: `${block.name}: ${summarizeToolInput(block.name, input)}`,
              timestamp: m.timestamp || null,
              sequence: sequence++,
              messageType: "tool_use",
              toolUseId: (block as { id?: string }).id ?? null,
              toolName: block.name,
              toolInput: toolInputJson,
            });
          }
        }
      }
    }
  }

  return { header, messages, files, toolCalls };
}
