import { readFileSync, readdirSync, statSync, existsSync } from "fs";
import { join, relative, basename, dirname } from "path";
import { homedir } from "os";
import matter from "gray-matter";
import db from "../db.js";
import type { LibraryArtifact, LibraryScope, LibraryType, ThinWrapper } from "./types.js";
import { encodeArtifactId } from "./types.js";

const HOME = homedir();
const CLAUDE_DIR = join(HOME, ".claude");

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", ".next", "__pycache__"]);

function walkMarkdown(root: string, maxDepth = 6): string[] {
  const out: string[] = [];
  function recurse(dir: string, depth: number) {
    if (depth > maxDepth) return;
    let entries: import("fs").Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".") && entry.name !== ".claude") continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        recurse(full, depth + 1);
      } else if (entry.isFile() && entry.name.endsWith(".md")) {
        out.push(full);
      }
    }
  }
  recurse(root, 0);
  return out;
}

// For skill scanning: a directory with SKILL.md is a folder-style skill.
// Don't descend into it (so we skip auxiliary markdown like references/, scripts/, etc.).
function walkSkills(root: string, maxDepth = 6): string[] {
  const out: string[] = [];
  function recurse(dir: string, depth: number) {
    if (depth > maxDepth) return;
    let entries: import("fs").Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    const hasSkillMd = entries.some(
      (e) => e.isFile() && e.name.toLowerCase() === "skill.md"
    );
    if (hasSkillMd && dir !== root) {
      // This dir is a folder-style skill. Emit only SKILL.md and stop descending.
      const skillFile = entries.find(
        (e) => e.isFile() && e.name.toLowerCase() === "skill.md"
      );
      if (skillFile) out.push(join(dir, skillFile.name));
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        recurse(full, depth + 1);
      } else if (entry.isFile() && entry.name.endsWith(".md")) {
        // Flat-file skill at top level (e.g. skills/qa/debug.md)
        out.push(full);
      }
    }
  }
  recurse(root, 0);
  return out;
}

function inferNameFromPath(typeRoot: string, filePath: string): { name: string; namespace: string | null } {
  // typeRoot is e.g. ~/.claude/skills, filePath is the .md absolute path.
  let rel = relative(typeRoot, filePath);
  // Strip /SKILL.md if folder-based
  if (basename(rel).toLowerCase() === "skill.md") {
    rel = dirname(rel);
  } else {
    rel = rel.replace(/\.md$/, "");
  }
  // Path components -> colons; e.g. "qa/contract/tests" -> "qa:contract:tests"
  const parts = rel.split("/").filter(Boolean);
  // Names like "dennison:ux-paths" already have a colon in the filename — keep them as-is.
  const name = parts.join(":");
  const namespace = parts.length > 1 ? parts[0] : null;
  return { name, namespace };
}

// Detect commands whose body is essentially "go run skill X". The strong
// "Invoke the /X skill" pattern fires on any length — it's only ever produced
// by namespace-bridge commands. Softer patterns ("Use the X skill") only fire
// if they appear near the top of a relatively short command body, otherwise
// they're incidental references inside a complex command.
const SOFT_HEAD_LIMIT = 600;
const SOFT_BODY_LIMIT = 1500;

