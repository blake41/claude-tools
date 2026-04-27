import express from "express";
import { execFile } from "node:child_process";
import { existsSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import db from "../db.js";
import { getArtifact, listArtifacts, loadLibrary, getStatus } from "./cache.js";
import { computeUsage, bulkUsageStats, type UsageBucket } from "./usage.js";
import type { LibraryArtifact } from "./types.js";

const router = express.Router();
const HOME = homedir();
const CLAUDE_DIR = join(HOME, ".claude");

// Drop body + frontmatter from list responses to keep payload small. Every
// other artifact field flows through automatically — adding a column to
// LibraryArtifact requires no edits here.
function summarize(a: LibraryArtifact, usage?: { total: number; indirect_total: number; last_used: string | null }) {
  const { body: _body, frontmatter: _fm, ...rest } = a;
  return {
    ...rest,
    total_invocations: usage?.total,
    indirect_invocations: usage?.indirect_total,
    last_used: usage?.last_used,
  };
}

function scopeKey(scope: LibraryArtifact["scope"]): string {
  if (scope.kind === "global") return "global";
  if (scope.kind === "plugin") return `plugin:${scope.name}`;
  return `project:${scope.workspacePath}`;
}

function toBool(v: unknown, fallback: boolean): boolean {
  if (typeof v !== "string") return fallback;
  if (v === "1" || v === "true") return true;
  if (v === "0" || v === "false") return false;
  return fallback;
}

// Group inspiration strings by source. Two skills imported from the same
// upstream (e.g. Jeffrey's) should land under one chip even though their
// per-skill URLs differ. Source key = host, plus owner segment for
// multi-author hubs (github.com, skills.sh, gitlab.com). Label = the human
// prefix before " — " in the inspiration string (falls back to host).
const MULTI_AUTHOR_HOSTS = new Set(["github.com", "gitlab.com", "skills.sh"]);

function inspirationSource(s: string): { key: string; label: string } {
  const sepIdx = s.search(/\s+—\s+/);
  const label = (sepIdx > 0 ? s.slice(0, sepIdx) : s).trim();
  const urlMatch = s.match(/https?:\/\/[^\s]+/);
  if (!urlMatch) return { key: s, label: label || s };
  try {
    const u = new URL(urlMatch[0]);
    const host = u.hostname.replace(/^www\./, "");
    const segs = u.pathname.split("/").filter(Boolean);
    const key = MULTI_AUTHOR_HOSTS.has(host) && segs[0] ? `${host}/${segs[0]}` : host;
    return { key, label: label || key };
  } catch {
    return { key: s, label: label || s };
  }
}

router.get("/api/library", (req, res) => {
  const type = req.query.type as string | undefined;
  const scope = req.query.scope as string | undefined; // 'global' | 'plugin' | 'project'
  const ns = req.query.ns as string | undefined;
  const inspiration = req.query.inspiration as string | undefined;
  const q = (req.query.q as string | undefined)?.toLowerCase();
  const sort = (req.query.sort as string | undefined) ?? "last_used";
  const includePlugins = toBool(req.query.include_plugins, false);
  const hasUsage = toBool(req.query.has_usage, false);

  let items = listArtifacts();

  if (!includePlugins) {
    items = items.filter((a) => a.scope.kind !== "plugin");
  }
  if (type) {
    items = items.filter((a) => a.type === type);
  }
  if (scope) {
    items = items.filter((a) => a.scope.kind === scope);
  }
  if (ns === "__none__") {
    items = items.filter((a) => !a.namespace);
  } else if (ns) {
    items = items.filter((a) => a.namespace === ns);
  }
  if (inspiration === "__has__") {
    items = items.filter((a) => !!a.inspiration);
  } else if (inspiration) {
    items = items.filter(
      (a) =>
        !!a.inspiration &&
        (a.inspiration === inspiration || inspirationSource(a.inspiration).key === inspiration)
    );
  }
  if (q) {
    items = items.filter((a) => {
      return (
        a.name.toLowerCase().includes(q) ||
        (a.description ?? "").toLowerCase().includes(q) ||
        a.body.toLowerCase().includes(q)
      );
    });
  }

  // Always hydrate usage — every row's "Last used" and "Invocations" columns
  // depend on it, regardless of sort. bulkUsageStats is cheap (one aggregate
  // query per tool type + a 60s-cached slash-command scan).
  const usageMap: Map<string, UsageBucket> = bulkUsageStats(items);
  if (hasUsage) {
    items = items.filter((a) => (usageMap.get(a.id)?.total ?? 0) > 0);
  }

  // Sort
  items = [...items];
  if (sort === "name") {
    items.sort((a, b) => a.name.localeCompare(b.name));
  } else if (sort === "created") {
    items.sort((a, b) => (b.created ?? "").localeCompare(a.created ?? ""));
  } else if (sort === "invocations") {
    items.sort((a, b) => (usageMap.get(b.id)?.total ?? 0) - (usageMap.get(a.id)?.total ?? 0));
  } else {
    // last_used (default) — most-recently-used first; never-used go last
    items.sort((a, b) => {
      const aLast = usageMap.get(a.id)?.last_used ?? "";
      const bLast = usageMap.get(b.id)?.last_used ?? "";
      if (aLast === bLast) return a.name.localeCompare(b.name);
      return bLast.localeCompare(aLast);
    });
  }

  // Build facet counts (over the un-narrowed-by-this-facet set, but post-includePlugins).
  // Namespace counts also constrain by the current type filter — without it,
  // namespaces from other types (e.g. skills) inflate the picker when the user
  // has narrowed to commands.
  const all = listArtifacts().filter((a) => includePlugins || a.scope.kind !== "plugin");
  const typeCounts: Record<string, number> = {};
  const scopeCounts: Record<string, number> = {};
  const namespaceCounts: Record<string, number> = {};
  // Per source-key: total count and label-frequency map (so we can pick the
  // most common label as the display name when sub-skill labels diverge).
  const inspirationGroups: Record<string, { count: number; labels: Record<string, number> }> = {};
  let noNamespaceCount = 0;
  let inspirationCount = 0;
  for (const a of all) {
    typeCounts[a.type] = (typeCounts[a.type] ?? 0) + 1;
    scopeCounts[a.scope.kind] = (scopeCounts[a.scope.kind] ?? 0) + 1;
    if (type && a.type !== type) continue;
    if (a.namespace) {
      namespaceCounts[a.namespace] = (namespaceCounts[a.namespace] ?? 0) + 1;
    } else {
      noNamespaceCount++;
    }
    if (a.inspiration) {
      const { key, label } = inspirationSource(a.inspiration);
      const g = (inspirationGroups[key] ??= { count: 0, labels: {} });
      g.count++;
      g.labels[label] = (g.labels[label] ?? 0) + 1;
      inspirationCount++;
    }
  }
  const inspirationFacet = Object.entries(inspirationGroups)
    .map(([key, g]) => {
      // Pick the most common label; tie-break alphabetically for determinism.
      const label = Object.entries(g.labels).sort(
        (a, b) => b[1] - a[1] || a[0].localeCompare(b[0])
      )[0][0];
      return { key, label, count: g.count };
    })
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));

  res.json({
    items: items.map((a) => summarize(a, usageMap.get(a.id))),
    total: items.length,
    facets: {
      type: typeCounts,
      scope: scopeCounts,
      namespace: namespaceCounts,
      noNamespace: noNamespaceCount,
      inspiration: inspirationFacet,
      inspirationCount,
    },
    status: getStatus(),
  });
});

