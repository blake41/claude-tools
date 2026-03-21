import React, { useState, useEffect } from "react";
import { useParams, useNavigate, useSearchParams } from "react-router-dom";
import type { SessionDetail as SessionDetailType, Message, Tag, FileReference } from "../types";
import { categorizeFileRefs } from "../fileCategories";
import { renderMarkdown } from "../sessionFormat";
import SessionHeader from "./SessionHeader";

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
  const isUser = message.role === "user" && !isToolResult;

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

export default function SessionDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const highlightMsg = searchParams.get("msg");
  const [session, setSession] = useState<SessionDetailType | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

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
        <button className="inline-flex items-center gap-1.5 px-3 py-1.5 text-[13px] text-text-secondary rounded-md transition-all hover:text-text hover:bg-white/6" onClick={() => navigate(-1)}>Go back</button>
      </div>
    );
  }

  return (
    <div className="max-w-[860px] px-10 pt-0 pb-20">
      <div className="sticky top-0 z-10 bg-bg pt-6 pb-3">
        <button className="inline-flex items-center gap-1.5 px-3 py-1.5 text-[13px] text-text-secondary rounded-md transition-all hover:text-text hover:bg-white/6" onClick={() => navigate(`/workspace/${session.workspace_id}`)}>
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
            <path d="M10 12L6 8L10 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          Back to sessions
        </button>
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

      <div className="snippet-bubbles" style={{ gap: 10 }}>
        {session.messages.map((msg, i) => {
          const prev = i > 0 ? session.messages[i - 1] : null;
          const isNewUserTurn = msg.role === "user" && msg.message_type !== "tool_result" && prev;
          return (
            <React.Fragment key={msg.id}>
              {isNewUserTurn && (
                <div className="w-full my-4 flex items-center">
                  <div className="flex-1 h-px bg-border/40" />
                </div>
              )}
              <MessageBubble
                message={msg}
                highlight={highlightMsg === String(msg.sequence)}
              />
            </React.Fragment>
          );
        })}
      </div>
    </div>
  );
}
