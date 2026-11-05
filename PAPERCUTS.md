# Papercuts

2026-11-03T17:11:47.392Z - claude-opus-5-5 - blake johnson

herdr 0.9.5: 'herdr agent start --help' prints the global usage instead of the subcommand's; use 'herdr agent help x' to get the per-command syntax list.

2026-11-03T19:31:57.414Z - claude-opus-5-5 - blake johnson

epic-runner: a fix job that parks at agent start still bumps wave.fixRounds (wave.ts:189), so resume starts round 2 and one review-fix round is burned without running.
