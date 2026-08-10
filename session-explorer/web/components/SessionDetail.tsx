import React, { useState, useEffect, useRef, useCallback, useMemo, useLayoutEffect, useContext, createContext } from "react";
import { useParams, useNavigate, useSearch } from "@tanstack/react-router";
import { useWindowVirtualizer } from "@tanstack/react-virtual";
import type { SessionDetail as SessionDetailType, Message, Tag, FileReference } from "../types";
import { categorizeFileRefs } from "../fileCategories";
import { MarkdownBody, cleanUserContent } from "../sessionFormat";
import { isLong } from "../traceFormat";
import { INSIGHT_TYPE_COLORS } from "../insight-shared";
import { useExtraction } from "../hooks/useExtraction";
import SessionHeader from "./SessionHeader";
import { sessionRoute } from "../router";

// ── Windowed fetch paging (plan U5/U7) ───────────────────────────────
// Page size for explicit `/messages` fetches once a session exceeds the
// server's inline first window (`config.defaultPageSize`, currently 50).
// Kept well under the endpoint's own 500-row cap so one page load never
// spikes JSON-parse time on a huge session.
const MESSAGES_PAGE_SIZE = 200;
// Fetch the next page once the virtualizer's rendered range gets this close
// to the end of what's currently loaded (scroll-driven page loads, D11).
const LOAD_MORE_ROW_THRESHOLD = 8;
// Safety cap on "load pages until the target sequence appears" (deep links
// via ?msg=, U7) so a stale/bogus sequence can't loop forever fetching pages.
const MAX_SEEK_PAGES = 60; // 60 * MESSAGES_PAGE_SIZE = 12,000 messages

function formatTime(dateStr: string | null): string {
  if (!dateStr) return "";
  return new Date(dateStr).toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
}

const TOOL_ICON = (
  <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
    <path d="M0 2.75C0 1.784.784 1 1.75 1h12.5c.966 0 1.75.784 1.75 1.75v10.5A1.75 1.75 0 0114.25 15H1.75A1.75 1.75 0 010 13.25zm1.75-.25a.25.25 0 00-.25.25v10.5c0 .138.112.25.25.25h12.5a.25.25 0 00.25-.25V2.75a.25.25 0 00-.25-.25zM7.25 8a.749.749 0 01-.22.53l-2.25 2.25a.749.749 0 11-1.06-1.06L5.44 8 3.72 6.28a.749.749 0 111.06-1.06l2.25 2.25c.141.14.22.331.22.53zm1.5 1.5h3a.75.75 0 010 1.5h-3a.75.75 0 010-1.5z"/>
  </svg>
);

/** Pretty-print JSON in content. Handles single objects, arrays, and concatenated JSON objects. */
function tryPrettyPrint(content: string): string {
  const trimmed = content.trim();
  // Single JSON value
  if ((trimmed.startsWith("{") || trimmed.startsWith("[")) ) {
    try {
      return JSON.stringify(JSON.parse(trimmed), null, 2);
    } catch { /* try splitting */ }
    // Concatenated JSON objects: {...} {...} or {...}\n{...}
    const objects: string[] = [];
    let depth = 0, start = -1;
    for (let i = 0; i < trimmed.length; i++) {
      const ch = trimmed[i];
      if (ch === "{" || ch === "[") { if (depth === 0) start = i; depth++; }
      else if (ch === "}" || ch === "]") {
        depth--;
        if (depth === 0 && start >= 0) {
          try {
            const chunk = trimmed.slice(start, i + 1);
            objects.push(JSON.stringify(JSON.parse(chunk), null, 2));
          } catch { objects.push(trimmed.slice(start, i + 1)); }
          start = -1;
        }
      }
    }
    if (objects.length > 0) return objects.join("\n\n");
  }
  return content;
}

/** Parse "ToolName: content" from tool_use messages */
function parseToolUse(content: string): { name: string; input: string } | null {
  const match = content.match(/^(\w+):\s*([\s\S]*)$/);
  if (!match) return null;
  return { name: match[1], input: match[2] };
}

function ToolBlock({ label, content, timestamp, highlight, sequence }: {
  label: string; content: string; timestamp?: string | null; highlight?: boolean; sequence: number;
}) {
  return (
    <div
      id={`msg-${sequence}`}
      className={`result-snippet type-tool ${highlight ? "message-highlight" : ""}`}
    >
      <div className="snippet-tool-label">
        {TOOL_ICON}
        {label}
        {timestamp && (
          <span className="font-mono text-[10px] text-text-dim/60 font-normal ml-1">{formatTime(timestamp)}</span>
        )}
      </div>
      <div className="snippet-tool-output" style={{ WebkitLineClamp: "unset" }}>
        {tryPrettyPrint(content)}
      </div>
    </div>
  );
}

// ── Mermaid hydration ────────────────────────────────────────────────────────
// MarkdownBody's FencedCodeBlock renders <div class="mermaid-placeholder"
// data-mermaid="base64"> for ```mermaid fences. MermaidHost finds these
// after mount and renders them in-place.
function MermaidHost({ containerRef }: { containerRef: React.RefObject<HTMLDivElement | null> }) {
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const placeholders = Array.from(el.querySelectorAll<HTMLElement>(".mermaid-placeholder[data-mermaid]"));
    if (placeholders.length === 0) return;

    let cancelled = false;
    (async () => {
      const mermaid = (await import("mermaid")).default;
      mermaid.initialize({ startOnLoad: false, theme: "dark", securityLevel: "strict" });
      for (const ph of placeholders) {
        if (cancelled) break;
        const encoded = ph.dataset.mermaid ?? "";
        try {
          const code = decodeURIComponent(escape(atob(encoded)));
          const id = `mmd-${Math.random().toString(36).slice(2)}`;
          const { svg } = await mermaid.render(id, code);
          const wrapper = document.createElement("div");
          wrapper.className = "mermaid-rendered";
          wrapper.innerHTML = svg;
          ph.replaceWith(wrapper);
        } catch (e) {
          ph.textContent = `[Mermaid error: ${e}]`;
          ph.className = "mermaid-error";
        }
      }
    })();
    return () => { cancelled = true; };
  }, [containerRef]);

  return null;
}

// ── Persisted expand/collapse state across virtualization remounts (U7) ──
// Rows scrolling out of the virtualizer's rendered range and back in are
// fresh React mounts — a plain `useState` for "show reasoning" / "show
// more" resets every time. This context holds a plain (mutated-in-place,
// not React-state) `Map<string, boolean>` created once per SessionDetail
// instance, so a row can read its prior toggle value on remount without
// forcing the whole list to re-render on every toggle. Cleared whenever
// the session id changes (see the `[id]` effect) so keys — which reuse
// per-session `sequence` numbers — never bleed across sessions.
const ExpandStoreContext = createContext<Map<string, boolean> | null>(null);

function usePersistedExpand(
  key: string,
  initial = false
): [boolean, (updater: boolean | ((prev: boolean) => boolean)) => void] {
  const store = useContext(ExpandStoreContext);
  const [value, setValue] = useState(() => store?.get(key) ?? initial);
  const setPersisted = useCallback(
    (updater: boolean | ((prev: boolean) => boolean)) => {
      setValue((prev) => {
        const next = typeof updater === "function" ? (updater as (prev: boolean) => boolean)(prev) : updater;
        store?.set(key, next);
        return next;
      });
    },
    [store, key]
  );
  return [value, setPersisted];
}

const COLLAPSE_PX = 320; // ~20 lines at 14px/1.5lh

function CollapsibleContent({ children, className, contentKey, expandKey }: { children: React.ReactNode; className?: string; contentKey: string; expandKey: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [overflows, setOverflows] = useState(false);
  const [expanded, setExpanded] = usePersistedExpand(`collapsible-${expandKey}`);

  // Keyed on the content STRING, not the children element: an element is a
  // new object every render, which made this scrollHeight read (a forced
  // synchronous layout) fire for every visible bubble on every re-render.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    setOverflows(el.scrollHeight > COLLAPSE_PX + 10);
  }, [contentKey]);

  return (
    <>
      <div
        ref={ref}
        className={`message-content collapsible-wrap${overflows && !expanded ? " collapsed" : ""} ${className ?? ""}`}
      >
        {children}
      </div>
      <MermaidHost containerRef={ref} />
      {overflows && (
        <button className="collapsible-btn" onClick={() => setExpanded((e) => !e)}>
          {expanded ? "Show less" : `Show more`}
        </button>
      )}
    </>
  );
}

