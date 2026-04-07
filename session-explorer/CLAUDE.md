# Session Explorer

## Running

Production is managed by launchd (`com.blake.session-explorer`). The plist is at `~/Library/LaunchAgents/com.blake.session-explorer.plist`.

- **Restart**: `bun run restart` (kicks the launchd service)
- **Dev mode**: `bun run dev` (concurrent server with `--watch` + Vite on :5199)
- **Build**: `bun run build`

Auto-ingest runs every 30s, re-ingesting sessions whose JSONL file size changed on disk.

## Stack

Express + React + SQLite (better-sqlite3) + Tailwind CSS 4.2 + Vite. Config in `server/config.ts`.

## Key Concepts

- **Subagent messages**: Ingested with `message_type = 'subagent_prompt'` (not `'text'`). All queries filtering on `message_type = 'text'` automatically exclude them. Don't add `source = 'parent'` filters — the data layer handles it.
- **Sequence vs timestamp**: Sequence numbers can be non-chronological due to Claude Code's rewind/replay feature. Always sort by `timestamp`, not `sequence`, when chronological order matters.
