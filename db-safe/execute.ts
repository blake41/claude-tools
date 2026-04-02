#!/usr/bin/env bun
/**
 * db-safe execute.ts — Query execution engine
 *
 * Invoked by the db-safe bash wrapper:
 *   bun execute.ts <mode> <env> <query> <config-path>
 *
 * Modes: prisma-read, prisma-write, sql-read, sql-write
 */

import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { createInterface } from "readline";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface EnvConfig {
  url: string;
  label?: string;
  infisical?: { env: string; secret: string };
  /** Allow write operations without TTY confirmation (for non-production envs) */
  allowNonInteractiveWrites?: boolean;
}

interface Config {
  environments: Record<string, EnvConfig>;
}

// ---------------------------------------------------------------------------
// Config & URL resolution
// ---------------------------------------------------------------------------

function loadConfig(configPath: string): Config {
  const raw = readFileSync(configPath, "utf-8");
  return JSON.parse(raw);
}

/**
 * Resolve a connection URL. Expands $ENV_VAR references.
 * Falls back to Infisical if env var is empty and infisical config is present.
 */
function resolveUrl(envConfig: EnvConfig): string {
  let url = envConfig.url;

  // Expand $VAR_NAME references
  url = url.replace(/\$([A-Z_][A-Z0-9_]*)/g, (_match, varName) => {
    return process.env[varName] || "";
  });

  if (url) return url;

  // Fallback: try Infisical if configured
  if (envConfig.infisical) {
    try {
      const { execSync } = require("child_process");
      const result = execSync(
        `infisical secrets get ${envConfig.infisical.secret} --env=${envConfig.infisical.env} --plain`,
        { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }
      );
      return result.trim();
    } catch {
      throw new Error(
        `Failed to resolve database URL. Env var is empty and Infisical fetch failed.\n` +
          `Make sure the env var is set or run: infisical login`
      );
    }
  }

  throw new Error(
    `Database URL resolved to empty string. Check your .db-safe.json and environment variables.`
  );
}

// ---------------------------------------------------------------------------
// TTY confirmation (simplified: just "yes")
// ---------------------------------------------------------------------------

function requireTTY(query: string, label: string): void {
  if (!process.stdin.isTTY) {
    const output = {
      ok: false,
      command: "db-safe",
      error: {
        message: "Write operations require an interactive terminal (TTY).",
        code: "NO_TTY",
      },
      fix: `Run this command manually in your terminal:\n  db-safe sql:write ${label.toLowerCase()} '${query.replace(/'/g, "'\\''")}'`,
      next_actions: [],
    };
    console.log(JSON.stringify(output));
    process.exit(1);
  }
}

