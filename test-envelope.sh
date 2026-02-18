#!/bin/bash
# test-envelope.sh - Verify all CLI tools return valid JSON envelopes
# Tests: root cmd_tree, error handling, and envelope structure
# Does NOT test commands that require API credentials

set -uo pipefail

TOOLS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PASS=0
FAIL=0
SKIP=0
ERRORS=()

# Colors for terminal output (test script only, not a CLI tool)
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m'

check_json() {
    local label="$1"
    local output="$2"

    if echo "$output" | jq -e '.' > /dev/null 2>&1; then
        return 0
    else
        return 1
    fi
}

check_envelope() {
    local label="$1"
    local output="$2"

    # Must be valid JSON
    if ! check_json "$label" "$output"; then
        echo -e "  ${RED}FAIL${NC} $label - not valid JSON"
        FAIL=$((FAIL + 1))
        ERRORS+=("$label: not valid JSON")
        return 1
    fi

    # Must have 'ok' field
    if ! echo "$output" | jq -e 'has("ok")' > /dev/null 2>&1; then
        echo -e "  ${RED}FAIL${NC} $label - missing 'ok' field"
        FAIL=$((FAIL + 1))
        ERRORS+=("$label: missing 'ok' field")
        return 1
    fi

    # Must have 'command' field
    if ! echo "$output" | jq -e 'has("command")' > /dev/null 2>&1; then
        echo -e "  ${RED}FAIL${NC} $label - missing 'command' field"
        FAIL=$((FAIL + 1))
        ERRORS+=("$label: missing 'command' field")
        return 1
    fi

    # Success must have 'result', error must have 'error'
    local ok
    ok=$(echo "$output" | jq -r '.ok')
    if [[ "$ok" == "true" ]]; then
        if ! echo "$output" | jq -e 'has("result")' > /dev/null 2>&1; then
            echo -e "  ${RED}FAIL${NC} $label - ok=true but missing 'result' field"
            FAIL=$((FAIL + 1))
            ERRORS+=("$label: ok=true but missing 'result'")
            return 1
        fi
    else
        if ! echo "$output" | jq -e 'has("error")' > /dev/null 2>&1; then
            echo -e "  ${RED}FAIL${NC} $label - ok=false but missing 'error' field"
            FAIL=$((FAIL + 1))
            ERRORS+=("$label: ok=false but missing 'error'")
            return 1
        fi
        # Error must have code
        if ! echo "$output" | jq -e '.error.code' > /dev/null 2>&1; then
            echo -e "  ${RED}FAIL${NC} $label - error missing 'code' field"
            FAIL=$((FAIL + 1))
            ERRORS+=("$label: error missing 'code'")
            return 1
        fi
    fi

    echo -e "  ${GREEN}PASS${NC} $label"
    PASS=$((PASS + 1))
    return 0
}

check_cmd_tree() {
    local label="$1"
    local output="$2"

    # cmd_tree output is ok=true with result.commands array
    if ! echo "$output" | jq -e '.result.commands | type == "array"' > /dev/null 2>&1; then
        echo -e "  ${RED}FAIL${NC} $label - cmd_tree missing result.commands array"
        FAIL=$((FAIL + 1))
        ERRORS+=("$label: cmd_tree missing result.commands")
        return 1
    fi

    # Each command should have name, description, usage
    local valid
    valid=$(echo "$output" | jq '[.result.commands[] | has("name", "description", "usage")] | all')
    if [[ "$valid" != "true" ]]; then
        echo -e "  ${RED}FAIL${NC} $label - cmd_tree commands missing name/description/usage"
        FAIL=$((FAIL + 1))
        ERRORS+=("$label: commands missing required fields")
        return 1
    fi

    echo -e "  ${GREEN}PASS${NC} $label ($(echo "$output" | jq '.result.commands | length') commands)"
    PASS=$((PASS + 1))
    return 0
}

run_tool() {
    local tool_path="$1"
    shift
    # Run and capture output, allow non-zero exit
    "$tool_path" "$@" 2>/dev/null || true
}

echo "============================================"
echo "CLI Envelope Migration Verification"
echo "============================================"
echo ""

