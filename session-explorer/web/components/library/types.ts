export type LibraryType = "skill" | "agent" | "command" | "rule" | "claude-md" | "hook";

export type LibraryScope =
  | { kind: "global" }
  | { kind: "plugin"; name: string }
  | { kind: "project"; workspacePath: string; workspaceName: string };

export interface ThinWrapper {
  targetType: "skill";
  targetName: string;
  targetId: string | null;
  match: string;
}

export interface ArtifactReference {
  targetType: LibraryType;
  targetName: string;
  targetId: string;
}

export interface LibraryListItem {
  id: string;
  type: LibraryType;
  scope: LibraryScope;
  name: string;
  namespace: string | null;
  displayName: string;
  sourcePath: string;
  description: string | null;
  created: string;
  inspiration: string | null;
  thinWrapper: ThinWrapper | null;
  references: ArtifactReference[];
  referencedByList: ArtifactReference[];
  parseError?: string;
  total_invocations?: number;
  // One-hop transitive credit: invocations of artifacts whose body
  // references this one. Useful for orchestration commands that never get
  // typed directly (e.g. /architect-tasks invoked inside /ship's body).
  indirect_invocations?: number;
  last_used?: string | null;
}

export interface LibraryArtifact extends LibraryListItem {
  frontmatter: Record<string, unknown>;
  body: string;
  siblings?: LibraryListItem[];
  wrappedBy?: LibraryListItem[];
  referencedBy?: LibraryListItem[];
}

export interface LibraryListResponse {
  items: LibraryListItem[];
  total: number;
  facets: {
    type: Record<string, number>;
    scope: Record<string, number>;
    namespace: Record<string, number>;
    noNamespace: number;
  };
  status: { count: number; lastScanAt: string | null; durationMs: number };
}

// Sentinel used in the `ns` query param to filter to artifacts that have no
// namespace at all. The API recognizes this string explicitly.
export const NO_NAMESPACE = "__none__";

// Color buckets for namespace badges — picked deterministically by hashing the
// namespace name so the same namespace always renders the same color.
const NS_BADGE_COLORS = [
  "bg-fuchsia-500/15 text-fuchsia-300 border-fuchsia-500/30",
  "bg-cyan-500/15 text-cyan-300 border-cyan-500/30",
  "bg-amber-500/15 text-amber-400 border-amber-500/30",
  "bg-emerald-500/15 text-emerald-400 border-emerald-500/30",
  "bg-rose-500/15 text-rose-400 border-rose-500/30",
  "bg-blue-500/15 text-blue-300 border-blue-500/30",
  "bg-violet-500/15 text-violet-300 border-violet-500/30",
  "bg-teal-500/15 text-teal-300 border-teal-500/30",
  "bg-indigo-500/15 text-indigo-300 border-indigo-500/30",
  "bg-lime-500/15 text-lime-300 border-lime-500/30",
];

export function namespaceBadgeColor(ns: string): string {
  let h = 0;
  for (let i = 0; i < ns.length; i++) h = (h * 31 + ns.charCodeAt(i)) | 0;
  return NS_BADGE_COLORS[Math.abs(h) % NS_BADGE_COLORS.length];
}

export interface UsageSession {
  session_id: string;
  title: string | null;
  count: number;
  last_used: string | null;
  workspace_name: string | null;
  workspace_path: string | null;
  started_at: string | null;
}

export type UsageResult =
  | {
      kind: "stats";
      total_invocations: number;
      last_used: string | null;
      top_sessions: UsageSession[];
      daily_buckets: Array<{ day: string; count: number }>;
    }
  | { kind: "always-on" };

export function scopeLabel(scope: LibraryScope): string {
  if (scope.kind === "global") return "global";
  if (scope.kind === "plugin") return `plugin:${scope.name}`;
  return `project:${scope.workspaceName}`;
}

export function typeBadgeColor(type: LibraryType): string {
  switch (type) {
    case "skill":
      return "bg-accent-purple/15 text-accent-purple border-accent-purple/30";
    case "agent":
      return "bg-accent-blue/15 text-accent-blue border-accent-blue/30";
    case "command":
      return "bg-emerald-500/15 text-emerald-400 border-emerald-500/30";
    case "rule":
      return "bg-amber-500/15 text-amber-400 border-amber-500/30";
    case "claude-md":
      return "bg-rose-500/15 text-rose-400 border-rose-500/30";
    case "hook":
      return "bg-zinc-500/20 text-zinc-300 border-zinc-500/30";
  }
}

export function scopeBadgeColor(scope: LibraryScope): string {
  switch (scope.kind) {
    case "global":
      return "bg-white/8 text-text-secondary border-border/50";
    case "plugin":
      return "bg-fuchsia-500/15 text-fuchsia-300 border-fuchsia-500/30";
    case "project":
      return "bg-cyan-500/15 text-cyan-300 border-cyan-500/30";
  }
}

export function formatRelative(ts: string | null | undefined): string {
  if (!ts) return "Never";
  const d = new Date(ts);
  const now = Date.now();
  const diff = now - d.getTime();
  const m = Math.floor(diff / 60_000);
  if (m < 1) return "Just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const days = Math.floor(h / 24);
  if (days < 7) return `${days}d ago`;
  if (days < 30) return `${Math.floor(days / 7)}w ago`;
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}
