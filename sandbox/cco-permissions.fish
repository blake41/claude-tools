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

    # Parse --resume/--continue from argv so we can track the resumed session
    # id for CCO_SESSION_ID and the sandbox-expansion restart loop below.
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

    # Auto-resume is handled by cmux's autoResumeAgentSessions: it types
    # `claude --resume <id>`, which the `claude` fish function (defined below)
    # intercepts and routes through cco-permissions. Manual invocation of
    # cco-permissions always starts a fresh session unless --resume is explicit.
    set -l extra_args

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

    # Persist the chosen mode so a later auto-resume (cmux's
    # autoResumeAgentSessions, via the claude() interceptor below) can boot
    # back into the same mode instead of always forcing sandboxed.
    set -l mode_dir ~/.cmux/claude-sessions/mode
    mkdir -p $mode_dir
    if $skip_sandbox
        echo "no-sandbox" >$mode_dir/$session_id
    else
        echo "sandboxed" >$mode_dir/$session_id
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
        # `command` bypasses the claude() interceptor function below — bare
        # `claude` would re-enter it (CMUX_SURFACE_ID + --resume) and recurse
        # through cco-permissions forever. The sandboxed path is immune only
        # because claude-sandbox execvp's the binary directly.
        command claude --dangerously-skip-permissions $extra_args $argv
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

# Intercept `claude --resume <id>` typed by cmux's autoResumeAgentSessions so
# restored sessions boot back into whichever mode (sandboxed or --no-sandbox)
# they were last launched with. Falls through to the real binary for all
# other invocations (non-cmux, no resume flag, etc.).
# claude-sandbox uses execvp internally so this function is never re-entered.
function claude
    if test -n "$CMUX_SURFACE_ID"; and test (count $argv) -gt 0
        for i in (seq 1 (count $argv))
            set -l flag $argv[$i]
            if test "$flag" = --resume -o "$flag" = -r -o "$flag" = --continue -o "$flag" = -c
                # Pass the resume flag + session ID to cco-permissions, restoring
                # whatever mode (sandboxed / --no-sandbox) that session id was
                # last explicitly launched with — see Task 2 in
                # HANDOFF-sandbox-mode-persistence.md for why this can't
                # distinguish cmux auto-resume from a bare manual resume (both
                # are byte-identical at the shell level), and why that's fine.
                set -l next (math $i + 1)
                set -l resume_id ""
                if test $next -le (count $argv)
                    set resume_id $argv[$next]
                end
                set -l resume_extra
                set -l mode_file ~/.cmux/claude-sessions/mode/$resume_id
                if test -f $mode_file
                    if test (cat $mode_file) = "no-sandbox"
                        set resume_extra --no-sandbox
                    end
                end
                if test -n "$resume_id"
                    cco-permissions $resume_extra $flag $resume_id
                else
                    cco-permissions $resume_extra $flag
                end
                return
            end
        end
    end
    command claude $argv
end
