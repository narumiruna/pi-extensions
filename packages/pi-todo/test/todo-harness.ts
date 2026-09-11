import assert from "node:assert/strict";
import type {
	ContextEvent,
	ExtensionAPI,
	ExtensionContext,
	SessionEntry,
	Theme,
} from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import {
	DEFAULT_TODO_SETTINGS,
	type TodoSettings,
	type TodoSettingsLoadResult,
} from "../src/settings.js";
import todoWidgetExtension, { TOOL_NAME, type Todo, type TodoDetails } from "../src/todo-widget.js";

type Handler = (event: never, ctx: ExtensionContext) => unknown;
type WidgetFactory = (tui: TUI, theme: Theme) => Component;

export interface RegisteredTool {
	name: string;
	label: string;
	description: string;
	promptSnippet: string;
	promptGuidelines: string[];
	parameters: unknown;
	prepareArguments(args: unknown): { todos: Todo[] };
	execute(
		toolCallId: string,
		params: unknown,
		signal: AbortSignal | undefined,
		onUpdate: undefined,
		ctx: ExtensionContext,
	): Promise<{ content: Array<{ type: string; text: string }>; details: TodoDetails }>;
}

export function defaultSettingsResult(): TodoSettingsLoadResult {
	return {
		kind: "missing",
		path: "/tmp/pi-todo.json",
		settings: { widget: { ...DEFAULT_TODO_SETTINGS.widget } },
	};
}

export function loadedSettings(widget: Partial<TodoSettings["widget"]>): TodoSettingsLoadResult {
	return {
		kind: "loaded",
		path: "/tmp/pi-todo.json",
		settings: { widget: { ...DEFAULT_TODO_SETTINGS.widget, ...widget } },
	};
}

export function createHarness(
	options: {
		loadSettings?: (path?: string, signal?: AbortSignal) => Promise<TodoSettingsLoadResult>;
	} = {},
) {
	const handlers = new Map<string, Handler[]>();
	const entries: Array<{ customType: string; data: unknown }> = [];
	let tool: RegisteredTool | undefined;
	const pi = {
		on(event: string, handler: Handler) {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		},
		registerTool(definition: RegisteredTool) {
			tool = definition;
		},
		appendEntry(customType: string, data: unknown) {
			entries.push({ customType, data: structuredClone(data) });
		},
	} as unknown as ExtensionAPI;
	todoWidgetExtension(pi, {
		loadSettings: options.loadSettings ?? (async () => defaultSettingsResult()),
	});

	return {
		entries,
		get tool(): RegisteredTool {
			assert.ok(tool);
			return tool;
		},
		async emit(event: string, ctx: ExtensionContext) {
			for (const handler of handlers.get(event) ?? []) await handler({} as never, ctx);
		},
		async context(messages: ContextEvent["messages"], ctx: ExtensionContext) {
			let current = messages;
			for (const handler of handlers.get("context") ?? []) {
				const result = (await handler({ messages: current } as never, ctx)) as
					| { messages?: ContextEvent["messages"] }
					| undefined;
				current = result?.messages ?? current;
			}
			return current;
		},
	};
}

export function createContext(
	options: { mode?: ExtensionContext["mode"]; branch?: SessionEntry[]; terminalRows?: number } = {},
) {
	const widgets: Array<{
		key: string;
		content: WidgetFactory | undefined;
		options: { placement: "aboveEditor" } | undefined;
	}> = [];
	const notifications: Array<{ message: string; type: string | undefined }> = [];
	const branch = options.branch ?? [];
	const tui = { terminal: { rows: options.terminalRows ?? 36 } } as unknown as TUI;
	const sessionManager = {
		getBranch: () => branch,
	} as unknown as ExtensionContext["sessionManager"];
	const ctx = {
		mode: options.mode ?? "tui",
		hasUI: options.mode !== "print" && options.mode !== "json",
		sessionManager,
		ui: {
			setWidget(
				key: string,
				content: WidgetFactory | undefined,
				widgetOptions?: { placement: "aboveEditor" },
			) {
				widgets.push({ key, content, options: widgetOptions });
			},
			notify(message: string, type?: string) {
				notifications.push({ message, type });
			},
		},
	} as unknown as ExtensionContext;
	return { branch, ctx, notifications, tui, widgets };
}

export function identityTheme() {
	const calls: [string, string][] = [];
	const theme = {
		fg(role: string, text: string) {
			calls.push(["fg", role]);
			return text;
		},
		bold(text: string) {
			calls.push(["style", "bold"]);
			return text;
		},
		strikethrough(text: string) {
			calls.push(["style", "strikethrough"]);
			return text;
		},
	} as unknown as Theme;
	return { calls, theme };
}

export function todoToolResultMessage(
	details: unknown,
	toolName = TOOL_NAME,
	isError = false,
): ContextEvent["messages"][number] {
	return {
		role: "toolResult",
		toolCallId: "todo-call",
		toolName,
		content: [{ type: "text", text: "updated" }],
		details,
		isError,
		timestamp: 0,
	};
}

export function todoToolCallMessage(
	todos: unknown,
	toolName = TOOL_NAME,
	argumentName: "todos" | "items" = "todos",
): ContextEvent["messages"][number] {
	return {
		role: "assistant",
		content: [
			{
				type: "toolCall",
				id: "todo-call",
				name: toolName,
				arguments: { [argumentName]: todos },
			},
		],
		api: "openai-responses",
		provider: "test",
		model: "test",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "toolUse",
		timestamp: 0,
	};
}

export function toolResultEntry(
	details: unknown,
	toolName = TOOL_NAME,
	id = "tool-result",
	parentId: string | null = null,
): SessionEntry {
	return {
		type: "message",
		id,
		parentId,
		timestamp: new Date(0).toISOString(),
		message: todoToolResultMessage(details, toolName),
	} as SessionEntry;
}

export function customEntry(
	customType: string,
	data: unknown,
	id: string,
	parentId: string | null,
): SessionEntry {
	return {
		type: "custom",
		id,
		parentId,
		timestamp: new Date(0).toISOString(),
		customType,
		data,
	} as SessionEntry;
}

export async function setTodos(
	harness: ReturnType<typeof createHarness>,
	ctx: ExtensionContext,
	todos: Todo[],
) {
	return harness.tool.execute("todo-call", { todos }, undefined, undefined, ctx);
}
