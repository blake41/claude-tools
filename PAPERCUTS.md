# Papercuts

2026-08-04T22:03:52.066Z - fable - blake johnson

Diagnosing 'pool saturation' reports post tab-teardown fix: ab ps counts /tmp/.ab-session-* marker files (30-min gc idle grace keeps 100+ rows on busy days), while real Chrome load is tabCounts in ab status — agents keep misreading marker sprawl as saturation.

2026-08-09T20:10:59.127Z - fable - blake johnson

QA'ing session-explorer: cross-referenced DB ingested_at (UTC) against file mtimes (local EDT) and got a false 'regression after the fix' verdict — sessions.ingested_at has no timezone marker in some rows and mixed ISO-T/space formats, so string comparisons and tz math both lie. Normalize with datetime() and compare in one zone.

2026-08-09T20:10:59.170Z - fable - blake johnson

IDE diagnostics repeatedly reported stale errors mid-session (Cannot find module './active-path', params unknown[] errors that were already fixed) while bunx tsc --noEmit showed zero — trust the real tsc run, not the LSP echo, when agents edit concurrently.

2026-08-09T20:10:59.204Z - fable - blake johnson

macOS has no coreutils 'timeout' command — a sandboxed test run using 'timeout 15 bun ...' died with exit 127; use the Bash tool's timeout parameter instead.

2026-08-10T18:07:43.830Z - opus - blake johnson - [worktree: parser-migration]

bun test: mock.module() registrations are global to the whole test RUN, not scoped to the file that calls them. Mocking server/archive.ts inside a new server/ingest.test.ts silently broke two assertions in server/archive.test.ts (shouldArchive resolved to my stub) even though that file runs first alphabetically. Workaround: import the real module first and spread it, overriding only the one export you need. Worth a note in a test-conventions doc.

2026-08-10T18:07:43.868Z - opus - blake johnson - [worktree: parser-migration]

session-explorer: importing server/db.ts opens and migrates the real data/sessions.db as a module side effect, so any test touching server/ingest.ts must mock.module it first or bun test writes to the production DB. server/ingest.test.ts now has a working in-memory recipe; a shared test helper (server/test-db.ts) would stop the next person rediscovering it.

2026-08-10T20:44:40.546Z - sonnet-5 - blake johnson - [worktree: parser-migration]

QA browser session: killed worktree dev server with 'pkill -f vite' / 'pkill -f "bun --watch server/index.ts"' — these patterns are process-name-only and would also match an unrelated main-checkout dev instance running on the same machine (ports 5198/5199). Got lucky it wasn't disrupted; should have grepped the full path (e.g. 'pkill -f worktrees/parser-migration.*vite') to scope the kill to only the worktree's own PIDs.

2026-08-10T21:53:52.885Z - sonnet-5 - blake johnson - [worktree: parser-migration]

QA on session-explorer's jumpToBottom fix: ab click @ref (and click-xy) intermittently failed with 'actionability: target ... outside layout viewport' on a sticky top-0 toolbar button after the page had auto-scrolled far down via rowVirtualizer.scrollToIndex, even though the button was visibly on-screen in a screenshot. click-js with a CSS selector worked reliably instead. Likely a stale-bounding-rect/scrollY cache in ab's ref-click path when window-level virtualized scrolling moves the page without a corresponding DOM mutation ab's snapshot would pick up.

2026-08-11T01:33:12.675Z - sonnet - blake johnson - [worktree: parser-migration]

ab click on a ref reports 'outside layout viewport' with a bogus viewport rect (e.g. y-offset 623, height 513) on the session-explorer trace page even when the element is visibly on-screen at the reported coordinates — click-xy with the same coords works fine. Likely a viewport-height calc bug in ab's actionability check when the page has a sticky header + windowed virtualizer. Workaround: use click-xy with coords read off a screenshot.

2026-08-11T01:33:12.715Z - sonnet - blake johnson - [worktree: parser-migration]

ab console-tail only streams NEW console messages from attach time forward — no buffer replay. If you 'open' a URL then start console-tail, you miss all logs from that page load. Must start console-tail (backgrounded) BEFORE navigating, then trigger navigation, then read its output file.

2026-10-05T03:29:06.772Z - opus - blake johnson - [worktree: ab-daemon-hardening]

ab tests: running several ab/src/__tests__ files in one 'bun test' call without --isolate gives 13 false failures, because chrome-supervisor reads AB_* env knobs at import and the first file's env wins. Use 'bun test --isolate' or a test script that sets it.

2026-10-05T06:09:23.909Z - opus - blake johnson - [worktree: ab-daemon-hardening]

ab tests (ps/tab-visibility/teardown/session-resolution) shell out to ab/ab, which hardcodes /Users/blake/Documents/Development/tools/ab/src/cli.ts, so in a worktree they exercise the main checkout, and several also hit the live daemon via ab gc/status/open; heartbeat-rearm, threshold-probe, health-summary, server-retry-gate and chrome-supervisor.test call ensure() without AB_PROFILE_ROOT.

2026-10-05T06:12:38.451Z - opus-4.8 - blake johnson - [worktree: ab-daemon-hardening]

daemon-integration.test.ts leaks agent-browser helper processes (cwd in the worktree, dashboard port 24848/24858) after a run; needs cleanup in the test's afterAll.

2026-10-05T07:05:12.592Z - opus - blake johnson - [worktree: ab-refactor]

ab: chrome-supervisor-adopt-flap.test.ts failed once (0 pass 1 fail) in a sequential --isolate run on an untouched tree, then passed 4/4 re-runs; timing-sensitive under load, worth a look.

2026-10-05T07:30:16.022Z - sonnet - blake johnson - [worktree: ab-followups]

worktree-add-cow in tools repo ran 'bun install' at root which has no package.json (ab/ has it) and reported ERROR even though the worktree was created.

2026-10-05T13:15:04.498Z - fable - blake johnson

Timing claude startup with a pty.fork() harness: the Bash tool moved the >300s command to background and the second pty.fork in the same python process hung forever (no claude child alive, no output). Running one pty session per python process with signal.alarm fixed it; macOS has no 'timeout' binary either.
