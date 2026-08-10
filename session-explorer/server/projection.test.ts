import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "url";

import {
  extractFileReferences,
  PROJECTION_TOOL_RESULT_CAP,
  PROJECTION_TRUNCATION_MARKER,
  projectHeader,
  projectMessage,
  projectMessages,
  type ProjectedRow,
} from "./projection";
import { MAX_FTS_TOKEN_LEN } from "./redact";
import { buildTraceFromFile } from "./trace/index";
import {
  extractToolCalls,
  extractToolResults,
} from "./trace/vendor/main/utils/toolExtraction";
import type { ContentBlock } from "./trace/vendor/main/types/jsonl";
import type { ParsedMessage } from "./trace/vendor/main/types/messages";

// ── Fixture helper ────────────────────────────────────────────────────
//
// Fixtures are built with the VENDORED extractors (`extractToolCalls` /
// `extractToolResults`, server/trace/vendor/main/utils/toolExtraction.ts),
// the exact functions `parseChatHistoryEntry` (vendor/main/utils/jsonl.ts:165)
// uses to populate `toolCalls`/`toolResults`. Hand-writing those arrays would
// let a fixture drift from what the real parser hands the projection.

const T0 = "2026-08-10T12:00:00.000Z";

function parsed(partial: Partial<ParsedMessage> & Pick<ParsedMessage, "uuid" | "type">): ParsedMessage {
  const content = partial.content ?? "";
  return {
    parentUuid: null,
    timestamp: new Date(T0),
    content,
    isSidechain: false,
    isMeta: false,
    toolCalls: extractToolCalls(content),
    toolResults: extractToolResults(content),
    ...partial,
  } as ParsedMessage;
}

function blocks(...b: ContentBlock[]): ContentBlock[] {
  return b;
}

describe("projectMessage — assistant records", () => {
  test("thinking + text + tool_use projects text and tool_use rows in block order", () => {
    const msg = parsed({
      uuid: "assistant-uuid-1",
      type: "assistant",
      role: "assistant",
      content: blocks(
        { type: "thinking", thinking: "internal reasoning", signature: "sig" },
        { type: "text", text: "Reading the config file now." },
        {
          type: "tool_use",
          id: "toolu_01ABC",
          name: "Read",
          input: { file_path: "/tmp/session-explorer/server/config.ts" },
        }
      ),
    });

    const rows: ProjectedRow[] = projectMessage(msg, "parent");

    // Thinking blocks produce NO row: `message_type` vocabulary is fixed at
    // text|tool_use|tool_result|system|subagent_prompt (D9), and thinking text
    // is already served by trace chunks + raw_records.
    expect(rows.map((r) => r.messageType)).toEqual(["text", "tool_use"]);
    expect(rows[0].role).toBe("assistant");
    expect(rows[0].content).toBe("Reading the config file now.");
    expect(rows[0].toolUseId).toBeNull();
    expect(rows[0].recordUuid).toBe("assistant-uuid-1");
    expect(rows[0].timestamp).toBe(T0);

    // The 'ToolName: <summary>' format is the contract with the Ask/chat SQL
    // recipe at server/chat.ts:89 (`content LIKE 'ToolName:%'`).
    expect(rows[1].content).toBe("Read: /tmp/session-explorer/server/config.ts");
    expect(rows[1].toolName).toBe("Read");
    expect(rows[1].toolUseId).toBe("toolu_01ABC");
    expect(rows[1].toolInput).toBe(
      JSON.stringify({ file_path: "/tmp/session-explorer/server/config.ts" })
    );
  });
});

describe("projectMessage — user text", () => {
  test("user text is verbatim and carries role 'user'", () => {
    const msg = parsed({
      uuid: "user-uuid-1",
      type: "user",
      role: "user",
      content: blocks({
        type: "text",
        text: "please fix the ingest tick, it double-counts subagents",
      }),
    });

    const rows = projectMessage(msg, "parent");

    expect(rows).toHaveLength(1);
    expect(rows[0].role).toBe("user");
    expect(rows[0].messageType).toBe("text");
    expect(rows[0].content).toBe(
      "please fix the ingest tick, it double-counts subagents"
    );
  });

  test("string content (older sessions) projects one verbatim text row", () => {
    const msg = parsed({
      uuid: "user-uuid-2",
      type: "user",
      role: "user",
      content: "ship it",
    });

    const rows = projectMessage(msg, "parent");

    expect(rows).toHaveLength(1);
    expect(rows[0].role).toBe("user");
    expect(rows[0].content).toBe("ship it");
  });
});

