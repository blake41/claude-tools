import { useState, useEffect } from "react";
import { Link, useRouterState } from "@tanstack/react-router";
import type { Workspace, Tag, SavedSearch } from "../types";

interface SidebarProps {
  workspaces: Workspace[];
  onSearchClick: () => void;
}

// Collapse preference is route-aware: library defaults to collapsed, the rest
// default to expanded. Once the user toggles, that choice sticks per-route.
function collapseStorageKey(pathname: string): string {
  if (pathname.startsWith("/library")) return "sidebar-collapsed:library";
  return "sidebar-collapsed:default";
}

function defaultCollapsedFor(pathname: string): boolean {
  return pathname.startsWith("/library");
}

function readCollapsed(pathname: string): boolean {
  try {
    const stored = localStorage.getItem(collapseStorageKey(pathname));
    if (stored === "1") return true;
    if (stored === "0") return false;
  } catch {
    // ignore
  }
  return defaultCollapsedFor(pathname);
}

const PRESET_COLORS = [
  "#58a6ff", "#3fb950", "#bc8cff", "#d29922",
  "#f85149", "#79c0ff", "#d2a8ff", "#56d364",
];

function formatDate(dateStr: string | null): string {
  if (!dateStr) return "";
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

function loadStarredIds(): Set<number> {
  try {
    const raw = localStorage.getItem("starred-workspaces");
    return raw ? new Set(JSON.parse(raw)) : new Set();
  } catch { return new Set(); }
}

function saveStarredIds(ids: Set<number>) {
  localStorage.setItem("starred-workspaces", JSON.stringify([...ids]));
}

export default function Sidebar({ workspaces, onSearchClick }: SidebarProps) {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const [tags, setTags] = useState<Tag[]>([]);
  const [showCreateTag, setShowCreateTag] = useState(false);
  const [newTagName, setNewTagName] = useState("");
  const [newTagColor, setNewTagColor] = useState(PRESET_COLORS[0]);
  const [ingesting, setIngesting] = useState(false);
  const [savedSearches, setSavedSearches] = useState<SavedSearch[]>([]);
  const [refreshingTag, setRefreshingTag] = useState<number | null>(null);
  const [starredIds, setStarredIds] = useState<Set<number>>(loadStarredIds);
  const [showMore, setShowMore] = useState(false);
  const [filter, setFilter] = useState("");
  const [collapsed, setCollapsedState] = useState<boolean>(() => readCollapsed(pathname));

  // Re-evaluate collapse state when navigating between collapse buckets
  // (library ↔ everything else). Respects user override stored per-bucket.
  useEffect(() => {
    setCollapsedState(readCollapsed(pathname));
  }, [pathname]);

  function setCollapsed(next: boolean) {
    setCollapsedState(next);
    try {
      localStorage.setItem(collapseStorageKey(pathname), next ? "1" : "0");
    } catch {
      // ignore storage failures
    }
  }

  function toggleStar(id: number, e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    setStarredIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      saveStarredIds(next);
      return next;
    });
  }

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

  function shortName(name: string): string {
    return name.replace(/^Development\//, "");
  }

  // Filter workspaces client-side
  const filterLower = filter.toLowerCase();
  const filteredWorkspaces = filter
    ? workspaces.filter(w => w.display_name.toLowerCase().includes(filterLower))
    : workspaces;

  const starred = filteredWorkspaces.filter(w => starredIds.has(w.id));
  const rest = filteredWorkspaces.filter(w => !starredIds.has(w.id));
  const hasStars = starred.length > 0;

  if (collapsed) {
    return (
      <aside className="w-[44px] min-w-[44px] bg-[#101018] border-r border-border/50 flex flex-col items-center py-3 gap-1.5">
        <button
          className="p-1.5 rounded-md text-text-dim transition-all hover:text-text hover:bg-white/8"
          onClick={() => setCollapsed(false)}
          title="Expand sidebar"
        >
          <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
            <path d="M9 1L16.5 9L9 17L1.5 9L9 1Z" fill="#bc8cff" fillOpacity="0.25" stroke="#bc8cff" strokeWidth="1.5" strokeLinejoin="round" />
          </svg>
        </button>
        <button
          className="p-1.5 rounded-md text-text-dim transition-all hover:text-text hover:bg-white/8"
          onClick={onSearchClick}
          title="Search (⌘K)"
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
            <circle cx="7" cy="7" r="4.5" stroke="currentColor" strokeWidth="1.5" />
            <path d="M10.5 10.5L14 14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
        </button>
        <div className="mt-1 flex flex-col gap-0.5 w-full items-center">
          <Link
            to="/library"
            className="p-1.5 rounded-md text-text-dim transition-all hover:text-text hover:bg-white/8 [&[data-status=active]]:text-accent-purple [&[data-status=active]]:bg-accent-purple/12"
            title="Library"
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
              <path d="M2.5 2.5h3v11h-3zM6.5 2.5h3v11h-3zM10.5 4.2l2.7-.7 2.5 9.4-2.7.7z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
            </svg>
          </Link>
          <Link
            to="/insights"
            className="p-1.5 rounded-md text-text-dim transition-all hover:text-text hover:bg-white/8 [&[data-status=active]]:text-accent-purple [&[data-status=active]]:bg-accent-purple/12"
            title="Insights"
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
              <path d="M8 1a5 5 0 00-1.5 9.77V12.5a1.5 1.5 0 003 0v-1.73A5 5 0 008 1zm0 2a3 3 0 011.5 5.6V12.5a1.5 1.5 0 01-3 0V8.6A3 3 0 018 3z" fill="currentColor" />
              <path d="M6.5 14.5h3" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
            </svg>
          </Link>
          <Link
            to="/meta"
            className="p-1.5 rounded-md text-text-dim transition-all hover:text-text hover:bg-white/8 [&[data-status=active]]:text-accent-purple [&[data-status=active]]:bg-accent-purple/12"
            title="Meta"
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
              <path d="M2 4h12M2 8h12M2 12h12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
              <circle cx="5" cy="4" r="1.5" fill="currentColor" />
              <circle cx="11" cy="8" r="1.5" fill="currentColor" />
              <circle cx="7" cy="12" r="1.5" fill="currentColor" />
            </svg>
          </Link>
        </div>
      </aside>
    );
  }

  return (
    <aside className="w-[230px] min-w-[230px] bg-[#101018] border-r border-border/50 flex flex-col overflow-hidden">
      {/* Header: Diamond icon + Explorer + Search + Collapse */}
      <div className="flex items-center gap-1.5 px-4 pt-5 pb-3">
        <Link to="/" className="flex items-center gap-2.5 no-underline text-inherit hover:no-underline flex-1 min-w-0">
          <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
            <path d="M9 1L16.5 9L9 17L1.5 9L9 1Z" fill="#bc8cff" fillOpacity="0.25" stroke="#bc8cff" strokeWidth="1.5" strokeLinejoin="round" />
          </svg>
          <span className="text-[15px] font-semibold tracking-tight text-text">Explorer</span>
        </Link>
        <button
          className="shrink-0 p-1.5 rounded-md text-text-dim transition-all hover:text-text hover:bg-white/8"
          onClick={onSearchClick}
          title="Search (⌘K)"
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
            <circle cx="7" cy="7" r="4.5" stroke="currentColor" strokeWidth="1.5" />
            <path d="M10.5 10.5L14 14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
        </button>
        <button
          className="shrink-0 p-1.5 rounded-md text-text-dim transition-all hover:text-text hover:bg-white/8"
          onClick={() => setCollapsed(true)}
          title="Collapse sidebar"
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
            <path d="M10 4L6 8l4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      </div>

      {/* Filter input */}
      <div className="px-3 pb-2">
        <div className="relative">
          <svg className="absolute left-2.5 top-1/2 -translate-y-1/2 text-text-dim" width="12" height="12" viewBox="0 0 16 16" fill="none">
            <circle cx="7" cy="7" r="5.5" stroke="currentColor" strokeWidth="1.5" />
            <line x1="11" y1="11" x2="14.5" y2="14.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
          <input
            type="text"
            className="w-full pl-7 pr-2 py-1.5 bg-white/5 border border-border/50 rounded-md outline-none text-xs text-text placeholder:text-text-dim focus:border-accent-purple/50 transition-colors"
            placeholder="Filter workspaces..."
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
        </div>
      </div>

      {/* Workspace list */}
      <nav className="flex-1 overflow-y-auto px-2 pb-2">
        {/* Starred workspaces */}
        {starred.map((w) => (
          <Link
            key={w.id}
            to="/workspace/$id"
            params={{ id: String(w.id) }}
            className="group/ws flex items-center gap-2 px-2.5 py-2 rounded-lg no-underline text-text transition-[background] duration-150 hover:bg-white/5 hover:no-underline [&[data-status=active]]:bg-accent-purple/12"
          >
            <button
              className="shrink-0 text-[#d29922] p-0"
              onClick={(e) => toggleStar(w.id, e)}
              title="Unstar"
            >
              <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
                <path d="M8 1.5l2 4.5 5 .5-3.75 3.25L12.5 15 8 12.25 3.5 15l1.25-5.25L1 6.5l5-.5L8 1.5z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
              </svg>
            </button>
            <span className="flex-1 text-[13px] font-medium whitespace-nowrap overflow-hidden text-ellipsis">{shortName(w.display_name)}</span>
            <span className="text-[10px] text-text-dim shrink-0">{formatDate(w.last_activity)}</span>
          </Link>
        ))}

        {/* Divider between starred and rest */}
        {hasStars && rest.length > 0 && (
          <div className="mx-2.5 my-1.5 border-t border-border/40" />
        )}

        {/* Collapsible "more workspaces" toggle when starred exist */}
        {hasStars && rest.length > 0 && (
          <div className="mx-2.5 mb-1">
            <button
              className="flex items-center gap-1.5 text-[11px] text-text-dim hover:text-text-secondary transition-colors py-1"
              onClick={() => setShowMore(!showMore)}
            >
              <svg width="8" height="8" viewBox="0 0 8 8" fill="none" className={`transition-transform ${showMore ? "rotate-90" : ""}`}>
                <path d="M2 1l4 3-4 3" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              {rest.length} more workspace{rest.length !== 1 ? "s" : ""}
            </button>
          </div>
        )}

        {/* Rest of workspaces */}
        {(!hasStars || showMore) && rest.map((w) => (
          <Link
            key={w.id}
            to="/workspace/$id"
            params={{ id: String(w.id) }}
            className="group/ws flex items-center gap-2 px-2.5 py-2 rounded-lg no-underline text-text transition-[background] duration-150 hover:bg-white/5 hover:no-underline [&[data-status=active]]:bg-accent-purple/12"
          >
            <button
              className="shrink-0 text-text-dim opacity-0 group-hover/ws:opacity-100 hover:text-[#d29922] transition-all p-0"
              onClick={(e) => toggleStar(w.id, e)}
              title="Star"
            >
              <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
                <path d="M8 1.5l2 4.5 5 .5-3.75 3.25L12.5 15 8 12.25 3.5 15l1.25-5.25L1 6.5l5-.5L8 1.5z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
              </svg>
            </button>
            <span className="flex-1 text-[13px] font-medium whitespace-nowrap overflow-hidden text-ellipsis">{shortName(w.display_name)}</span>
            <span className="text-[10px] text-text-dim shrink-0">{formatDate(w.last_activity)}</span>
          </Link>
        ))}

        {filteredWorkspaces.length === 0 && (
          <div className="p-4 text-xs text-text-secondary text-center">
            {filter ? "No matching workspaces" : "No workspaces found. Run the ingestion script first."}
          </div>
        )}
      </nav>

      {/* Tags section — compact pills */}
      <div className="border-t border-border/40 px-3 pt-3 pb-3 shrink-0">
        <div className="flex items-center justify-between pb-2">
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
          <form className="pb-2 flex flex-col gap-1.5" onSubmit={handleCreateTag}>
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

        {/* Tag pills */}
        <div className="flex flex-wrap gap-1.5 max-h-[140px] overflow-y-auto">
          {tags.map((tag) => {
            const ss = savedSearchByTagId.get(tag.id);
            return (
              <Link
                key={tag.id}
                to="/tag/$name"
                params={{ name: tag.name }}
                className="group inline-flex items-center gap-1.5 px-2 py-1 rounded-full no-underline text-text-secondary text-[11px] bg-white/5 border border-transparent transition-all hover:bg-white/8 hover:border-border/50 hover:text-text hover:no-underline [&[data-status=active]]:bg-accent-purple/15 [&[data-status=active]]:text-accent-purple [&[data-status=active]]:border-accent-purple/30"
              >
                <span className="inline-block w-2 h-2 rounded-full shrink-0" style={{ background: tag.color }} />
                <span className="whitespace-nowrap">{tag.name}</span>
                {ss && (
                  <button
                    className={`w-3.5 h-3.5 flex items-center justify-center rounded-full text-text-dim transition-all hover:text-accent-blue opacity-0 group-hover:opacity-100 ${refreshingTag === tag.id ? "opacity-100 animate-spin" : ""}`}
                    onClick={(e) => handleRefreshSearch(e, ss)}
                    title={`Refresh smart tag (last run: ${ss.last_run_at ? new Date(ss.last_run_at).toLocaleDateString() : "never"})`}
                    disabled={refreshingTag === tag.id}
                  >
                    <svg width="8" height="8" viewBox="0 0 16 16" fill="none">
                      <path d="M13.65 2.35A8 8 0 103.34 13.66M13.65 2.35V6.5M13.65 2.35H9.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  </button>
                )}
              </Link>
            );
          })}
          {tags.length === 0 && !showCreateTag && (
            <span className="text-[11px] text-text-dim">No tags yet</span>
          )}
        </div>
      </div>

      {/* Insights + Meta + Library links */}
      <div className="border-t border-border/40 px-3 pt-2 pb-1 shrink-0">
        <Link
          to="/library"
          className="group flex items-center gap-2 px-2.5 py-2 rounded-lg no-underline text-text-secondary transition-all hover:bg-white/5 hover:text-text [&[data-status=active]]:bg-accent-purple/12 [&[data-status=active]]:text-accent-purple"
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
            <path d="M2.5 2.5h3v11h-3zM6.5 2.5h3v11h-3zM10.5 4.2l2.7-.7 2.5 9.4-2.7.7z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
          </svg>
          <span className="text-[13px] font-medium">Library</span>
        </Link>
        <Link
          to="/insights"
          className="group flex items-center gap-2 px-2.5 py-2 rounded-lg no-underline text-text-secondary transition-all hover:bg-white/5 hover:text-text [&[data-status=active]]:bg-accent-purple/12 [&[data-status=active]]:text-accent-purple"
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
            <path d="M8 1a5 5 0 00-1.5 9.77V12.5a1.5 1.5 0 003 0v-1.73A5 5 0 008 1zm0 2a3 3 0 011.5 5.6V12.5a1.5 1.5 0 01-3 0V8.6A3 3 0 018 3z" fill="currentColor" />
            <path d="M6.5 14.5h3" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
          </svg>
          <span className="text-[13px] font-medium">Insights</span>
        </Link>
        <Link
          to="/meta"
          className="group flex items-center gap-2 px-2.5 py-2 rounded-lg no-underline text-text-secondary transition-all hover:bg-white/5 hover:text-text [&[data-status=active]]:bg-accent-purple/12 [&[data-status=active]]:text-accent-purple"
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
            <path d="M2 4h12M2 8h12M2 12h12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            <circle cx="5" cy="4" r="1.5" fill="currentColor" />
            <circle cx="11" cy="8" r="1.5" fill="currentColor" />
            <circle cx="7" cy="12" r="1.5" fill="currentColor" />
          </svg>
          <span className="text-[13px] font-medium">Meta</span>
        </Link>
      </div>

      {/* Re-ingest button */}
      <div className="border-t border-border/40 px-3 py-2.5 shrink-0">
        <button
          className="flex items-center gap-2 w-full text-[11px] text-text-dim transition-all hover:text-text-secondary disabled:opacity-40 text-left"
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
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none" className={ingesting ? "animate-spin" : ""}>
            <path d="M13.65 2.35A8 8 0 103.34 13.66M13.65 2.35V6.5M13.65 2.35H9.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          {ingesting ? "Ingesting..." : "Re-ingest sessions"}
        </button>
      </div>
    </aside>
  );
}
