#!/bin/bash
# cli-envelope.sh - JSON envelope helpers for agent-first CLI tools
#
# Source this file in any CLI tool:
#   source "$(dirname "$0")/cli-envelope.sh"
#
# Every command returns: { ok, command, result, next_actions }
# Every error returns:   { ok, command, error: {message, code}, fix, next_actions }

if ! command -v jq &>/dev/null; then
  echo '{"ok":false,"command":"cli-envelope","error":{"message":"jq is required but not installed","code":"MISSING_DEP"},"fix":"Install jq: brew install jq","next_actions":[]}' >&2
  exit 1
fi

# json_ok <command> <result_json> [next_actions_json]
# Emit a success envelope and return 0.
json_ok() {
  local cmd="$1"
  local result="$2"
  local next_actions="${3:-[]}"
  jq -n \
    --arg cmd "$cmd" \
    --argjson result "$result" \
    --argjson next "$next_actions" \
    '{ok: true, command: $cmd, result: $result, next_actions: $next}'
}

# json_error <command> <message> <code> <fix> [next_actions_json]
# Emit an error envelope and exit 1.
json_error() {
  local cmd="$1"
  local message="$2"
  local code="$3"
  local fix="$4"
  local next_actions="${5:-[]}"
  jq -n \
    --arg cmd "$cmd" \
    --arg msg "$message" \
    --arg code "$code" \
    --arg fix "$fix" \
    --argjson next "$next_actions" \
    '{ok: false, command: $cmd, error: {message: $msg, code: $code}, fix: $fix, next_actions: $next}'
  exit 1
}

# next_action <command> <description>
# Returns a single {command, description} JSON object.
next_action() {
  jq -n --arg cmd "$1" --arg desc "$2" '{command: $cmd, description: $desc}'
}

# next_actions "$(next_action ...)" "$(next_action ...)" ...
# Combines multiple next_action objects into a JSON array.
next_actions() {
  if [[ $# -eq 0 ]]; then
    echo '[]'
    return
  fi
  printf '%s\n' "$@" | jq -s '.'
}

# json_truncate <array_json> <max_items>
# Truncates a JSON array and returns metadata.
# Returns: { items: [...], total: N, shown: M, truncated: bool }
json_truncate() {
  local array="$1"
  local max="$2"
  echo "$array" | jq --argjson max "$max" '
    length as $total |
    if $total <= $max then
      {items: ., total: $total, shown: $total, truncated: false}
    else
      {items: .[:$max], total: $total, shown: $max, truncated: true}
    end'
}

# cmd_tree <tool_name> <description> <commands_json>
# Emit the self-documenting root response.
# commands_json is an array of {name, description, usage} objects.
cmd_tree() {
  local tool="$1"
  local desc="$2"
  local commands="$3"
  local na
  na=$(echo "$commands" | jq '[.[] | {command: .usage, description: .description}]')
  json_ok "$tool" "$(jq -n --arg desc "$desc" --argjson cmds "$commands" '{description: $desc, commands: $cmds}')" "$na"
}

# safe_api_call <command_name> <curl_args...>
# Wraps curl, captures HTTP status, emits json_error on failure.
# On success, prints the response body to stdout.
safe_api_call() {
  local cmd_name="$1"
  shift
  local tmpfile
  tmpfile=$(mktemp)
  local http_code
  http_code=$(curl -sS -w '%{http_code}' -o "$tmpfile" "$@") || {
    local err=$?
    rm -f "$tmpfile"
    json_error "$cmd_name" "curl failed (exit $err)" "NETWORK_ERROR" "Check network connectivity and URL"
  }
  local body
  body=$(cat "$tmpfile")
  rm -f "$tmpfile"

  if [[ "$http_code" -ge 400 ]]; then
    local msg
    msg=$(echo "$body" | jq -r '.message // .error // .error_description // empty' 2>/dev/null)
    [[ -z "$msg" ]] && msg="HTTP $http_code"
    json_error "$cmd_name" "$msg" "HTTP_$http_code" "Check API credentials and endpoint"
  fi
  echo "$body"
}
