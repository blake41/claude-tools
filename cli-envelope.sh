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

# Retry/pacing knobs for safe_api_call. Env-overridable (tests use small
# values to force exhaustion without waiting real time).
: "${RENDER_API_MAX_ATTEMPTS:=5}"
: "${RENDER_API_WAIT_BUDGET_S:=60}"

# json_ok <command> <result_json> [next_actions_json]
# Emit a success envelope and return 0.
#
# $result can be arbitrarily large — a page of Render log entries can run
# into the megabytes. It is written to a temp file and read back via
# --slurpfile rather than passed via --argjson, because --argjson pushes
# the ENTIRE value through argv when jq is exec'd. On Linux that blows past
# MAX_ARG_STRLEN (128KB per argv string): jq dies with "Argument list too
# long", and under `set -e` that used to kill the whole script with zero
# stdout bytes — indistinguishable from a crash to a caller. --slurpfile
# only takes a filename on argv; the content itself is read via file I/O,
# which has no such limit.
json_ok() {
  local cmd="$1"
  local result="$2"
  local next_actions="${3:-[]}"
  local tmpfile
  tmpfile=$(mktemp)
  printf '%s' "$result" > "$tmpfile"

  if ! jq -n \
    --arg cmd "$cmd" \
    --argjson next "$next_actions" \
    --slurpfile resultArr "$tmpfile" \
    '{ok: true, command: $cmd, result: $resultArr[0], next_actions: $next}'; then
    rm -f "$tmpfile"
    echo "json_ok: failed to build result envelope for $cmd" >&2
    json_error "$cmd" "Internal error building result envelope" "INTERNAL_ERROR" "This is a bug in $cmd — report it"
    return 1
  fi
  rm -f "$tmpfile"
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
# Wraps curl, captures HTTP status and response headers, retries 429/503
# with backoff, and emits a json_error envelope on unrecoverable failure.
# On success, prints the response body to stdout.
#
# Retry/pacing behavior:
#   - 429/503 responses: sleep for the Retry-After header (seconds) if
#     present, else exponential backoff capped at 30s. Bounded by
#     $RENDER_API_MAX_ATTEMPTS attempts and a total wait-time budget of
#     $RENDER_API_WAIT_BUDGET_S seconds.
#   - The wait-time budget is cumulative ACROSS separate safe_api_call
#     invocations within one script run (e.g. across a paginated fetch
#     loop), tracked via the file at $RENDER_API_BUDGET_FILE if set. This
#     is necessary because `result=$(render_api ...)` forks a subshell for
#     the command substitution — a bash variable set inside can't survive
#     to the next call, only a file can.
#   - On success, if the RateLimit-Remaining header is at/near 0, sleep
#     until RateLimit-Reset (capped) before returning, to pace ahead of
#     the next call instead of reactively hitting a 429.
#   - On exhaustion, this calls json_error with code RATE_LIMITED — a
#     caller in a pagination loop (see render/render-logs) can distinguish
#     that from a hard, non-retryable failure and degrade to a partial
#     result instead of aborting.
safe_api_call() {
  local cmd_name="$1"
  shift

  local budget_file="${RENDER_API_BUDGET_FILE:-}"
  local elapsed=0
  if [[ -n "$budget_file" && -f "$budget_file" ]]; then
    elapsed=$(cat "$budget_file" 2>/dev/null)
    [[ "$elapsed" =~ ^[0-9]+$ ]] || elapsed=0
  fi

  local attempt=1
  while true; do
    local tmpfile headerfile http_code
    tmpfile=$(mktemp)
    headerfile=$(mktemp)

    http_code=$(curl -sS -w '%{http_code}' -o "$tmpfile" -D "$headerfile" "$@") || {
      local err=$?
      rm -f "$tmpfile" "$headerfile"
      # Callers typically invoke this via `result=$(...)`. Under set -e,
      # that assignment's failure exits the script before $result is ever
      # printed — json_error's stdout envelope would otherwise be silently
      # lost. Mirror it to stderr so the failure is visible even though
      # stdout is captured.
      echo "curl failed (exit $err) calling $cmd_name" >&2
      json_error "$cmd_name" "curl failed (exit $err)" "NETWORK_ERROR" "Check network connectivity and URL"
    }

    local body
    body=$(cat "$tmpfile")
    rm -f "$tmpfile"

    if [[ "$http_code" == "429" || "$http_code" == "503" ]]; then
      local retry_after
      retry_after=$(grep -i '^Retry-After:' "$headerfile" 2>/dev/null | tail -1 | cut -d: -f2- | tr -d ' \r\n')
      if [[ ! "$retry_after" =~ ^[0-9]+$ ]]; then
        retry_after=$(( attempt * attempt * 2 ))
        [[ "$retry_after" -gt 30 ]] && retry_after=30
      fi
      rm -f "$headerfile"

      if [[ "$attempt" -ge "$RENDER_API_MAX_ATTEMPTS" ]] || (( elapsed + retry_after > RENDER_API_WAIT_BUDGET_S )); then
        echo "$cmd_name: rate limited (HTTP $http_code), retry budget exhausted after $attempt attempt(s), ${elapsed}s waited so far" >&2
        json_error "$cmd_name" "Rate limited (HTTP $http_code); retry budget exhausted" "RATE_LIMITED" "Retry later, or raise RENDER_API_WAIT_BUDGET_S / RENDER_API_MAX_ATTEMPTS"
      fi

      echo "$cmd_name: HTTP $http_code, waiting ${retry_after}s before retry $((attempt + 1))/$RENDER_API_MAX_ATTEMPTS" >&2
      sleep "$retry_after"
      elapsed=$((elapsed + retry_after))
      [[ -n "$budget_file" ]] && echo "$elapsed" > "$budget_file"
      attempt=$((attempt + 1))
      continue
    fi

    if [[ "$http_code" -ge 400 ]]; then
      local msg
      msg=$(echo "$body" | jq -r '.message // .error // .error_description // empty' 2>/dev/null)
      [[ -z "$msg" ]] && msg="HTTP $http_code"
      rm -f "$headerfile"
      echo "$cmd_name failed: HTTP $http_code — $msg" >&2
      json_error "$cmd_name" "$msg" "HTTP_$http_code" "Check API credentials and endpoint"
    fi

    # Success. Proactively pace ahead of the next call if we're at/near the
    # rate limit window's edge, instead of waiting to get 429'd.
    local remaining reset
    remaining=$(grep -i '^RateLimit-Remaining:' "$headerfile" 2>/dev/null | tail -1 | cut -d: -f2- | tr -d ' \r\n')
    reset=$(grep -i '^RateLimit-Reset:' "$headerfile" 2>/dev/null | tail -1 | cut -d: -f2- | tr -d ' \r\n')
    rm -f "$headerfile"

    if [[ "$remaining" =~ ^[0-9]+$ ]] && [[ "$remaining" -le 0 ]] && [[ "$reset" =~ ^[0-9]+$ ]] && [[ "$reset" -gt 0 ]]; then
      local pace_wait="$reset"
      [[ "$pace_wait" -gt 10 ]] && pace_wait=10
      echo "$cmd_name: rate limit window nearly exhausted, pacing ${pace_wait}s before returning" >&2
      sleep "$pace_wait"
    fi

    echo "$body"
    return 0
  done
}
