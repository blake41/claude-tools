// Parsing for the summarize prompt's expected output:
//   ONELINE: <headline>
//   - bullet
//   - bullet
//
// Extracted from summarizeSession so the parse rules are testable. The
// ONELINE match is deliberately tolerant of markdown decoration
// (\"**ONELINE:** ...\", \"# ONELINE: ...\") — models decorate keywords despite
// instructions, and a decorated line must not be misread as \"no headline\":
// a partial parse used to slip through updateSessionSummary and reset the
// retry/backoff state with summary_short still NULL, recreating the
// re-bill-every-tick loop the backoff exists to prevent.

export interface ParsedSummary {
  oneLine: string;
  bullets: string;
}

const ONELINE_RE = /^[\s*_#>`]*ONELINE[\s*_`]*:[\s*_`]*(.*)$/i;

export function parseSummaryOutput(raw: string): ParsedSummary {
  let oneLine = "";
  const bulletLines: string[] = [];
  for (const line of raw.split("\n")) {
    const m = line.match(ONELINE_RE);
    if (m && !oneLine) {
      oneLine = m[1].replace(/[\s*_`]+$/, "").trim();
    } else if (line.trim().startsWith("-")) {
      bulletLines.push(line);
    }
  }
  return { oneLine, bullets: bulletLines.join("\n").trim() };
}
