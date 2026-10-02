import { readdirSync, readFileSync, writeFileSync } from "fs";
import { basename, dirname, join, resolve } from "path";
import { redactSecrets } from "../server/redact";
import { buildTraceFromFile, shapeTraceForResponse } from "../server/trace/index";

const [src, out = "/tmp/session-export.html"] = process.argv.slice(2);
if (!src) {
  console.error("usage: bun spike-export/export.ts <session.jsonl> [out.html]");
  process.exit(2);
}

const srcPath = resolve(src);
const sessionId = basename(srcPath, ".jsonl");
const projectId = basename(dirname(srcPath));

const counts: Record<string, number> = {};
function redactDeep(value: unknown): unknown {
  if (typeof value === "string") {
    const { text, redactions } = redactSecrets(value);
    for (const r of redactions) counts[r.kind] = (counts[r.kind] ?? 0) + 1;
    return text;
  }
  if (Array.isArray(value)) return value.map(redactDeep);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redactDeep(v)]));
  }
  return value;
}

const full = await buildTraceFromFile(srcPath, projectId, sessionId);
const trace = redactDeep(shapeTraceForResponse(full));

const distDir = join(import.meta.dir, "dist");
const files = readdirSync(distDir);
const js = readFileSync(join(distDir, "viewer.js"), "utf8");
const css = readFileSync(join(distDir, files.find((f) => f.endsWith(".css"))!), "utf8");
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
console.log(JSON.stringify({ out, bytes: html.length, redactions: counts }));
