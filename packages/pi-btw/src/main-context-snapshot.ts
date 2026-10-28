import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { buildConversationContext } from "./conversation-context.js";

type Manager = ExtensionContext["sessionManager"];
export interface MainContextAnchor {
  sessionId: string;
  entryId: string | null;
}
export interface MainContextSnapshot {
  kind: "ready";
  source: MainContextAnchor;
  target: MainContextAnchor;
  text: string;
  entryCount: number;
}
export type MainContextResult = MainContextSnapshot | { kind: "empty" } | { kind: "unavailable"; reason: string };

export function captureMainContextSource(manager: Manager, entryId?: string, branch = manager.getBranch(entryId)) {
  const sessionId = manager.getSessionId?.();
  return {
    conversationContext: buildConversationContext(branch),
    anchor: sessionId ? { sessionId, entryId: branch.at(-1)?.id ?? null } : undefined,
  };
}

const LIMIT = 40_000;
const BLOCK_LIMIT = 8_000;
const boundaries = new Set(["compaction", "branch_summary", "context_edit"]);

/** SessionManager holds finalized message_end entries, never streaming deltas. */
export function buildMainContextSnapshot(manager: Manager, source: MainContextAnchor | undefined): MainContextResult {
  if (!source || manager.getSessionId?.() !== source.sessionId)
    return { kind: "unavailable", reason: "The source session is unavailable. Start a new side thread." };
  const branch = manager.getBranch();
  const index = source.entryId === null ? -1 : branch.findIndex((entry) => entry.id === source.entryId);
  if (source.entryId !== null && index < 0)
    return {
      kind: "unavailable",
      reason: "The main branch no longer contains the import cursor. Start a new side thread.",
    };
  const entries = branch.slice(index + 1);
  if (entries.some((entry) => boundaries.has(entry.type)))
    return {
      kind: "unavailable",
      reason: "Main context crossed a compaction, branch summary, or context edit. Start a new side thread.",
    };

  // Results may arrive in parallel. Do not advance past a call until all its
  // results exist. A cursor created between call and result is also supported.
  const pending = new Set<string>();
  for (const entry of branch.slice(0, index + 1)) {
    if (boundaries.has(entry.type)) pending.clear();
    if (entry.type !== "message") continue;
    if (
      entry.message.role === "assistant" &&
      entry.message.stopReason !== "error" &&
      entry.message.stopReason !== "aborted"
    ) {
      for (const block of entry.message.content) if (block.type === "toolCall") pending.add(block.id);
    } else if (entry.message.role === "toolResult") pending.delete(entry.message.toolCallId);
  }
  let safeLength = 0;
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (entry?.type === "message") {
      // Normal streaming deltas are not persisted. Also fail closed for restored
      // partial entries and provider-deferred handles, which are not answers.
      if (
        entry.message.role === "assistant" &&
        (entry.message.stopReason === "pending" || entry.message.stopReason === "deferred")
      )
        break;
      if (
        entry.message.role === "assistant" &&
        entry.message.stopReason !== "error" &&
        entry.message.stopReason !== "aborted"
      ) {
        for (const block of entry.message.content) if (block.type === "toolCall") pending.add(block.id);
      } else if (entry.message.role === "toolResult") pending.delete(entry.message.toolCallId);
    }
    if (pending.size === 0) safeLength = i + 1;
  }
  const eligible = entries.slice(0, safeLength);
  const sections: string[] = [];
  for (const entry of eligible) {
    if (entry.type !== "message") continue;
    const message = entry.message;
    if (message.role !== "user" && message.role !== "assistant" && message.role !== "toolResult") continue;
    const content =
      typeof message.content === "string" ? [{ type: "text" as const, text: message.content }] : message.content;
    const lines: string[] = [];
    for (const block of content) {
      if (block.type === "text") lines.push(bound(block.text, BLOCK_LIMIT));
      else if (block.type === "toolCall")
        lines.push(bound(`Tool call: ${block.name}(${JSON.stringify(block.arguments)})`, BLOCK_LIMIT));
    }
    if (!lines.some((line) => line.trim())) continue;
    const label =
      message.role === "toolResult"
        ? `Tool result: ${message.toolName}${message.isError ? " (error)" : ""}`
        : message.role;
    const status = message.role === "assistant" && message.stopReason !== "stop" ? ` (${message.stopReason})` : "";
    sections.push(`${label}${status}:\n${lines.join("\n")}`);
  }
  if (sections.length === 0) return { kind: "empty" };
  return {
    kind: "ready",
    source: { ...source },
    target: { sessionId: source.sessionId, entryId: eligible.at(-1)?.id ?? source.entryId },
    text: bound(sections.join("\n\n"), LIMIT),
    entryCount: eligible.length,
  };
}

function bound(text: string, limit: number): string {
  const notice = "\n[Remaining content omitted: import size limit.]";
  return text.length <= limit ? text : text.slice(0, limit - notice.length) + notice;
}

export function validateMainContextSnapshot(manager: Manager, snapshot: MainContextSnapshot): boolean {
  const latest = buildMainContextSnapshot(manager, snapshot.source);
  if (latest.kind !== "ready") return false;
  const branch = manager.getBranch();
  return branch.some((entry) => entry.id === snapshot.target.entryId);
}
