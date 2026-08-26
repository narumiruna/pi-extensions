import { StringEnum } from "@earendil-works/pi-ai";
import {
	buildSessionContext,
	type ContextEvent,
	type ExtensionAPI,
	type ExtensionContext,
	type SessionEntry,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { Type } from "typebox";

export const TOOL_NAME = "update_todo_list";
export const WIDGET_KEY = "todo";
export const TODO_CONTEXT_MESSAGE_TYPE = "todo-list-status";
export const TODO_CONTEXT_VERSION = 1;
export const TODO_DETAILS_VERSION = 1;
export const TODO_RESTORED_BOUNDARY_ENTRY_TYPE = "todo-restored-context-boundary";
const TODO_RESTORED_BOUNDARY_VERSION = 1;
export const MAX_TODO_ITEMS = 50;
export const MAX_TODO_TEXT_LENGTH = 300;

const WIDGET_OPTIONS = { placement: "aboveEditor" } as const;
const LEGACY_TOOL_NAME = "todo_widget";
const TODO_STATUSES = ["pending", "in_progress", "completed"] as const;
const BIDI_CONTROLS = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu;

type TodoStatus = (typeof TODO_STATUSES)[number];

export interface TodoItem {
	text: string;
	status: TodoStatus;
}

export interface TodoDetails {
	version: typeof TODO_DETAILS_VERSION;
	items: TodoItem[];
}

const TodoParameters = Type.Object({
	items: Type.Array(
		Type.Object({
			text: Type.String({
				minLength: 1,
				maxLength: MAX_TODO_TEXT_LENGTH,
				description: "A concise, action-oriented task",
			}),
			status: StringEnum(TODO_STATUSES, {
				description: "The task's current status",
			}),
		}),
		{
			maxItems: MAX_TODO_ITEMS,
			description: "The complete current todo list; send an empty list to clear it",
		},
	),
});

export default function todoWidgetExtension(pi: ExtensionAPI): void {
	let activeSession: ExtensionContext["sessionManager"] | undefined;
	let items: TodoItem[] = [];
	let restoredBoundary: { summaryEpoch: string; content: string } | undefined;

	const ownsSession = (ctx: ExtensionContext): boolean => ctx.sessionManager === activeSession;

	const publish = (ctx: ExtensionContext): void => {
		if (!ownsSession(ctx) || ctx.mode !== "tui") return;
		if (items.length === 0) {
			ctx.ui.setWidget(WIDGET_KEY, undefined);
			return;
		}

		const snapshot = cloneItems(items);
		ctx.ui.setWidget(
			WIDGET_KEY,
			(_tui, theme) => ({
				render: (width) => renderTodoWidget(snapshot, theme, width),
				invalidate: () => {},
			}),
			WIDGET_OPTIONS,
		);
	};

	pi.registerTool({
		name: TOOL_NAME,
		label: "Todo List",
		description:
			"Replace the current session todo list with the complete supplied list. Call update_todo_list whenever actual task state changes; keep at most one item in_progress and send an empty list to clear it.",
		promptSnippet: "Maintain the complete session todo list as multi-step work progresses",
		promptGuidelines: [
			"Use update_todo_list to track work with multiple meaningful steps; skip it for simple, single-step tasks.",
			"Use update_todo_list to keep the list aligned with actual work: mark a task in_progress before starting it, mark it completed as soon as it finishes, and revise the list before continuing when the plan changes.",
			"Before a progress report or final response, call update_todo_list to reconcile every item with actual work; do not report completion while the list is stale.",
			"On every update_todo_list call, send the complete current list, keep at most one task in_progress, and send an empty list when no tracked work remains.",
		],
		parameters: TodoParameters,
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			signal?.throwIfAborted();
			if (!ownsSession(ctx)) {
				throw new Error("Cannot update the todo list because the session changed.");
			}
			validateItems(params.items);

			items = cloneItems(params.items);
			publish(ctx);

			const details: TodoDetails = {
				version: TODO_DETAILS_VERSION,
				items: cloneItems(items),
			};
			if (items.length === 0) {
				return {
					content: [{ type: "text", text: "Todo list cleared." }],
					details,
				};
			}

			const completed = items.filter((item) => item.status === "completed").length;
			const inProgress = items.some((item) => item.status === "in_progress");
			return {
				content: [
					{
						type: "text",
						text: `Todo list updated: ${completed} of ${items.length} complete${inProgress ? "; 1 in progress" : ""}.`,
					},
				],
				details,
			};
		},
	});

	const restoreBranchState = (ctx: ExtensionContext): void => {
		const branch = ctx.sessionManager.getBranch();
		items = reconstructItems(branch);
		restoredBoundary = reconstructRestoredTodoBoundary(branch);
	};

	pi.on("session_start", (_event, ctx) => {
		activeSession = ctx.sessionManager;
		restoreBranchState(ctx);
		publish(ctx);
	});

	pi.on("context", (event, ctx) => {
		if (!ownsSession(ctx)) return;
		const summaryEpoch = leadingSummaryEpoch(event.messages);
		if (restoredBoundary?.summaryEpoch !== summaryEpoch) restoredBoundary = undefined;
		const messages = reconcileTodoContext(event.messages, items, restoredBoundary?.content);
		if (restoredBoundary === undefined && summaryEpoch) {
			const boundaryMessage = messages[leadingSummaryBoundary(messages)];
			if (isTodoContextMessage(boundaryMessage)) {
				restoredBoundary = { summaryEpoch, content: boundaryMessage.content };
				pi.appendEntry(TODO_RESTORED_BOUNDARY_ENTRY_TYPE, {
					version: TODO_RESTORED_BOUNDARY_VERSION,
					...restoredBoundary,
				});
			}
		}
		if (messages !== event.messages) return { messages };
	});

	pi.on("session_tree", (_event, ctx) => {
		if (!ownsSession(ctx)) return;
		restoreBranchState(ctx);
		publish(ctx);
	});

	pi.on("session_shutdown", (_event, ctx) => {
		if (!ownsSession(ctx)) return;
		if (ctx.mode === "tui") ctx.ui.setWidget(WIDGET_KEY, undefined);
		items = [];
		restoredBoundary = undefined;
		activeSession = undefined;
	});
}

