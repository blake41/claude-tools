# cco-permissions — Launch Claude Code inside a Seatbelt sandbox
# Source this file from ~/.config/fish/config.fish:
#   source ~/Documents/Development/tools/sandbox/cco-permissions.fish
#
# Dependencies:
#   - claude-sandbox (symlinked to ~/.local/bin/)
#   - sandbox-request (symlinked to ~/.local/bin/)
#   - dirs file (tools/sandbox/dirs)
#   - ab (for browser preflight, optional)
#   - cmux (for session auto-resume via $CMUX_PANEL_ID, optional)
#
# Flags (consumed here, not forwarded to claude):
#   --no-sandbox    Skip Seatbelt entirely — run `claude` directly with the
#                   usual CCO_SESSION_ID / cmux auto-resume / browser preflight
#                   still in place. Use when the sandbox is getting in the way
#                   of an exploratory session.

function cco-permissions
    # Pull out our own flags before touching $argv further.
    set -l skip_sandbox false
    if contains -- --no-sandbox $argv
        set skip_sandbox true
        set argv (string match -v -- --no-sandbox $argv)
    end

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

    # Auto-resume keyed by cmux's stable panel UUID ($CMUX_PANEL_ID).
    # The UUID survives renames, restarts, and auto-titles — no name hashing,
    # no human-name detection, no rename heal logic needed.
    set -l extra_args
    if test -n "$CMUX_PANEL_ID" -a "$has_resume_flag" != true
        set -l mapping_file ~/.cmux/claude-sessions/$CMUX_PANEL_ID
        if test -f $mapping_file
            set -l saved_sid (cat $mapping_file)
            # Validate the saved session still exists on disk
            set -l session_jsonl (find ~/.claude/projects -maxdepth 2 -name "$saved_sid.jsonl" -type f 2>/dev/null | head -1)
            if test -z "$session_jsonl"
                echo "cmux: saved session $saved_sid no longer exists on disk — removing stale mapping, starting fresh"
                rm -f $mapping_file
            else
                echo "Resuming session for panel $CMUX_PANEL_ID: $saved_sid"
                set -a extra_args --resume $saved_sid
                set session_id $saved_sid
            end
        else
            echo "cmux: no saved session for panel $CMUX_PANEL_ID — starting fresh"
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
end