describe("projectMessage — tool results", () => {
  test("tool_result body is redacted, then capped, then FTS-token-guarded", () => {
    // Real shape: tool results arrive as `type:'user'` records whose content
    // is a tool_result block, with `sourceToolUseID` mirrored on the record
    // (vendor/main/utils/jsonl.ts:147).
    const body = [
      "export const key = 'AKIAIOSFODNN7EXAMPLF';",
      "deploy log line two",
    ].join("\n");
    const msg = parsed({
      uuid: "toolresult-uuid-1",
      type: "user",
      role: "user",
      sourceToolUseID: "toolu_01ABC",
      content: blocks({
        type: "tool_result",
        tool_use_id: "toolu_01ABC",
        content: body,
      }),
    });

    const rows = projectMessage(msg, "parent");

    expect(rows).toHaveLength(1);
    expect(rows[0].messageType).toBe("tool_result");
    expect(rows[0].role).toBe("user");
    expect(rows[0].toolUseId).toBe("toolu_01ABC");
    // redactSecrets ran: the AWS key shape is gone, ordinary text survives.
    expect(rows[0].content).not.toContain("AKIAIOSFODNN7EXAMPLF");
    expect(rows[0].content).toContain("[REDACTED:aws-access-key]");
    expect(rows[0].content).toContain("deploy log line two");
  });

  test("a 50 KB tool result caps at PROJECTION_TOOL_RESULT_CAP with a truncation marker", () => {
    // Words + spaces so guardFtsTokens is a no-op here and the cap is the
    // only length effect under test.
    const body = "alpha bravo charlie delta ".repeat(2000); // ~52 KB
    expect(body.length).toBeGreaterThan(50_000);

    const msg = parsed({
      uuid: "toolresult-uuid-2",
      type: "user",
      role: "user",
      content: blocks({
        type: "tool_result",
        tool_use_id: "toolu_01BIG",
        content: body,
      }),
    });

    const rows = projectMessage(msg, "parent");

    expect(rows).toHaveLength(1);
    expect(rows[0].content).toHaveLength(PROJECTION_TOOL_RESULT_CAP);
    expect(rows[0].content.endsWith(PROJECTION_TRUNCATION_MARKER)).toBe(true);
    expect(rows[0].content.startsWith("alpha bravo charlie")).toBe(true);
  });

  test("no token in a projected tool_result exceeds MAX_FTS_TOKEN_LEN", () => {
    // Minified-bundle shape: one enormous whitespace-free run.
    const msg = parsed({
      uuid: "toolresult-uuid-3",
      type: "user",
      role: "user",
      content: blocks({
        type: "tool_result",
        tool_use_id: "toolu_01MIN",
        content: "a".repeat(500),
      }),
    });

    const rows = projectMessage(msg, "parent");

    const longest = Math.max(
      ...rows[0].content.split(/\s+/).map((t) => t.length)
    );
    expect(longest).toBeLessThanOrEqual(MAX_FTS_TOKEN_LEN);
  });

  test("array-form tool_result content joins its text blocks", () => {
    const msg = parsed({
      uuid: "toolresult-uuid-4",
      type: "user",
      role: "user",
      content: blocks({
        type: "tool_result",
        tool_use_id: "toolu_01ARR",
        content: [
          { type: "text", text: "first chunk" },
          { type: "text", text: "second chunk" },
        ],
      }),
    });

    const rows = projectMessage(msg, "parent");

    expect(rows).toHaveLength(1);
    expect(rows[0].content).toBe("first chunk\nsecond chunk");
  });

  test("a record whose content is only tool_results yields only tool_result rows", () => {
    const msg = parsed({
      uuid: "toolresult-uuid-5",
      type: "user",
      role: "user",
      content: blocks(
        { type: "tool_result", tool_use_id: "toolu_A", content: "result A" },
        { type: "tool_result", tool_use_id: "toolu_B", content: "result B" }
      ),
    });

    const rows = projectMessage(msg, "parent");

    expect(rows.map((r) => r.messageType)).toEqual([
      "tool_result",
      "tool_result",
    ]);
    expect(rows.map((r) => r.content)).toEqual(["result A", "result B"]);
    expect(rows.map((r) => r.toolUseId)).toEqual(["toolu_A", "toolu_B"]);
  });
});

