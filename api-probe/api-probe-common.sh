#!/bin/bash
# api-probe-common.sh - Shared constants and helpers for API discovery
#
# Source this file in api-probe:
#   source "$(dirname "$0")/api-probe-common.sh"

# Well-known spec paths to check first
SPEC_PATHS=(
  "/.well-known/openapi.json"
  "/.well-known/openapi.yaml"
  "/openapi.json"
  "/openapi.yaml"
  "/openapi/v3/api-docs"
  "/swagger.json"
  "/swagger.yaml"
  "/swagger/v1/swagger.json"
  "/api-docs"
  "/api-docs.json"
  "/docs/api"
  "/api/docs"
  "/api/swagger"
  "/api/v1/swagger.json"
)

# Common API base paths (including root — many APIs serve directly off /)
BASE_PATHS=(
  ""
  "/api"
  "/api/v1"
  "/api/v2"
  "/api/v3"
  "/v1"
  "/v2"
  "/rest"
)

# Common resource names to probe
RESOURCE_NAMES=(
  "users" "accounts" "customers" "orders" "products"
  "items" "messages" "notifications" "events" "projects"
  "tasks" "comments" "posts" "files" "uploads"
  "settings" "config" "health" "status" "me"
  "services" "owners" "teams" "organizations" "repos"
  "deployments" "environments" "jobs" "pipelines" "webhooks"
  "domains" "certificates" "secrets" "keys" "tokens"
  "invoices" "subscriptions" "plans" "blueprints" "templates"
)

# GraphQL introspection query
GRAPHQL_QUERY='{"query":"{ __schema { queryType { name } mutationType { name } types { name kind fields { name type { name kind ofType { name kind } } args { name type { name kind } } } } } }"}'

# Auth headers array, populated by parse_auth_flags
AUTH_CURL_ARGS=()

# Display/filter flags, populated by parse_display_flags
DISPLAY_LIMIT=50
DISPLAY_OFFSET=0
DISPLAY_TAG=""
DISPLAY_FILTER=""
DISPLAY_COMPACT=false
DISPLAY_QUERIES_ONLY=false
DISPLAY_TYPES_ONLY=false
DISPLAY_MUTATIONS_ONLY=false

