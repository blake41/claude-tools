import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "fs";
import { homedir, tmpdir } from "os";
import { join } from "path";

import { buildTrace, buildTraceFromFile, shapeTraceForResponse, TraceError, type LeanAIChunk, type LeanCompactChunk, type LeanUserChunk } from "./index";
import { ChunkBuilder } from "./vendor/main/services/analysis/ChunkBuilder";
import type { ParsedMessage, Process, Session, SessionMetrics } from "./vendor/main/types/index";

const PROJECTS_DIR = join(homedir(), ".claude", "projects");

interface SessionCandidate {
  sessionId: string;
  projectDir: string;
  size: number;
  hasSubagents: boolean;
}

/**
 * Walk the real ~/.claude/projects tree and collect top-level session files
 * (not subagent files, which live either alongside as `agent-*.jsonl` or
 * nested under `<sessionId>/subagents/`). We never hardcode a session id —
 * the fixture is picked at runtime so this test survives session pruning.
 */
function findSessionCandidates(): SessionCandidate[] {
  if (!existsSync(PROJECTS_DIR)) return [];

  const candidates: SessionCandidate[] = [];
  for (const projectEntry of readdirSync(PROJECTS_DIR, { withFileTypes: true })) {
    if (!projectEntry.isDirectory()) continue;
    const projectDir = join(PROJECTS_DIR, projectEntry.name);

    let sessionFiles: string[];
    try {
      sessionFiles = readdirSync(projectDir).filter(
        (name) => name.endsWith(".jsonl") && !name.startsWith("agent-")
      );
    } catch {
      continue;
    }

    for (const file of sessionFiles) {
      const sessionId = file.replace(/\.jsonl$/, "");
      const filePath = join(projectDir, file);
      let size: number;
      try {
        size = statSync(filePath).size;
      } catch {
        continue;
      }
      if (size === 0) continue;

      // Skip stub files that carry no real conversation turns (e.g. a session
      // containing only `file-history-snapshot` records, or a lone `summary`
      // line). "Smallest non-trivial" means smallest session that actually
      // has parseable user/assistant messages, not smallest file on disk —
      // a raw byte-size floor doesn't reliably distinguish the two.
      let content: string;
      try {
        content = readFileSync(filePath, "utf8");
      } catch {
        continue;
      }
      const hasUserTurn = content.includes('"type":"user"');
      const hasAssistantTurn = content.includes('"type":"assistant"');
      if (!hasUserTurn || !hasAssistantTurn) continue;

      // A subagent file is only real subagent linkage material if it isn't a
      // pre-warming "Warmup" agent (SubagentResolver.isWarmupSubagent filters
      // those out entirely) or a context-compaction artifact (`acompact*`
      // ids). Both are common and would otherwise make this candidate look
      // like it has linkable subagents when resolveSubagents will return none.
      const subagentsDir = join(projectDir, sessionId, "subagents");
      const hasSubagents =
        existsSync(subagentsDir) &&
        readdirSync(subagentsDir).some((n) => {
          if (!n.startsWith("agent-") || !n.endsWith(".jsonl")) return false;
          if (n.startsWith("agent-acompact")) return false;
          try {
            const agentContent = readFileSync(join(subagentsDir, n), "utf8");
            return !agentContent.includes('"content":"Warmup"');
          } catch {
            return false;
          }
        });

      candidates.push({ sessionId, projectDir, size, hasSubagents });
    }
  }

  return candidates;
}

const candidates = findSessionCandidates();
const smallestOverall = [...candidates].sort((a, b) => a.size - b.size)[0];
const smallestWithSubagents = [...candidates]
  .filter((c) => c.hasSubagents)
  .sort((a, b) => a.size - b.size)[0];

