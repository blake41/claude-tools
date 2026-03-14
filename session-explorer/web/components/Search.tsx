import { useState, useEffect, useRef } from "react";
import type { SearchResult, FileSearchResult } from "../types";
import { categorizeFileRefs } from "../fileCategories";

interface SearchProps {
  onClose: () => void;
  onNavigate: (path: string) => void;
}

type SearchTab = "messages" | "files";

function formatDate(dateStr: string): string {
  return new Date(dateStr).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

/** Render snippet HTML with <mark> highlights from FTS5 snippet() */
function SnippetText({ snippet }: { snippet: string }) {
  // Server sends ‹mark› and ‹/mark› as highlight delimiters (avoids HTML injection)
  const parts = snippet.split(/‹\/?mark›/);
  if (parts.length === 1) {
    return <span>{snippet}</span>;
  }
  // Odd-indexed parts are highlighted
  return (
    <span>
      {parts.map((part, i) =>
        i % 2 === 1 ? (
          <mark key={i} className="bg-accent-orange/20 text-text rounded-sm px-0.5">{part}</mark>
        ) : (
          <span key={i}>{part}</span>
        )
      )}
    </span>
  );
}

export default function Search({ onClose, onNavigate }: SearchProps) {
  const [query, setQuery] = useState("");
  const [tab, setTab] = useState<SearchTab>("messages");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [fileResults, setFileResults] = useState<FileSearchResult[]>([]);
  const [totalSessions, setTotalSessions] = useState(0);
  const [totalMatches, setTotalMatches] = useState(0);
  const [expandedSessions, setExpandedSessions] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const [searched, setSearched] = useState(false);
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
      setExpandedSessions(new Set());

      if (tab === "messages") {
        fetch(`/api/search?q=${encodeURIComponent(query.trim())}`)
          .then((r) => r.json())
          .then((data) => {
            const mapped = (data.results || []).map((r: Record<string, unknown>) => ({
              session_id: r.session_id,
              session_title: r.title,
              started_at: r.started_at,
              match_count: r.match_count ?? 0,
              matches: (r.matches as Array<Record<string, unknown>> || []).map((m) => ({
                message_id: m.sequence,
                role: m.role,
                snippet: m.snippet,
                sequence: m.sequence,
              })),
            }));
            setResults(mapped as SearchResult[]);
            setTotalSessions(data.total_sessions || 0);
            setTotalMatches(data.total_matches || 0);
          })
          .catch(() => setResults([]))
          .finally(() => setLoading(false));
      } else {
        fetch(`/api/files/search?q=${encodeURIComponent(query.trim())}`)
          .then((r) => r.json())
          .then((data) => {
            setFileResults(data.results || []);
          })
          .catch(() => setFileResults([]))
          .finally(() => setLoading(false));
      }
    }, 300);

    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [query, tab]);

  const handleTabChange = (newTab: SearchTab) => {
    setTab(newTab);
    setResults([]);
    setFileResults([]);
    setSearched(false);
  };

  const toggleExpanded = (sessionId: string) => {
    setExpandedSessions(prev => {
      const next = new Set(prev);
      if (next.has(sessionId)) next.delete(sessionId);
      else next.add(sessionId);
      return next;
    });
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
            placeholder={tab === "messages" ? "Search sessions..." : "Search files by name or path..."}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") onClose();
            }}
          />
          <kbd className="font-mono text-[10px] px-1.5 py-0.5 bg-white/6 border border-border rounded-sm text-text-dim">Esc</kbd>
        </div>

        {/* Tabs + result count */}
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
          {/* Result count */}
          {!loading && searched && tab === "messages" && results.length > 0 && (
            <span className="text-[11px] text-text-dim">
              {totalMatches} match{totalMatches !== 1 ? "es" : ""} in {totalSessions} session{totalSessions !== 1 ? "s" : ""}
            </span>
          )}
          {!loading && searched && tab === "files" && fileResults.length > 0 && (
            <span className="text-[11px] text-text-dim">
              {fileResults.length} file{fileResults.length !== 1 ? "s" : ""}
            </span>
          )}
        </div>

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

          {/* Message results — grouped by session */}
          {!loading && tab === "messages" &&
            results.map((result) => {
              const hiddenCount = result.match_count - result.matches.length;
              const isExpanded = expandedSessions.has(result.session_id);
              return (
                <div key={result.session_id} className="mb-3">
                  {/* Session header */}
                  <button
                    className="flex items-center justify-between w-full px-3 py-2 rounded-lg transition-[background] duration-100 hover:bg-white/5 group"
                    onClick={() => onNavigate(`/session/${result.session_id}?msg=${result.matches[0]?.sequence ?? 0}`)}
                  >
                    <div className="flex items-center gap-2.5 min-w-0">
                      <span className="text-[14px] font-semibold text-text truncate">
                        {result.session_title || "Untitled session"}
                      </span>
                      <span className="shrink-0 text-[10px] font-medium text-text-dim bg-white/6 rounded-full px-2 py-0.5">
                        {result.match_count} match{result.match_count !== 1 ? "es" : ""}
                      </span>
                    </div>
                    <span className="text-[11px] font-mono text-text-dim shrink-0 ml-3">{formatDate(result.started_at)}</span>
                  </button>

                  {/* Match snippets with left border for grouping */}
                  <div className="ml-3 border-l-2 border-white/8 pl-3">
                    {result.matches.map((match, i) => (
                      <button
                        key={i}
                        className="flex items-start gap-2.5 w-full px-2 py-1.5 rounded transition-[background] duration-100 hover:bg-white/4 text-left"
                        onClick={() => onNavigate(`/session/${result.session_id}?msg=${match.sequence}`)}
                      >
                        <span className={`text-[10px] font-semibold uppercase tracking-wide shrink-0 mt-0.5 w-[42px] ${match.role === "user" ? "text-accent-blue" : "text-claude-text"}`}>
                          {match.role === "user" ? "You" : "Claude"}
                        </span>
                        <span className="text-[12px] text-text-secondary leading-relaxed line-clamp-2">
                          <SnippetText snippet={match.snippet} />
                        </span>
                      </button>
                    ))}
                    {/* +N more matches */}
                    {hiddenCount > 0 && !isExpanded && (
                      <button
                        className="px-2 py-1 text-[11px] text-accent-blue hover:text-text transition-colors"
                        onClick={(e) => { e.stopPropagation(); toggleExpanded(result.session_id); }}
                      >
                        +{hiddenCount} more match{hiddenCount !== 1 ? "es" : ""}
                      </button>
                    )}
                  </div>
                </div>
              );
            })}

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
