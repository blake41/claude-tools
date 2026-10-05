import { spawn } from "child_process";
import * as fs from "fs";
import * as rpc from "./rpc";
import type { AuthStatusResponse, ChromeState, ShardDiagnostics } from "./types";
import { AGENT_BROWSER, CONFIG_ERROR } from "./config";
import { buildSessionName, readShardAssignment, resolvePid, sessionFilePath } from "./session";
import { fetchTabCounts } from "./cdp-http";
import { headlessPortsFromPool, portForShard } from "./shard-ports";

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
/**
 * Render "16:05Z" from an ISO timestamp — doctor's crash-evidence detail
 * string wants a short, glanceable time, not a full ISO stamp.
 */
function formatHHMMZ(iso: string): string {
  const match = /T(\d{2}:\d{2})/.exec(iso);
  return match ? `${match[1]}Z` : iso;
}

function upPort(state: ChromeState): number | null {
  return state.phase === "chrome_up" ? state.port : null;
}

function withPort(name: string, port: number | null): string {
  return port === null ? name : `${name}, ${port}`;
}

/**
 * Build the human-readable detail string for one headless shard's doctor
 * line. On-demand shards (i>=1) that are idle with crash evidence
 * (`diag.lastExit`) render that evidence inline instead of the bare "idle
 * (on-demand)" — before this, a shard that had just crash-looped and
 * silently relaunched itself on the next command left no trace in `ab
 * doctor` at all (FINAL CONSENSUS SPEC item 14). Pure and exported for
 * direct unit testing, following buildHeadlessDoctorChecks's own
 * established pattern (chrome-pool-plan Fix 5).
 */
export function buildHeadlessDoctorDetail(
  alwaysOn: boolean,
  phase: string,
  diag: ShardDiagnostics | undefined,
): string {
  const conflict = diag?.lastPortConflict;
  if (conflict && phase !== "chrome_up") {
    return `${phase} — port ${conflict.port} held by PID ${conflict.pid}, not spawned by this daemon (${conflict.detail})`;
  }
  if (phase === "chrome_up" && diag?.adoptedPid) {
    return `chrome_up (adopted PID ${diag.adoptedPid}, not spawned by this daemon; ab heal re-adopts it, it does not restart it)`;
  }
  if (!alwaysOn && phase === "idle") {
    if (diag?.lastExit) {
      const { code, signal, at } = diag.lastExit;
      return `idle (on-demand; last exit code=${code} signal=${signal} ${formatHHMMZ(at)} — relaunches on next use)`;
    }
    return "idle (on-demand)";
  }
  return phase;
}

/** Fix hint for a failing Chrome check: a refused port occupant needs a human, not ab heal. */
function chromeFix(phase: string, diag: ShardDiagnostics | undefined, fallback: string): string {
  const conflict = diag?.lastPortConflict;
  if (conflict && phase !== "chrome_up") {
    return `kill ${conflict.pid}   # only if that Chrome is yours; or set AB_BASE_PORT / AB_HEADED_PORT in the daemon's launchd env`;
  }
  return fallback;
}

export function buildHeadedDoctorCheck(status: {
  headed: ChromeState;
  diagnostics?: { headed?: ShardDiagnostics };
}): DoctorCheck {
  // Headed is on-demand — not running is normal, only flag if crashed.
  const crashed = status.headed.phase === "chrome_crashed";
  const diag = status.diagnostics?.headed;
  return {
    label: `Chrome (${withPort("headed", upPort(status.headed))})`,
    ok: !crashed,
    detail: buildHeadlessDoctorDetail(false, status.headed.phase, diag),
    fix: crashed ? chromeFix(status.headed.phase, diag, "ab heal") : undefined,
  };
}

export function buildHeadlessDoctorChecks(
  status: {
    headless: ChromeState;
    headlessPool?: ChromeState[];
    diagnostics?: { headlessPool?: ShardDiagnostics[] };
  },
): DoctorCheck[] {
  if (status.headlessPool && status.headlessPool.length > 0) {
    const ports = headlessPortsFromPool(status.headlessPool);
    return status.headlessPool.map((state, i) => {
      const alwaysOn = i === 0;
      const ok = alwaysOn ? state.phase === "chrome_up" : state.phase !== "chrome_crashed";
      const diag = status.diagnostics?.headlessPool?.[i];
      const detail = buildHeadlessDoctorDetail(alwaysOn, state.phase, diag);
      return {
        label: `Chrome (${withPort(`headless-${i}`, ports[i])})`,
        ok,
        detail,
        fix: ok ? undefined : chromeFix(state.phase, diag, "ab ensure   # or: ab heal"),
      };
    });
  }
  const headlessOk = status.headless.phase === "chrome_up";
  return [
    {
      label: `Chrome (${withPort("headless", upPort(status.headless))})`,
      ok: headlessOk,
      detail: status.headless.phase,
      fix: headlessOk ? undefined : "ab ensure   # or: ab heal",
    },
  ];
}

