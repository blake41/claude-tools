#!/usr/bin/env bun
/**
 * ab — CLI entry point for browser automation.
 *
 * Replaces the 769-line bash `ab` script with a TypeScript CLI
 * that talks to the ab-server daemon via RPC over Unix socket.
 *
 * Three dispatch modes:
 *   1. Daemon lifecycle — RPC calls to ab-server
 *   2. Automation — ensure Chrome + auth via daemon, then exec agent-browser
 *   3. Standalone — exec tools directly, no daemon involvement
 */

import { spawn } from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as rpc from "./rpc";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CDP_PORT_HEADLESS = 9333;
const CDP_PORT_HEADED = 9444;
const CDP_PORT_USER = 9222;

// Default user for dev-login auth. Uses email (more reliable than Slack ID
// since email always maps to a Clerk account if the user has logged in once).
// Override with AB_AUTH_EMAIL or AB_SLACK_USER_ID env vars.
const DEFAULT_AUTH_EMAIL = process.env.AB_AUTH_EMAIL ?? "blake.johnson@clay.com";
const DEFAULT_SLACK_USER_ID = process.env.AB_SLACK_USER_ID ?? "U08M03CDY73"; // blake (staging)

const AB_DIR = path.resolve(import.meta.dir, "..");

const AGENT_BROWSER = "agent-browser";

// ---------------------------------------------------------------------------
// Session pid resolution — the single source of truth.
//
// pid := AB_SESSION_PID (set by subagent hook) ?? CCO_SESSION_ID (main thread)
// file := /tmp/.ab-session-<pid>   (existence = initialized, content = pid)
// session := ab-<pid>               (agent-browser session identity)
// ---------------------------------------------------------------------------

export function resolvePid(): string | null {
  return process.env.AB_SESSION_PID ?? process.env.CCO_SESSION_ID ?? null;
}

export function sessionFilePath(pid: string | null = resolvePid()): string | null {
  return pid ? `/tmp/.ab-session-${pid}` : null;
}

export function buildSessionName(pid: string | null = resolvePid()): string {
  return pid ? `ab-${pid}` : "ab-default";
}

// ---------------------------------------------------------------------------
// Stderr helpers
// ---------------------------------------------------------------------------

function gray(text: string): void {
  process.stderr.write(`\x1b[90m${text}\x1b[0m\n`);
}

function stderr(text: string): void {
  process.stderr.write(text + "\n");
}

// ---------------------------------------------------------------------------
// Exec helpers
// ---------------------------------------------------------------------------

interface ExecResult {
  exitCode: number;
}

/**
 * Spawn a child process, inheriting stdio. Returns when the process exits.
 */
function execInherit(cmd: string, args: string[], env?: Record<string, string>): Promise<ExecResult> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      stdio: "inherit",
      env: { ...process.env, ...env },
    });
    child.on("error", (err) => {
      stderr(`Failed to spawn ${cmd}: ${err.message}`);
      resolve({ exitCode: 1 });
    });
    child.on("close", (code) => {
      resolve({ exitCode: code ?? 1 });
    });
  });
}

/**
 * Build the agent-browser command args with session and CDP port.
 */
function abArgs(cdpPort: number, sessionName: string | null, args: string[]): string[] {
  const result = ["--cdp", String(cdpPort)];
  if (sessionName) {
    result.push("--session", sessionName);
  }
  return [...result, ...args];
}

/**
 * Run agent-browser with inherited stdio.
 */
async function runAgentBrowser(
  cdpPort: number,
  sessionName: string | null,
  args: string[],
): Promise<ExecResult> {
  return execInherit(
    AGENT_BROWSER,
    abArgs(cdpPort, sessionName, args),
    { AGENT_BROWSER_IDLE_TIMEOUT_MS: process.env.AGENT_BROWSER_IDLE_TIMEOUT_MS ?? "600000" },
  );
}

// ---------------------------------------------------------------------------
// Flag parsing
// ---------------------------------------------------------------------------

interface ParsedFlags {
  headed: boolean;
  userChrome: boolean;
  args: string[];
}

