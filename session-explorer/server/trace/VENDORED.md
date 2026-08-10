# Vendored code: claude-devtools

Source repo: https://github.com/matt1398/claude-devtools
Commit: `16cc3c87c1e4d0e08ee101fb52dad1b85dbbe48a`
Commit date: 2026-05-13 17:37:57 +0900
Vendored on: 2026-08-09
License: MIT (see `LICENSE` in this directory, copied verbatim from the source repo)

## What's vendored

The `vendor/` directory contains the transitive closure of source files needed to run
claude-devtools' session parsing + chunk/step analysis + subagent-linking pipeline
outside of its Electron app shell. The closure was computed by static import-graph
traversal starting from four entry points:

- `main/services/discovery/ProjectScanner.ts`
- `main/services/parsing/SessionParser.ts`
- `main/services/discovery/SubagentResolver.ts`
- `main/services/analysis/ChunkBuilder.ts`

45 files total, ~10,900 lines. No Electron or renderer imports anywhere in the closure
(verified by a scripted static import-graph traversal from the four entry points —
zero matches for `from 'electron'` in the reachable set). The only external
dependencies are Node builtins (`fs`, `path`, `os`, `crypto`, `readline`, `stream`).

## What changed vs. upstream

**Mechanical only — no logic changes.** The only edits applied during vendoring:

1. **Import path rewrites.** The source repo uses TS path aliases (`@main/*`,
   `@shared/*`) configured in its own `tsconfig.json`, which this repo does not have.
   Every `@main/...` / `@shared/...` import (and re-export) was rewritten to a
   relative import pointing at the vendored copy of that file, via a scripted
   transform (not hand-edited). No import was redirected to a different file than
   the one it originally resolved to.
2. **Directory rename.** `src/main/*` -> `vendor/main/*`, `src/shared/*` ->
   `vendor/shared/*` (the `src/` prefix and the split between `main`/`renderer`/
   `preload` source trees don't mean anything here since only the `main`+`shared`
   subset is vendored).
3. **`vendor/tsconfig.json`** is new (not from upstream) — an isolated tsconfig for
   typechecking the vendor tree standalone. It sets `"types": ["node", "react"]`;
   the `react` entry is needed only because `shared/types/notifications.ts` re-exports
   `shared/constants/triggerColors.ts`, which references the ambient `React.CSSProperties`
   type (used for UI trigger-badge styling, unrelated to session parsing, but pulled in
   transitively via the `shared/types` barrel's `export *`). Upstream's main tsconfig.json
   compiles main+renderer as one TS program, so the global `React` namespace bleeds in
   from `.tsx` files; this repo's root tsconfig does the same for the same reason (see
   `web/**/*.tsx`), so no such flag was needed there — this file exists purely so the
   vendor tree can also be typechecked in isolation.

No other files were edited. Everything else — pipeline logic, chunk/step extraction,
context accumulation, subagent linking (3-phase match: result-based → team-description
→ positional), tokenizer, message classification — is byte-for-byte upstream logic.

## Files (relative to `vendor/`)

```
main/constants/messageTags.ts
main/constants/worktreePatterns.ts
main/services/analysis/ChunkBuilder.ts
main/services/analysis/ChunkFactory.ts
main/services/analysis/ConversationGroupBuilder.ts
main/services/analysis/ProcessLinker.ts
main/services/analysis/SemanticStepExtractor.ts
main/services/analysis/SemanticStepGrouper.ts
main/services/analysis/SubagentDetailBuilder.ts
main/services/analysis/ToolExecutionBuilder.ts
main/services/discovery/ProjectPathResolver.ts
main/services/discovery/ProjectScanner.ts
main/services/discovery/SearchTextCache.ts
main/services/discovery/SearchTextExtractor.ts
main/services/discovery/SessionContentFilter.ts
main/services/discovery/SessionSearcher.ts
main/services/discovery/SubagentLocator.ts
main/services/discovery/SubagentResolver.ts
main/services/discovery/SubprojectRegistry.ts
main/services/discovery/WorktreeGrouper.ts
main/services/infrastructure/FileSystemProvider.ts
main/services/infrastructure/LocalFileSystemProvider.ts
main/services/parsing/GitIdentityResolver.ts
main/services/parsing/MessageClassifier.ts
main/services/parsing/SessionParser.ts
main/types/chunks.ts
main/types/domain.ts
main/types/index.ts
main/types/jsonl.ts
main/types/messages.ts
main/utils/contextAccumulator.ts
main/utils/jsonl.ts
main/utils/metadataExtraction.ts
main/utils/pathDecoder.ts
main/utils/sessionStateDetection.ts
main/utils/timelineGapFilling.ts
main/utils/tokenizer.ts
main/utils/toolExtraction.ts
shared/constants/triggerColors.ts
shared/types/api.ts
shared/types/index.ts
shared/types/notifications.ts
shared/types/visualization.ts
shared/utils/contentSanitizer.ts
shared/utils/logger.ts
```

## Deliberately NOT vendored

`ToolResultExtractor.ts` and `ToolSummaryFormatter.ts` (also in
`main/services/analysis/`) were excluded — nothing in the four entry points'
transitive closure imports them; their only consumers upstream are the
notification/error-trigger feature (`main/services/error/*`), which this
integration doesn't use.

## How this is used

`server/trace/index.ts` (outside this vendor directory) is the adapter: it resolves
a session id to a JSONL path (DB lookup -> `~/.claude/projects/*` glob -> gzipped
archive fallback), wires up `LocalFileSystemProvider` + `ProjectScanner` +
`SessionParser` + `SubagentResolver` + `ChunkBuilder` exactly as upstream's
`ServiceContext` + `get-session-detail` IPC handler do (see upstream
`src/main/services/infrastructure/ServiceContext.ts` and
`src/main/ipc/sessions.ts`), and returns the full (unstripped) `SessionDetail`.