# parse_auth_flags <args...>
# Extracts --token, --api-key, --header from args.
# Sets AUTH_CURL_ARGS in the current shell.
# Remaining (non-auth) args are stored in REMAINING_ARGS.
# IMPORTANT: Call directly, NOT inside $() or <() — globals won't propagate from subshells.
parse_auth_flags() {
  AUTH_CURL_ARGS=()
  REMAINING_ARGS=()
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --token)
        [[ $# -lt 2 ]] && echo "ERROR: --token requires a value" >&2 && return 1
        AUTH_CURL_ARGS+=("-H" "Authorization: Bearer $2")
        shift 2
        ;;
      --api-key)
        [[ $# -lt 2 ]] && echo "ERROR: --api-key requires a value" >&2 && return 1
        AUTH_CURL_ARGS+=("-H" "X-API-Key: $2")
        shift 2
        ;;
      --header)
        [[ $# -lt 2 ]] && echo "ERROR: --header requires a value" >&2 && return 1
        AUTH_CURL_ARGS+=("-H" "$2")
        shift 2
        ;;
      *)
        REMAINING_ARGS+=("$1")
        shift
        ;;
    esac
  done
}

# parse_display_flags <args...>
# Extracts display/filter flags from args.
# Sets DISPLAY_* globals. Remaining args stored in REMAINING_ARGS.
parse_display_flags() {
  local new_remaining=()
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --limit)
        [[ $# -lt 2 ]] && echo "ERROR: --limit requires a value" >&2 && return 1
        DISPLAY_LIMIT="$2"; shift 2 ;;
      --offset)
        [[ $# -lt 2 ]] && echo "ERROR: --offset requires a value" >&2 && return 1
        DISPLAY_OFFSET="$2"; shift 2 ;;
      --tag)
        [[ $# -lt 2 ]] && echo "ERROR: --tag requires a value" >&2 && return 1
        DISPLAY_TAG="$2"; shift 2 ;;
      --filter)
        [[ $# -lt 2 ]] && echo "ERROR: --filter requires a value" >&2 && return 1
        DISPLAY_FILTER="$2"; shift 2 ;;
      --compact)        DISPLAY_COMPACT=true; shift ;;
      --queries-only)   DISPLAY_QUERIES_ONLY=true; shift ;;
      --types-only)     DISPLAY_TYPES_ONLY=true; shift ;;
      --mutations-only) DISPLAY_MUTATIONS_ONLY=true; shift ;;
      *)                new_remaining+=("$1"); shift ;;
    esac
  done
  REMAINING_ARGS=("${new_remaining[@]+"${new_remaining[@]}"}")
}

# filter_endpoints <endpoints_json>
# Applies DISPLAY_TAG and DISPLAY_FILTER to an endpoint array.
filter_endpoints() {
  local endpoints="$1"
  if [[ -n "$DISPLAY_TAG" ]]; then
    endpoints=$(echo "$endpoints" | jq --arg tag "$DISPLAY_TAG" \
      '[.[] | select(.tags[]? | ascii_downcase == ($tag | ascii_downcase))]')
  fi
  if [[ -n "$DISPLAY_FILTER" ]]; then
    endpoints=$(echo "$endpoints" | jq --arg pat "$DISPLAY_FILTER" \
      '[.[] | select(.path | test($pat; "i"))]')
  fi
  echo "$endpoints"
}

# paginate_and_summarize <array_json> <item_type>
# Applies DISPLAY_OFFSET and DISPLAY_LIMIT using json_truncate.
# Returns: {items, total, shown, truncated, offset, item_type}
paginate_and_summarize() {
  local array="$1"
  local item_type="$2"
  if [[ "$DISPLAY_OFFSET" -gt 0 ]]; then
    array=$(echo "$array" | jq --argjson off "$DISPLAY_OFFSET" '.[$off:]')
  fi
  local result
  result=$(json_truncate "$array" "$DISPLAY_LIMIT")
  echo "$result" | jq --argjson off "$DISPLAY_OFFSET" --arg type "$item_type" \
    '. + {offset: $off, item_type: $type}'
}

# extract_tag_summary <endpoints_json>
# Returns JSON array of {tag, count} sorted by count desc.
extract_tag_summary() {
  echo "$1" | jq '
    [.[] | .tags[]?] | group_by(.) |
    map({tag: .[0], count: length}) |
    sort_by(-.count)' 2>/dev/null || echo '[]'
}

# compact_endpoints <endpoints_json>
# Strips verbose fields when DISPLAY_COMPACT is true.
compact_endpoints() {
  local endpoints="$1"
  if [[ "$DISPLAY_COMPACT" == "true" ]]; then
    echo "$endpoints" | jq '[.[] | {method, path, summary, tags, source}
      | with_entries(select(.value != null))]'
  else
    echo "$endpoints"
  fi
}

# filter_graphql_items <items_json>
# Applies DISPLAY_FILTER regex to .name field.
filter_graphql_items() {
  local items="$1"
  if [[ -n "$DISPLAY_FILTER" ]]; then
    echo "$items" | jq --arg pat "$DISPLAY_FILTER" \
      '[.[] | select(.name | test($pat; "i"))]'
  else
    echo "$items"
  fi
}

# compact_graphql_result <result_json>
# Strips .fields from types, .args from queries/mutations when DISPLAY_COMPACT is true.
compact_graphql_result() {
  local result="$1"
  if [[ "$DISPLAY_COMPACT" == "true" ]]; then
    echo "$result" | jq '
      .types = [.types[] | {name, kind}] |
      .queries = [.queries[] | {name, return_type}] |
      .mutations = [.mutations[] | {name, return_type}]'
  else
    echo "$result"
  fi
}