export function renderTodoWidget(
	items: readonly TodoItem[],
	theme: Theme,
	width: number,
): string[] {
	const completed = items.filter((item) => item.status === "completed").length;
	const divider = theme.fg("borderMuted", "─".repeat(Math.max(0, width)));
	const lines = [divider, theme.fg("muted", `Todo · ${completed}/${items.length} complete`)];

	const renderWidth = Math.max(0, width);
	for (const item of items) {
		const text = sanitizeTodoText(item.text);
		let prefix: string;
		let styledText: string;
		switch (item.status) {
			case "completed":
				prefix = theme.fg("success", "✓ ");
				styledText = theme.fg("muted", theme.strikethrough(text));
				break;
			case "in_progress":
				prefix = theme.fg("accent", "▶ ");
				styledText = theme.fg("accent", theme.bold(text));
				break;
			case "pending":
				prefix = theme.fg("dim", "○ ");
				styledText = theme.fg("text", text);
				break;
		}

		if (renderWidth <= 2) {
			lines.push(prefix);
			continue;
		}

		const wrappedText = wrapTextWithAnsi(styledText, renderWidth - 2);
		lines.push(...wrappedText.map((line, index) => `${index === 0 ? prefix : "  "}${line}`));
	}

	return lines.map((line) => truncateToWidth(line, renderWidth, ""));
}