# --------------------------------------------------------------------------
# Test 1: cli-envelope.sh helper functions
# --------------------------------------------------------------------------
echo "--- cli-envelope.sh helper functions ---"

# Source the helper
source "$TOOLS_DIR/cli-envelope.sh"

# Test json_ok
output=$(json_ok "test-cmd" '{"key": "value"}' "$(next_actions "$(next_action "test next" "do next thing")")")
check_envelope "json_ok basic" "$output"

# Test json_error (runs in subshell since it calls exit 1)
output=$(json_error "test-cmd" "something broke" "TEST_ERROR" "fix it" 2>/dev/null) || true
if [[ -n "$output" ]]; then
    check_envelope "json_error basic" "$output"
else
    echo -e "  ${RED}FAIL${NC} json_error basic - no output captured"
    FAIL=$((FAIL + 1))
fi

# Test next_actions
output=$(next_actions "$(next_action "cmd1" "desc1")" "$(next_action "cmd2" "desc2")")
count=$(echo "$output" | jq 'length')
if [[ "$count" == "2" ]]; then
    echo -e "  ${GREEN}PASS${NC} next_actions (2 actions)"
    PASS=$((PASS + 1))
else
    echo -e "  ${RED}FAIL${NC} next_actions expected 2, got $count"
    FAIL=$((FAIL + 1))
fi

# Test json_truncate
output=$(json_truncate '[1,2,3,4,5,6,7,8,9,10]' 3)
truncated=$(echo "$output" | jq '.truncated')
total=$(echo "$output" | jq '.total')
if [[ "$truncated" == "true" && "$total" == "10" ]]; then
    echo -e "  ${GREEN}PASS${NC} json_truncate (10 items, limit 3)"
    PASS=$((PASS + 1))
else
    echo -e "  ${RED}FAIL${NC} json_truncate truncated=$truncated total=$total"
    FAIL=$((FAIL + 1))
fi

# Test cmd_tree
output=$(cmd_tree "test-tool" "A test tool" "$(jq -n '[{name: "foo", description: "do foo", usage: "test-tool foo"}]')")
check_envelope "cmd_tree basic" "$output"
check_cmd_tree "cmd_tree structure" "$output"

echo ""

# --------------------------------------------------------------------------
# Test 2: Each tool's root command (cmd_tree)
# --------------------------------------------------------------------------
echo "--- Tool root commands (cmd_tree) ---"

TOOL_NAMES=(render-services render-workspace render-logs sf-query cf-workers cf-logs exa-search c7 linear-cli notion-cc infisical-api)
TOOL_PATHS=(
    "$TOOLS_DIR/render/render-services"
    "$TOOLS_DIR/render/render-workspace"
    "$TOOLS_DIR/render/render-logs"
    "$TOOLS_DIR/salesforce/sf-query"
    "$TOOLS_DIR/cloudflare/cf-workers"
    "$TOOLS_DIR/cloudflare/cf-logs"
    "$TOOLS_DIR/exa/exa-search"
    "$TOOLS_DIR/c7/c7"
    "$TOOLS_DIR/linear/linear-cli"
    "$TOOLS_DIR/notion/notion-cc"
    "$TOOLS_DIR/infisical/infisical-api"
)

for i in "${!TOOL_NAMES[@]}"; do
    tool_name="${TOOL_NAMES[$i]}"
    tool_path="${TOOL_PATHS[$i]}"
    if [[ ! -x "$tool_path" ]]; then
        echo -e "  ${YELLOW}SKIP${NC} $tool_name - not executable or not found"
        SKIP=$((SKIP + 1))
        continue
    fi

    output=$(run_tool "$tool_path")

    if [[ -z "$output" ]]; then
        echo -e "  ${RED}FAIL${NC} $tool_name root - no output"
        FAIL=$((FAIL + 1))
        ERRORS+=("$tool_name: root command produced no output")
        continue
    fi

    check_envelope "$tool_name root" "$output"
    check_cmd_tree "$tool_name cmd_tree" "$output"
done

echo ""

# --------------------------------------------------------------------------
# Test 3: Error handling (missing args)
# --------------------------------------------------------------------------
echo "--- Error handling (missing args) ---"

