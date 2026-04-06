// ── Skill Amendment Pipeline (Layer 2) ────────────────────────────
// Identifies underperforming skills and proposes targeted amendments.

import Anthropic from "@anthropic-ai/sdk";
import { readFileSync, existsSync } from "fs";
import { join } from "path";
import db from "../db.js";
import { config } from "../config.js";
import { SKILL_INSPECTION_PROMPT, SKILL_AMENDMENT_PROMPT } from "./prompts.js";
import type { SkillAmendment, FailureCategory } from "./types.js";

const anthropic = new Anthropic();
const HOME = process.env.HOME || "/Users/blake";

// ── Prepared Statements ────────────────────────────────────────────

const getSkillInvocationsWithScores = db.prepare(`
  SELECT se.metadata, sc.composite_score, sc.tool_efficiency, sc.fix_convergence,
         sc.context_discipline, sc.verification_rigor, sc.architectural_alignment,
         se.session_id
  FROM session_events se
  JOIN session_scores sc ON se.session_id = sc.session_id
  WHERE se.type = 'skill_invocation'
`);

const getUserCorrections = db.prepare(`
  SELECT content FROM messages WHERE session_id = ? AND role = 'user'
    AND (content LIKE '%no %' OR content LIKE '%don''t%' OR content LIKE '%stop %' OR content LIKE '%wrong%')
`);

const getSessionEventsForSession = db.prepare(`
  SELECT type, tool, target_file, success, metadata, sequence
  FROM session_events WHERE session_id = ?
  ORDER BY sequence ASC
`);

const insertProposal = db.prepare(`
  INSERT OR IGNORE INTO proposals (type, status, title, summary, detail, evidence_session_ids, confidence, score_impact, created_at)
  VALUES (?, 'proposed', ?, ?, ?, ?, ?, ?, ?)
`);

// ── Types ──────────────────────────────────────────────────────────

interface AmendmentCandidate {
  skill_name: string;
  avg_score: number;
  invocation_count: number;
  session_ids: string[];
  weak_axes: string[];
}

interface InvocationRow {
  metadata: string | null;
  composite_score: number;
  tool_efficiency: number;
  fix_convergence: number;
  context_discipline: number;
  verification_rigor: number;
  architectural_alignment: number;
  session_id: string;
}

interface InspectionResult {
  categories: FailureCategory[];
  diagnosis: string;
  affected_sections: string[];
  severity: "high" | "medium" | "low";
}

// ── Core Functions ─────────────────────────────────────────────────

export function findAmendmentCandidates(): AmendmentCandidate[] {
  const rows = getSkillInvocationsWithScores.all() as InvocationRow[];

  // Group by skill name
  const bySkill = new Map<string, InvocationRow[]>();
  for (const row of rows) {
    if (!row.metadata) continue;
    let meta: Record<string, unknown>;
    try {
      meta = JSON.parse(row.metadata);
    } catch {
      continue;
    }
    const skillName = meta.skill_name as string | undefined;
    if (!skillName) continue;

    const existing = bySkill.get(skillName) || [];
    existing.push(row);
    bySkill.set(skillName, existing);
  }

  const candidates: AmendmentCandidate[] = [];

  for (const [skillName, invocations] of bySkill) {
    const avgScore =
      invocations.reduce((sum, r) => sum + r.composite_score, 0) / invocations.length;
    const count = invocations.length;
    const sessionIds = [...new Set(invocations.map((r) => r.session_id))];
    const hasAcuteFailure = invocations.some((r) => r.composite_score < 2.0);

    // Determine weak axes (avg < 3.5 across invocations)
    const axes = [
      "tool_efficiency",
      "fix_convergence",
      "context_discipline",
      "verification_rigor",
      "architectural_alignment",
    ] as const;

    const weakAxes: string[] = [];
    for (const axis of axes) {
      const axisAvg = invocations.reduce((sum, r) => sum + r[axis], 0) / count;
      if (axisAvg < 3.5) weakAxes.push(axis);
    }

    const isUnderperforming = avgScore < 3.5;
    const isMediocreButFrequent = avgScore >= 3.5 && avgScore < 4.0 && count >= 5;

    if (isUnderperforming || isMediocreButFrequent || hasAcuteFailure) {
      candidates.push({
        skill_name: skillName,
        avg_score: Math.round(avgScore * 100) / 100,
        invocation_count: count,
        session_ids: sessionIds,
        weak_axes: weakAxes,
      });
    }
  }

  // Sort by severity: lowest avg score first
  candidates.sort((a, b) => a.avg_score - b.avg_score);
  return candidates;
}