function MessageBubble({ message, highlight }: { message: Message; highlight?: boolean }) {
  const isToolResult = message.role === "user" && message.message_type === "tool_result";
  const isToolUse = message.message_type === "tool_use";
  const isSystem = message.message_type === "system" || message.message_type === "subagent_prompt";
  const isUser = message.role === "user" && !isToolResult && !isSystem;

  // System message (skill loaded, system context, subagent prompts)
  if (isSystem) {
    return (
      <details
        id={`msg-${message.sequence}`}
        className={`system-msg ${highlight ? "message-highlight" : ""}`}
      >
        <summary>
          <svg width="14" height="14" viewBox="0 0 16 16" fill="#bc8cff"><path d="M8.5 1.5a1 1 0 00-1 0L2.1 4.75a1 1 0 000 1.73l5.4 3.25a1 1 0 001 0l5.4-3.25a1 1 0 000-1.73zM2.1 9.52l5.4 3.25a1 1 0 001 0l5.4-3.25" stroke="#bc8cff" strokeWidth="1" fill="none"/></svg>
          {message.message_type === "subagent_prompt" ? "Subagent prompt" : message.content.replace(/^\[|\]$/g, '')}
        </summary>
      </details>
    );
  }

  // Tool result (output from a tool)
  if (isToolResult) {
    return <ToolBlock label="Tool output" content={message.content} timestamp={message.timestamp} highlight={highlight} sequence={message.sequence} />;
  }

  // Tool use (Claude invoking a tool)
  if (isToolUse) {
    const parsed = parseToolUse(message.content);
    const label = parsed ? parsed.name : "Tool";
    const content = parsed ? parsed.input : message.content;
    return <ToolBlock label={label} content={content} timestamp={message.timestamp} highlight={highlight} sequence={message.sequence} />;
  }

  // Clean harness noise from user content before rendering
  const displayContent = isUser ? cleanUserContent(message.content) : message.content;
  if (!displayContent) return null;

  return (
    <div
      id={`msg-${message.sequence}`}
      className={`result-snippet ${isUser ? "type-user" : "type-claude"} ${highlight ? "message-highlight" : ""}`}
    >
      <div className="bubble-role">
        {isUser ? "YOU" : "CLAUDE"}
        {message.timestamp && (
          <span className="font-mono text-[10px] opacity-50 font-normal ml-1.5">{formatTime(message.timestamp)}</span>
        )}
      </div>
      <CollapsibleContent contentKey={displayContent} expandKey={`msg-${message.sequence}`}>
        <MarkdownBody text={displayContent} />
      </CollapsibleContent>
    </div>
  );
}

// ─── Assistant turn grouping ─────────────────────────────────────────────
// Groups consecutive non-user items (text bubbles + tool groups) between
// two user turns into a single collapsible AssistantTurn block, mirroring
// the claude-devtools "Claude · N tool calls, N messages" header pattern.

type TurnItem =
  | { kind: "user"; item: GroupedItem }
  | {
      kind: "assistant";
      items: GroupedItem[];
      msgCount: number;
      toolCount: number;
      lastTime: string | null;
      firstSeq: number;
    };

function buildTurns(grouped: GroupedItem[]): TurnItem[] {
  const turns: TurnItem[] = [];
  let assistantBatch: GroupedItem[] = [];

  function flushAssistant() {
    if (assistantBatch.length === 0) return;
    let msgCount = 0, toolCount = 0;
    let lastTime: string | null = null;
    let firstSeq = Infinity;
    for (const g of assistantBatch) {
      if (g.kind === "text") {
        msgCount++;
        const seq = g.msg.sequence ?? Infinity;
        if (seq < firstSeq) firstSeq = seq;
        if (g.msg.timestamp) lastTime = g.msg.timestamp;
      } else {
        toolCount += g.items.length;
        const seq = g.firstSeq ?? Infinity;
        if (seq < firstSeq) firstSeq = seq;
        if (g.lastTime) lastTime = g.lastTime;
      }
    }
    turns.push({
      kind: "assistant",
      items: assistantBatch,
      msgCount,
      toolCount,
      lastTime,
      firstSeq: firstSeq === Infinity ? 0 : firstSeq,
    });
    assistantBatch = [];
  }

  for (const g of grouped) {
    const isUserText =
      g.kind === "text" &&
      g.msg.role === "user" &&
      g.msg.message_type !== "tool_result" &&
      g.msg.message_type !== "system" &&
      g.msg.message_type !== "subagent_prompt";

    if (isUserText) {
      flushAssistant();
      turns.push({ kind: "user", item: g });
    } else {
      assistantBatch.push(g);
    }
  }
  flushAssistant();
  return turns;
}

/** Find the row index (into a `turns`/`visibleTurns` array) whose content
 *  contains the given raw message `sequence` — the virtualization-era
 *  replacement for `document.getElementById('msg-'+seq)`: rows outside the
 *  virtualizer's rendered range simply aren't in the DOM, so lookups must
 *  go through the data model instead (U7). Returns -1 if not present in
 *  the given (possibly userOnly-filtered, possibly not-yet-fully-loaded)
 *  array. */
function findTurnIndexForSequence(turns: TurnItem[], seq: number): number {
  for (let i = 0; i < turns.length; i++) {
    const t = turns[i];
    if (t.kind === "user") {
      if ((t.item as { kind: "text"; msg: Message }).msg.sequence === seq) return i;
    } else {
      for (const g of t.items) {
        if (g.kind === "text" && g.msg.sequence === seq) return i;
        if (g.kind === "tools" && g.allSequences.includes(seq)) return i;
      }
    }
  }
  return -1;
}

function AssistantTurnBlock({
  turn,
  highlight,
  userOnly,
  highlightSeq,
  isLive,
  sessionId,
}: {
  turn: TurnItem & { kind: "assistant" };
  highlight: boolean;
  userOnly: boolean;
  highlightSeq: number;
  isLive: boolean;
  sessionId: string;
}) {
  const [expanded, setExpanded] = usePersistedExpand(`turn-${turn.firstSeq}`);

  // Find the last assistant text message — shown by default
  const lastTextItem = [...turn.items].reverse().find(
    (g) => g.kind === "text" && g.msg.role === "assistant" && g.msg.message_type === "text"
  );
  const hasHidden = turn.items.length > 1 || (turn.items.length === 1 && !lastTextItem);

  const parts: string[] = [];
  if (turn.toolCount > 0) parts.push(`${turn.toolCount} tool call${turn.toolCount !== 1 ? "s" : ""}`);
  if (turn.msgCount > 1) parts.push(`${turn.msgCount} messages`);
  const summary = parts.join(", ");

  return (
    <div className={`assistant-turn ${highlight ? "message-highlight" : ""}`}>
      <button
        className="assistant-turn-header"
        onClick={() => setExpanded((e) => !e)}
        title={expanded ? "Collapse reasoning" : "Show reasoning + tool calls"}
      >
        <span className="assistant-turn-label">Claude</span>
        {summary && <span className="assistant-turn-summary">· {summary}</span>}
        {turn.lastTime && (
          <span className="assistant-turn-time">{formatTime(turn.lastTime)}</span>
        )}
        {hasHidden && (
          <span className={`assistant-turn-chevron ${expanded ? "" : "collapsed"}`}>▾</span>
        )}
      </button>

      {/* Expanded: show everything */}
      {expanded && (
        <div className="assistant-turn-body">
          {turn.items.map((g, idx) => {
            if (g.kind === "tools") {
              if (userOnly) return null;
              const groupHighlight = !isNaN(highlightSeq) && g.allSequences.includes(highlightSeq);
              return <ToolGroupBlock key={`tg-${idx}`} group={g} highlight={groupHighlight} isLive={isLive} sessionId={sessionId} />;
            }
            const msg = g.msg;
            return (
              <MessageBubble
                key={msg.sequence}
                message={msg}
                highlight={!isNaN(highlightSeq) && msg.sequence === highlightSeq}
              />
            );
          })}
        </div>
      )}

      {/* Collapsed: show only the final text message */}
      {!expanded && lastTextItem && lastTextItem.kind === "text" && (
        <MessageBubble
          message={lastTextItem.msg}
          highlight={!isNaN(highlightSeq) && lastTextItem.msg.sequence === highlightSeq}
        />
      )}

      {/* Collapsed: no final text message (turn was all tool calls) — show nothing extra */}
    </div>
  );
}

// ─── Tool grouping + per-tool rendering ───────────────────────────────────
// Claude Code emits long runs of tool_use/tool_result messages between user
// turns. Rendering each as its own snippet drowns the conversation. Instead:
// collect consecutive tool_use/tool_result messages into a collapsed group
// summarized as "Bash × 3" / "Read, Bash, Edit (7)", with results inlined
// under their matching tool_use by tool_use_id.

type GroupedItem =
  | { kind: "text"; msg: Message }
  | {
      kind: "tools";
      firstSeq: number;
      lastTime: string | null;
      items: Array<{ use: Message; result: Message | null }>;
      allSequences: number[];
    };