router.get("/api/library/:id", (req, res) => {
  const id = decodeURIComponent(req.params.id);
  const artifact = getArtifact(id);
  if (!artifact) {
    res.status(404).json({ error: "artifact not found" });
    return;
  }
  // Siblings: same type + scope + namespace, excluding self.
  let siblings: ReturnType<typeof summarize>[] = [];
  if (artifact.namespace) {
    const all = listArtifacts();
    const myScopeKey = scopeKey(artifact.scope);
    siblings = all
      .filter(
        (a) =>
          a.id !== artifact.id &&
          a.type === artifact.type &&
          a.namespace === artifact.namespace &&
          scopeKey(a.scope) === myScopeKey
      )
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((a) => summarize(a));
  }

  // Reverse links: which other artifacts thin-wrap this one (only meaningful for skills).
  let wrappedBy: ReturnType<typeof summarize>[] = [];
  if (artifact.type === "skill") {
    const all = listArtifacts();
    wrappedBy = all
      .filter((a) => a.thinWrapper?.targetId === artifact.id)
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((a) => summarize(a));
  }

  // Reverse links: which artifacts reference (invoke) this one in their body.
  const referencedBy = listArtifacts()
    .filter((a) => a.references.some((r) => r.targetId === artifact.id))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((a) => summarize(a));

  res.json({ ...artifact, siblings, wrappedBy, referencedBy });
});

router.get("/api/library/:id/usage", (req, res) => {
  const id = decodeURIComponent(req.params.id);
  const artifact = getArtifact(id);
  if (!artifact) {
    res.status(404).json({ error: "artifact not found" });
    return;
  }
  res.json(computeUsage(artifact));
});

router.post("/api/library/rescan", (_req, res) => {
  const result = loadLibrary();
  res.json(result);
});

router.post("/api/library/show-in-finder", (req, res) => {
  const { path: filePath } = req.body as { path?: string };
  if (!filePath || typeof filePath !== "string") {
    res.status(400).json({ error: "path is required" });
    return;
  }
  if (!isAllowedPath(filePath)) {
    res.status(400).json({ error: "path not in allowed roots" });
    return;
  }
  if (!existsSync(filePath)) {
    res.status(404).json({ error: "file not found" });
    return;
  }
  execFile("open", ["-R", filePath], (err) => {
    if (err) {
      res.status(500).json({ error: err.message });
      return;
    }
    res.json({ ok: true });
  });
});

function isAllowedPath(filePath: string): boolean {
  if (!filePath.startsWith("/")) return false;
  if (filePath.includes("..")) return false;
  if (filePath.startsWith(CLAUDE_DIR + "/") || filePath === CLAUDE_DIR) return true;
  // Workspace-scoped paths
  try {
    const rows = db.prepare(`SELECT path FROM workspaces`).all() as Array<{ path: string }>;
    for (const row of rows) {
      if (row.path && filePath.startsWith(row.path + "/.claude/")) return true;
    }
  } catch {
    // ignore
  }
  return false;
}

export default router;
