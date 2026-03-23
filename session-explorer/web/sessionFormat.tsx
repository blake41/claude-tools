/**
 * Session text formatting utilities.
 *
 * Provides inline markdown rendering and search-term highlighting
 * for Claude session content displayed throughout the app.
 * Inspired by gist.github.com's code rendering style.
 */
import React from "react";

// ── Escape HTML ──────────────────────────────────────────────────
function esc(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// ── Full markdown → HTML (for message bodies) ───────────────────
export function renderMarkdown(text: string): string {
  let html = esc(text);

  // Code blocks (``` ... ```)
  html = html.replace(/```(\w*)\n([\s\S]*?)```/g, (_m, lang, code) => {
    const langLabel = lang ? `<span class="code-lang">${lang}</span>` : "";
    return `<div class="code-block">${langLabel}<pre><code>${code.trimEnd()}</code></pre></div>`;
  });

  // Inline code
  html = html.replace(/`([^`\n]+)`/g, '<code class="inline-code">$1</code>');

  // Headers
  html = html.replace(/^#### (.+)$/gm, "<h4>$1</h4>");
  html = html.replace(/^### (.+)$/gm, "<h3>$1</h3>");
  html = html.replace(/^## (.+)$/gm, "<h2>$1</h2>");
  html = html.replace(/^# (.+)$/gm, "<h1>$1</h1>");

  // Bold and italic
  html = html.replace(/\*\*\*(.+?)\*\*\*/g, "<strong><em>$1</em></strong>");
  html = html.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  html = html.replace(/\*(.+?)\*/g, "<em>$1</em>");

  // Lists — both ordered (1. ) and unordered (- *) rendered as <ul> to match terminal
  html = html.replace(/^\s*(?:[-*]|\d+\.)\s+(.+)$/gm, "<li>$1</li>");
  html = html.replace(/((?:\s*<li>.*<\/li>\s*)+)/g, "<ul>$1</ul>");

  // Horizontal rules
  html = html.replace(/^---+$/gm, "<hr />");

  // Links
  html = html.replace(
    /\[([^\]]+)\]\(([^)]+)\)/g,
    '<a href="$2" target="_blank" rel="noopener">$1</a>'
  );

  // Paragraphs
  html = html.replace(/\n\n/g, "</p><p>");
  html = html.replace(/\n/g, "<br />");

  return html;
}

// ── Inline format (for snippets, previews, context lines) ───────
// Renders inline markdown (bold, code, italic) as HTML string.
// No block elements — suitable for single-line or short text.
export function formatInline(text: string): string {
  let html = esc(text);

  // Strip ANSI escape codes
  html = html.replace(/\x1b\[[\d;]*m/g, "");
  html = html.replace(/\[[\d;]*m/g, "");

  // Inline code: `foo` → <code>foo</code>
  html = html.replace(
    /`([^`\n]+)`/g,
    '<code class="sf-code">$1</code>'
  );

  // Bold: **foo** → <strong>foo</strong>
  html = html.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");

  // Italic: *foo* → <em>foo</em>
  html = html.replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, "<em>$1</em>");

  // Markdown header markers at start → bold (collapse for inline)
  html = html.replace(/^#{1,4}\s+/, "");

  // File paths: /foo/bar/baz.ts → monospace styled
  html = html.replace(
    /(?<=\s|^)(\/[\w./-]+\.\w{1,6})(?=[\s,;:]|$)/g,
    '<code class="sf-path">$1</code>'
  );

  // Markdown table pipes — dim them
  html = html.replace(/\|/g, '<span class="sf-pipe">|</span>');

  return html;
}

// ── Search-term highlighting ────────────────────────────────────
// Takes plain text and a search query, returns HTML with <mark> tags.
// Handles FTS5 ‹mark›/‹/mark› AND client-side term matching.
export function highlightSearch(text: string, query?: string): string {
  let html = text;

  // First: handle FTS5-style ‹mark›/‹/mark› markers
  // Temporarily replace them with placeholders before escaping
  const FTS_OPEN = "\x00MARK_OPEN\x00";
  const FTS_CLOSE = "\x00MARK_CLOSE\x00";
  html = html.replace(/‹mark›/g, FTS_OPEN).replace(/‹\/mark›/g, FTS_CLOSE);

  // Apply inline formatting (which also escapes HTML)
  html = formatInline(html);

  // Restore FTS marks
  html = html
    .replace(new RegExp(escapeRegex(esc(FTS_OPEN)), "g"), '<mark class="sf-match">')
    .replace(new RegExp(escapeRegex(esc(FTS_CLOSE)), "g"), "</mark>");

  // Client-side highlighting for text without FTS marks (context, preview)
  if (query && !text.includes("‹mark›")) {
    const terms = query
      .trim()
      .split(/\s+/)
      .filter((t) => t.length >= 2)
      .map(escapeRegex);
    if (terms.length > 0) {
      const pattern = new RegExp(`(${terms.join("|")})`, "gi");
      // Only highlight outside of HTML tags
      html = html.replace(
        /(<[^>]*>)|([^<]+)/g,
        (full, tag, text) => {
          if (tag) return tag;
          return text.replace(pattern, '<mark class="sf-match">$1</mark>');
        }
      );
    }
  }

  return html;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Naive JSON formatter — handles truncated/incomplete JSON by
 *  inserting newlines and indentation at structural characters. */
function naiveJsonFormat(text: string): string {
  let out = "";
  let indent = 0;
  let inString = false;
  const INDENT = "  ";

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    // Track string boundaries
    if (ch === '"' && (i === 0 || text[i - 1] !== "\\")) {
      inString = !inString;
      out += ch;
      continue;
    }
    if (inString) {
      out += ch;
      continue;
    }
    // Structural characters
    if (ch === "{" || ch === "[") {
      indent++;
      out += ch + "\n" + INDENT.repeat(indent);
    } else if (ch === "}" || ch === "]") {
      indent = Math.max(0, indent - 1);
      out += "\n" + INDENT.repeat(indent) + ch;
    } else if (ch === ",") {
      out += ch + "\n" + INDENT.repeat(indent);
    } else if (ch === ":") {
      out += ": ";
    } else if (ch === " " && text[i - 1] === ":") {
      // skip — we already added space after colon
    } else {
      out += ch;
    }
  }
  return out;
}

// ── Tool content formatting ─────────────────────────────────────
// Formats tool output content: detects JSON and pretty-prints it,
// preserves line breaks, applies search highlighting.
export function formatToolContent(text: string, query?: string): string {
  // Strip ANSI codes first
  let cleaned = text
    .replace(/\x1b\[[\d;]*m/g, "")
    .replace(/\[[\d;]*m/g, "");

  // Pretty-print JSON (handles truncated/incomplete JSON too)
  const trimmed = cleaned.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    // Try proper parse first
    try {
      const parsed = JSON.parse(trimmed);
      cleaned = JSON.stringify(parsed, null, 2);
    } catch {
      // Naive formatter for truncated JSON: insert newlines + indent
      cleaned = naiveJsonFormat(trimmed);
    }
  }

  // Escape HTML
  let html = esc(cleaned);

  // Preserve newlines as <br>
  html = html.replace(/\n/g, "<br>");

  // Apply search term highlighting
  if (query) {
    const terms = query
      .trim()
      .split(/\s+/)
      .filter((t) => t.length >= 2)
      .map(escapeRegex);
    if (terms.length > 0) {
      const pattern = new RegExp(`(${terms.join("|")})`, "gi");
      html = html.replace(
        /(<[^>]*>)|([^<]+)/g,
        (full, tag, text) => {
          if (tag) return tag;
          return text.replace(pattern, '<mark class="sf-match">$1</mark>');
        }
      );
    }
  }

  return html;
}

// ── React components ────────────────────────────────────────────

/** Render session text with inline formatting + optional search highlighting */
export function SessionText({
  text,
  query,
  className,
  style,
}: {
  text: string;
  query?: string;
  className?: string;
  style?: React.CSSProperties;
}) {
  const html = highlightSearch(text, query);
  return (
    <span
      className={`session-fmt ${className || ""}`}
      style={style}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

/** Render FTS5 snippet with marks + inline formatting */
export function SnippetText({
  snippet,
  query,
}: {
  snippet: string;
  query?: string;
}) {
  const html = highlightSearch(snippet, query);
  return (
    <span
      className="session-fmt"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