# normalize_url <url>
# Strips trailing slashes, ensures https:// scheme.
normalize_url() {
  local url="$1"
  # Add scheme if missing
  if [[ ! "$url" =~ ^https?:// ]]; then
    url="https://$url"
  fi
  # Strip trailing slashes
  url="${url%/}"
  echo "$url"
}

# probe_url <method> <url>
# Safe HTTP probe. Only allows GET, HEAD, OPTIONS.
# Writes response body to a temp file.
# After calling, read results from:
#   PROBE_HTTP_CODE  - HTTP status code (or "000" on network failure)
#   PROBE_HEADERS    - path to temp file with response headers
#   PROBE_BODY       - path to temp file with response body
# Caller must NOT use $() to capture output — globals won't propagate.
# Returns 0 on any HTTP response, 1 on network failure.
PROBE_HTTP_CODE=""
PROBE_HEADERS=""
PROBE_BODY=""

# Shared temp files (reused across calls to avoid mktemp overhead)
_PROBE_TMPBODY=$(mktemp)
_PROBE_TMPHEADERS=$(mktemp)
trap 'rm -f "$_PROBE_TMPBODY" "$_PROBE_TMPHEADERS"' EXIT

probe_url() {
  local method="$1"
  local url="$2"

  # Enforce safe methods
  case "$method" in
    GET|HEAD|OPTIONS) ;;
    *)
      echo "BLOCKED: probe_url only allows GET/HEAD/OPTIONS, got $method" >&2
      return 1
      ;;
  esac

  PROBE_BODY="$_PROBE_TMPBODY"
  PROBE_HEADERS="$_PROBE_TMPHEADERS"

  local http_code
  http_code=$(curl -sS -X "$method" \
    --max-time 10 \
    -w '%{http_code}' \
    -o "$_PROBE_TMPBODY" \
    -D "$_PROBE_TMPHEADERS" \
    ${AUTH_CURL_ARGS[@]+"${AUTH_CURL_ARGS[@]}"} \
    "$url" 2>/dev/null) || {
    PROBE_HTTP_CODE="000"
    return 1
  }

  PROBE_HTTP_CODE="$http_code"
  return 0
}

# graphql_post <url> <query_json>
# Exception: POST for GraphQL introspection (read-only).
# Returns response body on stdout, sets PROBE_HTTP_CODE.
graphql_post() {
  local url="$1"
  local query="$2"

  local tmpbody
  tmpbody=$(mktemp)

  local http_code
  http_code=$(curl -sS -X POST \
    --max-time 15 \
    -w '%{http_code}' \
    -o "$tmpbody" \
    -H "Content-Type: application/json" \
    ${AUTH_CURL_ARGS[@]+"${AUTH_CURL_ARGS[@]}"} \
    -d "$query" \
    "$url" 2>/dev/null) || {
    rm -f "$tmpbody"
    PROBE_HTTP_CODE="000"
    return 1
  }

  PROBE_HTTP_CODE="$http_code"
  cat "$tmpbody"
  rm -f "$tmpbody"
  return 0
}

