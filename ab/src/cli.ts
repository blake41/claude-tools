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
import * as os from "os";
import * as path from "path";
import * as rpc from "./rpc";
import { HEADLESS_POOL_SIZE } from "./types";
import type { ChromeState } from "./types";

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
//         line 2 is optional: `shard=<i>`, the session's sticky headless
//         pool shard (chrome-pool-plan.md Unit 2, decision 3). Written
//         lazily the first time a session needs headless Chrome.
// session := ab-<pid>               (agent-browser session identity)
// ---------------------------------------------------------------------------

/** Literal pid used when neither AB_SESSION_PID nor CCO_SESSION_ID is set. */
export const DEFAULT_PID = "default";

export function resolvePid(): string {
  return process.env.AB_SESSION_PID ?? process.env.CCO_SESSION_ID ?? DEFAULT_PID;
}

export function sessionFilePath(pid: string = resolvePid()): string {
  return `/tmp/.ab-session-${pid}`;
}

export function buildSessionName(pid: string = resolvePid()): string {
  return `ab-${pid}`;
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
// Sticky shard mapping (chrome-pool-plan.md Unit 2, decisions 3 & 6)
//
// Persisted in the session marker's optional second line: `shard=<i>`.
// Assignment is least-loaded — count `shard=` lines across current
// non-stale markers, pick the fewest (ties -> lowest index) — computed
// CLI-side from /tmp, no daemon RPC or daemon-side state, and it
// self-corrects as `ab gc` removes stale markers.
//
// Race note: two processes can't collide on a *write* (each session owns
// its own marker file), but two sessions resolving/assigning concurrently
// can read the same load snapshot and land on the same "least-loaded"
// shard. Last-writer-wins on that snapshot is accepted (plan decision, not
// built as locking) — worst case is a transient load imbalance, not a
// correctness bug: every invocation re-reads its own marker fresh before
// using it, so the tab a session actually gets always matches what its
// marker says.
// ---------------------------------------------------------------------------

/**
 * Read the shard a session is pinned to from its marker file's optional
 * second line. Returns null when the marker is missing, has no second line,
 * or the second line doesn't parse as `shard=<int>` — all treated as
 * "unassigned" so the caller can (re)assign or default.
 */
export function readShardAssignment(pid: string): number | null {
  let raw: string;
  try {
    raw = fs.readFileSync(sessionFilePath(pid), "utf-8");
  } catch {
    return null;
  }
  const line2 = raw.split("\n")[1];
  if (!line2) return null;
  const m = /^shard=(\d+)\s*$/.exec(line2);
  if (!m) return null;
  const n = Number.parseInt(m[1], 10);
  return Number.isFinite(n) ? n : null;
}

/**
 * Overwrite (or create) a session's marker with the given shard, preserving
 * line 1 (the pid) when the marker already exists.
 */
function writeShardAssignment(pid: string, shard: number): void {
  const fp = sessionFilePath(pid);
  let line1 = pid;
  try {
    const existing = fs.readFileSync(fp, "utf-8").split("\n")[0];
    if (existing) line1 = existing;
  } catch {
    // Marker doesn't exist yet — create it fresh below.
  }
  fs.writeFileSync(fp, `${line1}\nshard=${shard}\n`);
}

/**
 * Simple, stable string hash (djb2). Deterministic across runs — used only
 * for the tiebreak below, never for anything security-sensitive.
 */
export function hashString(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = (h * 33) ^ s.charCodeAt(i);
  }
  return h >>> 0; // unsigned
}

/**
 * Pick the shard with the fewest sessions from a per-shard load count.
 *
 * Among shards tied at the minimum, breaks the tie deterministically via
 * `hash(identity) % tiedCount` into the sorted list of tied shard indices
 * (chrome-pool-plan Fix 3) — this spreads N sessions that start
 * simultaneously (all seeing the same all-zero count snapshot) across
 * shards instead of every one of them collapsing onto shard 0, which would
 * reproduce the exact single-Chrome contention incident the pool exists to
 * fix. Without an `identity` (or with only one shard tied), ties break to
 * the lowest index — back-compat for callers that don't have a session
 * identity to hash.
 */
export function pickLeastLoadedShard(counts: number[], identity?: string): number {
  const min = Math.min(...counts);
  const tied: number[] = [];
  for (let i = 0; i < counts.length; i++) {
    if (counts[i] === min) tied.push(i);
  }
  if (tied.length === 1 || identity === undefined) return tied[0];
  return tied[hashString(identity) % tied.length];
}

/**
 * Assign `pid` to the least-loaded headless shard and persist the choice.
 * `entries` defaults to a live `/tmp` scan (production path); tests can
 * inject a fabricated peer list to get deterministic counts on a machine
 * that's also running real, concurrent ab sessions.
 */