describe("projectMessage — subagent source hint", () => {
  test("subagent user text becomes subagent_prompt, not text", () => {
    // Contract: server/index.ts:191,204,217,229 all filter
    // `message_type != 'subagent_prompt'`, and CLAUDE.md states queries
    // filtering `message_type = 'text'` exclude subagent prompts for free.
    const msg = parsed({
      uuid: "sub-user-uuid-1",
      type: "user",
      role: "user",
      isSidechain: true,
      content: blocks({
        type: "text",
        text: "You are the implementer. Implement plan unit U3.",
      }),
    });

    expect(projectMessage(msg, "parent")[0].messageType).toBe("text");
    expect(projectMessage(msg, "subagent")[0].messageType).toBe(
      "subagent_prompt"
    );
  });

  test("subagent assistant text stays 'text'; subagent tool rows keep their types", () => {
    const assistantMsg = parsed({
      uuid: "sub-assistant-uuid-1",
      type: "assistant",
      role: "assistant",
      isSidechain: true,
      content: blocks(
        { type: "text", text: "Running the projection tests now." },
        {
          type: "tool_use",
          id: "toolu_01SUB",
          name: "Bash",
          input: { command: "bun test server/projection.test.ts" },
        }
      ),
    });
    const resultMsg = parsed({
      uuid: "sub-result-uuid-1",
      type: "user",
      role: "user",
      isSidechain: true,
      content: blocks({
        type: "tool_result",
        tool_use_id: "toolu_01SUB",
        content: "8 pass 0 fail",
      }),
    });

    expect(projectMessage(assistantMsg, "subagent").map((r) => r.messageType))
      .toEqual(["text", "tool_use"]);
    expect(projectMessage(resultMsg, "subagent").map((r) => r.messageType))
      .toEqual(["tool_result"]);
  });

  test("subagent string-content user text also becomes subagent_prompt", () => {
    const msg = parsed({
      uuid: "sub-user-uuid-2",
      type: "user",
      role: "user",
      isSidechain: true,
      content: "legacy-format subagent prompt",
    });

    expect(projectMessage(msg, "subagent")[0].messageType).toBe(
      "subagent_prompt"
    );
  });
});

