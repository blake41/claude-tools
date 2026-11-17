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
OPSHUB=c5d811f5-e17a-4a69-a58a-382eb9472bf0
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
run "default list keeps key/value and adds only a secretKey alias (no truncated secretValue)" \
    '.ok == true and (.result | all(.key == .secretKey)) and ([.result[] | keys[]] | unique) == ["key","secretKey","value"]' \
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

echo "folder awareness"
run "list at a root with folders reports folders + note" \
    '.ok == true and (.folders | index("/ops-hub-log-monitor")) != null and (.note | contains("subfolder") and contains("/ops-hub-log-monitor") and contains("--recursive"))' \
    secrets list -p "$OPSHUB" -e production --names
run "list at a root without folders has folders [] and no note" \
    '.ok == true and .folders == [] and (has("note") | not)' \
    secrets list -p "$TERRA" -e staging --names
run "alias note and folder note combine into one string" \
    '.ok == true and (.note | type == "string" and contains("Mapped") and contains("subfolder"))' \
    secrets list -p "$OPSHUB" -e prod --names
run "list --path into the folder lists its secrets" \
    '.ok == true and (.result | length) > 0 and .folders == [] and (has("note") | not)' \
    secrets list -p "$OPSHUB" -e production --path /ops-hub-log-monitor --names
run "export carries folders too" \
    '.ok == true and (.folders | index("/ops-hub-log-monitor")) != null' \
    secrets export -p "$OPSHUB" -e production -f json
run "get miss at a root with folders keeps ok:true 404 and adds a hint" \
    '.ok == true and .result.statusCode == 404 and (.hint | contains("ops-hub-log-monitor") and contains("secrets find ANTHROPIC_API_KEY"))' \
    secrets get ANTHROPIC_API_KEY -p "$OPSHUB" -e production
run "get hit has no hint" \
    '.ok == true and (has("hint") | not) and .result.secret.secretKey == "ANTHROPIC_API_KEY"' \
    secrets get ANTHROPIC_API_KEY -p "$OPSHUB" -e production --path /ops-hub-log-monitor

echo "list --recursive"
run "--recursive --names returns key+path only, including the folder key" \
    '.ok == true and ([.result[] | keys[]] | unique) == ["key","path"] and any(.result[]; .key == "ANTHROPIC_API_KEY" and .path == "/ops-hub-log-monitor") and any(.result[]; .path == "/")' \
    secrets list -p "$OPSHUB" -e production --recursive --names
run "-r alias works and default entries keep value fields plus path" \
    '.ok == true and ([.result[] | keys[]] | unique) == ["key","path","secretKey","value"]' \
    secrets list -p "$OPSHUB" -e production -r
run "--recursive on a project without folders still works" \
    '.ok == true and (.result | length) > 0' \
    secrets list -p "$TERRA" -e staging --recursive --names

echo "find at any depth"
run "find lists visited folder paths and finds the folder-only key" \
    '.ok == true and (.result.locations_searched | type == "array") and (.result.locations_searched_count == (.result.locations_searched | length)) and any(.result.locations_searched[]; .path == "/ops-hub-log-monitor") and any(.result.matches[]; .key == "ANTHROPIC_API_KEY" and .path == "/ops-hub-log-monitor")' \
    secrets find '^ANTHROPIC_API_KEY$' -p "$OPSHUB" -e production

echo "layout"
run "layout shows the folder tree with counts, no names or values" \
    '.ok == true and (.result.projects | length) == 1 and (.result.projects[0].environments | length) == 1 and (.result.projects[0].environments[0].tree | map(.path)) == ["/","/ops-hub-log-monitor"] and (.result.projects[0].environments[0].tree | all(.secrets | type == "number")) and ([.result.projects[0].environments[0].tree[] | keys[]] | unique | all(. == "path" or . == "depth" or . == "secrets" or . == "description"))' \
    layout -p "$OPSHUB" -e production
run "layout -e dev maps alias on Keystone with a note" \
    '.ok == true and (.note | contains("Mapped")) and (.result.projects[0].environments[0].env == "dev")' \
    layout -p "$KEYSTONE" -e development
run "layout with unknown env -> INVALID_ENV" '.error.code == "INVALID_ENV"' layout -p "$TERRA" -e nope
run "layout with empty -p -> MISSING_PROJECT" '.error.code == "MISSING_PROJECT"' layout -p ""
run "layout with empty -e -> MISSING_ENV" '.error.code == "MISSING_ENV"' layout -p "$TERRA" -e ""
run "layout with unknown option -> INVALID_ARG" '.error.code == "INVALID_ARG"' layout --bogus
run "layout with unknown project -> PROJECT_NOT_FOUND" '.error.code == "PROJECT_NOT_FOUND"' layout -p not-a-real-id
run "help lists layout" \
    '.result.commands | any(.name == "layout")' 

rm -f /tmp/.ia-test-err
echo
echo "passed=$PASS failed=$FAIL"
[[ "$FAIL" -eq 0 ]]
