// ── Session Title Picking ────────────────────────────────────────────
//
// Pure, DB-free helpers for turning a session's user messages into a title.
// Kept separate from ingest.ts so this logic is unit-testable without
// importing ingest.ts (which opens the real sqlite connection as a side
// effect of importing ./db.js).

/**
 * `<local-command-stdout>` / `<local-command-caveat>` wrap raw shell output
 * captured by Claude Code's local-command feature. It's never a real user
 * turn and frequently carries ANSI escape garbage (e.g. a stray
 * "[1mFable 5[22m") — never usable as a title.
 */
export function isLocalCommandNoise(content: string): boolean {
  return /<local-command-(?:stdout|caveat)>/.test(content);
}

/**
 * A bare slash command with no argument text (e.g. "/model", "/clear") makes a
 * useless title even though it's real "text" content — skip it in favor of the
 * next user turn. A command WITH argument text (e.g. "/ship-lite fix the bug")
 * is still title-worthy.
 */
export function isTitleWorthy(content: string): boolean {
  const trimmed = content.trim();
  return trimmed.length > 0 && !/^\/\S+\s*$/.test(trimmed);
}

// Real ESC-prefixed ANSI SGR codes (e.g. "\x1b[1m").
const ANSI_ESCAPE_RE = /\x1b\[[0-9;]*m/g;
// Bare bracket artifacts left behind when the ESC byte itself was already
// stripped upstream but the "[1m" / "[22m" sequence remains, as seen in
// local-command-stdout captures.
const BARE_ANSI_ARTIFACT_RE = /\[[0-9]{1,3}(?:;[0-9]{1,3})*m/g;

export function stripAnsiCodes(text: string): string {
  return text.replace(ANSI_ESCAPE_RE, "").replace(BARE_ANSI_ARTIFACT_RE, "");
}

/**
 * Pick a session title from its user messages: prefer the first title-worthy
 * real text turn, skipping local-command noise and bare slash commands, and
 * strip any ANSI garbage from whatever we pick.
 */
export function pickTitle(
  userMessages: Array<{ messageType?: string; content: string }>
): string {
  // System-context/caveat boilerplate is already classified messageType "system"
  // by strip.ts, not "text" — restrict to real text turns first, then drop
  // local-command-stdout/caveat noise before picking a candidate.
  const textMessages = userMessages
    .filter((m) => m.messageType === "text")
    .filter((m) => !isLocalCommandNoise(m.content));
  const best = textMessages.find((m) => isTitleWorthy(m.content)) ?? textMessages[0];
  const raw = best?.content.slice(0, 200) || "";
  return stripAnsiCodes(raw).trim();
}
