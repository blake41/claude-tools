# cco-permissions — Launch Claude Code inside a Seatbelt sandbox
# Source this file from ~/.config/fish/config.fish:
#   source ~/Documents/Development/tools/sandbox/cco-permissions.fish
#
# Dependencies:
#   - claude-sandbox (symlinked to ~/.local/bin/)
#   - sandbox-request (symlinked to ~/.local/bin/)
#   - dirs file (tools/sandbox/dirs)
#   - ab (for browser preflight, optional)
#   - cmux (for session auto-resume, optional)
#
# Flags (consumed here, not forwarded to claude):
#   --no-sandbox    Skip Seatbelt entirely — run `claude` directly with the
#                   usual CCO_SESSION_ID / cmux auto-resume / browser preflight
#                   still in place. Use when the sandbox is getting in the way
#                   of an exploratory session.
#   --name <name>   Set the cmux tab name to <name> before launching, so the
#                   session is persisted under that name (instead of cmux's
#                   auto-title showing the running command). Useful for fresh
#                   tabs that haven't been renamed yet.

function cco-permissions
    # Pull out our own flags before touching $argv further.
    set -l skip_sandbox false
    if contains -- --no-sandbox $argv
        set skip_sandbox true
        set argv (string match -v -- --no-sandbox $argv)
    end

    set -l explicit_name ""
    set -l prev ""
    set -l filtered_argv
    for i in $argv
        if test "$prev" = "--name"
            set explicit_name $i
            set prev $i
            continue
        end
        if test "$i" = "--name"
            set prev $i
            continue
        end
        set -a filtered_argv $i
        set prev $i
    end
    set argv $filtered_argv

    # Parse --resume/--continue from argv
    set -l session_id ""
    set -l has_resume_flag false
    set -l prev ""
    for i in $argv
        if test "$prev" = "--resume"; or test "$prev" = "--continue"
            set session_id $i
            set has_resume_flag true
            break
        end
        set prev $i
    end

    # Auto-resume from cmux workspace/surface mapping
    # Captures surface name BEFORE claude starts (claude changes the terminal title)
    set -l extra_args
    set -l cmux_key_hash ""
    if not set -q CMUX_SURFACE_ID
        # Not in cmux — silent, this is the common bare-shell case
    else if not command -q cmux
        echo "cmux: CMUX_SURFACE_ID set but cmux CLI not on PATH — skipping auto-resume" >&2
    else if not command -q cmux-session-key
        echo "cmux: cmux-session-key helper missing from PATH — skipping auto-resume" >&2
    else
        set -l identify (cmux identify 2>/dev/null)
        if test -z "$identify"
            echo "cmux: `cmux identify` returned nothing — skipping auto-resume" >&2
        else
            set -l ws_ref (echo "$identify" | python3 -c "import sys,json; print(json.load(sys.stdin)['caller']['workspace_ref'])" 2>/dev/null)
            set -l sf_ref (echo "$identify" | python3 -c "import sys,json; print(json.load(sys.stdin)['caller']['surface_ref'])" 2>/dev/null)

            # If --name was passed, rename the surface NOW so the human-name
            # capture below picks up the new name. Otherwise an unnamed tab
            # gets cmux's auto-title (the running command), which the human
            # filter rejects, so the session never gets persisted by name.
            if test -n "$explicit_name" -a -n "$sf_ref"
                cmux rename-tab --surface $sf_ref -- $explicit_name >/dev/null 2>&1
                or echo "cmux: rename-tab failed for $sf_ref → '$explicit_name'" >&2
            end

            set -l ws_name (cmux list-workspaces 2>/dev/null | grep "$ws_ref " | sed "s/^[* ]*$ws_ref  //" | sed 's/  \[selected\]//')
            set -l sf_name (cmux list-pane-surfaces 2>/dev/null | grep "$sf_ref " | sed "s/^[* ]*$sf_ref  //" | sed 's/  \[selected\]//')
            if test -z "$ws_name" -o -z "$sf_name"
                echo "cmux: could not resolve workspace/surface names (ws_ref=$ws_ref sf_ref=$sf_ref) — skipping auto-resume" >&2
            else
                # Derive normalized key + hash + human flag via the shared helper
                # so cco-permissions and cmux-session-persist stay in lockstep.
                set -l key_out (printf '%s\n%s\n' "$ws_name" "$sf_name" | cmux-session-key)
                set -l cmux_norm_key $key_out[1]
                set cmux_key_hash $key_out[2]
                set -l is_human_name $key_out[3]

                if test "$is_human_name" != "1"
                    echo "cmux: '$cmux_norm_key' looks non-human — not auto-resuming."
                    echo "      Rename the tab in cmux (right-click → Rename) to enable persistence,"
                    echo "      then re-run cco-permissions. This session will not be saved by name."
                    # Critical: wipe the hash so we don't export a non-human key to the
                    # persist hook. If we exported it, SessionStart would write a mapping
                    # under e.g. 'Keystone/Claude Code' (claude's auto-title), and on next
                    # boot the user-named tab would never find its way back to that key.
                    set cmux_key_hash ""
                else if test "$has_resume_flag" = true
                    echo "cmux: '$cmux_norm_key' hash=$cmux_key_hash (--resume flag present, skipping lookup)"
                else
                    set -l mapping_file ~/.cmux/claude-sessions/$cmux_key_hash
                    set -l saved_sid ""
                    if test -f $mapping_file
                        set saved_sid (cat $mapping_file)
                    else
                        # Heal: no mapping under current name hash. Maybe the tab
                        # was renamed within this cmux process. Look for any
                        # by-session/ entry whose surface_ref + workspace_ref
                        # match this tab; if so, the session is ours under a
                        # stale name. Relink to the current hash.
                        set -l by_session_dir ~/.cmux/claude-sessions/by-session
                        if test -d $by_session_dir
                            for f in $by_session_dir/*
                                test -f $f; or continue
                                set -l entry_ws (python3 -c "import sys,json; print(json.load(open('$f')).get('workspace_ref',''))" 2>/dev/null)
                                set -l entry_sf (python3 -c "import sys,json; print(json.load(open('$f')).get('surface_ref',''))" 2>/dev/null)
                                if test "$entry_ws" = "$ws_ref" -a "$entry_sf" = "$sf_ref"
                                    set -l entry_sid (python3 -c "import sys,json; print(json.load(open('$f')).get('session_id',''))" 2>/dev/null)
                                    set -l entry_key (python3 -c "import sys,json; print(json.load(open('$f')).get('key',''))" 2>/dev/null)
                                    if test -n "$entry_sid"
                                        echo "cmux: renamed tab detected ('$entry_key' → '$cmux_norm_key') — relinking session $entry_sid"
                                        echo $entry_sid >$mapping_file
                                        set saved_sid $entry_sid
                                        break
                                    end
                                end
                            end
                        end
                    end
                    if test -n "$saved_sid"
                        # Validate the saved session actually exists on disk
                        # before passing it to --resume. Stale mappings survive
                        # session deletion (retention, manual cleanup, worktree
                        # removal) and claude errors out on dead session IDs.
                        set -l session_jsonl (find ~/.claude/projects -maxdepth 2 -name "$saved_sid.jsonl" -type f 2>/dev/null | head -1)
                        if test -z "$session_jsonl"
                            echo "cmux: saved session $saved_sid no longer exists on disk — removing stale mapping, starting fresh"
                            rm -f $mapping_file
                            set saved_sid ""
                        end
                    end
                    if test -n "$saved_sid"
                        echo "Resuming session for '$cmux_norm_key' (hash=$cmux_key_hash): $saved_sid"
                        set -a extra_args --resume $saved_sid
                        set session_id $saved_sid
                    else if not test -f ~/.cmux/claude-sessions/$cmux_key_hash
                        echo "cmux: no saved session for '$cmux_norm_key' (hash=$cmux_key_hash) — starting fresh"
                    end
                end
            end
        end
    end

    if test -z "$session_id"
        set session_id (head -c 4 /dev/urandom | xxd -p)
    end

    # Ensure browser is ready before entering sandbox
    if command -q ab
        if not ab ensure
            echo "Browser setup failed. Run 'ab heal' and try again." >&2
            return 1
        end
    end

    set -gx CCO_SESSION_ID $session_id
    if test -n "$cmux_key_hash"
        set -gx CMUX_SESSION_KEY_HASH $cmux_key_hash
    end

    if not contains $HOME/.local/bin $PATH
        set -x PATH $HOME/.local/bin $PATH
    end

    # --no-sandbox: skip Seatbelt + the expansion loop entirely.
    # Everything else (CCO_SESSION_ID, auto-resume, --dangerously-skip-permissions)
    # stays in place.
    if $skip_sandbox
        # Tell the statusline we're NOT in seatbelt. Without this it falls
        # back to "is CCO_SESSION_ID set?" which is true in both modes and
        # would show the lock icon misleadingly.
        set -gx CCO_SANDBOX_OFF 1
        claude --dangerously-skip-permissions $extra_args $argv
        set -e CCO_SESSION_ID
        set -e CMUX_SESSION_KEY_HASH
        set -e CCO_SANDBOX_OFF
        return
    end

    # Build sandbox args from dirs file
    # Use the same directory as this script (tools/sandbox/)
    set -l dirs_file ~/Documents/Development/tools/sandbox/dirs
    set -l sandbox_args
    while read -l dir
        test -z "$dir"; and continue
        string match -q '#*' $dir; and continue
        set dir (string replace '~' $HOME $dir)
        if string match -q '*:ro' $dir
            set -a sandbox_args --read-only (string replace ':ro' '' $dir)
        else
            set -a sandbox_args --write (string replace ':rw' '' $dir)
        end
    end <$dirs_file

    # Claude's own config (always writable)
    set -a sandbox_args --write $HOME/.claude
    set -a sandbox_args --write $HOME/.claude.json

    # Session-level extra paths (added via sandbox-request + restart loop)
    set -l session_extra_args

    while true
        claude-sandbox $sandbox_args $session_extra_args -- claude --dangerously-skip-permissions $extra_args $argv

        # Check for sandbox expansion requests
        set -l request_file /tmp/sandbox-expand-request-$session_id
        if not test -f $request_file
            break # normal exit, no expansion requested
        end

        echo ""
        echo "━━━ Sandbox expansion requested ━━━"
        while read -l line
            set -l mode (echo $line | cut -d' ' -f1)
            set -l path (echo $line | cut -d' ' -f2-)
            if test "$mode" = "--ro"
                echo "  Read-only: $path"
            else
                echo "  Read-write: $path"
            end
        end <$request_file

        read -P "Allow? [y = permanent / s = session only / n = deny] " -l answer
        # Default to permanent (empty input = y)
        if test -z "$answer"
            set answer y
        end
        if test "$answer" = "n"
            echo "Denied. Exiting."
            rm -f $request_file
            break
        end

        # Add requested paths to session args, ensuring dirs exist for Seatbelt subpath rules
        while read -l line
            set -l mode (echo $line | cut -d' ' -f1)
            set -l path (echo $line | cut -d' ' -f2-)
            if test "$mode" = "--ro"
                set -a session_extra_args --read-only $path
                if test "$answer" = "y"
                    echo $path:ro >>$dirs_file
                end
            else
                # Ensure it's a directory so Seatbelt uses subpath (recursive) not literal (single file)
                if test -f $path
                    rm -f $path
                end
                if not test -d $path
                    mkdir -p $path
                end
                set -a session_extra_args --write $path
                if test "$answer" = "y"
                    echo $path >>$dirs_file
                end
            end
        end <$request_file
        rm -f $request_file

        # Resume the same session
        set extra_args --resume $session_id
        echo "Restarting session with expanded sandbox..."
        echo ""
    end

    set -e CCO_SESSION_ID
    set -e CMUX_SESSION_KEY_HASH
end
