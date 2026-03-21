import { useState, useRef, useEffect } from "react";
import { useNavigate, Link } from "react-router-dom";
import type { SessionSummary, Tag, ChangedFile } from "../types";
import { categorizeFileRefs } from "../fileCategories";

const PRESET_COLORS = [
  "#58a6ff", "#3fb950", "#bc8cff", "#d29922",
  "#f85149", "#79c0ff", "#d2a8ff", "#56d364",
];

function basename(path: string): string {
  return path.split("/").pop() || path;
}

/** Parse summary into clean bullet points, stripping markdown noise */
const MAX_BULLETS = 4;

function parseSummaryBullets(raw: string): string[] {
  return raw
    .split('\n')
    .map(l => l.trim())
    // Drop markdown headings, table separators, empty lines, bold-only lines
    .filter(l => l && !l.match(/^#{1,4}\s/) && !l.match(/^\|?[-:|\s]+\|?$/) && !l.match(/^\*\*.*\*\*:?\s*$/))
    // Collapse table rows
    .map(l => l.startsWith('|') ? l.replace(/^\||\|$/g, '').split('|').map(c => c.trim()).filter(Boolean).join(' — ') : l)
    // Strip bullet markers and bold
    .map(l => l.replace(/^[-•*]\s*/, '').replace(/\*\*/g, ''))
    .filter(l => l.length > 0)
    .slice(0, MAX_BULLETS);
}

function formatTime(dateStr: string): string {
  return new Date(dateStr).toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
}

function formatDate(dateStr: string): string {
  return new Date(dateStr).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function duration(start: string, end: string | null): string {
  if (!end) return "";
  const ms = new Date(end).getTime() - new Date(start).getTime();
  const mins = Math.round(ms / 60000);
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  const rem = mins % 60;
  return rem > 0 ? `${hrs}h ${rem}m` : `${hrs}h`;
}

// ── Inline Tag Adder ────────────────────────────────────────────────

function InlineTagAdder({ sessionId, tags, onTagsChange }: {
  sessionId: string;
  tags: Tag[];
  onTagsChange: (tags: Tag[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const [allTags, setAllTags] = useState<Tag[]>([]);
  const [filter, setFilter] = useState("");
  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState("");
  const [newColor, setNewColor] = useState(PRESET_COLORS[0]);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open) {
      fetch("/api/tags").then(r => r.json()).then(setAllTags).catch(() => {});
    }
  }, [open]);

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
        setShowCreate(false);
        setFilter("");
      }
    }
    if (open) {
      document.addEventListener("mousedown", handleClick);
      return () => document.removeEventListener("mousedown", handleClick);
    }
  }, [open]);

  function addTag(tagId: number) {
    fetch(`/api/sessions/${sessionId}/tags`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tag_id: tagId }),
    })
      .then(r => r.json())
      .then(tag => {
        onTagsChange(tags.some(t => t.id === tag.id) ? tags : [...tags, tag]);
        setOpen(false);
        setFilter("");
      }).catch(() => {});
  }

  function removeTag(e: React.MouseEvent, tagId: number) {
    e.stopPropagation();
    fetch(`/api/sessions/${sessionId}/tags/${tagId}`, { method: "DELETE" })
      .then(() => onTagsChange(tags.filter(t => t.id !== tagId)))
      .catch(() => {});
  }

  function createAndAdd(e: React.FormEvent) {
    e.preventDefault();
    if (!newName.trim()) return;
    fetch(`/api/sessions/${sessionId}/tags`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: newName.trim(), color: newColor }),
    })
      .then(r => r.json())
      .then(tag => {
        onTagsChange(tags.some(t => t.id === tag.id) ? tags : [...tags, tag]);
        setNewName("");
        setShowCreate(false);
        setOpen(false);
      }).catch(() => {});
  }

  const existingIds = new Set(tags.map(t => t.id));
  const available = allTags
    .filter(t => !existingIds.has(t.id))
    .filter(t => !filter || t.name.toLowerCase().includes(filter.toLowerCase()));

  return (
    <div className="flex items-center flex-wrap gap-1" onClick={e => e.stopPropagation()}>
      {tags.map(tag => (
        <span
          key={tag.id}
          className="inline-flex items-center gap-0.5 px-1.5 py-px rounded-full text-[10px] font-medium whitespace-nowrap"
          style={{ background: `${tag.color}26`, color: tag.color }}
        >
          <Link
            to={`/tag/${encodeURIComponent(tag.name)}`}
            className="no-underline hover:underline"
            style={{ color: "inherit" }}
            onClick={e => e.stopPropagation()}
          >{tag.name}</Link>
          <button
            className="text-[11px] leading-none opacity-60 hover:opacity-100"
            onClick={e => removeTag(e, tag.id)}
          >{"\u00d7"}</button>
        </span>
      ))}
      <div className="relative" ref={ref}>
        <button
          className="w-[18px] h-[18px] flex items-center justify-center rounded-full text-[11px] text-text-dim border border-dashed border-border/60 transition-all hover:text-text hover:border-text-secondary"
          onClick={e => { e.stopPropagation(); setOpen(!open); }}
        >+</button>
        {open && (
          <div className="absolute top-full left-0 mt-1 w-[200px] bg-bg-card border border-border rounded-lg shadow-[0_8px_24px_rgba(0,0,0,0.4)] z-50 overflow-hidden">
            <input
              className="w-full px-2.5 py-1.5 bg-transparent border-b border-border outline-none text-xs text-text"
              type="text"
              placeholder="Search tags..."
              value={filter}
              onChange={e => setFilter(e.target.value)}
              autoFocus
            />
            <div className="max-h-[140px] overflow-y-auto p-1">
              {available.map(tag => (
                <button
                  key={tag.id}
                  className="flex items-center gap-2 w-full px-2 py-1.5 rounded text-xs text-text text-left hover:bg-white/6"
                  onClick={() => addTag(tag.id)}
                >
                  <span className="w-2 h-2 rounded-full shrink-0" style={{ background: tag.color }} />
                  {tag.name}
                </button>
              ))}
              {available.length === 0 && !showCreate && (
                <div className="p-2 text-[11px] text-text-dim text-center">
                  {filter ? "No matching tags" : "No more tags"}
                </div>
              )}
            </div>
            {!showCreate ? (
              <button
                className="block w-full px-2.5 py-1.5 text-xs text-accent-blue text-left border-t border-border hover:bg-accent-blue/8"
                onClick={() => { setShowCreate(true); setNewName(filter); }}
              >+ Create{filter ? `: "${filter}"` : " new tag"}</button>
            ) : (
              <form className="p-2 border-t border-border flex flex-col gap-1.5" onSubmit={createAndAdd}>
                <input
                  type="text"
                  className="w-full px-2 py-1 bg-white/6 border border-border rounded outline-none text-xs text-text focus:border-accent-blue"
                  placeholder="Tag name..."
                  value={newName}
                  onChange={e => setNewName(e.target.value)}
                  autoFocus
                />
                <div className="flex gap-1 flex-wrap">
                  {PRESET_COLORS.map(c => (
                    <button
                      key={c}
                      type="button"
                      className={`w-4 h-4 rounded-full border-2 ${c === newColor ? "border-text" : "border-transparent"}`}
                      style={{ background: c }}
                      onClick={() => setNewColor(c)}
                    />
                  ))}
                </div>
                <button type="submit" className="px-2 py-0.5 bg-accent-blue text-white rounded text-[11px] font-medium self-start">Create</button>
              </form>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ── File Category Panel ─────────────────────────────────────────────

const MAX_FILES_PER_CAT = 5;

function FileCategoryPills({ files }: { files: ChangedFile[] }) {
  if (!files || files.length === 0) return null;
  const cats = categorizeFileRefs(files);
  const sections: Array<{ label: string; cls: string; files: ChangedFile[] }> = [];
  if (cats.docs.length > 0) sections.push({ label: "docs", cls: "docs", files: cats.docs });
  if (cats.viz.length > 0) sections.push({ label: "viz", cls: "viz", files: cats.viz });
  if (cats.code.length > 0) sections.push({ label: "code", cls: "code", files: cats.code });
  if (sections.length === 0) return null;

  return (
    <div className="flex flex-col gap-2.5">
      {sections.map(({ label, cls, files: catFiles }) => {
        const visible = catFiles.slice(0, MAX_FILES_PER_CAT);
        const overflow = catFiles.length - visible.length;
        return (
          <div key={label}>
            <div className={`file-cat-${cls} inline-block px-1.5 py-px rounded text-[9px] font-bold uppercase tracking-[0.08em] mb-1.5`}>
              {label}
            </div>
            <div className="flex flex-col gap-px">
              {visible.map((f) => (
                <a
                  key={f.file_path}
                  className="flex items-center gap-1.5 py-px group/file cursor-pointer no-underline"
                  href={cls === "viz" ? undefined : `vscode://file${f.file_path}`}
                  onClick={cls === "viz" ? (e) => {
                    e.stopPropagation();
                    fetch("/api/open-file", {
                      method: "POST",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({ path: f.file_path }),
                    });
                  } : (e) => e.stopPropagation()}
                  title={`Open ${f.file_path}`}
                >
                  <span className={`text-[11px] font-mono font-bold leading-none w-3 text-center shrink-0 ${f.operation === "write" ? "text-accent-green" : "text-accent-blue"}`}>
                    {f.operation === "write" ? "+" : "~"}
                  </span>
                  <span className="font-mono text-[11px] leading-tight text-text-secondary truncate group-hover/file:text-text transition-colors">
                    {basename(f.file_path)}
                  </span>
                </a>
              ))}
              {overflow > 0 && (
                <div className="flex items-center gap-1.5 py-px">
                  <span className="w-3 shrink-0" />
                  <span className="text-[10px] text-text-dim italic">+{overflow} more</span>
                </div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ── Session Card ────────────────────────────────────────────────────

interface SessionCardProps {
  session: SessionSummary & { workspace_name?: string };
  onTagsChange?: (sessionId: string, tags: Tag[]) => void;
}

export default function SessionCard({ session, onTagsChange }: SessionCardProps) {
  const navigate = useNavigate();

  return (
    <div className="session-row">
      <button
        className="session-row-card block w-full text-left bg-bg-card border border-border rounded-lg px-4 py-3.5 transition-all hover:border-accent-blue hover:bg-[rgba(22,27,34,0.8)]"
        onClick={() => navigate(`/session/${session.id}`)}
      >
        {/* Meta row: date, duration, session ID, branch */}
        <div className="flex items-center gap-2.5 text-xs flex-wrap">
          <span className="font-mono text-xs text-text-secondary">
            {formatDate(session.started_at)}{" "}
            {formatTime(session.started_at)}
            {session.ended_at && ` – ${formatTime(session.ended_at)}`}
          </span>
          {session.ended_at && (
            <span className="text-text-dim text-[11px]">{duration(session.started_at, session.ended_at)}</span>
          )}
          <button
            className="group/sid inline-flex items-center gap-0.5 font-mono text-[10px] text-text-dim/40 transition-colors hover:text-text-secondary"
            onClick={e => { e.stopPropagation(); navigator.clipboard.writeText(session.id); }}
            title="Copy session ID"
          >
            <span>{session.id.slice(0, 8)}</span>
            <svg className="opacity-0 group-hover/sid:opacity-100 transition-opacity shrink-0" width="10" height="10" viewBox="0 0 16 16" fill="none">
              <rect x="5" y="5" width="9" height="9" rx="1.5" stroke="currentColor" strokeWidth="1.2" />
              <path d="M3 11V3.5A1.5 1.5 0 014.5 2H10" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
            </svg>
          </button>
          {session.git_branch && <span className="inline-block px-2 py-px rounded-full font-mono text-[11px] bg-accent-purple/12 text-accent-purple whitespace-nowrap overflow-hidden text-ellipsis max-w-[200px]">{session.git_branch}</span>}
        </div>

        {/* Summary as bullet list, or message count fallback */}
        {session.summary ? (
          <ul className="mt-2 text-[12px] leading-[1.6] text-text-primary pl-4 list-disc space-y-0.5">
            {parseSummaryBullets(session.summary).map((line, i) => (
              <li key={i}>{line}</li>
            ))}
          </ul>
        ) : (
          <div className="mt-1.5 text-[11px] text-text-dim">
            {session.message_count} messages, {session.user_message_count} from you
          </div>
        )}

        {/* Tags */}
        <div className="flex items-center gap-1.5 mt-2">
          {onTagsChange ? (
            <InlineTagAdder
              sessionId={session.id}
              tags={session.tags || []}
              onTagsChange={(newTags) => onTagsChange(session.id, newTags)}
            />
          ) : (
            session.tags && session.tags.map((t) => (
              <span
                key={t.id}
                className="inline-flex items-center gap-1 px-1.5 py-px rounded-full text-[10px] font-medium whitespace-nowrap"
                style={{ background: `${t.color}26`, color: t.color }}
              >
                <Link
                  to={`/tag/${encodeURIComponent(t.name)}`}
                  className="no-underline hover:underline"
                  style={{ color: "inherit" }}
                  onClick={e => e.stopPropagation()}
                >{t.name}</Link>
              </span>
            ))
          )}
        </div>
      </button>
      <div className={`session-row-files${!session.files_changed?.length ? " session-row-files--empty" : ""}`}>
        <FileCategoryPills files={session.files_changed || []} />
      </div>
    </div>
  );
}