export function reconcileTodoContext(
	messages: ContextEvent["messages"],
	items: readonly TodoItem[],
	restoredBoundaryContent?: string,
): ContextEvent["messages"] {
	const existing = messages.filter(isTodoContextMessage);
	const withoutExisting = messages.filter((message) => !isTodoContextMessage(message));
	const summaryBoundary = leadingSummaryBoundary(withoutExisting);
	const currentContent =
		items.length > 0 && !hasModelVisibleTodoState(withoutExisting, items)
			? todoContextContent(items)
			: undefined;
	const content = summaryBoundary > 0 ? (restoredBoundaryContent ?? currentContent) : undefined;
	if (
		content !== undefined &&
		existing.length === 1 &&
		messages[summaryBoundary] === existing[0] &&
		existing[0]?.content === content &&
		hasTodoContextVersion(existing[0])
	) {
		return messages;
	}
	if (existing.length === 0 && content === undefined) return messages;
	if (content === undefined) return withoutExisting;

	return [
		...withoutExisting.slice(0, summaryBoundary),
		{
			role: "custom",
			customType: TODO_CONTEXT_MESSAGE_TYPE,
			content,
			display: false,
			details: { version: TODO_CONTEXT_VERSION },
			timestamp: 0,
		},
		...withoutExisting.slice(summaryBoundary),
	];
}

export function sanitizeTodoText(value: string): string {
	let text = "";
	for (const character of stripTerminalSequences(value).replace(BIDI_CONTROLS, "")) {
		const codePoint = character.codePointAt(0) ?? 0;
		const isControl = codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f);
		text += isControl ? " " : character;
	}
	return text.replace(/\s+/gu, " ").trim();
}

function todoContextContent(items: readonly TodoItem[]): string {
	return `[PI TODO STATUS v${TODO_CONTEXT_VERSION}]
Current todo list as JSON data:
${JSON.stringify(items)}`;
}

function reconstructRestoredTodoBoundary(
	entries: readonly SessionEntry[],
): { summaryEpoch: string; content: string } | undefined {
	const summaryEpoch = leadingSummaryEpoch(buildSessionContext([...entries]).messages);
	if (!summaryEpoch) return undefined;
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		const entry = entries[index];
		if (entry?.type !== "custom" || entry.customType !== TODO_RESTORED_BOUNDARY_ENTRY_TYPE) {
			continue;
		}
		if (!isRestoredTodoBoundaryData(entry.data, summaryEpoch)) continue;
		return { summaryEpoch, content: entry.data.content };
	}
	return undefined;
}

function isRestoredTodoBoundaryData(
	value: unknown,
	summaryEpoch: string,
): value is { version: number; summaryEpoch: string; content: string } {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const data = value as Record<string, unknown>;
	if (
		data.version !== TODO_RESTORED_BOUNDARY_VERSION ||
		data.summaryEpoch !== summaryEpoch ||
		typeof data.content !== "string"
	) {
		return false;
	}
	const prefix = `[PI TODO STATUS v${TODO_CONTEXT_VERSION}]\nCurrent todo list as JSON data:\n`;
	if (!data.content.startsWith(prefix)) return false;
	try {
		const restoredItems: unknown = JSON.parse(data.content.slice(prefix.length));
		return (
			isTodoItems(restoredItems) &&
			restoredItems.length > 0 &&
			todoContextContent(restoredItems) === data.content
		);
	} catch {
		return false;
	}
}

function hasModelVisibleTodoState(
	messages: ContextEvent["messages"],
	items: readonly TodoItem[],
): boolean {
	const currentResults = new Map<string, string>();
	for (const message of messages) {
		if (
			message.role === "toolResult" &&
			!message.isError &&
			(message.toolName === TOOL_NAME || message.toolName === LEGACY_TOOL_NAME) &&
			isTodoDetails(message.details) &&
			todoItemsEqual(message.details.items, items)
		) {
			currentResults.set(message.toolCallId, message.toolName);
		}
	}
	if (currentResults.size === 0) return false;

	return messages.some(
		(message) =>
			message.role === "assistant" &&
			message.content.some(
				(content) =>
					content.type === "toolCall" &&
					currentResults.get(content.id) === content.name &&
					isTodoToolArguments(content.arguments) &&
					todoItemsEqual(content.arguments.items, items),
			),
	);
}

