import express from "express";
import { execFile } from "node:child_process";
import { existsSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import db from "../db.js";
import { getArtifact, listArtifacts, loadLibrary, getStatus } from "./cache.js";
import { computeUsage, bulkUsageStats } from "./usage.js";
import type { LibraryArtifact } from "./types.js";

const router = express.Router();
const HOME = homedir();
const CLAUDE_DIR = join(HOME, ".claude");

// Drop body + frontmatter from list responses to keep payload small. Every
// other artifact field flows through automatically — adding a column to
// LibraryArtifact requires no edits here.
function summarize(a: LibraryArtifact, usage?: { total: number; last_used: string | null }) {
  const { body: _body, frontmatter: _fm, ...rest } = a;
  return { ...rest, total_invocations: usage?.total, last_used: usage?.last_used };
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

router.get("/api/library", (req, res) => {
  const type = req.query.type as string | undefined;
  const scope = req.query.scope as string | undefined; // 'global' | 'plugin' | 'project'
  const ns = req.query.ns as string | undefined;
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
  if (q) {
    items = items.filter((a) => {
      return (
        a.name.toLowerCase().includes(q) ||
        (a.description ?? "").toLowerCase().includes(q) ||
        a.body.toLowerCase().includes(q)
      );
    });
  }

  // For sorts that require usage, hydrate it
  const wantsUsage = sort === "last_used" || sort === "invocations" || hasUsage;
  let usageMap: Map<string, { total: number; last_used: string | null }> | null = null;
  if (wantsUsage) {
    usageMap = bulkUsageStats(items);
    if (hasUsage) {
      items = items.filter((a) => (usageMap!.get(a.id)?.total ?? 0) > 0);
    }
  }

  // Sort
  items = [...items];
  if (sort === "name") {
    items.sort((a, b) => a.name.localeCompare(b.name));
  } else if (sort === "created") {
    items.sort((a, b) => (b.created ?? "").localeCompare(a.created ?? ""));
  } else if (sort === "invocations") {
    items.sort((a, b) => (usageMap!.get(b.id)?.total ?? 0) - (usageMap!.get(a.id)?.total ?? 0));
  } else {
    // last_used (default) — most-recently-used first; never-used go last
    items.sort((a, b) => {
      const aLast = usageMap!.get(a.id)?.last_used ?? "";
      const bLast = usageMap!.get(b.id)?.last_used ?? "";
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
  let noNamespaceCount = 0;
  for (const a of all) {
    typeCounts[a.type] = (typeCounts[a.type] ?? 0) + 1;
    scopeCounts[a.scope.kind] = (scopeCounts[a.scope.kind] ?? 0) + 1;
    if (type && a.type !== type) continue;
    if (a.namespace) {
      namespaceCounts[a.namespace] = (namespaceCounts[a.namespace] ?? 0) + 1;
    } else {
      noNamespaceCount++;
    }
  }

  res.json({
    items: items.map((a) => summarize(a, usageMap?.get(a.id))),
    total: items.length,
    facets: {
      type: typeCounts,
      scope: scopeCounts,
      namespace: namespaceCounts,
      noNamespace: noNamespaceCount,
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

  res.json({ ...artifact, siblings, wrappedBy });
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
