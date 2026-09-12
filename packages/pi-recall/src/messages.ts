import path from "node:path";

export const MAX_MESSAGE_TEXT_BYTES = 50_000;

export type RecallRole = "user" | "assistant";
export type RecallScope = "all" | "cwd" | "session";

export interface RecallSourceContext {
  sessionId: string;
  sessionName?: string;
  cwd: string;
}

export interface MessageCandidate {
  entryId: string;
  role: RecallRole;
  text: string;
  messageTimestamp: number;
  source: RecallSourceContext;
}

export interface RecallMessageRecord {
  type: "recall_message";
  version: 1;
  id: string;
  savedAt: string;
  source: {
    sessionId: string;
    entryId: string;
    sessionName?: string;
    cwd: string;
    messageTimestamp: number;
    [key: string]: unknown;
  };
  role: RecallRole;
  text: string;
  [key: string]: unknown;
}

export interface RecallScopeContext {
  sessionId: string;
  cwd: string;
}

export function extractMessageCandidates(entries: readonly unknown[], source: RecallSourceContext): MessageCandidate[] {
  const candidates: MessageCandidate[] = [];
  for (const value of entries) {
    if (!isRecord(value) || value.type !== "message" || typeof value.id !== "string") continue;
    const message = value.message;
    if (!isRecord(message) || (message.role !== "user" && message.role !== "assistant")) continue;
    if (typeof message.timestamp !== "number" || !isValidTimestamp(message.timestamp)) {
      continue;
    }
    const text = textFromMessageContent(message.content);
    if (!text.trim() || Buffer.byteLength(text, "utf8") > MAX_MESSAGE_TEXT_BYTES) continue;
    candidates.push({
      entryId: value.id,
      role: message.role,
      text,
      messageTimestamp: message.timestamp,
      source,
    });
  }
  return candidates.reverse();
}

export function filterRecallMessages(
  records: readonly RecallMessageRecord[],
  scope: RecallScope,
  current: RecallScopeContext,
  platform: NodeJS.Platform = process.platform,
): RecallMessageRecord[] {
  if (scope === "all") return [...records];
  if (scope === "session") {
    return records.filter((record) => record.source.sessionId === current.sessionId);
  }
  const currentCwd = normalizeCwd(current.cwd, platform);
  return records.filter((record) => normalizeCwd(record.source.cwd, platform) === currentCwd);
}

export function normalizeCwd(value: string, platform: NodeJS.Platform | "win32"): string {
  if (platform === "win32") return path.win32.resolve(value).toLowerCase();
  return path.resolve(value);
}

export function messagePreview(text: string, maximumCharacters = 80): string {
  const normalized = text.trim().replace(/\s+/gu, " ");
  const characters = [...normalized];
  if (characters.length <= maximumCharacters) return normalized;
  if (maximumCharacters <= 1) return "…";
  return `${characters.slice(0, maximumCharacters - 1).join("")}…`;
}

export function formatRecallQuote(record: RecallMessageRecord): string {
  const timestamp = new Date(record.source.messageTimestamp).toISOString();
  return `<recalled_message role="${record.role}" message_timestamp="${escapeXml(timestamp)}">\n${escapeXml(record.text)}\n</recalled_message>\n\nThe user intentionally recalled and quoted the saved message above.\n\n`;
}

export function candidateIdentity(sessionId: string, entryId: string): string {
  return `${sessionId}\u0000${entryId}`;
}

function textFromMessageContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .flatMap((block) =>
      isRecord(block) && block.type === "text" && typeof block.text === "string" ? [block.text] : [],
    )
    .join("\n");
}

export function isValidTimestamp(value: number): boolean {
  return value >= 0 && Number.isFinite(value) && !Number.isNaN(new Date(value).getTime());
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
