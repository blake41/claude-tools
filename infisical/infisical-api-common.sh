# Common functions for Infisical CLI scripts
# Source this file: source "$(dirname "$0")/infisical-api-common.sh"

CONFIG_DIR="$HOME/.config/infisical"

# Load credentials: .env override > global config
load_credentials() {
    # Check .env in current directory first (override)
    if [[ -f ".env" ]]; then
        local env_id=$(grep -E "^INFISICAL_CLIENT_ID=" .env 2>/dev/null | cut -d= -f2- | tr -d '"' | tr -d "'")
        local env_secret=$(grep -E "^INFISICAL_CLIENT_SECRET=" .env 2>/dev/null | cut -d= -f2- | tr -d '"' | tr -d "'")
        if [[ -n "$env_id" && -n "$env_secret" ]]; then
            export INFISICAL_CLIENT_ID="$env_id"
            export INFISICAL_CLIENT_SECRET="$env_secret"
            return 0
        fi
    fi

    # Fall back to global config
    if [[ -f "$CONFIG_DIR/credentials" ]]; then
        source "$CONFIG_DIR/credentials"
        if [[ -n "$INFISICAL_CLIENT_ID" && -n "$INFISICAL_CLIENT_SECRET" ]]; then
            return 0
        fi
    fi

    return 1
}

# Load API host (defaults to Infisical Cloud US)
load_api_host() {
    # Check .env first
    if [[ -f ".env" ]]; then
        local env_host=$(grep -E "^INFISICAL_API_HOST=" .env 2>/dev/null | cut -d= -f2- | tr -d '"' | tr -d "'")
        if [[ -n "$env_host" ]]; then
            echo "$env_host"
            return 0
        fi
    fi

    # Check global config
    if [[ -f "$CONFIG_DIR/api_host" ]]; then
        cat "$CONFIG_DIR/api_host"
        return 0
    fi

    # Default to US cloud
    echo "https://us.infisical.com"
}

# Get access token via Universal Auth
# Caches token in /tmp for 5 minutes
get_access_token() {
    local api_host
    api_host=$(load_api_host)
    local cache_file="/tmp/infisical_token_$(echo "$INFISICAL_CLIENT_ID" | md5sum | cut -d' ' -f1)"

    # Check cache (tokens valid for ~5 min)
    if [[ -f "$cache_file" ]]; then
        local cache_age=$(($(date +%s) - $(stat -f%m "$cache_file" 2>/dev/null || stat -c%Y "$cache_file" 2>/dev/null)))
        if [[ $cache_age -lt 240 ]]; then
            cat "$cache_file"
            return 0
        fi
    fi

    # Fetch new token
    local response
    response=$(curl -sS "$api_host/api/v1/auth/universal-auth/login" \
        -H "Content-Type: application/json" \
        -d "{\"clientId\": \"$INFISICAL_CLIENT_ID\", \"clientSecret\": \"$INFISICAL_CLIENT_SECRET\"}" 2>&1)

    local token
    token=$(echo "$response" | jq -r '.accessToken // empty')

    if [[ -z "$token" ]]; then
        return 1
    fi

    echo "$token" > "$cache_file"
    chmod 600 "$cache_file"
    echo "$token"
}

# API helper - handles authentication automatically
infisical_api() {
    local endpoint="$1"
    shift

    local api_host
    api_host=$(load_api_host)

    local token
    token=$(get_access_token) || return 1

    curl -sS "$api_host/api$endpoint" \
        -H "Authorization: Bearer $token" \
        -H "Accept: application/json" \
        -H "Content-Type: application/json" \
        "$@"
}

# Ensure config directory exists
ensure_config_dir() {
    mkdir -p "$CONFIG_DIR"
}

# ============================================================================
# GUARDRAILS (project/env validation). Added so a wrong slug or empty -p fails
# with a JSON envelope naming the valid choices, never a raw jq error.
# Uses json_error from cli-envelope.sh (sourced by the main script).
# Bash 3.2 compatible (macOS /bin/bash): no namerefs, no associative arrays.
# ============================================================================

# Set by resolve_env when it maps an alias; json_ok (in infisical-api) copies
# it into the envelope as `note`.
ENV_NOTE=""

# Sets CMD_LABEL from the cmd_* function two frames up, e.g. cmd_secrets_batch_update
# -> "infisical-api secrets batch-update".
_set_cmd_label() {
    local f="${FUNCNAME[2]:-}" first rest
    f="${f#cmd_}"
    first="${f%%_*}"
    rest="${f#*_}"
    if [[ "$rest" == "$f" ]]; then
        CMD_LABEL="$TOOL_NAME $f"
    else
        CMD_LABEL="$TOOL_NAME $first ${rest//_/-}"
    fi
}

# require_project: call with the (possibly empty) project id from -p or a
# positional. Exits with MISSING_PROJECT when empty.
require_project() {
    [[ -n "${1:-}" ]] && return 0
    _set_cmd_label
    json_error "$CMD_LABEL" "Project ID is missing or empty (-p <project-id>)" "MISSING_PROJECT" \
        "Pass -p <project-id>. List ids with: infisical-api projects list"
}

