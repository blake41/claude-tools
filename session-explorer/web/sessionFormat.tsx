/**
 * Session text formatting utilities.
 *
 * Provides inline markdown rendering and search-term highlighting
 * for Claude session content displayed throughout the app.
 * Inspired by gist.github.com's code rendering style.
 */
import React from "react";

// ── Strip harness noise from user message content ───────────────
// Claude Code injects many XML-tagged blocks into user turns that are
// not typed by the user: system reminders, hook outputs, tool caveats,
// diagnostic notices, etc. Strip them before rendering.
const HARNESS_TAG_RE =
  /<(system-reminder|local-command-caveat|task-notification|command-name|command-message|command-args|local-command-stdout|local-command-stderr|bash-input|bash-stdout|bash-stderr|new-diagnostics|ide_opened_file|user-prompt-submit-hook)[^>]*>[\s\S]*?<\/\1>/gi;

// Also strip bare SYSTEM NOTIFICATION blocks (no XML wrapper)
const SYSTEM_NOTIFICATION_RE =
  /\[SYSTEM NOTIFICATION - NOT USER INPUT\][\s\S]*?(?=\n\n|\n?$)/g;

export function cleanUserContent(text: string): string {
  return text
    .replace(HARNESS_TAG_RE, "")
    .replace(SYSTEM_NOTIFICATION_RE, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// ── Escape HTML ──────────────────────────────────────────────────
function esc(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// ── Syntax highlighting ─────────────────────────────────────────
const KW: Record<string, Set<string>> = {};
const TS_KW = new Set(["import","export","from","const","let","var","function","class","interface","type","enum","return","if","else","for","while","do","switch","case","break","continue","try","catch","finally","throw","new","this","super","extends","implements","async","await","public","private","protected","static","readonly","abstract","as","typeof","instanceof","in","of","keyof","void","never","unknown","any","null","undefined","true","false","default","declare"]);
KW["typescript"] = KW["ts"] = KW["tsx"] = KW["javascript"] = KW["js"] = KW["jsx"] = TS_KW;
KW["python"] = KW["py"] = new Set(["def","class","import","from","as","if","elif","else","for","while","try","except","finally","raise","return","yield","with","pass","break","continue","and","or","not","in","is","lambda","global","nonlocal","del","assert","True","False","None","async","await"]);
KW["go"] = new Set(["package","import","func","var","const","type","struct","interface","map","chan","go","select","defer","return","if","else","for","range","switch","case","break","continue","fallthrough","goto","nil","true","false","make","new","append","len","cap","delete","close","panic","recover","print","println"]);
KW["rust"] = new Set(["fn","let","mut","const","static","struct","enum","impl","trait","use","mod","pub","crate","super","self","type","where","match","if","else","loop","while","for","in","return","break","continue","true","false","async","await","move","ref","dyn","Box","Vec","Option","Result","Some","None","Ok","Err"]);

function syntaxHL(raw: string, lang: string): string {
  const keywords = KW[lang] ?? new Set<string>();
  const lines = raw.split("\n");
  return lines.map(line => {
    let out = "";
    let i = 0;
    while (i < line.length) {
      const rest = line.slice(i);

      // line comment
      if (rest.startsWith("//") || (rest.startsWith("#") && (lang === "python" || lang === "py" || lang === "bash" || lang === "sh"))) {
        out += `<span style="color:#71717a;font-style:italic">${esc(rest)}</span>`;
        break;
      }

      // string literals
      const q = rest[0];
      if (q === '"' || q === "'" || q === "`") {
        let end = rest.indexOf(q, 1);
        while (end !== -1 && rest[end - 1] === "\\") end = rest.indexOf(q, end + 1);
        const str = end === -1 ? rest : rest.slice(0, end + 1);
        out += `<span style="color:#4ade80">${esc(str)}</span>`;
        i += str.length;
        continue;
      }

      // number
      const num = /^(\d+\.?\d*)/.exec(rest);
      if (num && (i === 0 || /\W/.test(line[i - 1]))) {
        out += `<span style="color:#fb923c">${esc(num[1])}</span>`;
        i += num[1].length;
        continue;
      }

      // word / keyword
      const word = /^([a-zA-Z_$][a-zA-Z0-9_$]*)/.exec(rest);
      if (word) {
        const w = word[1];
        if (keywords.has(w)) {
          out += `<span style="color:#c084fc;font-weight:500">${esc(w)}</span>`;
        } else if (w[0] === w[0].toUpperCase() && w.length > 1 && /[a-z]/.test(w)) {
          out += `<span style="color:#facc15">${esc(w)}</span>`;
        } else {
          out += esc(w);
        }
        i += w.length;
        continue;
      }

      out += esc(rest[0]);
      i++;
    }
    return out;
  }).join("\n");
}

// ── Full markdown → HTML (for message bodies) ───────────────────
export function renderMarkdown(text: string): string {
  // Extract code blocks BEFORE escaping so syntax highlighting sees raw text
  const codeSlots: string[] = [];
  let src = text.replace(/```(\w*)\n([\s\S]*?)```/g, (_m, lang, code) => {
    const trimmed = code.trimEnd();
    // Mermaid diagrams: emit a data attribute placeholder picked up by MermaidBlock
    if (lang === "mermaid") {
      const encoded = btoa(unescape(encodeURIComponent(trimmed)));
      const block = `<div class="mermaid-placeholder" data-mermaid="${encoded}"></div>`;
      codeSlots.push(block);
      return `\x00CB${codeSlots.length - 1}\x00`;
    }
    const highlighted = lang ? syntaxHL(trimmed, lang) : esc(trimmed);
    const langLabel = lang ? `<span class="code-lang">${esc(lang)}</span>` : "";
    const block = `<div class="code-block">${langLabel}<pre><code>${highlighted}</code></pre></div>`;
    codeSlots.push(block);
    return `\x00CB${codeSlots.length - 1}\x00`;
  });

  let html = esc(src);

  // Restore code blocks (placeholders survived escaping since \x00 isn't escaped)
  html = html.replace(/\x00CB(\d+)\x00/g, (_, i) => codeSlots[Number(i)]);

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

  // Tables — must run before paragraph conversion
  // Matches: header row | separator row | body rows
  html = html.replace(
    /^(\|.+\|)\n\|[-| :]+\|\n((?:\|.+\|\n?)*)/gm,
    (_match, headerRow, bodyRows) => {
      const parseRow = (row: string) =>
        row
          .split("|")
          .slice(1, -1)
          .map((c) => c.trim());

      const headers = parseRow(headerRow);
      const rows = bodyRows
        .trim()
        .split("\n")
        .filter(Boolean)
        .map(parseRow);

      const th = headers.map((h) => `<th>${h}</th>`).join("");
      const tbody = rows
        .map((cells: string[]) => `<tr>${cells.map((c: string) => `<td>${c}</td>`).join("")}</tr>`)
        .join("");

      return `<table class="md-table"><thead><tr>${th}</tr></thead><tbody>${tbody}</tbody></table>`;
    }
  );

  // Blockquotes
  html = html.replace(
    /((?:^&gt; .+\n?)+)/gm,
    (block) => {
      const inner = block
        .replace(/^&gt; /gm, "")
        .trimEnd();
      return `<blockquote>${inner}</blockquote>`;
    }
  );

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
