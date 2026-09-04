#!/bin/bash
# render/test-render-logs.sh — end-to-end tests for render/render-logs
#
# Drives the REAL render-logs script (and the real cli-envelope.sh /
# render-common.sh it sources) through PATH-shimmed fake `curl` and
# `sleep` binaries. Every scenario is fast, deterministic, and hits zero
# real network — per this repo's testing convention (see test-envelope.sh),
# no test may touch the real Render API.
#
# Style matches test-envelope.sh: PASS/FAIL counters, an ERRORS array,
# non-zero exit if anything failed.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TOOLS_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
RENDER_LOGS="$TOOLS_DIR/render/render-logs"

PASS=0
FAIL=0
ERRORS=()

GREEN='\033[0;32m'
RED='\033[0;31m'
NC='\033[0m'

pass() { echo -e "  ${GREEN}PASS${NC} $1"; PASS=$((PASS + 1)); }
fail() {
    echo -e "  ${RED}FAIL${NC} $1"
    FAIL=$((FAIL + 1))
    ERRORS+=("$1")
}

# --------------------------------------------------------------------------
# Fixture / shim plumbing
# --------------------------------------------------------------------------

# setup_env <dir>
# Scratch dir layout:
#   $dir/work/.env      - RENDER_API_KEY / RENDER_WORKSPACE (fake creds)
#   $dir/bin/curl        - shim: logs argv, serves scripted response
#   $dir/bin/sleep       - shim: logs requested duration, returns instantly
#   $dir/responses/<N>/  - status/body/headers for the Nth real curl call
#   $dir/calls.log       - every curl call's full argv, one call per block
#   $dir/sleep.log       - every sleep call's argument, one per line
setup_env() {
    local dir="$1"
    mkdir -p "$dir/bin" "$dir/responses" "$dir/work"
    cat > "$dir/work/.env" <<EOF
RENDER_API_KEY=test-key
RENDER_WORKSPACE=tm-test-owner
EOF

    cat > "$dir/bin/curl" <<'CURL_EOF'
#!/bin/bash
DIR="$FAKE_DIR"
COUNTER_FILE="$DIR/counter"
[[ -f "$COUNTER_FILE" ]] || echo 0 > "$COUNTER_FILE"
N=$(cat "$COUNTER_FILE")
echo $((N + 1)) > "$COUNTER_FILE"

{
    echo "=== call $N ==="
    printf '%s\n' "$@"
} >> "$DIR/calls.log"

CALLDIR="$DIR/responses/$N"
if [[ ! -d "$CALLDIR" ]]; then
    LAST=$(ls "$DIR/responses" 2>/dev/null | sort -n | tail -1)
    CALLDIR="$DIR/responses/$LAST"
fi

STATUS="200"
[[ -f "$CALLDIR/status" ]] && STATUS=$(cat "$CALLDIR/status")

OUT=""
HEADERFILE=""
args=("$@")
i=0
while [[ $i -lt ${#args[@]} ]]; do
    case "${args[$i]}" in
        -o) OUT="${args[$((i + 1))]}"; i=$((i + 2)) ;;
        -D) HEADERFILE="${args[$((i + 1))]}"; i=$((i + 2)) ;;
        *) i=$((i + 1)) ;;
    esac
done

if [[ -n "$OUT" ]]; then
    if [[ -f "$CALLDIR/body" ]]; then
        cp "$CALLDIR/body" "$OUT"
    else
        : > "$OUT"
    fi
fi

if [[ -n "$HEADERFILE" ]]; then
    if [[ -f "$CALLDIR/headers" ]]; then
        cp "$CALLDIR/headers" "$HEADERFILE"
    else
        : > "$HEADERFILE"
    fi
fi

printf '%s' "$STATUS"
exit 0
CURL_EOF
    chmod +x "$dir/bin/curl"

    cat > "$dir/bin/sleep" <<'SLEEP_EOF'
#!/bin/bash
echo "$1" >> "$FAKE_SLEEP_LOG"
exit 0
SLEEP_EOF
    chmod +x "$dir/bin/sleep"
}