describe("projectMessage — XML noise vs the dropped strip.ts heuristics", () => {
  test("harness XML wrappers are stripped from text rows", () => {
    const msg = parsed({
      uuid: "xml-uuid-1",
      type: "user",
      role: "user",
      content: blocks({
        type: "text",
        text:
          "real user prose\n<system-reminder>injected reminder body</system-reminder>\n" +
          "<task-notification>agent finished</task-notification>more prose",
      }),
    });

    const rows = projectMessage(msg, "parent");

    expect(rows).toHaveLength(1);
    expect(rows[0].content).not.toContain("<system-reminder>");
    expect(rows[0].content).not.toContain("injected reminder body");
    expect(rows[0].content).not.toContain("<task-notification>");
    expect(rows[0].content).toContain("real user prose");
    expect(rows[0].content).toContain("more prose");
  });

  test("a text block that is ONLY XML noise produces no row", () => {
    const msg = parsed({
      uuid: "xml-uuid-2",
      type: "user",
      role: "user",
      content: blocks({
        type: "text",
        text: "<system-reminder>only noise here</system-reminder>",
      }),
    });

    expect(projectMessage(msg, "parent")).toHaveLength(0);
  });

  test("assistant text under 100 chars survives (strip.ts:609 heuristic is gone)", () => {
    // strip.ts dropped every assistant text block of <= 100 chars outright —
    // permanent loss of short answers like this one. Full fidelity is the
    // point of the migration, so it must now be projected.
    const short = "Yes — that race is real.";
    expect(short.length).toBeLessThan(100);

    const msg = parsed({
      uuid: "short-uuid-1",
      type: "assistant",
      role: "assistant",
      content: blocks({ type: "text", text: short }),
    });

    const rows = projectMessage(msg, "parent");

    expect(rows).toHaveLength(1);
    expect(rows[0].content).toBe(short);
  });

  test("a skill-injection dump is kept verbatim (collapse heuristic is gone)", () => {
    // strip.ts:322-342 replaced this whole body with "[Skill loaded: …]" and
    // retyped the row as 'system'. Dropped per U3: keep the text, keep 'text'.
    const body =
      "Base directory for this skill: /Users/blake/.claude/skills/cass\n" +
      "# cass\n" +
      "Mine past agent sessions for working prompts.\n".repeat(40);
    expect(body.length).toBeGreaterThan(500);

    const msg = parsed({
      uuid: "skill-uuid-1",
      type: "user",
      role: "user",
      content: blocks({ type: "text", text: body }),
    });

    const rows = projectMessage(msg, "parent");

    expect(rows).toHaveLength(1);
    expect(rows[0].messageType).toBe("text");
    expect(rows[0].content).not.toContain("[Skill loaded:");
    expect(rows[0].content).toContain("Base directory for this skill:");
    expect(rows[0].content.length).toBeGreaterThan(500);
  });

  test("a slash-command wrapper compacts to '/name args'", () => {
    // stripXmlNoise does NOT know <command-name>, so without this the row
    // would render as raw XML in the UI. Unlike strip.ts:371 the args are no
    // longer sliced to 100 chars.
    const args = "unit U3 ".repeat(30).trim();
    const msg = parsed({
      uuid: "cmd-uuid-1",
      type: "user",
      role: "user",
      content: blocks({
        type: "text",
        text:
          "<command-name>/implement</command-name>" +
          "<command-message>implement</command-message>" +
          `<command-args>${args}</command-args>`,
      }),
    });

    const rows = projectMessage(msg, "parent");

    expect(rows).toHaveLength(1);
    expect(rows[0].messageType).toBe("text");
    expect(rows[0].content).toBe(`/implement ${args}`);
  });
});

describe("projectMessage — system records", () => {
  test("a system record with text projects a 'system' row", () => {
    const msg = parsed({
      uuid: "system-uuid-1",
      type: "system",
      content: "Turn duration 41s",
    });

    const rows = projectMessage(msg, "parent");

    expect(rows).toHaveLength(1);
    expect(rows[0].messageType).toBe("system");
    expect(rows[0].role).toBe("user");
    expect(rows[0].content).toBe("Turn duration 41s");
  });

  test("a contentless system record projects no row", () => {
    // The vendored parser never copies content off a SystemEntry
    // (vendor/main/utils/jsonl.ts:160-162), so this is the common case.
    const msg = parsed({ uuid: "system-uuid-2", type: "system" });
    expect(projectMessage(msg, "parent")).toHaveLength(0);
  });

  test("summary records project no rows", () => {
    const msg = parsed({ uuid: "summary-uuid-1", type: "summary" });
    expect(projectMessage(msg, "parent")).toHaveLength(0);
  });
});

