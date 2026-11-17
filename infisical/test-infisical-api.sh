#!/bin/bash
# test-infisical-api.sh - live, READ-ONLY checks for infisical-api guardrails.
# Needs real credentials (skips cleanly without them). Never prints a secret
# value: every assertion works on names, codes, counts and field sets.
#
#   bash infisical/test-infisical-api.sh

set -uo pipefail

TOOL="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/infisical-api"
TERRA=320dfa64-a77c-4a51-ba4f-6ccbc21208ef
KEYSTONE=32d390f3-bada-40cb-942d-536252fe001f
PASS=0
FAIL=0

ok()   { PASS=$((PASS + 1)); echo "  PASS $1"; }
bad()  { FAIL=$((FAIL + 1)); echo "  FAIL $1"; }

# run <label> <jq-assertion> <args...>: runs the tool, asserts exit-code-independent
# jq expression is true on stdout, and that stderr is empty (no raw jq errors).
run() {
    local label="$1" assertion="$2"
    shift 2
    local out err rc
    out=$("$TOOL" "$@" 2>/tmp/.ia-test-err); rc=$?
    err=$(cat /tmp/.ia-test-err)
    if [[ -n "$err" ]]; then bad "$label (stderr not empty: ${err:0:80})"; return; fi
    if printf '%s' "$out" | jq -e "$assertion" >/dev/null 2>&1; then ok "$label"; else bad "$label (rc=$rc)"; fi
}

"$TOOL" projects list >/dev/null 2>&1 || { echo "SKIP: no working Infisical credentials"; exit 0; }

echo "env validation"
run "wrong slug -> INVALID_ENV with valid list" \
    '.ok == false and .error.code == "INVALID_ENV" and (.error.message | contains("development, staging, production"))' \
    secrets list -p "$TERRA" -e nope
run "-e dev on Terra maps to development with a note" \
    '.ok == true and (.note | contains("development"))' \
    secrets list -p "$TERRA" -e dev --names
run "-e development on Keystone maps to dev with a note" \
    '.ok == true and (.note | contains("slug '"'"'dev'"'"'"))' \
    secrets list -p "$KEYSTONE" -e development --names
run "exact slug gives no note" \
    '.ok == true and (has("note") | not)' \
    secrets list -p "$TERRA" -e staging --names
run "empty -e -> MISSING_ENV" '.error.code == "MISSING_ENV"' secrets list -p "$TERRA" -e ""

echo "project id"
run "empty -p -> MISSING_PROJECT" '.error.code == "MISSING_PROJECT"' secrets list -p "" -e staging
run "-p without value -> MISSING_PROJECT" '.error.code == "MISSING_PROJECT"' secrets list -p
run "unknown project -> PROJECT_NOT_FOUND" '.error.code == "PROJECT_NOT_FOUND"' secrets list -p not-a-real-id -e staging

echo "--names / aliases"
run "--names returns only the key field" \
    '.ok == true and (.result | length) > 0 and ([.result[] | keys[]] | unique) == ["key"]' \
    secrets list -p "$TERRA" -e staging --names
run "default list keeps key/value and adds secretKey/secretValue equal to them" \
    '.ok == true and (.result | all(.key == .secretKey and .value == .secretValue)) and ([.result[] | keys[]] | unique) == ["key","secretKey","secretValue","value"]' \
    secrets list -p "$TERRA" -e staging

echo "secrets find"
run "find returns names with project/env/path, no value fields" \
    '.ok == true and (.result.matches | length) > 0 and ([.result.matches[] | keys[]] | unique) == ["env","key","path","project","projectId"]' \
    secrets find ANTHROPIC
run "find with alias -e dev searches Terra development" \
    '.ok == true and ([.result.matches[] | select(.project == "Terra") | .env] | unique) == ["development"]' \
    secrets find ANTHROPIC -e dev
run "find with unknown env -> INVALID_ENV" '.error.code == "INVALID_ENV"' secrets find ANTHROPIC -e nope
run "find with bad regex -> INVALID_ARG" '.error.code == "INVALID_ARG"' secrets find '('
run "find with empty -p -> MISSING_PROJECT" '.error.code == "MISSING_PROJECT"' secrets find ANTHROPIC -p ""

rm -f /tmp/.ia-test-err
echo
echo "passed=$PASS failed=$FAIL"
[[ "$FAIL" -eq 0 ]]
