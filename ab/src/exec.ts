/**
 * Shared stderr + agent-browser spawn helpers, used by cli.ts and session-gc.ts.
 */

import { spawn } from "child_process";
import { AGENT_BROWSER } from "./config";

export function stderr(text: string): void {
  process.stderr.write(text + "\n");
}

// ---------------------------------------------------------------------------
// Exec helpers
// ---------------------------------------------------------------------------

export interface ExecResult {
  exitCode: number;
}

/**
 * Spawn a child process, inheriting stdio. Returns when the process exits.
 */
export function execInherit(cmd: string, args: string[], env?: Record<string, string>): Promise<ExecResult> {
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
export function abArgs(cdpPort: number, sessionName: string | null, args: string[]): string[] {
  const result = ["--cdp", String(cdpPort)];
  if (sessionName) {
    result.push("--session", sessionName);
  }
  return [...result, ...args];
}

/**
 * Run agent-browser with inherited stdio.
 */
export async function runAgentBrowser(
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
