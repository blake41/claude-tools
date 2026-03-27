import { useState, useEffect, useRef, createContext, useContext } from "react";
import { Outlet, useNavigate, useLocation, useParams, useSearch } from "@tanstack/react-router";
import Sidebar from "./components/Sidebar";
import SessionList from "./components/SessionList";
import SessionDetail from "./components/SessionDetail";
import Search from "./components/Search";
import SessionCard from "./components/SessionCard";
import AskView from "./components/AskView";
import {
  rootRoute,
  indexRoute,
  workspaceRoute,
  sessionRoute,
  tagRoute,
  fileRoute,
  askRoute,
  searchRoute,
  router,
} from "./router";
import type { Workspace, Tag, SessionSummary } from "./types";

// ── Shared workspace context ──────────────────────────────────────────

const WorkspacesContext = createContext<Workspace[]>([]);

function useWorkspaces() {
  return useContext(WorkspacesContext);
}

// ── Page components ───────────────────────────────────────────────────

function Dashboard() {
  const workspaces = useWorkspaces();
  const totalSessions = workspaces.reduce((s, w) => s + w.session_count, 0);
  const mostRecent = workspaces.length > 0 ? workspaces[0] : null;

  return (
    <div className="px-12 pt-15 max-w-[800px]">
      <h1 className="text-[28px] font-semibold tracking-tight">Session Explorer</h1>
      <p className="text-text-secondary mt-1 text-[15px]">Browse your Claude Code session history</p>
      <div className="flex gap-4 mt-8">
        <div className="bg-bg-card border border-border rounded-[10px] px-6 py-5 min-w-[160px]">
          <div className="text-2xl font-semibold text-text whitespace-nowrap overflow-hidden text-ellipsis">{workspaces.length}</div>
          <div className="text-xs text-text-secondary mt-1">Workspaces</div>
        </div>
        <div className="bg-bg-card border border-border rounded-[10px] px-6 py-5 min-w-[160px]">
          <div className="text-2xl font-semibold text-text whitespace-nowrap overflow-hidden text-ellipsis">{totalSessions}</div>
          <div className="text-xs text-text-secondary mt-1">Total Sessions</div>
        </div>
        {mostRecent && (
          <div className="bg-bg-card border border-border rounded-[10px] px-6 py-5 min-w-[160px]">
            <div className="text-2xl font-semibold text-text whitespace-nowrap overflow-hidden text-ellipsis">{mostRecent.display_name}</div>
            <div className="text-xs text-text-secondary mt-1">Most Recent Activity</div>
          </div>
        )}
      </div>
      <p className="mt-8 text-text-dim text-[13px]">Select a workspace from the sidebar to browse sessions.</p>
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

  return (
    <WorkspacesContext.Provider value={workspaces}>
      <div className="flex h-full">
        <Sidebar workspaces={workspaces} onSearchClick={() => navigate({ to: "/search" })} />
        <main className="flex-1 overflow-y-auto relative">
          {isSearchOpen && <SearchOverlay />}
          <Outlet />
        </main>
      </div>
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
askRoute.update({ component: AskView });
searchRoute.update({ component: () => null });
