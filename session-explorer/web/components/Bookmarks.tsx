import { useState, useEffect } from "react";
import { useNavigate } from "@tanstack/react-router";
import type { SessionSummary, Tag } from "../types";

function formatDate(dateStr: string): string {
  return new Date(dateStr).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

type BookmarkedSession = SessionSummary & { workspace_name?: string };

export default function Bookmarks() {
  const navigate = useNavigate();
  const [sessions, setSessions] = useState<BookmarkedSession[]>([]);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    setNotFound(false);
    setError(null);
    fetch("/api/tags/by-name/bookmarked/sessions")
      .then((r) => {
        if (r.status === 404) {
          setNotFound(true);
          return null;
        }
        if (!r.ok) throw new Error(`Request failed: ${r.status}`);
        return r.json();
      })
      .then((data: { tag: Tag; sessions: BookmarkedSession[] } | null) => {
        if (data) setSessions(data.sessions);
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 p-15 text-text-secondary">
        <div className="spinner" />
        <span>Loading bookmarks...</span>
      </div>
    );
  }

  if (error) {
    return <div className="flex items-center justify-center px-5 py-15 text-text-secondary text-sm">Failed to load bookmarks: {error}</div>;
  }

  return (
    <div className="px-10 py-8 max-w-[900px]">
      <h1 className="text-[22px] font-semibold mb-1">Bookmarks</h1>
      <p className="text-[13px] text-text-secondary mb-6">
        {notFound || sessions.length === 0 ? "0 sessions" : `${sessions.length} sessions`}
      </p>

      {(notFound || sessions.length === 0) ? (
        <div className="flex items-center justify-center px-5 py-15 text-text-secondary text-sm">
          No sessions bookmarked yet — use /save-session
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {sessions.map((session) => (
            <div
              key={session.id}
              className="bg-bg-card border border-border rounded-lg px-4 py-3 transition-all hover:border-accent-blue hover:bg-[rgba(22,27,34,0.8)] cursor-pointer"
              onClick={() => navigate({ to: "/session/$id", params: { id: session.id } })}
            >
              <div className="flex items-center justify-between gap-3">
                <span className="font-mono text-[11px] text-text-secondary">{formatDate(session.started_at)}</span>
                <div className="flex items-center gap-1.5 shrink-0">
                  {session.workspace_name && (
                    <span className="inline-block px-2 py-px rounded-full font-mono text-[10px] bg-white/6 text-text-secondary whitespace-nowrap overflow-hidden text-ellipsis max-w-[160px]">
                      {session.workspace_name}
                    </span>
                  )}
                  {session.git_branch && (
                    <span className="inline-block px-2 py-px rounded-full font-mono text-[10px] bg-accent-purple/12 text-accent-purple whitespace-nowrap overflow-hidden text-ellipsis max-w-[160px]">
                      {session.git_branch}
                    </span>
                  )}
                </div>
              </div>

              {session.note ? (
                <p className="mt-1.5 text-[13px] leading-[1.5] text-text font-semibold">
                  &ldquo;{session.note}&rdquo;
                </p>
              ) : null}

              {session.summary_short ? (
                <p className={`text-[12px] leading-[1.5] text-text-secondary ${session.note ? "mt-1" : "mt-1.5"}`}>
                  {session.summary_short}
                </p>
              ) : !session.note ? (
                <p className="mt-1.5 text-[12px] text-text-dim italic">No summary available</p>
              ) : null}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
