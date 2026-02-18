# Common functions for Notion CLI scripts
# Source this file: source "$(dirname "$0")/notion-cc-common.sh"

CONFIG_DIR="$HOME/.config/notion"

# Load credentials: .env override > profile config > global config
load_credentials() {
    # Check .env for direct token override (highest priority)
    if [[ -f ".env" ]]; then
        local env_token=$(grep -E "^NOTION_API_TOKEN=" .env 2>/dev/null | cut -d= -f2- | tr -d '"' | tr -d "'")
        if [[ -n "$env_token" ]]; then
            export NOTION_API_TOKEN="$env_token"
            return 0
        fi
    fi

    # Check .env for NOTION_PROFILE to select profile-specific config
    local profile=""
    if [[ -f ".env" ]]; then
        profile=$(grep -E "^NOTION_PROFILE=" .env 2>/dev/null | cut -d= -f2- | tr -d '"' | tr -d "'")
    fi

    # Use profile config if specified
    if [[ -n "$profile" ]]; then
        local profile_token_file="$CONFIG_DIR/$profile/api_token"
        if [[ -f "$profile_token_file" ]]; then
            export NOTION_API_TOKEN=$(cat "$profile_token_file")
            export NOTION_CURRENT_PROFILE="$profile"
            if [[ -n "$NOTION_API_TOKEN" ]]; then
                return 0
            fi
        else
            return 1
        fi
    fi

    # Fall back to global config (default/personal)
    if [[ -f "$CONFIG_DIR/api_token" ]]; then
        export NOTION_API_TOKEN=$(cat "$CONFIG_DIR/api_token")
        export NOTION_CURRENT_PROFILE="default"
        if [[ -n "$NOTION_API_TOKEN" ]]; then
            return 0
        fi
    fi

    return 1
}

# API helper - calls Notion API
notion_api() {
    local endpoint="$1"
    shift
    local method="${1:-GET}"

    # Always shift if a method was provided
    if [[ -n "$1" ]]; then
        shift
    fi

    curl -sS "https://api.notion.com/v1$endpoint" \
        -H "Authorization: Bearer $NOTION_API_TOKEN" \
        -H "Notion-Version: 2022-06-28" \
        -H "Content-Type: application/json" \
        -X "$method" \
        "$@"
}

# Ensure config directory exists
ensure_config_dir() {
    mkdir -p "$CONFIG_DIR"
}

# Extract page ID from Notion URL
extract_page_id() {
    local url="$1"

    # Handle different Notion URL formats
    # https://www.notion.so/workspace/Page-Title-123abc456def...
    # https://www.notion.so/123abc456def...

    # Extract the ID part (32 hex chars, possibly with dashes)
    local id=$(echo "$url" | grep -oE '[a-f0-9]{32}|[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}' | head -1)

    if [[ -z "$id" ]]; then
        return 1
    fi

    # Convert to UUID format if needed (add dashes)
    if [[ ! "$id" =~ - ]]; then
        id=$(echo "$id" | sed -E 's/(.{8})(.{4})(.{4})(.{4})(.{12})/\1-\2-\3-\4-\5/')
    fi

    echo "$id"
}

# Get page properties
get_page() {
    local page_id="$1"
    notion_api "/pages/$page_id" GET
}

# Update page properties
update_page_property() {
    local page_id="$1"
    local property_name="$2"
    local property_value="$3"
    local property_type="${4:-rich_text}"

    local payload
    case "$property_type" in
        checkbox)
            payload=$(jq -n --arg name "$property_name" --argjson value "$property_value" \
                '{properties: {($name): {checkbox: $value}}}')
            ;;
        status)
            payload=$(jq -n --arg name "$property_name" --arg value "$property_value" \
                '{properties: {($name): {status: {name: $value}}}}')
            ;;
        select)
            payload=$(jq -n --arg name "$property_name" --arg value "$property_value" \
                '{properties: {($name): {select: {name: $value}}}}')
            ;;
        rich_text|*)
            payload=$(jq -n --arg name "$property_name" --arg value "$property_value" \
                '{properties: {($name): {rich_text: [{text: {content: $value}}]}}}')
            ;;
    esac

    notion_api "/pages/$page_id" PATCH -d "$payload"
}

# Get page comments
get_comments() {
    local page_id="$1"
    notion_api "/comments?block_id=$page_id" GET
}

# Add comment to page
add_comment() {
    local page_id="$1"
    local comment_text="$2"

    local payload=$(jq -n --arg page_id "$page_id" --arg text "$comment_text" \
        '{parent: {page_id: $page_id}, rich_text: [{text: {content: $text}}]}')

    notion_api "/comments" POST -d "$payload"
}
