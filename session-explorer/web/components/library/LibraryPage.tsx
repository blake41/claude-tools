import { useEffect, useState, useMemo } from "react";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { libraryRoute } from "../../router";
import {
  type LibraryListItem,
  type LibraryListResponse,
  type LibraryType,
  HAS_INSPIRATION,
  NO_NAMESPACE,
  formatRelative,
  namespaceBadgeColor,
  scopeBadgeColor,
  scopeLabel,
  typeBadgeColor,
} from "./types";

const TYPE_ORDER: LibraryType[] = ["skill", "agent", "command", "rule", "claude-md", "hook"];

export default function LibraryPage() {
  const search = useSearch({ from: libraryRoute.id });
  const navigate = useNavigate();
  const [data, setData] = useState<LibraryListResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [rescanning, setRescanning] = useState(false);
  const [qInput, setQInput] = useState(search.q ?? "");

  const sort = search.sort ?? "last_used";
  const includePlugins = !!search.include_plugins;

  // Debounce q input
  useEffect(() => {
    const handle = setTimeout(() => {
      if (qInput !== (search.q ?? "")) {
        navigate({
          to: "/library",
          search: { ...search, q: qInput || undefined },
          replace: true,
        });
      }
    }, 250);
    return () => clearTimeout(handle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [qInput]);

  useEffect(() => {
    setQInput(search.q ?? "");
  }, [search.q]);

  useEffect(() => {
    setLoading(true);
    const params = new URLSearchParams();
    if (search.type) params.set("type", search.type);
    if (search.scope) params.set("scope", search.scope);
    if (search.ns) params.set("ns", search.ns);
    if (search.inspiration) params.set("inspiration", search.inspiration);
    if (search.q) params.set("q", search.q);
    if (sort) params.set("sort", sort);
    if (includePlugins) params.set("include_plugins", "1");
    fetch(`/api/library?${params.toString()}`)
      .then((r) => r.json())
      .then((d: LibraryListResponse) => setData(d))
      .catch(() => setData(null))
      .finally(() => setLoading(false));
  }, [search.type, search.scope, search.ns, search.inspiration, search.q, sort, includePlugins]);

  function setSearchParam(patch: Partial<typeof search>) {
    navigate({
      to: "/library",
      search: { ...search, ...patch },
      replace: true,
    });
  }

  function setSort(next: string) {
    setSearchParam({ sort: next });
  }

  function handleRescan() {
    setRescanning(true);
    fetch("/api/library/rescan", { method: "POST" })
      .then(() => {
        // Re-fetch list
        const params = new URLSearchParams();
        if (search.type) params.set("type", search.type);
        if (search.scope) params.set("scope", search.scope);
        if (search.ns) params.set("ns", search.ns);
        if (search.inspiration) params.set("inspiration", search.inspiration);
        if (search.q) params.set("q", search.q);
        if (sort) params.set("sort", sort);
        if (includePlugins) params.set("include_plugins", "1");
        return fetch(`/api/library?${params.toString()}`).then((r) => r.json());
      })
      .then((d: LibraryListResponse) => setData(d))
      .finally(() => setRescanning(false));
  }

  const namespaces = useMemo(() => {
    if (!data) return [] as Array<{ name: string; count: number }>;
    return Object.entries(data.facets.namespace)
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count);
  }, [data]);

  const inspirations = data?.facets.inspiration ?? [];

  return (
    <div className="flex h-full">
      {/* Filters sidebar */}
      <aside className="w-[220px] min-w-[220px] border-r border-border/40 px-4 py-5 overflow-y-auto bg-[#0c0c12]">
        <div className="mb-5">
          <h2 className="text-[18px] font-semibold tracking-tight text-text mb-1">Library</h2>
          <p className="text-[11px] text-text-dim">
            {data?.status.count ?? "…"} artifacts
            {data?.status.lastScanAt ? ` · scanned ${formatRelative(data.status.lastScanAt)}` : ""}
          </p>
          <button
            className="mt-2 inline-flex items-center gap-1.5 text-[11px] text-text-dim hover:text-text transition-colors disabled:opacity-50"
            onClick={handleRescan}
            disabled={rescanning}
          >
            <svg width="11" height="11" viewBox="0 0 16 16" fill="none" className={rescanning ? "animate-spin" : ""}>
              <path d="M13.65 2.35A8 8 0 103.34 13.66M13.65 2.35V6.5M13.65 2.35H9.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            {rescanning ? "Rescanning…" : "Rescan"}
          </button>
        </div>

        <FilterGroup label="Type">
          <FilterChip
            active={!search.type}
            onClick={() => setSearchParam({ type: undefined })}
            label="All"
            count={data ? Object.values(data.facets.type).reduce((s, n) => s + n, 0) : null}
          />
          {TYPE_ORDER.map((t) => {
            const c = data?.facets.type[t];
            if (!c) return null;
            return (
              <FilterChip
                key={t}
                active={search.type === t}
                onClick={() => setSearchParam({ type: t })}
                label={t}
                count={c}
              />
            );
          })}
        </FilterGroup>

        <FilterGroup label="Scope">
          <FilterChip
            active={!search.scope}
            onClick={() => setSearchParam({ scope: undefined })}
            label="All"
            count={data ? Object.values(data.facets.scope).reduce((s, n) => s + n, 0) : null}
          />
          {(["global", "plugin", "project"] as const).map((s) => {
            const c = data?.facets.scope[s];
            if (!c) return null;
            return (
              <FilterChip
                key={s}
                active={search.scope === s}
                onClick={() => setSearchParam({ scope: s })}
                label={s}
                count={c}
              />
            );
          })}
        </FilterGroup>

        <div className="mb-4">
          <label className="flex items-center gap-2 text-[12px] text-text-secondary cursor-pointer">
            <input
              type="checkbox"
              checked={includePlugins}
              onChange={(e) => setSearchParam({ include_plugins: e.target.checked || undefined })}
              className="accent-accent-purple"
            />
            Include plugins
          </label>
        </div>

        {inspirations.length > 0 && (
          <FilterGroup label={`Inspiration (${inspirations.length})`}>
            <FilterChip
              active={!search.inspiration}
              onClick={() => setSearchParam({ inspiration: undefined })}
              label="All"
              count={null}
            />
            {(data?.facets.inspirationCount ?? 0) > 0 && (
              <FilterChip
                active={search.inspiration === HAS_INSPIRATION}
                onClick={() => setSearchParam({ inspiration: HAS_INSPIRATION })}
                label="Has inspiration"
                count={data!.facets.inspirationCount}
              />
            )}
            <div className={inspirations.length > 5 ? "max-h-[240px] overflow-y-auto pr-1" : ""}>
              {inspirations.map((ins) => (
                <FilterChip
                  key={ins.key}
                  active={search.inspiration === ins.key}
                  onClick={() => setSearchParam({ inspiration: ins.key })}
                  label={ins.label}
                  count={ins.count}
                  title={`${ins.label} (${ins.key})`}
                />
              ))}
            </div>
          </FilterGroup>
        )}

        {(namespaces.length > 0 || (data?.facets.noNamespace ?? 0) > 0) && (
          <FilterGroup label={`Namespace (${namespaces.length})`}>
            <FilterChip
              active={!search.ns}
              onClick={() => setSearchParam({ ns: undefined })}
              label="All"
              count={null}
            />
            {(data?.facets.noNamespace ?? 0) > 0 && (
              <FilterChip
                active={search.ns === NO_NAMESPACE}
                onClick={() => setSearchParam({ ns: NO_NAMESPACE })}
                label="(no namespace)"
                count={data!.facets.noNamespace}
              />
            )}
            <div className="max-h-[240px] overflow-y-auto pr-1">
              {namespaces.map((n) => (
                <FilterChip
                  key={n.name}
                  active={search.ns === n.name}
                  onClick={() => setSearchParam({ ns: n.name })}
                  label={n.name}
                  count={n.count}
                />
              ))}
            </div>
          </FilterGroup>
        )}
      </aside>

      {/* Main column */}
      <div className="flex-1 overflow-y-auto px-8 py-6">
        <div className="flex items-center gap-3 mb-4">
          <div className="relative flex-1 max-w-[420px]">
            <svg className="absolute left-3 top-1/2 -translate-y-1/2 text-text-dim" width="14" height="14" viewBox="0 0 16 16" fill="none">
              <circle cx="7" cy="7" r="5.5" stroke="currentColor" strokeWidth="1.5" />
              <line x1="11" y1="11" x2="14.5" y2="14.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
            <input
              type="text"
              className="w-full pl-9 pr-3 py-2 bg-white/5 border border-border/50 rounded-md outline-none text-[13px] text-text placeholder:text-text-dim focus:border-accent-purple/50 transition-colors"
              placeholder="Search name, description, body…"
              value={qInput}
              onChange={(e) => setQInput(e.target.value)}
            />
          </div>
          <span className="text-[12px] text-text-dim ml-auto">{data?.total ?? 0} results</span>
        </div>

        {loading && !data ? (
          <div className="flex items-center justify-center py-20 text-text-secondary text-sm">
            <div className="spinner mr-3" /> Loading library…
          </div>
        ) : !data || data.items.length === 0 ? (
          <div className="text-center py-16 text-text-dim text-sm">
            No artifacts match the current filters.
          </div>
        ) : (
          <table className="w-full text-[13px]">
            <thead>
              <tr className="text-left text-[11px] uppercase tracking-wider text-text-dim border-b border-border/40">
                <SortHeader label="Name" sort="name" current={sort} onClick={setSort} />
                <th className="px-2 py-2 font-semibold">Type</th>
                <th className="px-2 py-2 font-semibold">Scope</th>
                <SortHeader label="Last used" sort="last_used" current={sort} onClick={setSort} className="w-[110px]" />
                <SortHeader label="Invocations" sort="invocations" current={sort} onClick={setSort} className="w-[110px]" />
                <SortHeader label="Created" sort="created" current={sort} onClick={setSort} className="w-[110px]" />
              </tr>
            </thead>
            <tbody>
              {data.items.map((item) => (
                <ArtifactRow key={item.id} item={item} />
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

function FilterGroup({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="mb-4">
      <div className="text-[10px] font-semibold uppercase tracking-wider text-text-dim mb-1.5">{label}</div>
      <div className="flex flex-col gap-px">{children}</div>
    </div>
  );
}

function FilterChip({
  active,
  onClick,
  label,
  count,
  title,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  count: number | null;
  title?: string;
}) {
  return (
    <button
      className={`flex items-center justify-between px-2.5 py-1 rounded-full text-[12px] text-left transition-colors ${
        active
          ? "bg-accent-purple text-bg font-semibold"
          : "text-text-secondary hover:bg-white/5 hover:text-text"
      }`}
      onClick={onClick}
      title={title}
    >
      <span className="truncate">{label}</span>
      {count != null && (
        <span className={`text-[10px] ml-2 shrink-0 ${active ? "text-bg/70" : "text-text-dim"}`}>{count}</span>
      )}
    </button>
  );
}

function SortHeader({
  label,
  sort,
  current,
  onClick,
  className,
}: {
  label: string;
  sort: string;
  current: string;
  onClick: (s: string) => void;
  className?: string;
}) {
  const active = current === sort;
  return (
    <th className={`px-2 py-2 font-semibold ${className ?? ""}`}>
      <button
        className={`inline-flex items-center gap-1 transition-colors ${
          active ? "text-accent-purple" : "text-text-dim hover:text-text"
        }`}
        onClick={() => onClick(sort)}
      >
        {label}
        {active && (
          <svg width="9" height="9" viewBox="0 0 16 16" fill="none">
            <path d="M3 6l5 5 5-5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        )}
      </button>
    </th>
  );
}

function RelationshipBadge({
  kind,
  count,
  names,
}: {
  kind: "in" | "out";
  count: number;
  names: string[];
}) {
  const verb = kind === "out" ? "Invokes" : "Invoked by";
  const tooltip = `${verb} ${count}:\n${names.map((n) => `• ${n}`).join("\n")}`;
  return (
    <span
      className="inline-flex items-center gap-1 px-1.5 py-px text-[10px] rounded bg-white/5 border border-border/40 text-text-secondary font-normal"
      title={tooltip}
    >
      <svg width="9" height="9" viewBox="0 0 16 16" fill="none">
        {kind === "out" ? (
          <path d="M3 8h10M9 4l4 4-4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        ) : (
          <path d="M13 8H3M7 4l-4 4 4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        )}
      </svg>
      {count}
    </span>
  );
}

// Renders the Invocations cell. Direct = times the slash/skill/agent was
// invoked at the harness level. Indirect = sum of direct invocations of
// artifacts whose body references this one, attributing usage to commands
// like /architect-tasks that run inside /ship rather than being typed.
function InvocationCell({ item }: { item: LibraryListItem }) {
  const direct = item.total_invocations ?? 0;
  const indirect = item.indirect_invocations ?? 0;
  if (direct === 0 && indirect === 0) return <>—</>;
  const tooltipParts = [
    `Direct: ${direct}`,
    indirect > 0 ? `Indirect: ${indirect} (via ${item.referencedByList.map((r) => r.targetName).join(", ")})` : null,
  ].filter(Boolean);
  return (
    <span title={tooltipParts.join("\n")} className="inline-flex items-baseline gap-1">
      <span>{direct}</span>
      {indirect > 0 && (
        <span className="text-text-dim/70 text-[11px]" aria-label="indirect invocations">
          +{indirect}↩
        </span>
      )}
    </span>
  );
}

function ArtifactRow({ item }: { item: LibraryListItem }) {
  return (
    <tr className="border-b border-border/20 hover:bg-white/3 transition-colors">
      <td className="px-2 py-2.5">
        <Link
          to="/library/$id"
          params={{ id: item.id }}
          className="block no-underline text-text hover:text-accent-purple hover:no-underline"
        >
          <div className="font-medium flex items-center gap-2">
            {item.namespace && (
              <span
                className={`inline-flex items-center px-1.5 py-px text-[10px] rounded border font-mono uppercase tracking-wider shrink-0 ${namespaceBadgeColor(item.namespace)}`}
                title={`Namespace: ${item.namespace}`}
              >
                {item.namespace}
              </span>
            )}
            <span>{item.displayName}</span>
            {item.thinWrapper && (
              <span
                className="inline-flex items-center gap-1 px-1.5 py-px text-[10px] rounded bg-accent-purple/10 border border-accent-purple/25 text-accent-purple/90 font-normal"
                title={item.thinWrapper.match}
              >
                <svg width="9" height="9" viewBox="0 0 16 16" fill="none">
                  <path d="M3 8h10M9 4l4 4-4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
                {item.thinWrapper.targetName}
              </span>
            )}
            {item.references.length > 0 && (
              <RelationshipBadge
                kind="out"
                count={item.references.length}
                names={item.references.map((r) => r.targetName)}
              />
            )}
            {item.referencedByList.length > 0 && (
              <RelationshipBadge
                kind="in"
                count={item.referencedByList.length}
                names={item.referencedByList.map((r) => r.targetName)}
              />
            )}
            {item.inspiration && (
              <span
                className="inline-flex items-center text-amber-400/80"
                title={`Inspired by: ${item.inspiration}`}
              >
                <svg width="11" height="11" viewBox="0 0 16 16" fill="none">
                  <path d="M8 1.5v2M3.5 3.5l1.4 1.4M12.5 3.5l-1.4 1.4M2 8h2M12 8h2M5.5 12.5h5M6 14h4M5 10.5a3 3 0 116 0c0 .8-.4 1.5-1 2h-4c-.6-.5-1-1.2-1-2z" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </span>
            )}
          </div>
          {item.description && (
            <div className="text-[12px] text-text-dim mt-0.5 line-clamp-1">{item.description}</div>
          )}
        </Link>
      </td>
      <td className="px-2 py-2.5">
        <span
          className={`inline-block px-1.5 py-0.5 text-[10px] rounded border font-medium uppercase tracking-wider ${typeBadgeColor(item.type)}`}
        >
          {item.type}
        </span>
      </td>
      <td className="px-2 py-2.5">
        <span
          className={`inline-block px-1.5 py-0.5 text-[10px] rounded border font-medium ${scopeBadgeColor(item.scope)}`}
        >
          {scopeLabel(item.scope)}
        </span>
      </td>
      <td className="px-2 py-2.5 text-[12px] text-text-dim font-mono">
        {item.last_used ? formatRelative(item.last_used) : "—"}
      </td>
      <td className="px-2 py-2.5 text-[12px] text-text-dim font-mono">
        <InvocationCell item={item} />
      </td>
      <td className="px-2 py-2.5 text-[12px] text-text-dim font-mono">
        {new Date(item.created).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "2-digit" })}
      </td>
    </tr>
  );
}
