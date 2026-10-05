/**
 * Who holds a CDP port: the listening PID and its command line.
 */

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
  const proc = Bun.spawn(["/usr/bin/pgrep", "-lf", "--", "--user-data-dir="], {
    stdout: "pipe",
    stderr: "ignore",
  });
  proc.exited.catch(() => {});
  const timer = setTimeout(() => proc.kill(), 5_000);
  try {
    const raw = await new Response(proc.stdout).text();
    const prefix = `${pid} `;
    const line = raw.split("\n").find((l) => l.startsWith(prefix));
    return line ? line.slice(prefix.length) : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Return the PID of the process listening on `port`, or null if nothing is bound.
 */
export async function getListeningPid(port: number): Promise<number | null> {
  const proc = Bun.spawn(["/usr/sbin/lsof", "-i", `:${port}`, "-sTCP:LISTEN", "-t"], {
    stdout: "pipe",
    stderr: "ignore",
  });
  // Detach the exit promise so Bun reaps the child even if we don't await it
  proc.exited.catch(() => {});
  const timer = setTimeout(() => proc.kill(), 5_000);
  try {
    const raw = await new Response(proc.stdout).text();
    const trimmed = raw.trim();
    if (!trimmed) return null;
    const pid = parseInt(trimmed, 10);
    return Number.isNaN(pid) ? null : pid;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
