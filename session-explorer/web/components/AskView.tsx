import { useState, useRef, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import SessionCard from "./SessionCard";
import type { ChatMessage, ChatResult, SessionSummary, Tag } from "../types";

// ── Markdown helpers ──────────────────────────────────────────────────

function inlineMarkdown(text: string): string {
  return text
    .replace(/`([^`]+)`/g, '<code class="inline-code">$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\*([^*]+)\*/g, "<em>$1</em>");
}

function chatMarkdown(text: string): string {
  return text
    .split("\n")
    .map((line) => {
      if (!line.trim()) return "";
      if (/^\s*\|.*\|.*\|\s*$/.test(line)) return "";
      if (/^\s*\|[-:|]+\|\s*$/.test(line)) return "";
      if (/^\s*[-*]\s/.test(line)) {
        return `<li style="margin-left:12px;list-style:disc;margin-bottom:2px">${inlineMarkdown(line.replace(/^\s*[-*]\s/, ""))}</li>`;
      }
      if (/^\s*\d+\.\s/.test(line)) {
        return `<li style="margin-left:12px;list-style:decimal;margin-bottom:2px">${inlineMarkdown(line.replace(/^\s*\d+\.\s/, ""))}</li>`;
      }
      return `<p style="margin-bottom:4px">${inlineMarkdown(line)}</p>`;
    })
    .filter(Boolean)
    .join("");
}

function renderMarkdown(text: string): string {
  return text
    .split("\n")
    .map((line) => {
      if (!line.trim()) return "<br/>";
      if (/^\s*\|.*\|.*\|\s*$/.test(line)) return "";
      if (/^\s*\|[-:|]+\|\s*$/.test(line)) return "";
      if (/^\s*[-*]\s/.test(line)) {
        const content = line.replace(/^\s*[-*]\s/, "");
        return `<li>${inlineMarkdown(content)}</li>`;
      }
      if (/^\s*\d+\.\s/.test(line)) {
        const content = line.replace(/^\s*\d+\.\s/, "");
        return `<li>${inlineMarkdown(content)}</li>`;
      }
      return `<p>${inlineMarkdown(line)}</p>`;
    })
    .filter(Boolean)
    .join("\n");
}

// ── Utility functions ─────────────────────────────────────────────────

type SortKey = "date" | "duration" | "messages";

function getDurationMs(s: SessionSummary): number {
  if (!s.ended_at) return 0;
  return new Date(s.ended_at).getTime() - new Date(s.started_at).getTime();
}

function formatDurationShort(ms: number): string {
  const mins = Math.round(ms / 60000);
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  const rem = mins % 60;
  return rem > 0 ? `${hrs}h ${rem}m` : `${hrs}h`;
}

// ── Sub-components ────────────────────────────────────────────────────

function LiveQuery({ query, rowCount }: { query: string; rowCount: number | null }) {
  return (
    <div className="flex items-start gap-2 text-[11px] text-text-dim">
      <span className={`mt-0.5 shrink-0 inline-block w-1.5 h-1.5 rounded-full ${rowCount !== null ? "bg-accent-green" : "bg-accent-yellow animate-pulse"}`} />
      <span className="font-mono break-all">
        {query.length > 100 ? query.slice(0, 100) + "..." : query}
        {rowCount !== null && <span className="text-text-secondary ml-1.5">{rowCount} rows</span>}
      </span>
    </div>
  );
}

interface LiveQueryState {
  query: string;
  rowCount: number | null;
}

function ReasoningCard({ result }: { result: ChatResult }) {
  const [queriesOpen, setQueriesOpen] = useState(false);

  if (!result.explanation && !result.queries?.length) return null;

  return (
    <div className="mb-6 rounded-lg overflow-hidden border border-accent-blue/15 bg-gradient-to-b from-accent-blue/5 to-transparent">
      {result.explanation && (
        <div className="px-5 py-4">
          <div className="flex items-center gap-2 mb-3">
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" className="text-accent-blue">
              <path d="M8 1.5a6.5 6.5 0 100 13 6.5 6.5 0 000-13zM8 5v4M8 11h.01" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
            <span className="text-[12px] font-semibold text-accent-blue tracking-wide">How this was found</span>
          </div>
          <div
            className="message-content text-[13px] text-text-secondary leading-relaxed [&>p]:mb-1.5 [&>li]:mb-1 [&>li]:ml-4 [&>li]:list-disc [&>br]:hidden [&_strong]:text-text [&_code.inline-code]:text-accent-orange [&_code.inline-code]:text-[12px] [&_code.inline-code]:bg-white/8 [&_code.inline-code]:px-1.5 [&_code.inline-code]:py-0.5 [&_code.inline-code]:rounded"
            dangerouslySetInnerHTML={{ __html: renderMarkdown(result.explanation) }}
          />
        </div>
      )}
      {result.queries && result.queries.length > 0 && (
        <div className={`px-5 py-3 ${result.explanation ? "border-t border-border/50" : ""}`}>
          <button
            className="text-[11px] text-text-dim hover:text-text-secondary transition-colors flex items-center gap-1.5"
            onClick={() => setQueriesOpen(!queriesOpen)}
          >
            <svg
              width="10" height="10" viewBox="0 0 10 10" fill="none"
              className={`transition-transform ${queriesOpen ? "rotate-90" : ""}`}
            >
              <path d="M3 1L7 5L3 9" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            {result.queries.length} SQL quer{result.queries.length === 1 ? "y" : "ies"} executed
          </button>
          {queriesOpen && (
            <div className="mt-2 space-y-1.5">
              {result.queries.map((q, i) => (
                <pre
                  key={i}
                  className="text-[11px] leading-relaxed text-text-dim bg-black/30 rounded-md px-3 py-2 overflow-x-auto whitespace-pre-wrap break-all font-mono border border-border/30"
                >
                  {q}
                </pre>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Main AskView ──────────────────────────────────────────────────────

export default function AskView() {
  const navigate = useNavigate();

  // Chat state
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [streamingText, setStreamingText] = useState("");
  const [liveQueries, setLiveQueries] = useState<LiveQueryState[]>([]);
  const abortRef = useRef<AbortController | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const streamRef = useRef<HTMLDivElement>(null);

  // Results state
  const [currentResult, setCurrentResult] = useState<ChatResult | null>(null);
  const [sessions, setSessions] = useState<(SessionSummary & { workspace_name?: string })[]>([]);
  const [sessionsLoading, setSessionsLoading] = useState(false);
  const [applying, setApplying] = useState(false);

  // Save as smart tag
  const [showSaveSearch, setShowSaveSearch] = useState(false);
  const [saveTagName, setSaveTagName] = useState("");
  const [saveTagColor, setSaveTagColor] = useState("#58a6ff");
  const [saving, setSaving] = useState(false);

  // Sort/filter
  const [sortKey, setSortKey] = useState<SortKey>("date");
  const [minDuration, setMinDuration] = useState(0);
  const [minMessages, setMinMessages] = useState(0);

  // Focus input on mount
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Auto-scroll streaming area
  useEffect(() => {
    if (loading && streamRef.current) {
      streamRef.current.scrollIntoView({ behavior: "smooth", block: "end" });
    }
  }, [streamingText, liveQueries, loading]);

  // Fetch sessions when result changes
  useEffect(() => {
    if (!currentResult || currentResult.session_ids.length === 0) {
      setSessions([]);
      return;
    }

    setSessionsLoading(true);
    fetch("/api/sessions/bulk", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids: currentResult.session_ids }),
    })
      .then((r) => r.json())
      .then((data) => setSessions(data.sessions || []))
      .catch(() => setSessions([]))
      .finally(() => setSessionsLoading(false));
  }, [currentResult]);

  async function sendMessage() {
    const text = input.trim();
    if (!text || loading) return;

    const userMsg: ChatMessage = { role: "user", content: text };
    const newMessages = [...messages, userMsg];
    setMessages(newMessages);
    setInput("");
    setLoading(true);
    setStreamingText("");
    setLiveQueries([]);
    setCurrentResult(null);
    setSessions([]);

    const abort = new AbortController();
    abortRef.current = abort;

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: newMessages.map((m) => ({
            role: m.role,
            content: m.content,
          })),
        }),
        signal: abort.signal,
      });

      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || "Request failed");
      }

      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let accText = "";
      let accQueries: string[] = [];
      let finalResult: ChatResult | undefined;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        let eventType = "";
        for (const line of lines) {
          if (line.startsWith("event: ")) {
            eventType = line.slice(7);
          } else if (line.startsWith("data: ")) {
            const data = JSON.parse(line.slice(6));

            if (eventType === "text") {
              accText += data.text;
              setStreamingText(accText);
            } else if (eventType === "query") {
              accQueries = [...accQueries, data.query];
              setLiveQueries((prev) => [...prev, { query: data.query, rowCount: null }]);
            } else if (eventType === "query_result") {
              setLiveQueries((prev) =>
                prev.map((q) =>
                  q.query === data.query ? { ...q, rowCount: data.row_count } : q
                )
              );
            } else if (eventType === "done") {
              finalResult = data.result || undefined;
              if (data.queries) accQueries = data.queries;
            } else if (eventType === "error") {
              throw new Error(data.error);
            }
            eventType = "";
          }
        }
      }

      // Strip <result> block from display text
      const displayContent = accText
        .replace(/<result>\s*[\s\S]*?\s*<\/result>/g, "")
        .trim();

      // Attach explanation + queries to result
      if (finalResult) {
        finalResult.explanation = displayContent;
        finalResult.queries = accQueries.length > 0 ? accQueries : undefined;
      }

      const assistantMsg: ChatMessage = {
        role: "assistant",
        content: displayContent,
        result: finalResult,
        queries: accQueries.length > 0 ? accQueries : undefined,
      };
      setMessages([...newMessages, assistantMsg]);

      if (finalResult) {
        setCurrentResult(finalResult);
      }
    } catch (err: unknown) {
      if (abort.signal.aborted) return;
      const msg = err instanceof Error ? err.message : String(err);
      setMessages([
        ...newMessages,
        { role: "assistant", content: `Error: ${msg}` },
      ]);
    } finally {
      setLoading(false);
      setStreamingText("");
      setLiveQueries([]);
      abortRef.current = null;
    }
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  }

  async function handleApply() {
    if (!currentResult?.action || applying) return;
    setApplying(true);

    try {
      const action = currentResult.action;

      if (action.type === "add_tag") {
        for (const sessionId of currentResult.session_ids) {
          const body: Record<string, unknown> = {};
          if (action.tag_id) {
            body.tag_id = action.tag_id;
          } else if (action.tag_name) {
            body.name = action.tag_name;
            if (action.tag_color) body.color = action.tag_color;
          }

          await fetch(`/api/sessions/${sessionId}/tags`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          });
        }

        const tagsRes = await fetch("/api/tags");
        const tags: Tag[] = await tagsRes.json();
        const tag = tags.find(
          (t) => t.id === action.tag_id || t.name === action.tag_name
        );

        if (tag) {
          navigate(`/tag/${encodeURIComponent(tag.name)}`);
        } else {
          navigate("/");
        }
      } else if (action.type === "remove_tag") {
        for (const sessionId of currentResult.session_ids) {
          if (action.tag_id) {
            await fetch(`/api/sessions/${sessionId}/tags/${action.tag_id}`, {
              method: "DELETE",
            });
          }
        }
        navigate("/");
      }
    } catch (err) {
      console.error("Apply failed:", err);
    } finally {
      setApplying(false);
    }
  }

  async function handleSaveSearch() {
    if (!saveTagName.trim() || saving) return;
    setSaving(true);

    try {
      // Find the original user query that produced these results
      const lastUserMsg = [...messages].reverse().find((m) => m.role === "user");
      if (!lastUserMsg) return;

      const body: Record<string, unknown> = {
        tag_name: saveTagName.trim(),
        tag_color: saveTagColor,
        query_text: lastUserMsg.content,
      };

      const res = await fetch("/api/saved-searches", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const err = await res.json();
        alert(err.error || "Failed to save search");
        return;
      }

      const savedSearch = await res.json();

      // Now run the saved search to populate the tag
      await fetch(`/api/saved-searches/${savedSearch.id}/run`, { method: "POST" });

      // Navigate to the tag
      navigate(`/tag/${encodeURIComponent(saveTagName.trim())}`);
    } catch (err) {
      console.error("Save search failed:", err);
    } finally {
      setSaving(false);
      setShowSaveSearch(false);
    }
  }

  // Compute filtered/sorted sessions
  const filtered = sessions.filter((s) => {
    if (minDuration > 0) {
      const dur = getDurationMs(s) / 60000;
      if (dur < minDuration) return false;
    }
    if (minMessages > 0 && s.user_message_count < minMessages) return false;
    return true;
  });

  const sorted = [...filtered].sort((a, b) => {
    if (sortKey === "duration") return getDurationMs(b) - getDurationMs(a);
    if (sortKey === "messages") return b.user_message_count - a.user_message_count;
    return new Date(b.started_at).getTime() - new Date(a.started_at).getTime();
  });

  const byWorkspace = new Map<string, (SessionSummary & { workspace_name?: string })[]>();
  for (const s of sorted) {
    const key = s.workspace_name || "Unknown";
    if (!byWorkspace.has(key)) byWorkspace.set(key, []);
    byWorkspace.get(key)!.push(s);
  }

  const durations = sessions.map(getDurationMs).filter((d) => d > 0);
  const avgDuration = durations.length > 0 ? durations.reduce((a, b) => a + b, 0) / durations.length : 0;
  const filteredCount = filtered.length;
  const hiddenCount = sessions.length - filteredCount;

  // Previous conversation turns (all except the last assistant message that produced current results)
  const previousTurns = messages.slice(0, -1);
  const hasResults = currentResult && currentResult.session_ids.length > 0;
  const hasAnyResponse = messages.length > 0 && messages[messages.length - 1].role === "assistant";
  const lastAssistant = hasAnyResponse ? messages[messages.length - 1] : null;

  const isIdle = messages.length === 0 && !loading;

  return (
    <div className="px-10 py-8 max-w-[1200px] mx-auto">
      {/* Search bar */}
      <div className={`transition-all duration-300 ${isIdle ? "pt-[15vh]" : "pt-0"}`}>
        {isIdle && (
          <div className="text-center mb-6">
            <h1 className="text-[28px] font-semibold tracking-tight text-text">Ask your sessions</h1>
            <p className="text-text-secondary text-[14px] mt-1">Search with natural language, find patterns, tag in bulk</p>
          </div>
        )}
        <div className="relative">
          <textarea
            ref={inputRef}
            className={`w-full bg-bg-card border border-border rounded-xl outline-none text-[15px] text-text resize-none font-[var(--font-ui)] transition-all placeholder:text-text-dim focus:border-accent-blue/60 focus:shadow-[0_0_0_3px_rgba(88,166,255,0.08)] ${
              isIdle ? "px-5 py-4 min-h-[56px]" : "px-4 py-3 min-h-[44px]"
            }`}
            rows={isIdle ? 2 : 1}
            placeholder={isIdle
              ? 'e.g. "sessions that modified auth files last week" or "tag all React refactors"'
              : "Ask a follow-up..."
            }
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            disabled={loading}
          />
          <button
            className="absolute right-3 bottom-3 p-1.5 bg-accent-blue text-white rounded-lg transition-opacity hover:opacity-85 disabled:opacity-30"
            onClick={sendMessage}
            disabled={loading || !input.trim()}
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
              <path
                d="M14 2L7 9M14 2L9.5 14L7 9M14 2L2 6.5L7 9"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
        </div>
      </div>

      {/* Previous conversation turns (compact) */}
      {previousTurns.length > 0 && (
        <div className="mt-4 mb-2 flex flex-col gap-1">
          {previousTurns.map((msg, i) => (
            <div key={i} className="flex items-start gap-2">
              <span className={`text-[10px] font-semibold uppercase tracking-wider mt-0.5 shrink-0 w-8 ${
                msg.role === "user" ? "text-accent-blue" : "text-text-dim"
              }`}>
                {msg.role === "user" ? "You" : "AI"}
              </span>
              <span className="text-[12px] text-text-secondary line-clamp-1">
                {msg.content.length > 120 ? msg.content.slice(0, 120) + "..." : msg.content}
              </span>
            </div>
          ))}
        </div>
      )}

      {/* Live streaming area */}
      {loading && (
        <div ref={streamRef} className="mt-6 mb-4">
          {/* Live queries */}
          {liveQueries.length > 0 && (
            <div className="bg-white/4 rounded-lg px-4 py-3 space-y-1.5 mb-3">
              {liveQueries.map((q, i) => (
                <LiveQuery key={i} query={q.query} rowCount={q.rowCount} />
              ))}
            </div>
          )}

          {/* Streaming text */}
          {streamingText ? (
            <div className="rounded-lg px-4 py-3 text-[13px] leading-relaxed bg-white/4 text-text-secondary">
              <span
                dangerouslySetInnerHTML={{
                  __html: chatMarkdown(
                    streamingText.replace(/<result>\s*[\s\S]*?\s*<\/result>/g, "").trim()
                  ),
                }}
              />
              <span className="inline-block w-1.5 h-3.5 bg-text-secondary/60 animate-pulse ml-0.5 -mb-0.5" />
            </div>
          ) : (
            <div className="rounded-lg px-4 py-3 text-[13px] text-text-dim flex items-center gap-2">
              <div className="spinner small" />
              {liveQueries.length > 0 ? "Analyzing results..." : "Thinking..."}
            </div>
          )}
        </div>
      )}

      {/* Completed response (no sessions) */}
      {!loading && lastAssistant && !hasResults && (
        <div className="mt-6 rounded-lg px-4 py-3 text-[13px] leading-relaxed bg-white/4 text-text-secondary">
          <span dangerouslySetInnerHTML={{ __html: chatMarkdown(lastAssistant.content) }} />
        </div>
      )}

      {/* Results section */}
      {!loading && hasResults && currentResult && (
        <div className="mt-6">
          {/* Header row with count + apply button */}
          <div className="flex items-center justify-between mb-4">
            <div>
              <h2 className="text-[20px] font-semibold tracking-tight">
                {filteredCount} session{filteredCount !== 1 ? "s" : ""}
                {hiddenCount > 0 && (
                  <span className="text-[14px] font-normal text-text-dim ml-2">
                    ({hiddenCount} filtered out)
                  </span>
                )}
              </h2>
              {currentResult.action && (
                <p className="text-[13px] text-text-secondary mt-0.5">
                  {currentResult.action.type === "add_tag"
                    ? `Tag with "${currentResult.action.tag_name || "tag"}"`
                    : currentResult.action.type === "remove_tag"
                      ? `Remove tag "${currentResult.action.tag_name || "tag"}"`
                      : currentResult.action.type}
                </p>
              )}
            </div>
            <div className="flex items-center gap-2">
              {currentResult.action && filteredCount > 0 && (
                <button
                  className="px-4 py-2 bg-accent-blue text-white rounded-lg text-[13px] font-medium transition-opacity hover:opacity-85 disabled:opacity-40"
                  onClick={handleApply}
                  disabled={applying}
                >
                  {applying ? "Applying..." : `Apply to ${filteredCount} session${filteredCount !== 1 ? "s" : ""}`}
                </button>
              )}
              {filteredCount > 0 && (
                <button
                  className="px-4 py-2 bg-white/8 text-text rounded-lg text-[13px] font-medium transition-all hover:bg-white/12 disabled:opacity-40"
                  onClick={() => {
                    setShowSaveSearch(!showSaveSearch);
                    if (!saveTagName && currentResult?.action?.tag_name) {
                      setSaveTagName(currentResult.action.tag_name);
                    }
                  }}
                  disabled={saving}
                >
                  Save as smart tag
                </button>
              )}
            </div>
          </div>

          {/* Save as smart tag form */}
          {showSaveSearch && (
            <div className="mb-4 p-4 rounded-lg border border-border bg-white/4">
              <div className="text-[12px] font-semibold text-text-secondary mb-2">Save as smart tag</div>
              <p className="text-[11px] text-text-dim mb-3">This query will be saved and can be re-run later to keep the tag's membership current.</p>
              <div className="flex items-end gap-3">
                <div className="flex-1">
                  <label className="text-[11px] text-text-dim block mb-1">Tag name</label>
                  <input
                    type="text"
                    className="w-full px-3 py-1.5 bg-white/6 border border-border rounded-md outline-none text-[13px] text-text font-[var(--font-ui)] focus:border-accent-blue"
                    placeholder="e.g. react-refactors"
                    value={saveTagName}
                    onChange={(e) => setSaveTagName(e.target.value)}
                    autoFocus
                  />
                </div>
                <div className="flex gap-1">
                  {["#58a6ff", "#3fb950", "#bc8cff", "#d29922", "#f85149"].map((c) => (
                    <button
                      key={c}
                      type="button"
                      className={`w-[22px] h-[22px] rounded-full border-2 transition-[border-color] duration-100 hover:border-text-secondary ${c === saveTagColor ? "border-text" : "border-transparent"}`}
                      style={{ background: c }}
                      onClick={() => setSaveTagColor(c)}
                    />
                  ))}
                </div>
                <button
                  className="px-4 py-1.5 bg-accent-blue text-white rounded-md text-[12px] font-medium transition-opacity hover:opacity-85 disabled:opacity-40 whitespace-nowrap"
                  onClick={handleSaveSearch}
                  disabled={saving || !saveTagName.trim()}
                >
                  {saving ? "Saving..." : "Save"}
                </button>
                <button
                  className="px-3 py-1.5 text-text-secondary rounded-md text-[12px] transition-all hover:bg-white/8"
                  onClick={() => setShowSaveSearch(false)}
                >
                  Cancel
                </button>
              </div>
            </div>
          )}

          {/* Sort & Filter controls */}
          <div className="flex flex-wrap items-center gap-3 mb-5 pb-4 border-b border-border">
            <div className="flex items-center gap-1.5">
              <span className="text-[11px] text-text-dim font-medium uppercase tracking-wider">Sort</span>
              {(["date", "duration", "messages"] as SortKey[]).map((key) => (
                <button
                  key={key}
                  className={`px-2.5 py-1 rounded-md text-[12px] font-medium transition-all ${
                    sortKey === key
                      ? "bg-accent-blue/15 text-accent-blue"
                      : "text-text-secondary hover:bg-white/6 hover:text-text"
                  }`}
                  onClick={() => setSortKey(key)}
                >
                  {key === "date" ? "Newest" : key === "duration" ? "Longest" : "Most Q&A"}
                </button>
              ))}
            </div>

            <div className="w-px h-5 bg-border" />

            <div className="flex items-center gap-1.5">
              <span className="text-[11px] text-text-dim font-medium uppercase tracking-wider">Min</span>
              {[0, 5, 15, 30, 60].map((mins) => (
                <button
                  key={mins}
                  className={`px-2 py-1 rounded-md text-[12px] font-medium transition-all ${
                    minDuration === mins
                      ? "bg-accent-green/15 text-accent-green"
                      : "text-text-secondary hover:bg-white/6 hover:text-text"
                  }`}
                  onClick={() => setMinDuration(mins)}
                >
                  {mins === 0 ? "Any" : mins < 60 ? `${mins}m` : "1h"}
                </button>
              ))}
            </div>

            <div className="w-px h-5 bg-border" />

            <div className="flex items-center gap-1.5">
              <span className="text-[11px] text-text-dim font-medium uppercase tracking-wider">Q&A</span>
              {[0, 3, 5, 10, 20].map((n) => (
                <button
                  key={n}
                  className={`px-2 py-1 rounded-md text-[12px] font-medium transition-all ${
                    minMessages === n
                      ? "bg-accent-purple/15 text-accent-purple"
                      : "text-text-secondary hover:bg-white/6 hover:text-text"
                  }`}
                  onClick={() => setMinMessages(n)}
                >
                  {n === 0 ? "Any" : `${n}+`}
                </button>
              ))}
            </div>

            {avgDuration > 0 && (
              <>
                <div className="w-px h-5 bg-border" />
                <span className="text-[11px] text-text-dim">
                  avg duration: {formatDurationShort(avgDuration)}
                </span>
              </>
            )}
          </div>

          {/* Reasoning card */}
          <ReasoningCard result={currentResult} />

          {/* Sessions loading */}
          {sessionsLoading && (
            <div className="flex flex-col items-center justify-center gap-3 p-10 text-text-secondary">
              <div className="spinner" />
              <span>Loading sessions...</span>
            </div>
          )}

          {/* Session list grouped by workspace */}
          {!sessionsLoading && Array.from(byWorkspace.entries()).map(([workspace, items]) => (
            <div key={workspace} className="mb-6">
              <h3 className="text-[11px] font-semibold uppercase tracking-wider text-text-dim pb-2 border-b border-border mb-2">
                {workspace}
              </h3>
              <div className="session-rows">
                {items.map((session) => (
                  <SessionCard key={session.id} session={session} />
                ))}
              </div>
            </div>
          ))}

          {!sessionsLoading && filteredCount === 0 && (
            <div className="flex items-center justify-center px-5 py-15 text-text-secondary text-sm">
              {sessions.length === 0
                ? "No sessions found for the given IDs."
                : "All sessions filtered out. Try relaxing the filters."}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
