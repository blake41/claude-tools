import db from "../db.js";
import type { SessionEvent } from "./types.js";

// ── Prepared Statements ────────────────────────────────────────────

const getSessionMessages = db.prepare(`
  SELECT role, content, timestamp, sequence, message_type, source
  FROM messages
  WHERE session_id = ?
  ORDER BY sequence ASC
`);

const insertEvent = db.prepare(`
  INSERT OR IGNORE INTO session_events
    (session_id, sequence, type, tool, target_file, success, token_cost, timestamp, metadata)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

const getEventCount = db.prepare(`
  SELECT COUNT(*) as count FROM session_events WHERE session_id = ?
`);

const deleteSessionEvents = db.prepare(`
  DELETE FROM session_events WHERE session_id = ?
`);

const markEventsExtracted = db.prepare(`
  UPDATE sessions SET events_extracted = 1 WHERE id = ?
`);

const getUnextractedEventSessions = db.prepare(`
  SELECT id FROM sessions
  WHERE events_extracted = 0 AND message_count > 2
`);

// ── User Correction Detection ──────────────────────────────────────

const CORRECTION_PATTERNS = [
  /\bno[,.]?\s+(?:don'?t|not|stop|wrong|that'?s not)/i,
  /\bdon'?t\s+(?:do|use|add|create|make|change)/i,
  /\bstop\s+(?:doing|adding|using)/i,
  /\bwrong\b/i,
  /\bundo\b/i,
  /\brevert\b/i,
  /\bactually[,.]?\s+(?:let'?s|use|do|I)/i,
  /\bI'?d\s+prefer/i,
  /\binstead[,.]?\s+(?:use|do|try)/i,
  /\bthat'?s\s+not\s+what/i,
];

function isUserCorrection(content: string): boolean {
  return CORRECTION_PATTERNS.some(p => p.test(content));
}

// ── Tool Parsing ────────────────────────────────────────────────────

interface ParsedToolUse {
  tool: string;
  target_file: string | null;
}

function parseToolUseContent(content: string): ParsedToolUse | null {
  // tool_use messages have content like "Bash: git status" or "Read: /path/to/file"
  const colonIdx = content.indexOf(': ');
  if (colonIdx < 0) return null;

  const tool = content.slice(0, colonIdx).trim();
  const rest = content.slice(colonIdx + 2).trim();

  // Extract file path for file-based tools
  let target_file: string | null = null;
  if (['Read', 'Write', 'Edit', 'read', 'write', 'edit'].includes(tool)) {
    target_file = rest.split(/\s/)[0] || null;
  } else if (['Grep', 'Glob', 'grep', 'glob'].includes(tool)) {
    // no target file, it's a pattern
  } else if (tool === 'Bash' || tool === 'bash') {
    // Check if it's a file-related bash command
    const fileMatch = rest.match(/(?:cat|head|tail|sed|awk)\s+["']?([^\s"']+)/);
    if (fileMatch) target_file = fileMatch[1];
  }

  return { tool, target_file };
}

// ── Skill Invocation Detection ──────────────────────────────────────

function isSkillInvocation(content: string): string | null {
  // Check for Skill tool use
  const parsed = parseToolUseContent(content);
  if (parsed?.tool === 'Skill') {
    // content is like "Skill: commit" or "Skill: review-pr 123"
    const rest = content.slice(content.indexOf(': ') + 2).trim();
    return rest.split(/\s/)[0] || null;
  }
  // Check for slash command patterns in user text
  const slashMatch = content.match(/^\/(\w[\w-]*)/);
  if (slashMatch) return slashMatch[1];
  return null;
}

// ── Error Detection ─────────────────────────────────────────────────

const ERROR_PATTERNS = [
  /error[\s:]/i,
  /\bfailed\b/i,
  /\bERROR\b/,
  /\bFAILED\b/,
  /permission denied/i,
  /command not found/i,
  /no such file/i,
  /ENOENT/,
  /EACCES/,
  /TypeError:/,
  /SyntaxError:/,
  /ReferenceError:/,
  /Cannot find module/,
  /Module not found/,
  /exit code [1-9]/i,
];

function isErrorResult(content: string): boolean {
  // Only check tool_result messages that look like errors
  const trimmed = content.slice(0, 500);
  return ERROR_PATTERNS.some(p => p.test(trimmed));
}

// ── Main Extraction ─────────────────────────────────────────────────

interface RawMessage {
  role: string;
  content: string;
  timestamp: string | null;
  sequence: number;
  message_type: string;
  source: string;
}

export function extractEvents(sessionId: string, force = false): number {
  // Check if already extracted
  if (!force) {
    const count = (getEventCount.get(sessionId) as { count: number })?.count ?? 0;
    if (count > 0) return count;
  }

  if (force) {
    deleteSessionEvents.run(sessionId);
  }

  const messages = getSessionMessages.all(sessionId) as RawMessage[];
  if (messages.length === 0) return 0;

  const events: Array<SessionEvent & { sequence: number }> = [];
  let eventSeq = 0;

  // Track recent tool calls for retry detection
  const recentFailures = new Map<string, number>(); // "tool:target" -> sequence

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];

    // ── Tool calls from assistant ──
    if (msg.role === 'assistant' && msg.message_type === 'tool_use') {
      const parsed = parseToolUseContent(msg.content);
      if (!parsed) continue;

      // Check for skill invocation
      const skillName = isSkillInvocation(msg.content);
      if (skillName) {
        events.push({
          sequence: eventSeq++,
          type: 'skill_invocation',
          tool: 'Skill',
          target_file: null,
          success: true,
          timestamp: msg.timestamp || '',
          metadata: { skill_name: skillName },
        });
        continue;
      }

      // Check for subagent spawn
      if (parsed.tool === 'Agent' || parsed.tool === 'agent') {
        events.push({
          sequence: eventSeq++,
          type: 'subagent_spawn',
          tool: 'Agent',
          target_file: null,
          success: true,
          timestamp: msg.timestamp || '',
          metadata: { description: msg.content.slice(msg.content.indexOf(': ') + 2, 200) },
        });
        continue;
      }

      // Regular tool call — check next message for error
      const nextMsg = messages[i + 1];
      const hasError = nextMsg
        && nextMsg.role === 'user'
        && nextMsg.message_type === 'tool_result'
        && isErrorResult(nextMsg.content);

      const toolKey = `${parsed.tool}:${parsed.target_file || ''}`;

      // Check if this is a retry of a previous failure
      let retryOf: number | undefined;
      if (recentFailures.has(toolKey)) {
        retryOf = recentFailures.get(toolKey);
        recentFailures.delete(toolKey);
      }

      if (hasError) {
        // Record as error event
        events.push({
          sequence: eventSeq++,
          type: 'error',
          tool: parsed.tool,
          target_file: parsed.target_file,
          success: false,
          timestamp: msg.timestamp || '',
          metadata: { error_preview: nextMsg.content.slice(0, 200) },
        });
        recentFailures.set(toolKey, eventSeq - 1);
      } else {
        events.push({
          sequence: eventSeq++,
          type: retryOf !== undefined ? 'retry' : 'tool_call',
          tool: parsed.tool,
          target_file: parsed.target_file,
          success: true,
          retry_of: retryOf,
          timestamp: msg.timestamp || '',
        });
      }
    }

    // ── User corrections ──
    if (msg.role === 'user' && msg.message_type === 'text' && isUserCorrection(msg.content)) {
      events.push({
        sequence: eventSeq++,
        type: 'user_correction',
        success: true,
        timestamp: msg.timestamp || '',
        metadata: { preview: msg.content.slice(0, 200) },
      });
    }

    // ── Skill invocations from user slash commands ──
    if (msg.role === 'user' && msg.message_type === 'text') {
      const skillName = isSkillInvocation(msg.content);
      if (skillName && msg.content.trim().startsWith('/')) {
        events.push({
          sequence: eventSeq++,
          type: 'skill_invocation',
          tool: 'Skill',
          target_file: null,
          success: true,
          timestamp: msg.timestamp || '',
          metadata: { skill_name: skillName, source: 'user_command' },
        });
      }
    }
  }

  // Batch insert events
  if (events.length > 0) {
    const insertTransaction = db.transaction(() => {
      for (const event of events) {
        insertEvent.run(
          sessionId,
          event.sequence,
          event.type,
          event.tool || null,
          event.target_file || null,
          event.success ? 1 : 0,
          event.token_cost || null,
          event.timestamp,
          event.metadata ? JSON.stringify(event.metadata) : null,
        );
      }
      markEventsExtracted.run(sessionId);
    });
    insertTransaction();
  } else {
    markEventsExtracted.run(sessionId);
  }

  return events.length;
}

export function extractEventsForSessions(sessionIds?: string[]): {
  total: number;
  extracted: number;
} {
  const sessions = sessionIds
    ? sessionIds.map(id => ({ id }))
    : (getUnextractedEventSessions.all() as Array<{ id: string }>);

  let extracted = 0;
  for (const session of sessions) {
    const count = extractEvents(session.id);
    if (count > 0) extracted++;
  }

  return { total: sessions.length, extracted };
}

// ── Query Helpers ────────────────────────────────────────────────────

const getEventsForSession = db.prepare(`
  SELECT * FROM session_events WHERE session_id = ? ORDER BY sequence ASC
`);

const getEventsByType = db.prepare(`
  SELECT * FROM session_events WHERE session_id = ? AND type = ? ORDER BY sequence ASC
`);

const getEventStats = db.prepare(`
  SELECT type, COUNT(*) as count FROM session_events
  WHERE session_id = ? GROUP BY type
`);

export function getSessionEvents(sessionId: string) {
  return getEventsForSession.all(sessionId);
}

export function getSessionEventsByType(sessionId: string, type: string) {
  return getEventsByType.all(sessionId, type);
}

export function getSessionEventStats(sessionId: string) {
  return getEventStats.all(sessionId) as Array<{ type: string; count: number }>;
}
