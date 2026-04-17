import React, { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { useParams, useNavigate, useSearch } from "@tanstack/react-router";
import type { SessionDetail as SessionDetailType, Message, Tag, FileReference } from "../types";
import { categorizeFileRefs } from "../fileCategories";
import { renderMarkdown } from "../sessionFormat";
import { INSIGHT_TYPE_COLORS } from "../insight-shared";
import { useExtraction } from "../hooks/useExtraction";
import SessionHeader from "./SessionHeader";
import { sessionRoute } from "../router";

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

function MessageBubble({ message, highlight }: { message: Message; highlight?: boolean }) {
  const isToolResult = message.role === "user" && message.message_type === "tool_result";
  const isToolUse = message.message_type === "tool_use";
  const isSystem = message.message_type === "system";
  const isUser = message.role === "user" && !isToolResult && !isSystem;

  // System message (skill loaded, system context)
  if (isSystem) {
    return (
      <details
        id={`msg-${message.sequence}`}
        className={`system-msg ${highlight ? "message-highlight" : ""}`}
      >
        <summary>
          <svg width="14" height="14" viewBox="0 0 16 16" fill="#bc8cff"><path d="M8.5 1.5a1 1 0 00-1 0L2.1 4.75a1 1 0 000 1.73l5.4 3.25a1 1 0 001 0l5.4-3.25a1 1 0 000-1.73zM2.1 9.52l5.4 3.25a1 1 0 001 0l5.4-3.25" stroke="#bc8cff" strokeWidth="1" fill="none"/></svg>
          {message.content.replace(/^\[|\]$/g, '')}
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
      <div
        className="message-content"
        dangerouslySetInnerHTML={{ __html: renderMarkdown(message.content) }}
      />
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

function ToolResultInline({ result }: { result: Message }) {
  const isError = /error|failed|Error:/i.test(result.content.slice(0, 80));
  return (
    <details className={`tool-result-inline ${isError ? "tool-result-err" : "tool-result-ok"}`}>
      <summary>{isError ? "⚠ Error" : "Result"}</summary>
      <pre>{truncate(result.content, 1500)}</pre>
    </details>
  );
}

function ToolCallBlock({ use, result }: { use: Message; result: Message | null }) {
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
        {result && <ToolResultInline result={result} />}
      </div>
    );
  }

  if (name === "Edit" || name === "MultiEdit") {
    const fp = String(input.file_path ?? "");
    const oldStr = String(input.old_string ?? "");
    const newStr = String(input.new_string ?? "");
    return (
      <div id={`msg-${use.sequence}`} className="tool-mini tool-mini-edit">
        {header(name, "bg-[#f4a261]/20 text-[#f4a261]", fp && <span className="tool-mini-path" title={fp}>{fp}</span>)}
        {(oldStr || newStr) && (
          <div className="tool-mini-diff">
            <pre className="diff-old">{truncate(oldStr, 500)}</pre>
            <pre className="diff-new">{truncate(newStr, 500)}</pre>
          </div>
        )}
        {result && <ToolResultInline result={result} />}
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
        {result && <ToolResultInline result={result} />}
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
          {result && <ToolResultInline result={result} />}
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
        {result && <ToolResultInline result={result} />}
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
        {result && isError && <ToolResultInline result={result} />}
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
      {result && <ToolResultInline result={result} />}
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
}: {
  group: Extract<GroupedItem, { kind: "tools" }>;
  highlight: boolean;
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
        <span className="tool-group-label">Working</span>
        <span className="tool-group-desc">{summary}</span>
        {time && <span className="tool-group-time">{time}</span>}
      </summary>
      <div className="tool-group-body">
        {group.items.map((it, idx) => (
          <ToolCallBlock key={it.use.id ?? idx} use={it.use} result={it.result} />
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

export default function SessionDetail() {
  const { id } = useParams({ from: sessionRoute.id });
  const navigate = useNavigate();
  const { msg: highlightMsg } = useSearch({ from: sessionRoute.id });
  const [session, setSession] = useState<SessionDetailType | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // -- User-only filter mode --
  const [userOnly, setUserOnly] = useState(false);
  const [anchorSequence, setAnchorSequence] = useState<number | null>(null);

  // When userOnly turns off with an anchor, scroll to that message after render
  useEffect(() => {
    if (!userOnly && anchorSequence !== null) {
      // Wait for React to render all messages back into DOM
      requestAnimationFrame(() => {
        const el = document.getElementById(`msg-${anchorSequence}`);
        if (el) {
          el.scrollIntoView({ block: "center" });
          el.classList.add("message-highlight");
          setTimeout(() => el.classList.remove("message-highlight"), 2000);
        }
        setAnchorSequence(null);
      });
    }
  }, [userOnly, anchorSequence]);

  // -- In-page search state --
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [matches, setMatches] = useState<Element[]>([]);
  const [currentMatchIndex, setCurrentMatchIndex] = useState(0);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    setLoading(true);
    setError(null);
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
        })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [id]);

  // Scroll to highlighted message after load
  useEffect(() => {
    if (!loading && session && highlightMsg) {
      const el = document.getElementById(`msg-${highlightMsg}`);
      if (el) {
        setTimeout(() => {
          el.scrollIntoView({ behavior: "smooth", block: "center" });
        }, 100);
      }
    }
  }, [loading, session, highlightMsg]);

  // -- Feature 1: Prev/Next user message navigation --
  const userMessageSequences = useMemo(() => {
    if (!session) return [];
    return session.messages
      .filter((m) => m.role === "user" && m.message_type !== "tool_result")
      .map((m) => String(m.sequence));
  }, [session]);

  const currentUserIdx = useMemo(() => {
    if (!highlightMsg) return -1;
    return userMessageSequences.indexOf(highlightMsg);
  }, [highlightMsg, userMessageSequences]);

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

  // -- Feature 2: In-page text search helpers --
  const clearHighlights = useCallback(() => {
    const container = document.querySelector(".snippet-bubbles");
    if (!container) return;
    const marks = container.querySelectorAll("mark.page-search-match, mark.page-search-current");
    marks.forEach((mark) => {
      const parent = mark.parentNode;
      if (parent) {
        parent.replaceChild(document.createTextNode(mark.textContent || ""), mark);
        parent.normalize();
      }
    });
  }, []);

  const performSearch = useCallback(
    (query: string) => {
      clearHighlights();
      if (!query) {
        setMatches([]);
        setCurrentMatchIndex(0);
        return;
      }

      const container = document.querySelector(".snippet-bubbles");
      if (!container) return;

      const lowerQuery = query.toLowerCase();
      const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, null);
      const newMatches: Element[] = [];
      let matchCount = 0;

      // Collect text nodes with matches
      const textNodes: Text[] = [];
      let node: Node | null;
      while ((node = walker.nextNode())) {
        const text = node.textContent || "";
        if (text.toLowerCase().includes(lowerQuery)) {
          textNodes.push(node as Text);
        }
      }

      // Process each text node (splitting and wrapping matches)
      for (const textNode of textNodes) {
        const text = textNode.textContent || "";
        const parent = textNode.parentNode;
        if (!parent) continue;

        const fragment = document.createDocumentFragment();
        let lastIdx = 0;
        const lowerText = text.toLowerCase();
        let searchIdx = lowerText.indexOf(lowerQuery, 0);

        while (searchIdx !== -1) {
          // Text before match
          if (searchIdx > lastIdx) {
            fragment.appendChild(document.createTextNode(text.slice(lastIdx, searchIdx)));
          }
          // Wrap match
          const mark = document.createElement("mark");
          mark.className = "page-search-match";
          mark.dataset.matchIndex = String(matchCount);
          mark.textContent = text.slice(searchIdx, searchIdx + query.length);
          fragment.appendChild(mark);
          newMatches.push(mark);
          matchCount++;
          lastIdx = searchIdx + query.length;
          searchIdx = lowerText.indexOf(lowerQuery, lastIdx);
        }

        // Remaining text
        if (lastIdx < text.length) {
          fragment.appendChild(document.createTextNode(text.slice(lastIdx)));
        }

        parent.replaceChild(fragment, textNode);
      }

      setMatches(newMatches);
      setCurrentMatchIndex(0);

      // Highlight first match
      if (newMatches.length > 0) {
        newMatches[0].className = "page-search-current";
        newMatches[0].scrollIntoView({ behavior: "smooth", block: "center" });
      }
    },
    [clearHighlights],
  );

  const navigateMatch = useCallback(
    (direction: 1 | -1) => {
      if (matches.length === 0) return;
      // Reset current
      if (matches[currentMatchIndex]) {
        matches[currentMatchIndex].className = "page-search-match";
      }
      const next = (currentMatchIndex + direction + matches.length) % matches.length;
      setCurrentMatchIndex(next);
      if (matches[next]) {
        matches[next].className = "page-search-current";
        matches[next].scrollIntoView({ behavior: "smooth", block: "center" });
      }
    },
    [matches, currentMatchIndex],
  );

  const closeSearch = useCallback(() => {
    setSearchOpen(false);
    setSearchQuery("");
    clearHighlights();
    setMatches([]);
    setCurrentMatchIndex(0);
  }, [clearHighlights]);

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
        setAnchorSequence(null);
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
    <div className="max-w-[860px] px-10 pt-0 pb-20">
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
            {/* User-only filter toggle */}
            <button
              className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 text-[13px] rounded-md transition-all hover:text-text hover:bg-white/6 ${userOnly ? "text-accent-blue bg-accent-blue/10" : "text-text-secondary"}`}
              onClick={() => { setUserOnly(!userOnly); setAnchorSequence(null); }}
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
              onClick={() => {
                const main = document.querySelector("main");
                if (main) main.scrollTo({ top: 0, behavior: "smooth" });
              }}
              title="Scroll to top"
            >
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                <path d="M8 12V4M4 8L8 4L12 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              Top
            </button>
            <button
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-[13px] text-text-secondary rounded-md transition-all hover:text-text hover:bg-white/6"
              onClick={() => {
                const main = document.querySelector("main");
                if (main) main.scrollTo({ top: main.scrollHeight, behavior: "smooth" });
              }}
              title="Scroll to bottom"
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
                  {matches.length > 0 ? `${currentMatchIndex + 1} of ${matches.length}` : "0 of 0"}
                </span>
              )}
            </div>
            <button
              className="p-1.5 text-text-dim rounded transition-all hover:text-text hover:bg-white/6 disabled:opacity-30"
              onClick={() => navigateMatch(-1)}
              disabled={matches.length === 0}
              title="Previous match  Shift+Enter"
            >
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
                <path d="M12 10L8 6L4 10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
            <button
              className="p-1.5 text-text-dim rounded transition-all hover:text-text hover:bg-white/6 disabled:opacity-30"
              onClick={() => navigateMatch(1)}
              disabled={matches.length === 0}
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

      <ToolsUsedChips messages={session.messages} />

      <InsightsPanel sessionId={session.id} />

      <div className="snippet-bubbles" style={{ gap: 10 }}>
        {(() => {
          const grouped = groupMessagesForRender(session.messages);
          const highlightSeq = highlightMsg ? Number(highlightMsg) : NaN;
          let hasEmittedFirstUser = false;

          return grouped.map((item, idx) => {
            if (item.kind === "tools") {
              if (userOnly) return null;
              const groupHighlight = !isNaN(highlightSeq) && item.allSequences.includes(highlightSeq);
              return <ToolGroupBlock key={`g-${idx}`} group={item} highlight={groupHighlight} />;
            }

            const msg = item.msg;
            const isUserText =
              msg.role === "user" &&
              msg.message_type !== "tool_result" &&
              msg.message_type !== "system";
            const isNewUserTurn = isUserText && hasEmittedFirstUser;
            if (isUserText) hasEmittedFirstUser = true;

            if (userOnly && !isUserText) return null;

            return (
              <React.Fragment key={msg.id}>
                {!userOnly && isNewUserTurn && (
                  <div className="w-full my-4 flex items-center">
                    <div className="flex-1 h-px bg-border/40" />
                  </div>
                )}
                {userOnly && isUserText ? (
                  <div
                    className="cursor-pointer transition-all hover:brightness-125"
                    onClick={() => {
                      setAnchorSequence(msg.sequence);
                      setUserOnly(false);
                    }}
                  >
                    <MessageBubble
                      message={msg}
                      highlight={highlightMsg === String(msg.sequence)}
                    />
                  </div>
                ) : (
                  <MessageBubble
                    message={msg}
                    highlight={highlightMsg === String(msg.sequence)}
                  />
                )}
              </React.Fragment>
            );
          });
        })()}
      </div>
    </div>
  );
}
