import { readFileSync } from "fs";

// ── Types ──────────────────────────────────────────────────────────

export interface SessionHeader {
  sessionId: string;
  date: string;
  branch: string;
  cwd: string;
  project: string;
}

export interface StrippedMessage {
  role: "user" | "assistant";
  content: string;
  timestamp: string | null;
  sequence: number;
  messageType: "text" | "tool_use" | "tool_result" | "system";
  // For tool_use and tool_result messages: the provider-assigned id that
  // links them together. Null on plain text/system messages.
  toolUseId?: string | null;
  // For tool_use only: the tool name (e.g. "Bash") and the full input JSON
  // so the UI can render per-tool views without re-parsing the content prefix.
  toolName?: string | null;
  toolInput?: string | null;
}

export interface FileReference {
  filePath: string;
  fileName: string;
  operation: 'write' | 'edit' | 'read';
  timestamp: string | null;
  sequence: number;
}

export interface ToolCall {
  toolName: string;
  inputSummary: string;
  timestamp: string | null;
  sequence: number;
}

interface ContentBlock {
  type: string;
  text?: string;
  name?: string;
  input?: { file_path?: string; [key: string]: unknown };
  [key: string]: unknown;
}

interface RawMessage {
  type?: string;
  cwd?: string;
  sessionId?: string;
  gitBranch?: string;
  timestamp?: string;
  message?: {
    role?: string;
    content?: string | ContentBlock[];
  };
  [key: string]: unknown;
}

// ── Helpers ────────────────────────────────────────────────────────

const SKIP_TYPES = new Set([
  "file-history-snapshot",
  "progress",
  "queue-operation",
  "system",
]);