/**
 * Warn threshold for a single shard's open-page count (tab-teardown-fix U3,
 * decision 6). Healthy steady-state is roughly one tab per active session
 * spread across the 3-shard pool, and the observed healthy total was ~13
 * sessions; 15 on ONE shard is already ~3x that shard's expected share and
 * far below the 35-39 pages seen during the confirmed 2026-08-03 outage — it
 * fires early without false-positives during normal parallel QA. A named
 * constant makes it a one-line tune instead of a buried magic number.
 */
export const TAB_WARN_THRESHOLD = 15;

/**
 * Build the tab-count health checks for `ab doctor` (tab-teardown-fix U3,
 * R5). Pure and exported, following `buildHeadlessDoctorChecks`'s
 * documented test-seam pattern. One check per entry in `tabCounts` (already
 * shard-aligned by `fetchTabCounts`): `ok` is a straight `count <=
 * TAB_WARN_THRESHOLD` binary — no three-state warn level (decision 7,
 * explicitly deferred). A `null` count (shard down/idle/unreachable) always
 * renders as an ok "unreachable/idle" line, mirroring
 * `buildHeadlessDoctorChecks`'s existing idle-is-healthy treatment for
 * on-demand shards — an idle shard has no pages by definition, and "we
 * couldn't ask" is not evidence of a problem either.
 */
export function buildTabCountChecks(
  tabCounts: Array<number | null>,
  ports: Array<number | null> = [],
): DoctorCheck[] {
  return tabCounts.map((count, i) => {
    const label = `Chrome tabs (${withPort(`headless-${i}`, ports[i] ?? null)})`;
    if (count === null) {
      return { label, ok: true, detail: "unreachable/idle" };
    }
    const ok = count <= TAB_WARN_THRESHOLD;
    return {
      label,
      ok,
      detail: `${count} open pages`,
      fix: ok ? undefined : "ab gc   # or: ab heal",
    };
  });
}

/**
 * Build the doctor "terra auth" check from a cookie-backed /auth/status
 * response. `auth` is null when the target Chrome is not up (nothing to
 * probe): reported ok-but-unverifiable rather than failed. Tolerates a daemon
 * that predates the cookie-backed shape (no `port` / `checkedVia`) by
 * building the detail from optional fields.
 */
export function buildAuthCheck(
  auth: (Pick<AuthStatusResponse, "authenticated"> & Partial<AuthStatusResponse>) | null,
  probedPort: number | null,
  targetLabel = "headless-0",
): DoctorCheck {
  const label = "terra auth";
  if (!auth) {
    return { label, ok: true, detail: `not verifiable — ${targetLabel} Chrome is not up` };
  }
  const port = auth.port ?? probedPort;
  if (!auth.authenticated) {
    return {
      label,
      ok: false,
      detail: port !== null ? `no Clerk session cookie on port ${port}` : "not authenticated",
      fix: "ab reauth",
    };
  }
  const who = auth.user?.email || "unknown";
  const detail = auth.checkedVia === "cookie" && port !== null
    ? `${who} — Clerk session cookie present on port ${port}`
    : `${who} — authenticated (last login ${auth.lastLogin ?? "?"}; daemon reports no cookie detail)`;
  return { label, ok: true, detail, fix: undefined };
}

export async function cmdDoctor(headed = false): Promise<number> {
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

  if (CONFIG_ERROR) {
    checks.push({
      label: "CLI AB_* port env",
      ok: false,
      detail: `${CONFIG_ERROR} (ignored: the CLI takes ports from the daemon)`,
      fix: "fix or unset it in your shell; the daemon reads its own env from the launchd plist",
    });
  }

  if (status) {
    checks.push(...buildHeadlessDoctorChecks(status));

    // tab-teardown-fix U3 (R5): per-shard open-page counts, appended right
    // after the headless-liveness checks so a tab-level leak can never
    // again hide behind a healthy session/Chrome-liveness picture.
    const tabCounts = await fetchTabCounts(status.headlessPool, status.headless);
    const tabPorts = status.headlessPool ? headlessPortsFromPool(status.headlessPool) : [upPort(status.headless)];
    checks.push(...buildTabCountChecks(tabCounts, tabPorts));

    checks.push(buildHeadedDoctorCheck(status));
  }

  if (daemonUp) {
    try {
      // Doctor is read-only: read the marker's shard (never assign/clamp one),
      // default shard 0, and probe the port the daemon actually reports up.
      const shard = headed ? 0 : (readShardAssignment(resolvePid()) ?? 0);
      const targetLabel = headed ? "headed" : `headless-${shard}`;
      const port = headed
        ? (status?.headed.phase === "chrome_up" ? status.headed.port : null)
        : portForShard(status?.headlessPool, shard, status?.headless);
      if (port === null) {
        checks.push(buildAuthCheck(null, null, targetLabel));
      } else {
        const auth = await rpc.authStatus({
          port,
          sessionId: buildSessionName(),
          appBaseUrl: process.env.AB_APP_BASE_URL,
        });
        checks.push(buildAuthCheck(auth, port, targetLabel));
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      checks.push({ label: "terra auth", ok: false, detail: msg, fix: "ab reauth" });
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
