import { useState, useEffect } from "react";
import { Link, useNavigate, useRouterState } from "@tanstack/react-router";
import type { Workspace, Tag, SavedSearch } from "../types";

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
  const navigate = useNavigate();
  const [tags, setTags] = useState<Tag[]>([]);
  const [showCreateTag, setShowCreateTag] = useState(false);
  const [newTagName, setNewTagName] = useState("");
  const [newTagColor, setNewTagColor] = useState(PRESET_COLORS[0]);
  const [ingesting, setIngesting] = useState(false);
  const [savedSearches, setSavedSearches] = useState<SavedSearch[]>([]);
  const [refreshingTag, setRefreshingTag] = useState<number | null>(null);

  useEffect(() => {
    fetch("/api/tags")
      .then((r) => r.json())
      .then((data) => setTags(data))
      .catch(() => {});
    fetch("/api/saved-searches")
      .then((r) => r.json())
      .then((data) => setSavedSearches(data))
      .catch(() => {});
  }, []);

  const savedSearchByTagId = new Map(savedSearches.map((ss) => [ss.tag_id, ss]));

  function handleRefreshSearch(e: React.MouseEvent, ss: SavedSearch) {
    e.preventDefault();
    e.stopPropagation();
    setRefreshingTag(ss.tag_id);
    fetch(`/api/saved-searches/${ss.id}/run`, { method: "POST" })
      .then((r) => r.json())
      .then(() => {
        // Refresh tags to update counts
        fetch("/api/tags").then((r) => r.json()).then((data) => setTags(data));
        fetch("/api/saved-searches").then((r) => r.json()).then((data) => setSavedSearches(data));
      })
      .catch(() => {})
      .finally(() => setRefreshingTag(null));
  }

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
        <Link to="/" className="no-underline text-inherit hover:no-underline">
          <h2 className="text-[15px] font-semibold tracking-tight text-text">Session Explorer</h2>
        </Link>
        <div className="flex items-center gap-1">
          <button className="p-1.5 rounded-md text-text-secondary transition-all hover:bg-white/8 hover:text-text" onClick={() => navigate({ to: "/ask" })} title="Ask AI">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
              <path d="M2 3.5C2 2.67 2.67 2 3.5 2h9c.83 0 1.5.67 1.5 1.5v7c0 .83-.67 1.5-1.5 1.5H6L3 14.5V12H3.5C2.67 12 2 11.33 2 10.5v-7Z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
              <circle cx="5.5" cy="7" r="0.75" fill="currentColor" />
              <circle cx="8" cy="7" r="0.75" fill="currentColor" />
              <circle cx="10.5" cy="7" r="0.75" fill="currentColor" />
            </svg>
          </button>
          <button className="p-1.5 rounded-md text-text-secondary transition-all hover:bg-white/8 hover:text-text" onClick={onSearchClick} title="Search (Cmd+K)">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
              <circle cx="7" cy="7" r="5.5" stroke="currentColor" strokeWidth="1.5" />
              <line x1="11" y1="11" x2="14.5" y2="14.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          </button>
        </div>
      </div>
      <div className="px-4 pb-3 text-[11px] text-text-dim">
        <kbd className="inline-block px-1.5 py-px font-mono text-[10px] bg-white/6 border border-border rounded-sm">Cmd</kbd> + <kbd className="inline-block px-1.5 py-px font-mono text-[10px] bg-white/6 border border-border rounded-sm">K</kbd> to search
      </div>
      <nav className="flex-1 overflow-y-auto px-2 pb-4">
        {workspaces.map((w, i) => (
          <div key={w.id}>
            {i > 0 && <div className="mx-3 border-t border-border/50" />}
            <Link
              to="/workspace/$id"
              params={{ id: String(w.id) }}
              className="block px-3 py-2.5 rounded-lg no-underline text-text transition-[background] duration-150 hover:bg-white/5 hover:no-underline [&[data-status=active]]:bg-accent-blue/12 [&[data-status=active]_.workspace-name]:text-accent-blue"
            >
              <div className="workspace-name text-[13px] font-medium whitespace-nowrap overflow-hidden text-ellipsis">{w.display_name}</div>
              <div className="flex justify-between mt-0.5 text-[11px] text-text-dim">
                <span>{w.session_count} sessions</span>
                <span>{formatDate(w.last_activity)}</span>
              </div>
            </Link>
          </div>
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
          {tags.map((tag) => {
            const ss = savedSearchByTagId.get(tag.id);
            return (
              <Link
                key={tag.id}
                to="/tag/$name"
                params={{ name: tag.name }}
                className="flex items-center gap-2 px-2 py-1.5 rounded-md no-underline text-text text-xs transition-[background] duration-150 hover:bg-white/5 hover:no-underline group [&[data-status=active]]:bg-accent-blue/12"
              >
                <span className={`inline-block w-2 h-2 rounded-full shrink-0 ${ss ? "ring-1 ring-offset-1 ring-accent-blue/40 ring-offset-bg-sidebar" : ""}`} style={{ background: tag.color }} />
                <span className="flex-1 overflow-hidden text-ellipsis whitespace-nowrap">{tag.name}</span>
                {ss && (
                  <button
                    className={`w-4 h-4 flex items-center justify-center rounded text-text-dim transition-all hover:text-accent-blue hover:bg-white/10 opacity-0 group-hover:opacity-100 ${refreshingTag === tag.id ? "opacity-100 animate-spin" : ""}`}
                    onClick={(e) => handleRefreshSearch(e, ss)}
                    title={`Refresh smart tag (last run: ${ss.last_run_at ? new Date(ss.last_run_at).toLocaleDateString() : "never"})`}
                    disabled={refreshingTag === tag.id}
                  >
                    <svg width="10" height="10" viewBox="0 0 16 16" fill="none">
                      <path d="M13.65 2.35A8 8 0 103.34 13.66M13.65 2.35V6.5M13.65 2.35H9.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  </button>
                )}
                <span className="text-[10px] text-text-dim">{tag.session_count ?? 0}</span>
              </Link>
            );
          })}
          {tags.length === 0 && !showCreateTag && (
            <div className="px-2 py-1 text-[11px] text-text-dim">No tags yet</div>
          )}
        </div>
      </div>

      <div className="border-t border-border px-3 py-2.5 shrink-0">
        <button
          className="w-full text-[11px] text-text-dim transition-all hover:text-text-secondary disabled:opacity-40 text-left"
          onClick={() => {
            setIngesting(true);
            fetch("/api/ingest", { method: "POST" })
              .then(() => {
                const poll = setInterval(() => {
                  fetch("/api/ingest/status").then(r => r.json()).then(d => {
                    if (!d.running) {
                      clearInterval(poll);
                      setIngesting(false);
                      window.location.reload();
                    }
                  });
                }, 2000);
              })
              .catch(() => setIngesting(false));
          }}
          disabled={ingesting}
        >
          {ingesting ? "Ingesting..." : "Re-ingest sessions"}
        </button>
      </div>
    </aside>
  );
}
