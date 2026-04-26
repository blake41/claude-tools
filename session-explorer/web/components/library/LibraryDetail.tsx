import { useEffect, useState } from "react";
import { Link, useParams } from "@tanstack/react-router";
import { libraryDetailRoute } from "../../router";
import { renderMarkdown } from "../../sessionFormat";
import {
  type LibraryArtifact,
  type LibraryListItem,
  type UsageResult,
  formatRelative,
  namespaceBadgeColor,
  scopeBadgeColor,
  scopeLabel,
  typeBadgeColor,
} from "./types";
import UsageSparkline from "./UsageSparkline";

const EDITOR_SCHEME =
  (typeof window !== "undefined" && (window as { LIBRARY_EDITOR_SCHEME?: string }).LIBRARY_EDITOR_SCHEME) || "cursor";

export default function LibraryDetail() {
  const { id: rawId } = useParams({ from: libraryDetailRoute.id });
  const id = decodeURIComponent(rawId);
  const [artifact, setArtifact] = useState<LibraryArtifact | null>(null);
  const [usage, setUsage] = useState<UsageResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    setError(null);
    fetch(`/api/library/${encodeURIComponent(id)}`)
      .then((r) => {
        if (!r.ok) throw new Error(r.status === 404 ? "not found" : `HTTP ${r.status}`);
        return r.json();
      })
      .then((d: LibraryArtifact) => setArtifact(d))
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));

    fetch(`/api/library/${encodeURIComponent(id)}/usage`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => setUsage(d))
      .catch(() => setUsage(null));
  }, [id]);

  function handleShowInFinder() {
    if (!artifact) return;
    fetch("/api/library/show-in-finder", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: artifact.sourcePath }),
    }).catch(() => {});
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20 text-text-secondary text-sm">
        <div className="spinner mr-3" /> Loading artifact…
      </div>
    );
  }

  if (error || !artifact) {
    return (
      <div className="px-10 py-8">
        <Link to="/library" className="text-accent-purple hover:underline text-[13px]">
          ← Back to library
        </Link>
        <p className="mt-4 text-text-secondary">Artifact not found.</p>
      </div>
    );
  }

  const editorHref = `${EDITOR_SCHEME}://file${artifact.sourcePath}`;
  const isHook = artifact.type === "hook";

  // Frontmatter table rows (skip body-derived/internal fields if any)
  const fmEntries = Object.entries(artifact.frontmatter).filter(([k]) => k !== "");

  return (
    <div className="px-10 py-8 max-w-[1100px] mx-auto">
      <Link to="/library" className="inline-flex items-center gap-1.5 text-[13px] text-text-secondary hover:text-text mb-4">
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
          <path d="M10 12L6 8L10 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        Back to library
      </Link>

      {/* Header */}
      <div className="flex flex-wrap items-baseline gap-3 mb-2">
        <h1 className="text-[24px] font-semibold tracking-tight text-text">{artifact.displayName}</h1>
        <span
          className={`inline-block px-2 py-0.5 text-[11px] rounded border font-medium uppercase tracking-wider ${typeBadgeColor(artifact.type)}`}
        >
          {artifact.type}
        </span>
        <span
          className={`inline-block px-2 py-0.5 text-[11px] rounded border font-medium ${scopeBadgeColor(artifact.scope)}`}
        >
          {scopeLabel(artifact.scope)}
        </span>
        {artifact.namespace && (
          <span
            className={`inline-block px-2 py-0.5 text-[11px] rounded border font-mono uppercase tracking-wider ${namespaceBadgeColor(artifact.namespace)}`}
            title={`Namespace: ${artifact.namespace}`}
          >
            {artifact.namespace}
          </span>
        )}
      </div>

      {artifact.description && (
        <p className="text-[14px] text-text-secondary mb-3">{artifact.description}</p>
      )}

      {artifact.thinWrapper && (
        <div className="mb-3 px-3 py-2.5 bg-accent-purple/5 border border-accent-purple/25 rounded-md flex items-center gap-2.5">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" className="text-accent-purple shrink-0">
            <path d="M3 8h10M9 4l4 4-4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          <div className="text-[12px] text-text-secondary flex-1">
            Thin wrapper — delegates to skill{" "}
            {artifact.thinWrapper.targetId ? (
              <Link
                to="/library/$id"
                params={{ id: artifact.thinWrapper.targetId }}
                className="font-mono text-accent-purple hover:underline"
              >
                {artifact.thinWrapper.targetName}
              </Link>
            ) : (
              <span className="font-mono text-accent-purple/70" title="Target skill not found in library">
                {artifact.thinWrapper.targetName}
              </span>
            )}
            <div className="text-[11px] text-text-dim mt-0.5 italic line-clamp-1">"{artifact.thinWrapper.match}"</div>
          </div>
        </div>
      )}

      <p className="font-mono text-[11px] text-text-dim mb-3">{artifact.sourcePath}</p>

      {/* Action buttons */}
      <div className="flex gap-2 mb-5">
        <a
          href={editorHref}
          className="inline-block px-3 py-1.5 text-[12px] text-accent-blue bg-accent-blue/10 border border-accent-blue/30 rounded-md no-underline transition-all hover:bg-accent-blue/20 hover:no-underline"
        >
          Open in editor
        </a>
        <button
          className="inline-block px-3 py-1.5 text-[12px] text-text-secondary bg-white/5 border border-border/40 rounded-md transition-all hover:bg-white/10 hover:text-text"
          onClick={handleShowInFinder}
        >
          Show in Finder
        </button>
        <button
          className="inline-block px-3 py-1.5 text-[12px] text-text-secondary bg-white/5 border border-border/40 rounded-md transition-all hover:bg-white/10 hover:text-text"
          onClick={() => navigator.clipboard.writeText(artifact.sourcePath)}
        >
          Copy path
        </button>
      </div>

      {artifact.parseError && (
        <div className="mb-4 px-3 py-2 bg-amber-500/10 border border-amber-500/30 rounded-md text-[12px] text-amber-300">
          <strong className="font-semibold">Frontmatter parse error:</strong> {artifact.parseError}
        </div>
      )}

      {/* Frontmatter table */}
      {!isHook && fmEntries.length > 0 && (
        <section className="mb-6 bg-white/3 border border-border/30 rounded-lg overflow-hidden">
          <table className="w-full text-[12px]">
            <tbody>
              {fmEntries.map(([key, value]) => (
                <tr key={key} className="border-b border-border/20 last:border-b-0">
                  <td className="px-3 py-2 font-mono text-text-dim w-[180px] align-top">{key}</td>
                  <td className="px-3 py-2 text-text font-mono whitespace-pre-wrap break-words">
                    {formatFmValue(value)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {/* Body */}
      <section className="mb-8">
        {isHook ? (
          <>
            <p className="text-[12px] text-text-dim mb-2">
              Hook script — runs as part of the Claude Code harness, not invoked through messages.
            </p>
            <pre className="text-[12px] bg-bg-card border border-border/40 rounded-lg p-4 overflow-x-auto whitespace-pre text-text">
              {artifact.body}
            </pre>
          </>
        ) : (
          <div
            className="message-body"
            dangerouslySetInnerHTML={{ __html: `<p>${renderMarkdown(artifact.body)}</p>` }}
          />
        )}
      </section>

      {/* Usage panel */}
      <section className="border-t border-border/40 pt-6">
        <h2 className="text-[12px] font-semibold uppercase tracking-wider text-text-dim mb-3">Usage</h2>
        {usage == null ? (
          <p className="text-[12px] text-text-dim">Loading usage…</p>
        ) : usage.kind === "always-on" ? (
          <p className="text-[13px] text-text-secondary">
            <span className="font-semibold text-text">Always-on.</span> Applied to every session.
          </p>
        ) : (
          <UsagePanel usage={usage} />
        )}
      </section>

      {artifact.siblings && artifact.siblings.length > 0 && (
        <section className="border-t border-border/40 pt-6 mt-6">
          <h2 className="text-[12px] font-semibold uppercase tracking-wider text-text-dim mb-3">
            Namespace siblings
            <span className="ml-1.5 text-text-dim normal-case font-normal tracking-normal">
              ({artifact.siblings.length} other {artifact.type}
              {artifact.siblings.length === 1 ? "" : "s"} in <span className="font-mono">{artifact.namespace}</span>)
            </span>
          </h2>
          <SiblingList items={artifact.siblings} />
        </section>
      )}

      {artifact.wrappedBy && artifact.wrappedBy.length > 0 && (
        <section className="border-t border-border/40 pt-6 mt-6">
          <h2 className="text-[12px] font-semibold uppercase tracking-wider text-text-dim mb-3">
            Wrapped by
            <span className="ml-1.5 text-text-dim normal-case font-normal tracking-normal">
              ({artifact.wrappedBy.length} command{artifact.wrappedBy.length === 1 ? "" : "s"} delegate to this skill)
            </span>
          </h2>
          <SiblingList items={artifact.wrappedBy} />
        </section>
      )}
    </div>
  );
}

function SiblingList({ items }: { items: LibraryListItem[] }) {
  return (
    <ul className="grid grid-cols-1 sm:grid-cols-2 gap-1.5">
      {items.map((item) => (
        <li key={item.id}>
          <Link
            to="/library/$id"
            params={{ id: item.id }}
            className="flex items-center justify-between gap-3 px-3 py-2 bg-white/3 border border-border/30 rounded-md no-underline text-text hover:bg-white/8 hover:no-underline"
          >
            <div className="min-w-0 flex-1">
              <div className="text-[13px] truncate font-medium">{item.displayName}</div>
              {item.description && (
                <div className="text-[11px] text-text-dim truncate">{item.description}</div>
              )}
            </div>
            <span
              className={`shrink-0 inline-block px-1.5 py-0.5 text-[10px] rounded border font-medium uppercase tracking-wider ${typeBadgeColor(item.type)}`}
            >
              {item.type}
            </span>
          </Link>
        </li>
      ))}
    </ul>
  );
}

function formatFmValue(value: unknown): string {
  if (value == null) return "—";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value, null, 2);
}

function UsagePanel({ usage }: { usage: Extract<UsageResult, { kind: "stats" }> }) {
  if (usage.total_invocations === 0) {
    return <p className="text-[13px] text-text-secondary">Never used.</p>;
  }
  return (
    <div>
      <div className="flex items-baseline gap-6 mb-4">
        <div>
          <div className="text-[24px] font-semibold text-text">{usage.total_invocations}</div>
          <div className="text-[11px] text-text-dim uppercase tracking-wider">invocations</div>
        </div>
        <div>
          <div className="text-[14px] text-text">{formatRelative(usage.last_used)}</div>
          <div className="text-[11px] text-text-dim uppercase tracking-wider">last used</div>
        </div>
      </div>

      <div className="mb-5">
        <div className="text-[11px] text-text-dim uppercase tracking-wider mb-2">Last 90 days</div>
        <UsageSparkline buckets={usage.daily_buckets} />
      </div>

      {usage.top_sessions.length > 0 && (
        <div>
          <div className="text-[11px] text-text-dim uppercase tracking-wider mb-2">Top sessions</div>
          <ul className="flex flex-col gap-1.5">
            {usage.top_sessions.map((s) => (
              <li key={s.session_id}>
                <Link
                  to="/session/$id"
                  params={{ id: s.session_id }}
                  className="flex items-center justify-between gap-3 px-3 py-2 bg-white/3 border border-border/30 rounded-md no-underline text-text hover:bg-white/8 hover:no-underline"
                >
                  <div className="min-w-0 flex-1">
                    <div className="text-[13px] truncate">{s.title || "Untitled session"}</div>
                    <div className="text-[11px] text-text-dim truncate">
                      {s.workspace_name ?? "—"}
                      {s.last_used ? ` · ${formatRelative(s.last_used)}` : ""}
                    </div>
                  </div>
                  <span className="text-[12px] text-accent-purple font-mono shrink-0">{s.count}×</span>
                </Link>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
