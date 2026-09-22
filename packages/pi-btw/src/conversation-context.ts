const MAX_CONTEXT_CHARS = 40_000;

type MessageContentBlock = {
  type?: string;
  text?: string;
  name?: string;
  arguments?: unknown;
  result?: unknown;
};

type SessionMessage = {
  role?: string;
  content?: unknown;
  stopReason?: string;
};

export type BtwSessionEntry = {
  type: string;
  message?: SessionMessage;
};

export function buildConversationContext(entries: readonly BtwSessionEntry[]): string {
  const sections: string[] = [];

  for (const entry of entries) {
    if (entry.type !== "message" || !entry.message?.role) continue;

    const role = entry.message.role;
    if (role !== "user" && role !== "assistant") continue;

    const contentLines = extractContentLines(entry.message.content);
    if (contentLines.length === 0) continue;

    const label = role === "user" ? "User" : "Assistant";
    const status =
      entry.message.stopReason && entry.message.stopReason !== "stop" ? ` (${entry.message.stopReason})` : "";
    sections.push(`${label}${status}: ${contentLines.join("\n")}`);
  }

  return truncateFromStart(sections.join("\n\n"), MAX_CONTEXT_CHARS);
}

function extractContentLines(content: unknown): string[] {
  if (typeof content === "string") return [content.trim()].filter(Boolean);
  if (!Array.isArray(content)) return [];

  const lines: string[] = [];
  for (const part of content) {
    if (!part || typeof part !== "object") continue;
    const block = part as MessageContentBlock;
    if (block.type === "text" && typeof block.text === "string") {
      lines.push(block.text.trim());
    } else if (block.type === "toolCall" && typeof block.name === "string") {
      lines.push(`Tool call: ${block.name}(${formatJson(block.arguments)})`);
    } else if (block.type === "toolResult" && typeof block.name === "string") {
      lines.push(`Tool result from ${block.name}: ${formatJson(block.result)}`);
    }
  }
  return lines.filter(Boolean);
}

function formatJson(value: unknown): string {
  if (value === undefined) return "";
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function truncateFromStart(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `[Earlier context omitted; showing the last ${maxChars} characters.]\n${text.slice(-maxChars)}`;
}
