# Common functions for GitHub CLI scripts
# Source this file: source "$(dirname "$0")/gh-common.sh"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
BLUE='\033[0;34m'
GRAY='\033[0;90m'
NC='\033[0m' # No Color

# Get repo from git remote (owner/repo format)
get_repo() {
    local remote_url
    remote_url=$(git remote get-url origin 2>/dev/null) || {
        echo "Error: Not in a git repository or no origin remote" >&2
        return 1
    }
    
    # Handle SSH format: git@github.com:owner/repo.git
    if [[ "$remote_url" =~ git@github\.com:([^/]+)/(.+)\.git$ ]]; then
        echo "${BASH_REMATCH[1]}/${BASH_REMATCH[2]}"
        return 0
    fi
    
    # Handle SSH format without .git: git@github.com:owner/repo
    if [[ "$remote_url" =~ git@github\.com:([^/]+)/(.+)$ ]]; then
        echo "${BASH_REMATCH[1]}/${BASH_REMATCH[2]}"
        return 0
    fi
    
    # Handle HTTPS format: https://github.com/owner/repo.git
    if [[ "$remote_url" =~ github\.com/([^/]+)/(.+)\.git$ ]]; then
        echo "${BASH_REMATCH[1]}/${BASH_REMATCH[2]}"
        return 0
    fi
    
    # Handle HTTPS format without .git: https://github.com/owner/repo
    if [[ "$remote_url" =~ github\.com/([^/]+)/([^/]+)/?$ ]]; then
        echo "${BASH_REMATCH[1]}/${BASH_REMATCH[2]}"
        return 0
    fi
    
    echo "Error: Could not parse GitHub repo from remote URL: $remote_url" >&2
    return 1
}

# GitHub API wrapper using gh CLI
gh_api() {
    local endpoint="$1"
    shift
    gh api "$endpoint" "$@" 2>/dev/null
}

# Format timestamp to relative time
relative_time() {
    local timestamp="$1"
    local now=$(date +%s)
    local then=$(date -j -f "%Y-%m-%dT%H:%M:%SZ" "$timestamp" +%s 2>/dev/null || date -d "$timestamp" +%s 2>/dev/null)
    local diff=$((now - then))
    
    if [[ $diff -lt 60 ]]; then
        echo "${diff}s ago"
    elif [[ $diff -lt 3600 ]]; then
        echo "$((diff / 60))m ago"
    elif [[ $diff -lt 86400 ]]; then
        echo "$((diff / 3600))h ago"
    else
        echo "$((diff / 86400))d ago"
    fi
}

# Format run status with color
format_status() {
    local status="$1"
    local conclusion="$2"
    
    if [[ "$status" == "in_progress" ]]; then
        echo -e "${YELLOW}●${NC} running"
    elif [[ "$status" == "queued" ]]; then
        echo -e "${GRAY}○${NC} queued"
    elif [[ "$conclusion" == "success" ]]; then
        echo -e "${GREEN}✓${NC} success"
    elif [[ "$conclusion" == "failure" ]]; then
        echo -e "${RED}✗${NC} failure"
    elif [[ "$conclusion" == "cancelled" ]]; then
        echo -e "${GRAY}⊘${NC} cancelled"
    elif [[ "$conclusion" == "skipped" ]]; then
        echo -e "${GRAY}◌${NC} skipped"
    else
        echo -e "${GRAY}?${NC} $status"
    fi
}

# Duration in whole seconds between two ISO8601 timestamps (for aggregation math)
duration_seconds() {
    local start="$1"
    local end="$2"

    if [[ -z "$start" || "$start" == "null" || -z "$end" || "$end" == "null" ]]; then
        echo ""
        return
    fi

    local start_ts=$(date -j -f "%Y-%m-%dT%H:%M:%SZ" "$start" +%s 2>/dev/null || date -d "$start" +%s 2>/dev/null)
    local end_ts=$(date -j -f "%Y-%m-%dT%H:%M:%SZ" "$end" +%s 2>/dev/null || date -d "$end" +%s 2>/dev/null)
    echo $((end_ts - start_ts))
}

# Format duration
format_duration() {
    local start="$1"
    local end="$2"
    
    if [[ -z "$end" || "$end" == "null" ]]; then
        echo "-"
        return
    fi
    
    local start_ts=$(date -j -f "%Y-%m-%dT%H:%M:%SZ" "$start" +%s 2>/dev/null || date -d "$start" +%s 2>/dev/null)
    local end_ts=$(date -j -f "%Y-%m-%dT%H:%M:%SZ" "$end" +%s 2>/dev/null || date -d "$end" +%s 2>/dev/null)
    local diff=$((end_ts - start_ts))
    
    if [[ $diff -lt 60 ]]; then
        echo "${diff}s"
    elif [[ $diff -lt 3600 ]]; then
        echo "$((diff / 60))m $((diff % 60))s"
    else
        echo "$((diff / 3600))h $((diff % 3600 / 60))m"
    fi
}

