import { readdirSync, statSync, existsSync } from "fs";
import { join, basename } from "path";
import { homedir } from "os";
import db from "./db.js";
import { stripSession } from "./strip.js";

// ── Config ─────────────────────────────────────────────────────────

const CLAUDE_PROJECTS_DIR = join(homedir(), ".claude", "projects");

const DEFAULT_WORKSPACES = new Set([
  "/Users/blake/Documents/Development/clay/terra/.claude/worktrees/v4-prototype",
  "/Users/blake/Documents/Development/clay/terra",
  "/Users/blake/Documents/Development/clay/slack-project",
  "/Users/blake/Documents/Development/clay/slack-project-v4-prototype",
]);

const ingestAll = process.argv.includes("--all");
const forceReingest = process.argv.includes("--force");

// ── Helpers ────────────────────────────────────────────────────────

/**
 * Decode a Claude projects directory name to a workspace path.
 * The encoding replaces `/` with `-`, so `-Users-blake-...` => `/Users/blake/...`
 *
 * Since folder names can contain dashes, we greedily match from left to right,
 * picking the longest existing directory segment at each level.
 */
function decodeDirName(dirName: string): string | null {
  // The dir name starts with `-` representing the leading `/`
  if (!dirName.startsWith("-")) return null;

  const rest = dirName.slice(1); // remove leading `-`
  const segments = rest.split("-");

  let currentPath = "/";
  let i = 0;

  while (i < segments.length) {
    // Try greedy: longest match first
    let matched = false;
    for (let end = segments.length; end > i; end--) {
      const candidate = segments.slice(i, end).join("-");
      const testPath = join(currentPath, candidate);
      try {
        if (existsSync(testPath) && statSync(testPath).isDirectory()) {
          currentPath = testPath;
          i = end;
          matched = true;
          break;
        }
      } catch {
        // permission denied or similar
      }
    }
    if (!matched) {
      // Can't resolve further — join remaining as single segment
      const remaining = segments.slice(i).join("-");
      currentPath = join(currentPath, remaining);
      break;
    }
  }

  return currentPath;
}

function displayName(workspacePath: string): string {
  const parts = workspacePath.split("/").filter(Boolean);
  // Return last 2-3 meaningful segments
  if (parts.length <= 2) return parts.join("/");

  // If path contains .claude/worktrees, include the worktree name + parent project
  const worktreeIdx = parts.indexOf(".claude");
  if (worktreeIdx >= 1 && parts[worktreeIdx + 1] === "worktrees") {
    const projectName = parts[worktreeIdx - 1];
    const worktreeName = parts[worktreeIdx + 2];
    return worktreeName ? `${projectName}/${worktreeName}` : projectName;
  }

  // Otherwise last 2 segments
  return parts.slice(-2).join("/");
}

// ── Prepared Statements ────────────────────────────────────────────

const getWorkspace = db.prepare(`SELECT id FROM workspaces WHERE path = ?`);

const insertWorkspace = db.prepare(`
  INSERT INTO workspaces (path, dir_name, display_name) VALUES (?, ?, ?)
`);

const updateWorkspaceStats = db.prepare(`
  UPDATE workspaces SET
    session_count = (SELECT COUNT(*) FROM sessions WHERE workspace_id = ?),
    last_activity = (SELECT MAX(ended_at) FROM sessions WHERE workspace_id = ?)
  WHERE id = ?
`);

const sessionExists = db.prepare(`SELECT 1 FROM sessions WHERE id = ?`);

