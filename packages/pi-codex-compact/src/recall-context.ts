import { stripVTControlCharacters } from "node:util";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { type SessionEntry, sessionEntryToContextMessages } from "@earendil-works/pi-coding-agent";
import {
	CONTEXT_STATE_ENTRY_TYPE,
	loadContextLineage,
	parseContextState,
	parseExperimentalCompaction,
} from "./context-window.js";
import { sortedNotes } from "./notes-state.js";

export const MAX_RECALL_QUERY_LENGTH = 512;
export const MAX_RECALL_RESULT_BYTES = 32 * 1024;
export const MAX_RECALL_MATCHES = 20;
const MAX_INDEXED_MESSAGE_CHARS = 256 * 1024;
// Bound source work separately so removable terminal controls do not consume the visible index.
const MAX_SCANNED_MESSAGE_CHARS = 4 * MAX_INDEXED_MESSAGE_CHARS;
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
	const serialized = JSON.stringify(messagePayload(message));
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
					arguments: block.arguments,
					...(typeof block.namespace === "string" ? { namespace: block.namespace } : {}),
				};
			default:
				return block;
		}
	});
}

function messageIndexPayload(message: AgentMessage): unknown {
	const payload = messagePayload(message);
	if (!isRecord(payload) || !Object.hasOwn(payload, "content")) return payload;
	return { ...payload, content: indexContent(payload.content) };
}

function firstWindowId(entries: readonly SessionEntry[]): string | undefined {
	for (const entry of entries) {
		if (entry.type === "custom" && entry.customType === CONTEXT_STATE_ENTRY_TYPE) {
			const state = parseContextState(entry.data);
			if (state) return state.firstWindowId;
		}
		if (entry.type === "compaction") {
			const details = parseExperimentalCompaction(entry);
			if (details) return details.firstWindowId;
		}
	}
	return loadContextLineage(entries)?.firstWindowId;
}

function historyMessageItems(entries: readonly SessionEntry[]): HistoryMessageItem[] {
	const items: HistoryMessageItem[] = [];
	let windowId = firstWindowId(entries);
	for (const entry of entries) {
		if (entry.type === "compaction") {
			const details = parseExperimentalCompaction(entry);
			if (details) windowId = details.currentWindowId;
		}
		const messages = sessionEntryToContextMessages(entry);
		for (let index = 0; index < messages.length; index += 1) {
			const message = messages[index];
			items.push({
				id: messages.length === 1 ? entry.id : `${entry.id}:${index}`,
				...(windowId ? { windowId } : {}),
				role: message.role,
				message,
			});
		}
	}
	return items;
}

function activeToolCallMessageId(
	history: readonly HistoryMessageItem[],
	toolCallId: string | undefined,
): string | undefined {
	if (!toolCallId) return undefined;
	for (let index = history.length - 1; index >= 0; index -= 1) {
		const item = history[index];
		if (
			item.message.role === "assistant" &&
			item.message.content.some((block) => block.type === "toolCall" && block.id === toolCallId)
		) {
			return item.id;
		}
	}
	return undefined;
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

function boundedPayloadText(value: unknown): string {
	let scannedCharacters = 0;
	let text = "";
	const append = (value: string) => {
		if (
			scannedCharacters >= MAX_SCANNED_MESSAGE_CHARS ||
			text.length >= MAX_INDEXED_MESSAGE_CHARS
		) {
			return;
		}
		const remainingScan = MAX_SCANNED_MESSAGE_CHARS - scannedCharacters;
		const part = value.slice(0, remainingScan);
		scannedCharacters += part.length;
		text += displayText(part).slice(0, MAX_INDEXED_MESSAGE_CHARS - text.length);
	};
	const visit = (item: unknown) => {
		if (
			scannedCharacters >= MAX_SCANNED_MESSAGE_CHARS ||
			text.length >= MAX_INDEXED_MESSAGE_CHARS
		) {
			return;
		}
		if (typeof item === "string") {
			append(item);
			return;
		}
		if (typeof item !== "object" || item === null) {
			if (item !== undefined && typeof item !== "function" && typeof item !== "symbol") {
				append(String(item));
			}
			return;
		}
		if (Array.isArray(item)) {
			for (const value of item) visit(value);
			return;
		}
		for (const [key, value] of Object.entries(item)) {
			append(`${key} `);
			visit(value);
			append("\n");
		}
	};
	visit(value);
	return text;
}

function boundedMessageText(message: AgentMessage): string {
	return boundedPayloadText(messageIndexPayload(message));
}

function paged<T>(values: readonly T[], offset: number) {
	const items = values.slice(offset, offset + MAX_RECALL_MATCHES);
	const next = offset + items.length;
	return {
		items,
		...(next < values.length ? { nextCursor: String(next) } : {}),
	};
}

function searchPage<T>(values: readonly T[], offset: number, matches: (value: T) => boolean) {
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
	if (offset > value.length)
		throw new Error("codex_compact_recall_context cursor exceeds the selected item");
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
	return Object.fromEntries(
		Object.entries(value).map(([key, item]) => [displayText(key), sanitizeJsonValue(item)]),
	);
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
			if (!note) throw new Error(`Context note ${JSON.stringify(input.id)} was not found`);
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

	const history = historyMessageItems(entries);
	if (input.action === "list") {
		const selected = paged(history, offset);
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
		const item = history.find((candidate) => candidate.id === input.id);
		if (!item) throw new Error(`History item ${JSON.stringify(input.id)} was not found`);
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
	const activeMessageId = activeToolCallMessageId(history, activeToolCallId);
	const matches = searchPage(
		history,
		offset,
		(item) =>
			item.id !== activeMessageId &&
			boundedMessageText(item.message).toLowerCase().includes(searchQuery),
	);
	const page = {
		...matches,
		items: matches.items.map((item) => ({
			id: item.id,
			...(item.windowId ? { windowId: item.windowId } : {}),
			role: item.role,
			preview: preview(boundedMessageText(item.message)),
		})),
	};
	return { text: safeJson({ source: "history", action: "search", ...page }), details: page };
}
