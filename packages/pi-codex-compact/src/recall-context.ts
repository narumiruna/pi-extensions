import { stripVTControlCharacters } from "node:util";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { type SessionEntry, sessionEntryToContextMessages } from "@earendil-works/pi-coding-agent";
import { CONTEXT_STATE_ENTRY_TYPE, parseContextState, parseExperimentalCompaction } from "./context-window.js";
import { sortedNotes } from "./notes-state.js";

export const MAX_RECALL_QUERY_LENGTH = 512;
export const MAX_RECALL_RESULT_BYTES = 32 * 1024;
export const MAX_RECALL_MATCHES = 20;
export const MAX_HISTORY_BRANCH_ENTRY_VISITS = 100_000;
const MAX_INDEXED_MESSAGE_CHARS = 256 * 1024;
// Bound source work separately so empty structures and removable terminal controls cannot bypass the limit.
const MAX_SCANNED_MESSAGE_UNITS = 4 * MAX_INDEXED_MESSAGE_CHARS;
const MAX_HISTORY_SEARCH_SCAN_UNITS = 4 * MAX_SCANNED_MESSAGE_UNITS;
const MAX_HISTORY_READ_SCAN_UNITS = MAX_HISTORY_SEARCH_SCAN_UNITS;
const MAX_HISTORY_READ_DEPTH = 512;
const READ_CHUNK_BYTES = 12 * 1024;

export type RecallSource = "history" | "notes";
export type RecallAction = "list" | "read" | "search";

export interface RecallContextInput {
  source: RecallSource;
  action: RecallAction;
  id?: string;
  query?: string;
  cursor?: string;
}

interface HistoryMessageItem {
  id: string;
  windowId?: string;
  role: string;
  message: AgentMessage;
}

interface HistoryTraversalBudget {
  remainingVisits: number;
}

function visitHistoryEntry(budget: HistoryTraversalBudget): void {
  if (budget.remainingVisits <= 0) {
    throw new Error("codex_compact_recall_context history branch traversal exceeded its entry limit");
  }
  budget.remainingVisits -= 1;
}

function parseCursor(cursor: string | undefined): number {
  if (cursor === undefined) return 0;
  if (!/^\d{1,12}$/.test(cursor)) throw new Error("codex_compact_recall_context cursor is invalid");
  return Number.parseInt(cursor, 10);
}

function messagePayload(message: AgentMessage): unknown {
  switch (message.role) {
    case "compactionSummary":
      return { summary: message.summary };
    case "branchSummary":
      return { summary: message.summary };
    case "custom":
      return { customType: message.customType, content: message.content };
    case "toolResult":
      return {
        toolName: message.toolName,
        toolCallId: message.toolCallId,
        content: message.content,
        isError: message.isError,
      };
    default: {
      const candidate = message as unknown as Record<string, unknown>;
      return Object.hasOwn(candidate, "content")
        ? { content: candidate.content }
        : {
            command: candidate.command,
            output: candidate.output,
            exitCode: candidate.exitCode,
          };
    }
  }
}

