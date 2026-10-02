import { createRoot } from "react-dom/client";
import { ExpandStoreContext } from "../web/hooks/usePersistedExpand";
import { ChunkRow, TraceStatsBar } from "../web/components/TraceView";
import type { TraceSessionDetail } from "../web/traceTypes";
import "./viewer.css";

const trace: TraceSessionDetail = JSON.parse(document.getElementById("trace-data")!.textContent!);
const store = new Map<string, boolean>();

let maxContextTokens = 0;
for (const c of trace.chunks) {
  if (c.chunkType === "ai" && c.contextTokensEnd !== undefined) {
    maxContextTokens = Math.max(maxContextTokens, c.contextTokensEnd);
  }
}

createRoot(document.getElementById("root")!).render(
  <ExpandStoreContext.Provider value={store}>
    <div className="mx-auto max-w-4xl px-4 py-6">
      <TraceStatsBar trace={trace} />
      {trace.chunks.map((chunk) => (
        <ChunkRow key={chunk.id} chunk={chunk} maxContextTokens={maxContextTokens} highlight={false} />
      ))}
    </div>
  </ExpandStoreContext.Provider>,
);
