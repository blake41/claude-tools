# cass

[cass](https://github.com/Dicklesworthstone/coding_agent_session_search) (coding_agent_session_search) is a
third-party CLI and TUI that indexes and searches the session histories of coding agents (Claude Code, Codex,
and others). Shipyard's `/recall` skill and eval playbook use it as a transcript source next to session-explorer.

This folder holds only the installer and these notes. It does **not** vendor the cass source: cass ships
prebuilt release binaries, and a full clone is hundreds of MB of Rust build output plus history.

## Install

```bash
./cass/install.sh
```

Installs the pinned release (see `VERSION` in the script) to `~/.local/bin/cass`. It downloads the
archive from GitHub Releases, verifies the `.sha256`, and checks that the binary reports the pinned version.
A newer installed version is left alone unless you pass `--force`.

Supported: macOS arm64, Linux amd64, Linux arm64. There is no Intel macOS build.

Check:

```bash
cass --version
```

## Upgrade

```bash
cass upgrade --check            # print current vs latest, exit 1 if outdated
cass upgrade --force --yes      # install the latest (cass's own checksum-verified installer)
```

`--force` is needed because cass caches its update check for an hour. After upgrading, bump `VERSION` in
`install.sh` so a fresh machine gets the same version.

## Not handled by `tools/install.sh`

`cass` is a binary download, not a script symlink, so it has its own installer. See shipyard
`DEPENDENCIES.md` (the `cass` item) for when an agent needs it.
