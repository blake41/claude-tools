/**
 * Who holds a CDP port: the listening PID, its command line, and whether
 * this daemon may signal it.
 */

/** Stdout of `argv`, or null if it cannot be read within `timeoutMs`. */
async function captureStdout(argv: string[], timeoutMs: number): Promise<string | null> {
  const proc = Bun.spawn(argv, { stdout: "pipe", stderr: "ignore" });
  // Detach the exit promise so Bun reaps the child even if we don't await it
  proc.exited.catch(() => {});
  const timer = setTimeout(() => proc.kill(), timeoutMs);
  try {
    return await new Response(proc.stdout).text();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** `cmdline` passes exactly `--user-data-dir=<profilePath>` (not a longer path that starts with it). */
export function commandLineUsesProfile(cmdline: string, profilePath: string): boolean {
  const flag = `--user-data-dir=${profilePath}`;
  let i = cmdline.indexOf(flag);
  while (i !== -1) {
    const before = i === 0 ? " " : cmdline[i - 1];
    const after = cmdline[i + flag.length] ?? " ";
    if (/\s/.test(before) && /\s/.test(after)) return true;
    i = cmdline.indexOf(flag, i + 1);
  }
  return false;
}

/**
 * Command line of `pid` via `pgrep -lf` ("<pid> <args>" lines; the sandbox
 * has no ps), or null if it cannot be read.
 */
export async function readCommandLine(pid: number): Promise<string | null> {
  const raw = await captureStdout(["/usr/bin/pgrep", "-lf", "--", "--user-data-dir="], 5_000);
  if (raw === null) return null;
  const prefix = `${pid} `;
  const line = raw.split("\n").find((l) => l.startsWith(prefix));
  return line ? line.slice(prefix.length) : null;
}

/**
 * Return the PID of the process listening on `port`, or null if nothing is bound.
 */
export async function getListeningPid(port: number): Promise<number | null> {
  const raw = await captureStdout(["/usr/sbin/lsof", "-i", `:${port}`, "-sTCP:LISTEN", "-t"], 5_000);
  if (raw === null) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const pid = parseInt(trimmed, 10);
  return Number.isNaN(pid) ? null : pid;
}

/**
 * Whose Chrome holds a target's port:
 * - `ours`: the PID this daemon last spawned for the target.
 * - `own-profile`: its --user-data-dir is this target's own profile (it can
 *   be no one else's, and it blocks every launch on that profile).
 * - `foreign`: anything else, including an unreadable command line. Never
 *   signalled; `detail` says why.
 */
export type OccupantClass =
  | { kind: "ours" }
  | { kind: "own-profile" }
  | { kind: "foreign"; detail: string };

/**
 * Classify a port holder this daemon did not spawn. `cmdline` is null only
 * when it could not be read.
 */
export function classifyOccupant(input: {
  cmdline: string | null;
  profilePath: string;
}): Exclude<OccupantClass, { kind: "ours" }> {
  const { cmdline, profilePath } = input;
  if (cmdline === null) return { kind: "foreign", detail: "command line unreadable" };
  if (commandLineUsesProfile(cmdline, profilePath)) return { kind: "own-profile" };
  const userDataDir = /--user-data-dir=(\S+)/.exec(cmdline)?.[1] ?? "none";
  return { kind: "foreign", detail: `--user-data-dir ${userDataDir} is not this target's profile ${profilePath}` };
}