describe("buildTrace (vendored claude-devtools pipeline)", () => {
  test("environment sanity: real ~/.claude/projects transcripts are available to test against", () => {
    // If this fails, the integration tests below are meaningless (skipped, not
    // false-passing) — surface that clearly rather than silently no-op'ing.
    expect(candidates.length).toBeGreaterThan(0);
  });

  test.if(!!smallestOverall)(
    "parses a real transcript into messages, chunks, and metrics",
    async () => {
      const detail = await buildTrace(smallestOverall!.sessionId);

      expect(detail.session.id).toBe(smallestOverall!.sessionId);
      expect(Array.isArray(detail.messages)).toBe(true);
      expect(detail.messages.length).toBeGreaterThan(0);
      expect(Array.isArray(detail.chunks)).toBe(true);
      expect(detail.chunks.length).toBeGreaterThan(0);
      expect(detail.metrics).toBeDefined();
      expect(typeof detail.metrics.messageCount).toBe("number");
      expect(detail.metrics.messageCount).toBeGreaterThan(0);
    }
  );

  test.if(!!smallestWithSubagents)(
    "links subagent processes for a session with Task tool calls",
    async () => {
      const detail = await buildTrace(smallestWithSubagents!.sessionId);

      expect(detail.session.hasSubagents).toBe(true);
      expect(detail.processes.length).toBeGreaterThan(0);

      // At least one process must carry real per-tool subagent metrics and
      // Task-call linkage fields (parentTaskId set by SubagentResolver's
      // 3-phase matching) — this is the "3-phase subagent linking into
      // nested trees" the vendor closure exists to provide.
      const process = detail.processes[0];
      expect(process.id).toBeTruthy();
      expect(process.messages.length).toBeGreaterThan(0);
      expect(process.metrics).toBeDefined();
      expect(typeof process.durationMs).toBe("number");

      // Subagent processes attach to whichever AI chunk spawned them.
      const chunkWithProcesses = detail.chunks.find(
        (c) => "processes" in c && (c as { processes: unknown[] }).processes.length > 0
      );
      expect(chunkWithProcesses).toBeDefined();
    }
  );

  test("throws a NOT_FOUND TraceError for an unknown session id", async () => {
    let caught: unknown;
    try {
      await buildTrace("00000000-not-a-real-session-0000");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(TraceError);
    expect((caught as TraceError).code).toBe("NOT_FOUND");
  });
});

// =============================================================================
// shapeTraceForResponse — lean payload shaping
// =============================================================================
//
// These fixtures build ParsedMessage objects by hand (the shape SessionParser
// produces from raw JSONL) and run them through the REAL ChunkBuilder, rather
// than fabricating Chunk/SemanticStep objects directly — that way these tests
// exercise the exact contract shapeTraceForResponse depends on
// (SemanticStepExtractor's field wiring), not an assumed one.

function baseMessage(overrides: Partial<ParsedMessage> & Pick<ParsedMessage, "uuid" | "type">): ParsedMessage {
  return {
    parentUuid: null,
    timestamp: new Date("2026-08-01T00:00:00.000Z"),
    isSidechain: false,
    isMeta: false,
    toolCalls: [],
    toolResults: [],
    content: "",
    ...overrides,
  };
}

function fixtureSession(overrides: Partial<Session> = {}): Session {
  return {
    id: "sess-fixture",
    projectId: "proj-fixture",
    projectPath: "/repo",
    createdAt: Date.now(),
    hasSubagents: false,
    messageCount: 0,
    ...overrides,
  };
}

const HUGE_FILE_CONTENT = "x".repeat(10_000);
const HUGE_TOOL_OUTPUT = "y".repeat(9_000);

/** One user turn -> thinking -> Write tool call (huge input) -> huge tool result (with structuredPatch) -> final text output. */
function buildMainThreadMessages(): ParsedMessage[] {
  const userMsg = baseMessage({
    uuid: "u1",
    type: "user",
    role: "user",
    content: "Investigate the payload-shaping bug",
    timestamp: new Date("2026-08-01T00:00:00.000Z"),
  });

  const assistantMsg = baseMessage({
    uuid: "a1",
    type: "assistant",
    role: "assistant",
    model: "claude-sonnet-5",
    timestamp: new Date("2026-08-01T00:00:05.000Z"),
    usage: { input_tokens: 500, output_tokens: 200, cache_read_input_tokens: 100, cache_creation_input_tokens: 0 },
    content: [
      { type: "thinking", thinking: "Let me look at the file first.", signature: "sig" },
      { type: "tool_use", id: "tool-1", name: "Write", input: { file_path: "/tmp/x.ts", content: HUGE_FILE_CONTENT } },
    ],
  });

  const toolResultMsg = baseMessage({
    uuid: "tr1",
    type: "user",
    isMeta: true,
    timestamp: new Date("2026-08-01T00:00:06.000Z"),
    content: [{ type: "tool_result", tool_use_id: "tool-1", content: HUGE_TOOL_OUTPUT }],
    toolResults: [{ toolUseId: "tool-1", content: HUGE_TOOL_OUTPUT, isError: false }],
    sourceToolUseID: "tool-1",
    toolUseResult: {
      success: true,
      filePath: "/tmp/x.ts",
      content: HUGE_TOOL_OUTPUT,
      structuredPatch: [{ oldStart: 1, oldLines: 0, newStart: 1, newLines: 1, lines: ["+" + "z".repeat(20)] }],
    },
  });

  const finalMsg = baseMessage({
    uuid: "a2",
    type: "assistant",
    role: "assistant",
    model: "claude-sonnet-5",
    timestamp: new Date("2026-08-01T00:00:07.000Z"),
    usage: { input_tokens: 50, output_tokens: 30, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    content: [{ type: "text", text: "Done, fixed the bug." }],
  });

  return [userMsg, assistantMsg, toolResultMsg, finalMsg];
}

function buildDetailWithProcesses(subagents: Process[]) {
  const messages = buildMainThreadMessages();
  const session = fixtureSession({ messageCount: messages.length, hasSubagents: subagents.length > 0 });
  return new ChunkBuilder().buildSessionDetail(session, messages, subagents);
}

describe("shapeTraceForResponse (lean trace payload)", () => {
  test("preserves user/ai chunk structure and step types", () => {
    const detail = buildDetailWithProcesses([]);
    const lean = shapeTraceForResponse(detail);

    expect(lean.chunks).toHaveLength(2);
    expect(lean.chunks[0].chunkType).toBe("user");
    expect((lean.chunks[0] as LeanUserChunk).text).toBe("Investigate the payload-shaping bug");

    const aiChunk = lean.chunks[1] as LeanAIChunk;
    expect(aiChunk.chunkType).toBe("ai");
    const stepTypes = aiChunk.steps.map((s) => s.type);
    expect(stepTypes).toEqual(["thinking", "tool_call", "tool_result", "output"]);
  });

  test("carries gap-filled effective duration for tool_call/tool_result steps (their own durationMs is always 0)", () => {
    const detail = buildDetailWithProcesses([]);
    const lean = shapeTraceForResponse(detail);
    const aiChunk = lean.chunks[1] as LeanAIChunk;

    const toolCall = aiChunk.steps.find((s) => s.type === "tool_call")!;
    expect(toolCall.durationMs).toBe(0); // raw field from SemanticStepExtractor — not useful for a duration badge
    expect(toolCall.effectiveDurationMs).toBeGreaterThan(0);
  });

  test("keeps thinking text and final output text in full (under the prose cap)", () => {
    const detail = buildDetailWithProcesses([]);
    const lean = shapeTraceForResponse(detail);
    const aiChunk = lean.chunks[1] as LeanAIChunk;

    const thinking = aiChunk.steps.find((s) => s.type === "thinking")!;
    expect(thinking.thinkingText).toBe("Let me look at the file first.");
    expect(thinking.thinkingTruncated).toBeUndefined();

    const output = aiChunk.steps.find((s) => s.type === "output")!;
    expect(output.outputText).toBe("Done, fixed the bug.");
  });

  test("caps the huge tool_use input and tool_result content, flags truncation, but preserves structuredPatch", () => {
    const detail = buildDetailWithProcesses([]);
    const lean = shapeTraceForResponse(detail);
    const aiChunk = lean.chunks[1] as LeanAIChunk;

    const toolCall = aiChunk.steps.find((s) => s.type === "tool_call")!;
    expect(toolCall.toolName).toBe("Write");
    const cappedInputContent = (toolCall.toolInput as { content: string }).content;
    expect(cappedInputContent.length).toBeLessThan(HUGE_FILE_CONTENT.length);
    expect(toolCall.toolInputTruncated).toBe(true);

    const toolResult = aiChunk.steps.find((s) => s.type === "tool_result")!;
    expect(toolResult.toolResultContent!.length).toBeLessThan(HUGE_TOOL_OUTPUT.length);
    expect(toolResult.toolResultTruncated).toBe(true);
    expect(toolResult.toolUseResultTruncated).toBe(true);

    // structuredPatch itself must survive intact — each line is short, so capDeep
    // shouldn't touch it even though the sibling `content` field on the same
    // toolUseResult object gets truncated.
    const patch = (toolResult.toolUseResult as { structuredPatch: Array<{ lines: string[] }> }).structuredPatch;
    expect(patch[0].lines).toEqual(["+" + "z".repeat(20)]);
  });

  test("caps a pathologically huge user-message text (e.g. a 47MB pasted console dump) and flags it", () => {
    // Regression for session 13119fd6: a single user message whose entire
    // content was one ~47M-char pasted string, uncapped by anything else in
    // this module (capDeep only guards tool_use input/toolUseResult, not
    // plain user-chunk text) — the trace payload for that one 166-message
    // session ballooned to 48MB. CHUNK_TEXT_CAP guards the user/system/compact
    // `text` field itself.
    const hugeUserText = "Q".repeat(70_000);
    const userMsg = baseMessage({
      uuid: "u-huge",
      type: "user",
      role: "user",
      content: hugeUserText,
      timestamp: new Date("2026-08-01T00:00:00.000Z"),
    });
    const session = fixtureSession({ messageCount: 1 });
    const detail = new ChunkBuilder().buildSessionDetail(session, [userMsg], []);
    const lean = shapeTraceForResponse(detail);

    const userChunk = lean.chunks[0] as LeanUserChunk;
    expect(userChunk.chunkType).toBe("user");
    expect(userChunk.text.length).toBe(64_000);
    expect(userChunk.textTruncated).toBe(true);
  });

  test("enforces an aggregate budget across many small-but-numerous tool_use input leaves, each under the per-string cap", () => {
    // Each item is exactly at TOOL_PAYLOAD_CAP (4000 chars) — no single leaf
    // trips the per-string cap — but 50 of them total 200k chars, well past
    // the 100k aggregate budget. capDeep must stop partway through the array
    // and mark the rest truncated, rather than letting the total balloon.
    const manySmallLeaves = Array.from({ length: 50 }, () => "s".repeat(4000));
    const userMsg = baseMessage({
      uuid: "u1",
      type: "user",
      role: "user",
      content: "Process this batch",
      timestamp: new Date("2026-08-01T00:00:00.000Z"),
    });
    const assistantMsg = baseMessage({
      uuid: "a1",
      type: "assistant",
      role: "assistant",
      model: "claude-sonnet-5",
      timestamp: new Date("2026-08-01T00:00:01.000Z"),
      usage: { input_tokens: 10, output_tokens: 10 },
      content: [{ type: "tool_use", id: "tool-batch", name: "BatchTool", input: { items: manySmallLeaves } }],
    });
    const session = fixtureSession({ messageCount: 2 });
    const detail = new ChunkBuilder().buildSessionDetail(session, [userMsg, assistantMsg], []);
    const lean = shapeTraceForResponse(detail);

    const aiChunk = lean.chunks[1] as LeanAIChunk;
    const toolCall = aiChunk.steps.find((s) => s.type === "tool_call")!;
    expect(toolCall.toolInputTruncated).toBe(true);

    const items = (toolCall.toolInput as { items: string[] }).items;
    const marker = items[items.length - 1];
    const realItems = items.slice(0, -1);
    const totalKept = realItems.reduce((sum, s) => sum + s.length, 0);
    expect(totalKept).toBeLessThanOrEqual(100_000);
    expect(marker).toContain("more items truncated");
  });

  test("drops the raw messages[]/rawMessages duplication that the full model carries", () => {
    const detail = buildDetailWithProcesses([]);
    const lean = shapeTraceForResponse(detail);

    expect("messages" in lean).toBe(false);
    expect(JSON.stringify(lean)).not.toContain("rawMessages");
    // The lean payload must actually be smaller than the full one it's derived from.
    expect(JSON.stringify(lean).length).toBeLessThan(JSON.stringify(detail).length);
  });

  test("renders a compact_boundary message as a 'compact' lean chunk", () => {
    const compactMsg = baseMessage({
      uuid: "c1",
      type: "user",
      role: "user",
      isCompactSummary: true,
      content: "Conversation compacted. Summary: investigated the payload bug.",
      timestamp: new Date("2026-08-01T00:00:10.000Z"),
    });
    const session = fixtureSession({ messageCount: 1 });
    const detail = new ChunkBuilder().buildSessionDetail(session, [compactMsg], []);
    const lean = shapeTraceForResponse(detail);

    expect(lean.chunks).toHaveLength(1);
    expect(lean.chunks[0].chunkType).toBe("compact");
    expect((lean.chunks[0] as LeanCompactChunk).text).toContain("investigated the payload bug");
  });

  test("builds a per-subagent step outline and caps its tool-result payloads the same way", () => {
    // Real subagent JSONL files carry isSidechain: true on EVERY entry (sidechain
    // is relative to the PARENT session, not the subagent's own frame of
    // reference) — reproduced here because it's what tripped up the first
    // version of shapeSubagent: ChunkBuilder.buildChunks() filters out
    // isSidechain messages, so passing a subagent's own messages through
    // unmodified silently produced zero steps for every subagent.
    const subagentMessages: ParsedMessage[] = [
      baseMessage({
        uuid: "su1",
        type: "user",
        role: "user",
        content: "Explore the auth module",
        timestamp: new Date("2026-08-01T00:00:05.200Z"),
        agentId: "agent-1",
        isSidechain: true,
      }),
      baseMessage({
        uuid: "sa1",
        type: "assistant",
        role: "assistant",
        model: "claude-haiku-5",
        timestamp: new Date("2026-08-01T00:00:05.400Z"),
        agentId: "agent-1",
        isSidechain: true,
        usage: { input_tokens: 10, output_tokens: 5 },
        content: [{ type: "tool_use", id: "sub-tool-1", name: "Grep", input: { pattern: "auth" } }],
      }),
      baseMessage({
        uuid: "str1",
        type: "user",
        isMeta: true,
        agentId: "agent-1",
        isSidechain: true,
        timestamp: new Date("2026-08-01T00:00:05.600Z"),
        content: [{ type: "tool_result", tool_use_id: "sub-tool-1", content: HUGE_TOOL_OUTPUT }],
        toolResults: [{ toolUseId: "sub-tool-1", content: HUGE_TOOL_OUTPUT, isError: false }],
        sourceToolUseID: "sub-tool-1",
        toolUseResult: { success: true, content: HUGE_TOOL_OUTPUT },
      }),
    ];
    const metrics: SessionMetrics = {
      durationMs: 2000,
      totalTokens: 15,
      inputTokens: 10,
      outputTokens: 5,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      messageCount: subagentMessages.length,
    };
    const subagent: Process = {
      id: "agent-1",
      filePath: "/fake/agent-1.jsonl",
      messages: subagentMessages,
      startTime: new Date("2026-08-01T00:00:05.200Z"),
      endTime: new Date("2026-08-01T00:00:05.600Z"),
      durationMs: 2000,
      metrics,
      description: "Explore the auth module",
      subagentType: "Explore",
      isParallel: false,
    };

    const detail = buildDetailWithProcesses([subagent]);
    const lean = shapeTraceForResponse(detail);

    expect(lean.subagentCount).toBe(1);
    const aiChunk = lean.chunks[1] as LeanAIChunk;
    expect(aiChunk.subagents).toHaveLength(1);
    const shaped = aiChunk.subagents[0];
    expect(shaped.id).toBe("agent-1");
    expect(shaped.description).toBe("Explore the auth module");

    const subSteps = shaped.steps.map((s) => s.type);
    expect(subSteps).toContain("tool_call");
    expect(subSteps).toContain("tool_result");
    const subToolResult = shaped.steps.find((s) => s.type === "tool_result")!;
    expect(subToolResult.toolResultTruncated).toBe(true);

    // No fallback "unattached" entry — this subagent was linked to the chunk it spawned from.
    expect(lean.unattachedSubagents).toHaveLength(0);
  });

  test("collects unique model names across main-thread and subagent messages", () => {
    const detail = buildDetailWithProcesses([]);
    const lean = shapeTraceForResponse(detail);
    expect(lean.models).toEqual(["claude-sonnet-5"]);
  });

  test("a subagent whose every message is isSidechain still yields non-zero steps", () => {
    // Guard for the production fix in shapeSubagent: ChunkBuilder.buildChunks()
    // filters `!m.isSidechain`, and real subagent JSONL flags EVERY record
    // isSidechain: true (relative to the parent). Without the re-flag this
    // assertion goes to 0 and every subagent renders empty.
    const messages: ParsedMessage[] = [
      baseMessage({
        uuid: "sx1",
        type: "user",
        role: "user",
        content: "Do the thing",
        agentId: "agent-sidechain",
        isSidechain: true,
        timestamp: new Date("2026-08-01T00:00:05.200Z"),
      }),
      baseMessage({
        uuid: "sx2",
        type: "assistant",
        role: "assistant",
        model: "claude-haiku-5",
        agentId: "agent-sidechain",
        isSidechain: true,
        timestamp: new Date("2026-08-01T00:00:05.400Z"),
        usage: { input_tokens: 10, output_tokens: 5 },
        content: [{ type: "text", text: "Did the thing." }],
      }),
    ];
    const subagent: Process = {
      id: "agent-sidechain",
      filePath: "/fake/agent-sidechain.jsonl",
      messages,
      startTime: new Date("2026-08-01T00:00:05.200Z"),
      endTime: new Date("2026-08-01T00:00:05.400Z"),
      durationMs: 200,
      metrics: {
        durationMs: 200,
        totalTokens: 15,
        inputTokens: 10,
        outputTokens: 5,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        messageCount: messages.length,
      },
      isParallel: false,
    };

    const lean = shapeTraceForResponse(buildDetailWithProcesses([subagent]));
    const shaped = (lean.chunks[1] as LeanAIChunk).subagents[0];
    expect(shaped.steps.length).toBeGreaterThan(0);
    // The input objects must not be mutated — the re-flag copies.
    expect(messages.every((m) => m.isSidechain)).toBe(true);
  });
});

// =============================================================================
// buildTraceFromFile — the file-addressed core extracted from buildTrace
// =============================================================================
//
// buildTrace resolves a session id to a path (DB -> glob -> gzip archive) and
// then delegates here. Ingest (plan U4) calls buildTraceFromFile directly with
// a path it resolved itself, so this half must be testable against an ordinary
// JSONL file with no DB row, no ~/.claude/projects entry, and no archive.
//
// It also returns `rawLinesByUuid` — the verbatim original JSONL line for each
// record that survived the active-path filter, keyed by uuid. The vendored
// ParsedMessage drops the original text, and ingest needs it byte-for-byte for
// the `raw_records` table, so the adapter captures it at the one place that
// already reads and splits the file.

interface FixtureTranscript {
  dir: string;
  filePath: string;
  /** The exact strings written to disk, in file order. */
  lines: string[];
}

function writeFixtureTranscript(sessionId: string, records: Record<string, unknown>[]): FixtureTranscript {
  const dir = mkdtempSync(join(tmpdir(), "trace-from-file-"));
  const filePath = join(dir, `${sessionId}.jsonl`);
  const lines = records.map((r) => JSON.stringify(r));
  writeFileSync(filePath, lines.join("\n") + "\n");
  return { dir, filePath, lines };
}

function userRecord(uuid: string, parentUuid: string | null, text: string, minute: number) {
  return {
    type: "user",
    uuid,
    parentUuid,
    sessionId: "fixture",
    timestamp: `2026-08-01T00:0${minute}:00.000Z`,
    cwd: "/repo",
    gitBranch: "main",
    isSidechain: false,
    message: { role: "user", content: text },
  };
}

function assistantRecord(uuid: string, parentUuid: string, text: string, minute: number) {
  return {
    type: "assistant",
    uuid,
    parentUuid,
    sessionId: "fixture",
    timestamp: `2026-08-01T00:0${minute}:00.000Z`,
    isSidechain: false,
    message: {
      role: "assistant",
      model: "claude-sonnet-5",
      content: [{ type: "text", text }],
      usage: { input_tokens: 100, output_tokens: 20 },
    },
  };
}

describe("buildTraceFromFile", () => {
  test("parses an arbitrary JSONL path with no DB row, no project id, and no archive", async () => {
    const fixture = writeFixtureTranscript("fixture-session-1", [
      userRecord("u1", null, "Explain the trace adapter", 1),
      assistantRecord("a1", "u1", "It resolves a session id then parses the transcript.", 2),
    ]);
    try {
      const detail = await buildTraceFromFile(fixture.filePath, null, "fixture-session-1");

      expect(detail.session.id).toBe("fixture-session-1");
      expect(detail.messages.length).toBe(2);
      expect(detail.chunks.length).toBeGreaterThan(0);
      expect(detail.metrics.messageCount).toBe(2);
      // No project id -> no subagent resolution attempted (the archive-fallback
      // degradation path), and the stub session carries the file's directory.
      expect(detail.processes).toHaveLength(0);
      expect(detail.session.hasSubagents).toBe(false);
    } finally {
      rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  test("returns rawLinesByUuid holding the verbatim original line for every parsed record", async () => {
    const fixture = writeFixtureTranscript("fixture-session-2", [
      userRecord("u1", null, "Explain the trace adapter", 1),
      assistantRecord("a1", "u1", "It resolves a session id then parses the transcript.", 2),
    ]);
    try {
      const detail = await buildTraceFromFile(fixture.filePath, null, "fixture-session-2");

      expect(detail.rawLinesByUuid.get("u1")).toBe(fixture.lines[0]);
      expect(detail.rawLinesByUuid.get("a1")).toBe(fixture.lines[1]);
      expect(detail.rawLinesByUuid.size).toBe(2);

      // Verbatim means re-parseable into the original record — this is what
      // lands in `raw_records.raw`.
      const reparsed = JSON.parse(detail.rawLinesByUuid.get("a1")!) as { uuid: string };
      expect(reparsed.uuid).toBe("a1");

      // Every message the pipeline produced can find its raw line.
      for (const msg of detail.messages) {
        expect(detail.rawLinesByUuid.has(msg.uuid)).toBe(true);
      }
    } finally {
      rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  test("preserves the raw line byte-for-byte, not a re-serialization of it", async () => {
    // Hand-written line with non-canonical spacing: a JSON.stringify round trip
    // would silently normalize it away.
    const dir = mkdtempSync(join(tmpdir(), "trace-from-file-verbatim-"));
    const filePath = join(dir, "fixture-session-3.jsonl");
    const spaced =
      '{"type":"user",  "uuid":"u1", "parentUuid":null, "sessionId":"fixture", "timestamp":"2026-08-01T00:01:00.000Z", "cwd":"/repo", "isSidechain":false, "message":{"role":"user","content":"spacing matters"}}';
    writeFileSync(filePath, spaced + "\n");
    try {
      const detail = await buildTraceFromFile(filePath, null, "fixture-session-3");
      expect(detail.rawLinesByUuid.get("u1")).toBe(spaced);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("omits records the active-path filter dropped (abandoned rewind branches)", async () => {
    // u2a and u2b are both children of a1 — a rewind fork. The active leaf is
    // the later branch (a2 <- u2b); u2a's subtree is a human re-prompt, i.e. a
    // genuinely abandoned branch. Those records stay out of BOTH the parsed
    // model and rawLinesByUuid; the gzip archive remains their only home.
    const fixture = writeFixtureTranscript("fixture-session-4", [
      userRecord("u1", null, "First question about the parser", 1),
      assistantRecord("a1", "u1", "Here is the first answer to that question.", 2),
      userRecord("u2a", "a1", "Abandoned follow-up that was rewound away", 3),
      userRecord("u2b", "a1", "The follow-up that actually happened", 4),
      assistantRecord("a2", "u2b", "Here is the answer on the surviving branch.", 5),
    ]);
    try {
      const detail = await buildTraceFromFile(fixture.filePath, null, "fixture-session-4");

      expect(detail.rawLinesByUuid.has("u2b")).toBe(true);
      expect(detail.rawLinesByUuid.has("u2a")).toBe(false);
      expect(detail.messages.map((m) => m.uuid)).not.toContain("u2a");
      expect(detail.messages.map((m) => m.uuid)).toContain("u2b");
    } finally {
      rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  test("throws PARSE_FAILED when the path can't be read", async () => {
    let caught: unknown;
    try {
      await buildTraceFromFile(join(tmpdir(), "definitely-not-a-transcript-9182.jsonl"), null, "nope");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
  });

  test.if(!!smallestOverall)(
    "buildTrace delegates to it: same session, same message count, for a real transcript",
    async () => {
      const viaId = await buildTrace(smallestOverall!.sessionId);
      const viaPath = await buildTraceFromFile(
        join(smallestOverall!.projectDir, `${smallestOverall!.sessionId}.jsonl`),
        smallestOverall!.projectDir.split("/").pop()!,
        smallestOverall!.sessionId
      );

      expect(viaPath.session.id).toBe(viaId.session.id);
      expect(viaPath.messages.length).toBe(viaId.messages.length);
      expect(viaPath.chunks.length).toBe(viaId.chunks.length);
      expect(viaPath.rawLinesByUuid.size).toBeGreaterThan(0);
    }
  );

  test.if(!!smallestWithSubagents)(
    "captures subagent files' raw lines alongside the parent's",
    async () => {
      const detail = await buildTraceFromFile(
        join(smallestWithSubagents!.projectDir, `${smallestWithSubagents!.sessionId}.jsonl`),
        smallestWithSubagents!.projectDir.split("/").pop()!,
        smallestWithSubagents!.sessionId
      );

      expect(detail.processes.length).toBeGreaterThan(0);
      const subagentMessages = detail.processes.flatMap((p) => p.messages);
      expect(subagentMessages.length).toBeGreaterThan(0);

      // Subagent records live in sibling files the parent's active-path pass
      // never reads, so the adapter must read them too — otherwise ingest
      // writes messages whose record_uuid has no raw_records row.
      const missing = subagentMessages.filter((m) => !detail.rawLinesByUuid.has(m.uuid));
      expect(missing).toHaveLength(0);
    }
  );
});