function serializeMessage(message: AgentMessage): string {
  let remainingUnits = MAX_HISTORY_READ_SCAN_UNITS;
  const depths = new WeakMap<object, number>();
  const serialized = JSON.stringify(
    messagePayload(message),
    function boundedReplacer(this: unknown, key, value: unknown) {
      const holderDepth = typeof this === "object" && this !== null ? depths.get(this) : undefined;
      const depth = key === "" && holderDepth === undefined ? 0 : (holderDepth ?? -1) + 1;
      const units = 1 + key.length + (typeof value === "string" ? value.length : 0);
      if (depth > MAX_HISTORY_READ_DEPTH || units > remainingUnits) {
        throw new Error("codex_compact_recall_context history read exceeded its scan limit");
      }
      remainingUnits -= units;
      if (typeof value === "object" && value !== null) depths.set(value, depth);
      return value;
    },
  );
  if (serialized === undefined) {
    throw new Error("codex_compact_recall_context selected history payload is not serializable");
  }
  return JSON.stringify(sanitizeJsonValue(JSON.parse(serialized)));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function indexContent(content: unknown): unknown {
  if (!Array.isArray(content)) return content;
  return content.map((block) => {
    if (!isRecord(block)) return block;
    switch (block.type) {
      case "text":
        return { type: block.type, text: block.text };
      case "image":
        return { type: block.type, mimeType: block.mimeType };
      case "thinking":
        return {
          type: block.type,
          thinking: block.thinking,
          ...(typeof block.redacted === "boolean" ? { redacted: block.redacted } : {}),
        };
      case "toolCall":
        return {
          type: block.type,
          id: block.id,
          name: block.name,
          ...(block.name === "codex_compact_recall_context" ? {} : { arguments: block.arguments }),
          ...(typeof block.namespace === "string" ? { namespace: block.namespace } : {}),
        };
      default:
        return block;
    }
  });
}

function messageIndexPayload(message: AgentMessage): unknown {
  if (message.role === "toolResult" && message.toolName === "codex_compact_recall_context") {
    return {
      toolName: message.toolName,
      toolCallId: message.toolCallId,
      isError: message.isError,
    };
  }
  const payload = messagePayload(message);
  if (!isRecord(payload) || !Object.hasOwn(payload, "content")) return payload;
  return { ...payload, content: indexContent(payload.content) };
}

function firstWindowId(entries: readonly SessionEntry[], budget: HistoryTraversalBudget): string | undefined {
  for (const entry of entries) {
    visitHistoryEntry(budget);
    if (entry.type === "custom" && entry.customType === CONTEXT_STATE_ENTRY_TYPE) {
      const state = parseContextState(entry.data);
      if (state) return state.firstWindowId;
    }
    if (entry.type === "compaction") {
      const details = parseExperimentalCompaction(entry);
      if (details) return details.firstWindowId;
    }
  }
  return undefined;
}

function isExcludedFromModelContext(message: AgentMessage): boolean {
  return message.role === "bashExecution" && message.excludeFromContext === true;
}

function* historyMessageItems(
  entries: readonly SessionEntry[],
  budget: HistoryTraversalBudget,
): Generator<HistoryMessageItem> {
  let windowId = firstWindowId(entries, budget);
  for (const entry of entries) {
    visitHistoryEntry(budget);
    if (entry.type === "compaction") {
      const details = parseExperimentalCompaction(entry);
      if (details) windowId = details.currentWindowId;
    }
    const messages = sessionEntryToContextMessages(entry);
    for (let index = 0; index < messages.length; index += 1) {
      const message = messages[index];
      if (isExcludedFromModelContext(message)) continue;
      yield {
        id: messages.length === 1 ? entry.id : `${entry.id}:${index}`,
        ...(windowId ? { windowId } : {}),
        role: message.role,
        message,
      };
    }
  }
}

function isActiveToolCallMessage(message: AgentMessage, toolCallId: string | undefined): boolean {
  return (
    toolCallId !== undefined &&
    message.role === "assistant" &&
    message.content.some((block) => block.type === "toolCall" && block.id === toolCallId)
  );
}

function displayText(value: string): string {
  return Array.from(stripVTControlCharacters(value), (character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint === 9 || codePoint === 10 || codePoint === 13) return character;
    return codePoint < 32 || (codePoint >= 127 && codePoint <= 159) ? " " : character;
  }).join("");
}

function normalizedSearchQuery(input: RecallContextInput): string {
  if (!input.query || input.query.length > MAX_RECALL_QUERY_LENGTH || input.id !== undefined) {
    throw new Error(
      `codex_compact_recall_context search requires a query of 1-${MAX_RECALL_QUERY_LENGTH} characters and does not accept id`,
    );
  }
  const query = displayText(input.query).trim().toLowerCase();
  if (!query) throw new Error("codex_compact_recall_context search query contains no visible text");
  return query;
}

function preview(value: string): string {
  const compact = displayText(value).replace(/\s+/g, " ").trim();
  const characters = Array.from(compact);
  return characters.length > 240 ? `${characters.slice(0, 239).join("")}…` : compact;
}

interface SearchScanBudget {
  remainingUnits: number;
  exceeded: boolean;
}

type PayloadFrame =
  | { kind: "value"; value: unknown }
  | { kind: "array"; value: unknown[]; index: number }
  | { kind: "object"; entries: Iterator<[string, unknown]> }
  | { kind: "text"; value: string };

function* ownEntries(value: object): Generator<[string, unknown]> {
  for (const key in value) {
    if (Object.hasOwn(value, key)) yield [key, (value as Record<string, unknown>)[key]];
  }
}

