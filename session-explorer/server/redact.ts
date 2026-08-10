// ── Secret Redaction + Overlong-FTS-Token Guard ──────────────────────
//
// Pure, dependency-free string functions used by the projection layer
// (server/projection.ts, U3) before a tool-result body is written to
// `messages.content` — the same column FTS5 indexes. Two independent
// concerns live here on purpose:
//
//   redactSecrets   — keep credentials out of SQLite/FTS/summarize-LLM
//                      calls (R6). Regex-first, then entropy, for
//                      unlabeled tokens. See D6 in the migration plan.
//   guardFtsTokens  — keep any single indexed token under SQLite's
//                      practical limit (R7). See D7.
//
// `raw_records` (U1/U4) always keeps the untouched original — this module
// only ever affects the lossy projection column, never the raw store.

// ── redactSecrets ─────────────────────────────────────────────────────

export interface RedactionSpan {
  /** Redaction category, e.g. "aws-access-key" or "entropy-base64". */
  kind: string;
  /** Length (chars) of the original span that got replaced. */
  length: number;
}

export interface RedactSecretsResult {
  text: string;
  redactions: RedactionSpan[];
}

interface SecretPattern {
  kind: string;
  regex: RegExp;
}

// Ordered set of high-confidence, shape-identifiable secret formats. Order
// doesn't matter for correctness (matches are merged and resolved by
// position below), but keep it matching D6's listed order for readability.
const SECRET_PATTERNS: SecretPattern[] = [
  { kind: "aws-access-key", regex: /AKIA[0-9A-Z]{16}/g },
  { kind: "github-token", regex: /gh[pousr]_[A-Za-z0-9]{36,255}/g },
  { kind: "slack-token", regex: /xox[baprs]-[A-Za-z0-9-]{10,72}/g },
  { kind: "stripe-live-key", regex: /sk_live_[A-Za-z0-9]{24,}/g },
  { kind: "jwt", regex: /eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}/g },
  {
    kind: "private-key",
    regex: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
  },
];

// Exact strings that would otherwise match a shape pattern but are known
// documentation placeholders, not real credentials (D6). Checked against
// the *matched text*, not the surrounding context.
const ALLOWLISTED_EXACT = new Set<string>(["AKIAIOSFODNN7EXAMPLE"]);

interface RawMatch {
  kind: string;
  start: number;
  end: number;
  text: string;
}

/** Find every non-overlapping SECRET_PATTERNS match in `text`. On overlap,
 * the earliest-starting match wins; ties prefer the longer match. */
function findRegexMatches(text: string): RawMatch[] {
  const candidates: RawMatch[] = [];
  for (const { kind, regex } of SECRET_PATTERNS) {
    const re = new RegExp(regex.source, regex.flags);
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      if (m[0].length === 0) {
        re.lastIndex += 1;
        continue;
      }
      if (!ALLOWLISTED_EXACT.has(m[0])) {
        candidates.push({ kind, start: m.index, end: m.index + m[0].length, text: m[0] });
      }
    }
  }
  return resolveOverlaps(candidates);
}

/** Greedy earliest-start, longest-on-tie, non-overlapping selection. */
function resolveOverlaps(candidates: RawMatch[]): RawMatch[] {
  const sorted = [...candidates].sort(
    (a, b) => a.start - b.start || b.end - b.start - (a.end - a.start)
  );
  const resolved: RawMatch[] = [];
  let cursor = -1;
  for (const m of sorted) {
    if (m.start >= cursor) {
      resolved.push(m);
      cursor = m.end;
    }
  }
  return resolved;
}

/** Replace each match with `[REDACTED:<kind>]` and record what was cut. */
function applyMatches(
  text: string,
  matches: RawMatch[]
): { text: string; redactions: RedactionSpan[] } {
  if (matches.length === 0) return { text, redactions: [] };
  let result = "";
  let last = 0;
  const redactions: RedactionSpan[] = [];
  for (const m of matches) {
    result += text.slice(last, m.start);
    result += `[REDACTED:${m.kind}]`;
    redactions.push({ kind: m.kind, length: m.end - m.start });
    last = m.end;
  }
  result += text.slice(last);
  return { text: result, redactions };
}

// ── Entropy layer (unlabeled tokens) ───────────────────────────────────
//
// Research values per D6/D7: base64-charset runs >=20 chars with Shannon
// entropy > ~4.5; hex runs >=32 chars with entropy > ~3.0. Hex's 16-symbol
// alphabet caps entropy at exactly log2(16) = 4.0 bits/char, which is
// below the base64 threshold by construction — so a pure-hex run never
// double-fires the base64 pass, and we don't need to de-duplicate spans
// across the two scans beyond the shared overlap-resolution pass below.

export const BASE64_RUN_MIN_LEN = 20;
export const BASE64_ENTROPY_THRESHOLD = 4.5;
export const HEX_RUN_MIN_LEN = 32;
export const HEX_ENTROPY_THRESHOLD = 3.0;
// 40 hex chars is a git SHA-1 — extremely common in tool output (commit
// refs, `git rev-parse` results) and not a secret. UUIDs are NOT special-
// cased here: their canonical dashed form (8-4-4-4-12) never assembles a
// >=32-char contiguous hex run in the first place, since '-' isn't a hex
// digit and breaks every run into segments of at most 12 chars.
export const GIT_SHA_HEX_LEN = 40;