describe("projectMessage — empty, image, and malformed input", () => {
  test("an empty content-block array produces no rows", () => {
    const msg = parsed({ uuid: "empty-uuid-1", type: "assistant", content: [] });
    expect(projectMessage(msg, "parent")).toEqual([]);
  });

  test("whitespace-only text blocks produce no rows", () => {
    const msg = parsed({
      uuid: "empty-uuid-2",
      type: "assistant",
      role: "assistant",
      content: blocks({ type: "text", text: "   \n\t  " }),
    });
    expect(projectMessage(msg, "parent")).toEqual([]);
  });

  test("image blocks produce no row but do not suppress sibling text", () => {
    const msg = parsed({
      uuid: "image-uuid-1",
      type: "user",
      role: "user",
      content: blocks(
        {
          type: "image",
          source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" },
        },
        { type: "text", text: "here is the screenshot" }
      ),
    });

    const rows = projectMessage(msg, "parent");

    expect(rows).toHaveLength(1);
    expect(rows[0].messageType).toBe("text");
    expect(rows[0].content).toBe("here is the screenshot");
    // The base64 payload must never reach messages.content / FTS.
    expect(rows[0].content).not.toContain("iVBORw0KGgo=");
  });

  test("malformed and partial records never throw", () => {
    const malformed: unknown[] = [
      undefined,
      null,
      {},
      { uuid: "m1" },
      { uuid: "m2", type: "user" }, // no role, no content
      { uuid: "m3", type: "assistant", content: "string instead of blocks" },
      { uuid: "m4", type: "user", content: [null, undefined, 42, "raw string"] },
      { uuid: "m5", type: "assistant", content: [{ type: "text" }] }, // text block, no text
      { uuid: "m6", type: "assistant", content: [{ type: "tool_use", input: {} }] }, // no name
      { uuid: "m7", type: "user", content: [{ type: "tool_result" }] }, // no body
      { uuid: "m8", type: "assistant", content: { not: "an array" } },
      { type: "assistant", content: [{ type: "text", text: "no uuid" }] },
      {
        uuid: "m9",
        type: "assistant",
        timestamp: "2026-08-10T12:00:00.000Z", // string, not Date
        content: [{ type: "text", text: "bad timestamp type" }],
      },
    ];

    for (const m of malformed) {
      expect(() => projectMessage(m as ParsedMessage, "parent")).not.toThrow();
      expect(() => projectMessage(m as ParsedMessage, "subagent")).not.toThrow();
    }
  });

  test("a record with no uuid still projects, with recordUuid null", () => {
    const msg = {
      type: "assistant",
      role: "assistant",
      timestamp: new Date(T0),
      content: [{ type: "text", text: "orphan record" }],
      isSidechain: false,
      isMeta: false,
      toolCalls: [],
      toolResults: [],
    } as unknown as ParsedMessage;

    const rows = projectMessage(msg, "parent");

    expect(rows).toHaveLength(1);
    expect(rows[0].recordUuid).toBeNull();
  });

  test("a non-Date timestamp yields a null timestamp, not a crash", () => {
    const msg = {
      uuid: "ts-uuid-1",
      type: "assistant",
      role: "assistant",
      timestamp: "2026-08-10T12:00:00.000Z",
      content: [{ type: "text", text: "bad timestamp type" }],
      isSidechain: false,
      isMeta: false,
      toolCalls: [],
      toolResults: [],
    } as unknown as ParsedMessage;

    expect(projectMessage(msg, "parent")[0].timestamp).toBeNull();
  });
});

describe("projectMessages", () => {
  test("flattens a conversation in message order, applying the source hint to all", () => {
    const msgs = [
      parsed({
        uuid: "c1",
        type: "user",
        role: "user",
        content: blocks({ type: "text", text: "run the tests" }),
      }),
      parsed({
        uuid: "c2",
        type: "assistant",
        role: "assistant",
        content: blocks(
          { type: "text", text: "Running them." },
          {
            type: "tool_use",
            id: "toolu_1",
            name: "Bash",
            input: { command: "bun test" },
          }
        ),
      }),
      parsed({
        uuid: "c3",
        type: "user",
        role: "user",
        content: blocks({
          type: "tool_result",
          tool_use_id: "toolu_1",
          content: "25 pass 0 fail",
        }),
      }),
    ];

    expect(projectMessages(msgs, "parent").map((r) => r.messageType)).toEqual([
      "text",
      "text",
      "tool_use",
      "tool_result",
    ]);
    expect(projectMessages(msgs, "subagent").map((r) => r.messageType)).toEqual([
      "subagent_prompt",
      "text",
      "tool_use",
      "tool_result",
    ]);
  });

  test("a non-array argument yields no rows", () => {
    expect(projectMessages(undefined as unknown as ParsedMessage[])).toEqual([]);
  });
});

