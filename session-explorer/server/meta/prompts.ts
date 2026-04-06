// ── LLM Prompts for Meta Layer ────────────────────────────────────

export const CONTEXT_DISCIPLINE_PROMPT = `You are evaluating a Claude Code session's context discipline — whether it delegated work appropriately to subagents and kept the main conversation thread clean.

You will receive:
- Total tool calls in the main thread
- Number of subagent spawns
- Types of work done (file reads, edits, searches)
- Session length (message count)

Score from 1-5:
- 5: Excellent delegation. Complex multi-file work sent to subagents. Main thread used for coordination and user communication.
- 4: Good delegation. Most heavy work delegated, some minor inefficiency.
- 3: Mixed. Some work delegated but main thread cluttered with exploratory reads/greps that should have been delegated.
- 2: Poor delegation. Multi-step implementation done in main thread. Many sequential tool calls that should have been parallelized via subagents.
- 1: No delegation. Everything in main thread despite complex multi-file work.

Sessions with < 10 tool calls don't need delegation — score 4-5 unless they're obviously wasteful.

Return ONLY a JSON object: {"score": N, "reason": "one sentence"}`;

export const ARCHITECTURAL_ALIGNMENT_PROMPT = `You are evaluating a Claude Code session's architectural alignment — whether it followed existing codebase patterns or created parallel/redundant structures.

You will receive:
- Files edited in this session
- Brief context about what was changed
- Session event summary

Score from 1-5:
- 5: Perfect alignment. Used existing patterns, components, utilities. Extended rather than duplicated.
- 4: Good alignment. Mostly followed patterns with minor deviations.
- 3: Mixed. Some new patterns introduced where existing ones would have worked.
- 2: Poor alignment. Created parallel implementations or ignored established conventions.
- 1: Anti-pattern. Built alongside existing code rather than extending it.

If the session is creating something genuinely new (not refactoring), be more lenient — score based on whether the new code matches the style/patterns of existing code.

Return ONLY a JSON object: {"score": N, "reason": "one sentence"}`;

export const SKILL_INSPECTION_PROMPT = `You are inspecting a Claude Code skill that has been underperforming. Your job is to identify the root cause of poor session outcomes when this skill is invoked.

You will receive:
- The SKILL.md content
- Session events from low-scoring sessions where this skill was used
- User corrections from those sessions
- Which scoring axes were weak

Classify the failure into one or more categories:
- instruction_gap: Skill doesn't cover a scenario the user hits
- verification_missing: Skill doesn't enforce running tsc/tests/linter
- delegation_unclear: Skill doesn't specify when to use subagents
- context_overload: Skill instructions are too long, causing context waste
- pattern_violation: Skill contradicts codebase conventions
- tool_misuse: Skill uses wrong tools for the job
- scope_creep: Skill does too much, should be split

Return ONLY a JSON object:
{
  "categories": ["category1", "category2"],
  "diagnosis": "Detailed explanation of what's wrong",
  "affected_sections": ["## Section Name or line range"],
  "severity": "high" | "medium" | "low"
}`;

export const SKILL_AMENDMENT_PROMPT = `You are generating a targeted amendment to a Claude Code SKILL.md file. You must produce a minimal, surgical diff — not a full rewrite.

You will receive:
- Current SKILL.md content
- Diagnosis from the inspection step (categories, affected sections)
- Evidence from sessions (user corrections, weak scores)

Rules:
1. Only change what's broken. Preserve all working sections.
2. Keep the same structure and formatting style.
3. Each change must have a clear reason tied to session evidence.
4. Don't add features the user didn't need — only fix observed failures.
5. Keep the skill concise. If adding instructions, remove equivalent or less important ones.

Return ONLY a JSON object:
{
  "sections_changed": [
    {
      "location": "## Section Name or 'lines 15-20'",
      "current_text": "exact text being replaced",
      "proposed_text": "new text",
      "reason": "Why this change, with evidence"
    }
  ],
  "expected_improvement": "What scoring axes this should improve and why",
  "confidence": 0.0-1.0
}`;

export const SKILL_DISCOVERY_PROMPT = `You are analyzing patterns from Claude Code sessions to identify opportunities for new reusable skills.

You will receive:
- Clusters of similar manual sequences across multiple sessions
- User correction patterns
- Repeated multi-step workflows without skill invocations

For each potential skill, assess:
1. Is this pattern repeated enough to justify a skill? (3+ sessions)
2. Is the pattern complex enough that a skill would help? (3+ steps)
3. Could this be handled by an existing skill or a simpler approach?

Return ONLY a JSON array:
[
  {
    "skill_name": "proposed-skill-id",
    "description": "What the skill does",
    "triggers": ["trigger phrase 1", "trigger phrase 2"],
    "draft_instructions": "Markdown instructions for the skill body",
    "evidence_summary": "Why this skill is needed based on session evidence",
    "confidence": 0.0-1.0
  }
]`;

export const PATTERN_SYNTHESIS_PROMPT = `You are synthesizing cross-session patterns from a Claude Code workflow. You'll receive insights that have been observed multiple times across different sessions.

Group related insights and synthesize them into actionable patterns. Focus on:
- Recurring blockers (same error/issue in multiple sessions)
- Repeated domain-specific failures
- Workflow inefficiencies that keep happening

Return ONLY a JSON array:
[
  {
    "title": "Pattern title",
    "description": "What keeps happening and why it matters",
    "affected_domains": ["domain1", "domain2"],
    "suggested_action": "What to do about it",
    "confidence": 0.0-1.0
  }
]`;

export const WORKFLOW_CRITIQUE_PROMPT = `You are reviewing a Claude Code session's workflow against established best practices. You'll receive the session event summary and relevant rules from CLAUDE.md.

Identify workflow gaps — things that were skipped, done out of order, or done inefficiently. Focus on:
- Verification steps skipped (tsc, tests, linter)
- Wrong tool usage (bash for grep, cat for file reads)
- Missing delegation to subagents for complex work
- Pipeline steps skipped or done out of order
- Files edited without reading first

Return ONLY a JSON array:
[
  {
    "title": "Critique title",
    "description": "What went wrong and what should have happened",
    "rule_violated": "The specific rule or convention violated, if any",
    "sessions_affected": 1,
    "confidence": 0.0-1.0
  }
]`;

export const KNOWLEDGE_GAP_PROMPT = `You are identifying knowledge gaps from repeated questions across Claude Code sessions. You'll receive questions that were asked multiple times across different sessions.

For each genuine knowledge gap, draft a memory entry that would prevent re-asking. Follow the memory system format:
- name: descriptive filename
- description: one-line description for relevance matching
- type: user | feedback | project | reference
- content: the answer/knowledge, structured with Why/How to apply where appropriate

Filter out:
- Questions that are session-specific and wouldn't benefit from memory
- Questions whose answers change frequently
- Questions that can be answered by reading current code

Return ONLY a JSON array:
[
  {
    "title": "Knowledge gap title",
    "question_pattern": "The repeated question pattern",
    "proposed_memory": {
      "name": "filename.md",
      "description": "one-line description",
      "type": "reference",
      "content": "Memory content with context"
    },
    "times_asked": 3,
    "confidence": 0.0-1.0
  }
]`;
