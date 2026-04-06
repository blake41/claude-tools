// ── Git Branch Creation for Approved Amendments ───────────────────

import { execSync } from "child_process";
import { readFileSync, writeFileSync } from "fs";
import { dirname } from "path";
import type { SkillAmendment } from "./types.js";

// ── Core Functions ─────────────────────────────────────────────────

/**
 * Apply amendment diffs to skill content.
 * For each section, find current_text and replace with proposed_text.
 */
export function applyAmendment(
  content: string,
  sections: SkillAmendment["sections_changed"],
): string {
  let result = content;

  for (const section of sections) {
    if (!result.includes(section.current_text)) {
      throw new Error(
        `Could not find text to replace in section "${section.location}". ` +
          `Expected:\n${section.current_text.slice(0, 200)}...`,
      );
    }
    result = result.replace(section.current_text, section.proposed_text);
  }

  return result;
}

/**
 * Create a git branch with the amended skill file, then return to the previous branch.
 * Returns the branch name on success.
 */
export async function createAmendmentBranch(
  skillPath: string,
  amendment: SkillAmendment,
): Promise<string> {
  const dir = dirname(skillPath);
  const execOpts = { encoding: "utf-8" as const, stdio: "pipe" as const };

  // Determine repo root
  let repoRoot: string;
  try {
    repoRoot = execSync(`git -C "${dir}" rev-parse --show-toplevel`, execOpts).trim();
  } catch (err) {
    throw new Error(
      `Could not determine git repo root for "${dir}": ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const gitCmd = (cmd: string) => execSync(`git -C "${repoRoot}" ${cmd}`, execOpts).trim();

  // Extract skill name from path for branch naming
  const skillName = skillPath
    .replace(/.*\/skills\//, "")
    .replace(/.*\/commands\//, "")
    .replace(/\/SKILL\.md$/, "")
    .replace(/\.md$/, "")
    .replace(/[^a-zA-Z0-9-]/g, "-");

  const datestamp = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const branchName = `meta/amend-${skillName}-${datestamp}`;

  // Remember current branch to return to
  let previousBranch: string;
  try {
    previousBranch = gitCmd("rev-parse --abbrev-ref HEAD");
  } catch {
    previousBranch = "master";
  }

  try {
    // Create and switch to new branch
    gitCmd(`checkout -b "${branchName}"`);

    // Read current content
    const currentContent = readFileSync(skillPath, "utf-8");

    // Apply amendments
    const updatedContent = applyAmendment(currentContent, amendment.sections_changed);

    // Write updated file
    writeFileSync(skillPath, updatedContent, "utf-8");

    // Stage and commit
    gitCmd(`add "${skillPath}"`);

    const sessionList = amendment.evidence_session_ids.slice(0, 10).join(", ");
    const commitMessage = [
      `meta: amend ${skillName}`,
      "",
      `Evidence sessions: ${sessionList}`,
      amendment.expected_improvement,
    ].join("\n");

    // Use a temp approach to avoid shell escaping issues with the commit message
    execSync(
      `git -C "${repoRoot}" commit -m "${commitMessage.replace(/"/g, '\\"')}"`,
      execOpts,
    );

    return branchName;
  } catch (err) {
    // Attempt to restore previous branch on failure
    try {
      gitCmd(`checkout "${previousBranch}"`);
    } catch {
      // Best effort
    }
    throw new Error(
      `Failed to create amendment branch: ${err instanceof Error ? err.message : String(err)}`,
    );
  } finally {
    // Always return to previous branch
    try {
      gitCmd(`checkout "${previousBranch}"`);
    } catch {
      // Best effort — may already be on previous branch if checkout failed above
    }
  }
}
