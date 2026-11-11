#!/usr/bin/env bash
# PostToolUse hook for epic-runner workers. Env: EPIC_RUNNER_ROTATE_AT, EPIC_RUNNER_MARKER_DIR, EPIC_RUNNER_STATUS.
set -euo pipefail

input=$(cat)
transcript=$(jq -r '.transcript_path // empty' <<<"$input")
session=$(jq -r '.session_id // "unknown"' <<<"$input")
threshold=${EPIC_RUNNER_ROTATE_AT:-300000}
marker_dir=${EPIC_RUNNER_MARKER_DIR:-}
status_file=${EPIC_RUNNER_STATUS:-.epic-runner/status}

[[ -n "$transcript" && -f "$transcript" ]] || exit 0

tokens=$(grep '"type":"assistant"' "$transcript" | tail -n 200 \
  | jq -s '[.[] | select((.isSidechain // false) | not) | .message.usage | select(. != null)] | last
           | if . == null then 0 else (.input_tokens + (.cache_read_input_tokens // 0) + (.cache_creation_input_tokens // 0)) end' 2>/dev/null || echo 0)

(( tokens >= threshold )) || exit 0

if [[ -n "$marker_dir" ]]; then
  marker="$marker_dir/rotate-notified-$session"
  [[ -e "$marker" ]] && exit 0
  mkdir -p "$marker_dir"
  : >"$marker"
fi

msg="epic-runner: context is at ${tokens} tokens (threshold ${threshold}). Finish the current edit, commit WIP on the epic branch, run /baton drop, then append the line \`rotate baton=<path>\` to ${status_file} and end your turn."
jq -cn --arg m "$msg" '{hookSpecificOutput: {hookEventName: "PostToolUse", additionalContext: $m}}'
