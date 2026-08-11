import { createContext, useCallback, useContext, useState } from "react";

// ── Persisted expand/collapse state across virtualization remounts (U7) ──
// Rows scrolling out of a react-virtual rendered range and back in are fresh
// React mounts — a plain `useState` for "show reasoning" / "show more"
// resets every time. This context holds a plain (mutated-in-place, not React
// -state) `Map<string, boolean>` created once per page instance, so a row
// can read its prior toggle value on remount without forcing the whole list
// to re-render on every toggle. Shared by SessionDetail.tsx (message/turn/
// tool-result toggles) and TraceView.tsx's chunk-row renderers (user/system
// /compact/AI chunk expand) now that the merged session page virtualizes
// trace chunks instead of message turns. Cleared whenever the session id
// changes so keys — which reuse per-session ids/sequences — never bleed
// across sessions.
export const ExpandStoreContext = createContext<Map<string, boolean> | null>(null);

export function usePersistedExpand(
  key: string,
  initial = false
): [boolean, (updater: boolean | ((prev: boolean) => boolean)) => void] {
  const store = useContext(ExpandStoreContext);
  const [value, setValue] = useState(() => store?.get(key) ?? initial);
  const setPersisted = useCallback(
    (updater: boolean | ((prev: boolean) => boolean)) => {
      setValue((prev) => {
        const next = typeof updater === "function" ? (updater as (prev: boolean) => boolean)(prev) : updater;
        store?.set(key, next);
        return next;
      });
    },
    [store, key]
  );
  return [value, setPersisted];
}
