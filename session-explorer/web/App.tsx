import { useState, useEffect, useRef, createContext, useContext } from "react";
import { Outlet, useNavigate, useLocation, useParams, useSearch } from "@tanstack/react-router";
import Sidebar from "./components/Sidebar";
import SessionList from "./components/SessionList";
import SessionDetail from "./components/SessionDetail";
import Search from "./components/Search";
import SessionCard from "./components/SessionCard";
// AskView is now rendered inside the Search overlay's "Ask AI" tab
import InsightsPage from "./components/InsightsPage";
import MetaDashboard from "./components/MetaDashboard";
import ProposalQueue from "./components/ProposalQueue";
import ProposalDetail from "./components/ProposalDetail";
import ScoreTrends from "./components/ScoreTrends";
import MetaSettings from "./components/MetaSettings";
import LibraryPage from "./components/library/LibraryPage";
import LibraryDetail from "./components/library/LibraryDetail";
import {
  rootRoute,
  indexRoute,
  workspaceRoute,
  sessionRoute,
  tagRoute,
  fileRoute,
  askRoute,
  searchRoute,
  insightsRoute,
  metaRoute,
  metaProposalsRoute,
  metaProposalDetailRoute,
  metaScoresRoute,
  metaSettingsRoute,
  libraryRoute,
  libraryDetailRoute,
  router,
} from "./router";
import type { Workspace, Tag, SessionSummary } from "./types";

// ── Shared contexts ──────────────────────────────────────────────────

const WorkspacesContext = createContext<Workspace[]>([]);
const SearchClickContext = createContext<(() => void) | null>(null);

function useWorkspaces() {
  return useContext(WorkspacesContext);
}

function useSearchClick() {
  return useContext(SearchClickContext);
}

// ── Page components ───────────────────────────────────────────────────

interface HeatmapDay {
  date: string;
  count: number;
}

interface RecentSession {
  id: string;
  title: string | null;
  started_at: string;
  message_count: number;
  workspace_name?: string;
}