function groupMessagesForRender(messages: Message[]): GroupedItem[] {
  const out: GroupedItem[] = [];
  let i = 0;
  while (i < messages.length) {
    const m = messages[i];
    const isToolMsg = m.message_type === "tool_use" || m.message_type === "tool_result";
    if (!isToolMsg) {
      out.push({ kind: "text", msg: m });
      i++;
      continue;
    }

    const uses: Message[] = [];
    const resultsById = new Map<string, Message>();
    const orphanResults: Message[] = [];
    const allSequences: number[] = [];
    let lastTime: string | null = null;
    let firstSeq = m.sequence;
    let consumedAny = false;

    while (i < messages.length) {
      const t = messages[i];
      if (t.message_type === "tool_use") {
        uses.push(t);
        allSequences.push(t.sequence);
        lastTime = t.timestamp ?? lastTime;
        if (!consumedAny) { firstSeq = t.sequence; consumedAny = true; }
        i++;
      } else if (t.message_type === "tool_result") {
        if (t.tool_use_id) resultsById.set(t.tool_use_id, t);
        else orphanResults.push(t);
        allSequences.push(t.sequence);
        lastTime = t.timestamp ?? lastTime;
        if (!consumedAny) { firstSeq = t.sequence; consumedAny = true; }
        i++;
      } else {
        break;
      }
    }

    const items = uses.map((use, idx) => {
      let result: Message | null = null;
      if (use.tool_use_id && resultsById.has(use.tool_use_id)) {
        result = resultsById.get(use.tool_use_id)!;
      } else if (orphanResults[idx]) {
        result = orphanResults[idx];
      }
      return { use, result };
    });

    out.push({ kind: "tools", firstSeq, lastTime, items, allSequences });
  }
  return out;
}

/** Parse a tool_use message's `tool_name` + `tool_input`. Falls back to
 *  parsing the content prefix ("Bash: ls -la") for rows ingested before
 *  the schema carried these fields. */
function readToolCall(msg: Message): { name: string; input: Record<string, unknown> } {
  let input: Record<string, unknown> = {};
  if (msg.tool_input) {
    try { input = JSON.parse(msg.tool_input) || {}; } catch { /* ignore */ }
  }
  if (msg.tool_name) return { name: msg.tool_name, input };
  const match = msg.content.match(/^(\w+):\s*([\s\S]*)$/);
  if (match) return { name: match[1], input: { __summary: match[2] } };
  return { name: "Tool", input: { __summary: msg.content } };
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + "\n… (truncated)" : s;
}

function escHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** LCS-based unified diff — returns HTML string with styled lines */
function lcsDiff(oldStr: string, newStr: string): string {
  const oldLines = oldStr.split("\n");
  const newLines = newStr.split("\n");
  const m = oldLines.length, n = newLines.length;

  // Fallback for large diffs
  if (m * n > 50000) {
    const dels = oldLines.map(l => `<div class="diff-del">− ${escHtml(l)}</div>`).join("");
    const adds = newLines.map(l => `<div class="diff-add">+ ${escHtml(l)}</div>`).join("");
    return dels + adds;
  }

  // DP table: backward LCS
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--)
    for (let j = n - 1; j >= 0; j--)
      dp[i][j] = oldLines[i] === newLines[j] ? dp[i+1][j+1] + 1 : Math.max(dp[i+1][j], dp[i][j+1]);

  let html = "";
  let i = 0, j = 0;
  while (i < m || j < n) {
    if (i < m && j < n && oldLines[i] === newLines[j]) {
      html += `<div class="diff-ctx">  ${escHtml(oldLines[i])}</div>`;
      i++; j++;
    } else if (j < n && (i >= m || dp[i][j+1] >= dp[i+1][j])) {
      html += `<div class="diff-add">+ ${escHtml(newLines[j])}</div>`;
      j++;
    } else {
      html += `<div class="diff-del">− ${escHtml(oldLines[i])}</div>`;
      i++;
    }
  }
  return html;
}

/** Best-effort extraction of a tool_result block's text from a verbatim
 *  Claude Code JSONL line (`server/serving.ts`'s `getRawRecord` — untouched
 *  by redaction/capping). Shape varies: `message.content` may be a bare
 *  string (older sessions) or an array of blocks, one of which is
 *  `{ type: "tool_result", content }` where that nested `content` is
 *  itself a string OR an array of `{ type: "text", text }` blocks. Falls
 *  back to pretty-printed raw JSON so "expand" never renders nothing. */
function extractRawToolResultText(raw: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return raw;
  }
  const message = (parsed as Record<string, unknown> | null)?.["message"] as
    | Record<string, unknown>
    | undefined;
  const content = message?.["content"];
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    for (const block of content) {
      if (block && typeof block === "object" && (block as Record<string, unknown>)["type"] === "tool_result") {
        const inner = (block as Record<string, unknown>)["content"];
        if (typeof inner === "string") return inner;
        if (Array.isArray(inner)) {
          return inner
            .map((b) =>
              b && typeof b === "object" && typeof (b as Record<string, unknown>)["text"] === "string"
                ? ((b as Record<string, unknown>)["text"] as string)
                : ""
            )
            .join("");
        }
      }
    }
  }
  try {
    return JSON.stringify(parsed, null, 2);
  } catch {
    return raw;
  }
}

// String-length gate for "is this tool result worth collapsing" — deliberately
// not a scrollHeight/DOM read (D11/U7: `CollapsibleContent`'s own comment on
// why that's a perf trap; tool payloads can sit right at the 4000-char
// projection cap, so a forced sync layout per big block adds up fast).
const TOOL_RESULT_COLLAPSE_THRESHOLD = 1200;

type FullFetchState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "loaded"; text: string };

function ToolResultInline({ result, sessionId }: { result: Message; sessionId: string }) {
  const isError = /error|failed|Error:/i.test(result.content.slice(0, 80));
  const [expanded, setExpanded] = usePersistedExpand(`toolresult-${result.sequence}`);
  const [full, setFull] = useState<FullFetchState>({ status: "idle" });

  // Expand-on-click source (D2/U7): only offered when the row was actually
  // capped by the projection (`truncated`) AND carries a join key into
  // `raw_records`. Pre-migration rows have neither — hidden, not broken.
  const canLoadFull = !!result.record_uuid && !!result.truncated;
  const displayContent = full.status === "loaded" ? full.text : result.content;
  const isBig = isLong(displayContent, TOOL_RESULT_COLLAPSE_THRESHOLD);
  const shown = isBig && !expanded ? truncate(displayContent, TOOL_RESULT_COLLAPSE_THRESHOLD) : displayContent;

  async function loadFull() {
    if (!result.record_uuid || full.status === "loading") return;
    setFull({ status: "loading" });
    try {
      const res = await fetch(`/api/sessions/${sessionId}/records/${result.record_uuid}`);
      if (res.status === 404) {
        setFull({ status: "error", message: "Original record not found (session may predate the migration)." });
        return;
      }
      if (!res.ok) {
        setFull({ status: "error", message: `Failed to load full result (${res.status}).` });
        return;
      }
      const data = await res.json();
      setFull({ status: "loaded", text: extractRawToolResultText(data.raw) });
      setExpanded(true);
    } catch {
      setFull({ status: "error", message: "Failed to load full result." });
    }
  }

  return (
    <details className={`tool-result-inline ${isError ? "tool-result-err" : "tool-result-ok"}`}>
      <summary>{isError ? "⚠ Error" : "Result"}</summary>
      <pre>{shown}</pre>
      {isBig && (
        <button type="button" className="tool-result-expand-btn" onClick={() => setExpanded((e) => !e)}>
          {expanded ? "Show less" : "Show more"}
        </button>
      )}
      {canLoadFull && full.status !== "loaded" && (
        <button
          type="button"
          className="tool-result-expand-btn"
          onClick={loadFull}
          disabled={full.status === "loading"}
        >
          {full.status === "loading" ? "Loading full result…" : full.status === "error" ? "Retry — load full result" : "Load full result"}
        </button>
      )}
      {full.status === "error" && <div className="tool-result-error">{full.message}</div>}
    </details>
  );
}

