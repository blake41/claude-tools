import type { ArtifactReference, LibraryArtifact, LibraryType } from "./types.js";
import { scanLibrary } from "./scan.js";

let cache: Map<string, LibraryArtifact> = new Map();
let lastScanAt: string | null = null;
let lastDurationMs = 0;

// Linker — resolves name-based references between artifacts after the full
// library has been scanned. All cross-artifact lookups go through here so
// scope-preference and self-reference rules are defined once.

const scopeRank = (a: LibraryArtifact) =>
  a.scope.kind === "global" ? 0 : a.scope.kind === "plugin" ? 1 : 2;

function buildNameIndex(
  artifacts: LibraryArtifact[],
  types: ReadonlySet<LibraryType>
): Map<string, LibraryArtifact> {
  const buckets = new Map<string, LibraryArtifact[]>();
  for (const a of artifacts) {
    if (!types.has(a.type)) continue;
    const list = buckets.get(a.name) ?? [];
    list.push(a);
    buckets.set(a.name, list);
  }
  // Collapse each bucket to its best (lowest-rank) match up front so callers
  // don't re-sort on every lookup.
  const index = new Map<string, LibraryArtifact>();
  for (const [name, group] of buckets) {
    index.set(name, group.reduce((best, x) => (scopeRank(x) < scopeRank(best) ? x : best)));
  }
  return index;
}

const SKILL_TYPES: ReadonlySet<LibraryType> = new Set(["skill"]);
const INVOKABLE_TYPES: ReadonlySet<LibraryType> = new Set(["skill", "command", "agent"]);

function link(artifacts: LibraryArtifact[]) {
  const skillIndex = buildNameIndex(artifacts, SKILL_TYPES);
  const invokableIndex = buildNameIndex(artifacts, INVOKABLE_TYPES);

  for (const a of artifacts) {
    if (a.thinWrapper) {
      const target = skillIndex.get(a.thinWrapper.targetName);
      a.thinWrapper.targetId = target ? target.id : null;
    }

    const candidates = a._refCandidates ?? [];
    delete a._refCandidates;
    if (candidates.length === 0) continue;

    const seen = new Set<string>();
    const resolved: typeof a.references = [];
    for (const name of candidates) {
      const target = invokableIndex.get(name);
      if (!target) continue;
      if (target.id === a.id) continue;
      if (a.thinWrapper?.targetId === target.id) continue;
      if (seen.has(target.id)) continue;
      seen.add(target.id);
      resolved.push({ targetType: target.type, targetName: target.name, targetId: target.id });
    }
    a.references = resolved;
  }

  // Inbound list: every other artifact that points at this one. Single pass
  // over the now-resolved references plus thin-wrapper targets. The two sets
  // are disjoint by construction (link() drops a body reference whose target
  // matches the source's own thin-wrapper), so concatenating is safe.
  const byId = new Map<string, LibraryArtifact>();
  for (const a of artifacts) byId.set(a.id, a);

  const inbound = new Map<string, ArtifactReference[]>();
  const push = (sourceId: string, targetId: string | null | undefined) => {
    if (!targetId) return;
    const source = byId.get(sourceId);
    if (!source) return;
    const list = inbound.get(targetId) ?? [];
    list.push({ targetType: source.type, targetName: source.name, targetId: source.id });
    inbound.set(targetId, list);
  };
  for (const a of artifacts) {
    for (const ref of a.references) push(a.id, ref.targetId);
    push(a.id, a.thinWrapper?.targetId);
  }
  for (const a of artifacts) {
    const list = inbound.get(a.id) ?? [];
    list.sort((x, y) => x.targetName.localeCompare(y.targetName));
    a.referencedByList = list;
  }
}

export function loadLibrary(): { count: number; durationMs: number } {
  const result = scanLibrary();
  link(result.artifacts);
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
