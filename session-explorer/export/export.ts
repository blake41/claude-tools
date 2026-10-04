import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { redactSecrets } from "../server/redact";
import { buildTraceFromFile, shapeTraceForResponse } from "../server/trace/index";

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const PAGES_BASE_URL = "https://clay-internal.pages.dev";

export class CliError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly fix: string,
  ) {
    super(message);
  }
}

export function resolveSession(value: string): string {
  if (value.endsWith(".jsonl") || value.includes("/")) {
    const p = resolve(value);
    if (!existsSync(p)) throw new CliError(`file not found: ${p}`, "NOT_FOUND", "check the path to the .jsonl");
    return p;
  }
  const projects = join(process.env.SESSION_EXPORT_PROJECTS_DIR ?? join(homedir(), ".claude", "projects"));
  if (existsSync(projects)) {
    for (const dir of readdirSync(projects)) {
      const candidate = join(projects, dir, `${value}.jsonl`);
      if (existsSync(candidate)) return candidate;
    }
  }
  throw new CliError(`no session ${value} under ${projects}`, "NOT_FOUND", "pass the full path to the .jsonl");
}

export function validateSlug(slug: string | undefined): string {
  if (!slug || !SLUG_RE.test(slug)) {
    throw new CliError(`invalid slug: ${slug ?? "(missing)"}`, "BAD_SLUG", "use lowercase letters, digits and hyphens, 1-64 chars, starting with a letter or digit");
  }
  return slug;
}

function redactDeep(value: unknown, counts: Record<string, number>): unknown {
  if (typeof value === "string") {
    const { text, redactions } = redactSecrets(value);
    for (const r of redactions) counts[r.kind] = (counts[r.kind] ?? 0) + 1;
    return text;
  }
  if (Array.isArray(value)) return value.map((v) => redactDeep(v, counts));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redactDeep(v, counts)]));
  }
  return value;
}

export async function render(session: string, outArg?: string) {
  const srcPath = resolveSession(session);
  const sessionId = basename(srcPath, ".jsonl");
  const projectId = basename(dirname(srcPath));
  const out = resolve(outArg ?? `/tmp/session-export-${sessionId}.html`);

  const counts: Record<string, number> = {};
  const full = await buildTraceFromFile(srcPath, projectId, sessionId);
  const trace = redactDeep(shapeTraceForResponse(full), counts);

  const viewerDir = join(import.meta.dir, "viewer");
  const js = readFileSync(join(viewerDir, "viewer.js"), "utf8");
  const css = readFileSync(join(viewerDir, "viewer.css"), "utf8");
  const data = JSON.stringify(trace).replace(/</g, "\\u003c");

  const html = `<!doctype html>
<html><head><meta charset="utf-8"><meta name="robots" content="noindex">
<title>Session ${sessionId}</title>
<style>${css}</style></head>
<body><div id="root"></div>
<script id="trace-data" type="application/json">${data}</script>
<script>${js.replace(/<\/script/gi, "<\\/script")}</script>
</body></html>`;

  writeFileSync(out, html);
  return { out, bytes: statSync(out).size, sessionId, redactions: counts };
}

export async function publish(session: string, slug: string | undefined) {
  const sessionId = basename(resolveSession(session), ".jsonl");
  const safeSlug = validateSlug(slug ?? `s-${sessionId}`);
  const pages = process.env.SESSION_EXPORT_PAGES_DIR ?? join(homedir(), "Documents", "Development", "clay", "internal-pages");
  if (!existsSync(pages) || !existsSync(join(pages, "publish"))) {
    throw new CliError(`internal-pages checkout or its ./publish not found at ${pages}`, "PAGES_DIR_MISSING", "clone internal-pages or set SESSION_EXPORT_PAGES_DIR");
  }

  const rendered = await render(session, `/tmp/session-export-${safeSlug}.html`);
  const target = join(pages, "public", safeSlug);
  mkdirSync(target, { recursive: true });
  copyFileSync(rendered.out, join(target, "index.html"));

  const run = spawnSync("./publish", [], { cwd: pages, encoding: "utf8" });
  if (run.status !== 0) {
    const tail = `${run.stdout ?? ""}${run.stderr ?? ""}`.trim().split("\n").slice(-5).join("\n");
    throw new CliError(`./publish exited ${run.status}: ${tail}`, "PUBLISH_FAILED", `run ./publish manually in ${pages}`);
  }
  return { url: `${PAGES_BASE_URL}/${safeSlug}/`, out: rendered.out, redactions: rendered.redactions };
}

function parseArgs(argv: string[]) {
  const positional: string[] = [];
  const flags: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const value = argv[++i];
      if (value === undefined) throw new CliError(`${a} needs a value`, "BAD_ARGS", `pass ${a} <value>`);
      flags[a.slice(2)] = value;
    } else positional.push(a);
  }
  return { positional, flags };
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  try {
    const { positional, flags } = parseArgs(rest);
    const session = positional[0] ?? process.env.CLAUDE_CODE_SESSION_ID;
    if ((command === "render" || command === "publish") && !session) {
      throw new CliError("missing session id or path, and CLAUDE_CODE_SESSION_ID is not set", "BAD_ARGS", `session-export ${command} <session-id|path.jsonl>`);
    }
    let result;
    if (command === "render") result = await render(session, flags.out);
    else if (command === "publish") result = await publish(session, flags.slug);
    else throw new CliError(`unknown command: ${command ?? "(none)"}`, "BAD_ARGS", "use render or publish");
    console.log(JSON.stringify(result));
  } catch (e) {
    const err = e instanceof CliError ? e : new CliError(e instanceof Error ? e.message : String(e), "INTERNAL_ERROR", "this is a bug in session-export");
    console.log(JSON.stringify({ error: { message: err.message, code: err.code }, fix: err.fix }));
    process.exit(1);
  }
}

if (import.meta.main) await main();