# write_response <dir> <index> <status> <body_file> [header_line...]
# body_file: a path to read the body from (so callers can printf large
# bodies to a file first rather than passing them as a shell arg).
write_response() {
    local dir="$1" idx="$2" status="$3" body_file="$4"
    shift 4
    mkdir -p "$dir/responses/$idx"
    echo "$status" > "$dir/responses/$idx/status"
    cp "$body_file" "$dir/responses/$idx/body"
    if [[ $# -gt 0 ]]; then
        printf '%s\r\n' "$@" > "$dir/responses/$idx/headers"
    fi
}

# run_render_logs <dir> [args...]
# Runs the real render-logs with PATH shims + fake creds, in a subshell so
# the `cd` and exported env don't leak into the rest of this test script.
run_render_logs() {
    local dir="$1"
    shift
    (
        cd "$dir/work" || exit 1
        FAKE_DIR="$dir" \
            FAKE_SLEEP_LOG="$dir/sleep.log" \
            PATH="$dir/bin:$PATH" \
            RENDER_API_MAX_ATTEMPTS="${TEST_MAX_ATTEMPTS:-5}" \
            RENDER_API_WAIT_BUDGET_S="${TEST_WAIT_BUDGET:-60}" \
            "$RENDER_LOGS" "$@"
    )
}

# render_page <logs_json_array> <hasMore> [nextEndTime] [nextStartTime]
render_page() {
    local logs="$1" has_more="$2" next_end="${3:-}" next_start="${4:-}"
    jq -n --argjson logs "$logs" --argjson hasMore "$has_more" \
        --arg nextEnd "$next_end" --arg nextStart "$next_start" \
        '{logs: $logs, hasMore: $hasMore} +
         (if $nextEnd != "" then {nextEndTime: $nextEnd} else {} end) +
         (if $nextStart != "" then {nextStartTime: $nextStart} else {} end)'
}

# log_entry <id> <timestamp> <message> <labels_json_array>
log_entry() {
    local id="$1" ts="$2" msg="$3" labels="$4"
    jq -n --arg id "$id" --arg ts "$ts" --arg msg "$msg" --argjson labels "$labels" \
        '{id: $id, timestamp: $ts, message: $msg, labels: $labels}'
}

# render_page_from_file <logs_json_file> <hasMore> -> stdout
# Same as render_page, but reads a (possibly large) logs array from a FILE
# via --slurpfile instead of a shell arg via --argjson — the ARG_MAX fixture
# below is itself over 1MB, which would blow the same argv limit render-logs
# is being fixed for if this used --argjson like render_page() does.
render_page_from_file() {
    local logs_file="$1" has_more="$2"
    jq -n --slurpfile logsArr "$logs_file" --argjson hasMore "$has_more" \
        '{logs: $logsArr[0], hasMore: $hasMore}'
}

echo "============================================"
echo "render-logs end-to-end verification"
echo "============================================"
echo ""

# --------------------------------------------------------------------------
# 1. ARG_MAX-exceeding payload: 100 entries x 12KB messages
# --------------------------------------------------------------------------
echo "--- ARG_MAX-exceeding payload ---"
{
    dir=$(mktemp -d)
    setup_env "$dir"

    big_msg=$(printf 'x%.0s' $(seq 1 12000))
    logs_file="$dir/big-logs.json"
    jq -n --argjson n 100 --arg msg "$big_msg" '
        [range($n) | {id: ("big-" + (. | tostring)), timestamp: "2026-09-04T10:00:00Z",
                       message: $msg, labels: [{name: "level", value: "error"}]}]' \
        > "$logs_file"
    render_page_from_file "$logs_file" false > "$dir/page0.json"
    write_response "$dir" 0 200 "$dir/page0.json"

    output=$(run_render_logs "$dir" srv-fake --lines 100)
    rc=$?

    if [[ $rc -ne 0 ]]; then
        fail "ARG_MAX payload: render-logs exited non-zero ($rc): $output"
    else
        total=$(echo "$output" | jq -r '.result.total // "MISSING"' 2>/dev/null)
        ok=$(echo "$output" | jq -r 'if has("ok") then (.ok|tostring) else "MISSING" end' 2>/dev/null)
        if [[ "$ok" == "true" && "$total" == "100" ]]; then
            pass "ARG_MAX payload: real total (100) returned, not a false zero"
        else
            fail "ARG_MAX payload: expected ok=true total=100, got ok=$ok total=$total. Output: $output"
        fi
    fi
    rm -rf "$dir"
}
echo ""

# --------------------------------------------------------------------------
# 2. Multi-page pagination merges correctly and in order
# --------------------------------------------------------------------------
echo "--- Multi-page pagination order ---"
{
    dir=$(mktemp -d)
    setup_env "$dir"

    page0_logs=$(jq -n '[
        {id: "p0-a", timestamp: "2026-09-04T10:00:00Z", message: "first", labels: [{name:"level",value:"info"}]},
        {id: "p0-b", timestamp: "2026-09-04T10:00:01Z", message: "second", labels: [{name:"level",value:"info"}]}
    ]')
    page1_logs=$(jq -n '[
        {id: "p1-a", timestamp: "2026-09-04T09:59:59Z", message: "third", labels: [{name:"level",value:"info"}]},
        {id: "p1-b", timestamp: "2026-09-04T09:59:58Z", message: "fourth", labels: [{name:"level",value:"info"}]}
    ]')
    render_page "$page0_logs" true "2026-09-04T10:00:00Z" > "$dir/page0.json"
    render_page "$page1_logs" false > "$dir/page1.json"
    write_response "$dir" 0 200 "$dir/page0.json"
    write_response "$dir" 1 200 "$dir/page1.json"

    output=$(run_render_logs "$dir" srv-fake --lines 10)
    ids=$(echo "$output" | jq -r '.result.items[].id' 2>/dev/null | paste -sd, -)

    if [[ "$ids" == "p0-a,p0-b,p1-a,p1-b" ]]; then
        pass "Multi-page: 4 entries across 2 pages merged in fetch order ($ids)"
    else
        fail "Multi-page: expected p0-a,p0-b,p1-a,p1-b, got '$ids'. Output: $output"
    fi

    calls=$(grep -c '^https://api.render.com/v1/logs' "$dir/calls.log" 2>/dev/null || echo 0)
    if [[ "$calls" == "2" ]]; then
        pass "Multi-page: exactly 2 page fetches made"
    else
        fail "Multi-page: expected 2 fetches, saw $calls"
    fi
    rm -rf "$dir"
}
echo ""

# --------------------------------------------------------------------------
# 3. Malformed/HTML response body -> loud PARSE_ERROR
# --------------------------------------------------------------------------
echo "--- Malformed response body ---"
{
    dir=$(mktemp -d)
    setup_env "$dir"
    printf '<html><body>502 Bad Gateway</body></html>' > "$dir/malformed.body"
    write_response "$dir" 0 200 "$dir/malformed.body"

    output=$(run_render_logs "$dir" srv-fake --lines 10)
    ok=$(echo "$output" | jq -r 'if has("ok") then (.ok|tostring) else "MISSING" end' 2>/dev/null)
    code=$(echo "$output" | jq -r '.error.code // "MISSING"' 2>/dev/null)

    if [[ "$ok" == "false" && "$code" == "PARSE_ERROR" ]]; then
        pass "Malformed body: loud PARSE_ERROR envelope, not a silent empty result"
    else
        fail "Malformed body: expected ok=false code=PARSE_ERROR, got ok=$ok code=$code. Output: $output"
    fi
    rm -rf "$dir"
}
echo ""

# --------------------------------------------------------------------------
# 4. Invalid --grep regex -> loud INVALID_ARG
# --------------------------------------------------------------------------
echo "--- Invalid --grep regex ---"
{
    dir=$(mktemp -d)
    setup_env "$dir"

    output=$(run_render_logs "$dir" srv-fake --grep '[unterminated')
    ok=$(echo "$output" | jq -r 'if has("ok") then (.ok|tostring) else "MISSING" end' 2>/dev/null)
    code=$(echo "$output" | jq -r '.error.code // "MISSING"' 2>/dev/null)

    if [[ "$ok" == "false" && "$code" == "INVALID_ARG" ]]; then
        pass "Invalid --grep: loud INVALID_ARG, not silent empty"
    else
        fail "Invalid --grep: expected ok=false code=INVALID_ARG, got ok=$ok code=$code. Output: $output"
    fi

    calls=0
    [[ -f "$dir/calls.log" ]] && calls=$(wc -l < "$dir/calls.log")
    if [[ "$calls" -eq 0 ]]; then
        pass "Invalid --grep: rejected before any API call was made"
    else
        fail "Invalid --grep: expected zero API calls, saw activity in calls.log"
    fi
    rm -rf "$dir"
}
echo ""

# --------------------------------------------------------------------------
# 5. 429 with Retry-After -> retried and eventually succeeds
# --------------------------------------------------------------------------
echo "--- 429 with Retry-After, then success ---"
{
    dir=$(mktemp -d)
    setup_env "$dir"

    printf '{"message":"rate limited"}' > "$dir/429.body"
    write_response "$dir" 0 429 "$dir/429.body" "Retry-After: 3"

    ok_logs=$(jq -n '[{id: "ok-1", timestamp: "2026-09-04T10:00:00Z", message: "fine", labels: [{name:"level",value:"info"}]}]')
    render_page "$ok_logs" false > "$dir/ok.json"
    write_response "$dir" 1 200 "$dir/ok.json"

    output=$(run_render_logs "$dir" srv-fake --lines 10)
    ok=$(echo "$output" | jq -r 'if has("ok") then (.ok|tostring) else "MISSING" end' 2>/dev/null)
    total=$(echo "$output" | jq -r '.result.total // "MISSING"' 2>/dev/null)

    if [[ "$ok" == "true" && "$total" == "1" ]]; then
        pass "429+Retry-After: recovered and returned the 1 real entry"
    else
        fail "429+Retry-After: expected ok=true total=1, got ok=$ok total=$total. Output: $output"
    fi

    if [[ -f "$dir/sleep.log" ]] && grep -qx '3' "$dir/sleep.log"; then
        pass "429+Retry-After: slept for the Retry-After value (3s)"
    else
        fail "429+Retry-After: expected a sleep of 3s, sleep.log: $(cat "$dir/sleep.log" 2>/dev/null || echo '<missing>')"
    fi
    rm -rf "$dir"
}
echo ""

# --------------------------------------------------------------------------
# 6. 429 repeated past the retry/wait budget -> partial:true, not a crash
# --------------------------------------------------------------------------
echo "--- 429 past retry budget -> partial result ---"
{
    dir=$(mktemp -d)
    setup_env "$dir"

    printf '{"message":"rate limited"}' > "$dir/429.body"
    write_response "$dir" 0 429 "$dir/429.body" "Retry-After: 1"
    write_response "$dir" 1 429 "$dir/429.body" "Retry-After: 1"

    TEST_MAX_ATTEMPTS=2 output=$(TEST_MAX_ATTEMPTS=2 run_render_logs "$dir" srv-fake --lines 10)
    rc=$?
    ok=$(echo "$output" | jq -r 'if has("ok") then (.ok|tostring) else "MISSING" end' 2>/dev/null)
    partial=$(echo "$output" | jq -r '.result.partial // "MISSING"' 2>/dev/null)
    reason=$(echo "$output" | jq -r '.result.partial_reason // "MISSING"' 2>/dev/null)

    if [[ $rc -eq 0 && "$ok" == "true" && "$partial" == "true" && "$reason" == "rate_limited" ]]; then
        pass "429 budget exhausted: partial:true result, not a crash (rc=$rc)"
    else
        fail "429 budget exhausted: expected rc=0 ok=true partial=true reason=rate_limited, got rc=$rc ok=$ok partial=$partial reason=$reason. Output: $output"
    fi
    rm -rf "$dir"
}
echo ""

# --------------------------------------------------------------------------
# 7. 401 / 404 -> proper {"ok":false,...} envelope on stdout, never empty
# --------------------------------------------------------------------------
echo "--- Hard HTTP errors (401, 404) reach stdout ---"
for status in 401 404; do
    dir=$(mktemp -d)
    setup_env "$dir"
    printf '{"message":"boom %s"}' "$status" > "$dir/err.body"
    write_response "$dir" 0 "$status" "$dir/err.body"

    output=$(run_render_logs "$dir" srv-fake --lines 10)
    rc=$?
    ok=$(echo "$output" | jq -r 'if has("ok") then (.ok|tostring) else "MISSING" end' 2>/dev/null)
    code=$(echo "$output" | jq -r '.error.code // "MISSING"' 2>/dev/null)

    if [[ -n "$output" && "$ok" == "false" && "$code" == "HTTP_$status" && $rc -ne 0 ]]; then
        pass "HTTP $status: proper ok:false envelope on stdout (code=$code)"
    else
        fail "HTTP $status: expected non-empty ok:false HTTP_$status envelope, got rc=$rc ok=$ok code=$code output='$output'"
    fi
    rm -rf "$dir"
done
echo ""

# --------------------------------------------------------------------------
# 8. --level validation
# --------------------------------------------------------------------------
echo "--- --level validation ---"
{
    dir=$(mktemp -d)
    setup_env "$dir"
    output=$(run_render_logs "$dir" srv-fake --level warn --lines 10)
    ok=$(echo "$output" | jq -r 'if has("ok") then (.ok|tostring) else "MISSING" end' 2>/dev/null)
    code=$(echo "$output" | jq -r '.error.code // "MISSING"' 2>/dev/null)
    fix=$(echo "$output" | jq -r '.fix // ""' 2>/dev/null)

    if [[ "$ok" == "false" && "$code" == "INVALID_ARG" && "$fix" == *"warning"* ]]; then
        pass "--level warn: rejected with a fix mentioning 'warning'"
    else
        fail "--level warn: expected rejection mentioning warning, got ok=$ok code=$code fix='$fix'"
    fi
    calls=0
    [[ -f "$dir/calls.log" ]] && calls=$(wc -l < "$dir/calls.log")
    [[ "$calls" -eq 0 ]] && pass "--level warn: rejected before any API call" \
        || fail "--level warn: expected zero API calls, saw activity"
    rm -rf "$dir"
}

for lvl in warning '/warn.*/' 'err*'; do
    dir=$(mktemp -d)
    setup_env "$dir"
    logs=$(jq -n '[]')
    render_page "$logs" false > "$dir/empty.json"
    write_response "$dir" 0 200 "$dir/empty.json"

    output=$(run_render_logs "$dir" srv-fake --level "$lvl" --lines 10)
    ok=$(echo "$output" | jq -r 'if has("ok") then (.ok|tostring) else "MISSING" end' 2>/dev/null)

    url_line=$(grep '^https://api.render.com/v1/logs' "$dir/calls.log" 2>/dev/null | head -1)
    decoded=$(python3 -c "import urllib.parse,sys; print(urllib.parse.unquote(sys.argv[1]))" "$url_line" 2>/dev/null)

    if [[ "$ok" == "true" ]] && echo "$decoded" | grep -q "level=$lvl"; then
        pass "--level '$lvl': accepted, sent as-is in the query params"
    else
        fail "--level '$lvl': expected ok=true and 'level=$lvl' in query, got ok=$ok decoded_url='$decoded'"
    fi
    rm -rf "$dir"
done
echo ""

# --------------------------------------------------------------------------
# 9. --direction / --lines validation
# --------------------------------------------------------------------------
echo "--- --direction / --lines validation ---"
{
    dir=$(mktemp -d)
    setup_env "$dir"
    output=$(run_render_logs "$dir" srv-fake --direction sideways --lines 10)
    code=$(echo "$output" | jq -r '.error.code // "MISSING"' 2>/dev/null)
    [[ "$code" == "INVALID_ARG" ]] && pass "--direction sideways: rejected as INVALID_ARG" \
        || fail "--direction sideways: expected INVALID_ARG, got $code. Output: $output"
    rm -rf "$dir"
}
{
    dir=$(mktemp -d)
    setup_env "$dir"
    output=$(run_render_logs "$dir" srv-fake --lines abc)
    code=$(echo "$output" | jq -r '.error.code // "MISSING"' 2>/dev/null)
    [[ "$code" == "INVALID_ARG" ]] && pass "--lines abc: rejected as INVALID_ARG" \
        || fail "--lines abc: expected INVALID_ARG, got $code. Output: $output"
    rm -rf "$dir"
}
echo ""

# --------------------------------------------------------------------------
# 10. --since returns the NEWEST matching lines, not the oldest
# --------------------------------------------------------------------------
echo "--- --since defaults to newest-first ---"
{
    dir=$(mktemp -d)
    setup_env "$dir"

    # A backward-direction page from Render is newest-first. 5 matches,
    # --lines 3 should keep the 3 newest (the head of this list), not the
    # 3 oldest (the tail) — the old default (direction=forward) would
    # have returned the oldest matches after the cutoff instead.
    logs=$(jq -n '[
        {id: "newest",  timestamp: "2026-09-04T10:00:05Z", message: "m5", labels: [{name:"level",value:"error"}]},
        {id: "n2",       timestamp: "2026-09-04T10:00:04Z", message: "m4", labels: [{name:"level",value:"error"}]},
        {id: "n3",       timestamp: "2026-09-04T10:00:03Z", message: "m3", labels: [{name:"level",value:"error"}]},
        {id: "n4",       timestamp: "2026-09-04T10:00:02Z", message: "m2", labels: [{name:"level",value:"error"}]},
        {id: "oldest",   timestamp: "2026-09-04T10:00:01Z", message: "m1", labels: [{name:"level",value:"error"}]}
    ]')
    render_page "$logs" false > "$dir/since.json"
    write_response "$dir" 0 200 "$dir/since.json"

    output=$(run_render_logs "$dir" srv-fake --since 1h --lines 3)
    ids=$(echo "$output" | jq -r '.result.items[].id' 2>/dev/null | paste -sd, -)

    if [[ "$ids" == "newest,n2,n3" ]]; then
        pass "--since 1h --lines 3: kept the 3 newest entries ($ids)"
    else
        fail "--since 1h --lines 3: expected newest,n2,n3, got '$ids'"
    fi

    url_line=$(grep '^https://api.render.com/v1/logs' "$dir/calls.log" 2>/dev/null | head -1)
    if echo "$url_line" | grep -q 'direction=backward'; then
        pass "--since 1h: used direction=backward (newest-first) by default"
    else
        fail "--since 1h: expected direction=backward in query, got: $url_line"
    fi
    rm -rf "$dir"
}
echo ""

# --------------------------------------------------------------------------
# 11. Labels survive into output; --stats reflects real statusCode/method/path
# --------------------------------------------------------------------------
echo "--- Labels survive into output and stats ---"
{
    dir=$(mktemp -d)
    setup_env "$dir"

    logs=$(jq -n '[
        {id: "l1", timestamp: "2026-09-04T10:00:00Z", message: "POST /api/generate 500",
         labels: [{name:"level",value:"error"},{name:"type",value:"request"},
                  {name:"statusCode",value:"500"},{name:"method",value:"POST"},
                  {name:"path",value:"/api/generate"},{name:"host",value:"svc.onrender.com"},
                  {name:"instance",value:"srv-abc123"}]},
        {id: "l2", timestamp: "2026-09-04T10:00:01Z", message: "POST /api/generate 500",
         labels: [{name:"level",value:"error"},{name:"type",value:"request"},
                  {name:"statusCode",value:"500"},{name:"method",value:"POST"},
                  {name:"path",value:"/api/generate"},{name:"host",value:"svc.onrender.com"},
                  {name:"instance",value:"srv-abc123"}]}
    ]')
    render_page "$logs" false > "$dir/labeled.json"
    write_response "$dir" 0 200 "$dir/labeled.json"

    output=$(run_render_logs "$dir" srv-fake --lines 10)
    first=$(echo "$output" | jq -c '.result.items[0]' 2>/dev/null)
    type_v=$(echo "$first" | jq -r '.type')
    status_v=$(echo "$first" | jq -r '.statusCode')
    method_v=$(echo "$first" | jq -r '.method')
    path_v=$(echo "$first" | jq -r '.path')
    host_v=$(echo "$first" | jq -r '.host')
    instance_v=$(echo "$first" | jq -r '.instance')

    if [[ "$type_v" == "request" && "$status_v" == "500" && "$method_v" == "POST" && \
          "$path_v" == "/api/generate" && "$host_v" == "svc.onrender.com" && "$instance_v" == "srv-abc123" ]]; then
        pass "Normal mode: type/statusCode/method/path/host/instance all survive"
    else
        fail "Normal mode: labels dropped. type=$type_v status=$status_v method=$method_v path=$path_v host=$host_v instance=$instance_v"
    fi
}
{
    dir=$(mktemp -d)
    setup_env "$dir"
    logs=$(jq -n '[
        {id: "l1", timestamp: "2026-09-04T10:00:00Z", message: "req 1",
         labels: [{name:"level",value:"error"},{name:"statusCode",value:"500"},
                  {name:"method",value:"POST"},{name:"path",value:"/api/generate"}]},
        {id: "l2", timestamp: "2026-09-04T10:00:01Z", message: "req 2",
         labels: [{name:"level",value:"error"},{name:"statusCode",value:"500"},
                  {name:"method",value:"POST"},{name:"path",value:"/api/generate"}]},
        {id: "l3", timestamp: "2026-09-04T10:00:02Z", message: "req 3",
         labels: [{name:"level",value:"error"},{name:"statusCode",value:"404"},
                  {name:"method",value:"GET"},{name:"path",value:"/api/other"}]}
    ]')
    render_page "$logs" false > "$dir/labeled-stats.json"
    write_response "$dir" 0 200 "$dir/labeled-stats.json"

    output=$(run_render_logs "$dir" srv-fake --stats)
    by_status_500=$(echo "$output" | jq -r '.result.by_status["500"] // "MISSING"' 2>/dev/null)
    by_endpoint=$(echo "$output" | jq -r '.result.by_endpoint["POST /api/generate"] // "MISSING"' 2>/dev/null)

    if [[ "$by_status_500" == "2" && "$by_endpoint" == "2" ]]; then
        pass "--stats: by_status and by_endpoint reflect real labels (500x2, POST /api/generate x2)"
    else
        fail "--stats: expected by_status[500]=2 by_endpoint[POST /api/generate]=2, got $by_status_500 / $by_endpoint. Output: $output"
    fi
    rm -rf "$dir"
}
echo ""

# --------------------------------------------------------------------------
# Summary
# --------------------------------------------------------------------------
echo "============================================"
echo -e "Results: ${GREEN}${PASS} passed${NC}, ${RED}${FAIL} failed${NC}"
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
