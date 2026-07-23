#!/usr/bin/env bun
/**
 * install.ts — Install or uninstall the ab-server daemon and CLI.
 *
 * Usage:
 *   bun run install.ts            # Install
 *   bun run install.ts --uninstall # Uninstall
 */

import { execSync } from "child_process";
import * as fs from "fs";
import * as path from "path";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const HOME = process.env.HOME ?? "";
const AB_DIR = path.dirname(new URL(import.meta.url).pathname);
const PLIST_NAME = "com.clay.ab-server.plist";
const PLIST_SRC = path.join(AB_DIR, PLIST_NAME);
const PLIST_DST = path.join(HOME, "Library", "LaunchAgents", PLIST_NAME);
const LABEL = "com.clay.ab-server";
const AB_BIN = path.join(HOME, ".local", "bin", "ab");
const AB_BACKUP = AB_BIN + ".bash.bak";
const CLI_SRC = path.join(AB_DIR, "src", "cli.ts");

// agent-browser (the native Rust CDP engine `ab` shells out to) is a separate
// repo — this fork carries a click-actionability patch upstream doesn't have.
// Pinned to a tag rather than a branch so installs are reproducible.
const AGENT_BROWSER_REPO = "git@github.com:blake41/agent-browser.git";
const AGENT_BROWSER_TAG = "v0.32.4-clay.1";
const AGENT_BROWSER_SRC_DIR = path.join(HOME, ".agent-browser", "src");
const AGENT_BROWSER_BIN = path.join(HOME, ".local", "bin", "agent-browser");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function run(cmd: string, ignoreError = false): string {
  try {
    return execSync(cmd, { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }).trim();
  } catch (err: unknown) {
    if (ignoreError) return "";
    throw err;
  }
}

function log(msg: string): void {
  process.stderr.write(`  ${msg}\n`);
}

function isBashScript(filePath: string): boolean {
  try {
    const fd = fs.openSync(filePath, "r");
    const buf = Buffer.alloc(32);
    fs.readSync(fd, buf, 0, 32, 0);
    fs.closeSync(fd);
    return buf.toString("utf-8").startsWith("#!/usr/bin/env bash");
  } catch {
    return false;
  }
}

