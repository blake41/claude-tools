/**
 * Session text formatting utilities.
 *
 * Provides inline markdown rendering and search-term highlighting
 * for Claude session content displayed throughout the app.
 * Inspired by gist.github.com's code rendering style.
 */
import React, { useContext, useEffect, useState } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkBreaks from "remark-breaks";

// Module-scope so the array keeps a stable identity: react-markdown gates
// its full re-parse behind a useEffect keyed on [children, ...plugins] — an
// inline array literal defeats that and forces a remark re-parse of every
// mounted message on every re-render (e.g. each search-box keystroke).
// remark-breaks keeps the old renderer's single-\n → <br> behavior; plain
// CommonMark soft-breaks would join line-separated prose into run-on
// paragraphs, which real transcripts hit constantly.
const REMARK_PLUGINS = [remarkGfm, remarkBreaks];

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

// ── Full markdown rendering (message bodies) ────────────────────
// Renders full markdown (headers, lists, tables, code fences, etc.) as a
// real React tree via react-markdown + remark-gfm, instead of hand-rolled
// regex → HTML strings (fragile escaping, broken code fences on nesting).
// Code fences are syntax-highlighted lazily via shiki, off the main render
// path, so large pasted blocks don't block the initial paint.

const MAX_HIGHLIGHT_CHARS = 20000; // skip highlighting past this size — perf guard
const SHIKI_THEME = "github-dark-default"; // bg #0d1117 / fg #e6edf3 — matches this app's own dark palette
type ShikiHighlighter = import("shiki/core").HighlighterCore;
let highlighterPromise: Promise<ShikiHighlighter> | null = null;

// Loads shiki's core highlighter engine on first use only (never at module
// load — the `import()` calls below don't fire until this function runs).
// Languages are imported by exact file path (the "fine-grained bundle"
// pattern) rather than through `createHighlighter`/`bundledLanguages` — that
// convenience map is one big object reachable from ~200 dynamic imports,
// which makes bundlers emit a chunk for every language shiki knows about
// instead of just the ones we actually expect in agent session logs. Add a
// line to the `langs` array below if one is missing; don't switch back to
// the full bundle.
function getHighlighter(): Promise<ShikiHighlighter> {
  if (!highlighterPromise) {
    highlighterPromise = Promise.all([
      import("shiki/core"),
      import("shiki/engine/javascript"),
      import("shiki/themes/github-dark-default.mjs"),
    ]).then(([{ createHighlighterCore }, { createJavaScriptRegexEngine }, theme]) =>
      createHighlighterCore({
        themes: [theme],
        langs: [
          import("shiki/langs/typescript.mjs"),
          import("shiki/langs/tsx.mjs"),
          import("shiki/langs/javascript.mjs"),
          import("shiki/langs/jsx.mjs"),
          import("shiki/langs/python.mjs"),
          import("shiki/langs/bash.mjs"),
          import("shiki/langs/json.mjs"),
          import("shiki/langs/go.mjs"),
          import("shiki/langs/rust.mjs"),
          import("shiki/langs/yaml.mjs"),
          import("shiki/langs/markdown.mjs"),
          import("shiki/langs/css.mjs"),
          import("shiki/langs/html.mjs"),
          import("shiki/langs/sql.mjs"),
          import("shiki/langs/diff.mjs"),
          import("shiki/langs/toml.mjs"),
          import("shiki/langs/c.mjs"),
          import("shiki/langs/cpp.mjs"),
          import("shiki/langs/java.mjs"),
          import("shiki/langs/ruby.mjs"),
          import("shiki/langs/php.mjs"),
          import("shiki/langs/dockerfile.mjs"),
        ],
        engine: createJavaScriptRegexEngine(),
      })
    );
  }
  return highlighterPromise;
}

// react-markdown (v9+) no longer passes an `inline` flag to the `code`
// renderer, so we thread "am I inside a fenced block?" via context: the
// `pre` renderer (only used for fenced blocks) sets it to true for its
// children before the nested `code` renderer reads it.
const InFencedBlockContext = React.createContext(false);

function MarkdownPre({ children }: { children?: React.ReactNode }) {
  return <InFencedBlockContext.Provider value={true}>{children}</InFencedBlockContext.Provider>;
}

function FencedCodeBlock({ lang, code }: { lang?: string; code: string }) {
  const [html, setHtml] = useState<string | null>(null);

  useEffect(() => {
    setHtml(null);
    if (!lang || lang === "mermaid" || code.length > MAX_HIGHLIGHT_CHARS) return;
    let cancelled = false;
    getHighlighter().then((hl) => {
      if (cancelled) return;
      const loaded = hl.getLoadedLanguages() as string[];
      const useLang = loaded.includes(lang) ? lang : "text";
      try {
        setHtml(hl.codeToHtml(code, { lang: useLang, theme: SHIKI_THEME }));
      } catch {
        // Unrecognized language/token error — leave the plain fallback rendered.
      }
    });
    return () => {
      cancelled = true;
    };
  }, [code, lang]);

  if (lang === "mermaid") {
    const encoded = btoa(unescape(encodeURIComponent(code)));
    return <div className="mermaid-placeholder" data-mermaid={encoded} />;
  }

  return (
    <div className="code-block">
      {lang && <span className="code-lang">{lang}</span>}
      {html ? (
        <div className="shiki-wrap" dangerouslySetInnerHTML={{ __html: html }} />
      ) : (
        <pre>
          <code>{code}</code>
        </pre>
      )}
    </div>
  );
}

function MarkdownCode({ className, children }: { className?: string; children?: React.ReactNode }) {
  const isFenced = useContext(InFencedBlockContext);
  const code = String(children ?? "").replace(/\n$/, "");

  if (!isFenced) {
    return <code className="inline-code">{code}</code>;
  }

  const lang = /language-(\w+)/.exec(className || "")?.[1];
  return <FencedCodeBlock lang={lang} code={code} />;
}

const markdownComponents: Components = {
  pre: MarkdownPre,
  code: MarkdownCode,
  table: ({ children }) => <table className="md-table">{children}</table>,
  a: ({ href, children }) => (
    <a href={href} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  ),
};

/** Render full markdown (message bodies) as a React tree. */
export const MarkdownBody = React.memo(function MarkdownBody({ text }: { text: string }) {
  return (
    <ReactMarkdown remarkPlugins={REMARK_PLUGINS} components={markdownComponents}>
      {text}
    </ReactMarkdown>
  );
});

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