# api_body_error <label> <body> <code> <fix>
# Exit with an envelope if an API body is not a JSON object or is an error
# object ({statusCode, message}). Keeps callers' jq filters from crashing.
api_body_error() {
    local label="$1" body="$2" code="$3" fix="$4"
    if ! printf '%s' "$body" | jq -e 'type == "object"' >/dev/null 2>&1; then
        json_error "$label" "Infisical returned a non-JSON response" "API_ERROR" "$fix"
    fi
    if printf '%s' "$body" | jq -e 'has("statusCode")' >/dev/null 2>&1; then
        local msg status
        msg=$(printf '%s' "$body" | jq -r '.message // .error // "request failed"')
        status=$(printf '%s' "$body" | jq -r '.statusCode')
        [[ "$status" == "404" ]] || code="API_ERROR"
        json_error "$label" "HTTP $status: $msg" "$code" "$fix"
    fi
}

# fetch_project_envs <label> <project_id>
# Sets PROJECT_NAME and PROJECT_ENV_SLUGS (newline-separated) from
# GET /v1/workspace/<id> (authoritative per-project environment list).
fetch_project_envs() {
    local label="$1" pid="$2" ws msg
    ws=$(infisical_api "/v1/workspace/$pid") || \
        json_error "$label" "Could not authenticate or reach Infisical to look up project environments" "AUTH_FAILED" "Check credentials and network"
    if ! printf '%s' "$ws" | jq -e '.workspace.id' >/dev/null 2>&1; then
        msg=$(printf '%s' "$ws" | jq -r '.message? // empty' 2>/dev/null || true)
        json_error "$label" "${msg:-Project lookup failed}" "PROJECT_NOT_FOUND" \
            "Run 'infisical-api projects list' for valid project ids"
    fi
    PROJECT_NAME=$(printf '%s' "$ws" | jq -r '.workspace.name')
    PROJECT_ENV_SLUGS=$(printf '%s' "$ws" | jq -r '.workspace.environments[]?.slug')
}

# match_env <wanted> <newline-separated slugs>
# Prints the project's real slug for <wanted>: exact match first, then
# case-insensitive, then the dev/development and prod/production aliases.
# Returns 1 when nothing matches.
match_env() {
    local want="$1" slugs="$2" lc s c cands
    while IFS= read -r s; do
        [[ -n "$s" && "$s" == "$want" ]] && { printf '%s\n' "$s"; return 0; }
    done <<< "$slugs"
    lc=$(printf '%s' "$want" | tr '[:upper:]' '[:lower:]')
    case "$lc" in
        dev|development) cands="$lc dev development" ;;
        prod|production) cands="$lc prod production" ;;
        *) cands="$lc" ;;
    esac
    for c in $cands; do
        while IFS= read -r s; do
            [[ -n "$s" && "$s" == "$c" ]] && { printf '%s\n' "$s"; return 0; }
        done <<< "$slugs"
    done
    return 1
}

# resolve_env <project_id> <env>
# Validates <env> against the project's real environments. On success sets
# RESOLVED_ENV (the real slug) and, if it differed from the input, ENV_NOTE.
# On failure exits with INVALID_ENV listing the valid slugs.
resolve_env() {
    local pid="$1" want="$2" real slugs_csv
    _set_cmd_label
    load_credentials || json_error "$CMD_LABEL" "Infisical credentials not found" "AUTH_MISSING" \
        "Set credentials in .env or ~/.config/infisical/credentials"
    if [[ -z "$want" ]]; then
        json_error "$CMD_LABEL" "Environment (-e) is empty" "MISSING_ENV" "Pass -e <slug>. List slugs with: infisical-api environments list $pid"
    fi
    fetch_project_envs "$CMD_LABEL" "$pid"
    slugs_csv=$(printf '%s' "$PROJECT_ENV_SLUGS" | paste -sd, - | sed 's/,/, /g')
    if [[ -z "$slugs_csv" ]]; then
        json_error "$CMD_LABEL" "Project '$PROJECT_NAME' ($pid) has no environments" "INVALID_ENV" \
            "Pick a project with environments: infisical-api projects list"
    fi
    if real=$(match_env "$want" "$PROJECT_ENV_SLUGS"); then
        RESOLVED_ENV="$real"
        if [[ "$real" != "$want" ]]; then
            ENV_NOTE="Mapped -e '$want' to this project's slug '$real' (project '$PROJECT_NAME'). Valid slugs: $slugs_csv."
        fi
        return 0
    fi
    json_error "$CMD_LABEL" "Unknown environment '$want' for project '$PROJECT_NAME' ($pid). Valid slugs: $slugs_csv" "INVALID_ENV" \
        "Re-run with -e one of: $slugs_csv (dev/development and prod/production aliases are mapped automatically)"
}
