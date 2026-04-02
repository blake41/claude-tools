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

function cco-permissions
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
    if set -q CMUX_SURFACE_ID; and command -q cmux
        set -l identify (cmux identify 2>/dev/null)
        if test -n "$identify"
            set -l ws_ref (echo "$identify" | python3 -c "import sys,json; print(json.load(sys.stdin)['caller']['workspace_ref'])" 2>/dev/null)
            set -l sf_ref (echo "$identify" | python3 -c "import sys,json; print(json.load(sys.stdin)['caller']['surface_ref'])" 2>/dev/null)
            set -l ws_name (cmux list-workspaces 2>/dev/null | grep "$ws_ref " | sed "s/^[* ]*$ws_ref  //" | sed 's/  \[selected\]//')
            set -l sf_name (cmux list-pane-surfaces 2>/dev/null | grep "$sf_ref " | sed "s/^[* ]*$sf_ref  //" | sed 's/  \[selected\]//')
            if test -n "$ws_name" -a -n "$sf_name"
                set -l is_human_name true
                if string match -rq '^[~✳/]|^\S+\s+[~/]' "$sf_name"
                    set is_human_name false
                end
                set cmux_key_hash (echo -n "$ws_name/$sf_name" | shasum -a 256 | string sub -l 16)
                if test "$has_resume_flag" = false -a "$is_human_name" = true
                    set -l mapping_file ~/.cmux/claude-sessions/$cmux_key_hash
                    if test -f $mapping_file
                        set -l saved_sid (cat $mapping_file)
                        if test -n "$saved_sid"
                            echo "Resuming session for '$ws_name/$sf_name': $saved_sid"
                            set -a extra_args --resume $saved_sid
                            set session_id $saved_sid
                        end
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