function isTodoToolArguments(value: unknown): value is { items: TodoItem[] } {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	return isTodoItems((value as Record<string, unknown>).items);
}

type TodoContextMessage = Extract<ContextEvent["messages"][number], { role: "custom" }> & {
	content: string;
};

function isTodoContextMessage(
	message: ContextEvent["messages"][number],
): message is TodoContextMessage {
	return message.role === "custom" && message.customType === TODO_CONTEXT_MESSAGE_TYPE;
}

function hasTodoContextVersion(message: TodoContextMessage): boolean {
	return (
		typeof message.details === "object" &&
		message.details !== null &&
		!Array.isArray(message.details) &&
		(message.details as Record<string, unknown>).version === TODO_CONTEXT_VERSION
	);
}

function leadingSummaryEpoch(messages: ContextEvent["messages"]): string | undefined {
	const boundary = leadingSummaryBoundary(messages);
	return boundary === 0 ? undefined : JSON.stringify(messages.slice(0, boundary));
}

function leadingSummaryBoundary(messages: ContextEvent["messages"]): number {
	let index = 0;
	while (index < messages.length) {
		const role = messages[index]?.role;
		if (role !== "compactionSummary" && role !== "branchSummary") break;
		index += 1;
	}
	return index;
}

function validateItems(items: readonly TodoItem[]): void {
	for (const [index, item] of items.entries()) {
		if (item.text.trim().length === 0) {
			throw new Error(`Todo item ${index + 1} must contain non-whitespace text.`);
		}
	}

	const currentCount = items.filter((item) => item.status === "in_progress").length;
	if (currentCount > 1) {
		throw new Error("Todo list can contain at most one in_progress item.");
	}
}

function reconstructItems(entries: readonly SessionEntry[]): TodoItem[] {
	let restored: TodoItem[] = [];
	for (const entry of entries) {
		if (entry.type !== "message") continue;
		const message = entry.message;
		if (
			message.role !== "toolResult" ||
			(message.toolName !== TOOL_NAME && message.toolName !== LEGACY_TOOL_NAME)
		) {
			continue;
		}
		if (!isTodoDetails(message.details)) continue;
		restored = cloneItems(message.details.items);
	}
	return restored;
}

function isTodoDetails(value: unknown): value is TodoDetails {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const record = value as Record<string, unknown>;
	return record.version === TODO_DETAILS_VERSION && isTodoItems(record.items);
}

function isTodoItems(value: unknown): value is TodoItem[] {
	if (!Array.isArray(value) || value.length > MAX_TODO_ITEMS) return false;

	let currentCount = 0;
	for (const item of value) {
		if (typeof item !== "object" || item === null || Array.isArray(item)) return false;
		const candidate = item as Record<string, unknown>;
		if (
			typeof candidate.text !== "string" ||
			candidate.text.length === 0 ||
			candidate.text.length > MAX_TODO_TEXT_LENGTH ||
			candidate.text.trim().length === 0 ||
			!TODO_STATUSES.includes(candidate.status as TodoStatus)
		) {
			return false;
		}
		if (candidate.status === "in_progress") currentCount += 1;
	}
	return currentCount <= 1;
}

function todoItemsEqual(left: readonly TodoItem[], right: readonly TodoItem[]): boolean {
	return (
		left.length === right.length &&
		left.every(
			(item, index) => item.text === right[index]?.text && item.status === right[index]?.status,
		)
	);
}

function cloneItems(items: readonly TodoItem[]): TodoItem[] {
	return items.map((item) => ({ text: item.text, status: item.status }));
}