# render-services get (no ID)
output=$(run_tool "$TOOLS_DIR/render/render-services" get)
if [[ -n "$output" ]]; then
    check_envelope "render-services get (no ID)" "$output"
fi

# sf-query (no args)
output=$(run_tool "$TOOLS_DIR/salesforce/sf-query")
if [[ -n "$output" ]]; then
    check_envelope "sf-query (no args)" "$output"
fi

# linear-cli issue (no ID)
output=$(run_tool "$TOOLS_DIR/linear/linear-cli" issue)
if [[ -n "$output" ]]; then
    check_envelope "linear-cli issue (no ID)" "$output"
fi

# notion-cc setup (interactive)
output=$(run_tool "$TOOLS_DIR/notion/notion-cc" setup)
if [[ -n "$output" ]]; then
    check_envelope "notion-cc setup (interactive)" "$output"
    error_code=$(echo "$output" | jq -r '.error.code // empty')
    if [[ "$error_code" == "INTERACTIVE_REQUIRED" ]]; then
        echo -e "  ${GREEN}PASS${NC} notion-cc setup returns INTERACTIVE_REQUIRED"
        PASS=$((PASS + 1))
    else
        echo -e "  ${RED}FAIL${NC} notion-cc setup expected INTERACTIVE_REQUIRED, got: $error_code"
        FAIL=$((FAIL + 1))
    fi
fi

# notion-cc wait-for-comment (streaming)
output=$(run_tool "$TOOLS_DIR/notion/notion-cc" wait-for-comment)
if [[ -n "$output" ]]; then
    check_envelope "notion-cc wait-for-comment (streaming)" "$output"
    error_code=$(echo "$output" | jq -r '.error.code // empty')
    if [[ "$error_code" == "STREAMING" ]]; then
        echo -e "  ${GREEN}PASS${NC} notion-cc wait-for-comment returns STREAMING"
        PASS=$((PASS + 1))
    else
        echo -e "  ${RED}FAIL${NC} notion-cc wait-for-comment expected STREAMING, got: $error_code"
        FAIL=$((FAIL + 1))
    fi
fi

# c7 setup (interactive)
output=$(run_tool "$TOOLS_DIR/c7/c7" setup)
if [[ -n "$output" ]]; then
    check_envelope "c7 setup (interactive)" "$output"
fi

# infisical-api setup (interactive)
output=$(run_tool "$TOOLS_DIR/infisical/infisical-api" setup)
if [[ -n "$output" ]]; then
    check_envelope "infisical-api setup (interactive)" "$output"
fi

echo ""

# --------------------------------------------------------------------------
# Test 4: No ANSI colors in output
# --------------------------------------------------------------------------
echo "--- No ANSI escape codes ---"

for i in "${!TOOL_NAMES[@]}"; do
    tool_name="${TOOL_NAMES[$i]}"
    tool_path="${TOOL_PATHS[$i]}"
    [[ ! -x "$tool_path" ]] && continue

    output=$(run_tool "$tool_path" 2>&1)
    if echo "$output" | grep -qP '\033\[' 2>/dev/null || echo "$output" | grep -q $'\e\[' 2>/dev/null; then
        echo -e "  ${RED}FAIL${NC} $tool_name - contains ANSI escape codes"
        FAIL=$((FAIL + 1))
        ERRORS+=("$tool_name: contains ANSI escape codes")
    else
        echo -e "  ${GREEN}PASS${NC} $tool_name - no ANSI codes"
        PASS=$((PASS + 1))
    fi
done

echo ""

# --------------------------------------------------------------------------
# Summary
# --------------------------------------------------------------------------
echo "============================================"
echo "Results: ${GREEN}${PASS} passed${NC}, ${RED}${FAIL} failed${NC}, ${YELLOW}${SKIP} skipped${NC}"
echo "============================================"

if [[ ${#ERRORS[@]} -gt 0 ]]; then
    echo ""
    echo "Failures:"
    for err in "${ERRORS[@]}"; do
        echo "  - $err"
    done
fi

if [[ $FAIL -gt 0 ]]; then
    exit 1
fi
