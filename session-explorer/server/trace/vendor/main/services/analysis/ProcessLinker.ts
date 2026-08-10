/**
 * ProcessLinker service - Links subagent processes to AI chunks.
 *
 * Uses a two-tier linking strategy:
 * 1. Primary: parentTaskId matching - Links subagents to chunks containing the Task tool call
 *    that spawned them. This is reliable even when the response is still in progress.
 * 2. Fallback: Timing-based - For orphaned subagents without parentTaskId, falls back to
 *    checking if the subagent's startTime falls within the chunk's time range.
 */

import { type EnhancedAIChunk, type Process } from '../../types/index';

/**
 * Link processes to a single AI chunk.
 *
 * Uses a two-tier linking strategy:
 * 1. Primary: parentTaskId matching - Links subagents to chunks containing the Task tool call
 *    that spawned them. This is reliable even when the response is still in progress.
 * 2. Fallback: Timing-based - For orphaned subagents without parentTaskId, falls back to
 *    checking if the subagent's startTime falls within the chunk's time range.
 */
export function linkProcessesToAIChunk(chunk: EnhancedAIChunk, subagents: Process[]): void {
  // Build set of Task tool IDs from this chunk's responses
  const chunkTaskIds = new Set<string>();
  for (const response of chunk.responses) {
    for (const toolCall of response.toolCalls) {
      if (toolCall.isTask) {
        chunkTaskIds.add(toolCall.id);
      }
    }
  }

  // Track which subagents have been linked
  const linkedSubagentIds = new Set<string>();

  // Primary linking: Match subagents to Task calls by parentTaskId
  for (const subagent of subagents) {
    if (subagent.parentTaskId && chunkTaskIds.has(subagent.parentTaskId)) {
      chunk.processes.push(subagent);
      linkedSubagentIds.add(subagent.id);
    }
  }

  // Fallback linking: For orphaned subagents, use timing-based matching
  // This handles edge cases where parentTaskId might not be set
  for (const subagent of subagents) {
    if (linkedSubagentIds.has(subagent.id)) {
      continue; // Already linked via parentTaskId
    }

    // Only use timing fallback if subagent has no parentTaskId
    // (If it has parentTaskId but didn't match, it belongs to a different chunk)
    if (!subagent.parentTaskId) {
      if (subagent.startTime >= chunk.startTime && subagent.startTime <= chunk.endTime) {
        chunk.processes.push(subagent);
      }
    }
  }

  chunk.processes.sort((a, b) => a.startTime.getTime() - b.startTime.getTime());
}