export function assignShard(
  pid: string,
  poolSize: number = HEADLESS_POOL_SIZE,
  entries: SessionEntry[] = listSessionEntries(),
): number {
  const counts = new Array<number>(poolSize).fill(0);
  for (const entry of entries) {
    if (entry.pid === pid) continue; // don't count our own not-yet-written marker
    if (entry.state === "stale") continue; // on its way out via `ab gc`
    if (entry.shard === null) continue;
    counts[entry.shard % poolSize] += 1;
  }
  const shard = pickLeastLoadedShard(counts, pid);
  writeShardAssignment(pid, shard);
  return shard;
}

/**
 * Clamp a marker's recorded shard to the current pool size (decision 6: a
 * pool shrink can leave markers pointing past the new size) and persist the
 * corrected value so future reads see it directly. No-op (no rewrite) when
 * the shard is already in range.
 */
function clampAndPersistShard(pid: string, shard: number, poolSize: number): number {
  if (shard < poolSize) return shard;
  const clamped = shard % poolSize;
  writeShardAssignment(pid, clamped);
  return clamped;
}

/**
 * Resolve (or assign) the shard a session should boot/use Chrome on: read
 * the marker; if unassigned, assign a fresh least-loaded shard; if the
 * recorded shard is out of range for the current pool, clamp it. Used by
 * the passthrough-command path, where booting a fresh shard for an
 * unassigned session is the correct behavior.
 */
export function resolveOrAssignShard(pid: string, poolSize: number = HEADLESS_POOL_SIZE): number {
  const raw = readShardAssignment(pid);
  if (raw === null) return assignShard(pid, poolSize);
  return clampAndPersistShard(pid, raw, poolSize);
}

/**
 * Resolve the shard whose Chrome a session's tab actually lives on, for
 * teardown purposes (`ab close`, `ab gc`). Never assigns and never boots
 * Chrome — a missing/legacy (pid-only) or garbled marker is treated as
 * shard 0, matching where an unassigned session's tab landed before
 * sharding existed (shard 0 reuses the pre-pool profile/port).
 */
export function resolveTeardownShard(pid: string, poolSize: number = HEADLESS_POOL_SIZE): number {
  const raw = readShardAssignment(pid);
  if (raw === null) return 0;
  return clampAndPersistShard(pid, raw, poolSize);
}

/**
 * Look up the CDP port for `shard` from an already-fetched headlessPool
 * snapshot (`status().headlessPool`), or null if that shard's Chrome isn't
 * up.
 *
 * Tolerates a daemon that hasn't been restarted with pool support yet (no
 * `headlessPool` field on /status at all) via `legacyHeadless` — the
 * daemon's `status().headless` field, which exists in both the pre-pool and
 * pool-aware response shapes. A pre-pool daemon runs exactly one headless
 * Chrome, and every session's tab lives there regardless of what the
 * marker's shard= line claims, so when `headlessPool` is missing this falls
 * back to `legacyHeadless` for EVERY shard rather than reporting every
 * shard down (chrome-pool-plan Fix 1).
 */
export function portForShard(
  headlessPool: ChromeState[] | undefined,
  shard: number,
  legacyHeadless?: ChromeState,
): number | null {
  if (headlessPool) {
    const state = headlessPool[shard];
    return state && state.phase === "chrome_up" ? state.port : null;
  }
  return legacyHeadless && legacyHeadless.phase === "chrome_up" ? legacyHeadless.port : null;
}

/**
 * Print a one-line stderr hint when a shard's Chrome just started from a
 * brand-new profile (empty cookie jar — see ChromeEnsureResponse.profileFresh,
 * chrome-pool-plan Unit 3 decision 5). No-op when the profile already
 * existed. Shared by both the headless and headed branches of
 * ensureChromePort so the hint fires regardless of which Chrome a command
 * ends up needing.
 */
function maybePrintFreshProfileHint(profileFresh: boolean): void {
  if (profileFresh) {
    gray("fresh profile for this shard — run 'ab reauth' if you need auth");
  }
}

/**
 * Derive the headless shard that actually served a request from the port
 * the daemon reported. The daemon's response port is the source of truth —
 * a pre-pool daemon ignores the `shard` field on the request entirely and
 * always serves its single Chrome on port 9333 regardless of what was
 * requested (chrome-pool-plan Fix 2). Ports map back via `9333 + i`;
 * anything outside the current pool's port range (legacy daemon, single
 * Chrome) resolves to shard 0 — that Chrome IS where every tab lives
 * pre-pool.
 */
export function shardForPort(port: number, poolSize: number = HEADLESS_POOL_SIZE): number {
  const i = port - CDP_PORT_HEADLESS;
  if (i < 0 || i >= poolSize) return 0;
  return i;
}

/**
 * Resolve the CDP port headless commands should use for this session:
 * resolve (or assign) its shard, then ensure that shard's Chrome is up via
 * the daemon. Returns the port the daemon reports rather than assuming the
 * `9333 + shard` formula — the daemon is the source of truth for the port.
 *
 * If the daemon served a different shard than the one requested (a
 * pre-pool daemon that ignores `shard` entirely, or a future mismatch),
 * rewrite the marker to the shard actually served — otherwise the marker
 * would keep lying about where this session's tab lives (chrome-pool-plan
 * Fix 2).
 */
