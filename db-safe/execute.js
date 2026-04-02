#!/usr/bin/env bun
// @bun
var __create = Object.create;
var __getProtoOf = Object.getPrototypeOf;
var __defProp = Object.defineProperty;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __toESM = (mod, isNodeMode, target) => {
  target = mod != null ? __create(__getProtoOf(mod)) : {};
  const to = isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target;
  for (let key of __getOwnPropNames(mod))
    if (!__hasOwnProp.call(to, key))
      __defProp(to, key, {
        get: () => mod[key],
        enumerable: true
      });
  return to;
};
var __commonJS = (cb, mod) => () => (mod || cb((mod = { exports: {} }).exports, mod), mod.exports);
var __require = import.meta.require;

// execute.ts
import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { createInterface } from "readline";
var require_execute = __commonJS((exports, module) => {
  function loadConfig(configPath) {
    const raw = readFileSync(configPath, "utf-8");
    return JSON.parse(raw);
  }
  function resolveUrl(envConfig) {
    let url2 = envConfig.url;
    url2 = url2.replace(/\$([A-Z_][A-Z0-9_]*)/g, (_match, varName) => {
      return process.env[varName] || "";
    });
    if (url2)
      return url2;
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
  function requireTTY(query2, label) {
    if (!process.stdin.isTTY) {
      const output = {
        ok: false,
        command: "db-safe",
        error: {
          message: "Write operations require an interactive terminal (TTY).",
          code: "NO_TTY"
        },
        fix: `Run this command manually in your terminal:
  db-safe sql:write ${label.toLowerCase()} '${query2.replace(/'/g, "'\\''")}'`,
        next_actions: []
      };
      console.log(JSON.stringify(output));
      process.exit(1);
    }
  }
  async function confirmWrite(query2, label) {
    console.error("");
    console.error(`\u26A0\uFE0F  WRITE on [${label}]`);
    console.error("");
    console.error(`  Operation: ${query2}`);
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
  async function executeSql(url2, sql) {
    let pg;
    try {
      pg = await import("pg");
    } catch {
      throw new Error("Could not load 'pg' module. Install it in your project: bun add pg");
    }
    const Client = pg.default?.Client || pg.Client;
    const client = new Client({
      connectionString: url2,
      ssl: url2.includes("render.com") ? { rejectUnauthorized: false } : undefined
    });
    try {
      await client.connect();
      const result = await client.query(sql);
      return result.rows;
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
    const prisma = new PrismaClient({ datasourceUrl: url });
    if (writeToken) {
      prisma.$use(async (params, next) => {
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
        if (writeActions.includes(params.action)) {
          if (!writeToken.startsWith("db-safe-")) {
            throw new Error("Invalid write token. Blocked by db-safe middleware.");
          }
        }
        return next(params);
      });
    } else {
      prisma.$use(async (params, next) => {
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
        if (writeActions.includes(params.action)) {
          throw new Error(`Write operation blocked: ${params.model}.${params.action}
Use 'db-safe write' for write operations.`);
        }
        return next(params);
      });
    }
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
          const jsonStr = argsStr.replace(/(\w+)\s*:/g, '"$1":').replace(/'/g, '"');
          args = JSON.parse(jsonStr);
        } catch {
          try {
            args = eval(`(${argsStr})`);
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
    const query2 = process.env.DB_SAFE_QUERY || process.argv[4];
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
          code: "BAD_ENV"
        },
        fix: `Available environments: ${available}`,
        next_actions: []
      };
      console.log(JSON.stringify(output));
      process.exit(1);
    }
    const label = envConfig.label || env;
    const url2 = resolveUrl(envConfig);
    const isWrite = mode === "sql-write" || mode === "prisma-write";
    if (isWrite) {
      if (envConfig.allowNonInteractiveWrites && !process.stdin.isTTY) {
        console.error(`\u26A0\uFE0F  WRITE on [${label}] (auto-confirmed via allowNonInteractiveWrites)`);
        console.error(`  Operation: ${query2}`);
        console.error("");
      } else {
        requireTTY(query2, label);
        const confirmed = await confirmWrite(query2, label);
        if (!confirmed)
          process.exit(1);
      }
    }
    try {
      let result;
      if (mode === "sql-read" || mode === "sql-write") {
        result = await executeSql(url2, query2);
      } else {
        const writeToken2 = isWrite ? `db-safe-${Date.now()}-${Math.random().toString(36).slice(2, 10)}` : undefined;
        result = await executePrisma(url2, query2, writeToken2);
      }
      const output = {
        ok: true,
        command: "db-safe",
        result,
        next_actions: []
      };
      console.log(JSON.stringify(output, null, 2));
    } catch (err) {
      const output = {
        ok: false,
        command: "db-safe",
        error: {
          message: err.message || String(err),
          code: "QUERY_ERROR"
        },
        fix: "Check your query syntax and database connectivity.",
        next_actions: []
      };
      console.log(JSON.stringify(output));
      process.exit(1);
    }
  }
  main();
});
export default require_execute();
