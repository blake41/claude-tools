import { useState, useEffect } from "react";
import { NavLink } from "react-router-dom";
import type { Workspace, Tag } from "../types";

interface SidebarProps {
  workspaces: Workspace[];
  onSearchClick: () => void;
}

const PRESET_COLORS = [
  "#58a6ff", "#3fb950", "#bc8cff", "#d29922",
  "#f85149", "#79c0ff", "#d2a8ff", "#56d364",
];

function formatDate(dateStr: string | null): string {
  if (!dateStr) return "No activity";
  const d = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

  if (diffDays === 0) return "Today";
  if (diffDays === 1) return "Yesterday";
  if (diffDays < 7) return `${diffDays}d ago`;
  if (diffDays < 30) return `${Math.floor(diffDays / 7)}w ago`;
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export default function Sidebar({ workspaces, onSearchClick }: SidebarProps) {
  const [tags, setTags] = useState<Tag[]>([]);
  const [showCreateTag, setShowCreateTag] = useState(false);
  const [newTagName, setNewTagName] = useState("");
  const [newTagColor, setNewTagColor] = useState(PRESET_COLORS[0]);

  useEffect(() => {
    fetch("/api/tags")
      .then((r) => r.json())
      .then((data) => setTags(data))
      .catch(() => {});
  }, []);

  function handleCreateTag(e: React.FormEvent) {
    e.preventDefault();
    if (!newTagName.trim()) return;
    fetch("/api/tags", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: newTagName.trim(), color: newTagColor }),
    })
      .then((r) => r.json())
      .then((tag) => {
        setTags((prev) => [...prev, { ...tag, session_count: 0 }].sort((a, b) => a.name.localeCompare(b.name)));
        setNewTagName("");
        setNewTagColor(PRESET_COLORS[0]);
        setShowCreateTag(false);
      })
      .catch(() => {});
  }

  return (
    <aside className="w-[260px] min-w-[260px] bg-bg-sidebar border-r border-border flex flex-col overflow-hidden">
      <div className="flex items-center justify-between px-4 pt-5 pb-2">
        <NavLink to="/" className="no-underline text-inherit hover:no-underline">
          <h2 className="text-[15px] font-semibold tracking-tight text-text">Session Explorer</h2>
        </NavLink>
        <button className="p-1.5 rounded-md text-text-secondary transition-all hover:bg-white/8 hover:text-text" onClick={onSearchClick} title="Search (Cmd+K)">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
            <circle cx="7" cy="7" r="5.5" stroke="currentColor" strokeWidth="1.5" />
            <line x1="11" y1="11" x2="14.5" y2="14.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
        </button>
      </div>
      <div className="px-4 pb-3 text-[11px] text-text-dim">
        <kbd className="inline-block px-1.5 py-px font-mono text-[10px] bg-white/6 border border-border rounded-sm">Cmd</kbd> + <kbd className="inline-block px-1.5 py-px font-mono text-[10px] bg-white/6 border border-border rounded-sm">K</kbd> to search
      </div>
      <nav className="flex-1 overflow-y-auto px-2 pb-4">
        {workspaces.map((w) => (
          <NavLink
            key={w.id}
            to={`/workspace/${w.id}`}
            className={({ isActive }) =>
              `block px-3 py-2.5 rounded-lg no-underline text-text transition-[background] duration-150 mb-0.5 hover:bg-white/5 hover:no-underline ${isActive ? "bg-accent-blue/12 [&_.workspace-name]:text-accent-blue" : ""}`
            }
          >
            <div className="workspace-name text-[13px] font-medium whitespace-nowrap overflow-hidden text-ellipsis">{w.display_name}</div>
            <div className="flex justify-between mt-0.5 text-[11px] text-text-dim">
              <span>{w.session_count} sessions</span>
              <span>{formatDate(w.last_activity)}</span>
            </div>
          </NavLink>
        ))}
        {workspaces.length === 0 && (
          <div className="p-4 text-xs text-text-secondary text-center">No workspaces found. Run the ingestion script first.</div>
        )}
      </nav>

      <div className="border-t border-border px-2 pt-3 pb-4 shrink-0">
        <div className="flex items-center justify-between px-2 pb-2">
          <span className="text-[11px] font-semibold uppercase tracking-wider text-text-dim">Tags</span>
          <button
            className="w-5 h-5 flex items-center justify-center rounded text-sm text-text-dim transition-all hover:text-text hover:bg-white/8"
            onClick={() => setShowCreateTag(!showCreateTag)}
            title="Create tag"
          >
            {showCreateTag ? "\u00d7" : "+"}
          </button>
        </div>

        {showCreateTag && (
          <form className="px-2 pb-2 flex flex-col gap-1.5" onSubmit={handleCreateTag}>
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
            <button type="submit" className="px-2.5 py-1 bg-accent-blue text-white rounded text-[11px] font-medium transition-opacity hover:opacity-85 self-start">Create</button>
          </form>
        )}

        <div className="max-h-[200px] overflow-y-auto">
          {tags.map((tag) => (
            <NavLink
              key={tag.id}
              to={`/tag/${tag.id}`}
              className={({ isActive }) =>
                `flex items-center gap-2 px-2 py-1.5 rounded-md no-underline text-text text-xs transition-[background] duration-150 hover:bg-white/5 hover:no-underline ${isActive ? "bg-accent-blue/12" : ""}`
              }
            >
              <span className="inline-block w-2 h-2 rounded-full shrink-0" style={{ background: tag.color }} />
              <span className="flex-1 overflow-hidden text-ellipsis whitespace-nowrap">{tag.name}</span>
              <span className="text-[10px] text-text-dim">{tag.session_count ?? 0}</span>
            </NavLink>
          ))}
          {tags.length === 0 && !showCreateTag && (
            <div className="px-2 py-1 text-[11px] text-text-dim">No tags yet</div>
          )}
        </div>
      </div>
    </aside>
  );
}