function isBunScript(filePath: string): boolean {
  try {
    const fd = fs.openSync(filePath, "r");
    const buf = Buffer.alloc(32);
    fs.readSync(fd, buf, 0, 32, 0);
    fs.closeSync(fd);
    return buf.toString("utf-8").startsWith("#!/usr/bin/env bun");
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Uninstall
// ---------------------------------------------------------------------------

function uninstall(): void {
  process.stderr.write("\nUninstalling ab-server...\n\n");

  // Stop and unload launchd service
  log("Stopping daemon...");
  run(`launchctl stop ${LABEL}`, true);
  run(`launchctl unload "${PLIST_DST}"`, true);

  // Remove plist
  if (fs.existsSync(PLIST_DST)) {
    fs.unlinkSync(PLIST_DST);
    log(`Removed ${PLIST_DST}`);
  } else {
    log("Plist already absent");
  }

  // Restore bash backup if it exists
  if (fs.existsSync(AB_BACKUP)) {
    fs.copyFileSync(AB_BACKUP, AB_BIN);
    fs.chmodSync(AB_BIN, 0o755);
    fs.unlinkSync(AB_BACKUP);
    log(`Restored ${AB_BIN} from backup`);
  }

  process.stderr.write("\nUninstall complete.\n");
}

// ---------------------------------------------------------------------------
// agent-browser (native binary)
// ---------------------------------------------------------------------------

/** Build agent-browser from source and symlink it into ~/.local/bin, unless
 * it's already resolvable on PATH. Requires the Rust toolchain (cargo) — this
 * is left to the user to install since it's an interactive installer that
 * modifies shell profiles.
 */
function ensureAgentBrowser(): void {
  log("Checking agent-browser binary...");
  const existing = run("command -v agent-browser", true);
  if (existing) {
    log(`agent-browser already on PATH (${existing}) — skipping build`);
    return;
  }

  const cargoVersion = run("cargo --version", true);
  if (!cargoVersion) {
    process.stderr.write(`
  agent-browser (the browser-automation engine \`ab\` depends on) isn't installed,
  and building it from source requires the Rust toolchain (cargo), which isn't
  on your PATH.

  Install Rust first:
    curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
    source "$HOME/.cargo/env"

  Then re-run this installer:
    bun run install.ts

  (This script won't run the rustup installer for you — it's interactive and
  modifies your shell profile.)
`);
    process.exit(1);
  }

  log(`Building agent-browser (${AGENT_BROWSER_TAG})...`);
  if (!fs.existsSync(AGENT_BROWSER_SRC_DIR)) {
    fs.mkdirSync(path.dirname(AGENT_BROWSER_SRC_DIR), { recursive: true });
    run(
      `git clone --branch ${AGENT_BROWSER_TAG} --depth 1 ${AGENT_BROWSER_REPO} "${AGENT_BROWSER_SRC_DIR}"`,
    );
  } else {
    run(
      `cd "${AGENT_BROWSER_SRC_DIR}" && git fetch --depth 1 origin tag ${AGENT_BROWSER_TAG} && git checkout ${AGENT_BROWSER_TAG}`,
    );
  }

  run(`cargo build --release --manifest-path "${AGENT_BROWSER_SRC_DIR}/cli/Cargo.toml"`);

  const builtBin = path.join(AGENT_BROWSER_SRC_DIR, "cli", "target", "release", "agent-browser");
  if (!fs.existsSync(builtBin)) {
    process.stderr.write(`\n  ERROR: build finished but binary not found at ${builtBin}\n`);
    process.exit(1);
  }

  fs.mkdirSync(path.dirname(AGENT_BROWSER_BIN), { recursive: true });
  if (fs.existsSync(AGENT_BROWSER_BIN) || fs.lstatSync(AGENT_BROWSER_BIN, { throwIfNoEntry: false })) {
    fs.unlinkSync(AGENT_BROWSER_BIN);
  }
  fs.symlinkSync(builtBin, AGENT_BROWSER_BIN);
  log(`Installed agent-browser -> ${AGENT_BROWSER_BIN}`);
}

// ---------------------------------------------------------------------------
// Install
// ---------------------------------------------------------------------------

function install(): void {
  process.stderr.write("\nInstalling ab-server...\n\n");

  // 0. Ensure the native agent-browser binary exists (builds from source if needed)
  ensureAgentBrowser();

  // 1. Verify daemon builds
  log("Verifying daemon builds...");
  try {
    run(`cd "${AB_DIR}" && bun build src/daemon.ts --no-bundle`);
    log("Daemon build OK");
  } catch {
    process.stderr.write("\n  ERROR: daemon.ts failed to build. Fix errors before installing.\n");
    process.exit(1);
  }

  // 2. Write plist (template {{HOME}} placeholders with actual home directory)
  log("Installing launchd plist...");
  fs.mkdirSync(path.dirname(PLIST_DST), { recursive: true });
  const plistTemplate = fs.readFileSync(PLIST_SRC, "utf-8");
  const plistContent = plistTemplate.replaceAll("{{HOME}}", HOME).replaceAll("{{AB_DIR}}", AB_DIR);
  fs.writeFileSync(PLIST_DST, plistContent);
  log(`Wrote ${PLIST_DST}`);

  // 3. Load and start daemon
  log("Loading daemon into launchd...");
  run(`launchctl unload "${PLIST_DST}"`, true);
  run(`launchctl load "${PLIST_DST}"`);
  run(`launchctl start ${LABEL}`);
  log("Daemon loaded and started");

  // 4. Backup old ab if it's a bash script (not already our CLI)
  if (fs.existsSync(AB_BIN) && isBashScript(AB_BIN) && !isBunScript(AB_BIN)) {
    fs.copyFileSync(AB_BIN, AB_BACKUP);
    log(`Backed up old ab to ${AB_BACKUP}`);
  }

  // 5. Install CLI — make executable and symlink to ~/.local/bin/ab
  log("Installing CLI...");
  fs.chmodSync(CLI_SRC, 0o755);
  // Write a thin bun shim so the path resolves correctly
  const shimContent = `#!/usr/bin/env bun\nawait import("${CLI_SRC}");\n`;
  fs.writeFileSync(AB_BIN, shimContent, { mode: 0o755 });
  log(`Installed ${AB_BIN} (shim -> ${CLI_SRC})`);

  // 6. Clean stale PID files
  log("Cleaning stale PID files...");
  let cleaned = 0;
  try {
    const tmpFiles = fs.readdirSync("/tmp");
    for (const f of tmpFiles) {
      if (f.startsWith("ab-chrome-") && f.endsWith(".pid")) {
        fs.unlinkSync(path.join("/tmp", f));
        cleaned++;
      }
    }
  } catch {
    // /tmp read failure is non-fatal
  }
  log(`Cleaned ${cleaned} stale PID file(s)`);

  // 7. Remove old ab-startup.sh from launchd if present
  log("Checking for old ab-related plists...");
  const launchAgentsDir = path.join(HOME, "Library", "LaunchAgents");
  try {
    const plists = fs.readdirSync(launchAgentsDir);
    for (const plist of plists) {
      if (plist === PLIST_NAME) continue; // Skip our own
      // Match any ab-related plist (ab-startup, ab-server variants, etc.)
      if (/\bab[\-_]/.test(plist) || plist.includes("ab-startup")) {
        const oldPath = path.join(launchAgentsDir, plist);
        const oldLabel = plist.replace(/\.plist$/, "");
        run(`launchctl stop "${oldLabel}"`, true);
        run(`launchctl unload "${oldPath}"`, true);
        fs.unlinkSync(oldPath);
        log(`Removed old plist: ${plist}`);
      }
    }
  } catch {
    // Non-fatal if we can't scan LaunchAgents
  }

  process.stderr.write("\nInstall complete. Daemon is running.\n");
  process.stderr.write("  Logs: /tmp/ab-server-out.log, /tmp/ab-server-error.log\n");
  process.stderr.write("  Status: ab status\n");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);

if (args.includes("--uninstall")) {
  uninstall();
} else {
  install();
}