async function resolveSessionCdpPort(pid: string): Promise<number> {
  const requestedShard = resolveOrAssignShard(pid);
  const result = await rpc.ensureChrome({ shard: requestedShard });
  maybePrintFreshProfileHint(result.profileFresh);
  const servedShard = shardForPort(result.port);
  if (servedShard !== requestedShard) {
    writeShardAssignment(pid, servedShard);
  }
  return result.port;
}

// ---------------------------------------------------------------------------
// Ensure Chrome is running via daemon
//
// This is also what makes `ab reauth` shard-correct "for free" (chrome-pool-
// plan Unit 3, decision 5): `reauth` is a member of NEEDS_CHROME (below), so
// main() already routes it through here before dispatching to cmdReauth —
// the cdpPort cmdReauth receives is always this session's sticky-resolved
// shard port, never a hardcoded constant. See auth.test.ts's
// "reauth is shard-aware" tests for the wiring proof.
// ---------------------------------------------------------------------------

export async function ensureChromePort(headed: boolean): Promise<number> {
  if (headed) {
    const result = await rpc.ensureChromeHeaded();
    maybePrintFreshProfileHint(result.profileFresh);
    return result.port;
  }
  return resolveSessionCdpPort(resolvePid());
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

// ---------------------------------------------------------------------------
// ab doctor — consolidated health check with concrete fix commands.
// Walks the chain a user hits when something's off: daemon → Chrome → auth →
// session files → agent-browser binary. Prints ✓ / ✗ with the exact command
// to run next to any failure. Exit code 0 if everything passes, 1 otherwise.
// ---------------------------------------------------------------------------

export interface DoctorCheck {
  label: string;
  ok: boolean;
  detail?: string;
  fix?: string;
}

/**
 * Build the headless-Chrome health checks for `ab doctor`. Iterates
 * `status.headlessPool` (one line per shard, chrome-pool-plan Fix 5) when
 * the daemon reports it, so a crash-looping shard 1/2 no longer hides
 * behind a healthy shard 0; falls back to the single legacy
 * `status.headless` line for a daemon that predates the pool (no
 * `headlessPool` field on /status at all). Shard 0 is always-on (down =
 * failure, same as before); shards >= 1 are on-demand (idle is healthy,
 * mirroring the existing headed-Chrome treatment) — only a crash fails
 * them. Pure and exported for direct unit testing: cmdDoctor itself talks
 * to the live daemon over RPC and writes straight to stdout, so this is
 * the only test seam without a larger refactor.
 */
export function buildHeadlessDoctorChecks(
  status: { headless: ChromeState; headlessPool?: ChromeState[] },
): DoctorCheck[] {
  if (status.headlessPool && status.headlessPool.length > 0) {
    return status.headlessPool.map((state, i) => {
      const alwaysOn = i === 0;
      const ok = alwaysOn ? state.phase === "chrome_up" : state.phase !== "chrome_crashed";
      const detail = !alwaysOn && state.phase === "idle" ? "idle (on-demand)" : state.phase;
      return {
        label: `Chrome (headless-${i}, ${CDP_PORT_HEADLESS + i})`,
        ok,
        detail,
        fix: ok ? undefined : "ab ensure   # or: ab heal",
      };
    });
  }
  const headlessOk = status.headless.phase === "chrome_up";
  return [
    {
      label: "Chrome (headless, 9333)",
      ok: headlessOk,
      detail: status.headless.phase,
      fix: headlessOk ? undefined : "ab ensure   # or: ab heal",
    },
  ];
}

async function cmdDoctor(): Promise<number> {
  const checks: Array<{ label: string; ok: boolean; detail?: string; fix?: string }> = [];

  let daemonUp = false;
  let status: Awaited<ReturnType<typeof rpc.status>> | null = null;
  try {
    status = await rpc.status();
    daemonUp = true;
    checks.push({
      label: "ab-server daemon",
      ok: true,
      detail: `uptime ${Math.floor(status.uptime)}s, v${status.version}`,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    checks.push({
      label: "ab-server daemon",
      ok: false,
      detail: msg,
      fix: "launchctl start com.clay.ab-server",
    });
  }

  if (status) {
    checks.push(...buildHeadlessDoctorChecks(status));

    // Headed is on-demand — not running is normal, only flag if crashed.
    const headedCrashed = status.headed.phase === "chrome_crashed";
    checks.push({
      label: "Chrome (headed, 9444)",
      ok: !headedCrashed,
      detail: status.headed.phase === "idle" ? "idle (on-demand)" : status.headed.phase,
      fix: headedCrashed ? "ab heal" : undefined,
    });
  }

  if (daemonUp) {
    try {
      const auth = await rpc.authStatus();
      checks.push({
        label: "dev-login auth",
        ok: auth.authenticated,
        detail: auth.authenticated
          ? `${auth.user?.email || "unknown"} (last login ${auth.lastLogin ?? "?"})`
          : "not authenticated",
        fix: auth.authenticated ? undefined : "ab reauth",
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      checks.push({ label: "dev-login auth", ok: false, detail: msg, fix: "ab reauth" });
    }
  }

  const pid = resolvePid();
  const sessionFile = sessionFilePath(pid);
  const sessionFileExists = fs.existsSync(sessionFile);
  checks.push({
    label: `session file (${sessionFile})`,
    ok: sessionFileExists,
    detail: sessionFileExists ? "present" : "missing",
    fix: sessionFileExists ? undefined : "ab new-session",
  });

  // Wrapper only matters in subagents (where AB_SESSION_PID is set by the hook).
  if (process.env.AB_SESSION_PID) {
    const wrapper = `/tmp/ab-${pid}`;
    const wrapperExists = fs.existsSync(wrapper);
    checks.push({
      label: `subagent wrapper (${wrapper})`,
      ok: wrapperExists,
      detail: wrapperExists ? "present" : "missing (SubagentStart hook didn't run?)",
      fix: wrapperExists ? undefined : "Restart the subagent so SubagentStart installs the shim.",
    });
  }

  const whichResult = await new Promise<number>((resolve) => {
    const child = spawn("which", [AGENT_BROWSER], { stdio: "ignore" });
    child.on("close", (code) => resolve(code ?? 1));
    child.on("error", () => resolve(1));
  });
  checks.push({
    label: `${AGENT_BROWSER} on PATH`,
    ok: whichResult === 0,
    fix: whichResult === 0 ? undefined : "bun install -g agent-browser (or check your PATH)",
  });

  const allOk = checks.every((c) => c.ok);
  const labelW = Math.max(...checks.map((c) => c.label.length));
  for (const c of checks) {
    const mark = c.ok ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m";
    const detail = c.detail ? `  \x1b[90m${c.detail}\x1b[0m` : "";
    process.stdout.write(`${mark} ${c.label.padEnd(labelW)}${detail}\n`);
    if (!c.ok && c.fix) {
      process.stdout.write(`    \x1b[33m→ ${c.fix}\x1b[0m\n`);
    }
  }
  process.stdout.write(
    allOk ? "\n\x1b[32mAll checks passed.\x1b[0m\n" : "\n\x1b[31mSome checks failed.\x1b[0m\n",
  );
  return allOk ? 0 : 1;
}

// Environment presets for `ab reauth`. Terra-specific: dev-login is a Terra
// endpoint and exists only in non-production envs.
const REAUTH_ENV_PRESETS: Record<string, string> = {
  staging: "https://slack-feedback-staging.onrender.com",
  dev: "https://slack-feedback-development.onrender.com",
};

/**
 * Detect whether a browser URL is a Terra worktree origin (*.terra.localhost
 * or terra.localhost itself) and return the portless HTTPS base URL if so.
 * Returns undefined for non-Terra URLs.
 */
function detectWorktreeOrigin(browserUrl: string | undefined): string | undefined {
  if (!browserUrl) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(browserUrl);
  } catch {
    return undefined;
  }
  const hostname = parsed.hostname;
  // Match terra.localhost itself or any *.terra.localhost subdomain
  if (hostname === "terra.localhost" || hostname.endsWith(".terra.localhost")) {
    // Use the browser's actual origin verbatim — portless serves standard
    // HTTPS (:443), so a bare https origin is correct and any non-standard
    // port the browser used is preserved.
    return parsed.origin;
  }
  return undefined;
}

export function resolveReauthBaseUrls(
  args: string[],
  env: { AB_API_BASE_URL?: string; AB_APP_BASE_URL?: string },
  browserUrl?: string,
): { apiBaseUrl: string | undefined; appBaseUrl: string | undefined; error?: string } {
  let preset: string | undefined;
  let host: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith("--")) continue;

    // --host <value> or --host=<value>
    if (arg === "--host" || arg.startsWith("--host=")) {
      let hostValue: string | undefined;
      if (arg === "--host") {
        const next = args[i + 1];
        if (next !== undefined && !next.startsWith("--")) {
          hostValue = next;
          i++;
        }
      } else {
        hostValue = arg.slice("--host=".length);
      }
      if (!hostValue) {
        return { apiBaseUrl: undefined, appBaseUrl: undefined, error: "--host requires a hostname" };
      }
      if (host && host !== hostValue) {
        return { apiBaseUrl: undefined, appBaseUrl: undefined, error: `Conflicting --host values: ${host} and ${hostValue}` };
      }
      host = hostValue;
      continue;
    }

    const name = arg.slice(2);
    if (name in REAUTH_ENV_PRESETS) {
      if (preset && preset !== name) {
        return { apiBaseUrl: undefined, appBaseUrl: undefined, error: `Conflicting env flags: --${preset} and --${name}` };
      }
      preset = name;
    } else if (name === "prod" || name === "production") {
      return {
        apiBaseUrl: undefined,
        appBaseUrl: undefined,
        error: "--prod is not supported: dev-login is disabled in production. Use `ab import` for headed Google login.",
      };
    } else if (name === "local") {
      // Explicit no-op: use defaults (localhost) from auth.ts.
      preset = "local";
    }
  }
  if (host && preset && preset !== "local") {
    return {
      apiBaseUrl: undefined,
      appBaseUrl: undefined,
      error: `Cannot combine --host with --${preset}`,
    };
  }
  // --host wins over presets. For bare hostnames, pick the right scheme:
  //   - `*.localhost` subdomains → portless serves standard HTTPS (:443);
  //     :80 issues a 302 and following the redirect drops the POST body, so
  //     address https directly. The portless TLS cert is self-signed;
  //     auth.ts already accepts that for `.localhost` hosts.
  //   - bare `localhost` → plain HTTP on the default port (no portless).
  const hostUrl = host
    ? host.startsWith("http://") || host.startsWith("https://")
      ? host
      : host.endsWith(".localhost")
        ? `https://${host}`
        : `http://${host}`
    : undefined;
  const presetUrl = preset && preset !== "local" ? REAUTH_ENV_PRESETS[preset] : undefined;
  // Auto-detect from browser URL when no explicit flag/preset was given.
  // Explicit flags (--host, --staging, --dev, --local) always win over auto-detect.
  const autoDetected = (hostUrl === undefined && presetUrl === undefined)
    ? detectWorktreeOrigin(browserUrl)
    : undefined;
  const resolved = hostUrl ?? presetUrl ?? autoDetected;
  // Env vars win over flags, flags win over auto-detect, auto-detect wins over undefined (→ auth.ts localhost defaults).
  return {
    apiBaseUrl: env.AB_API_BASE_URL ?? resolved,
    appBaseUrl: env.AB_APP_BASE_URL ?? resolved,
  };
}

/**
 * Query the browser's current URL via agent-browser, capturing stdout.
 * Returns undefined if the query fails or times out.
 */
async function getBrowserCurrentUrl(cdpPort: number, sessionName: string | null): Promise<string | undefined> {
  const args = abArgs(cdpPort, sessionName, ["get", "url"]);
  const proc = Bun.spawn(["agent-browser", ...args], { stdout: "pipe", stderr: "pipe" });
  const timeout = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error("timeout")), 5_000),
  );
  try {
    await Promise.race([proc.exited, timeout]);
  } catch {
    proc.kill();
    return undefined;
  }
  if (proc.exitCode !== 0) return undefined;
  const url = await new Response(proc.stdout).text().then(s => s.trim());
  return url || undefined;
}