# detect_pagination <response_body>
# Analyzes JSON response for pagination patterns.
# Returns JSON: {style, details}
detect_pagination() {
  local body="$1"
  echo "$body" | jq -r '
    # Top-level cursor fields (Stripe, etc.)
    if .has_more != null or .next_cursor != null or .starting_after != null then
      {style: "cursor", details: {
        has_more_field: (if .has_more != null then "has_more" else null end),
        cursor_field: (if .next_cursor != null then "next_cursor"
                       elif .starting_after != null then "starting_after"
                       elif .cursor != null then "cursor"
                       else null end)
      }}
    # Offset-based
    elif .total != null and (.offset != null or .limit != null) then
      {style: "offset", details: {
        total_field: "total",
        offset_field: (if .offset != null then "offset" else null end),
        limit_field: (if .limit != null then "limit" else null end)
      }}
    # Page-based
    elif .page != null and (.total_pages != null or .pages != null) then
      {style: "page", details: {
        page_field: "page",
        total_pages_field: (if .total_pages != null then "total_pages" elif .pages != null then "pages" else null end)
      }}
    # Next URL field
    elif .next_page_url != null or .next != null then
      {style: "cursor", details: {
        next_url_field: (if .next_page_url != null then "next_page_url" elif .next != null then "next" else null end)
      }}
    # Per-item cursor (Render style: array of {cursor, <resource>} objects)
    elif type == "array" and length > 0 and (.[0].cursor // null) != null then
      {style: "cursor", details: {
        cursor_location: "per-item",
        cursor_field: "cursor"
      }}
    else
      {style: "unknown", details: {}}
    end
  ' 2>/dev/null || echo '{"style":"unknown","details":{}}'
}

# detect_pagination_from_headers <headers>
# Check Link header for pagination.
detect_pagination_from_headers() {
  local headers="$1"
  if echo "$headers" | grep -qi '^link:.*rel="next"'; then
    echo '{"style":"link-header","details":{"header":"Link"}}'
  else
    echo 'null'
  fi
}

# detect_rate_limits <headers>
# Parses rate limit headers. Handles both x-ratelimit-* and ratelimit-* (IETF draft).
detect_rate_limits() {
  local headers="$1"
  local limit remaining reset retry_after

  # Try x-ratelimit-* first, then ratelimit-* (IETF draft, used by Render etc.)
  limit=$(echo "$headers" | grep -i '^\(x-\)\{0,1\}ratelimit-limit:' | head -1 | awk '{print $2}' | tr -d '\r')
  remaining=$(echo "$headers" | grep -i '^\(x-\)\{0,1\}ratelimit-remaining:' | head -1 | awk '{print $2}' | tr -d '\r')
  reset=$(echo "$headers" | grep -i '^\(x-\)\{0,1\}ratelimit-reset:' | head -1 | awk '{print $2}' | tr -d '\r')
  retry_after=$(echo "$headers" | grep -i '^retry-after:' | head -1 | awk '{print $2}' | tr -d '\r')

  if [[ -n "$limit" || -n "$remaining" || -n "$reset" || -n "$retry_after" ]]; then
    jq -n \
      --arg limit "${limit:-}" \
      --arg remaining "${remaining:-}" \
      --arg reset "${reset:-}" \
      --arg retry "${retry_after:-}" \
      '{
        detected: true,
        limit: (if $limit != "" then ($limit | tonumber) else null end),
        remaining: (if $remaining != "" then ($remaining | tonumber) else null end),
        reset: (if $reset != "" then ($reset | tonumber) else null end),
        retry_after: (if $retry != "" then ($retry | tonumber) else null end)
      }'
  else
    echo '{"detected":false}'
  fi
}

# detect_auth_scheme <headers>
# Parses WWW-Authenticate header. Returns JSON.
detect_auth_scheme() {
  local headers="$1"
  local www_auth
  www_auth=$(echo "$headers" | grep -i '^www-authenticate:' | head -1 | sed 's/^[^:]*: *//' | tr -d '\r')

  if [[ -n "$www_auth" ]]; then
    local scheme
    scheme=$(echo "$www_auth" | awk '{print tolower($1)}')
    jq -n --arg scheme "$scheme" --arg raw "$www_auth" \
      '{scheme: $scheme, www_authenticate: $raw}'
  else
    echo '{"scheme":null,"www_authenticate":null}'
  fi
}

# is_json <string>
# Returns 0 if the string is valid JSON, 1 otherwise.
is_json() {
  echo "$1" | jq empty 2>/dev/null
}

# extract_sample_fields <json_body>
# Extracts top-level field names from a JSON response.
# Handles both object responses and array-of-objects.
extract_sample_fields() {
  local body="$1"
  echo "$body" | jq -r '
    if type == "array" then
      (.[0] // {}) | keys | .[:10]
    elif type == "object" then
      # Check common data wrapper fields
      if .data then
        if (.data | type) == "array" then (.data[0] // {}) | keys | .[:10]
        else .data | keys | .[:10]
        end
      elif .results then
        if (.results | type) == "array" then (.results[0] // {}) | keys | .[:10]
        else keys | .[:10]
        end
      elif .items then
        if (.items | type) == "array" then (.items[0] // {}) | keys | .[:10]
        else keys | .[:10]
        end
      else
        keys | .[:10]
      end
    else
      []
    end
  ' 2>/dev/null || echo '[]'
}

# parse_openapi_spec <spec_body>
# Extracts endpoints from an OpenAPI/Swagger JSON spec.
# Returns JSON array of {method, path, summary, tags}.
parse_openapi_spec() {
  local body="$1"
  echo "$body" | jq '
    [.paths | to_entries[] | .key as $path |
     .value | to_entries[] |
     select(.key | test("get|post|put|patch|delete|options|head")) |
     {
       method: (.key | ascii_upcase),
       path: $path,
       summary: (.value.summary // .value.description // ""),
       tags: (.value.tags // [])
     }
    ]
  ' 2>/dev/null || echo '[]'
}