const HEX_RUN_RE = /[0-9a-fA-F]{32,}/g;
const BASE64_RUN_RE = /[A-Za-z0-9+/=]{20,}/g;

/** Shannon entropy in bits/char over the string's character distribution. */
function shannonEntropy(s: string): number {
  if (s.length === 0) return 0;
  const freq = new Map<string, number>();
  for (const ch of s) freq.set(ch, (freq.get(ch) ?? 0) + 1);
  let entropy = 0;
  for (const count of freq.values()) {
    const p = count / s.length;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

function findEntropyMatches(text: string): RawMatch[] {
  const candidates: RawMatch[] = [];

  const hexRe = new RegExp(HEX_RUN_RE.source, HEX_RUN_RE.flags);
  let m: RegExpExecArray | null;
  while ((m = hexRe.exec(text)) !== null) {
    const run = m[0];
    if (
      run.length !== GIT_SHA_HEX_LEN &&
      !ALLOWLISTED_EXACT.has(run) &&
      shannonEntropy(run) > HEX_ENTROPY_THRESHOLD
    ) {
      candidates.push({ kind: "entropy-hex", start: m.index, end: m.index + run.length, text: run });
    }
  }

  const base64Re = new RegExp(BASE64_RUN_RE.source, BASE64_RUN_RE.flags);
  while ((m = base64Re.exec(text)) !== null) {
    const run = m[0];
    if (!ALLOWLISTED_EXACT.has(run) && shannonEntropy(run) > BASE64_ENTROPY_THRESHOLD) {
      candidates.push({
        kind: "entropy-base64",
        start: m.index,
        end: m.index + run.length,
        text: run,
      });
    }
  }

  return resolveOverlaps(candidates);
}

/**
 * Redact secrets from `text` in two layers:
 *  1. High-confidence prefixed patterns (AWS/GitHub/Slack/Stripe/JWT/PEM).
 *  2. Shannon-entropy scan over remaining base64/hex-charset runs, for
 *     unlabeled tokens the regex layer can't recognize by shape alone.
 * An allowlist prevents known-safe high-entropy strings (git SHAs, UUIDs,
 * documentation placeholder keys) from being flagged.
 */
export function redactSecrets(text: string): RedactSecretsResult {
  if (typeof text !== "string" || text.length === 0) {
    return { text: text ?? "", redactions: [] };
  }
  const regexMatches = findRegexMatches(text);
  const afterRegex = applyMatches(text, regexMatches);

  const entropyMatches = findEntropyMatches(afterRegex.text);
  const afterEntropy = applyMatches(afterRegex.text, entropyMatches);

  return {
    text: afterEntropy.text,
    redactions: [...afterRegex.redactions, ...afterEntropy.redactions],
  };
}

// ── guardFtsTokens ────────────────────────────────────────────────────
//
// Whitespace-splitting alone is NOT enough to bound token length: minified
// JS/CSS/bundler output routinely runs hundreds of chars with zero
// whitespace (property chains, packed literals), and SQLite's FTS5
// tokenizer treats the whole run as one token. 64 is conservative relative
// to SQLite's actual token ceiling (32768 bytes) but matches the existing
// `snippet()`/`TOOL_PAYLOAD_CAP`-style caps already used in this repo
// (server/trace/index.ts) — a guard, not an engine requirement.

export const MAX_FTS_TOKEN_LEN = 64;

// The choice, named per D7: SPLIT an overlong run (insert a single space
// every maxLen chars) rather than DROP it outright. `guardFtsTokens` runs
// on the same string that becomes `messages.content` — the displayed
// projection, not just the FTS input — so dropping would permanently
// delete visible content over an SQLite-engine constraint that has
// nothing to do with the migration's full-fidelity goal. Splitting adds
// whitespace only; every original character survives, and the run becomes
// tokenizable. (`raw_records` keeps the untouched original regardless.)
export const FTS_TOKEN_GUARD_STRATEGY = "split" as const;

const NON_WHITESPACE_RUN_RE = /\S+/g;

function splitRun(run: string, maxLen: number): string {
  const chunks: string[] = [];
  for (let i = 0; i < run.length; i += maxLen) {
    chunks.push(run.slice(i, i + maxLen));
  }
  return chunks.join(" ");
}

/**
 * Ensure no single non-whitespace run in `text` exceeds `maxLen` chars, by
 * inserting a space every `maxLen` chars within any run that does. Runs at
 * or under the limit are left byte-for-byte unchanged.
 */
export function guardFtsTokens(
  text: string,
  maxLen: number = MAX_FTS_TOKEN_LEN
): string {
  if (typeof text !== "string" || text.length === 0) return text ?? "";
  if (maxLen <= 0) return text;

  const re = new RegExp(NON_WHITESPACE_RUN_RE.source, NON_WHITESPACE_RUN_RE.flags);
  let result = "";
  let lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const run = m[0];
    result += text.slice(lastIndex, m.index);
    result += run.length > maxLen ? splitRun(run, maxLen) : run;
    lastIndex = m.index + run.length;
  }
  result += text.slice(lastIndex);
  return result;
}