export async function inspectSkill(
  skillName: string,
  sessionIds: string[],
  weakAxes: string[],
): Promise<{ skillPath: string; skillContent: string; inspection: InspectionResult } | null> {
  // Try to locate the SKILL.md
  const skillPaths = [
    join(HOME, ".claude", "skills", skillName, "SKILL.md"),
    join(HOME, ".claude", "commands", `${skillName}.md`),
  ];

  let skillPath: string | null = null;
  let skillContent: string | null = null;

  for (const p of skillPaths) {
    if (existsSync(p)) {
      skillPath = p;
      skillContent = readFileSync(p, "utf-8");
      break;
    }
  }

  if (!skillPath || !skillContent) {
    return null;
  }

  // Gather evidence from sessions
  const corrections: string[] = [];
  const eventSummaries: string[] = [];

  for (const sid of sessionIds.slice(0, 5)) {
    const userCorrections = getUserCorrections.all(sid) as Array<{ content: string }>;
    corrections.push(...userCorrections.map((c) => c.content.slice(0, 500)));

    const events = getSessionEventsForSession.all(sid) as Array<{
      type: string;
      tool: string | null;
      success: number;
      sequence: number;
    }>;
    const summary = events
      .map((e) => `${e.sequence}: ${e.type}${e.tool ? `(${e.tool})` : ""} ${e.success ? "✓" : "✗"}`)
      .join("\n");
    eventSummaries.push(`--- Session ${sid.slice(0, 8)} ---\n${summary}`);
  }

  const context = [
    `## SKILL.md Content\n\`\`\`\n${skillContent}\n\`\`\``,
    `## Weak Scoring Axes\n${weakAxes.join(", ")}`,
    `## Session Events (low-scoring sessions)\n${eventSummaries.join("\n\n")}`,
    `## User Corrections\n${corrections.length > 0 ? corrections.join("\n---\n") : "(none detected)"}`,
  ].join("\n\n");

  try {
    const response = await anthropic.messages.create({
      model: config.metaAnalysisModel,
      max_tokens: config.metaMaxTokens,
      system: SKILL_INSPECTION_PROMPT,
      messages: [{ role: "user", content: context }],
    });

    const text = response.content[0].type === "text" ? response.content[0].text : "";
    const parsed = JSON.parse(
      text.replace(/^```(?:json)?\s*/, "").replace(/\s*```$/, "").trim(),
    ) as InspectionResult;

    return { skillPath, skillContent, inspection: parsed };
  } catch (err) {
    console.error(`[meta] Failed to inspect skill ${skillName}:`, err);
    return null;
  }
}

export async function generateAmendment(
  skillName: string,
  skillContent: string,
  diagnosis: InspectionResult,
): Promise<SkillAmendment | null> {
  const context = [
    `## Current SKILL.md\n\`\`\`\n${skillContent}\n\`\`\``,
    `## Diagnosis\n${JSON.stringify(diagnosis, null, 2)}`,
  ].join("\n\n");

  try {
    const response = await anthropic.messages.create({
      model: config.metaAnalysisModel,
      max_tokens: config.metaMaxTokens,
      system: SKILL_AMENDMENT_PROMPT,
      messages: [{ role: "user", content: context }],
    });

    const text = response.content[0].type === "text" ? response.content[0].text : "";
    const parsed = JSON.parse(
      text.replace(/^```(?:json)?\s*/, "").replace(/\s*```$/, "").trim(),
    ) as {
      sections_changed: SkillAmendment["sections_changed"];
      expected_improvement: string;
      confidence: number;
    };

    return {
      skill_path: "",  // will be set by caller
      sections_changed: parsed.sections_changed,
      evidence_session_ids: [],  // will be set by caller
      confidence: parsed.confidence,
      expected_improvement: parsed.expected_improvement,
    };
  } catch (err) {
    console.error(`[meta] Failed to generate amendment for ${skillName}:`, err);
    return null;
  }
}

export async function runSkillAmendmentAnalysis(
  sessionIds?: string[],
): Promise<{ candidates: number; proposals: number; errors: string[] }> {
  const errors: string[] = [];
  let proposalCount = 0;

  const candidates = findAmendmentCandidates();

  // If sessionIds provided, filter candidates to those touching those sessions
  const filtered = sessionIds
    ? candidates.filter((c) => c.session_ids.some((sid) => sessionIds.includes(sid)))
    : candidates;

  for (const candidate of filtered) {
    try {
      const result = await inspectSkill(
        candidate.skill_name,
        candidate.session_ids,
        candidate.weak_axes,
      );

      if (!result) {
        errors.push(`Could not locate skill file for "${candidate.skill_name}"`);
        continue;
      }

      const amendment = await generateAmendment(
        candidate.skill_name,
        result.skillContent,
        result.inspection,
      );

      if (!amendment) {
        errors.push(`Failed to generate amendment for "${candidate.skill_name}"`);
        continue;
      }

      // Fill in caller-side fields
      amendment.skill_path = result.skillPath;
      amendment.evidence_session_ids = candidate.session_ids;

      // Skip low-confidence amendments
      if (amendment.confidence < config.metaDefaultConfidenceThreshold) {
        continue;
      }

      const title = `Amend skill: ${candidate.skill_name}`;
      const summary = `Skill "${candidate.skill_name}" avg score ${candidate.avg_score} across ${candidate.invocation_count} invocations. Weak axes: ${candidate.weak_axes.join(", ")}. ${amendment.expected_improvement}`;

      insertProposal.run(
        "skill_amendment",
        title,
        summary,
        JSON.stringify(amendment),
        JSON.stringify(candidate.session_ids),
        amendment.confidence,
        JSON.stringify({ weak_axes: candidate.weak_axes, avg_score: candidate.avg_score }),
        new Date().toISOString(),
      );

      proposalCount++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`Error processing "${candidate.skill_name}": ${msg}`);
    }
  }

  return { candidates: filtered.length, proposals: proposalCount, errors };
}
