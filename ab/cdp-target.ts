export interface CdpTab {
  id?: string;
  type: string;
  url?: string;
  webSocketDebuggerUrl: string;
}

/** Env var carrying the session's last recorded CDP target id from cli.ts. */
export const TARGET_ID_ENV = "AB_TARGET_ID";

/**
 * Select the session's own tab from a /json list. Never falls back to another
 * page: on a shared Chrome shard that would act in a different agent's tab.
 */
export function pickTabWs(tabs: CdpTab[], targetId: string | undefined): string {
  if (!targetId) {
    throw new Error("No tab recorded for this session. Run `ab open <url>` first.");
  }
  const tab = tabs.find((t) => t.type === "page" && t.id === targetId);
  if (!tab) {
    throw new Error(`Session tab ${targetId} no longer exists. Run \`ab open <url>\` to open a new one.`);
  }
  return tab.webSocketDebuggerUrl;
}
