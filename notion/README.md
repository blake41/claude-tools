# Notion CLI (`notion-cc`)

Minimal CLI for interacting with Notion task boards and pages via the Notion API.

## Quick Reference

Use this tool for:
- Updating task status properties
- Setting blocked checkboxes
- Moving tasks between statuses
- Adding comments
- **Waiting for user responses** (blocking until comment appears)

## Setup

1. Create a Notion integration at https://www.notion.so/my-integrations
2. Copy your Internal Integration Token
3. Run setup:

```bash
notion-cc setup
```

Or manually save token to `~/.config/notion/api_token`

**Important**: You must share your Notion database/pages with your integration:
1. Open the database in Notion
2. Click "..." menu → "Add connections"
3. Select your integration

## Configuration

| Location | Purpose |
|----------|---------|
| `~/.config/notion/api_token` | Global API token |
| `.env` with `NOTION_API_TOKEN` | Project-specific override |

## Commands

### Page Commands

```bash
# Get page details (properties, metadata)
notion-cc get <page-url>

# Update "current status" text property
notion-cc update-status <page-url> "Working on database queries"
notion-cc update-status <page-url> "Debugging tests" "custom status"

# Set blocked checkbox
notion-cc set-blocked <page-url>              # Set to true
notion-cc set-blocked <page-url> false        # Set to false
notion-cc set-blocked <page-url> true "custom blocked"  # Custom property name

# Move task to different status
notion-cc move <page-url> "Done"
notion-cc move <page-url> "In Progress"
notion-cc move <page-url> "Blocked" "CustomStatus"
```

### Comment Commands

```bash
# List all comments on a page
notion-cc comments <page-url>

# Add a comment
notion-cc comment <page-url> "Need clarification on requirements"

# Wait for new comment (BLOCKING)
notion-cc wait-for-comment <page-url>         # Default: 5s poll, 300s timeout
notion-cc wait-for-comment <page-url> 10      # 10s poll interval
notion-cc wait-for-comment <page-url> 5 600   # 5s poll, 10min timeout
```

**`wait-for-comment` use case**: After asking the user a question, call this to block until they respond. When a new comment appears, it prints the comment text and exits.

### Property Commands

```bash
# Update any property (flexible command)
notion-cc update-property <page-url> "Priority" "High" select
notion-cc update-property <page-url> "Notes" "Some notes" rich_text
notion-cc update-property <page-url> "Done" true checkbox
```

Property types: `rich_text`, `checkbox`, `status`, `select`

## Typical Agent Workflow

As described in your post:

```bash
# 1. Agent works on a task
TASK_URL="https://www.notion.so/workspace/Task-123abc..."

# 2. Periodically update status
notion-cc update-status "$TASK_URL" "Analyzing codebase structure"
notion-cc update-status "$TASK_URL" "Writing implementation"

# 3. If blocked, set flag and ask in comments
notion-cc set-blocked "$TASK_URL" true
notion-cc comment "$TASK_URL" "Should I use approach A or B? Please clarify in comments."

# 4. Wait for user response (BLOCKS here)
notion-cc wait-for-comment "$TASK_URL"

# 5. Unblock and continue
notion-cc set-blocked "$TASK_URL" false
notion-cc update-status "$TASK_URL" "Implementing with approach A"

# 6. When done, move to Done
notion-cc move "$TASK_URL" "Done"
```

## URL Formats

Supports both Notion URL formats:
- `https://www.notion.so/workspace/Page-Title-123abc456def...`
- `https://www.notion.so/123abc456def...`

The tool automatically extracts the page ID.

## Notes

- **Polling**: `wait-for-comment` uses polling (not webhooks) for simplicity
- **Authentication**: Uses Notion Integration tokens (not OAuth)
- **Read/Write**: All commands require the integration to have write access to the page
- **Property Names**: Case-sensitive, must match exactly as they appear in Notion

## Examples

```bash
# Setup task board tracking
TASK="https://www.notion.so/..."
notion-cc update-status "$TASK" "Starting work"

# Work simulation
sleep 10
notion-cc update-status "$TASK" "50% complete"

# Need input
notion-cc set-blocked "$TASK" true
notion-cc comment "$TASK" "Which API version should I target?"
echo "Waiting for user response..."
notion-cc wait-for-comment "$TASK"

# Continue work
notion-cc set-blocked "$TASK" false
notion-cc update-status "$TASK" "Finishing up"

# Complete
notion-cc move "$TASK" "Done"
```
