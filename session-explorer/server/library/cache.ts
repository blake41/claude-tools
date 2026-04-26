import type { LibraryArtifact } from "./types.js";
import { scanLibrary } from "./scan.js";

let cache: Map<string, LibraryArtifact> = new Map();
let lastScanAt: string | null = null;
let lastDurationMs = 0;

// Resolve thin-wrapper targetName → targetId by looking up the skill of the
// same name. Prefer global scope, then plugin, then project as a fallback.
function resolveThinWrappers(artifacts: LibraryArtifact[]) {
  const skillsByName = new Map<string, LibraryArtifact[]>();
  for (const a of artifacts) {
    if (a.type !== "skill") continue;
    const list = skillsByName.get(a.name) ?? [];
    list.push(a);
    skillsByName.set(a.name, list);
  }
  const scopeRank = (a: LibraryArtifact) =>
    a.scope.kind === "global" ? 0 : a.scope.kind === "plugin" ? 1 : 2;

  for (const a of artifacts) {
    if (!a.thinWrapper) continue;
    const candidates = skillsByName.get(a.thinWrapper.targetName);
    if (!candidates || candidates.length === 0) {
      a.thinWrapper.targetId = null;
      continue;
    }
    const best = [...candidates].sort((x, y) => scopeRank(x) - scopeRank(y))[0];
    a.thinWrapper.targetId = best.id;
  }
}

export function loadLibrary(): { count: number; durationMs: number } {
  const result = scanLibrary();
  resolveThinWrappers(result.artifacts);
  const next = new Map<string, LibraryArtifact>();
  for (const a of result.artifacts) {
    // Last write wins on duplicate ids (shouldn't happen, but defensive)
    next.set(a.id, a);
  }
  cache = next;
  lastScanAt = new Date().toISOString();
  lastDurationMs = result.durationMs;
  return { count: cache.size, durationMs: result.durationMs };
}

export function listArtifacts(): LibraryArtifact[] {
  return Array.from(cache.values());
}

export function getArtifact(id: string): LibraryArtifact | undefined {
  return cache.get(id);
}

export function getStatus(): { count: number; lastScanAt: string | null; durationMs: number } {
  return { count: cache.size, lastScanAt, durationMs: lastDurationMs };
}
