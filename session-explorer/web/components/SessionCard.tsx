import { useNavigate } from "@tanstack/react-router";
import type { SessionSummary, Tag, ChangedFile } from "../types";
import { categorizeFileRefs } from "../fileCategories";
import SessionHeader from "./SessionHeader";

function basename(path: string): string {
  return path.split("/").pop() || path;
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
  showLastMessage?: boolean;
}

export default function SessionCard({ session, onTagsChange, showLastMessage }: SessionCardProps) {
  const navigate = useNavigate();

  return (
    <div className="session-row">
      <button
        className="session-row-card block w-full text-left bg-bg-card border border-border rounded-lg px-4 py-3.5 transition-all hover:border-accent-blue hover:bg-[rgba(22,27,34,0.8)]"
        onClick={() => navigate({ to: "/session/$id", params: { id: session.id } })}
      >
        <SessionHeader
          session={session}
          onTagsChange={onTagsChange ? (newTags) => onTagsChange(session.id, newTags) : undefined}
          activityMode={showLastMessage}
        />
        {showLastMessage && session.last_user_message && (
          <div className="mt-2 flex items-start gap-2">
            <div className="shrink-0 mt-0.5 w-1 h-full min-h-[16px] rounded-full bg-[#f0883e]/60" />
            <div className="min-w-0">
              {session.last_user_message_at && (
                <span className="text-[10px] font-mono text-[#f0883e]/70 mr-1">
                  {new Date(session.last_user_message_at).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true })}
                </span>
              )}
              <p className="text-[12px] text-[#f0883e] leading-relaxed line-clamp-2">
                {session.last_user_message.length > 200
                  ? session.last_user_message.slice(0, 200) + "..."
                  : session.last_user_message}
              </p>
            </div>
          </div>
        )}
      </button>
      <div className={`session-row-files${!session.files_changed?.length ? " session-row-files--empty" : ""}`}>
        <FileCategoryPills files={session.files_changed || []} />
      </div>
    </div>
  );
}