export class RemovedFlagError extends Error {
  constructor(flag: string) {
    super(
      `${flag} is removed. Session identity now comes from the pid (AB_SESSION_PID in subagents, CCO_SESSION_ID on the main thread). Run 'ab new-session' to initialize.`,
    );
    this.name = "RemovedFlagError";
  }
}

export function parseFlags(argv: string[]): ParsedFlags {
  const result: ParsedFlags = {
    headed: false,
    userChrome: false,
    args: [],
  };

  let i = 0;
  while (i < argv.length) {
    const arg = argv[i];
    if (arg === "--headed") {
      result.headed = true;
      i++;
    } else if (arg === "--user-chrome") {
      result.userChrome = true;
      i++;
    } else if (arg === "--session-name" || arg === "--session") {
      throw new RemovedFlagError(arg);
    } else {
      result.args.push(arg);
      i++;
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Ensure Chrome is running via daemon
// ---------------------------------------------------------------------------

async function ensureChromePort(headed: boolean): Promise<number> {
  if (headed) {
    const result = await rpc.ensureChromeHeaded();
    return result.port;
  }
  const result = await rpc.ensureChrome();
  return result.port;
}

// ---------------------------------------------------------------------------
// Command handlers
// ---------------------------------------------------------------------------

async function cmdStatus(): Promise<number> {
  const result = await rpc.status();
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  return 0;
}

async function cmdEnsure(headed: boolean): Promise<number> {
  if (headed) {
    const result = await rpc.ensureChromeHeaded();
    stderr(
      result.alreadyRunning
        ? `Chrome headed already running (port ${result.port})`
        : `Chrome headed started (port ${result.port}, PID ${result.pid})`,
    );
  } else {
    const result = await rpc.ensureChrome();
    stderr(
      result.alreadyRunning
        ? `Chrome headless already running (port ${result.port})`
        : `Chrome headless started (port ${result.port}, PID ${result.pid})`,
    );
  }
  return 0;
}

async function cmdHeal(): Promise<number> {
  const result = await rpc.heal();
  stderr(`Healed. Actions: ${result.actions.join(", ")}`);
  return 0;
}

async function cmdReauth(cdpPort: number, sessionName: string | null): Promise<number> {
  const result = await rpc.authLogin({
    sessionId: sessionName ?? "default",
    port: cdpPort,
    email: DEFAULT_AUTH_EMAIL,
    slackUserId: DEFAULT_SLACK_USER_ID,
    apiBaseUrl: process.env.AB_API_BASE_URL,
    appBaseUrl: process.env.AB_APP_BASE_URL,
  });
  if (result.ok) {
    stderr("Reauth complete");
    if (result.user) {
      stderr(`  User: ${result.user.email} (${result.user.slackUserId})`);
    }
  } else {
    stderr(`Reauth failed: ${result.error}`);
    return 1;
  }
  return 0;
}

async function cmdOpen(
  url: string,
  cdpPort: number,
  sessionName: string | null,
): Promise<number> {
  // Create a dedicated tab for this session so parallel sessions don't collide.
  // tab new sets the new tab as active, so subsequent commands target it.
  await runAgentBrowser(cdpPort, sessionName, ["tab", "new", url]);
  await runAgentBrowser(cdpPort, sessionName, ["set", "viewport", "1440", "900", "2"]);
  return 0;
}

async function cmdImport(): Promise<number> {
  if (process.env.CCO_SESSION_ID) {
    stderr("Cannot import inside sandbox. Run 'ab import' from a terminal.");
    return 1;
  }

  // Ensure headed Chrome
  const result = await rpc.ensureChromeHeaded();
  stderr(`Headed Chrome on port ${result.port}`);

  // Open the exchange URL
  const exchangeUrl = "http://localhost:5173/?renderer=v4";
  stderr("");
  stderr("A Chrome window is available. Log into Google/Clerk on:");
  stderr("  1. http://localhost:5173 (local dev)");
  stderr("  2. https://slack-feedback-staging.onrender.com (staging)");
  stderr("  3. https://terra.clay.com (production)");
  stderr("");
  stderr("Press Enter here when done logging in.");
  stderr("");

  await runAgentBrowser(result.port, null, ["open", exchangeUrl]);

  // Wait for stdin Enter
  await new Promise<void>((resolve) => {
    process.stdin.once("data", () => resolve());
    process.stdin.resume();
  });

  // Trigger auth grab via daemon
  const authResult = await rpc.authLogin({
    sessionId: "import",
    port: result.port,
    email: DEFAULT_AUTH_EMAIL,
    slackUserId: DEFAULT_SLACK_USER_ID,
    apiBaseUrl: process.env.AB_API_BASE_URL,
    appBaseUrl: process.env.AB_APP_BASE_URL,
  });

  if (authResult.ok) {
    stderr("Import complete. Auth established.");
  } else {
    stderr(`Import auth failed: ${authResult.error}`);
    return 1;
  }

  return 0;
}

function cmdNewSession(): number {
  const pid = resolvePid();
  if (!pid) {
    stderr(
      "Cannot initialize session: neither AB_SESSION_PID nor CCO_SESSION_ID is set.",
    );
    return 1;
  }
  const fp = sessionFilePath(pid)!;
  if (!fs.existsSync(fp)) {
    fs.writeFileSync(fp, pid + "\n");
  }
  process.stdout.write(pid + "\n");
  return 0;
}

// ---------------------------------------------------------------------------
// ab ps + ab gc — session inventory and cleanup.
//
// The filesystem (/tmp/.ab-session-*) is the source of truth. We don't query
// the daemon for liveness — if a follow-up exposes a listSessions RPC we can
// upgrade later. For now, file exists = live; mtime > STALE_AGE_MS = stale.
// ---------------------------------------------------------------------------

const SESSION_FILE_PREFIX = "/tmp/.ab-session-";
const WRAPPER_PREFIX = "/tmp/ab-";
const STALE_AGE_MS = 24 * 60 * 60 * 1000;

export interface SessionEntry {
  pid: string;
  session: string;
  owner: "self" | "self (main-thread)" | "subagent" | "other-cc" | "other-cc (subagent)";
  mtimeIso: string;
  ageSeconds: number;
  stale: boolean;
}

export function listSessionEntries(now: Date = new Date()): SessionEntry[] {
  const dir = "/tmp";
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const prefix = ".ab-session-";
  const selfPid = resolvePid();
  const cco = process.env.CCO_SESSION_ID;
  const entries: SessionEntry[] = [];
  for (const name of names) {
    if (!name.startsWith(prefix)) continue;
    const pid = name.slice(prefix.length);
    if (!pid) continue;
    const fp = `${dir}/${name}`;
    let stat: fs.Stats;
    try {
      stat = fs.statSync(fp);
    } catch {
      continue;
    }
    if (!stat.isFile()) continue;
    const ageMs = now.getTime() - stat.mtimeMs;
    entries.push({
      pid,
      session: `ab-${pid}`,
      owner: classifyOwner(pid, selfPid, cco),
      mtimeIso: new Date(stat.mtimeMs).toISOString(),
      ageSeconds: Math.max(0, Math.floor(ageMs / 1000)),
      stale: ageMs > STALE_AGE_MS,
    });
  }
  entries.sort((a, b) => {
    // self first, then lexicographic by pid
    if (a.owner === "self" && b.owner !== "self") return -1;
    if (b.owner === "self" && a.owner !== "self") return 1;
    return a.pid.localeCompare(b.pid);
  });
  return entries;
}

function classifyOwner(
  pid: string,
  selfPid: string | null,
  cco: string | undefined,
): SessionEntry["owner"] {
  if (selfPid && pid === selfPid) return "self";
  if (cco && pid === cco) return "self (main-thread)";
  if (cco && pid.startsWith(cco + "-")) return "subagent";
  return pid.includes("-") ? "other-cc (subagent)" : "other-cc";
}

function formatAge(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86400)}d`;
}

function cmdPs(args: string[]): number {
  const json = args.includes("--json");
  const entries = listSessionEntries();
  if (json) {
    process.stdout.write(JSON.stringify(entries, null, 2) + "\n");
    return 0;
  }
  if (entries.length === 0) {
    stderr("No active browser sessions.");
    return 0;
  }
  const pidW = Math.max(3, ...entries.map((e) => e.pid.length));
  const ownerW = Math.max(5, ...entries.map((e) => e.owner.length));
  const header = `  ${"PID".padEnd(pidW)}  ${"OWNER".padEnd(ownerW)}  ${"AGE".padEnd(6)}  STATUS`;
  process.stdout.write(header + "\n");
  let anyStale = false;
  for (const e of entries) {
    const marker = e.owner === "self" ? "*" : " ";
    const status = e.stale ? "stale" : "live";
    if (e.stale) anyStale = true;
    process.stdout.write(
      `${marker} ${e.pid.padEnd(pidW)}  ${e.owner.padEnd(ownerW)}  ${formatAge(e.ageSeconds).padEnd(6)}  ${status}\n`,
    );
  }
  if (anyStale) {
    stderr("Run `ab gc` to prune stale sessions.");
  }
  return 0;
}

function cmdGc(args: string[]): number {
  const dryRun = args.includes("--dry-run");
  const entries = listSessionEntries();
  const targets = entries.filter((e) => e.stale);
  if (targets.length === 0) {
    stderr("Nothing to prune.");
    return 0;
  }
  for (const e of targets) {
    const sessionFile = `${SESSION_FILE_PREFIX}${e.pid}`;
    const wrapper = `${WRAPPER_PREFIX}${e.pid}`;
    if (dryRun) {
      process.stdout.write(`would remove: ${sessionFile}\n`);
      if (fs.existsSync(wrapper)) {
        process.stdout.write(`would remove: ${wrapper}\n`);
      }
    } else {
      try { fs.unlinkSync(sessionFile); } catch { /* race: already gone */ }
      try { fs.unlinkSync(wrapper); } catch { /* wrapper may not exist */ }
      stderr(`removed: ${e.pid}`);
    }
  }
  return 0;
}

async function cmdConsoleTail(args: string[], cdpPort: number): Promise<number> {
  const script = path.join(AB_DIR, "console-tail.ts");
  const result = await execInherit("bun", ["run", script, ...args, String(cdpPort)]);
  return result.exitCode;
}

async function cmdWatch(args: string[], cdpPort: number): Promise<number> {
  const script = path.join(AB_DIR, "console-tail.ts");
  const result = await execInherit("bun", ["run", script, "--watch", ...args, String(cdpPort)]);
  return result.exitCode;
}

async function cmdClickJs(args: string[], cdpPort: number): Promise<number> {
  const script = path.join(AB_DIR, "cdp-click.ts");
  const result = await execInherit("bun", ["run", script, String(cdpPort), ...args]);
  return result.exitCode;
}

async function cmdLocalStorage(
  subCmd: string,
  key: string,
  value: string | undefined,
  cdpPort: number,
  sessionName: string | null,
): Promise<number> {
  if (subCmd === "get") {
    const result = await runAgentBrowser(cdpPort, sessionName, [
      "eval",
      `localStorage.getItem(${JSON.stringify(key)})`,
    ]);
    return result.exitCode;
  }
  if (subCmd === "set") {
    const result = await runAgentBrowser(cdpPort, sessionName, [
      "eval",
      `localStorage.setItem(${JSON.stringify(key)},${JSON.stringify(value ?? "")});'ok'`,
    ]);
    return result.exitCode;
  }

  stderr("Usage: ab localStorage <get|set> <key> [value]");
  return 1;
}

async function cmdDashboard(
  subCmd: string,
  cdpPort: number,
  sessionName: string | null,
): Promise<number> {
  if (!["start", "stop", "restart", "status"].includes(subCmd)) {
    stderr("Usage: ab dashboard <start|stop|restart|status>");
    return 1;
  }
  const result = await runAgentBrowser(cdpPort, sessionName, [
    "dashboard",
    subCmd,
  ]);
  return result.exitCode;
}

async function cmdRecord(
  subCmd: string,
  outputFile: string | undefined,
  cdpPort: number,
  sessionName: string | null,
): Promise<number> {
  if (subCmd === "start") {
    if (!outputFile) {
      stderr("Usage: ab record start <output.webm>");
      return 1;
    }
    const result = await runAgentBrowser(cdpPort, sessionName, [
      "record",
      "start",
      outputFile,
    ]);
    return result.exitCode;
  }
  if (subCmd === "stop") {
    const result = await runAgentBrowser(cdpPort, sessionName, ["record", "stop"]);
    return result.exitCode;
  }
  stderr("Usage: ab record <start|stop> [output.webm]");
  return 1;
}

// ---------------------------------------------------------------------------
// Passthrough commands — ensure Chrome, then forward to agent-browser
// ---------------------------------------------------------------------------

const PASSTHROUGH_COMMANDS = new Set([
  "click",
  "dblclick",
  "fill",
  "type",
  "select",
  "check",
  "press",
  "hover",
  "scroll",
  "find",
  "get",
  "wait",
  "highlight",
  "snapshot",
  "screenshot",
  "pdf",
  "diff",
  "set",
  "keyboard",
  "frame",
]);

const BLOCKED_COMMANDS = new Set(["eval", "js", "execute"]);

/** Commands that require a managed Chrome instance (ensureChromePort). */
const NEEDS_CHROME = new Set([
  ...PASSTHROUGH_COMMANDS,
  "open",
  "navigate",
  "goto",
  "record",
  "localStorage",
  "dashboard",
  "reauth",
]);

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<number> {
  // Parse flags from process.argv (skip bun and script path)
  const rawArgs = process.argv.slice(2);
  let flags: ParsedFlags;
  try {
    flags = parseFlags(rawArgs);
  } catch (err) {
    if (err instanceof RemovedFlagError) {
      stderr(err.message);
      return 2;
    }
    throw err;
  }

  const command = flags.args[0] ?? "";
  const rest = flags.args.slice(1);

  // Resolve session identity from pid (see resolvePid above).
  const pid = resolvePid();
  const sessionName = buildSessionName(pid);

  // Resolve CDP port based on flags
  let cdpPort: number;
  if (flags.userChrome) {
    cdpPort = CDP_PORT_USER;
  } else if (flags.headed) {
    cdpPort = CDP_PORT_HEADED;
  } else {
    cdpPort = CDP_PORT_HEADLESS;
  }

  // Session identity display (gray on stderr)
  gray(`[${sessionName}]`);

  // -----------------------------------------------------------------------
  // Blocked commands
  // -----------------------------------------------------------------------

  if (BLOCKED_COMMANDS.has(command)) {
    if (flags.userChrome) {
      // Allowed with --user-chrome
      const result = await runAgentBrowser(cdpPort, sessionName, flags.args);
      return result.exitCode;
    }
    stderr(
      "BLOCKED: eval is not allowed. Use snapshot + refs for interaction, localStorage commands for storage.",
    );
    return 1;
  }

  // -----------------------------------------------------------------------
  // Dispatch
  // -----------------------------------------------------------------------

  try {
    // -- Ensure Chrome once for all commands that need it --
    if (NEEDS_CHROME.has(command) && !flags.userChrome) {
      cdpPort = await ensureChromePort(flags.headed);
    }

    // -- Daemon lifecycle --
    if (command === "status") return await cmdStatus();
    if (command === "ensure") return await cmdEnsure(flags.headed);
    if (command === "heal") return await cmdHeal();
    if (command === "reauth") return await cmdReauth(cdpPort, sessionName);

    // -- Standalone --
    if (command === "new-session") return cmdNewSession();
    if (command === "ps") return cmdPs(rest);
    if (command === "gc") return cmdGc(rest);
    if (command === "console-tail") return await cmdConsoleTail(rest, cdpPort);
    if (command === "watch") return await cmdWatch(rest, cdpPort);
    if (command === "click-js") return await cmdClickJs(rest, cdpPort);

    // -- Interactive --
    if (command === "import") return await cmdImport();

    // -- Navigation (open/navigate/goto) --
    if (command === "open" || command === "navigate" || command === "goto") {
      const url = rest[0] ?? "about:blank";
      return await cmdOpen(url, cdpPort, sessionName);
    }

    // -- Recording --
    if (command === "record") {
      return await cmdRecord(rest[0] ?? "", rest[1], cdpPort, sessionName);
    }

    // -- Storage --
    if (command === "localStorage") {
      return await cmdLocalStorage(
        rest[0] ?? "",
        rest[1] ?? "",
        rest[2],
        cdpPort,
        sessionName,
      );
    }

    // -- Dashboard --
    if (command === "dashboard") {
      return await cmdDashboard(rest[0] ?? "", cdpPort, sessionName);
    }

    // -- Passthrough commands --
    if (PASSTHROUGH_COMMANDS.has(command)) {
      const result = await runAgentBrowser(cdpPort, sessionName, flags.args);
      // Bump headed idle timer (fire-and-forget) so headed Chrome stays alive during use
      if (flags.headed) {
        rpc.touchHeaded().catch(() => {});
      }
      return result.exitCode;
    }

    // -- No command / unknown --
    if (!command) {
      printUsage();
      return 1;
    }

    stderr(`Unknown command: ${command}`);
    stderr("Run 'ab' with no arguments to see available commands.");
    return 1;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    stderr(msg);
    return 1;
  }
}

// ---------------------------------------------------------------------------
// Usage
// ---------------------------------------------------------------------------

function printUsage(): void {
  stderr("Usage: ab <command> [args...]");
  stderr("");
  stderr("Navigation:");
  stderr("  open <url>          Navigate (creates tab per session)");
  stderr("");
  stderr("Interaction:");
  stderr('  snapshot -i         Discover interactive elements (get @refs)');
  stderr("  click @ref          Click element");
  stderr('  fill @ref "text"    Clear and type text');
  stderr('  type @ref "text"    Type without clearing');
  stderr('  select @ref "opt"   Select dropdown option');
  stderr("  check @ref          Check checkbox");
  stderr("  press Enter         Press key");
  stderr("  scroll down 500     Scroll page");
  stderr('  find text "X" click Semantic click by text');
  stderr('  keyboard type "X"   Type at current focus');
  stderr("");
  stderr("Inspection:");
  stderr("  screenshot          Screenshot to /tmp/agent-browser/");
  stderr("  get text @ref       Get element text");
  stderr("  get url             Get current URL");
  stderr("  wait --load networkidle  Wait for page load");
  stderr("  diff snapshot       Compare current vs last snapshot");
  stderr("  highlight @ref      Highlight element visually");
  stderr("");
  stderr("Recording:");
  stderr("  record start <file> Record video of active tab");
  stderr("  record stop         Stop recording");
  stderr("");
  stderr("Debugging:");
  stderr("  console-tail [pfx]  Stream console output via CDP");
  stderr("  watch               Errors + auto-screenshot");
  stderr("");
  stderr("Auth & Lifecycle:");
  stderr("  reauth              Re-authenticate via daemon");
  stderr("  import              Headed login (manual Google/Clerk auth)");
  stderr("  heal                Kill all Chrome, restart fresh");
  stderr("  status              Show daemon status (JSON)");
  stderr("  ensure              Ensure Chrome is running");
  stderr("  dashboard <cmd>     Dashboard management");
  stderr("");
  stderr("Storage:");
  stderr("  localStorage get <key>          Read localStorage");
  stderr("  localStorage set <key> <value>  Write localStorage");
  stderr("");
  stderr("Sessions:");
  stderr("  new-session         Initialize session file for current pid (idempotent)");
  stderr("  ps [--json]         List active browser sessions (pid, owner, age, status)");
  stderr("  gc [--dry-run]      Prune stale session files and wrappers");
  stderr("");
  stderr("Other:");
  stderr("  click-js <args>     JS-based click (for React virtualized lists)");
  stderr("");
  stderr("Flags:");
  stderr("  --headed            Use headed Chrome (port 9444)");
  stderr("  --user-chrome       Use personal Chrome (port 9222), allows eval");
  stderr("");
  stderr("Environment:");
  stderr("  AB_SLACK_USER_ID    Override default Slack user for dev-login auth");
  stderr("  AB_SESSION_PID      Session pid (set by subagent hook; falls back to CCO_SESSION_ID)");
  stderr("  CCO_SESSION_ID      Claude Code session ID (auto-set by sandbox)");
}

// ---------------------------------------------------------------------------
// Entry — only run when executed directly, not when imported as a module (e.g. tests).
// ---------------------------------------------------------------------------

// @ts-expect-error -- Bun exposes import.meta.main
if (import.meta.main) {
  main().then((code) => {
    process.exit(code);
  }).catch((err) => {
    process.stderr.write(String(err) + "\n");
    process.exit(1);
  });
}