function boundedPayloadText(value: unknown, searchBudget?: SearchScanBudget): string {
  let scannedUnits = 0;
  let text = "";
  const consume = (requestedUnits: number): number => {
    const allowedByMessage = Math.min(requestedUnits, MAX_SCANNED_MESSAGE_UNITS - scannedUnits);
    const consumedUnits = Math.min(allowedByMessage, searchBudget?.remainingUnits ?? allowedByMessage);
    scannedUnits += consumedUnits;
    if (searchBudget) {
      searchBudget.remainingUnits -= consumedUnits;
      if (consumedUnits < allowedByMessage) searchBudget.exceeded = true;
    }
    return consumedUnits;
  };
  const append = (value: string) => {
    const part = value.slice(0, consume(value.length));
    text += displayText(part).slice(0, MAX_INDEXED_MESSAGE_CHARS - text.length);
  };
  const frames: PayloadFrame[] = [{ kind: "value", value }];
  while (
    frames.length > 0 &&
    scannedUnits < MAX_SCANNED_MESSAGE_UNITS &&
    text.length < MAX_INDEXED_MESSAGE_CHARS &&
    !searchBudget?.exceeded
  ) {
    const frame = frames.pop();
    if (!frame) break;
    if (frame.kind === "text") {
      append(frame.value);
      continue;
    }
    if (frame.kind === "array") {
      if (frame.index < frame.value.length) {
        frames.push(
          { kind: "array", value: frame.value, index: frame.index + 1 },
          { kind: "value", value: frame.value[frame.index] },
        );
      }
      continue;
    }
    if (frame.kind === "object") {
      const next = frame.entries.next();
      if (!next.done) {
        const [key, item] = next.value;
        frames.push(
          frame,
          { kind: "text", value: "\n" },
          { kind: "value", value: item },
          { kind: "text", value: `${key} ` },
        );
      }
      continue;
    }
    if (consume(1) < 1) continue;
    const item = frame.value;
    if (typeof item === "string") {
      append(item);
    } else if (typeof item !== "object" || item === null) {
      if (item !== undefined && typeof item !== "function" && typeof item !== "symbol") {
        append(String(item));
      }
    } else if (Array.isArray(item)) {
      frames.push({ kind: "array", value: item, index: 0 });
    } else {
      frames.push({ kind: "object", entries: ownEntries(item) });
    }
  }
  return text;
}

function boundedMessageText(message: AgentMessage, searchBudget?: SearchScanBudget): string {
  return boundedPayloadText(messageIndexPayload(message), searchBudget);
}

function paged<T>(values: readonly T[], offset: number) {
  const items = values.slice(offset, offset + MAX_RECALL_MATCHES);
  const next = offset + items.length;
  return {
    items,
    ...(next < values.length ? { nextCursor: String(next) } : {}),
  };
}

function searchPage<T>(values: Iterable<T>, offset: number, matches: (value: T) => boolean) {
  const items: T[] = [];
  let matchIndex = 0;
  for (const value of values) {
    if (!matches(value)) continue;
    if (matchIndex >= offset) items.push(value);
    matchIndex += 1;
    if (items.length > MAX_RECALL_MATCHES) break;
  }
  const hasMore = items.length > MAX_RECALL_MATCHES;
  return {
    items: items.slice(0, MAX_RECALL_MATCHES),
    ...(hasMore ? { nextCursor: String(offset + MAX_RECALL_MATCHES) } : {}),
  };
}

function readChunk(value: string, offset: number) {
  if (offset > value.length) throw new Error("codex_compact_recall_context cursor exceeds the selected item");
  if (
    offset > 0 &&
    offset < value.length &&
    /[\uDC00-\uDFFF]/.test(value[offset]) &&
    /[\uD800-\uDBFF]/.test(value[offset - 1])
  ) {
    throw new Error("codex_compact_recall_context cursor splits a Unicode code point");
  }
  let bytes = 0;
  let next = offset;
  for (const character of value.slice(offset)) {
    const characterBytes = Buffer.byteLength(character, "utf8");
    if (bytes + characterBytes > READ_CHUNK_BYTES) break;
    bytes += characterBytes;
    next += character.length;
  }
  const chunk = value.slice(offset, next);
  return {
    chunk,
    ...(next < value.length ? { nextCursor: String(next) } : {}),
  };
}

function sanitizeJsonValue(value: unknown): unknown {
  if (typeof value === "string") return displayText(value);
  if (Array.isArray(value)) return value.map(sanitizeJsonValue);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [displayText(key), sanitizeJsonValue(item)]));
}

function safeJson(value: unknown): string {
  const text = JSON.stringify(sanitizeJsonValue(value), null, 2);
  if (Buffer.byteLength(text, "utf8") > MAX_RECALL_RESULT_BYTES) {
    throw new Error("codex_compact_recall_context result exceeded its output limit");
  }
  if (text.split("\n").length > 1_000) {
    throw new Error("codex_compact_recall_context result exceeded its line limit");
  }
  return text;
}