function ToolCallBlock({ use, result, sessionId }: { use: Message; result: Message | null; sessionId: string }) {
  const { name, input } = readToolCall(use);
  const time = use.timestamp ? formatTime(use.timestamp) : "";

  const header = (label: string, badgeClass: string, right?: React.ReactNode) => (
    <div className="tool-mini-header">
      <span className={`tool-mini-badge ${badgeClass}`}>{label}</span>
      {right}
      {time && <span className="tool-mini-time">{time}</span>}
    </div>
  );

  if (name === "Bash") {
    const cmd = String(input.command ?? input.__summary ?? "");
    const desc = String(input.description ?? "");
    return (
      <div id={`msg-${use.sequence}`} className="tool-mini tool-mini-bash">
        {header("Bash", "bg-[#1f2328] text-[#e6edf3]", desc && <span className="tool-mini-desc" title={desc}>{desc}</span>)}
        <pre className="tool-mini-body tool-mini-code">{truncate(cmd, 800)}</pre>
        {result && <ToolResultInline result={result} sessionId={sessionId} />}
      </div>
    );
  }

  if (name === "Edit" || name === "MultiEdit") {
    const fp = String(input.file_path ?? "");
    const oldStr = String(input.old_string ?? "");
    const newStr = String(input.new_string ?? "");
    const diffHtml = (oldStr || newStr) ? lcsDiff(oldStr, newStr) : null;
    return (
      <div id={`msg-${use.sequence}`} className="tool-mini tool-mini-edit">
        {header(name, "bg-[#f4a261]/20 text-[#f4a261]", fp && <span className="tool-mini-path" title={fp}>{fp}</span>)}
        {diffHtml && (
          <div className="diff-view" dangerouslySetInnerHTML={{ __html: diffHtml }} />
        )}
        {result && <ToolResultInline result={result} sessionId={sessionId} />}
      </div>
    );
  }

  if (name === "Write") {
    const fp = String(input.file_path ?? "");
    const content = String(input.content ?? "");
    return (
      <div id={`msg-${use.sequence}`} className="tool-mini tool-mini-write">
        {header("Write", "bg-[#2a9d8f]/20 text-[#2a9d8f]", fp && <span className="tool-mini-path" title={fp}>{fp}</span>)}
        {content && <pre className="tool-mini-body tool-mini-code">{truncate(content, 600)}</pre>}
        {result && <ToolResultInline result={result} sessionId={sessionId} />}
      </div>
    );
  }

  if (name === "TodoWrite" || name === "TaskCreate" || name === "TaskUpdate") {
    const raw = input.todos;
    let todos: Array<{ content?: string; subject?: string; status: string }> = [];
    if (Array.isArray(raw)) todos = raw as any;
    else if (typeof raw === "string") { try { todos = JSON.parse(raw); } catch { /* empty */ } }
    if (todos.length === 0) {
      const subject = String(input.subject ?? input.__summary ?? "");
      return (
        <div id={`msg-${use.sequence}`} className="tool-mini tool-mini-todo">
          {header(name, "bg-[#457b9d]/20 text-[#8bb8d8]")}
          {subject && <div className="tool-mini-body text-[12px]">{subject}</div>}
          {result && <ToolResultInline result={result} sessionId={sessionId} />}
        </div>
      );
    }
    return (
      <div id={`msg-${use.sequence}`} className="tool-mini tool-mini-todo">
        {header("Tasks", "bg-[#457b9d]/20 text-[#8bb8d8]")}
        <ul className="todo-list-mini">
          {todos.map((t, idx) => {
            const icon = t.status === "completed" ? "✓" : t.status === "in_progress" ? "●" : "○";
            const cls = t.status === "completed" ? "todo-done" : t.status === "in_progress" ? "todo-active" : "";
            return (
              <li key={idx} className={`todo-item-mini ${cls}`}>
                <span className="todo-icon-mini">{icon}</span>
                <span>{t.content ?? t.subject ?? ""}</span>
              </li>
            );
          })}
        </ul>
        {result && <ToolResultInline result={result} sessionId={sessionId} />}
      </div>
    );
  }

  if (name === "Read" || name === "Glob" || name === "Grep") {
    const preview = formatInputPreview(input);
    // Hide result unless it's an error — cleaner reading
    const isError = result ? /error|failed|Error:/i.test(result.content.slice(0, 80)) : false;
    return (
      <div id={`msg-${use.sequence}`} className="tool-mini tool-mini-generic">
        {header(name, "bg-[#2a2a2a] text-[#c9d1d9]", preview && <span className="tool-mini-path" title={preview}>{preview}</span>)}
        {result && isError && <ToolResultInline result={result} sessionId={sessionId} />}
      </div>
    );
  }

  // Generic fallback — compact key:value preview, JSON available on expand
  const preview = formatInputPreview(input);
  const pretty = (() => {
    try { return JSON.stringify(input, null, 2); } catch { return String(input.__summary ?? ""); }
  })();
  return (
    <div id={`msg-${use.sequence}`} className="tool-mini tool-mini-generic">
      {header(name, "bg-[#2a2a2a] text-[#c9d1d9]", preview && <span className="tool-mini-path" title={preview}>{preview}</span>)}
      {pretty && pretty !== "{}" && (
        <details className="tool-mini-details">
          <summary className="tool-mini-details-summary">params</summary>
          <pre className="tool-mini-body tool-mini-code">{truncate(pretty, 400)}</pre>
        </details>
      )}
      {result && <ToolResultInline result={result} sessionId={sessionId} />}
    </div>
  );
}

/** One-line key: value, key: value preview of a tool input object. */
function formatInputPreview(input: Record<string, unknown>): string {
  if (input.__summary !== undefined) return String(input.__summary);
  const keys = Object.keys(input);
  if (keys.length === 0) return "";
  // Prioritize the params most useful at a glance
  const priority = ["pattern", "file_path", "path", "query", "url", "command", "subject", "description"];
  const ordered = [...keys].sort((a, b) => {
    const ai = priority.indexOf(a);
    const bi = priority.indexOf(b);
    if (ai === -1 && bi === -1) return 0;
    if (ai === -1) return 1;
    if (bi === -1) return -1;
    return ai - bi;
  });
  const parts: string[] = [];
  for (const k of ordered.slice(0, 4)) {
    const v = input[k];
    if (v === undefined || v === null || v === "") continue;
    const s = typeof v === "string" ? v : JSON.stringify(v);
    const short = s.length > 60 ? s.slice(0, 57) + "…" : s;
    parts.push(`${k}: ${short}`);
  }
  return parts.join(", ");
}

function ToolGroupBlock({
  group,
  highlight,
  isLive,
  sessionId,
}: {
  group: Extract<GroupedItem, { kind: "tools" }>;
  highlight: boolean;
  isLive: boolean;
  sessionId: string;
}) {
  const names = group.items.map((it) => readToolCall(it.use).name);
  const unique = Array.from(new Set(names));
  let summary: string;
  if (unique.length === 1) {
    summary = names.length > 1 ? `${unique[0]} × ${names.length}` : unique[0];
  } else if (unique.length <= 3) {
    summary = unique.join(", ") + (names.length > unique.length ? ` (${names.length})` : "");
  } else {
    summary = `${names.length} tool calls`;
  }
  const time = group.lastTime ? formatTime(group.lastTime) : "";

  return (
    <details
      id={`msg-${group.firstSeq}`}
      className={`tool-group ${highlight ? "message-highlight" : ""}`}
      open={highlight}
    >
      <summary className="tool-group-summary">
        <span className="tool-group-chevron">▶</span>
        <span className="tool-group-label">{isLive ? "Working" : "Tools"}</span>
        <span className="tool-group-desc">{summary}</span>
        {time && <span className="tool-group-time">{time}</span>}
      </summary>
      <div className="tool-group-body">
        {group.items.map((it, idx) => (
          <ToolCallBlock key={it.use.id ?? idx} use={it.use} result={it.result} sessionId={sessionId} />
        ))}
      </div>
    </details>
  );
}