async function confirmWrite(query: string, label: string): Promise<boolean> {
  console.error("");
  console.error(`⚠️  WRITE on [${label}]`);
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

// ---------------------------------------------------------------------------
// SQL execution (raw pg)
// ---------------------------------------------------------------------------

async function executeSql(url: string, sql: string): Promise<unknown> {
  // Try to load pg from the project's node_modules first, then from bun's global
  let pg: any;
  try {
    pg = await import("pg");
  } catch {
    throw new Error(
      "Could not load 'pg' module. Install it in your project: bun add pg"
    );
  }

  const Client = pg.default?.Client || pg.Client;
  const client = new Client({
    connectionString: url,
    ssl: url.includes("render.com") ? { rejectUnauthorized: false } : undefined,
  });

  try {
    await client.connect();
    const result = await client.query(sql);
    return result.rows;
  } finally {
    await client.end();
  }
}

// ---------------------------------------------------------------------------
// Prisma execution
// ---------------------------------------------------------------------------

async function executePrisma(
  url: string,
  query: string,
  writeToken?: string
): Promise<unknown> {
  // Find the project root from the config file location
  const cfgPath = process.env.DB_SAFE_CONFIG || process.argv[5];
  const configDir = dirname(cfgPath);

  // Try to load Prisma from the project
  let PrismaClient: any;
  try {
    const prismaPath = resolve(configDir, "node_modules", "@prisma", "client");
    const mod = await import(prismaPath);
    PrismaClient = mod.PrismaClient;
  } catch {
    throw new Error(
      `Could not load @prisma/client from project at ${configDir}.\n` +
        "Make sure Prisma is installed and generated:\n" +
        "  bun prisma generate\n\n" +
        "Or use SQL mode instead:\n" +
        '  db-safe sql <env> "SELECT ..."'
    );
  }

  const prisma = new PrismaClient({ datasourceUrl: url });

  // Add write protection middleware
  if (writeToken) {
    prisma.$use(async (params: any, next: any) => {
      const writeActions = [
        "create", "createMany", "createManyAndReturn",
        "update", "updateMany", "upsert",
        "delete", "deleteMany",
      ];
      if (writeActions.includes(params.action)) {
        if (!writeToken.startsWith("db-safe-")) {
          throw new Error("Invalid write token. Blocked by db-safe middleware.");
        }
      }
      return next(params);
    });
  } else {
    // Read mode: block all writes
    prisma.$use(async (params: any, next: any) => {
      const writeActions = [
        "create", "createMany", "createManyAndReturn",
        "update", "updateMany", "upsert",
        "delete", "deleteMany",
      ];
      if (writeActions.includes(params.action)) {
        throw new Error(
          `Write operation blocked: ${params.model}.${params.action}\n` +
            "Use 'db-safe write' for write operations."
        );
      }
      return next(params);
    });
  }

  try {
    // Parse: prisma.model.action({ ... })
    const match = query.match(/^prisma\.([\s\S]+)$/);
    if (!match) {
      throw new Error(
        'Invalid query format. Expected: prisma.model.action({ ... })\n' +
          "Example: prisma.account.findMany({ take: 5 })"
      );
    }

    const parts = match[1].match(/^(\w+)\.(\w+)\s*\(([\s\S]*)\)$/);
    if (!parts) {
      throw new Error(
        `Could not parse query. Expected: prisma.model.action({ ... })\nGot: ${query}`
      );
    }

    const [, model, method, argsStr] = parts;

    const prismaModel = prisma[model];
    if (!prismaModel) throw new Error(`Unknown Prisma model: ${model}`);

    const prismaMethod = prismaModel[method];
    if (!prismaMethod)
      throw new Error(`Unknown method: ${model}.${method}`);

    let args: any;
    if (argsStr.trim()) {
      try {
        // Convert JS-like object syntax to JSON
        const jsonStr = argsStr
          .replace(/(\w+)\s*:/g, '"$1":')
          .replace(/'/g, '"');
        args = JSON.parse(jsonStr);
      } catch {
        try {
          args = eval(`(${argsStr})`);
        } catch {
          throw new Error(
            `Could not parse query arguments: ${argsStr}\n` +
              'Use JSON-compatible format: { "key": "value" }'
          );
        }
      }
    }

    return await prismaMethod.call(prismaModel, args);
  } finally {
    await prisma.$disconnect();
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  // Support both argv and env var input (env vars used to avoid sandbox issues)
  const mode = process.env.DB_SAFE_MODE || process.argv[2];
  const env = process.env.DB_SAFE_ENV || process.argv[3];
  const query = process.env.DB_SAFE_QUERY || process.argv[4];
  const configPath = process.env.DB_SAFE_CONFIG || process.argv[5];

  const config = loadConfig(configPath);
  const envConfig = config.environments[env];

  if (!envConfig) {
    const available = Object.keys(config.environments).join(", ");
    const output = {
      ok: false,
      command: "db-safe",
      error: {
        message: `Unknown environment: ${env}`,
        code: "BAD_ENV",
      },
      fix: `Available environments: ${available}`,
      next_actions: [],
    };
    console.log(JSON.stringify(output));
    process.exit(1);
  }

  const label = envConfig.label || env;
  const url = resolveUrl(envConfig);
  const isWrite = mode === "sql-write" || mode === "prisma-write";

  // Write guard
  if (isWrite) {
    if (envConfig.allowNonInteractiveWrites && !process.stdin.isTTY) {
      // Skip TTY check and confirmation for explicitly opted-in environments
      console.error(`⚠️  WRITE on [${label}] (auto-confirmed via allowNonInteractiveWrites)`);
      console.error(`  Operation: ${query}`);
      console.error("");
    } else {
      requireTTY(query, label);
      const confirmed = await confirmWrite(query, label);
      if (!confirmed) process.exit(1);
    }
  }

  try {
    let result: unknown;

    if (mode === "sql-read" || mode === "sql-write") {
      result = await executeSql(url, query);
    } else {
      const writeToken = isWrite
        ? `db-safe-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
        : undefined;
      result = await executePrisma(url, query, writeToken);
    }

    const output = {
      ok: true,
      command: "db-safe",
      result,
      next_actions: [],
    };
    console.log(JSON.stringify(output, null, 2));
  } catch (err: any) {
    const output = {
      ok: false,
      command: "db-safe",
      error: {
        message: err.message || String(err),
        code: "QUERY_ERROR",
      },
      fix: "Check your query syntax and database connectivity.",
      next_actions: [],
    };
    console.log(JSON.stringify(output));
    process.exit(1);
  }
}

main();