export function recallContext(
  entries: readonly SessionEntry[],
  input: RecallContextInput,
  activeToolCallId?: string,
): { text: string; details: Record<string, unknown> } {
  if (input.source !== "history" && input.source !== "notes") {
    throw new Error("codex_compact_recall_context source must be history or notes");
  }
  if (input.action !== "list" && input.action !== "read" && input.action !== "search") {
    throw new Error("codex_compact_recall_context action must be list, read, or search");
  }
  const offset = parseCursor(input.cursor);
  if (input.action === "read" && (!input.id || input.query !== undefined)) {
    throw new Error("codex_compact_recall_context read requires id and does not accept query");
  }
  const searchQuery = input.action === "search" ? normalizedSearchQuery(input) : "";
  if (input.action === "list" && (input.id !== undefined || input.query !== undefined)) {
    throw new Error("codex_compact_recall_context list does not accept id or query");
  }

  if (input.source === "notes") {
    const notes = sortedNotes(entries);
    if (input.action === "list") {
      const page = paged(
        notes.map((note) => ({ id: note.name, bytes: Buffer.byteLength(note.content, "utf8") })),
        offset,
      );
      return { text: safeJson({ source: "notes", action: "list", ...page }), details: page };
    }
    if (input.action === "read") {
      const note = notes.find((candidate) => candidate.name === input.id);
      if (!note) throw new Error(`Context note ${JSON.stringify(displayText(input.id ?? ""))} was not found`);
      const page = readChunk(displayText(note.content), offset);
      return {
        text: safeJson({ source: "notes", action: "read", id: note.name, ...page }),
        details: { source: "notes", id: note.name, ...page },
      };
    }
    const matches = searchPage(notes, offset, (note) =>
      displayText(`${note.name}\n${note.content.slice(0, MAX_INDEXED_MESSAGE_CHARS)}`)
        .toLowerCase()
        .includes(searchQuery),
    );
    const page = {
      ...matches,
      items: matches.items.map((note) => ({ id: note.name, preview: preview(note.content) })),
    };
    return { text: safeJson({ source: "notes", action: "search", ...page }), details: page };
  }

  const history = historyMessageItems(entries, { remainingVisits: MAX_HISTORY_BRANCH_ENTRY_VISITS });
  if (input.action === "list") {
    const selected = searchPage(history, offset, () => true);
    const page = {
      ...selected,
      items: selected.items.map((item) => ({
        id: item.id,
        ...(item.windowId ? { windowId: item.windowId } : {}),
        role: item.role,
        preview: preview(boundedMessageText(item.message)),
      })),
    };
    return { text: safeJson({ source: "history", action: "list", ...page }), details: page };
  }
  if (input.action === "read") {
    let item: HistoryMessageItem | undefined;
    for (const candidate of history) {
      if (candidate.id !== input.id) continue;
      item = candidate;
      break;
    }
    if (!item) throw new Error(`History item ${JSON.stringify(displayText(input.id ?? ""))} was not found`);
    const content = serializeMessage(item.message);
    const page = readChunk(content, offset);
    return {
      text: safeJson({
        source: "history",
        action: "read",
        id: item.id,
        ...(item.windowId ? { windowId: item.windowId } : {}),
        role: item.role,
        ...page,
      }),
      details: { source: "history", id: item.id, ...page },
    };
  }
  const searchBudget: SearchScanBudget = { remainingUnits: MAX_HISTORY_SEARCH_SCAN_UNITS, exceeded: false };
  const indexedText = new Map<string, string>();
  const matches = searchPage(history, offset, (item) => {
    if (isActiveToolCallMessage(item.message, activeToolCallId)) return false;
    const text = boundedMessageText(item.message, searchBudget);
    if (searchBudget.exceeded) {
      throw new Error("codex_compact_recall_context history search exceeded its scan limit");
    }
    indexedText.set(item.id, text);
    return text.toLowerCase().includes(searchQuery);
  });
  const page = {
    ...matches,
    items: matches.items.map((item) => ({
      id: item.id,
      ...(item.windowId ? { windowId: item.windowId } : {}),
      role: item.role,
      preview: preview(indexedText.get(item.id) ?? ""),
    })),
  };
  return { text: safeJson({ source: "history", action: "search", ...page }), details: page };
}