describe("extractFileReferences", () => {
  test("Write/Edit/Read tool calls become session_files rows, deduped by path+operation", () => {
    const msgs = [
      parsed({
        uuid: "f1",
        type: "assistant",
        role: "assistant",
        content: blocks(
          {
            type: "tool_use",
            id: "toolu_w",
            name: "Write",
            input: { file_path: "/repo/server/projection.ts", content: "…" },
          },
          {
            type: "tool_use",
            id: "toolu_r",
            name: "Read",
            input: { file_path: "/repo/server/strip.ts" },
          }
        ),
      }),
      parsed({
        uuid: "f2",
        type: "assistant",
        role: "assistant",
        content: blocks(
          {
            type: "tool_use",
            id: "toolu_r2",
            name: "Read",
            input: { file_path: "/repo/server/strip.ts" }, // duplicate path+op
          },
          {
            type: "tool_use",
            id: "toolu_e",
            name: "Edit",
            input: { file_path: "/repo/server/strip.ts" }, // same path, new op
          },
          {
            type: "tool_use",
            id: "toolu_b",
            name: "Bash",
            input: { command: "ls /repo" }, // not a file tool
          },
          {
            type: "tool_use",
            id: "toolu_g",
            name: "Grep",
            input: { pattern: "TODO", file_path: "/repo" }, // not a file tool
          }
        ),
      }),
    ];

    const files = extractFileReferences(msgs);

    expect(files).toEqual([
      {
        filePath: "/repo/server/projection.ts",
        fileName: "projection.ts",
        operation: "write",
        timestamp: T0,
        sequence: 0,
      },
      {
        filePath: "/repo/server/strip.ts",
        fileName: "strip.ts",
        operation: "read",
        timestamp: T0,
        sequence: 1,
      },
      {
        filePath: "/repo/server/strip.ts",
        fileName: "strip.ts",
        operation: "edit",
        timestamp: T0,
        sequence: 2,
      },
    ]);
  });

  test("lowercase tool aliases are covered and a missing file_path is skipped", () => {
    const msgs = [
      parsed({
        uuid: "f3",
        type: "assistant",
        role: "assistant",
        content: blocks(
          {
            type: "tool_use",
            id: "toolu_lw",
            name: "write",
            input: { file_path: "/repo/a.ts" },
          },
          {
            type: "tool_use",
            id: "toolu_nopath",
            name: "Read",
            input: {}, // no file_path — must not produce a reference
          },
          {
            type: "tool_use",
            id: "toolu_badpath",
            name: "Read",
            input: { file_path: 42 }, // non-string — must not produce one
          }
        ),
      }),
    ];

    const files = extractFileReferences(msgs);

    expect(files).toHaveLength(1);
    expect(files[0].operation).toBe("write");
    expect(files[0].filePath).toBe("/repo/a.ts");
  });

  test("malformed input never throws", () => {
    expect(() =>
      extractFileReferences([undefined, null, {}] as unknown as ParsedMessage[])
    ).not.toThrow();
    expect(
      extractFileReferences(undefined as unknown as ParsedMessage[])
    ).toEqual([]);
  });
});

describe("projectHeader", () => {
  test("takes branch and cwd from the first record that carries them", () => {
    const msgs = [
      parsed({ uuid: "h0", type: "summary" }),
      parsed({
        uuid: "h1",
        type: "user",
        role: "user",
        cwd: "/Users/blake/Documents/Development/tools",
        gitBranch: "worktree-parser-migration",
        content: blocks({ type: "text", text: "hi" }),
      }),
      parsed({
        uuid: "h2",
        type: "user",
        role: "user",
        cwd: "/somewhere/else",
        gitBranch: "other",
        content: blocks({ type: "text", text: "later" }),
      }),
    ];

    expect(projectHeader(msgs)).toEqual({
      branch: "worktree-parser-migration",
      cwd: "/Users/blake/Documents/Development/tools",
    });
  });

  test("branch and cwd resolve independently when they appear on different records", () => {
    const msgs = [
      parsed({ uuid: "h3", type: "user", role: "user", cwd: "/repo" }),
      parsed({ uuid: "h4", type: "assistant", role: "assistant", gitBranch: "main" }),
    ];

    expect(projectHeader(msgs)).toEqual({ branch: "main", cwd: "/repo" });
  });

  test("empty strings when nothing carries a header, and no throw on junk", () => {
    expect(projectHeader([])).toEqual({ branch: "", cwd: "" });
    expect(projectHeader(undefined as unknown as ParsedMessage[])).toEqual({
      branch: "",
      cwd: "",
    });
    expect(() =>
      projectHeader([null, undefined, {}] as unknown as ParsedMessage[])
    ).not.toThrow();
  });
});