function Dashboard() {
  const workspaces = useWorkspaces();
  const onSearchClick = useSearchClick();
  const navigate = useNavigate();
  const totalSessions = workspaces.reduce((s, w) => s + w.session_count, 0);
  const [heatmap, setHeatmap] = useState<HeatmapDay[]>([]);
  const [recentSessions, setRecentSessions] = useState<RecentSession[]>([]);

  useEffect(() => {
    fetch("/api/activity-heatmap")
      .then((r) => r.json())
      .then((data) => setHeatmap(data))
      .catch(() => {});
    fetch("/api/sessions?limit=8")
      .then((r) => r.json())
      .then((data) => {
        // The API returns { sessions, pagination } — enrich with workspace name
        const sessions = (data.sessions || []).map((s: Record<string, unknown>) => ({
          id: s.id,
          title: s.title,
          started_at: s.started_at,
          message_count: s.message_count,
          workspace_name: (s as { workspace_name?: string }).workspace_name,
          workspace_id: s.workspace_id,
        }));
        // Resolve workspace names from context
        setRecentSessions(sessions.map((s: Record<string, unknown>) => {
          const ws = workspaces.find(w => w.id === Number(s.workspace_id));
          return { ...s, workspace_name: ws?.display_name || "Unknown" };
        }));
      })
      .catch(() => {});
  }, [workspaces]);

  // Build 28-day heatmap grid (4 weeks, Mon-Sun columns)
  const heatmapByDate = new Map(heatmap.map(h => [h.date, h.count]));
  const days: { date: string; count: number; label: string }[] = [];
  const today = new Date();
  for (let i = 27; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    const dateStr = d.toISOString().split("T")[0];
    const count = heatmapByDate.get(dateStr) || 0;
    const label = d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
    days.push({ date: dateStr, count, label });
  }
  const maxCount = Math.max(1, ...days.map(d => d.count));

  function heatColor(count: number): string {
    if (count === 0) return "rgba(188, 140, 255, 0.06)";
    const intensity = Math.min(count / maxCount, 1);
    if (intensity < 0.25) return "rgba(188, 140, 255, 0.18)";
    if (intensity < 0.5) return "rgba(188, 140, 255, 0.35)";
    if (intensity < 0.75) return "rgba(188, 140, 255, 0.55)";
    return "rgba(188, 140, 255, 0.8)";
  }

  function formatTime(dateStr: string): string {
    const d = new Date(dateStr);
    const now = new Date();
    const diffMs = now.getTime() - d.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    if (diffMins < 60) return `${diffMins}m ago`;
    const diffHours = Math.floor(diffMins / 60);
    if (diffHours < 24) return `${diffHours}h ago`;
    const diffDays = Math.floor(diffHours / 24);
    if (diffDays === 1) return "Yesterday";
    if (diffDays < 7) return `${diffDays}d ago`;
    return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  }

  return (
    <div className="px-12 pt-10 pb-12">
      {/* Prominent search bar (Raycast style) */}
      <button
        className="w-full bg-bg-card border border-border rounded-2xl px-6 py-5 flex items-center gap-4 transition-all hover:border-accent-purple/50 hover:bg-bg-card/80 group cursor-pointer text-left"
        onClick={() => onSearchClick?.()}
      >
        <svg className="text-text-dim group-hover:text-accent-purple transition-colors shrink-0" width="22" height="22" viewBox="0 0 16 16" fill="none">
          <circle cx="7" cy="7" r="5.5" stroke="currentColor" strokeWidth="1.5" />
          <line x1="11" y1="11" x2="14.5" y2="14.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
        <span className="flex-1 text-[15px] text-text-dim group-hover:text-text-secondary transition-colors">Search sessions, files, messages...</span>
        <kbd className="inline-flex items-center gap-1 px-2 py-1 font-mono text-[11px] text-text-dim bg-white/6 border border-border/60 rounded-md">
          <span className="text-[13px]">&#8984;</span>K
        </kbd>
      </button>

      {/* Session Activity heading */}
      <div className="mt-5 mb-3">
        <h2 className="text-[20px] font-semibold tracking-tight text-text">Session Activity</h2>
        <p className="text-[13px] text-text-dim mt-0.5">{totalSessions} sessions across {workspaces.length} workspaces</p>
      </div>

      {/* Activity heatmap — two-row grid */}
      <div className="bg-bg-card border border-border rounded-xl px-5 py-4 mb-8">
        <div className="grid gap-[3px]" style={{ gridTemplateColumns: `repeat(14, 1fr)`, gridTemplateRows: "repeat(2, 1fr)" }}>
          {days.map((day) => (
            <div
              key={day.date}
              className="h-[16px] rounded-[3px] transition-colors"
              style={{ background: heatColor(day.count) }}
              title={`${day.label}: ${day.count} session${day.count !== 1 ? "s" : ""}`}
            />
          ))}
        </div>
        <div className="flex items-center justify-between mt-2">
          <span className="text-[10px] text-text-dim">4 weeks ago</span>
          <div className="flex items-center gap-1.5">
            <span className="text-[10px] text-text-dim mr-1">Less</span>
            {[0, 0.25, 0.5, 0.75, 1].map((v, i) => (
              <div key={i} className="w-[10px] h-[10px] rounded-[2px]" style={{ background: heatColor(v === 0 ? 0 : v * maxCount) }} />
            ))}
            <span className="text-[10px] text-text-dim ml-1">More</span>
          </div>
          <span className="text-[10px] text-text-dim">Today</span>
        </div>
      </div>

      {/* Recent sessions */}
      {recentSessions.length > 0 && (
        <div>
          <h3 className="text-[14px] font-semibold text-text mb-3">Recent Sessions</h3>
          <div className="flex flex-col gap-1.5">
            {recentSessions.map((session) => (
              <button
                key={session.id}
                className="flex items-center gap-4 bg-bg-card border border-border rounded-lg px-4 py-3.5 transition-all hover:border-accent-purple/40 hover:bg-[rgba(22,27,34,0.8)] text-left w-full group"
                onClick={() => navigate({ to: "/session/$id", params: { id: session.id } })}
              >
                {/* Purple message count badge */}
                <div className="shrink-0 w-9 h-9 rounded-lg bg-accent-purple/12 flex items-center justify-center">
                  <span className="text-[13px] font-semibold text-accent-purple">{session.message_count}</span>
                </div>
                {/* Session info */}
                <div className="flex-1 min-w-0">
                  <div className="text-[13px] font-medium text-text line-clamp-1 group-hover:text-accent-purple transition-colors">
                    {session.title || "Untitled session"}
                  </div>
                </div>
                {/* Workspace + time */}
                <div className="shrink-0 text-right">
                  <div className="text-[11px] text-text-dim">{session.workspace_name}</div>
                  <div className="text-[10px] text-text-dim mt-0.5">{formatTime(session.started_at)}</div>
                </div>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function WorkspaceView() {
  const workspaces = useWorkspaces();
  const { id } = useParams({ from: workspaceRoute.id });
  const workspace = workspaces.find((w) => w.id === Number(id));

  if (!workspace) {
    return <div className="flex items-center justify-center px-5 py-15 text-text-secondary text-sm">Workspace not found.</div>;
  }

  return <SessionList workspace={workspace} />;
}

function SessionView() {
  return <SessionDetail />;
}

function formatTagDate(dateStr: string): string {
  return new Date(dateStr).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

const PRESET_COLORS = [
  "#58a6ff", "#3fb950", "#bc8cff", "#d29922",
  "#f85149", "#79c0ff", "#d2a8ff", "#56d364",
];

function TagView() {
  const { name } = useParams({ from: tagRoute.id });
  const navigate = useNavigate();
  const [tag, setTag] = useState<Tag | null>(null);
  const [sessions, setSessions] = useState<(SessionSummary & { workspace_name?: string })[]>([]);
  const [loading, setLoading] = useState(true);
  const [colorPickerOpen, setColorPickerOpen] = useState(false);
  const colorPickerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (colorPickerRef.current && !colorPickerRef.current.contains(e.target as Node)) {
        setColorPickerOpen(false);
      }
    }
    if (colorPickerOpen) {
      document.addEventListener("mousedown", handleClickOutside);
      return () => document.removeEventListener("mousedown", handleClickOutside);
    }
  }, [colorPickerOpen]);

  function updateTagColor(color: string) {
    fetch(`/api/tags/${tag?.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ color }),
    })
      .then((r) => r.json())
      .then((updated: Tag) => {
        setTag(updated);
        setColorPickerOpen(false);
      })
      .catch(() => {});
  }

  useEffect(() => {
    setLoading(true);
    fetch(`/api/tags/by-name/${encodeURIComponent(name)}/sessions`)
      .then((r) => r.json())
      .then((data: { tag: Tag; sessions: (SessionSummary & { workspace_name?: string })[] }) => {
        setTag(data.tag);
        setSessions(data.sessions);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [name]);

  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 p-15 text-text-secondary">
        <div className="spinner" />
        <span>Loading tag sessions...</span>
      </div>
    );
  }

  if (!tag) {
    return <div className="flex items-center justify-center px-5 py-15 text-text-secondary text-sm">Tag not found.</div>;
  }

  // Group by workspace
  const byWorkspace = new Map<string, (SessionSummary & { workspace_name?: string })[]>();
  for (const s of sessions) {
    const key = s.workspace_name || "Unknown";
    if (!byWorkspace.has(key)) byWorkspace.set(key, []);
    byWorkspace.get(key)!.push(s);
  }

  return (
    <div className="px-10 py-8 max-w-[1200px]">
      <button className="inline-flex items-center gap-1.5 px-3 py-1.5 text-[13px] text-text-secondary rounded-md transition-all hover:text-text hover:bg-white/6 mb-4" onClick={() => window.history.back()}>
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
          <path d="M10 12L6 8L10 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        Back
      </button>
      <div>
        <div className="flex items-center gap-2.5">
          <div className="relative" ref={colorPickerRef}>
            <button
              className="inline-block w-3.5 h-3.5 rounded-full shrink-0 cursor-pointer transition-transform hover:scale-125 border-0 p-0"
              style={{ background: tag.color }}
              onClick={() => setColorPickerOpen(!colorPickerOpen)}
              title="Change color"
            />
            {colorPickerOpen && (
              <div className="absolute top-full left-0 mt-1.5 p-2 bg-bg-card border border-border rounded-lg shadow-[0_8px_24px_rgba(0,0,0,0.4)] z-50 flex gap-1.5 flex-wrap w-[120px]">
                {PRESET_COLORS.map((c) => (
                  <button
                    key={c}
                    className={`w-5 h-5 rounded-full border-2 transition-[border-color] duration-100 hover:border-text-secondary ${c === tag.color ? "border-text" : "border-transparent"}`}
                    style={{ background: c }}
                    onClick={() => updateTagColor(c)}
                  />
                ))}
              </div>
            )}
          </div>
          <h1 className="text-[22px] font-semibold">{tag.name}</h1>
        </div>
        {tag.description && <p className="font-mono text-xs text-text-dim mt-1">{tag.description}</p>}
        <p className="text-[13px] text-text-secondary mt-0.5 mb-6">{sessions.length} sessions</p>
      </div>

      <div>
        {Array.from(byWorkspace.entries()).map(([workspace, items]) => (
          <div key={workspace} className="mb-6">
            <h3 className="text-[11px] font-semibold uppercase tracking-wider text-text-dim pb-2 border-b border-border mb-2">{workspace}</h3>
            <div className="session-rows">
              {items.map((session) => (
                <SessionCard key={session.id} session={session} />
              ))}
            </div>
          </div>
        ))}
      </div>

      {sessions.length === 0 && (
        <div className="flex items-center justify-center px-5 py-15 text-text-secondary text-sm">No sessions tagged with "{tag.name}" yet.</div>
      )}
    </div>
  );
}

function FileView() {
  const { path: filePath } = useSearch({ from: fileRoute.id });
  const navigate = useNavigate();
  const fileName = filePath.split("/").pop() || filePath;
  const [sessions, setSessions] = useState<Array<{
    id: string;
    started_at: string;
    ended_at: string | null;
    git_branch: string | null;
    title: string | null;
    message_count: number;
    user_message_count: number;
    operation: string;
    workspace_name: string;
  }>>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!filePath) return;
    setLoading(true);
    fetch(`/api/files/by-path?path=${encodeURIComponent(filePath)}`)
      .then((r) => r.json())
      .then((data) => setSessions(data.sessions || []))
      .catch(() => setSessions([]))
      .finally(() => setLoading(false));
  }, [filePath]);

  if (!filePath) {
    return <div className="flex items-center justify-center px-5 py-15 text-text-secondary text-sm">No file path specified.</div>;
  }

  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 p-15 text-text-secondary">
        <div className="spinner" />
        <span>Loading file history...</span>
      </div>
    );
  }

  return (
    <div className="px-10 py-8 max-w-[900px]">
      <div>
        <button className="inline-flex items-center gap-1.5 px-3 py-1.5 text-[13px] text-text-secondary rounded-md transition-all hover:text-text hover:bg-white/6" onClick={() => window.history.back()}>
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
            <path d="M10 12L6 8L10 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          Back
        </button>
        <h1 className="mt-3 text-[22px] font-semibold tracking-tight">{fileName}</h1>
        <p className="font-mono text-xs text-text-dim mt-1">{filePath}</p>
        <div className="flex gap-2 mt-2 mb-4">
          <a
            href={`vscode://file${filePath}`}
            className="inline-block px-3 py-1 text-xs text-accent-blue bg-accent-blue/8 border border-accent-blue/20 rounded-md no-underline transition-all hover:bg-accent-blue/15 hover:border-accent-blue hover:no-underline"
          >
            Open in VS Code
          </a>
          <button
            className="inline-block px-3 py-1 text-xs text-accent-blue bg-accent-blue/8 border border-accent-blue/20 rounded-md transition-all hover:bg-accent-blue/15 hover:border-accent-blue"
            onClick={() => navigator.clipboard.writeText(filePath)}
          >
            Copy path
          </button>
        </div>
        <p className="text-[13px] text-text-secondary mt-0.5 mb-6">
          Referenced in {sessions.length} session{sessions.length !== 1 ? "s" : ""}
        </p>
      </div>

      {sessions.map((session) => (
        <button
          key={`${session.id}-${session.operation}`}
          className="block w-full text-left bg-bg-card border border-border rounded-lg px-4 py-3.5 mb-1.5 transition-all hover:border-accent-blue hover:bg-[rgba(22,27,34,0.8)]"
          onClick={() => navigate({ to: "/session/$id", params: { id: session.id } })}
        >
          <div className="flex items-center gap-2.5 text-xs">
            <span className="font-mono text-xs text-text-secondary">
              {formatTagDate(session.started_at)}
            </span>
            <span className={`operation-badge operation-${session.operation} inline-block px-2 py-px rounded-full text-[10px] font-semibold uppercase tracking-wide`}>
              {session.operation}
            </span>
            {session.git_branch && <span className="inline-block px-2 py-px rounded-full font-mono text-[11px] bg-accent-purple/12 text-accent-purple whitespace-nowrap overflow-hidden text-ellipsis max-w-[200px]">{session.git_branch}</span>}
          </div>
          <div className="mt-1.5 text-sm font-medium text-text line-clamp-2">
            {session.title || "Untitled session"}
          </div>
          <div className="mt-1.5 text-xs text-text-dim">
            <span>{session.workspace_name}</span>
            <span className="mx-1.5 text-border">/</span>
            <span>{session.message_count} messages</span>
          </div>
        </button>
      ))}

      {sessions.length === 0 && (
        <div className="flex items-center justify-center px-5 py-15 text-text-secondary text-sm">No sessions found that reference this file.</div>
      )}
    </div>
  );
}


function SearchOverlay() {
  return (
    <Search
      onClose={() => router.history.push("/")}
      onNavigate={(path) => router.history.push(path)}
    />
  );
}

// ── Root layout ───────────────────────────────────────────────────────

function RootLayout() {
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [loading, setLoading] = useState(true);
  const navigate = useNavigate();
  const location = useLocation();

  useEffect(() => {
    fetch("/api/workspaces")
      .then((r) => r.json())
      .then((data) => {
        const sorted = (data as Workspace[]).sort((a, b) => {
          if (!a.last_activity) return 1;
          if (!b.last_activity) return -1;
          return b.last_activity.localeCompare(a.last_activity);
        });
        setWorkspaces(sorted);
      })
      .catch(() => setWorkspaces([]))
      .finally(() => setLoading(false));
  }, []);

  const isSearchOpen = location.pathname === "/search";

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        if (isSearchOpen) {
          navigate({ to: "/" });
        } else {
          navigate({ to: "/search" });
        }
      }
      if (e.key === "Escape" && isSearchOpen) {
        navigate({ to: "/" });
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [isSearchOpen, navigate]);

  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-4 text-text-secondary">
        <div className="spinner" />
        <p>Loading workspaces...</p>
      </div>
    );
  }

  const handleSearchClick = () => navigate({ to: "/search" });

  return (
    <WorkspacesContext.Provider value={workspaces}>
      <SearchClickContext.Provider value={handleSearchClick}>
        <div className="flex h-full">
          <Sidebar workspaces={workspaces} onSearchClick={handleSearchClick} />
          <main className="flex-1 overflow-y-auto relative">
            {isSearchOpen && <SearchOverlay />}
            <Outlet />
          </main>
        </div>
      </SearchClickContext.Provider>
    </WorkspacesContext.Provider>
  );
}

// ── Attach components to routes ───────────────────────────────────────

rootRoute.update({ component: RootLayout });
indexRoute.update({ component: Dashboard });
workspaceRoute.update({ component: WorkspaceView });
sessionRoute.update({ component: SessionView });
tagRoute.update({ component: TagView });
fileRoute.update({ component: FileView });
askRoute.update({ component: () => null });
searchRoute.update({ component: () => null });
insightsRoute.update({ component: InsightsPage });
metaRoute.update({ component: MetaDashboard });
metaProposalsRoute.update({ component: ProposalQueue });
metaProposalDetailRoute.update({ component: ProposalDetail });
metaScoresRoute.update({ component: ScoreTrends });
metaSettingsRoute.update({ component: MetaSettings });
libraryRoute.update({ component: LibraryPage });
libraryDetailRoute.update({ component: LibraryDetail });