export async function cmdReauth(
  rest: string[],
  cdpPort: number,
  sessionName: string | null,
): Promise<number> {
  // Auto-detect: query the browser's current URL to pick up worktree origins
  // when no explicit --host/--staging/--dev flag is set.
  const browserUrl = await getBrowserCurrentUrl(cdpPort, sessionName);

  const urls = resolveReauthBaseUrls(rest, {
    AB_API_BASE_URL: process.env.AB_API_BASE_URL,
    AB_APP_BASE_URL: process.env.AB_APP_BASE_URL,
  }, browserUrl);
  if (urls.error) {
    stderr(urls.error);
    return 2;
  }
  const result = await rpc.authLogin({
    sessionId: sessionName ?? "default",
    port: cdpPort,
    email: DEFAULT_AUTH_EMAIL,
    slackUserId: DEFAULT_SLACK_USER_ID,
    apiBaseUrl: urls.apiBaseUrl,
    appBaseUrl: urls.appBaseUrl,
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

// Default viewport applied by `ab open` when AB_VIEWPORT_* are unset.
// Pinned to 1440x900@2x because that matches Clerk's auth UI breakpoints
// and most apps' desktop layouts. Override per-session via env vars.
const DEFAULT_VIEWPORT_W = process.env.AB_VIEWPORT_W ?? "1440";
const DEFAULT_VIEWPORT_H = process.env.AB_VIEWPORT_H ?? "900";
const DEFAULT_VIEWPORT_SCALE = process.env.AB_VIEWPORT_SCALE ?? "2";

async function cmdOpen(
  url: string,
  cdpPort: number,
  sessionName: string | null,
): Promise<number> {
  // Create a dedicated tab for this session so parallel sessions don't collide.
  // tab new sets the new tab as active, so subsequent commands target it.
  await runAgentBrowser(cdpPort, sessionName, ["tab", "new", url]);
  // Apply viewport unless explicitly skipped. Override defaults via
  // AB_VIEWPORT_W / AB_VIEWPORT_H / AB_VIEWPORT_SCALE; set AB_VIEWPORT=skip
  // to leave Chrome's native window size in place.
  if (process.env.AB_VIEWPORT !== "skip") {
    await runAgentBrowser(cdpPort, sessionName, [
      "set",
      "viewport",
      DEFAULT_VIEWPORT_W,
      DEFAULT_VIEWPORT_H,
      DEFAULT_VIEWPORT_SCALE,
    ]);
  }
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
  const fp = sessionFilePath(pid);
  if (!fs.existsSync(fp)) {
    fs.writeFileSync(fp, pid + "\n");
  }
  process.stdout.write(pid + "\n");
  return 0;
}

// ---------------------------------------------------------------------------
// ab ps + ab gc — session inventory and cleanup.
//
// Three-state liveness, derived from real daemon state (not just marker
// file existence):
//   - active — the per-session agent-browser daemon is alive
//     (~/.agent-browser/ab-<pid>.pid names a live OS pid)
//   - idle   — daemon is dead, marker age <= STALE_AGE_MS
//   - stale  — daemon is dead, marker age > STALE_AGE_MS
// CDP /json/list cross-check is explicitly deferred — pid-file check is
// sufficient for v1 and keeps this dependency-free.
// ---------------------------------------------------------------------------

const SESSION_FILE_PREFIX = "/tmp/.ab-session-";
const WRAPPER_PREFIX = "/tmp/ab-";
const STALE_AGE_MS = 24 * 60 * 60 * 1000;
/** Grace window before an idle (daemon-dead, not-yet-stale) session is reaped by `ab gc`. */
const IDLE_GRACE_MS = Number(process.env.AB_GC_IDLE_GRACE_MS ?? 30 * 60 * 1000);

function daemonPidFilePath(sessionPid: string): string {
  return path.join(os.homedir(), ".agent-browser", `ab-${sessionPid}.pid`);
}

/** Returns the per-session daemon's OS pid if alive, else null. */
function daemonPidAlive(sessionPid: string): number | null {
  let raw: string;
  try {
    raw = fs.readFileSync(daemonPidFilePath(sessionPid), "utf-8").trim();
  } catch {
    return null; // no pid file — daemon never started or already cleaned up
  }
  const pid = Number.parseInt(raw, 10);
  if (!Number.isFinite(pid) || pid <= 0) return null;
  try {
    process.kill(pid, 0); // signal 0: existence check only, doesn't kill
    return pid; // no throw — process exists and we can signal it
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === "EPERM") return pid; // exists, owned by another user — still alive
    return null; // ESRCH (or anything else) — dead
  }
}

export interface SessionEntry {
  pid: string;
  session: string;
  owner: "self" | "self (main-thread)" | "subagent" | "other-cc" | "other-cc (subagent)";
  mtimeIso: string;
  ageSeconds: number;
  state: "active" | "idle" | "stale";
  daemonPid: number | null;
  /** Headless shard this session is pinned to, or null if unassigned
   *  (legacy marker, headed-only session, or never touched Chrome). */
  shard: number | null;
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
    const daemonPid = daemonPidAlive(pid);
    const state: SessionEntry["state"] =
      daemonPid !== null ? "active" : ageMs > STALE_AGE_MS ? "stale" : "idle";
    entries.push({
      pid,
      session: `ab-${pid}`,
      owner: classifyOwner(pid, selfPid, cco),
      mtimeIso: new Date(stat.mtimeMs).toISOString(),
      ageSeconds: Math.max(0, Math.floor(ageMs / 1000)),
      state,
      daemonPid,
      shard: readShardAssignment(pid),
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
  selfPid: string,
  cco: string | undefined,
): SessionEntry["owner"] {
  if (pid === selfPid) return "self";
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
  const shardW = 5;
  const header = `  ${"PID".padEnd(pidW)}  ${"OWNER".padEnd(ownerW)}  ${"AGE".padEnd(6)}  ${"SHARD".padEnd(shardW)}  STATUS`;
  process.stdout.write(header + "\n");
  let needsGc = false;
  for (const e of entries) {
    const marker = e.owner === "self" ? "*" : " ";
    if (e.state === "idle" || e.state === "stale") needsGc = true;
    const shardStr = e.shard === null ? "" : String(e.shard);
    process.stdout.write(
      `${marker} ${e.pid.padEnd(pidW)}  ${e.owner.padEnd(ownerW)}  ${formatAge(e.ageSeconds).padEnd(6)}  ${shardStr.padEnd(shardW)}  ${e.state}\n`,
    );
  }
  if (needsGc) {
    stderr("Run `ab gc` to prune stale sessions.");
  }
  return 0;
}

/**
 * Tear down a session's Chrome tab via the same passthrough `close` uses.
 * Callers must already know the target shard's Chrome is up (via
 * `portForShard`/status) — this function unconditionally attempts the
 * close, it never boots Chrome itself. For an idle entry this transiently
 * spawns a per-session agent-browser daemon to close the orphan tab; it
 * exits immediately after (idle timeout).
 */
async function teardownSession(sessionPid: string, cdpPort: number): Promise<void> {
  // Bare `close` only shuts down the per-session daemon — in attached-CDP
  // mode it never closes the Chrome tab (verified 2026-07-10 via
  // `/json/list`: the tab survives). `tab close` is what closes the
  // daemon's tab, so run it first, then `close` to end the daemon. If the
  // daemon had already idle-exited, the respawned daemon may not re-adopt
  // the orphan tab, so the tab-close is best-effort for dead-daemon reaps.
  const sessionName = buildSessionName(sessionPid);
  await runAgentBrowser(cdpPort, sessionName, ["tab", "close"]);
  await runAgentBrowser(cdpPort, sessionName, ["close"]);
}

/** Guard regex for orphan-wrapper sweep: hex-ish session pid shapes only.
 *  Deliberately excludes name-adjacent sidecar files like
 *  `ab-server-out.log` / `ab-server-error.log` (see plan history: a prior
 *  glob-based cleanup deleted `ab-server.sock` this way). */
const ORPHAN_WRAPPER_NAME_RE = /^ab-[0-9a-f][0-9a-f-]*$/i;

/**
 * Second gc pass: wrapper shims in /tmp with no matching session marker
 * (already reaped, or never had one) that are old enough (> STALE_AGE_MS)
 * to be confidently orphaned. Guarded hard against non-session sidecar
 * files sharing the `/tmp/ab-*` prefix.
 */
function findOrphanWrappers(entries: SessionEntry[], now: Date = new Date()): string[] {
  const dir = "/tmp";
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const knownPids = new Set(entries.map((e) => e.pid));
  const orphans: string[] = [];
  for (const name of names) {
    if (!ORPHAN_WRAPPER_NAME_RE.test(name)) continue;
    const pid = name.slice("ab-".length);
    if (knownPids.has(pid)) continue; // has a marker — not orphaned
    const fp = `${dir}/${name}`;
    let stat: fs.Stats;
    try {
      stat = fs.statSync(fp);
    } catch {
      continue;
    }
    if (!stat.isFile()) continue;
    const isExecutable = (stat.mode & 0o111) !== 0;
    if (!isExecutable) continue; // real wrapper shims are chmod +x
    if (now.getTime() - stat.mtimeMs <= STALE_AGE_MS) continue;
    orphans.push(fp);
  }
  return orphans;
}

async function cmdGc(args: string[]): Promise<number> {
  const dryRun = args.includes("--dry-run");
  const entries = listSessionEntries();
  const targets = entries.filter((e) => e.state === "idle" || e.state === "stale");
  const orphanWrappers = findOrphanWrappers(entries);

  if (targets.length === 0 && orphanWrappers.length === 0) {
    stderr("Nothing to prune.");
    return 0;
  }

  // Resolve the headless pool's liveness once for the whole run — same
  // guarantee as `close`: never boots Chrome, no-op for a shard that isn't
  // up. Each entry below resolves its own marker's shard and only gets a
  // close attempt if THAT shard is up (decision 2/6: per-shard, not global).
  let headlessPool: ChromeState[] | undefined;
  let legacyHeadless: ChromeState | undefined;
  try {
    const st = await rpc.status();
    headlessPool = st.headlessPool;
    legacyHeadless = st.headless;
  } catch {
    headlessPool = undefined; // daemon down → nothing to close on any shard
    legacyHeadless = undefined;
  }

  for (const e of targets) {
    const sessionFile = `${SESSION_FILE_PREFIX}${e.pid}`;
    const wrapper = `${WRAPPER_PREFIX}${e.pid}`;
    const withinGrace = e.state === "idle" && e.ageSeconds * 1000 <= IDLE_GRACE_MS;

    if (withinGrace) {
      const line = `${e.pid}  state=${e.state}  age=${formatAge(e.ageSeconds)}  action=skip: within grace window`;
      if (dryRun) process.stdout.write(line + "\n");
      continue;
    }

    if (dryRun) {
      const action =
        e.state === "stale"
          ? "close + remove marker + wrapper"
          : "close + remove marker (keep wrapper)";
      process.stdout.write(
        `${e.pid}  state=${e.state}  age=${formatAge(e.ageSeconds)}  action=${action}\n`,
      );
      process.stdout.write(`would remove: ${sessionFile}\n`);
      if (e.state === "stale") {
        process.stdout.write(`would remove: ${wrapper}\n`);
      }
      continue;
    }

    const shard = resolveTeardownShard(e.pid);
    const port = portForShard(headlessPool, shard, legacyHeadless);
    if (port !== null) {
      await teardownSession(e.pid, port);
    }
    try { fs.unlinkSync(sessionFile); } catch { /* race: already gone */ }
    if (e.state === "stale") {
      try { fs.unlinkSync(wrapper); } catch { /* wrapper may not exist */ }
    }
    stderr(`reaped: ${e.pid} (${e.state})`);
  }

  for (const wrapperPath of orphanWrappers) {
    if (dryRun) {
      process.stdout.write(`orphan wrapper  action=remove: ${wrapperPath}\n`);
      continue;
    }
    try { fs.unlinkSync(wrapperPath); } catch { /* already gone */ }
    stderr(`reaped orphan wrapper: ${wrapperPath}`);
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

async function cmdClickXy(args: string[], cdpPort: number): Promise<number> {
  const script = path.join(AB_DIR, "cdp-click-xy.ts");
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
  "close", // tear down this session's tab — see the explicit handler; never boots Chrome
]);

const BLOCKED_COMMANDS = new Set(["eval", "js", "execute"]);

/** Commands that must never bump a session marker's mtime — see the touch
 *  in main() below. `ps`/`gc` are inspection, not activity (and `gc` runs as
 *  pid "default" under launchd — it must never keep a marker perpetually
 *  fresh); `new-session` creates the marker itself. */
const NO_TOUCH_COMMANDS = new Set(["ps", "gc", "new-session"]);

/** Commands that require a managed Chrome instance (ensureChromePort). */
const NEEDS_CHROME = new Set([
  // `close` is intentionally excluded: it should tear down, never boot Chrome.
  ...[...PASSTHROUGH_COMMANDS].filter((c) => c !== "close"),
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

  // Touch the marker's mtime on every real invocation so "age" tracks last
  // activity, not creation time — this is what both the gc grace window and
  // the 24h stale threshold actually want.
  if (command && !NO_TOUCH_COMMANDS.has(command)) {
    try {
      const now = new Date();
      fs.utimesSync(sessionFilePath(pid), now, now);
    } catch { /* marker not initialized — fine */ }
  }

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
    if (command === "doctor") return await cmdDoctor();
    if (command === "ensure") return await cmdEnsure(flags.headed);
    if (command === "heal") return await cmdHeal();
    if (command === "reauth") return await cmdReauth(rest, cdpPort, sessionName);

    // -- Standalone --
    if (command === "new-session") return cmdNewSession();
    if (command === "ps") return cmdPs(rest);
    if (command === "gc") return await cmdGc(rest);
    if (command === "console-tail") return await cmdConsoleTail(rest, cdpPort);
    if (command === "watch") return await cmdWatch(rest, cdpPort);
    if (command === "click-js") return await cmdClickJs(rest, cdpPort);
    if (command === "click-xy") return await cmdClickXy(rest, cdpPort);

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

    // -- Close: tear down this session's tab. Never boots Chrome — if no
    //    browser is running there is nothing to close (no-op success). This is
    //    the targeted alternative to `ab heal`, which nukes every session's tabs. --
    if (command === "close") {
      let closePort: number | null = null;
      try {
        const st = await rpc.status();
        if (flags.headed) {
          closePort = st.headed.phase === "chrome_up" ? st.headed.port : null;
        } else {
          // Resolve this session's shard the same way teardown/gc does:
          // marker's recorded shard (missing/legacy → 0), never assigned or
          // booted here — `close` must stay a pure teardown.
          const shard = resolveTeardownShard(pid);
          closePort = portForShard(st.headlessPool, shard, st.headless);
        }
      } catch {
        closePort = null; // daemon down → nothing to close
      }
      if (closePort !== null) {
        await teardownSession(pid, closePort);
      } else {
        gray("No browser running — nothing to close.");
      }
      // Reap this session's own /tmp markers so `ab ps` reflects the teardown
      // immediately instead of waiting for the 24h gc.
      try { fs.unlinkSync(`${SESSION_FILE_PREFIX}${pid}`); } catch { /* already gone */ }
      try { fs.unlinkSync(`${WRAPPER_PREFIX}${pid}`); } catch { /* may not exist */ }
      return 0;
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
  stderr("  reauth [--staging|--dev|--host <hostname>]  Re-authenticate via daemon (default: auto-detects *.terra.localhost from browser URL, falls back to localhost)");
  stderr("  import              Headed login (manual Google/Clerk auth)");
  stderr("  heal                Kill all Chrome, restart fresh");
  stderr("  status              Show daemon status (JSON)");
  stderr("  doctor              Human-readable health check with fix commands");
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
  stderr("  click-xy <x> <y>    Compositor-level pixel click (cross-origin iframes, shadow DOM)");
  stderr("");
  stderr("Flags:");
  stderr("  --headed            Use headed Chrome (port 9444)");
  stderr("  --user-chrome       Use personal Chrome (port 9222), allows eval");
  stderr("");
  stderr("Environment:");
  stderr("  AB_SLACK_USER_ID    Override default Slack user for dev-login auth");
  stderr("  AB_SESSION_PID      Session pid (set by subagent hook; falls back to CCO_SESSION_ID)");
  stderr("  CCO_SESSION_ID      Claude Code session ID (auto-set by sandbox)");
  stderr("  AB_VIEWPORT_W       Viewport width applied by 'ab open' (default 1440)");
  stderr("  AB_VIEWPORT_H       Viewport height applied by 'ab open' (default 900)");
  stderr("  AB_VIEWPORT_SCALE   Viewport DPR applied by 'ab open' (default 2)");
  stderr("  AB_VIEWPORT=skip    Skip auto-viewport on 'ab open' (use Chrome native size)");
}

// ---------------------------------------------------------------------------
// Entry — only run when executed directly, not when imported as a module (e.g. tests).
// ---------------------------------------------------------------------------

if (import.meta.main) {
  main().then((code) => {
    process.exit(code);
  }).catch((err) => {
    process.stderr.write(String(err) + "\n");
    process.exit(1);
  });
}
