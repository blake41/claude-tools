#!/bin/bash
# Claude Code statusline with background-activity awareness.
# Arena synthesis (base: candidate 0; grafts from candidates 1 and 3, see SYNTHESIS.md).
# Derived from cc-statusline v1.4.0 (directory, model, git, context)
# plus: running subagents, dynamic workflows, monitors, background shells, cost, cache TTL.
# Set "refreshInterval": 3 in settings.json statusLine so counts update while the main thread idles.
#
# Pure bash + jq. No LLM calls. Fast on every refresh:
#   - one jq call parses the stdin JSON
#   - the transcript is parsed incrementally (only bytes appended since the last run),
#     with the parsed task ledger cached on disk keyed by session_id
#   - git and the rendered activity line are cached for a few seconds
#
# Liveness model (see RATIONALE.md):
#   launch  = tool_use + toolUseResult in the transcript (Agent/Workflow/Monitor/Bash bg/TaskStop)
#   done    = <task-notification> with status completed|failed|killed, TaskStop, OR an on-disk
#             completion marker: "[exited with code N]" / "[killed]" at the end of the task
#             output file, a SubagentStop hook line at the end of the agent transcript, a
#             non-empty workflow output file, or a workflow journal with no unfinished agents
#   stale   = no completion evidence, but no file activity for longer than a per-type cutoff
#             (agents 30m, workflows 60m, monitors their own timeout + 90s). Shells: a process
#             holding <id>.output open (lsof) is proof of life; no holder = gone. The 3h cutoff
#             applies only when lsof is unavailable.
#   shells  = only ids a transcript declared as background (main transcript backgroundTaskId, or
#             "Command running in background" text in a subagent transcript). Never adopt a bare
#             registry file: an in-flight foreground command's output file is also held open.
#
# Env knobs: STATUSLINE_ACTIVITY=0 disables the activity engine; STATUSLINE_DEBUG=1 logs to
# $CACHE_DIR/debug.log; STATUSLINE_AGENT_STALE/WORKFLOW_STALE/SHELL_STALE/CACHE_TTL in seconds.

input=$(cat)
command -v jq >/dev/null 2>&1 || { printf '📁 %s\n' "${PWD/#$HOME/~}"; exit 0; }

umask 077
now=$(date +%s)
CACHE_DIR="${XDG_CACHE_HOME:-$HOME/.cache}/claude-statusline"
mkdir -p "$CACHE_DIR" 2>/dev/null
# Refuse a symlinked or foreign-owned cache dir: run without caches instead of writing through it.
NOCACHE=0
if [ -L "$CACHE_DIR" ] || [ ! -O "$CACHE_DIR" ]; then NOCACHE=1; STATUSLINE_ACTIVITY=0; fi
TTL="${STATUSLINE_CACHE_TTL:-3}"
AGENT_STALE="${STATUSLINE_AGENT_STALE:-1800}"
WORKFLOW_STALE="${STATUSLINE_WORKFLOW_STALE:-3600}"
SHELL_STALE="${STATUSLINE_SHELL_STALE:-10800}"
FSONLY_STALE="${STATUSLINE_FSONLY_STALE:-900}"

dbg() { [ "${STATUSLINE_DEBUG:-0}" = "1" ] && printf '[%s] %s\n' "$(date '+%H:%M:%S')" "$*" >> "$CACHE_DIR/debug.log"; return 0; }

# ---- portable mtime / size ----
if stat -c %Y / >/dev/null 2>&1; then
  mtime() { stat -c %Y "$1" 2>/dev/null || echo 0; }
  lmtime() { stat -c %Y "$1" 2>/dev/null || echo 0; }          # symlink itself (GNU stat does not follow)
  fsize() { stat -c %s "$1" 2>/dev/null || echo 0; }
else
  mtime() { stat -L -f %m "$1" 2>/dev/null || echo 0; }
  lmtime() { stat -f %m "$1" 2>/dev/null || echo 0; }
  fsize() { stat -L -f %z "$1" 2>/dev/null || echo 0; }
fi
age_of() { local m; m=$(mtime "$1"); [ "$m" -gt 0 ] && echo $((now - m)) || echo 999999999; }
fmt_dur() { local s=$1; if [ "$s" -lt 60 ]; then echo "${s}s"; elif [ "$s" -lt 3600 ]; then echo "$((s/60))m"; else echo "$((s/3600))h$(printf '%02d' $(( (s%3600)/60 )))m"; fi; }

