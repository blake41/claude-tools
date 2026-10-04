import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const EXPORT_TS = join(import.meta.dir, "export.ts");
const FIXTURE = join(import.meta.dir, "..", "server", "fixtures", "projection-sample.jsonl");

const GH_TOKEN = `ghp_${"a1B2c3D4e5".repeat(4).slice(0, 36)}`;
const AWS_KEY = "AKIAABCDEFGHIJKLMNOP";

let tmp: string;
let session: string;

function run(args: string[], env: Record<string, string> = {}) {
  const p = Bun.spawnSync(["bun", "run", EXPORT_TS, ...args], { env: { ...process.env, ...env } });
  return { code: p.exitCode, json: JSON.parse(p.stdout.toString()) };
}

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), "session-export-test-"));
  const projectDir = join(tmp, "proj");
  mkdirSync(projectDir);
  const lines = readFileSync(FIXTURE, "utf8").trim().split("\n");
  const first = JSON.parse(lines[0]);
  first.message.content = `deploy with token ${GH_TOKEN} and key ${AWS_KEY}`;
  lines[0] = JSON.stringify(first);
  session = join(projectDir, "11111111-2222-3333-4444-555555555555.jsonl");
  writeFileSync(session, `${lines.join("\n")}\n`);
});

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("render", () => {
  test("redacts planted secrets from the output html", () => {
    const out = join(tmp, "out.html");
    const { code, json } = run(["render", session, "--out", out]);
    expect(code).toBe(0);
    expect(json.out).toBe(out);
    expect(json.sessionId).toBe("11111111-2222-3333-4444-555555555555");
    expect(json.redactions["github-token"]).toBeGreaterThanOrEqual(1);
    const html = readFileSync(out, "utf8");
    expect(html).not.toContain(GH_TOKEN);
    expect(html).not.toContain(AWS_KEY);
    expect(html).toContain("[REDACTED:github-token]");
  });

  test("session id resolves through the projects dir; unknown id is NOT_FOUND", () => {
    const env = { SESSION_EXPORT_PROJECTS_DIR: tmp };
    const ok = run(["render", "11111111-2222-3333-4444-555555555555", "--out", join(tmp, "byid.html")], env);
    expect(ok.code).toBe(0);
    const missing = run(["render", "99999999-0000-0000-0000-000000000000"], env);
    expect(missing.code).toBe(1);
    expect(missing.json.error.code).toBe("NOT_FOUND");
  });
});

describe("publish", () => {
  test("copies index.html into public/<slug>/ and runs ./publish", () => {
    const pages = join(tmp, "pages");
    mkdirSync(pages);
    writeFileSync(join(pages, "publish"), `#!/bin/sh\ntouch "$PWD/published.marker"\n`);
    chmodSync(join(pages, "publish"), 0o755);

    const { code, json } = run(["publish", session, "--slug", "my-session-1"], { SESSION_EXPORT_PAGES_DIR: pages });
    expect(code).toBe(0);
    expect(json.url).toBe("https://clay-internal.pages.dev/my-session-1/");
    expect(existsSync(join(pages, "public", "my-session-1", "index.html"))).toBe(true);
    expect(readFileSync(join(pages, "public", "my-session-1", "index.html"), "utf8")).not.toContain(GH_TOKEN);
    expect(existsSync(join(pages, "published.marker"))).toBe(true);
  });

  test("no session arg and no --slug publishes the current session under s-<session-id>", () => {
    const pages = join(tmp, "pages-default");
    mkdirSync(pages);
    writeFileSync(join(pages, "publish"), `#!/bin/sh\ntouch "$PWD/published.marker"\n`);
    chmodSync(join(pages, "publish"), 0o755);

    const id = "11111111-2222-3333-4444-555555555555";
    const { code, json } = run(["publish"], {
      SESSION_EXPORT_PAGES_DIR: pages,
      SESSION_EXPORT_PROJECTS_DIR: tmp,
      CLAUDE_CODE_SESSION_ID: id,
    });
    expect(code).toBe(0);
    expect(json.url).toBe(`https://clay-internal.pages.dev/s-${id}/`);
    expect(existsSync(join(pages, "public", `s-${id}`, "index.html"))).toBe(true);
    expect(existsSync(join(pages, "published.marker"))).toBe(true);
  });

  test("no session arg and no CLAUDE_CODE_SESSION_ID is BAD_ARGS", () => {
    const { CLAUDE_CODE_SESSION_ID: _drop, ...env } = process.env;
    const p = Bun.spawnSync(["bun", "run", EXPORT_TS, "publish"], { env });
    expect(p.exitCode).toBe(1);
    expect(JSON.parse(p.stdout.toString()).error.code).toBe("BAD_ARGS");
  });

  test("missing pages dir is PAGES_DIR_MISSING", () => {
    const { code, json } = run(["publish", session, "--slug", "ok"], { SESSION_EXPORT_PAGES_DIR: join(tmp, "nope") });
    expect(code).toBe(1);
    expect(json.error.code).toBe("PAGES_DIR_MISSING");
  });

  test.each(["../x", "A B"])("rejects slug %p with BAD_SLUG before touching anything", (slug) => {
    const pages = join(tmp, "pages");
    const { code, json } = run(["publish", session, "--slug", slug], { SESSION_EXPORT_PAGES_DIR: pages });
    expect(code).toBe(1);
    expect(json.error.code).toBe("BAD_SLUG");
  });
});