const insertSession = db.prepare(`
  INSERT INTO sessions (id, workspace_id, source_path, started_at, ended_at, git_branch, title, message_count, user_message_count, ingested_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

const insertMessage = db.prepare(`
  INSERT INTO messages (session_id, role, content, timestamp, sequence)
  VALUES (?, ?, ?, ?, ?)
`);

const insertFile = db.prepare(`
  INSERT INTO session_files (session_id, file_path, file_name, operation, timestamp, sequence)
  VALUES (?, ?, ?, ?, ?, ?)
`);

const updateSessionCounts = db.prepare(`
  UPDATE sessions SET
    message_count = (SELECT COUNT(*) FROM messages WHERE session_id = ?),
    user_message_count = (SELECT COUNT(*) FROM messages WHERE session_id = ? AND role = 'user')
  WHERE id = ?
`);

const deleteSessionFiles = db.prepare(`DELETE FROM session_files WHERE session_id = ?`);
const deleteSessionMessages = db.prepare(`DELETE FROM messages WHERE session_id = ?`);
const deleteSessionTags = db.prepare(`DELETE FROM session_tags WHERE session_id = ?`);
const deleteSession = db.prepare(`DELETE FROM sessions WHERE id = ?`);

// ── Main ───────────────────────────────────────────────────────────

function getOrCreateWorkspace(
  workspacePath: string,
  dirName: string
): number {
  const existing = getWorkspace.get(workspacePath) as
    | { id: number }
    | undefined;
  if (existing) return existing.id;

  const result = insertWorkspace.run(
    workspacePath,
    dirName,
    displayName(workspacePath)
  );
  return Number(result.lastInsertRowid);
}

function ingestSession(
  jsonlPath: string,
  workspaceId: number
): boolean {
  const sessionId = basename(jsonlPath, ".jsonl");

  const alreadyExists = !!sessionExists.get(sessionId);

  // In force mode, delete existing data first
  if (alreadyExists && forceReingest) {
    const deleteTx = db.transaction(() => {
      deleteSessionFiles.run(sessionId);
      deleteSessionMessages.run(sessionId);
      deleteSessionTags.run(sessionId);
      deleteSession.run(sessionId);
    });
    deleteTx();
  } else if (alreadyExists) {
    return false;
  }

  let result;
  try {
    result = stripSession(jsonlPath);
  } catch (err) {
    console.error(`  [SKIP] Failed to strip ${sessionId}: ${err}`);
    return false;
  }

  const { header, messages, files } = result;
  if (messages.length === 0) return false;

  const userMessages = messages.filter((m) => m.role === "user");
  const title = userMessages[0]?.content.slice(0, 200) || "";
  const startedAt = messages[0]?.timestamp || null;
  const endedAt = messages[messages.length - 1]?.timestamp || null;

  const ingestTx = db.transaction(() => {
    insertSession.run(
      sessionId,
      workspaceId,
      jsonlPath,
      startedAt,
      endedAt,
      header.branch || null,
      title,
      messages.length,
      userMessages.length,
      new Date().toISOString()
    );

    for (const msg of messages) {
      insertMessage.run(
        sessionId,
        msg.role,
        msg.content,
        msg.timestamp,
        msg.sequence
      );
    }

    for (const file of files) {
      if (file.filePath.endsWith('.png') || file.filePath.endsWith('.jpg')) continue;
      insertFile.run(
        sessionId,
        file.filePath,
        file.fileName,
        file.operation,
        file.timestamp,
        file.sequence
      );
    }

    // Ingest subagent sessions — merge their messages/files into the parent
    const subagentDir = join(
      jsonlPath.replace(/\.jsonl$/, ""),
      "subagents"
    );
    if (existsSync(subagentDir)) {
      let subagentFiles: string[];
      try {
        subagentFiles = readdirSync(subagentDir).filter((f) =>
          f.endsWith(".jsonl")
        );
      } catch {
        subagentFiles = [];
      }

      let seqOffset = messages.length + files.length;
      for (const sf of subagentFiles) {
        try {
          const subResult = stripSession(join(subagentDir, sf));
          for (const msg of subResult.messages) {
            insertMessage.run(
              sessionId,
              msg.role,
              msg.content,
              msg.timestamp,
              seqOffset + msg.sequence
            );
          }
          for (const file of subResult.files) {
            if (file.filePath.endsWith('.png') || file.filePath.endsWith('.jpg')) continue;
            insertFile.run(
              sessionId,
              file.filePath,
              file.fileName,
              file.operation,
              file.timestamp,
              seqOffset + file.sequence
            );
          }
          seqOffset += subResult.messages.length + subResult.files.length;
        } catch {
          // skip broken subagent files
        }
      }
    }
  });

  ingestTx();

  // Update counts to include subagent messages
  const subagentDir = join(jsonlPath.replace(/\.jsonl$/, ""), "subagents");
  if (existsSync(subagentDir)) {
    updateSessionCounts.run(sessionId, sessionId, sessionId);
  }

  return true;
}

function main() {
  if (!existsSync(CLAUDE_PROJECTS_DIR)) {
    console.error(`Claude projects directory not found: ${CLAUDE_PROJECTS_DIR}`);
    process.exit(1);
  }

  const projectDirs = readdirSync(CLAUDE_PROJECTS_DIR).filter((d) => {
    const fullPath = join(CLAUDE_PROJECTS_DIR, d);
    try {
      return statSync(fullPath).isDirectory();
    } catch {
      return false;
    }
  });

  console.log(`Found ${projectDirs.length} project directories`);
  if (forceReingest) {
    console.log(`Force mode: re-ingesting all sessions (clearing existing data)`);
  }
  if (!ingestAll) {
    console.log(`Filtering to default workspaces (use --all to ingest everything)`);
  }

  let totalIngested = 0;
  let totalSkipped = 0;

  for (const dirName of projectDirs) {
    const projectDir = join(CLAUDE_PROJECTS_DIR, dirName);

    // Find .jsonl files (not directories — those are subagent sessions)
    let jsonlFiles: string[];
    try {
      jsonlFiles = readdirSync(projectDir).filter(
        (f) => f.endsWith(".jsonl")
      );
    } catch {
      continue;
    }

    if (jsonlFiles.length === 0) continue;

    // Resolve workspace path from first session's cwd, falling back to dir name decode
    let workspacePath: string | null = null;

    // Try to get cwd from first session file
    for (const f of jsonlFiles.slice(0, 3)) {
      try {
        const { header } = stripSession(join(projectDir, f));
        if (header.cwd) {
          workspacePath = header.cwd;
          break;
        }
      } catch {
        // try next file
      }
    }

    if (!workspacePath) {
      workspacePath = decodeDirName(dirName);
    }

    if (!workspacePath) {
      console.log(`  [SKIP] Could not resolve path for: ${dirName}`);
      continue;
    }

    // Filter to default workspaces unless --all
    if (!ingestAll && !DEFAULT_WORKSPACES.has(workspacePath)) {
      continue;
    }

    const workspaceId = getOrCreateWorkspace(workspacePath, dirName);
    let dirIngested = 0;

    for (const f of jsonlFiles) {
      const fullPath = join(projectDir, f);
      const ingested = ingestSession(fullPath, workspaceId);
      if (ingested) {
        dirIngested++;
        totalIngested++;
      } else {
        totalSkipped++;
      }
    }

    if (dirIngested > 0) {
      updateWorkspaceStats.run(workspaceId, workspaceId, workspaceId);
      console.log(
        `  ${displayName(workspacePath)}: ingested ${dirIngested} sessions (${jsonlFiles.length - dirIngested} skipped)`
      );
    }
  }

  console.log(
    `\nDone. Ingested ${totalIngested} new sessions, skipped ${totalSkipped}.`
  );
}

main();
