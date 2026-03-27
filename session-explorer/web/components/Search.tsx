import { useState, useEffect, useRef } from "react";
import { useQueryState, parseAsString, parseAsStringLiteral } from "nuqs";
import type { SearchResult, SearchMatch, FileSearchResult, ChangedFile } from "../types";
import { categorizeFileRefs } from "../fileCategories";
import { SessionText, SnippetText, formatToolContent } from "../sessionFormat";

interface SearchProps {
  onClose: () => void;
  onNavigate: (path: string) => void;
}

type SearchTab = "messages" | "files";

type SortMode = "date" | "date_asc" | "relevance" | "matches";

type GroupMode = "none" | "branch" | "date";

const SORT_OPTIONS: Array<{ value: SortMode; label: string }> = [
  { value: "date", label: "Newest first" },
  { value: "date_asc", label: "Oldest first" },
  { value: "relevance", label: "Most relevant" },
  { value: "matches", label: "Most matches" },
];

function formatDate(dateStr: string): string {
  return new Date(dateStr).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function formatTime(dateStr: string): string {
  return new Date(dateStr).toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
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

function basename(path: string): string {
  return path.split("/").pop() || path;
}

function getDateGroup(dateStr: string): string {
  const now = new Date();
  const date = new Date(dateStr);
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const diffMs = startOfToday.getTime() - new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffDays < 0 || diffDays === 0) return "Today";
  if (diffDays === 1) return "Yesterday";
  if (diffDays < 7) return "This Week";
  if (diffDays < 30) return "This Month";
  return "Older";
}

/* SnippetText and SessionText are imported from sessionFormat.tsx */

/** Sort dropdown */
function SortDropdown({ value, onChange }: { value: SortMode; onChange: (v: SortMode) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  const current = SORT_OPTIONS.find((o) => o.value === value)!;

  return (
    <div ref={ref} className="relative">
      <button
        className="flex items-center gap-1.5 px-2.5 py-1 text-[12px] text-text-secondary hover:text-text bg-white/4 hover:bg-white/6 border border-border rounded-md transition-colors"
        onClick={() => setOpen(!open)}
      >
        {current.label}
        <svg width="10" height="10" viewBox="0 0 10 10" fill="none" className={`transition-transform ${open ? "rotate-180" : ""}`}>
          <path d="M2.5 3.75L5 6.25L7.5 3.75" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open && (
        <div className="absolute right-0 top-full mt-1 z-50 bg-bg-card border border-border rounded-lg shadow-lg py-1 min-w-[160px]">
          {SORT_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              className={`flex items-center gap-2 w-full px-3 py-1.5 text-[12px] hover:bg-white/6 rounded cursor-pointer transition-colors ${opt.value === value ? "text-accent-blue" : "text-text-secondary"}`}
              onClick={() => { onChange(opt.value); setOpen(false); }}
            >
              <span className="w-4 text-center">
                {opt.value === value ? "\u2713" : ""}
              </span>
              {opt.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** GroupToggle component */
function GroupToggle({ value, onChange }: { value: GroupMode; onChange: (v: GroupMode) => void }) {
  return (
    <div className="view-toggle">
      {(["none", "branch", "date"] as const).map((mode) => (
        <button
          key={mode}
          className={mode === value ? "active" : ""}
          onClick={() => onChange(mode)}
        >
          {mode === "none" ? "None" : mode === "branch" ? "Branch" : "Date"}
        </button>
      ))}
    </div>
  );
}

/** Branch group header */
function BranchGroupHeader({ branch, sessionCount, matchCount, latestDate }: {
  branch: string;
  sessionCount: number;
  matchCount: number;
  latestDate: string;
}) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 0 6px", borderBottom: "1px solid var(--border)", marginBottom: 8, marginTop: 16 }}>
      <span className="result-branch" style={{ fontSize: 11, padding: "2px 10px" }}>{branch}</span>
      <span style={{ fontSize: 10, color: "var(--text-dim)" }}>
        {sessionCount} session{sessionCount !== 1 ? "s" : ""} · {matchCount} match{matchCount !== 1 ? "es" : ""}
      </span>
      <span style={{ fontSize: 10, color: "var(--text-dim)", marginLeft: "auto" }}>
        Latest: {formatDate(latestDate)}
      </span>
    </div>
  );
}

/** FilterBar component */
function FilterBar({
  roleFilter, setRoleFilter,
  minMatches, setMinMatches,
  hasFiles, setHasFiles,
  branchFilter, setBranchFilter,
  branches,
}: {
  roleFilter: "all" | "user" | "assistant" | "tool";
  setRoleFilter: (v: "all" | "user" | "assistant" | "tool") => void;
  minMatches: number;
  setMinMatches: (v: number) => void;
  hasFiles: boolean;
  setHasFiles: (v: boolean) => void;
  branchFilter: string;
  setBranchFilter: (v: string) => void;
  branches: string[];
}) {
  return (
    <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 12 }}>
      {/* Role filter */}
      {(["all", "user", "assistant", "tool"] as const).map((r) => (
        <button
          key={r}
          className={`filter-chip ${roleFilter === r ? "active" : ""}`}
          onClick={() => setRoleFilter(r)}
        >
          {r === "all" ? "All roles" : r === "user" ? "Your messages" : r === "assistant" ? "Claude's" : "Tool outputs"}
        </button>
      ))}
      <span style={{ width: 1, background: "var(--border)", margin: "0 4px" }} />
      {/* Min matches */}
      {[1, 3, 5].map((n) => (
        <button
          key={n}
          className={`filter-chip ${minMatches === n ? "active" : ""}`}
          onClick={() => setMinMatches(minMatches === n ? 0 : n)}
        >
          {n}+ matches
        </button>
      ))}
      <span style={{ width: 1, background: "var(--border)", margin: "0 4px" }} />
      {/* Has files */}
      <button
        className={`filter-chip ${hasFiles ? "active" : ""}`}
        onClick={() => setHasFiles(!hasFiles)}
      >
        Has files
      </button>
      {/* Branch filter */}
      {branches.length > 1 && (
        <select
          value={branchFilter}
          onChange={(e) => setBranchFilter(e.target.value)}
          style={{
            fontSize: 11, padding: "3px 8px", borderRadius: 6,
            border: "1px solid var(--border)", background: "transparent",
            color: branchFilter !== "all" ? "var(--accent-blue)" : "var(--text-dim)",
            fontFamily: "var(--font-ui)", cursor: "pointer",
          }}
        >
          <option value="all">All branches</option>
          {branches.map((b) => (
            <option key={b} value={b}>{b}</option>
          ))}
        </select>
      )}
    </div>
  );
}

/** File pills — horizontal compact display for search results */
function FilePills({ files, query }: { files: ChangedFile[]; query?: string }) {
  if (!files || files.length === 0) return null;
  const cats = categorizeFileRefs(files);
  const items: Array<{ name: string; path: string; op: string; cls: string }> = [];
  for (const f of cats.docs) items.push({ name: basename(f.file_path), path: f.file_path, op: f.operation, cls: "docs" });
  for (const f of cats.viz) items.push({ name: basename(f.file_path), path: f.file_path, op: f.operation, cls: "viz" });
  for (const f of cats.code) items.push({ name: basename(f.file_path), path: f.file_path, op: f.operation, cls: "code" });

  // If query present, sort matching files first
  const queryLower = query?.toLowerCase() || "";
  if (queryLower) {
    items.sort((a, b) => {
      const aMatch = a.name.toLowerCase().includes(queryLower) || a.path.toLowerCase().includes(queryLower);
      const bMatch = b.name.toLowerCase().includes(queryLower) || b.path.toLowerCase().includes(queryLower);
      if (aMatch && !bMatch) return -1;
      if (!aMatch && bMatch) return 1;
      return 0;
    });
  }

  const visible = items.slice(0, 6);
  const overflow = items.length - visible.length;

  return (
    <div className="flex flex-wrap gap-1.5">
      {visible.map((item, i) => {
        const isMatch = queryLower && (item.name.toLowerCase().includes(queryLower) || item.path.toLowerCase().includes(queryLower));
        return (
          <span
            key={i}
            className={`file-cat-${item.cls} inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[11px] font-mono`}
            style={isMatch ? { outline: "2px solid rgba(250, 225, 50, 0.5)", outlineOffset: "1px" } : undefined}
          >
            <span className={`font-bold ${item.op === "write" ? "text-accent-green" : "text-accent-blue"}`}>
              {item.op === "write" ? "+" : "~"}
            </span>
            {item.name}
          </span>
        );
      })}
      {overflow > 0 && (
        <span className="text-[10px] text-text-dim self-center">+{overflow} more</span>
      )}
    </div>
  );
}

/** Single search result card */
function SearchResultCard({
  result,
  onNavigate,
  groupMode,
  roleFilter,
  query,
}: {
  result: SearchResult;
  onNavigate: (path: string) => void;
  groupMode: GroupMode;
  roleFilter: "all" | "user" | "assistant" | "tool";
  query: string;
}) {
  // Filter matches by role/type
  const filteredMatches = roleFilter === "all"
    ? result.matches
    : result.matches.filter((m) => {
        if (roleFilter === "tool") return m.message_type !== 'text';
        if (roleFilter === "user") return m.role === "user" && m.message_type === 'text';
        return m.role === "assistant" && m.message_type === 'text';
      });

  // Parse summary into bullet points
  const summaryBullets = result.summary
    ? result.summary.split('\n').filter(l => l.trim()).map(l => l.trim().replace(/^[-•]\s*/, '')).slice(0, 3)
    : [];

  const isFileMatch = result.match_source === 'files';

  return (
    <div className="result-card" onClick={() => onNavigate(`/session/${result.id}`)}>
      {/* 1. File pills */}
      {result.files_changed && result.files_changed.length > 0 && (
        <div style={{ marginBottom: 6 }}>
          <FilePills files={result.files_changed} query={isFileMatch ? query : undefined} />
        </div>
      )}

      {/* 2. Summary bullets */}
      {summaryBullets.length > 0 && (
        <div className="result-summary" style={{ marginTop: 0 }}>
          {summaryBullets.map((bullet, i) => (
            <div key={i} style={{ display: "flex", gap: 6 }}>
              <span style={{ color: "var(--text-dim)", flexShrink: 0 }}>·</span>
              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{bullet}</span>
            </div>
          ))}
        </div>
      )}

      {/* 3. Date + duration + match count + branch (when not grouped) */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 6, flexWrap: "wrap" }}>
        <span className="result-date">
          {formatDate(result.started_at)} · {formatTime(result.started_at)}
          {result.ended_at && ` – ${formatTime(result.ended_at)}`}
          {result.ended_at && ` · ${duration(result.started_at, result.ended_at)}`}
        </span>
        {!isFileMatch && result.match_count > 0 && (
          <span className="result-match-count">
            {result.match_count} match{result.match_count !== 1 ? "es" : ""}
          </span>
        )}
        {groupMode !== "branch" && result.git_branch && (
          <span className="result-branch">{result.git_branch}</span>
        )}
      </div>

      {/* 4. Tertiary meta */}
      <div className="result-stats">
        <span>{result.message_count} messages</span>
        <span>{result.user_message_count} from you</span>
      </div>

      {/* 5. Match snippets or file-match indicator */}
      {isFileMatch ? (
        <div style={{ marginTop: 10 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11, color: "var(--color-text-dim)", marginBottom: 6 }}>
            <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor" style={{ opacity: 0.5, flexShrink: 0 }}>
              <path d="M2 1.75C2 .784 2.784 0 3.75 0h6.586c.464 0 .909.184 1.237.513l2.914 2.914c.329.328.513.773.513 1.237v9.586A1.75 1.75 0 0113.25 16h-9.5A1.75 1.75 0 012 14.25zm1.75-.25a.25.25 0 00-.25.25v12.5c0 .138.112.25.25.25h9.5a.25.25 0 00.25-.25V6h-2.75A1.75 1.75 0 019 4.25V1.5zm6.75.062V4.25c0 .138.112.25.25.25h2.688z"/>
            </svg>
            <span>Matched by file name</span>
          </div>
          {result.matched_files && result.matched_files.length > 0 && (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
              {result.matched_files.slice(0, 4).map((f, i) => (
                <span key={i} style={{ fontFamily: "var(--font-mono)", fontSize: 11, padding: "2px 8px", borderRadius: 4, background: "rgba(250, 225, 50, 0.2)", color: "#fae132", border: "1px solid rgba(250, 225, 50, 0.4)", fontWeight: 600 }}>
                  {f}
                </span>
              ))}
              {result.matched_files.length > 4 && (
                <span style={{ fontSize: 10, color: "var(--color-text-dim)", alignSelf: "center" }}>+{result.matched_files.length - 4} more</span>
              )}
            </div>
          )}
        </div>
      ) : filteredMatches.length > 0 ? (
        <div className="snippet-bubbles">
          {filteredMatches.slice(0, 3).map((match, i) => {
            const isUser = match.role === "user";
            const isToolMatch = match.message_type !== 'text';
            return (
              <div
                key={i}
                className={`result-snippet ${isToolMatch ? 'type-tool' : isUser ? 'type-user' : 'type-claude'}`}
                onClick={(e) => {
                  e.stopPropagation();
                  onNavigate(`/session/${result.id}?msg=${match.sequence}`);
                }}
              >
                {isToolMatch ? (
                  <>
                    <div className="snippet-tool-label">
                      <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
                        <path d="M0 2.75C0 1.784.784 1 1.75 1h12.5c.966 0 1.75.784 1.75 1.75v10.5A1.75 1.75 0 0114.25 15H1.75A1.75 1.75 0 010 13.25zm1.75-.25a.25.25 0 00-.25.25v10.5c0 .138.112.25.25.25h12.5a.25.25 0 00.25-.25V2.75a.25.25 0 00-.25-.25zM7.25 8a.749.749 0 01-.22.53l-2.25 2.25a.749.749 0 11-1.06-1.06L5.44 8 3.72 6.28a.749.749 0 111.06-1.06l2.25 2.25c.141.14.22.331.22.53zm1.5 1.5h3a.75.75 0 010 1.5h-3a.75.75 0 010-1.5z"/>
                      </svg>
                      Tool output
                    </div>
                    <div
                      className="snippet-tool-output"
                      dangerouslySetInnerHTML={{ __html: formatToolContent(match.tool_content || match.snippet, query) }}
                    />
                  </>
                ) : (
                  <>
                    <div className="bubble-role">
                      {isUser ? "YOU" : "CLAUDE"}
                    </div>
                    <div className="snippet-highlight">
                      <SnippetText snippet={match.snippet} query={query} />
                    </div>
                  </>
                )}
              </div>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

export default function Search({ onClose, onNavigate }: SearchProps) {
  const [query, setQuery] = useQueryState("q", parseAsString.withDefault(""));
  const [tab, setTab] = useQueryState("tab", parseAsStringLiteral(["messages", "files"] as const).withDefault("messages"));
  const [sort, setSort] = useState<SortMode>("date");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [fileResults, setFileResults] = useState<FileSearchResult[]>([]);
  const [totalSessions, setTotalSessions] = useState(0);
  const [totalMatches, setTotalMatches] = useState(0);
  const [loading, setLoading] = useState(false);
  const [searched, setSearched] = useState(false);
  const [groupMode, setGroupMode] = useState<GroupMode>("branch");
  const [roleFilter, setRoleFilter] = useState<"all" | "user" | "assistant" | "tool">("all");
  const [minMatches, setMinMatches] = useState<number>(0);
  const [hasFiles, setHasFiles] = useState(false);
  const [branchFilter, setBranchFilter] = useState<string>("all");
  const inputRef = useRef<HTMLInputElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>();

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);

    if (query.trim().length < 2) {
      setResults([]);
      setFileResults([]);
      setTotalSessions(0);
      setTotalMatches(0);
      setSearched(false);
      return;
    }

    debounceRef.current = setTimeout(() => {
      setLoading(true);
      setSearched(true);

      if (tab === "messages") {
        fetch(`/api/search?q=${encodeURIComponent(query.trim())}&sort=${sort}`)
          .then((r) => r.json())
          .then((data) => {
            setResults(data.results || []);
            setTotalSessions(data.total_sessions || 0);
            setTotalMatches(data.total_matches || 0);
          })
          .catch(() => setResults([]))
          .finally(() => setLoading(false));
      } else {
        fetch(`/api/files/search?q=${encodeURIComponent(query.trim())}`)
          .then((r) => r.json())
          .then((data) => setFileResults(data.results || []))
          .catch(() => setFileResults([]))
          .finally(() => setLoading(false));
      }
    }, 300);

    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [query, tab, sort]);

  const handleTabChange = (newTab: "messages" | "files") => {
    setTab(newTab);
    setResults([]);
    setFileResults([]);
    setSearched(false);
  };

  const branches = [...new Set(results.map((r) => r.git_branch).filter(Boolean) as string[])].sort();

  const renderMessageResults = () => {
    // Apply client-side filters
    let filtered = results.filter((r) => {
      if (minMatches > 0 && r.match_count < minMatches) return false;
      if (hasFiles && (!r.files_changed || r.files_changed.length === 0)) return false;
      if (branchFilter !== "all" && (r.git_branch || "") !== branchFilter) return false;
      // Role filter: hide sessions where all matches are filtered out (unless file match)
      if (roleFilter !== "all" && r.match_source !== 'files') {
        const visibleMatches = r.matches.filter((m) => {
          if (roleFilter === "tool") return m.message_type !== 'text';
          if (roleFilter === "user") return m.role === "user" && m.message_type === 'text';
          return m.role === "assistant" && m.message_type === 'text';
        });
        if (visibleMatches.length === 0 && r.matches.length > 0) return false;
      }
      return true;
    });

    if (filtered.length === 0) {
      return <div style={{ textAlign: "center", padding: 24, fontSize: 13, color: "var(--text-secondary)" }}>No results match current filters</div>;
    }

    if (groupMode === "none") {
      return filtered.map((result) => (
        <SearchResultCard key={result.id} result={result} onNavigate={onNavigate} groupMode={groupMode} roleFilter={roleFilter} query={query} />
      ));
    }

    if (groupMode === "branch") {
      // Group by branch
      const groups = new Map<string, SearchResult[]>();
      for (const r of filtered) {
        const branch = r.git_branch || "Other";
        if (!groups.has(branch)) groups.set(branch, []);
        groups.get(branch)!.push(r);
      }

      // Sort groups by latest session date (most recent first), "Other" last
      const sortedGroups = Array.from(groups.entries()).sort((a, b) => {
        if (a[0] === "Other") return 1;
        if (b[0] === "Other") return -1;
        const aLatest = Math.max(...a[1].map((r) => new Date(r.started_at).getTime()));
        const bLatest = Math.max(...b[1].map((r) => new Date(r.started_at).getTime()));
        return bLatest - aLatest;
      });

      const elements: React.ReactNode[] = [];
      for (const [branch, sessions] of sortedGroups) {
        const totalMatchesInGroup = sessions.reduce((sum, s) => sum + s.match_count, 0);
        const latestDate = sessions.reduce((latest, s) =>
          new Date(s.started_at) > new Date(latest) ? s.started_at : latest,
          sessions[0].started_at
        );
        elements.push(
          <BranchGroupHeader
            key={`branch-${branch}`}
            branch={branch}
            sessionCount={sessions.length}
            matchCount={totalMatchesInGroup}
            latestDate={latestDate}
          />
        );
        for (const result of sessions) {
          elements.push(
            <SearchResultCard key={result.id} result={result} onNavigate={onNavigate} groupMode={groupMode} roleFilter={roleFilter} query={query} />
          );
        }
      }
      return elements;
    }

    // groupMode === "date"
    const elements: React.ReactNode[] = [];
    let lastGroup = "";
    for (const result of filtered) {
      const group = getDateGroup(result.started_at);
      if (group !== lastGroup) {
        elements.push(
          <div key={`date-${group}`} style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 0 6px", borderBottom: "1px solid var(--border)", marginBottom: 8, marginTop: 16 }}>
            <span style={{ fontSize: 11, fontWeight: 600, color: "var(--text-dim)", textTransform: "uppercase", letterSpacing: "0.05em" }}>{group}</span>
          </div>
        );
        lastGroup = group;
      }
      elements.push(
        <SearchResultCard key={result.id} result={result} onNavigate={onNavigate} groupMode={groupMode} roleFilter={roleFilter} query={query} />
      );
    }
    return elements;
  };

  return (
    <div className="fixed inset-0 bg-bg z-[100] flex flex-col" onClick={onClose}>
      <div className="w-full h-full bg-bg flex flex-col overflow-hidden" onClick={(e) => e.stopPropagation()}>
        {/* Search input */}
        <div className="flex items-center gap-3.5 px-8 py-5 border-b border-border bg-bg-card">
          <svg className="text-text-secondary shrink-0" width="18" height="18" viewBox="0 0 16 16" fill="none">
            <circle cx="7" cy="7" r="5.5" stroke="currentColor" strokeWidth="1.5" />
            <line x1="11" y1="11" x2="14.5" y2="14.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
          <input
            ref={inputRef}
            type="text"
            className="flex-1 bg-transparent border-none outline-none text-xl text-text font-[var(--font-ui)] placeholder:text-text-dim"
            placeholder={tab === "messages" ? "Search sessions..." : "Search files — use * and ? for globs (e.g. *blake.html)"}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") onClose();
            }}
          />
          <kbd className="font-mono text-[10px] px-1.5 py-0.5 bg-white/6 border border-border rounded-sm text-text-dim">Esc</kbd>
        </div>

        {/* Tabs */}
        <div className="flex items-center justify-between px-8 border-b border-border bg-bg-card">
          <div className="flex">
            <button
              className={`px-5 py-2.5 text-[13px] font-medium border-b-2 transition-all hover:text-text ${tab === "messages" ? "text-accent-blue border-b-accent-blue" : "text-text-secondary border-b-transparent"}`}
              onClick={() => handleTabChange("messages")}
            >
              Messages
            </button>
            <button
              className={`px-5 py-2.5 text-[13px] font-medium border-b-2 transition-all hover:text-text ${tab === "files" ? "text-accent-blue border-b-accent-blue" : "text-text-secondary border-b-transparent"}`}
              onClick={() => handleTabChange("files")}
            >
              Files
            </button>
          </div>
          <div className="flex items-center gap-3">
            {!loading && searched && tab === "files" && fileResults.length > 0 && (
              <span className="text-[11px] text-text-dim">
                {fileResults.length} file{fileResults.length !== 1 ? "s" : ""}
              </span>
            )}
          </div>
        </div>

        {/* Toolbar: counts + group toggle + sort + filters */}
        {!loading && searched && tab === "messages" && results.length > 0 && (
          <div style={{ padding: "12px 32px 0" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14, flexWrap: "wrap", gap: 8 }}>
              <div style={{ fontSize: 11, color: "var(--text-dim)" }}>
                <span style={{ fontWeight: 600, color: "var(--text-secondary)" }}>{totalSessions} sessions</span>
                {" \u00b7 "}{totalMatches} matches
                {branches.length > 0 && <> {"\u00b7"} {branches.length} branch{branches.length !== 1 ? "es" : ""}</>}
              </div>
              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <span style={{ fontSize: 11, color: "var(--text-dim)" }}>Group by:</span>
                <GroupToggle value={groupMode} onChange={setGroupMode} />
                <SortDropdown value={sort} onChange={setSort} />
              </div>
            </div>
            <FilterBar
              roleFilter={roleFilter} setRoleFilter={setRoleFilter}
              minMatches={minMatches} setMinMatches={setMinMatches}
              hasFiles={hasFiles} setHasFiles={setHasFiles}
              branchFilter={branchFilter} setBranchFilter={setBranchFilter}
              branches={branches}
            />
          </div>
        )}

        {/* Results */}
        <div className="flex-1 overflow-y-auto px-8 py-4">
          {loading && (
            <div className="flex items-center justify-center gap-2 p-6 text-[13px] text-text-secondary">
              <div className="spinner small" />
              <span>Searching...</span>
            </div>
          )}

          {!loading && searched && tab === "messages" && results.length === 0 && (
            <div className="flex items-center justify-center gap-2 p-6 text-[13px] text-text-secondary">No results found for &quot;{query}&quot;</div>
          )}

          {!loading && searched && tab === "files" && fileResults.length === 0 && (
            <div className="flex items-center justify-center gap-2 p-6 text-[13px] text-text-secondary">No files found matching &quot;{query}&quot;</div>
          )}

          {/* Message results */}
          {!loading && tab === "messages" && (
            <div className="search-results max-w-[1200px]">
              {renderMessageResults()}
            </div>
          )}

          {/* File results */}
          {!loading && tab === "files" && fileResults.length > 0 && (() => {
            const cats = categorizeFileRefs(fileResults.map(f => ({ ...f, file_path: f.file_path })));
            const sections: Array<{ key: string; label: string; cls: string; files: FileSearchResult[] }> = [];
            if (cats.docs.length > 0) sections.push({ key: "docs", label: "Docs", cls: "file-cat-docs", files: cats.docs as FileSearchResult[] });
            if (cats.viz.length > 0) sections.push({ key: "viz", label: "Viz", cls: "file-cat-viz", files: cats.viz as FileSearchResult[] });
            if (cats.code.length > 0) sections.push({ key: "code", label: "Code", cls: "file-cat-code", files: cats.code as FileSearchResult[] });

            return sections.map(({ key, label, cls, files }) => (
              <div key={key} className="mb-5">
                <div className="flex items-center gap-2 mb-2">
                  <span className={`${cls} inline-block px-2 py-0.5 rounded text-[11px] font-semibold uppercase tracking-wide`}>{label}</span>
                  <span className="text-[11px] text-text-dim">{files.length} files</span>
                </div>
                {files.map((file, i) => (
                  <button
                    key={`${file.file_path}-${file.operation}-${i}`}
                    className="block w-full text-left px-3.5 py-3 mb-1 bg-bg-card border border-border rounded-lg transition-all hover:border-accent-blue hover:bg-[rgba(22,27,34,0.8)]"
                    onClick={() => {
                      onClose();
                      onNavigate(`/file?path=${encodeURIComponent(file.file_path)}`);
                    }}
                  >
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-semibold text-text font-mono">{file.file_name}</span>
                      <span className={`operation-badge operation-${file.operation} inline-block px-2 py-px rounded-full text-[10px] font-semibold uppercase tracking-wide`}>
                        {file.operation}
                      </span>
                    </div>
                    <div className="text-xs font-mono text-text-dim mt-0.5 overflow-hidden text-ellipsis whitespace-nowrap">{file.file_path}</div>
                    <div className="flex gap-3 mt-1.5 text-[11px] text-text-secondary">
                      <span>{file.session_count} session{file.session_count !== 1 ? "s" : ""}</span>
                      {file.last_seen && (
                        <span>Last seen {formatDate(file.last_seen)}</span>
                      )}
                    </div>
                  </button>
                ))}
              </div>
            ));
          })()}
        </div>
      </div>
    </div>
  );
}