function detectThinWrapper(type: LibraryType, body: string): ThinWrapper | null {
  if (type !== "command") return null;
  const stripped = body
    .replace(/^---[\s\S]*?---\s*/m, "")
    .replace(/^#.*$/gm, "")
    .trim();
  if (!stripped) return null;

  const strong = stripped.match(/^Invoke the\s+\/?([\w:.\-]+)\s+skill\b[^\n]*/im);
  if (strong && strong[1]) {
    return {
      targetType: "skill",
      targetName: strong[1],
      targetId: null,
      match: strong[0].trim().slice(0, 200),
    };
  }

  if (stripped.length > SOFT_BODY_LIMIT) return null;

  const softPatterns: RegExp[] = [
    /\bUse the\s+`?\/?([\w:.\-]+)`?\s+skill\b[^\n]*/im,
    /\bRun the\s+`?\/?([\w:.\-]+)`?\s+skill\b[^\n]*/im,
    /\bDelegates?\s+to\s+(?:the\s+)?`?\/?([\w:.\-]+)`?\s+skill\b[^\n]*/im,
  ];
  const head = stripped.slice(0, SOFT_HEAD_LIMIT);
  for (const re of softPatterns) {
    const m = head.match(re);
    if (m && m[1]) {
      return {
        targetType: "skill",
        targetName: m[1],
        targetId: null,
        match: m[0].trim().slice(0, 200),
      };
    }
  }
  return null;
}

function deriveDescription(frontmatter: Record<string, unknown>, body: string): string | null {
  const fmDesc = frontmatter.description;
  if (typeof fmDesc === "string" && fmDesc.trim()) return fmDesc.trim();

  // First H1
  const h1 = body.match(/^#\s+(.+)$/m);
  if (h1) return h1[1].trim().slice(0, 200);

  // First non-empty paragraph
  const trimmed = body.trim();
  if (trimmed) {
    const para = trimmed.split(/\n\s*\n/)[0].trim();
    return para.replace(/\s+/g, " ").slice(0, 200);
  }
  return null;
}

function parseArtifact(
  filePath: string,
  type: LibraryType,
  scope: LibraryScope,
  name: string,
  namespace: string | null
): LibraryArtifact {
  const stat = statSync(filePath);
  const raw = readFileSync(filePath, "utf-8");

  let frontmatter: Record<string, unknown> = {};
  let body = raw;
  let parseError: string | undefined;
  try {
    const parsed = matter(raw);
    frontmatter = (parsed.data || {}) as Record<string, unknown>;
    body = parsed.content || "";
  } catch (e) {
    parseError = e instanceof Error ? e.message : String(e);
  }

  const description = deriveDescription(frontmatter, body);
  const inspirationVal = frontmatter.inspiration ?? frontmatter.inspired_by ?? null;
  const inspiration = typeof inspirationVal === "string" ? inspirationVal : null;

  // created: prefer frontmatter, else fs ctime
  const fmCreated = frontmatter.created ?? frontmatter.date ?? null;
  const created = typeof fmCreated === "string" ? fmCreated : new Date(stat.birthtimeMs || stat.ctimeMs).toISOString();

  // The leaf form — what to render next to the namespace badge in the UI.
  // `name` stays the canonical fully-qualified identifier ("qa:contract:tests"),
  // which is what slash-command usage queries match against.
  const displayName = namespace ? name.slice(namespace.length + 1) : name;

  return {
    id: encodeArtifactId(type, scope, name),
    type,
    scope,
    name,
    namespace,
    displayName,
    sourcePath: filePath,
    description,
    created,
    inspiration,
    frontmatter,
    body,
    thinWrapper: detectThinWrapper(type, body),
    parseError,
  };
}

function scanTypeDir(
  typeRoot: string,
  type: LibraryType,
  scope: LibraryScope,
  out: LibraryArtifact[]
) {
  if (!existsSync(typeRoot)) return;
  const files = type === "skill" ? walkSkills(typeRoot) : walkMarkdown(typeRoot);
  for (const f of files) {
    const { name, namespace } = inferNameFromPath(typeRoot, f);
    if (!name) continue;
    try {
      out.push(parseArtifact(f, type, scope, name, namespace));
    } catch (e) {
      // ignore unreadable file
      console.error(`[library] failed to parse ${f}:`, e);
    }
  }
}

function scanGlobals(out: LibraryArtifact[]) {
  const scope: LibraryScope = { kind: "global" };
  scanTypeDir(join(CLAUDE_DIR, "skills"), "skill", scope, out);
  scanTypeDir(join(CLAUDE_DIR, "agents"), "agent", scope, out);
  scanTypeDir(join(CLAUDE_DIR, "commands"), "command", scope, out);
  scanTypeDir(join(CLAUDE_DIR, "rules"), "rule", scope, out);

  // CLAUDE.md as a single artifact
  const claudeMd = join(CLAUDE_DIR, "CLAUDE.md");
  if (existsSync(claudeMd)) {
    try {
      out.push(parseArtifact(claudeMd, "claude-md", scope, "CLAUDE.md", null));
    } catch (e) {
      console.error(`[library] failed to parse CLAUDE.md:`, e);
    }
  }

  // Hooks
  scanHooks(join(CLAUDE_DIR, "hooks"), scope, out);
}

function scanHooks(hooksRoot: string, scope: LibraryScope, out: LibraryArtifact[]) {
  if (!existsSync(hooksRoot)) return;
  let entries: import("fs").Dirent[];
  try {
    entries = readdirSync(hooksRoot, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = join(hooksRoot, entry.name);
    if (entry.isDirectory()) {
      // Look for an entrypoint: hook.sh, run.sh, index.js, etc., or fall back to first file
      let entrypoint: string | null = null;
      try {
        const subEntries = readdirSync(full, { withFileTypes: true })
          .filter((e) => e.isFile())
          .map((e) => e.name);
        const preferred = subEntries.find((n) => /^(hook|run|index|main)\.(sh|js|ts|py)$/.test(n));
        entrypoint = preferred ? join(full, preferred) : (subEntries[0] ? join(full, subEntries[0]) : null);
      } catch {
        // skip
      }
      if (!entrypoint) continue;
      out.push(buildHookArtifact(entrypoint, entry.name, scope));
    } else if (entry.isFile()) {
      out.push(buildHookArtifact(full, entry.name.replace(/\.[^.]+$/, ""), scope));
    }
  }
}

function buildHookArtifact(filePath: string, name: string, scope: LibraryScope): LibraryArtifact {
  const stat = statSync(filePath);
  let body = "";
  let truncated = false;
  try {
    const raw = readFileSync(filePath, "utf-8");
    const MAX = 50_000;
    if (raw.length > MAX) {
      body = raw.slice(0, MAX);
      truncated = true;
    } else {
      body = raw;
    }
  } catch {
    body = "(unreadable)";
  }

  // First comment line as description
  const firstComment = body.split("\n").slice(0, 50).find((line) => /^\s*[#/*]/.test(line));
  const description = firstComment ? firstComment.replace(/^[\s#/*]+/, "").trim().slice(0, 200) : null;

  return {
    id: encodeArtifactId("hook", scope, name),
    type: "hook",
    scope,
    name,
    namespace: null,
    displayName: name,
    sourcePath: filePath,
    description,
    created: new Date(stat.birthtimeMs || stat.ctimeMs).toISOString(),
    inspiration: null,
    frontmatter: truncated ? { truncated: true } : {},
    body,
    thinWrapper: null,
    parseError: undefined,
  };
}

interface InstalledPlugins {
  version?: number;
  plugins?: Record<string, Array<{ installPath: string; scope?: string; version?: string }>>;
}

function scanPlugins(out: LibraryArtifact[]) {
  const manifestPath = join(CLAUDE_DIR, "plugins", "installed_plugins.json");
  if (!existsSync(manifestPath)) return;
  let manifest: InstalledPlugins;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
  } catch {
    return;
  }
  const plugins = manifest.plugins || {};
  for (const [pluginKey, instances] of Object.entries(plugins)) {
    if (!Array.isArray(instances) || instances.length === 0) continue;
    // pluginKey is like "design-and-refine@design-plugins" — take the part before @
    const pluginName = pluginKey.split("@")[0];
    for (const inst of instances) {
      const root = inst.installPath;
      if (!root || !existsSync(root)) continue;
      const scope: LibraryScope = { kind: "plugin", name: pluginName };
      scanTypeDir(join(root, "skills"), "skill", scope, out);
      scanTypeDir(join(root, "agents"), "agent", scope, out);
      scanTypeDir(join(root, "commands"), "command", scope, out);
      scanHooks(join(root, "hooks"), scope, out);
    }
  }
}

interface WorkspaceRow {
  path: string;
  display_name: string;
}

function scanProjects(out: LibraryArtifact[]) {
  let rows: WorkspaceRow[] = [];
  try {
    rows = db.prepare(`SELECT path, display_name FROM workspaces`).all() as WorkspaceRow[];
  } catch {
    return;
  }
  for (const row of rows) {
    if (!row.path || !existsSync(row.path)) continue;
    const projectClaude = join(row.path, ".claude");
    if (!existsSync(projectClaude)) continue;
    // Don't double-count globals: if a workspace path is the user's home, its .claude IS the global dir.
    if (projectClaude === CLAUDE_DIR) continue;
    const scope: LibraryScope = {
      kind: "project",
      workspacePath: row.path,
      workspaceName: row.display_name,
    };
    scanTypeDir(join(projectClaude, "skills"), "skill", scope, out);
    scanTypeDir(join(projectClaude, "agents"), "agent", scope, out);
    scanTypeDir(join(projectClaude, "commands"), "command", scope, out);
  }
}

export interface ScanResult {
  artifacts: LibraryArtifact[];
  durationMs: number;
}

export function scanLibrary(): ScanResult {
  const start = Date.now();
  const out: LibraryArtifact[] = [];
  scanGlobals(out);
  scanPlugins(out);
  scanProjects(out);
  return { artifacts: out, durationMs: Date.now() - start };
}