// ── Golden-file check ─────────────────────────────────────────────────
//
// Layer-2 wiring test: the REAL vendored pipeline (SessionParser →
// active-path filter → ChunkBuilder, via buildTraceFromFile) parses a real
// on-disk transcript, and the projection runs over its `detail.messages`.
// Everything below the file read is production code — the only thing this
// test stubs is the transcript itself.
//
// The fixture is derived from strip.test.ts's inline fixture shape (uuid /
// parentUuid chained records with sessionId+cwd+gitBranch) and covers every
// block type U3 has a rule for: thinking, text, tool_use, tool_result,
// image, a slash-command wrapper and a system-reminder-only turn.

describe("golden file — server/fixtures/projection-sample.jsonl", () => {
  test("projects the row sequence the UI and Ask/chat expect", async () => {
    const fixture = fileURLToPath(
      new URL("./fixtures/projection-sample.jsonl", import.meta.url)
    );
    const detail = await buildTraceFromFile(
      fixture,
      null,
      "9f4f5030-1c2a-4d55-b0a1-projection00"
    );

    const rows = projectMessages(detail.messages, "parent");

    expect(rows.map((r) => [r.messageType, r.content])).toEqual([
      ["text", "Port the strip.ts tool summarizer into projection.ts"],
      ["text", "Reading strip.ts first."],
      ["tool_use", "Read: /repo/session-explorer/server/strip.ts"],
      [
        "tool_result",
        '1→import { readFileSync } from "fs";\n' +
          "     2→\n" +
          "     3→// deploy creds pasted into a scratch file by mistake\n" +
          '     4→const awsKey = "[REDACTED:aws-access-key]";',
      ],
      // Under strip.ts this 5-char assistant answer was deleted outright.
      ["text", "Done."],
      ["tool_use", "Write: /repo/session-explorer/server/projection.ts"],
      [
        "tool_result",
        "File created successfully at: /repo/session-explorer/server/projection.ts",
      ],
      ["text", "/implement unit U3"],
      // r7 (system-reminder only) yields no row.
      ["text", "does this screenshot look right?"],
    ]);

    // Roles, tool linkage and raw-record join keys survive the real pipeline.
    expect(rows.map((r) => r.role)).toEqual([
      "user",
      "assistant",
      "assistant",
      "user",
      "assistant",
      "assistant",
      "user",
      "user",
      "user",
    ]);
    expect(rows.filter((r) => r.messageType === "tool_use").map((r) => r.toolUseId))
      .toEqual(["toolu_read_1", "toolu_write_1"]);
    expect(
      rows.filter((r) => r.messageType === "tool_result").map((r) => r.toolUseId)
    ).toEqual(["toolu_read_1", "toolu_write_1"]);
    expect(rows.every((r) => typeof r.recordUuid === "string" && r.recordUuid))
      .toBe(true);
    expect(rows.every((r) => r.timestamp?.endsWith("Z"))).toBe(true);

    // No base64 image payload ever reaches messages.content / FTS.
    expect(rows.some((r) => r.content.includes("iVBORw0KGgo"))).toBe(false);
  });

  test("file references and header come off the same parsed fixture", async () => {
    const fixture = fileURLToPath(
      new URL("./fixtures/projection-sample.jsonl", import.meta.url)
    );
    const detail = await buildTraceFromFile(
      fixture,
      null,
      "9f4f5030-1c2a-4d55-b0a1-projection00"
    );

    expect(extractFileReferences(detail.messages)).toEqual([
      {
        filePath: "/repo/session-explorer/server/strip.ts",
        fileName: "strip.ts",
        operation: "read",
        timestamp: "2026-08-10T12:00:05.000Z",
        sequence: 0,
      },
      {
        filePath: "/repo/session-explorer/server/projection.ts",
        fileName: "projection.ts",
        operation: "write",
        timestamp: "2026-08-10T12:00:20.000Z",
        sequence: 1,
      },
    ]);

    expect(projectHeader(detail.messages)).toEqual({
      branch: "worktree-parser-migration",
      cwd: "/Users/blake/Documents/Development/tools/session-explorer",
    });
  });
});