function ToolsUsedChips({ messages }: { messages: Message[] }) {
  const counts = useMemo(() => {
    const map = new Map<string, number>();
    for (const m of messages) {
      if (m.message_type !== "tool_use") continue;
      let name = m.tool_name;
      if (!name) {
        const match = m.content.match(/^(\w+):/);
        if (match) name = match[1];
      }
      if (!name) continue;
      map.set(name, (map.get(name) || 0) + 1);
    }
    return [...map.entries()].sort((a, b) => b[1] - a[1]);
  }, [messages]);

  if (counts.length === 0) return null;

  return (
    <div className="mb-5 flex items-center gap-1.5 flex-wrap">
      <span className="text-[11px] font-semibold uppercase tracking-wider text-text-dim mr-1">
        Tools used
      </span>
      {counts.map(([name, count]) => (
        <span
          key={name}
          className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium bg-[#d29922]/10 text-[#d29922]/90 border border-[#d29922]/20"
        >
          {name}
          <span className="font-mono text-[10px] text-[#d29922]/70">{count}</span>
        </span>
      ))}
    </div>
  );
}

function FilesPanel({ sessionId }: { sessionId: string }) {
  const [files, setFiles] = useState<FileReference[]>([]);
  const [open, setOpen] = useState(false);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (!open || loaded) return;
    fetch(`/api/sessions/${sessionId}/files`)
      .then((r) => r.json())
      .then((data) => setFiles(data.files || []))
      .catch(() => setFiles([]))
      .finally(() => setLoaded(true));
  }, [sessionId, open, loaded]);

  const cats = categorizeFileRefs(files);
  const totalCount = loaded ? files.length : null;

  function FileEntry({ file }: { file: FileReference }) {
    return (
      <div className="flex items-center gap-1.5 py-0.5 group">
        <span className={`operation-badge operation-${file.operation} inline-block px-1.5 py-px rounded text-[9px] font-semibold uppercase tracking-wide shrink-0`}>
          {file.operation === "write" ? "new" : file.operation}
        </span>
        <a
          className="font-mono text-xs text-text-secondary overflow-hidden text-ellipsis whitespace-nowrap flex-1 no-underline hover:text-accent-blue hover:underline"
          href={`vscode://file${file.file_path}`}
          title={`Open in VS Code: ${file.file_path}`}
        >
          {file.file_path}
        </a>
        <button
          className="shrink-0 p-0.5 rounded text-text-dim opacity-0 transition-all group-hover:opacity-100 hover:text-text hover:bg-white/8"
          title="Copy path"
          onClick={() => navigator.clipboard.writeText(file.file_path)}
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
            <rect x="5" y="5" width="9" height="9" rx="1.5" stroke="currentColor" strokeWidth="1.2" />
            <path d="M3 11V3.5A1.5 1.5 0 014.5 2H10" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
          </svg>
        </button>
      </div>
    );
  }

  const sections: Array<{ key: string; label: string; cls: string; files: FileReference[] }> = [];
  if (cats.docs.length > 0) sections.push({ key: "docs", label: "Docs", cls: "file-cat-docs", files: cats.docs });
  if (cats.viz.length > 0) sections.push({ key: "viz", label: "Viz", cls: "file-cat-viz", files: cats.viz });
  if (cats.code.length > 0) sections.push({ key: "code", label: "Code", cls: "file-cat-code", files: cats.code });

  return (
    <div className="mb-5 border border-border rounded-lg bg-bg-card overflow-hidden">
      <button className="flex items-center gap-2 w-full px-3.5 py-2.5 text-[13px] font-medium text-text-secondary transition-[background] duration-100 hover:bg-white/3" onClick={() => setOpen(!open)}>
        <svg
          width="12"
          height="12"
          viewBox="0 0 12 12"
          fill="none"
          style={{ transform: open ? "rotate(90deg)" : "rotate(0deg)", transition: "transform 0.15s" }}
        >
          <path d="M4 2L8 6L4 10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        <span>Files touched</span>
        {totalCount !== null && (
          <div className="flex items-center gap-1.5 ml-1">
            {sections.map(({ key, label, cls, files: catFiles }) => (
              <span key={key} className={`${cls} inline-flex items-center gap-0.5 px-1.5 py-px rounded text-[10px] font-semibold uppercase tracking-wide`}>
                {catFiles.length} {label}
              </span>
            ))}
          </div>
        )}
      </button>
      {open && loaded && files.length === 0 && (
        <div className="px-3.5 py-3 text-xs text-text-dim border-t border-border">No file operations recorded for this session.</div>
      )}
      {open && loaded && files.length > 0 && (
        <div className="border-t border-border px-3.5 pt-2 pb-3">
          {sections.map(({ key, label, cls, files: catFiles }) => (
            <div key={key} className="mb-3 last:mb-0">
              <div className="flex items-center gap-2 mb-1.5">
                <span className={`${cls} inline-block px-2 py-px rounded text-[10px] font-semibold uppercase tracking-wide`}>{label}</span>
                <span className="text-[11px] text-text-dim">{catFiles.length} files</span>
              </div>
              {catFiles.map((f, i) => <FileEntry key={`${key}-${i}`} file={f} />)}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function InsightsPanel({ sessionId }: { sessionId: string }) {
  const navigate = useNavigate();
  const [insights, setInsights] = useState<Array<{
    id: number;
    type: string;
    content: string;
    observation_count: number;
    score: number;
    files: string[];
    source: string;
    last_observed_at: string;
  }>>([]);
  const [open, setOpen] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const { extracting, startExtraction: handleExtractSession } = useExtraction(() => {
    setLoaded(false); // force reload on next open
  });

  useEffect(() => {
    if (!open || loaded) return;
    fetch(`/api/sessions/${sessionId}/insights`)
      .then((r) => r.json())
      .then((data) => setInsights(data.insights || []))
      .catch(() => setInsights([]))
      .finally(() => setLoaded(true));
  }, [sessionId, open, loaded]);

  return (
    <div className="mb-5 border border-border rounded-lg bg-bg-card overflow-hidden">
      <button
        className="flex items-center gap-2 w-full px-3.5 py-2.5 text-[13px] font-medium text-text-secondary transition-[background] duration-100 hover:bg-white/3"
        onClick={() => setOpen(!open)}
      >
        <svg
          width="12"
          height="12"
          viewBox="0 0 12 12"
          fill="none"
          style={{ transform: open ? "rotate(90deg)" : "rotate(0deg)", transition: "transform 0.15s" }}
        >
          <path d="M4 2L8 6L4 10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        <span>Insights</span>
        {loaded && insights.length > 0 && (
          <span className="inline-flex items-center gap-0.5 px-1.5 py-px rounded text-[10px] font-semibold text-accent-purple bg-accent-purple/12">
            {insights.length}
          </span>
        )}
      </button>
      {open && !loaded && !extracting && (
        <div className="px-3.5 py-3 text-xs text-text-dim border-t border-border flex items-center gap-2">
          <div className="spinner w-3 h-3" />
          Loading...
        </div>
      )}
      {open && loaded && insights.length === 0 && (
        <div className="px-3.5 py-3 text-xs text-text-dim border-t border-border flex items-center gap-2">
          <span>No insights extracted for this session.</span>
          <button
            className="text-accent-purple hover:text-accent-purple/80 transition-colors disabled:opacity-40"
            onClick={handleExtractSession}
            disabled={extracting}
          >
            {extracting ? "Extracting..." : "Extract now"}
          </button>
        </div>
      )}
      {open && loaded && insights.length > 0 && (
        <div className="border-t border-border px-3.5 pt-2 pb-3 flex flex-col gap-2">
          {insights.map((insight) => (
            <div key={insight.id} className="flex items-start gap-2">
              <span
                className="shrink-0 mt-0.5 inline-block px-1.5 py-px rounded-full text-[9px] font-semibold uppercase tracking-wide"
                style={{
                  background: `${INSIGHT_TYPE_COLORS[insight.type] || "#888"}18`,
                  color: INSIGHT_TYPE_COLORS[insight.type] || "#888",
                }}
              >
                {insight.type}
              </span>
              <div className="flex-1 min-w-0">
                <p className="text-[12px] text-text leading-relaxed">{insight.content}</p>
                {insight.files && insight.files.length > 0 && (
                  <div className="flex items-center gap-1 mt-1 flex-wrap">
                    {insight.files.slice(0, 3).map((f) => (
                      <button
                        key={f}
                        className="inline-flex items-center px-1 py-px rounded text-[10px] font-mono text-accent-blue bg-accent-blue/8 hover:bg-accent-blue/15 max-w-[180px] truncate"
                        onClick={() => navigate({ to: "/file", search: { path: f } })}
                        title={f}
                      >
                        {f.split("/").pop()}
                      </button>
                    ))}
                  </div>
                )}
                {insight.observation_count > 1 && (
                  <span className="text-[10px] text-text-dim mt-0.5 inline-block">&times; {insight.observation_count} sessions</span>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// A session only counts as "live" when it has no recorded end time AND its
// most recent message is very recent — see `isLive` below.
const LIVE_WINDOW_MS = 10 * 60 * 1000; // 10 minutes

export default function SessionDetail() {
  const { id } = useParams({ from: sessionRoute.id });
  const navigate = useNavigate();
  const { msg: highlightMsg } = useSearch({ from: sessionRoute.id });
  const [session, setSession] = useState<SessionDetailType | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // -- User-only filter mode --
  const [userOnly, setUserOnly] = useState(false);

  // -- Windowed fetch state (plan U5/U7) --
  // `messages` starts as the server's inline first window (config.default
  // PageSize) and grows via `/api/sessions/:id/messages` as the virtualizer
  // scrolls near the end of what's loaded. Refs mirror the state so async
  // loops (page-load-until-found for deep links) always read the LATEST
  // value instead of a closure captured at effect-setup time.
  const [messages, setMessages] = useState<Message[]>([]);
  const [totalMessages, setTotalMessages] = useState(0);
  const [nextRawOffset, setNextRawOffset] = useState<number | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadMoreError, setLoadMoreError] = useState<string | null>(null);
  const [lastActivityAt, setLastActivityAt] = useState<string | null>(null);

  const messagesRef = useRef<Message[]>([]);
  const nextRawOffsetRef = useRef<number | null>(null);
  const totalMessagesRef = useRef(0);
  const loadingMoreRef = useRef(false);
  const loadedSequencesRef = useRef<Set<number>>(new Set());
  // Per-row expand/collapse toggles, keyed by a stable per-row id (message
  // sequence / turn firstSeq — see `usePersistedExpand`). Survives a row's
  // virtualizer-driven unmount/remount; cleared below on session change.
  const expandStoreRef = useRef<Map<string, boolean>>(new Map());

  function setMessagesBoth(next: Message[]) {
    messagesRef.current = next;
    setMessages(next);
  }
  function setNextRawOffsetBoth(next: number | null) {
    nextRawOffsetRef.current = next;
    setNextRawOffset(next);
  }
  function setTotalMessagesBoth(next: number) {
    totalMessagesRef.current = next;
    setTotalMessages(next);
  }

  useEffect(() => {
    setLoading(true);
    setError(null);
    loadedSequencesRef.current = new Set();
    expandStoreRef.current.clear();
    setMessagesBoth([]);
    setNextRawOffsetBoth(null);
    setTotalMessagesBoth(0);
    setLastActivityAt(null);
    setLoadMoreError(null);
    fetch(`/api/sessions/${id}`)
      .then((r) => {
        if (!r.ok) throw new Error("Session not found");
        return r.json();
      })
      .then((data) => {
          // API returns flat fields; normalize to match SessionDetail type
          if (data.workspace_name && !data.workspace) {
            data.workspace = {
              display_name: data.workspace_name,
              path: data.workspace_path,
            };
          }
          setSession(data);

          const initial: Message[] = data.messages ?? [];
          for (const m of initial) loadedSequencesRef.current.add(m.sequence);
          setMessagesBoth(initial);
          const total = data.message_count ?? initial.length;
          setTotalMessagesBoth(total);

          // Live-session liveness (below) needs the TRUE last message's
          // timestamp, not just whatever's in the first window. Short
          // sessions already have it; long ones get one cheap 1-row fetch
          // instead of loading the whole session just to answer that.
          if (initial.length >= total) {
            setLastActivityAt(initial[initial.length - 1]?.timestamp ?? data.started_at ?? null);
          } else if (!data.ended_at) {
            fetch(`/api/sessions/${id}/messages?offset=${Math.max(0, total - 1)}&limit=1`)
              .then((r) => r.json())
              .then((d) => {
                const last = (d.messages as Message[])[d.messages.length - 1];
                setLastActivityAt(last?.timestamp ?? data.started_at ?? null);
              })
              .catch(() => setLastActivityAt(data.started_at ?? null));
          }
        })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [id]);

  // Bootstrap: once we know the session is longer than the inline first
  // window, replace it with an explicitly-anchored page (offset=0) so
  // every later page's offset math is exact instead of guessed from a
  // post-filter array length (D9's cleanXmlNoise can drop rows to empty
  // content, shortening the returned array without shortening the raw
  // row range it consumed). Runs at most once per session load.
  useEffect(() => {
    if (!session || loading) return;
    if (nextRawOffsetRef.current !== null) return;
    if (messagesRef.current.length >= totalMessagesRef.current) return;
    let cancelled = false;
    fetch(`/api/sessions/${id}/messages?offset=0&limit=${MESSAGES_PAGE_SIZE}`)
      .then((r) => {
        if (!r.ok) throw new Error(`Failed to load messages (${r.status}).`);
        return r.json();
      })
      .then((data) => {
        if (cancelled) return;
        loadedSequencesRef.current = new Set((data.messages as Message[]).map((m) => m.sequence));
        setMessagesBoth(data.messages);
        setNextRawOffsetBoth(data.offset + data.limit);
      })
      .catch((e) => {
        if (!cancelled) setLoadMoreError(e instanceof Error ? e.message : "Failed to load messages.");
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session, loading, id]);

  // Scroll-driven page loads (D11): fetches the next raw-row window and
  // appends any not-already-loaded rows. Sequence-deduped so an overlap
  // between the bootstrap page and a stale trigger never double-renders a
  // row. Stable across the session's lifetime (reads/writes via refs) so
  // it's safe to call repeatedly from both the virtualizer's onChange and
  // the deep-link "load until found" loop below.
  const loadMorePage = useCallback(async (): Promise<"loaded" | "done" | "already-loading" | "error"> => {
    if (loadingMoreRef.current) return "already-loading";
    const offset = nextRawOffsetRef.current;
    if (offset === null || offset >= totalMessagesRef.current) return "done";
    loadingMoreRef.current = true;
    setLoadingMore(true);
    setLoadMoreError(null);
    try {
      const res = await fetch(`/api/sessions/${id}/messages?offset=${offset}&limit=${MESSAGES_PAGE_SIZE}`);
      if (!res.ok) throw new Error(`Failed to load more messages (${res.status}).`);
      const data = await res.json();
      const fresh: Message[] = (data.messages as Message[]).filter((m) => !loadedSequencesRef.current.has(m.sequence));
      for (const m of fresh) loadedSequencesRef.current.add(m.sequence);
      if (fresh.length > 0) {
        const next = [...messagesRef.current, ...fresh];
        messagesRef.current = next;
        setMessages(next);
      }
      const newOffset = data.offset + data.limit;
      nextRawOffsetRef.current = newOffset;
      setNextRawOffset(newOffset);
      return "loaded";
    } catch (e) {
      setLoadMoreError(e instanceof Error ? e.message : "Failed to load more messages.");
      return "error";
    } finally {
      loadingMoreRef.current = false;
      setLoadingMore(false);
    }
  }, [id]);

  const hasMore = nextRawOffset !== null ? nextRawOffset < totalMessages : messages.length < totalMessages;

  // -- In-page search state (re-pointed at the loaded window's DATA, not
  // the DOM — most loaded messages aren't mounted under virtualization, so
  // the old TreeWalker-over-.snippet-bubbles approach can't see them) --
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [matchSequences, setMatchSequences] = useState<number[]>([]);
  const [currentMatchIndex, setCurrentMatchIndex] = useState(0);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // -- Feature 1: Prev/Next user message navigation — scoped to the loaded
  // window (U7: re-pointed from "all messages" to "what's loaded so far"). --
  const userMessageSequences = useMemo(() => {
    return messages
      .filter((m) => m.role === "user" && m.message_type !== "tool_result")
      .map((m) => String(m.sequence));
  }, [messages]);

  const currentUserIdx = useMemo(() => {
    if (!highlightMsg) return -1;
    return userMessageSequences.indexOf(highlightMsg);
  }, [highlightMsg, userMessageSequences]);

  // -- Live-session detection (gates the "Working" tool-group label) --
  // liveTick re-evaluates the window once a minute so a session left open
  // past LIVE_WINDOW_MS flips from "Working" to "Tools" without a reload.
  // The interval only runs while the label could still change.
  const [liveTick, setLiveTick] = useState(0);
  const isLive = useMemo(() => {
    void liveTick;
    if (!session || session.ended_at) return false;
    if (!lastActivityAt) return false;
    return Date.now() - new Date(lastActivityAt).getTime() < LIVE_WINDOW_MS;
  }, [session, liveTick, lastActivityAt]);
  useEffect(() => {
    if (!isLive) return;
    const id = setInterval(() => setLiveTick((t) => t + 1), 60_000);
    return () => clearInterval(id);
  }, [isLive]);

  const jumpToUserMessage = useCallback(
    (direction: -1 | 1) => {
      if (userMessageSequences.length === 0) return;
      let targetIdx: number;
      if (currentUserIdx === -1) {
        // No current position: go to first (next) or last (prev)
        targetIdx = direction === 1 ? 0 : userMessageSequences.length - 1;
      } else {
        targetIdx = currentUserIdx + direction;
      }
      if (targetIdx < 0 || targetIdx >= userMessageSequences.length) return;
      navigate({
        to: "/session/$id",
        params: { id },
        search: { msg: userMessageSequences[targetIdx] },
        replace: true,
      });
    },
    [userMessageSequences, currentUserIdx, navigate, id],
  );

  const performSearch = useCallback(
    (query: string) => {
      if (!query) {
        setMatchSequences([]);
        setCurrentMatchIndex(0);
        return;
      }
      const lowerQuery = query.toLowerCase();
      const found = messagesRef.current
        .filter((m) => m.content.toLowerCase().includes(lowerQuery))
        .map((m) => m.sequence);
      setMatchSequences(found);
      setCurrentMatchIndex(0);
    },
    [],
  );

  const navigateMatch = useCallback(
    (direction: 1 | -1) => {
      if (matchSequences.length === 0) return;
      setCurrentMatchIndex((idx) => (idx + direction + matchSequences.length) % matchSequences.length);
    },
    [matchSequences],
  );

  const closeSearch = useCallback(() => {
    setSearchOpen(false);
    setSearchQuery("");
    setMatchSequences([]);
    setCurrentMatchIndex(0);
  }, []);

  // Debounced search effect
  useEffect(() => {
    if (!searchOpen) return;
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      performSearch(searchQuery);
    }, 150);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [searchQuery, searchOpen, performSearch]);

  // Focus input when search opens
  useEffect(() => {
    if (searchOpen) {
      setTimeout(() => searchInputRef.current?.focus(), 50);
    }
  }, [searchOpen]);

  // Keyboard shortcuts
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      const target = e.target as HTMLElement;
      const isInput = target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable;

      // Cmd+F to open search
      if ((e.metaKey || e.ctrlKey) && e.key === "f") {
        e.preventDefault();
        if (!searchOpen) {
          setSearchOpen(true);
        } else {
          searchInputRef.current?.select();
        }
        return;
      }

      // Escape to close search
      if (e.key === "Escape" && searchOpen) {
        closeSearch();
        return;
      }

      // Enter / Shift+Enter in search input to navigate matches
      if (searchOpen && isInput && target === searchInputRef.current) {
        if (e.key === "Enter") {
          e.preventDefault();
          navigateMatch(e.shiftKey ? -1 : 1);
          return;
        }
      }

      // U to toggle user-only filter
      if (!isInput && !searchOpen && e.key === "u") {
        e.preventDefault();
        setUserOnly((prev) => !prev);
        return;
      }

      // [ and ] for prev/next user message (only when not in an input)
      if (!isInput && !searchOpen) {
        if (e.key === "[") {
          e.preventDefault();
          jumpToUserMessage(-1);
          return;
        }
        if (e.key === "]") {
          e.preventDefault();
          jumpToUserMessage(1);
          return;
        }
      }
    }

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [searchOpen, closeSearch, navigateMatch, jumpToUserMessage]);

  function handleTagsChange(newTags: Tag[]) {
    if (!session) return;
    setSession({ ...session, tags: newTags });
  }

  // -- Grouping/turns over the loaded window (recomputed as it grows) --
  const grouped = useMemo(() => groupMessagesForRender(messages), [messages]);
  const turns = useMemo(() => buildTurns(grouped), [grouped]);
  const visibleTurns = useMemo(
    () => (userOnly ? turns.filter((t) => t.kind === "user") : turns),
    [turns, userOnly],
  );
  const visibleTurnsRef = useRef<TurnItem[]>([]);
  visibleTurnsRef.current = visibleTurns;

  // Precompute which "user" rows need the separating divider drawn INSIDE
  // their own virtual row (there's no separate flow sibling to put it in
  // once rows are absolutely positioned) — every user turn except the
  // first. Dividers are never shown in userOnly mode (matches prior
  // behavior), so this is only consulted when `visibleTurns === turns`.
  const dividerBeforeIndex = useMemo(() => {
    const set = new Set<number>();
    let seenFirstUser = false;
    turns.forEach((t, i) => {
      if (t.kind === "user") {
        if (seenFirstUser) set.add(i);
        seenFirstUser = true;
      }
    });
    return set;
  }, [turns]);

  const urlHighlightSeq = highlightMsg ? Number(highlightMsg) : null;
  const searchHighlightSeq = searchOpen && matchSequences.length > 0 ? matchSequences[currentMatchIndex] : null;
  const highlightSeq = searchHighlightSeq ?? urlHighlightSeq ?? NaN;

  // -- Virtualization (D11): window-scoped since the page itself scrolls
  // (sticky header, no fixed-height inner container). `scrollMargin` is the
  // list's offset from the top of the document — re-measured whenever
  // anything above it (header/search bar/panels) changes size. --
  const listContainerRef = useRef<HTMLDivElement>(null);
  const [scrollMargin, setScrollMargin] = useState(0);

  useLayoutEffect(() => {
    function measure() {
      const el = listContainerRef.current;
      if (!el) return;
      setScrollMargin(el.getBoundingClientRect().top + window.scrollY);
    }
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(document.body);
    window.addEventListener("resize", measure);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [session?.id]);

  const rowVirtualizer = useWindowVirtualizer({
    count: visibleTurns.length,
    estimateSize: () => 140,
    overscan: 10,
    gap: 10,
    scrollMargin,
    onChange: (instance) => {
      const items = instance.getVirtualItems();
      const last = items[items.length - 1];
      if (last && hasMore && !loadingMoreRef.current && last.index >= visibleTurns.length - LOAD_MORE_ROW_THRESHOLD) {
        void loadMorePage();
      }
    },
  });

  // Deep-link scroll (?msg=, prev/next nav, and the userOnly-bubble-click
  // re-navigation below all funnel through this): find the target
  // sequence's row and scroll to it. If it isn't loaded yet, load pages
  // (bounded by MAX_SEEK_PAGES) until it appears or the session's
  // exhausted — the U7 replacement for "everything's already in the DOM".
  useEffect(() => {
    if (loading || !session || !highlightMsg) return;
    const seq = Number(highlightMsg);
    if (Number.isNaN(seq)) return;
    let cancelled = false;

    (async () => {
      for (let attempts = 0; attempts <= MAX_SEEK_PAGES; attempts++) {
        if (cancelled) return;
        const idx = findTurnIndexForSequence(visibleTurnsRef.current, seq);
        if (idx !== -1) {
          rowVirtualizer.scrollToIndex(idx, { align: "center", behavior: "smooth" });
          return;
        }
        const result = await loadMorePage();
        if (result === "done" || result === "error") return;
      }
    })();

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, session, highlightMsg, loadMorePage]);

  // Jump-to-bottom (U7 fix): unlike Top, Bottom can't just scroll to the
  // document's current scrollHeight — that only reflects whatever page(s)
  // are loaded so far, so a naive scrollTo lands at the end of page 1 and
  // stops even as onChange above keeps appending pages behind it. Load
  // every remaining page first (same bounded loop as the deep-link seek
  // above), then scroll — and re-invoke scrollToIndex once more after a
  // frame, since react-virtual measures rows as they mount and the first
  // call can land on estimateSize (140px) positions before that settles.
  const jumpingToBottomRef = useRef(false);
  const jumpToBottom = useCallback(async () => {
    if (jumpingToBottomRef.current) return;
    jumpingToBottomRef.current = true;
    try {
      for (let attempts = 0; attempts <= MAX_SEEK_PAGES; ) {
        const result = await loadMorePage();
        if (result === "done" || result === "error") break;
        if (result === "already-loading") {
          await new Promise((r) => setTimeout(r, 50));
          continue;
        }
        attempts++;
      }
      const lastIndex = visibleTurnsRef.current.length - 1;
      if (lastIndex < 0) return;
      rowVirtualizer.scrollToIndex(lastIndex, { align: "end" });
      requestAnimationFrame(() => {
        rowVirtualizer.scrollToIndex(lastIndex, { align: "end" });
      });
    } finally {
      jumpingToBottomRef.current = false;
    }
  }, [loadMorePage, rowVirtualizer]);

  // Scroll to the current search match whenever it changes.
  useEffect(() => {
    if (!searchOpen || matchSequences.length === 0) return;
    const seq = matchSequences[currentMatchIndex];
    const idx = findTurnIndexForSequence(visibleTurns, seq);
    if (idx !== -1) rowVirtualizer.scrollToIndex(idx, { align: "center", behavior: "smooth" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchOpen, matchSequences, currentMatchIndex, visibleTurns]);

  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 p-15 text-text-secondary">
        <div className="spinner" />
        <span>Loading session...</span>
      </div>
    );
  }

  if (error || !session) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 p-15 text-text-secondary">
        <p>{error || "Session not found"}</p>
        <button className="inline-flex items-center gap-1.5 px-3 py-1.5 text-[13px] text-text-secondary rounded-md transition-all hover:text-text hover:bg-white/6" onClick={() => window.history.back()}>Go back</button>
      </div>
    );
  }

  const canGoPrev = userMessageSequences.length > 0 && (currentUserIdx === -1 || currentUserIdx > 0);
  const canGoNext = userMessageSequences.length > 0 && (currentUserIdx === -1 || currentUserIdx < userMessageSequences.length - 1);

  return (
    <ExpandStoreContext.Provider value={expandStoreRef.current}>
    <div className="max-w-[1400px] mx-auto px-10 pt-0 pb-20">
      <div className="sticky top-0 z-10 bg-bg pt-6 pb-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-1">
            <button className="inline-flex items-center gap-1.5 px-3 py-1.5 text-[13px] text-text-secondary rounded-md transition-all hover:text-text hover:bg-white/6" onClick={() => navigate({ to: "/workspace/$id", params: { id: String(session.workspace_id) } })}>
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                <path d="M10 12L6 8L10 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              Back to sessions
            </button>

            {/* Prev/Next user message buttons */}
            <div className="flex items-center gap-0.5 ml-2">
              <button
                className="inline-flex items-center gap-1 px-2 py-1 text-[11px] text-text-dim rounded transition-all hover:text-text hover:bg-white/6 disabled:opacity-30 disabled:cursor-default disabled:hover:bg-transparent disabled:hover:text-text-dim"
                onClick={() => jumpToUserMessage(-1)}
                disabled={!canGoPrev}
                title="Previous user message  ["
              >
                <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
                  <path d="M10 12L6 8L10 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
                Prev
              </button>
              <button
                className="inline-flex items-center gap-1 px-2 py-1 text-[11px] text-text-dim rounded transition-all hover:text-text hover:bg-white/6 disabled:opacity-30 disabled:cursor-default disabled:hover:bg-transparent disabled:hover:text-text-dim"
                onClick={() => jumpToUserMessage(1)}
                disabled={!canGoNext}
                title="Next user message  ]"
              >
                Next
                <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
                  <path d="M6 4L10 8L6 12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </button>
            </div>
          </div>

          <div className="flex items-center gap-1">
            {/* Trace view — drillable chunk/step/subagent view over the raw JSONL */}
            <button
              className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-[13px] text-text-secondary rounded-md transition-all hover:text-text hover:bg-white/6"
              onClick={() => navigate({ to: "/session/$id/trace", params: { id: session.id } })}
              title="Open drillable trace view (thinking, tool durations, context deltas, subagents)"
            >
              <svg width="15" height="15" viewBox="0 0 16 16" fill="none">
                <path d="M2 13V9M6 13V5M10 13V7M14 13V3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              Trace
            </button>
            {/* User-only filter toggle */}
            <button
              className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 text-[13px] rounded-md transition-all hover:text-text hover:bg-white/6 ${userOnly ? "text-accent-blue bg-accent-blue/10" : "text-text-secondary"}`}
              onClick={() => setUserOnly(!userOnly)}
              title="Show only your messages  U"
            >
              <svg width="15" height="15" viewBox="0 0 16 16" fill="none">
                <path d="M8 8a3 3 0 100-6 3 3 0 000 6zM2 14c0-2.21 2.69-4 6-4s6 1.79 6 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              {userOnly && <span className="text-[11px]">Mine</span>}
            </button>
            {/* Search toggle button */}
            <button
              className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 text-[13px] rounded-md transition-all hover:text-text hover:bg-white/6 ${searchOpen ? "text-accent-blue" : "text-text-secondary"}`}
              onClick={() => searchOpen ? closeSearch() : setSearchOpen(true)}
              title="Search in page  Cmd+F"
            >
              <svg width="15" height="15" viewBox="0 0 16 16" fill="none">
                <circle cx="7" cy="7" r="4.5" stroke="currentColor" strokeWidth="1.5" />
                <path d="M10.5 10.5L14 14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
              </svg>
            </button>
            <button
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-[13px] text-text-secondary rounded-md transition-all hover:text-text hover:bg-white/6"
              onClick={() => window.scrollTo({ top: 0, behavior: "smooth" })}
              title="Scroll to top"
            >
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                <path d="M8 12V4M4 8L8 4L12 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              Top
            </button>
            <button
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-[13px] text-text-secondary rounded-md transition-all hover:text-text hover:bg-white/6 disabled:opacity-50"
              onClick={() => void jumpToBottom()}
              disabled={loadingMore}
              title="Scroll to bottom (loads remaining pages first)"
            >
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                <path d="M8 4V12M4 8L8 12L12 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              Bottom
            </button>
          </div>
        </div>

        {/* Search bar (second row) */}
        {searchOpen && (
          <div className="flex items-center gap-2 mt-2 px-1">
            <div className="flex items-center flex-1 gap-2 bg-white/6 border border-border rounded-lg px-3 py-1.5">
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" className="shrink-0 text-text-dim">
                <circle cx="7" cy="7" r="4.5" stroke="currentColor" strokeWidth="1.5" />
                <path d="M10.5 10.5L14 14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
              </svg>
              <input
                ref={searchInputRef}
                type="text"
                className="flex-1 bg-transparent text-[13px] text-text outline-none placeholder:text-text-dim"
                placeholder="Search in conversation..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
              />
              {searchQuery && (
                <span className="text-[11px] text-text-dim font-mono whitespace-nowrap">
                  {matchSequences.length > 0 ? `${currentMatchIndex + 1} of ${matchSequences.length}` : "0 of 0"}
                </span>
              )}
            </div>
            <button
              className="p-1.5 text-text-dim rounded transition-all hover:text-text hover:bg-white/6 disabled:opacity-30"
              onClick={() => navigateMatch(-1)}
              disabled={matchSequences.length === 0}
              title="Previous match  Shift+Enter"
            >
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
                <path d="M12 10L8 6L4 10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
            <button
              className="p-1.5 text-text-dim rounded transition-all hover:text-text hover:bg-white/6 disabled:opacity-30"
              onClick={() => navigateMatch(1)}
              disabled={matchSequences.length === 0}
              title="Next match  Enter"
            >
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
                <path d="M4 6L8 10L12 6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
            <button
              className="p-1.5 text-text-dim rounded transition-all hover:text-text hover:bg-white/6"
              onClick={closeSearch}
              title="Close search  Esc"
            >
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
                <path d="M4 4L12 12M12 4L4 12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
              </svg>
            </button>
          </div>
        )}
      </div>
      <div className="border-b border-border pb-5 mb-6">
        <div className="mt-1">
          <SessionHeader
            session={session}
            onTagsChange={handleTagsChange}
            showTitle
          />
          <div className="flex items-center gap-2 mt-1 text-xs text-text-dim">
            <span>{session.message_count} messages</span>
            <span className="text-border">/</span>
            <span>{session.user_message_count} from you</span>
            <span className="text-border">/</span>
            <span>{session.workspace.display_name}</span>
          </div>
        </div>
      </div>

      <FilesPanel sessionId={session.id} />

      {/* Reflects messages loaded so far, not the full session total, once
          a session is longer than one page (U7: re-pointed at the loaded
          window — see notes). Fills in as you scroll. */}
      <ToolsUsedChips messages={messages} />

      <InsightsPanel sessionId={session.id} />

      <div ref={listContainerRef} className="snippet-bubbles-virtual" style={{ position: "relative", marginTop: 8 }}>
        <div style={{ position: "relative", width: "100%", height: rowVirtualizer.getTotalSize() }}>
          {rowVirtualizer.getVirtualItems().map((virtualItem) => {
            const turn = visibleTurns[virtualItem.index];
            if (!turn) return null;
            const showDivider = !userOnly && dividerBeforeIndex.has(virtualItem.index);

            let rowContent: React.ReactNode;
            if (turn.kind === "assistant") {
              const turnHighlight =
                !isNaN(highlightSeq) &&
                turn.items.some((g) =>
                  g.kind === "tools" ? g.allSequences.includes(highlightSeq) : g.msg.sequence === highlightSeq
                );
              rowContent = (
                <AssistantTurnBlock
                  turn={turn}
                  highlight={turnHighlight}
                  userOnly={userOnly}
                  highlightSeq={highlightSeq}
                  isLive={isLive}
                  sessionId={session.id}
                />
              );
            } else {
              const msg = (turn.item as { kind: "text"; msg: Message }).msg;
              const bubble = (
                <MessageBubble message={msg} highlight={!isNaN(highlightSeq) && highlightSeq === msg.sequence} />
              );
              rowContent = (
                <>
                  {showDivider && (
                    <div className="w-full my-4 flex items-center">
                      <div className="flex-1 h-px bg-border/40" />
                    </div>
                  )}
                  {userOnly ? (
                    <div
                      className="cursor-pointer transition-all hover:brightness-125"
                      onClick={() => {
                        // Return to the full (non-filtered) view AND deep-link
                        // to this message so the existing highlightMsg scroll
                        // effect (above) carries it into view — reuses that
                        // machinery instead of a separate transient-highlight
                        // path (U7: simpler than re-deriving it under
                        // virtualization, at the cost of a persistent rather
                        // than a 2s-flash highlight; see implementation notes).
                        setUserOnly(false);
                        navigate({
                          to: "/session/$id",
                          params: { id },
                          search: { msg: String(msg.sequence) },
                          replace: true,
                        });
                      }}
                    >
                      {bubble}
                    </div>
                  ) : (
                    bubble
                  )}
                </>
              );
            }

            return (
              <div
                key={virtualItem.key}
                data-index={virtualItem.index}
                ref={rowVirtualizer.measureElement}
                style={{
                  position: "absolute",
                  top: 0,
                  left: 0,
                  width: "100%",
                  transform: `translateY(${virtualItem.start - scrollMargin}px)`,
                }}
              >
                {rowContent}
              </div>
            );
          })}
        </div>

        {loadingMore && (
          <div className="flex items-center justify-center gap-2 py-4 text-xs text-text-dim">
            <div className="spinner w-3 h-3" />
            Loading more messages…
          </div>
        )}
        {loadMoreError && (
          <div className="flex items-center justify-center gap-2 py-4 text-xs text-[#f85149]">
            <span>{loadMoreError}</span>
            <button className="text-accent-blue hover:underline" onClick={() => void loadMorePage()}>
              Retry
            </button>
          </div>
        )}
      </div>
    </div>
    </ExpandStoreContext.Provider>
  );
}