function countHeaders(text: string): number {
  const matches = text.match(/^#{1,4}\s/gm);
  return matches ? matches.length : 0;
}

function isSkillInjection(text: string): boolean {
  return text.length > 2000 && countHeaders(text) > 5;
}

function isSystemContext(text: string): boolean {
  return text.length > 1500 && countHeaders(text) > 3;
}

function truncateSkill(text: string): string {
  for (const line of text.split("\n")) {
    const cleaned = line.trim().replace(/^#+\s*/, "");
    if (cleaned) return `[Skill loaded: ${cleaned}]`;
  }
  return "[Skill loaded: unknown]";
}

function truncateSystemContext(text: string): string {
  for (const line of text.split("\n")) {
    const cleaned = line.trim().replace(/^#+\s*/, "");
    if (cleaned) return `${cleaned} [system context truncated]`;
  }
  return "[system context truncated]";
}

/** Strip XML tags that leak into user/assistant text (task-notification, system-reminder, etc.) */
function stripXmlNoise(text: string): string {
  // Remove entire <task-notification>...</task-notification> blocks
  let cleaned = text.replace(/<task-notification>[\s\S]*?<\/task-notification>/g, "");
  // Remove entire <system-reminder>...</system-reminder> blocks
  cleaned = cleaned.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "");
  // Remove <output-file>...</output-file>, <tool-use-id>...</tool-use-id>, etc.
  cleaned = cleaned.replace(/<(?:output-file|tool-use-id|task-id|status|summary|result|available-deferred-tools)>[\s\S]*?<\/(?:output-file|tool-use-id|task-id|status|summary|result|available-deferred-tools)>/g, "");
  // Remove any remaining orphan XML-looking tags that are clearly not markdown
  cleaned = cleaned.replace(/<\/?(?:task-notification|system-reminder|output-file|tool-use-id|task-id|status|summary|result|available-deferred-tools)[^>]*>/g, "");
  return cleaned.trim();
}

function compactCommand(text: string): string | null {
  const cmdMatch = text.match(/<command-name>(.*?)<\/command-name>/);
  if (!cmdMatch) return null;

  const cmd = cmdMatch[1].trim().replace(/^\//, "");
  const argsMatch = text.match(/<command-args>([\s\S]*?)<\/command-args>/);
  const args = argsMatch ? argsMatch[1].trim().slice(0, 100) : "";
  return `/${cmd} ${args}`.trim();
}

function extractTextBlocks(content: string | ContentBlock[]): string[] {
  if (typeof content === "string") {
    return content.trim() ? [content] : [];
  }
  if (Array.isArray(content)) {
    return content
      .filter((b) => b.type === "text" && b.text?.trim())
      .map((b) => b.text!);
  }
  return [];
}

function hasOnlyToolResults(content: string | ContentBlock[]): boolean {
  if (!Array.isArray(content)) return false;
  const types = new Set(content.map((b) => b.type));
  return types.has("tool_result") && types.size === 1;
}

// ── Main ───────────────────────────────────────────────────────────

const FILE_TOOL_NAMES = new Set(["Write", "Edit", "Read", "write", "edit", "read"]);

function summarizeToolInput(toolName: string, input: Record<string, unknown>): string {
  switch (toolName) {
    case "Bash":
      return String(input.command || "").slice(0, 500);
    case "Read":
    case "Edit":
    case "Write":
    case "read":
    case "edit":
    case "write":
      return String(input.file_path || "");
    case "Grep":
    case "Glob":
    case "grep":
    case "glob":
      return String(input.pattern || "");
    case "Agent":
    case "agent":
      return String(input.description || input.prompt || "").slice(0, 200);
    case "ToolSearch":
      return String(input.query || "");
    default:
      try {
        return JSON.stringify(input).slice(0, 300);
      } catch {
        return "";
      }
  }
}

function extractFileName(filePath: string): string {
  const parts = filePath.split("/");
  return parts[parts.length - 1] || filePath;
}

export function stripSession(jsonlPath: string): {
  header: SessionHeader;
  messages: StrippedMessage[];
  files: FileReference[];
  toolCalls: ToolCall[];
} {
  const raw = readFileSync(jsonlPath, "utf-8");
  const lines = raw.split("\n");

  const msgs: RawMessage[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      msgs.push(JSON.parse(trimmed));
    } catch {
      // skip malformed lines
    }
  }

  // Extract header from first user message
  const header: SessionHeader = {
    sessionId: "",
    date: "",
    branch: "",
    cwd: "",
    project: "",
  };

  for (const m of msgs) {
    if (m.type === "user") {
      header.sessionId = m.sessionId || "unknown";
      header.date = (m.timestamp || "").slice(0, 10);
      header.branch = m.gitBranch || "";
      header.cwd = m.cwd || "";
      if (header.cwd) {
        const parts = header.cwd.split("/");
        header.project = parts[parts.length - 1] || "";
      }
      break;
    }
  }

  // ── Extract file references and tool calls from tool_use blocks ──
  const fileMap = new Map<string, FileReference>(); // key: "filePath|operation"
  let fileSeq = 0;
  const toolCalls: ToolCall[] = [];
  let toolSeq = 0;

  for (const m of msgs) {
    if (m.type === "assistant" && Array.isArray(m.message?.content)) {
      for (const block of m.message!.content as ContentBlock[]) {
        if (block.type === "tool_use" && block.name) {
          // Extract tool call
          const input = (block.input || {}) as Record<string, unknown>;
          toolCalls.push({
            toolName: block.name,
            inputSummary: summarizeToolInput(block.name, input),
            timestamp: m.timestamp || null,
            sequence: toolSeq++,
          });

          // Extract file reference (existing logic)
          if (FILE_TOOL_NAMES.has(block.name)) {
            const filePath = block.input?.file_path;
            if (!filePath || typeof filePath !== "string") continue;
            const operation = block.name.toLowerCase() as "write" | "edit" | "read";
            const key = `${filePath}|${operation}`;
            if (!fileMap.has(key)) {
              fileMap.set(key, {
                filePath,
                fileName: extractFileName(filePath),
                operation,
                timestamp: m.timestamp || null,
                sequence: fileSeq++,
              });
            }
          }
        }
      }
    }
  }

  const files = Array.from(fileMap.values());

  // ── Extract stripped messages ──
  const messages: StrippedMessage[] = [];
  let sequence = 0;

  for (const m of msgs) {
    const mtype = m.type;
    if (!mtype || SKIP_TYPES.has(mtype)) continue;

    const content = m.message?.content;
    if (content === undefined || content === null) continue;

    if (mtype === "user") {
      // Extract tool_result blocks from user messages (array content)
      if (Array.isArray(content)) {
        for (const block of content as ContentBlock[]) {
          if (block.type === "tool_result" && (block as any).content) {
            let resultText = "";
            const blockContent = (block as any).content;
            if (typeof blockContent === "string") {
              resultText = blockContent;
            } else if (Array.isArray(blockContent)) {
              resultText = blockContent
                .filter((b: any) => b.type === "text" && b.text)
                .map((b: any) => b.text)
                .join("\n");
            }
            // Strip line-number prefixes and excessive whitespace, truncate
            resultText = resultText.replace(/^\s*\d+[→│|]\s*/gm, "").replace(/\s+/g, " ").trim().slice(0, 500);
            if (resultText) {
              messages.push({
                role: "user",
                content: resultText,
                timestamp: m.timestamp || null,
                sequence: sequence++,
                messageType: "tool_result",
                toolUseId: (block as any).tool_use_id ?? null,
              });
            }
          }
        }
        // If this message ONLY has tool_results, skip text extraction
        if (hasOnlyToolResults(content)) continue;
      }

      const texts = extractTextBlocks(content);
      for (const text of texts) {
        let processed: string;

        let msgType: StrippedMessage["messageType"] = "text";
        const compacted = compactCommand(text);
        if (compacted) {
          processed = compacted;
        } else if (isSkillInjection(text)) {
          processed = truncateSkill(text);
          msgType = "system";
        } else if (isSystemContext(text)) {
          processed = truncateSystemContext(text);
          msgType = "system";
        } else {
          processed = text.trim();
        }

        processed = stripXmlNoise(processed);
        if (processed) {
          messages.push({
            role: "user",
            content: processed,
            timestamp: m.timestamp || null,
            sequence: sequence++,
            messageType: msgType,
          });
        }
      }
    } else if (mtype === "assistant") {
      const texts = extractTextBlocks(content);
      for (const text of texts) {
        const trimmed = stripXmlNoise(text.trim());
        if (trimmed.length > 100) {
          messages.push({
            role: "assistant",
            content: trimmed,
            timestamp: m.timestamp || null,
            sequence: sequence++,
            messageType: "text",
          });
        }
      }

      // Emit tool_use messages for this assistant turn
      if (Array.isArray(content)) {
        for (const block of content as ContentBlock[]) {
          if (block.type === "tool_use" && block.name) {
            const input = (block.input || {}) as Record<string, unknown>;
            let toolInputJson: string | null = null;
            try {
              toolInputJson = JSON.stringify(input);
            } catch {
              // Circular / non-serializable — drop input, keep summary.
            }
            messages.push({
              role: "assistant",
              content: `${block.name}: ${summarizeToolInput(block.name, input)}`,
              timestamp: m.timestamp || null,
              sequence: sequence++,
              messageType: "tool_use",
              toolUseId: (block as { id?: string }).id ?? null,
              toolName: block.name,
              toolInput: toolInputJson,
            });
          }
        }
      }
    }
  }

  return { header, messages, files, toolCalls };
}
