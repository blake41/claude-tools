#!/usr/bin/env bun
/**
 * Tail browser console output via Chrome DevTools Protocol.
 *
 * Usage (via ab):
 *   ab console-tail                       # all console output
 *   ab console-tail '[action-debug]'      # filter by prefix
 *   ab console-tail --level error         # errors + exceptions only
 *   ab watch                              # errors only + auto-screenshot
 *
 * Direct usage:
 *   bun run console-tail.ts 9333                    # all output, port 9333
 *   bun run console-tail.ts --filter '[debug]' 9333 # prefix filter
 *   bun run console-tail.ts --level error 9333      # errors only
 *   bun run console-tail.ts --watch 9333             # errors + screenshots
 *
 * Streams three CDP event sources:
 *   - Runtime.consoleAPICalled  (console.log/warn/error/etc)
 *   - Runtime.exceptionThrown   (uncaught errors, unhandled rejections)
 *   - Log.entryAdded            (browser-level: CORS, CSP, network errors)
 *
 * Reconnects automatically on tab close/crash.
 */

const LEVELS_BY_SEVERITY: Record<string, Set<string>> = {
  verbose: new Set(["log", "debug", "info", "warning", "error"]),
  info: new Set(["info", "warning", "error"]),
  warn: new Set(["warning", "error"]),
  error: new Set(["error"]),
};
const CONSOLE_TYPES = new Set(["log", "debug", "info", "warning", "error", "assert", "trace"]);
const WATCH_DIR = "/tmp/ab-watch";
const WATCH_DEBOUNCE_SECS = 2.0;

function findTab(port: number, match = "localhost:5173"): string {
  // Synchronous fetch via Bun.spawnSync to keep the reconnect loop simple
  const res = Bun.spawnSync(["curl", "-s", "--max-time", "3", `http://localhost:${port}/json`]);
  const tabs: any[] = JSON.parse(res.stdout.toString());
  const pages = tabs.filter((t) => t.type === "page");
  for (const tab of pages) {
    const url = tab.url ?? "";
    if (url.includes(match) && !url.startsWith("blob:")) return tab.webSocketDebuggerUrl;
  }
  if (pages.length > 0) return pages[0].webSocketDebuggerUrl;
  throw new Error(`No page tabs on port ${port}`);
}

function formatArg(arg: any): string {
  if ("value" in arg) {
    const v = arg.value;
    return typeof v === "string" ? v : String(v);
  }
  return arg.description ?? JSON.stringify(arg);
}

function captureScreenshot(port: number): string | null {
  const { mkdirSync, existsSync } = require("fs");
  mkdirSync(WATCH_DIR, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const path = `${WATCH_DIR}/${ts}.png`;
  try {
    Bun.spawnSync(["ab", "screenshot", "--output", path], { timeout: 10_000 });
    if (existsSync(path)) return path;
  } catch {}
  return null;
}

let msgId = 0;
function cdpSend(ws: WebSocket, method: string, params?: any): void {
  ws.send(JSON.stringify({ id: ++msgId, method, params }));
}

async function tail(
  wsUrl: string,
  prefix: string | null,
  levels: Set<string> | null,
  watch: boolean,
  port: number
): Promise<void> {
  let lastScreenshot = 0;

  return new Promise<void>((resolve, reject) => {
    const ws = new WebSocket(wsUrl);

    ws.addEventListener("open", () => {
      cdpSend(ws, "Runtime.enable");
      cdpSend(ws, "Log.enable");
      console.error(`Tailing console on ${wsUrl}`);
      if (prefix) console.error(`Filter: lines starting with '${prefix}'`);
      if (levels) console.error(`Levels: ${[...levels].sort().join(", ")}`);
      if (watch) console.error(`Watch: screenshots on errors → ${WATCH_DIR}/`);
      console.error("---");
    });

    ws.addEventListener("message", (event) => {
      const msg = JSON.parse(event.data as string);
      const method = msg.method;
      let isError = false;

      if (method === "Runtime.consoleAPICalled") {
        const params = msg.params;
        const level: string = params.type ?? "log";
        if (!CONSOLE_TYPES.has(level)) return;
        if (levels && !levels.has(level)) return;
        const text = (params.args ?? []).map(formatArg).join(" ");
        if (prefix && !text.startsWith(prefix)) return;
        if (level === "log" || level === "info") {
          console.log(text);
        } else {
          console.log(`[${level}] ${text}`);
        }
        isError = level === "error";
      } else if (method === "Runtime.exceptionThrown") {
        if (levels && !levels.has("error")) return;
        const details = msg.params.exceptionDetails ?? {};
        const exc = details.exception ?? {};
        const desc = exc.description ?? details.text ?? "Unknown exception";
        console.log(`[exception] ${desc}`);
        isError = true;
      } else if (method === "Log.entryAdded") {
        const entry = msg.params.entry ?? {};
        const level: string = entry.level ?? "info";
        if (levels && !levels.has(level)) return;
        const text: string = entry.text ?? "";
        const source: string = entry.source ?? "";
        if (prefix && !text.startsWith(prefix)) return;
        console.log(`[${source}] ${text}`);
        isError = level === "error";
      } else if (method === "Runtime.executionContextDestroyed") {
        console.error("--- page navigated ---");
      } else if (method === "Inspector.detached") {
        console.error("--- tab detached ---");
        ws.close();
        resolve();
        return;
      }

      if (watch && isError) {
        const now = performance.now() / 1000;
        if (now - lastScreenshot >= WATCH_DEBOUNCE_SECS) {
          lastScreenshot = now;
          const path = captureScreenshot(port);
          if (path) console.error(`  📸 ${path}`);
        }
      }
    });

    ws.addEventListener("close", () => resolve());
    ws.addEventListener("error", (e) => reject(e));
  });
}

async function tailWithReconnect(
  port: number,
  prefix: string | null,
  levels: Set<string> | null,
  watch: boolean
): Promise<void> {
  while (true) {
    try {
      const wsUrl = findTab(port);
      await tail(wsUrl, prefix, levels, watch, port);
    } catch (e: any) {
      if (e.name === "AbortError") throw e;
      console.error(`Disconnected: ${e.message}. Reconnecting in 2s...`);
      await Bun.sleep(2000);
    }
  }
}

// --- CLI ---
const args = process.argv.slice(2);
let prefix: string | null = null;
let levelName: string | null = null;
let watch = false;
const positionals: string[] = [];

for (let i = 0; i < args.length; i++) {
  if (args[i] === "--filter" || args[i] === "-f") {
    prefix = args[++i];
  } else if (args[i] === "--level" || args[i] === "-l") {
    levelName = args[++i];
  } else if (args[i] === "--watch" || args[i] === "-w") {
    watch = true;
  } else {
    positionals.push(args[i]);
  }
}

let port = 9333;
if (positionals.length > 0) {
  const last = Number(positionals[positionals.length - 1]);
  if (!isNaN(last)) {
    port = last;
    positionals.pop();
  }
  if (positionals.length > 0 && !prefix) {
    prefix = positionals[0];
  }
}

let levels = levelName ? LEVELS_BY_SEVERITY[levelName] ?? null : null;
if (watch && !levels) levels = LEVELS_BY_SEVERITY.error;

process.on("SIGINT", () => {
  console.error("\nDone.");
  process.exit(0);
});

tailWithReconnect(port, prefix, levels, watch);

export {};
