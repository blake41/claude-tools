#!/usr/bin/env bun
// @bun
var __require = import.meta.require;

// ../../tools/db-safe/execute.ts
import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { createInterface } from "readline";
function pickFormat() {
  const explicit = process.env.DB_SAFE_FORMAT;
  if (explicit === "table" || explicit === "ndjson" || explicit === "json" || explicit === "pretty") {
    return explicit;
  }
  return process.stdout.isTTY ? "table" : "ndjson";
}
function isRowArray(v) {
  return Array.isArray(v) && v.length > 0 && v.every((r) => r !== null && typeof r === "object" && !Array.isArray(r));
}
function stringifyCell(v) {
  if (v === null)
    return "null";
  if (v === undefined)
    return "";
  if (v instanceof Date)
    return v.toISOString();
  if (typeof v === "bigint")
    return v.toString();
  if (typeof v === "object")
    return JSON.stringify(v);
  return String(v);
}
function renderTable(rows) {
  if (rows.length === 0)
    return "(no rows)";
  const cols = Array.from(new Set(rows.flatMap((r) => Object.keys(r))));
  const cells = rows.map((r) => cols.map((c) => stringifyCell(r[c])));
  const MAX = 80;
  const widths = cols.map((c, i) => Math.min(MAX, Math.max(c.length, ...cells.map((row) => row[i].length))));
  const truncate = (s, w) => s.length > w ? s.slice(0, w - 1) + "\u2026" : s.padEnd(w);
  const header = cols.map((c, i) => c.padEnd(widths[i])).join(" | ");
  const sep = widths.map((w) => "-".repeat(w)).join("-+-");
  const body = cells.map((row) => row.map((v, i) => truncate(v, widths[i])).join(" | ")).join(`
`);
  const count = `(${rows.length} ${rows.length === 1 ? "row" : "rows"})`;
  return `${header}
${sep}
${body}
${count}`;
}
function emitSuccess(result, format) {
  if (format === "ndjson" && isRowArray(result)) {
    console.log(JSON.stringify({ ok: true, command: "db-safe", rows: result.length }));
    for (const row of result)
      console.log(JSON.stringify(row));
    return;
  }
  if (format === "table" && isRowArray(result)) {
    console.log(renderTable(result));
    return;
  }
  const envelope = { ok: true, command: "db-safe", result, next_actions: [] };
  console.log(format === "pretty" ? JSON.stringify(envelope, null, 2) : JSON.stringify(envelope));
}
function emitError(message, code, fix, format) {
  if (format === "table") {
    process.stderr.write(`ERROR (${code}): ${message}
`);
    if (fix)
      process.stderr.write(`  ${fix}
`);
    return;
  }
  const envelope = {
    ok: false,
    command: "db-safe",
    error: { message, code },
    fix,
    next_actions: []
  };
  console.log(format === "pretty" ? JSON.stringify(envelope, null, 2) : JSON.stringify(envelope));
}
function loadConfig(configPath) {
  const raw = readFileSync(configPath, "utf-8");
  return JSON.parse(raw);
}
function resolveUrl(envConfig) {
  let url = envConfig.url;
  url = url.replace(/\$([A-Z_][A-Z0-9_]*)/g, (_match, varName) => {
    return process.env[varName] || "";
  });
  if (url)
    return url;
  if (envConfig.infisical) {
    try {
      const { execSync } = __require("child_process");
      const result = execSync(`infisical secrets get ${envConfig.infisical.secret} --env=${envConfig.infisical.env} --plain`, { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] });
      return result.trim();
    } catch {
      throw new Error(`Failed to resolve database URL. Env var is empty and Infisical fetch failed.
` + `Make sure the env var is set or run: infisical login`);
    }
  }
  throw new Error(`Database URL resolved to empty string. Check your .db-safe.json and environment variables.`);
}
function requireTTY(query, label) {
  if (!process.stdin.isTTY) {
    const output = {
      ok: false,
      command: "db-safe",
      error: {
        message: "Write operations require an interactive terminal (TTY).",
        code: "NO_TTY"
      },
      fix: `Run this command manually in your terminal:
  db-safe sql:write ${label.toLowerCase()} '${query.replace(/'/g, "'\\''")}'`,
      next_actions: []
    };
    console.log(JSON.stringify(output));
    process.exit(1);
  }
}
async function confirmWrite(query, label) {
  console.error("");
  console.error(`\u26A0\uFE0F  WRITE on [${label}]`);
  console.error("");
  console.error(`  Operation: ${query}`);
  console.error("");
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  return new Promise((res) => {
    rl.question("  Type 'yes' to proceed: ", (answer) => {
      rl.close();
      if (answer.trim().toLowerCase() === "yes") {
        res(true);
      } else {
        console.error("");
        console.error("  Cancelled.");
        res(false);
      }
    });
  });
}
async function executeSql(url, sql, readOnly) {
  let pg;
  try {
    pg = await import("pg");
  } catch {
    throw new Error("Could not load 'pg' module. Install it in your project: bun add pg");
  }
  const Client = pg.default?.Client || pg.Client;
  const client = new Client({
    connectionString: url,
    ssl: url.includes("render.com") ? { rejectUnauthorized: false } : undefined
  });
  try {
    await client.connect();
    if (!readOnly) {
      const result = await client.query(sql);
      return result.rows;
    }
    await client.query("BEGIN READ ONLY");
    try {
      const result = await client.query({
        name: "db-safe-read",
        text: sql,
        values: []
      });
      return result.rows;
    } finally {
      await client.query("ROLLBACK").catch(() => {});
    }
  } finally {
    await client.end();
  }
}
async function executePrisma(url, query, writeToken) {
  const cfgPath = process.env.DB_SAFE_CONFIG || process.argv[5];
  const configDir = dirname(cfgPath);
  let PrismaClient;
  try {
    const prismaPath = resolve(configDir, "node_modules", "@prisma", "client");
    const mod = await import(prismaPath);
    PrismaClient = mod.PrismaClient;
  } catch {
    throw new Error(`Could not load @prisma/client from project at ${configDir}.
Make sure Prisma is installed and generated:
  bun prisma generate

Or use SQL mode instead:
  db-safe sql <env> "SELECT ..."`);
  }
  const writeActions = [
    "create",
    "createMany",
    "createManyAndReturn",
    "update",
    "updateMany",
    "upsert",
    "delete",
    "deleteMany"
  ];
  const prisma = new PrismaClient({ datasourceUrl: url }).$extends({
    query: {
      $allModels: {
        async $allOperations({ model, operation, args, query }) {
          if (writeActions.includes(operation)) {
            if (writeToken) {
              if (!writeToken.startsWith("db-safe-")) {
                throw new Error("Invalid write token. Blocked by db-safe middleware.");
              }
            } else {
              throw new Error(`Write operation blocked: ${model}.${operation}
Use 'db-safe write' for write operations.`);
            }
          }
          return query(args);
        }
      }
    }
  });
  try {
    const match = query.match(/^prisma\.([\s\S]+)$/);
    if (!match) {
      throw new Error(`Invalid query format. Expected: prisma.model.action({ ... })
Example: prisma.account.findMany({ take: 5 })`);
    }
    const parts = match[1].match(/^(\w+)\.(\w+)\s*\(([\s\S]*)\)$/);
    if (!parts) {
      throw new Error(`Could not parse query. Expected: prisma.model.action({ ... })
Got: ${query}`);
    }
    const [, model, method, argsStr] = parts;
    const prismaModel = prisma[model];
    if (!prismaModel)
      throw new Error(`Unknown Prisma model: ${model}`);
    const prismaMethod = prismaModel[method];
    if (!prismaMethod)
      throw new Error(`Unknown method: ${model}.${method}`);
    let args;
    if (argsStr.trim()) {
      try {
        args = JSON.parse(argsStr);
      } catch {
        try {
          args = JSON.parse(argsStr.replace(/(\w+)\s*:/g, '"$1":').replace(/'/g, '"'));
        } catch {
          throw new Error(`Could not parse query arguments: ${argsStr}
Use JSON-compatible format: { "key": "value" }`);
        }
      }
    }
    return await prismaMethod.call(prismaModel, args);
  } finally {
    await prisma.$disconnect();
  }
}
async function main() {
  const mode = process.env.DB_SAFE_MODE || process.argv[2];
  const env = process.env.DB_SAFE_ENV || process.argv[3];
  const query = process.env.DB_SAFE_QUERY || process.argv[4];
  const configPath = process.env.DB_SAFE_CONFIG || process.argv[5];
  const format = pickFormat();
  const config = loadConfig(configPath);
  const envConfig = config.environments[env];
  if (!envConfig) {
    const available = Object.keys(config.environments).join(", ");
    emitError(`Unknown environment: ${env}`, "BAD_ENV", `Available environments: ${available}`, format);
    process.exit(1);
  }
  const label = envConfig.label || env;
  const url = resolveUrl(envConfig);
  const isWrite = mode === "sql-write" || mode === "prisma-write";
  if (isWrite) {
    if (envConfig.allowNonInteractiveWrites && !process.stdin.isTTY) {
      console.error(`\u26A0\uFE0F  WRITE on [${label}] (auto-confirmed via allowNonInteractiveWrites)`);
      console.error(`  Operation: ${query}`);
      console.error("");
    } else {
      requireTTY(query, label);
      const confirmed = await confirmWrite(query, label);
      if (!confirmed)
        process.exit(1);
    }
  }
  try {
    let result;
    if (mode === "sql-read" || mode === "sql-write") {
      result = await executeSql(url, query, mode === "sql-read" && !envConfig.allowNonInteractiveWrites);
    } else {
      const writeToken = isWrite ? `db-safe-${Date.now()}-${Math.random().toString(36).slice(2, 10)}` : undefined;
      result = await executePrisma(url, query, writeToken);
    }
    emitSuccess(result, format);
  } catch (err) {
    emitError(err.message || String(err), "QUERY_ERROR", "Check your query syntax and database connectivity.", format);
    process.exit(1);
  }
}
main();
