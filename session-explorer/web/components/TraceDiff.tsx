import React from "react";
import type { StructuredPatchHunk } from "../traceTypes";

/**
 * Renders `toolUseResult.structuredPatch` hunks (the `diff` npm package's own
 * hunk format: each line already prefixed with '+'/'-'/' ') as a plain
 * red/green diff. Reuses the .diff-add/.diff-del/.diff-ctx classes already
 * defined in styles.css for the Edit/MultiEdit inline diff in SessionDetail —
 * no new deps, no LCS recomputation (the patch is already computed).
 */
function TraceDiff({ hunks }: { hunks: StructuredPatchHunk[] }) {
  if (!Array.isArray(hunks) || hunks.length === 0) return null;
  return (
    <div className="font-mono text-[11.5px] leading-[1.5] overflow-x-auto">
      {hunks.map((hunk, hi) => (
        <div key={hi} className={hi > 0 ? "mt-2 pt-2 border-t border-border/40" : undefined}>
          {(hunk.lines ?? []).map((line, li) => {
            const prefix = line[0];
            const cls = prefix === "+" ? "diff-add" : prefix === "-" ? "diff-del" : "diff-ctx";
            return (
              <div key={li} className={cls} style={{ whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
                {line.length > 0 ? line : " "}
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}

export default React.memo(TraceDiff);
