import { useState, useEffect, useRef } from "react";
import { useParams, useNavigate, useSearchParams } from "react-router-dom";
import type { SessionDetail as SessionDetailType, Message, Tag, FileReference } from "../types";
import { categorizeFileRefs } from "../fileCategories";

function formatDate(dateStr: string): string {
  return new Date(dateStr).toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  });
}

function formatTime(dateStr: string | null): string {
  if (!dateStr) return "";
  return new Date(dateStr).toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
}

function duration(start: string, end: string | null): string {
  if (!end) return "Ongoing";
  const ms = new Date(end).getTime() - new Date(start).getTime();
  const mins = Math.round(ms / 60000);
  if (mins < 60) return `${mins} minutes`;
  const hrs = Math.floor(mins / 60);
  const rem = mins % 60;
  return rem > 0 ? `${hrs}h ${rem}m` : `${hrs} hours`;
}

import { parseSummaryBullets } from "../summaryUtils";

function renderMarkdown(text: string): string {
  let html = escapeHtml(text);

  // Code blocks (``` ... ```)
  html = html.replace(/```(\w*)\n([\s\S]*?)```/g, (_match, lang, code) => {
    const langLabel = lang ? `<span class="code-lang">${lang}</span>` : "";
    return `<div class="code-block">${langLabel}<pre><code>${code.trimEnd()}</code></pre></div>`;
  });

  // Inline code
  html = html.replace(/`([^`\n]+)`/g, "<code class=\"inline-code\">$1</code>");

  // Headers
  html = html.replace(/^#### (.+)$/gm, "<h4>$1</h4>");
  html = html.replace(/^### (.+)$/gm, "<h3>$1</h3>");
  html = html.replace(/^## (.+)$/gm, "<h2>$1</h2>");
  html = html.replace(/^# (.+)$/gm, "<h1>$1</h1>");

  // Bold and italic
  html = html.replace(/\*\*\*(.+?)\*\*\*/g, "<strong><em>$1</em></strong>");
  html = html.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  html = html.replace(/\*(.+?)\*/g, "<em>$1</em>");

  // Unordered lists
  html = html.replace(/^(\s*)[-*] (.+)$/gm, "$1<li>$2</li>");
  // Wrap consecutive <li> in <ul>
  html = html.replace(/((?:<li>.*<\/li>\n?)+)/g, "<ul>$1</ul>");

  // Ordered lists
  html = html.replace(/^\d+\. (.+)$/gm, "<li>$1</li>");

  // Horizontal rules
  html = html.replace(/^---+$/gm, "<hr />");

  // Links
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');

  // Paragraphs - convert double newlines
  html = html.replace(/\n\n/g, "</p><p>");
  // Single newlines within paragraphs
  html = html.replace(/\n/g, "<br />");

  return html;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function MessageBubble({ message, highlight }: { message: Message; highlight?: boolean }) {
  const isUser = message.role === "user";

  return (
    <div
      id={`msg-${message.sequence}`}
      className={`relative ${highlight ? "message-highlight" : ""}`}
    >
      <div className={`${isUser ? "pr-12" : "pl-10"}`}>
        <div className="flex items-center gap-2.5 mb-1">
          {isUser ? (
            <span className="text-[13px] font-bold uppercase tracking-[0.12em] text-accent-blue">You</span>
          ) : (
            <span className="text-[11px] font-medium uppercase tracking-[0.08em] text-text-dim">Claude</span>
          )}
          {message.timestamp && (
            <span className="font-mono text-[10px] text-text-dim/60">{formatTime(message.timestamp)}</span>
          )}
        </div>
        <div
          className={`message-content text-[13.5px] leading-[1.75] break-words ${isUser ? "text-text" : "text-claude-text"}`}
          dangerouslySetInnerHTML={{ __html: renderMarkdown(message.content) }}
        />
      </div>
    </div>
  );
}

const PRESET_COLORS = [
  "#58a6ff", "#3fb950", "#bc8cff", "#d29922",
  "#f85149", "#79c0ff", "#d2a8ff", "#56d364",
];

function TagSection({ sessionId, initialTags }: { sessionId: string; initialTags: Tag[] }) {
  const [tags, setTags] = useState<Tag[]>(initialTags);
  const [allTags, setAllTags] = useState<Tag[]>([]);
  const [showDropdown, setShowDropdown] = useState(false);
  const [filter, setFilter] = useState("");
  const [newTagName, setNewTagName] = useState("");
  const [newTagColor, setNewTagColor] = useState(PRESET_COLORS[0]);
  const [showCreate, setShowCreate] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (showDropdown) {
      fetch("/api/tags").then((r) => r.json()).then(setAllTags).catch(() => {});
    }
  }, [showDropdown]);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setShowDropdown(false);
        setShowCreate(false);
        setFilter("");
      }
    }
    if (showDropdown) {
      document.addEventListener("mousedown", handleClickOutside);
      return () => document.removeEventListener("mousedown", handleClickOutside);
    }
  }, [showDropdown]);

  function addTag(tagId: number) {
    fetch(`/api/sessions/${sessionId}/tags`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tag_id: tagId }),
    })
      .then((r) => r.json())
      .then((tag) => {
        setTags((prev) => prev.some((t) => t.id === tag.id) ? prev : [...prev, tag]);
        setShowDropdown(false);
        setFilter("");
      })
      .catch(() => {});
  }

  function removeTag(tagId: number) {
    fetch(`/api/sessions/${sessionId}/tags/${tagId}`, { method: "DELETE" })
      .then(() => setTags((prev) => prev.filter((t) => t.id !== tagId)))
      .catch(() => {});
  }

  function createAndAdd(e: React.FormEvent) {
    e.preventDefault();
    if (!newTagName.trim()) return;
    fetch(`/api/sessions/${sessionId}/tags`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: newTagName.trim(), color: newTagColor }),
    })
      .then((r) => r.json())
      .then((tag) => {
        setTags((prev) => prev.some((t) => t.id === tag.id) ? prev : [...prev, tag]);
        setNewTagName("");
        setNewTagColor(PRESET_COLORS[0]);
        setShowCreate(false);
        setShowDropdown(false);
      })
      .catch(() => {});
  }

  const existingIds = new Set(tags.map((t) => t.id));
  const available = allTags
    .filter((t) => !existingIds.has(t.id))
    .filter((t) => !filter || t.name.toLowerCase().includes(filter.toLowerCase()));

  return (
    <div className="flex items-center flex-wrap gap-1.5 mt-2.5">
      {tags.map((tag) => (
        <span
          key={tag.id}
          className="inline-flex items-center gap-1 px-2 py-px rounded-full text-[11px] font-medium whitespace-nowrap"
          style={{ background: `${tag.color}26`, color: tag.color }}
        >
          {tag.name}
          <button
            className="text-[13px] leading-none opacity-60 pl-0.5 text-inherit hover:opacity-100"
            onClick={() => removeTag(tag.id)}
            title="Remove tag"
          >
            {"\u00d7"}
          </button>
        </span>
      ))}
      <div className="relative" ref={dropdownRef}>
        <button
          className="w-[22px] h-[22px] flex items-center justify-center rounded-full text-sm text-text-dim border border-dashed border-border transition-all hover:text-text hover:border-text-secondary"
          onClick={() => setShowDropdown(!showDropdown)}
          title="Add tag"
        >
          +
        </button>
        {showDropdown && (
          <div className="absolute top-full left-0 mt-1.5 w-[220px] bg-bg-card border border-border rounded-lg shadow-[0_8px_24px_rgba(0,0,0,0.4)] z-50 overflow-hidden">
            <input
              className="w-full px-2.5 py-2 bg-transparent border-none border-b border-border outline-none text-xs text-text font-[var(--font-ui)]"
              style={{ borderBottom: '1px solid var(--color-border)' }}
              type="text"
              placeholder="Search tags..."
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              autoFocus
            />
            <div className="max-h-[160px] overflow-y-auto p-1">
              {available.map((tag) => (
                <button
                  key={tag.id}
                  className="flex items-center gap-2 w-full px-2 py-1.5 rounded text-xs text-text text-left transition-[background] duration-100 hover:bg-white/6"
                  onClick={() => addTag(tag.id)}
                >
                  <span className="inline-block w-2 h-2 rounded-full shrink-0" style={{ background: tag.color }} />
                  {tag.name}
                </button>
              ))}
              {available.length === 0 && !showCreate && (
                <div className="p-2 text-[11px] text-text-dim text-center">
                  {filter ? "No matching tags" : "No more tags available"}
                </div>
              )}
            </div>
            {!showCreate ? (
              <button
                className="block w-full px-2.5 py-2 text-xs text-accent-blue text-left border-t border-border transition-[background] duration-100 hover:bg-accent-blue/8"
                onClick={() => { setShowCreate(true); setNewTagName(filter); }}
              >
                + Create new tag{filter ? `: "${filter}"` : ""}
              </button>
            ) : (
              <form className="p-2 border-t border-border flex flex-col gap-1.5" onSubmit={createAndAdd}>
                <input
                  type="text"
                  className="w-full px-2 py-1.5 bg-white/6 border border-border rounded outline-none text-xs text-text font-[var(--font-ui)] focus:border-accent-blue"
                  placeholder="Tag name..."
                  value={newTagName}
                  onChange={(e) => setNewTagName(e.target.value)}
                  autoFocus
                />
                <div className="flex gap-1 flex-wrap">
                  {PRESET_COLORS.map((c) => (
                    <button
                      key={c}
                      type="button"
                      className={`w-[18px] h-[18px] rounded-full border-2 transition-[border-color] duration-100 hover:border-text-secondary ${c === newTagColor ? "border-text" : "border-transparent"}`}
                      style={{ background: c }}
                      onClick={() => setNewTagColor(c)}
                    />
                  ))}
                </div>
                <button type="submit" className="px-2.5 py-1 bg-accent-blue text-white rounded text-[11px] font-medium transition-opacity hover:opacity-85 self-start">Create & Add</button>
              </form>
            )}
          </div>
        )}
      </div>
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
          <h1 className="text-xl font-semibold tracking-tight">{session.title || "Untitled Session"}</h1>
          <div className="flex items-center flex-wrap gap-3 mt-2 text-[13px] text-text-secondary">
            <span>{formatDate(session.started_at)}</span>
            <span>
              {formatTime(session.started_at)}
              {session.ended_at && ` - ${formatTime(session.ended_at)}`}
            </span>
            <span>{duration(session.started_at, session.ended_at)}</span>
            {session.git_branch && (
              <span className="inline-block px-2 py-px rounded-full font-mono text-[11px] bg-accent-purple/12 text-accent-purple whitespace-nowrap overflow-hidden text-ellipsis max-w-[200px]">{session.git_branch}</span>
            )}
          </div>
          <div className="flex items-center gap-2 mt-1 text-xs text-text-dim">
            <span>{session.message_count} messages</span>
            <span className="text-border">/</span>
            <span>{session.user_message_count} from you</span>
            <span className="text-border">/</span>
            <span>{session.workspace.display_name}</span>
          </div>
          <button
            className="group/sid flex items-center gap-1 mt-1 font-mono text-[11px] text-text-dim transition-colors hover:text-text-secondary"
            onClick={() => navigator.clipboard.writeText(session.id)}
            title="Copy session ID"
          >
            <span>{session.id}</span>
            <svg className="opacity-0 group-hover/sid:opacity-100 transition-opacity" width="12" height="12" viewBox="0 0 16 16" fill="none">
              <rect x="5" y="5" width="9" height="9" rx="1.5" stroke="currentColor" strokeWidth="1.2" />
              <path d="M3 11V3.5A1.5 1.5 0 014.5 2H10" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
            </svg>
          </button>
          <TagSection sessionId={session.id} initialTags={session.tags || []} />
          {session.summary && (
            <ul className="mt-3 text-[13px] leading-[1.6] text-text-primary pl-4 list-disc space-y-0.5">
              {parseSummaryBullets(session.summary).map((line, i) => (
                <li key={i}>{line}</li>
              ))}
            </ul>
          )}
        </div>
      </div>

      <FilesPanel sessionId={session.id} />

      <div className="flex flex-col">
        {session.messages.map((msg, i) => {
          const prev = i > 0 ? session.messages[i - 1] : null;
          const isNewTurn = prev && prev.role !== msg.role;
          const isNewUserTurn = msg.role === "user" && prev;
          return (
            <div key={msg.id}>
              {isNewUserTurn && (
                <div className="my-7 flex items-center gap-4">
                  <div className="flex-1 h-px bg-border/40" />
                </div>
              )}
              {isNewTurn && !isNewUserTurn && <div className="mt-5" />}
              {!isNewTurn && i > 0 && <div className="mt-3" />}
              <MessageBubble
                message={msg}
                highlight={highlightMsg === String(msg.sequence)}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}