# ---- colors ----
use_color=1; [ -n "$NO_COLOR" ] && use_color=0
c() { [ "$use_color" -eq 1 ] && printf '\033[%sm' "$1"; }
rst() { [ "$use_color" -eq 1 ] && printf '\033[0m'; }
C_DIR='38;5;117'; C_MODEL='38;5;147'; C_CCV='38;5;249'; C_STYLE='38;5;245'; C_SESSION='38;5;110'
C_GIT='38;5;150'; C_COST='38;5;180'; C_CACHE='38;5;111'; C_COLD='38;5;245'; C_ACT='38;5;215'; C_ACTDIM='38;5;180'

# ---- parse stdin once ----
# One jq call emits a tab-separated record; empty fields become "".
# Fields are joined with \x1f (unit separator): unlike tab, a non-whitespace IFS does not
# collapse consecutive empty fields, so an absent output_style cannot shift the columns.
IFS=$'\x1f' read -r current_dir model_name session_id cc_version output_style transcript_path \
  ctx_size ctx_in ctx_cc ctx_cr used_pct cost_usd cache_warm cache_ttl cache_exp cache_hit cache_obs < <(
  printf '%s' "$input" | jq -r 'def clean: tostring | gsub("[\u0000-\u001f\u007f]"; "");
  [
    (.workspace.current_dir // .cwd // "unknown" | clean),
    (.model.display_name // .model.id // "" | clean),
    (.session_id // "" | clean),
    (.version // "" | clean),
    (.output_style.name // "" | clean),
    (.transcript_path // "" | clean),
    (.context_window.context_window_size // 200000),
    (.context_window.current_usage.input_tokens // 0),
    (.context_window.current_usage.cache_creation_input_tokens // 0),
    (.context_window.current_usage.cache_read_input_tokens // 0),
    (.context_window.used_percentage // ""),
    (.cost.total_cost_usd // ""),
    (.prompt_cache.warm // ""),
    (.prompt_cache.ttl // ""),
    (.prompt_cache.expires_at // ""),
    (.prompt_cache.hit_ratio // "" | if type == "number" then (. * 100 | round) else "" end),
    (.prompt_cache.caching_observed // "")
  ] | map(tostring) | join("\u001f")' 2>/dev/null
)
raw_dir=$current_dir
tilde='~'; current_dir="${current_dir/#$HOME/$tilde}"   # via a variable: bash 3.2 keeps quotes/backslashes in the replacement literal
[[ "$session_id" =~ ^[A-Za-z0-9_-]{1,128}$ ]] || session_id=""   # used in cache file names
STATE="$CACHE_DIR/${session_id:-nosession}.json"

# ---- git (cached a few seconds per session) ----
git_line=""
git_cache="$CACHE_DIR/${session_id:-nosession}.git"
if [ "$NOCACHE" = 0 ] && [ -f "$git_cache" ] && [ ! -L "$git_cache" ] && [ $(( now - $(mtime "$git_cache") )) -le 5 ]; then
  git_line=$(cat "$git_cache")
else
  gdir=$raw_dir; [ -d "$gdir" ] || gdir=.
  if git -C "$gdir" rev-parse --git-dir >/dev/null 2>&1; then
    git_branch=$(git -C "$gdir" symbolic-ref --quiet --short HEAD 2>/dev/null || git -C "$gdir" rev-parse --short HEAD 2>/dev/null)
    # One porcelain scan replaces three diff/ls-files forks (same counts as the original).
    staged=0; modified=0; untracked=0
    while IFS= read -r -d '' entry; do
      xy=${entry:0:2}
      if [ "$xy" = '??' ]; then untracked=$((untracked+1))
      else
        [ "${xy:0:1}" != ' ' ] && staged=$((staged+1))
        [ "${xy:1:1}" != ' ' ] && modified=$((modified+1))
        case "$xy" in *R*|*C*) IFS= read -r -d '' _oldpath ;; esac
      fi
    done < <(GIT_OPTIONAL_LOCKS=0 git -C "$gdir" status --porcelain=v1 -z --untracked-files=all 2>/dev/null)
    git_dirty=""
    [ "$staged" -gt 0 ] && git_dirty+="$(c '38;5;150')+${staged}$(rst)"
    [ "$modified" -gt 0 ] && git_dirty+="$(c '38;5;215')~${modified}$(rst)"
    [ "$untracked" -gt 0 ] && git_dirty+="$(c '38;5;245')?${untracked}$(rst)"
    [ -n "$git_branch" ] && git_line="  🌿 $(c $C_GIT)${git_branch}$(rst)${git_dirty:+ $git_dirty}"
  fi
  [ "$NOCACHE" = 0 ] && printf '%s' "$git_line" > "$git_cache" 2>/dev/null
fi

# ---- context (same formula as cc-statusline: input + cache_creation + cache_read) ----
context_pct=""; context_bar=""; ctx_color='1;37'
cur_tokens=$(( ${ctx_in:-0} + ${ctx_cc:-0} + ${ctx_cr:-0} ))
if [ "$cur_tokens" -gt 0 ] 2>/dev/null && [ "${ctx_size:-0}" -gt 0 ] 2>/dev/null; then
  rem=$(( 100 - cur_tokens * 100 / ctx_size )); (( rem < 0 )) && rem=0; (( rem > 100 )) && rem=100
  if [ "$rem" -le 20 ]; then ctx_color='38;5;203'; elif [ "$rem" -le 40 ]; then ctx_color='38;5;215'; else ctx_color='38;5;158'; fi
  context_pct="${rem}%"
  filled=$(( rem / 10 )); context_bar=""
  for ((i=0;i<filled;i++)); do context_bar+="█"; done
  for ((i=filled;i<10;i++)); do context_bar+="░"; done
fi

# ---- cost + cache segments ----
cost_seg=""
if [ -n "$cost_usd" ] && [ "$cost_usd" != "null" ]; then
  cost_seg="💰 $(c $C_COST)$(printf '$%.2f' "$cost_usd")$(rst)"
fi
cache_seg=""
left=0
if [ "$cache_warm" = "true" ] && [ -n "$cache_exp" ] && [ "$cache_exp" != "null" ]; then left=$(( ${cache_exp%.*} - now )); fi
if [ "$left" -gt 0 ]; then
  hit=""; [ -n "$cache_hit" ] && hit=" ${cache_hit}%"
  cache_seg="⚡ $(c $C_CACHE)cache ${cache_ttl:+$cache_ttl }$(printf '%d:%02d' $((left/60)) $((left%60)))${hit}$(rst)"
elif [ "$cache_obs" = "true" ]; then
  cache_seg="⚡ $(c $C_COLD)cache cold$(rst)"
fi

# ---- sandbox indicator (probe the Seatbelt directly; see cc-statusline note) ----
if ! ps -p 1 >/dev/null 2>&1; then sandbox_indicator="🔒 sandbox"; else sandbox_indicator="🔓 no sandbox"; fi

# =====================================================================================
# Background-activity engine
# =====================================================================================
activity_line=""
if [ "${STATUSLINE_ACTIVITY:-1}" != "0" ] && [ -n "$session_id" ] && [ -n "$transcript_path" ] && [ -f "$transcript_path" ]; then

  # -- 1. load / reset ledger --
  state='{"v":1,"offset":0,"pending":{},"tasks":{},"rendered_at":0,"rendered":""}'
  rendered_at=0; st_size=-1; offset=0; st_rendered=""
  if [ -f "$STATE" ]; then
    s=$(cat "$STATE" 2>/dev/null)
    IFS=$'\x1f' read -r ok rendered_at st_size offset st_rendered < <(printf '%s' "$s" | jq -r --arg t "$transcript_path" \
        '[((.v == 1 and .transcript == $t) | tostring), (.rendered_at // 0), (.size // -1), (.offset // 0), (.rendered // "")] | map(tostring) | join("\u001f")' 2>/dev/null)
    if [ "$ok" = "true" ]; then state="$s"; else rendered_at=0; st_size=-1; offset=0; st_rendered=""; fi
  fi
  size=$(fsize "$transcript_path")

  if [ $(( now - rendered_at )) -lt "$TTL" ] && [ "$st_size" = "$size" ]; then
    # Fresh enough and the transcript has not grown: reuse the last rendering.
    activity_line="$st_rendered"
    dbg "cache hit (ttl)"
  else
    [ "$offset" -gt "$size" ] && offset=0                # truncated / rotated: rescan
    chunk=$(( size - offset ))
    # Only whole lines are consumed. If the file does not end in "\n", the writer is mid-line:
    # measure that partial tail (bytes, LC_ALL=C) and leave it for the next refresh.
    consumed=$chunk
    # macOS `tail -c +N` streams byte-by-byte (~20 MB/s: 1.5 s on a 72 MB transcript). dd seeks in
    # 1 MiB blocks for free, so only the sub-MiB remainder plus the new bytes go through tail.
    read_delta() {
      if [ "$offset" -eq 0 ]; then cat "$transcript_path"
      else dd if="$transcript_path" bs=1048576 skip=$(( offset / 1048576 )) 2>/dev/null | tail -c +$(( offset % 1048576 + 1 )); fi
    }
    if [ "$chunk" -gt 0 ] && [ "$(tail -c 1 "$transcript_path" | od -An -tx1 | tr -d ' \n')" != "0a" ]; then
      partial_len=$(read_delta | LC_ALL=C awk 'END{print length($0)}')
      consumed=$(( chunk - ${partial_len:-0} ))
    fi

    # -- 2. incremental parse of the transcript delta --
    # Emits the updated ledger. Launch and completion shapes were taken from real transcripts:
    #   Agent    -> toolUseResult {status:"async_launched", agentId, description, outputFile}
    #   Workflow -> toolUseResult {status:"async_launched", taskId, taskType:"local_workflow", workflowName, transcriptDir}
    #   Monitor  -> toolUseResult {taskId, timeoutMs}
    #   Bash bg  -> toolUseResult {backgroundTaskId, timedOutAfterMs?}
    #   TaskStop -> toolUseResult {task_id, task_type}
    #   done     -> "<task-notification>…<task-id>X</task-id>…<status>completed|failed|killed</status>"
    #               in user text blocks and in queue-operation enqueue entries
    read -r -d '' JQ_UPDATE <<'JQ'
      def texts: .message.content | if type=="string" then [.] else [.[]? | select(.type=="text") | .text] end;
      def kind_from_summary: if test("^Agent ") then "agent" elif test("^Background command") then "shell"
                             elif test("^Monitor") then "monitor" elif test("workflow";"i") then "workflow" else "unknown" end;
      def apply_notif($txt; $ts):
        reduce ($txt | split("<task-notification>")[1:][]) as $p (.;
          ($p | [capture("<task-id>(?<id>[^<]+)</task-id>")] | .[0].id // null) as $id
          | ($p | [capture("<status>(?<s>[^<]+)</status>")] | .[0].s // null) as $st
          | ($p | [capture("<summary>(?<s>[^<]*)</summary>")] | .[0].s // "") as $sum
          | if $id == null then .
            elif ($st == "completed" or $st == "failed" or $st == "killed" or $st == "stopped") then
              .tasks[$id] = ((.tasks[$id] // {type: ($sum | kind_from_summary), desc: ""}) + {done: true, status: $st, done_ts: $ts})
            else (if .tasks[$id] then .tasks[$id].last_event = $ts else . end) end);
      def ts_of: (.timestamp // "") | if . == "" then null else (sub("\\.[0-9]+Z$"; "Z") | try fromdateiso8601 catch null) end;
      def watched($tu): ($tu.name == "Agent" or $tu.name == "Workflow" or $tu.name == "Monitor" or $tu.name == "TaskStop"
                         or $tu.name == "Bash");   # any Bash: a foreground command can be auto-backgrounded on timeout
      def new_task($t; $p; $ts; $extra): ((. // {}) + {type: $t, desc: ($extra.desc // $p.desc // $t), ts: ($ts // $p.ts), tuid: $p.tuid} + ($extra | del(.desc)) | .done //= false);

      reduce (inputs | fromjson? // empty) as $e ($state;
          ($e | ts_of) as $ts
          | if $e.type == "assistant" then
              reduce ($e.message.content[]? | select(.type == "tool_use") | select(watched(.))) as $tu (.;
                .pending[$tu.id] = {name: $tu.name, tuid: $tu.id, ts: $ts,
                                    desc: ($tu.input.description // $tu.input.query // $tu.input.subagent_type // $tu.name),
                                    task_id: ($tu.input.task_id // null)})
            elif $e.type == "user" then
              (reduce ($e.message.content | if type == "array" then .[] else empty end | select(.type == "tool_result")) as $tr (.;
                if .pending[$tr.tool_use_id] then
                  .pending[$tr.tool_use_id] as $p | del(.pending[$tr.tool_use_id])
                  | ($e.toolUseResult // {}) as $r | (if ($r|type) == "object" then $r else {} end) as $r
                  | if $p.name == "Agent" and ($r.agentId // null) then
                      .tasks[$r.agentId] |= new_task("agent"; $p; $ts; {desc: $r.description, out: $r.outputFile, model: $r.resolvedModel})
                    elif $p.name == "Workflow" and ($r.taskId // null) then
                      .tasks[$r.taskId] |= new_task("workflow"; $p; $ts; {desc: ($r.workflowName // $r.summary), dir: $r.transcriptDir, run_id: $r.runId})
                    elif $p.name == "Monitor" and ($r.taskId // null) then
                      .tasks[$r.taskId] |= new_task("monitor"; $p; $ts; {timeout_ms: ($r.timeoutMs // null)})
                    elif $p.name == "Bash" and ($r.backgroundTaskId // null) then
                      .tasks[$r.backgroundTaskId] |= new_task("shell"; $p; $ts; {timeout_ms: ($r.timedOutAfterMs // null)})
                    elif $p.name == "TaskStop" then
                      (($r.task_id // $p.task_id) // null) as $id
                      | if $id then .tasks[$id] = ((.tasks[$id] // {type: "unknown", desc: ""}) + {done: true, status: "killed", done_ts: $ts}) else . end
                    else . end
                else . end))
              | reduce ($e | texts[] | select(test("<task-notification>"))) as $t (.; apply_notif($t; $ts))
            elif $e.type == "queue-operation" and $e.operation == "enqueue" and (($e.content // "") | test("<task-notification>")) then
              apply_notif($e.content; $ts)
            else . end)
      | .offset = ($offset + $consumed) | .size = $size | .transcript = $tpath | .pending |= with_entries(select(.value.ts == null or .value.ts > ($now_ts - 86400)))
JQ
    if [ "$consumed" -gt 0 ]; then
      # grep keeps only lines that can carry a launch, a result, or a notification (cheap: ~60ms on 72 MB);
      # head -c bounds the read to whole lines so a partial trailing line is never parsed.
      new_state=$(read_delta | head -c "$consumed" \
                  | LC_ALL=C grep -a -E '"tool_use"|"toolUseResult"|task-notification' \
                  | jq -R -n --argjson state "$state" --argjson consumed "$consumed" --argjson offset "$offset" \
                       --argjson size "$size" --arg tpath "$transcript_path" "$JQ_UPDATE" 2>>"$CACHE_DIR/errors.log")
      if [ -n "$new_state" ]; then state="$new_state"; else dbg "jq update failed; keeping old state"; fi
    elif [ "$st_size" != "$size" ]; then
      state=$(printf '%s' "$state" | jq --arg tpath "$transcript_path" --argjson size "$size" '.size = $size | .transcript = $tpath')
    fi

    # -- 3. locate the on-disk task registry --
    sessdir="${transcript_path%.jsonl}"
    slug=$(basename "$(dirname "$transcript_path")")
    uid=$(id -u)
    tasks_dir=""
    for base in "/tmp/claude-$uid" "${TMPDIR%/}/claude-$uid"; do
      [ -n "$base" ] && [ -d "$base/$slug/$session_id/tasks" ] && { tasks_dir="$base/$slug/$session_id/tasks"; break; }
    done
    if [ -z "$tasks_dir" ]; then
      o=$(printf '%s' "$state" | jq -r '[.tasks[] | .out // empty] | .[0] // ""')
      [ -n "$o" ] && [ -d "$(dirname "$o")" ] && tasks_dir=$(dirname "$o")
    fi

    # -- 4. verify each open task against the filesystem --
    n_agent=0; n_wf=0; n_mon=0; n_sh=0; details=(); finished_ids=(); adopted=()

    LSOF_OK=""
    lsof_ok() {   # lsof present and permitted (it fails inside some sandboxes): probe once per run
      if [ -z "$LSOF_OK" ]; then
        if command -v lsof >/dev/null 2>&1 && lsof -n -P -w -p $$ >/dev/null 2>&1; then LSOF_OK=1; else LSOF_OK=0; fi
      fi
      [ "$LSOF_OK" = 1 ]
    }
    check_agent() {   # $1 id, $2 launch_ts, $3 desc  -> sets verdict=running|done|stale, extra
      local id=$1 lts=$2 f="$sessdir/subagents/agent-$1.jsonl" last a
      [ -f "$f" ] || { [ -n "$tasks_dir" ] && [ -L "$tasks_dir/$id.output" ] && f=$(readlink "$tasks_dir/$id.output"); }
      if [ -f "$f" ]; then
        a=$(age_of "$f"); last=$(tail -n 1 "$f" 2>/dev/null)
        if [[ "$last" == *'"hookEvent":"SubagentStop"'* ]]; then verdict=done
        elif [[ "$last" == *'"stop_reason":"end_turn"'* ]] && [ "$a" -gt 20 ]; then verdict=done
        elif [ "$a" -gt "$AGENT_STALE" ]; then verdict=stale
        else verdict=running; fi
      else
        # transcript not created yet (starting up) or gone
        if [ "$lts" -gt 0 ] && [ $(( now - lts )) -gt 180 ]; then verdict=stale; else verdict=running; fi
      fi
    }
    check_outfile() {   # $1 id, $2 launch_ts, $3 kind(shell|monitor), $4 timeout_ms, $5 fsonly(0|1)
      local id=$1 lts=$2 kind=$3 tmo=${4:-0} fsonly=${5:-0} f="$tasks_dir/$id.output" tailtxt a
      if [ -n "$tasks_dir" ]; then
        if [ -e "$f" ]; then
          tailtxt=$(tail -c 96 "$f" 2>/dev/null)
          if [[ "$tailtxt" == *'[exited with code'* ]] || [[ "$tailtxt" == *'[killed]'* ]]; then verdict=done; return; fi
          # No marker. A live shell keeps its output file open, so a holder is proof of life
          # (any age) and no holder means it is gone. Skip in the first seconds: file may not be open yet.
          if [ "$kind" = shell ] && [ "$lts" -gt 0 ] && [ $(( now - lts )) -gt 10 ] && lsof_ok; then
            if lsof -n -P -w -- "$f" >/dev/null 2>&1; then verdict=running; else verdict=stale; fi
            return
          fi
        elif [ "$lts" -gt 0 ] && [ $(( now - lts )) -gt 60 ]; then
          # registry exists but this task has no output file: the process is gone (e.g. reboot)
          verdict=stale; return
        fi
      fi
      a=$(( lts > 0 ? now - lts : 0 ))
      if [ "$kind" = monitor ]; then
        local limit=$(( (tmo > 0 ? tmo / 1000 : 1500) + 90 ))
        [ "$a" -gt "$limit" ] && verdict=stale || verdict=running
      else
        # A shell seen only on disk (launched by a subagent) never gets a notification in this
        # transcript, so it gets the short cutoff; a shell this session launched gets the long one.
        local limit=$SHELL_STALE; [ "$fsonly" = 1 ] && limit=$FSONLY_STALE
        [ "$a" -gt "$limit" ] && verdict=stale || verdict=running
      fi
    }
    check_workflow() {   # $1 id, $2 launch_ts, $3 dir -> verdict, extra (phase + live agent count)
      local id=$1 lts=$2 dir=$3 f="$tasks_dir/$id.output" newest live phase
      extra=""
      if [ -n "$tasks_dir" ] && [ -f "$f" ] && [ "$(fsize "$f")" -gt 0 ]; then verdict=done; return; fi
      if [ -n "$dir" ] && [ -f "$dir/journal.jsonl" ]; then
        read -r live phase < <(jq -rs '([.[] | select(.type=="started")] ) as $s | ([.[] | select(.type=="result" or .type=="failed") | .agentId]) as $d
                                | [$s[] | select(.agentId as $a | $d | index($a) | not)] | [length, (map(.phase) | unique | join("/"))] | @tsv' "$dir/journal.jsonl" 2>/dev/null)
        newest=$(ls -t "$dir" 2>/dev/null | head -1)
        local a=$(age_of "$dir/${newest:-journal.jsonl}")
        if [ "${live:-0}" -gt 0 ]; then
          extra=" [${phase}: ${live} agent$([ "$live" -ne 1 ] && echo s)]"
          [ "$a" -gt "$WORKFLOW_STALE" ] && verdict=stale || verdict=running
        else
          # between phases (harness moving fast) or finished without a notification yet
          [ "$a" -gt 300 ] && verdict=stale || verdict=running
        fi
      else
        [ "$lts" -gt 0 ] && [ $(( now - lts )) -gt 180 ] && verdict=stale || verdict=running
      fi
    }

    while IFS=$'\x1f' read -r id type lts tmo dir fsonly desc; do
      [ -z "$id" ] && continue
      verdict=running; extra=""
      case "$type" in
        agent)    check_agent "$id" "$lts" ;;
        workflow) check_workflow "$id" "$lts" "$dir" ;;
        monitor|shell) check_outfile "$id" "$lts" "$type" "$tmo" "$fsonly" ;;
        *)        verdict=stale ;;
      esac
      dbg "task $id $type -> $verdict"
      case "$verdict" in
        done)  finished_ids+=("$id") ;;
        stale) ;;
        running)
          case "$type" in agent) n_agent=$((n_agent+1));; workflow) n_wf=$((n_wf+1));; monitor) n_mon=$((n_mon+1));; shell) n_sh=$((n_sh+1));; esac
          agetxt=""; [ "$lts" -gt 0 ] && agetxt=" $(fmt_dur $(( now - lts )))"
          details+=("${desc:0:48}${extra}${agetxt}") ;;
      esac
    done < <(printf '%s' "$state" | jq -r '.tasks | to_entries | map(select(.value.done != true))
              | sort_by((.value.fsonly // false), ({agent: 0, workflow: 1, monitor: 2, shell: 3}[.value.type] // 9), (.value.ts // 0)) | .[]
              | [.key, (.value.type // "unknown"), (.value.ts // 0 | floor), (.value.timeout_ms // 0), (.value.dir // ""),
                 (if .value.fsonly then 1 else 0 end), ((.value.desc // "") | gsub("[\t\r\n\u001f]+"; " "))] | map(tostring) | join("\u001f")')

    # Tasks visible only on disk (e.g. background shells launched by a subagent, or launched
    # before the ledger existed). Adopt them so they are counted, then tracked like the rest.
    if [ -n "$tasks_dir" ]; then
      known=" $(printf '%s' "$state" | jq -r '.tasks | keys | join(" ")') "
      # Agents and workflows: recent registry entries only (one find, no per-file work on old ones).
      while IFS= read -r f; do
        [ -n "$f" ] || continue
        id=${f##*/}; id=${id%.output}
        case "$known" in *" $id "*) continue ;; esac
        lts=$(lmtime "$f"); a=$(( now - lts ))
        case "$id" in
          a*) [ -L "$f" ] || continue
              check_agent "$id" "$lts"
              if [ "$verdict" = running ]; then n_agent=$((n_agent+1)); details+=("agent $id $(fmt_dur $a)"); fi
              adopted+=("$id"$'\x1f'"agent"$'\x1f'"$lts") ;;
          w*) if [ "$(fsize "$f")" -gt 0 ]; then adopted+=("$id"$'\x1f'"workflow"$'\x1f'"$lts"$'\x1f'"done"); continue; fi
              if [ "$a" -le "$WORKFLOW_STALE" ]; then n_wf=$((n_wf+1)); details+=("workflow $id $(fmt_dur $a)"); fi
              adopted+=("$id"$'\x1f'"workflow"$'\x1f'"$lts") ;;
        esac
      done < <(find "$tasks_dir" -maxdepth 1 -name '*.output' -mmin "-$(( WORKFLOW_STALE / 60 ))" 2>/dev/null)

      # Shells launched by subagents never appear in this transcript. Take only ids that an agent
      # transcript declared as background (anchored to the start of a tool_result, so quoted text
      # elsewhere cannot match), then verify each like any other shell.
      if [ -d "$sessdir/subagents" ]; then
        RES='"type":"tool_result","content":("|\[\{"type":"text","text":")'
        BG_RE="${RES}(Command running in background with ID: |Command did not complete within its [0-9]+s timeout and was moved to the background \(ID: )[a-z0-9]+"
        sub_ids=$(find "$sessdir/subagents" -name 'agent-*.jsonl' -mmin "-$(( AGENT_STALE / 60 ))" \
                    -exec grep -h -a -o -E "$BG_RE" {} + 2>/dev/null | sed 's/.*ID: //' | sort -u)
        for id in $sub_ids; do
          case "$known" in *" $id "*) continue ;; esac
          f="$tasks_dir/$id.output"; [ -f "$f" ] && [ ! -L "$f" ] || continue
          lts=$(lmtime "$f")
          check_outfile "$id" "$lts" shell 0 1
          case "$verdict" in
            done)    adopted+=("$id"$'\x1f'"shell"$'\x1f'"$lts"$'\x1f'"done") ;;
            running) n_sh=$((n_sh+1)); details+=("shell $id $(fmt_dur $(( now - lts )))")
                     adopted+=("$id"$'\x1f'"shell"$'\x1f'"$lts") ;;
            *)       adopted+=("$id"$'\x1f'"shell"$'\x1f'"$lts") ;;
          esac
        done
      fi
    fi

    # -- 5. render --
    total=$(( n_agent + n_wf + n_mon + n_sh ))
    if [ "$total" -gt 0 ]; then
      segs=()
      [ "$n_agent" -gt 0 ] && segs+=("${n_agent} agent$([ "$n_agent" -ne 1 ] && echo s)")
      [ "$n_wf" -gt 0 ]    && segs+=("${n_wf} workflow$([ "$n_wf" -ne 1 ] && echo s)")
      [ "$n_mon" -gt 0 ]   && segs+=("${n_mon} monitor$([ "$n_mon" -ne 1 ] && echo s)")
      [ "$n_sh" -gt 0 ]    && segs+=("${n_sh} bg shell$([ "$n_sh" -ne 1 ] && echo s)")
      summary=$(IFS='·'; printf '%s' "${segs[*]}"); summary="${summary//·/ · }"
      det=$(IFS='|'; printf '%s' "${details[*]}"); det="${det//|/ · }"
      width="${COLUMNS:-140}"; budget=$(( width - ${#summary} - 12 ))
      if [ "$budget" -gt 12 ] && [ -n "$det" ]; then
        [ "${#det}" -gt "$budget" ] && det="${det:0:$((budget-1))}…"
        activity_line="⚙️  $(c $C_ACT)${summary}$(rst)  $(c $C_ACTDIM)${det}$(rst)"
      else
        activity_line="⚙️  $(c $C_ACT)${summary}$(rst)"
      fi
    fi

    # -- 6. persist ledger (mark finished, adopt fs-only, remember rendering) --
    # Build the two small JSON args in bash (ids are [a-z0-9]+, types are words, ts is an int).
    fin_json="["; for id in "${finished_ids[@]}"; do fin_json+="\"$id\","; done; fin_json="${fin_json%,}]"
    adopt_json="{"
    for row in "${adopted[@]}"; do
      IFS=$'\x1f' read -r aid atype ats adone <<<"$row"
      adopt_json+="\"$aid\":{\"type\":\"$atype\",\"ts\":${ats:-0},\"desc\":\"$atype $aid\",\"fsonly\":true,\"done\":$([ "$adone" = done ] && echo true || echo false)},"
    done
    adopt_json="${adopt_json%,}}"
    printf '%s' "$state" | jq --argjson fin "$fin_json" --argjson adopt "$adopt_json" --argjson now "$now" --arg r "$activity_line" '
        reduce $fin[] as $id (.; .tasks[$id] += {done: true, status: "fs", done_ts: $now})
        | .tasks = ($adopt + .tasks)
        | .tasks |= with_entries(if .value.done == true then .value |= {type, done, status, done_ts} else . end)
        | .rendered = $r | .rendered_at = $now' > "$STATE.tmp" 2>>"$CACHE_DIR/errors.log" && mv -f "$STATE.tmp" "$STATE"
  fi
fi

# =====================================================================================
# Output
# =====================================================================================
printf '📁 %s%s%s' "$(c $C_DIR)" "$current_dir" "$(rst)"
[ -n "$model_name" ] && [ "$model_name" != "null" ] && printf '  🤖 %s%s%s' "$(c $C_MODEL)" "$model_name" "$(rst)"
[ -n "$git_line" ] && printf '%s' "$git_line"

line_meta=""
[ -n "$session_id" ] && line_meta="🆔 $(c $C_SESSION)${session_id}$(rst)"
[ -n "$cc_version" ] && [ "$cc_version" != "null" ] && line_meta="${line_meta:+$line_meta  }📟 $(c $C_CCV)v${cc_version}$(rst)"
[ -n "$output_style" ] && [ "$output_style" != "null" ] && line_meta="${line_meta:+$line_meta  }🎨 $(c $C_STYLE)${output_style}$(rst)"
line_meta="${line_meta:+$line_meta  }${sandbox_indicator}"

if [ -n "$context_pct" ]; then
  line_ctx="🧠 $(c $ctx_color)Context Remaining: ${context_pct} [${context_bar}]$(rst)"
else
  line_ctx="🧠 $(c $ctx_color)Context Remaining: TBD$(rst)"
fi
[ -n "$cost_seg" ] && line_ctx+="  ${cost_seg}"
[ -n "$cache_seg" ] && line_ctx+="  ${cache_seg}"

printf '\n%s' "$line_meta"
printf '\n%s' "$line_ctx"
[ -n "$activity_line" ] && printf '\n%s' "$activity_line"
printf '\n'
