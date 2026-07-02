import os from "node:os";
import path from "node:path";

type MockHandler = (...args: unknown[]) => unknown;

type MockCommand = {
	description?: string;
	handler: MockHandler;
	getArgumentCompletions?: (prefix: string) => unknown;
};

type MockTool = {
	name?: string;
	[key: string]: unknown;
};

type MockFlag = {
	value?: unknown;
	[key: string]: unknown;
};

type MockExecOptions = { cwd?: string; signal?: AbortSignal; timeout?: number };

type MockExecResult = {
	stdout?: string;
	stderr?: string;
	code?: number | null;
	killed?: boolean;
};

type MockPiApi = {
	registerCommand(name: string, command: unknown): void;
	registerFlag(name: string, flag: unknown): void;
	registerTool(tool: unknown): void;
	on(name: string, handler: MockHandler): void;
	getFlag(name: string): unknown;
	getActiveTools(): string[];
	setActiveTools(names: string[]): void;
	getAllTools(): unknown[];
	getThinkingLevel(): string;
	appendEntry(customType: string, data: unknown): void;
	sendUserMessage(text: string, messageOptions?: unknown): void;
	sendMessage(message: unknown, messageOptions?: unknown): void;
	exec(command: string, args: string[], execOptions?: MockExecOptions): Promise<MockExecResult>;
};

export function createMockPi(
	options: { activeTools?: string[]; allTools?: unknown[]; execResult?: MockExecResult } = {},
) {
	const commands = new Map<string, MockCommand>();
	const flags = new Map<string, MockFlag>();
	const events = new Map<string, MockHandler[]>();
	const tools: MockTool[] = [];
	const entries: Array<{ customType: string; data: unknown }> = [];
	const sentUserMessages: Array<{ text: string; options?: unknown }> = [];
	const sentMessages: Array<{ message: unknown; options?: unknown }> = [];
	const execCalls: Array<{ command: string; args: string[]; options?: MockExecOptions }> = [];
	let activeTools = [...(options.activeTools ?? [])];
	const allTools = options.allTools ?? activeTools.map((name) => builtinTool(name));

	const rawPi: MockPiApi = {
		registerCommand(name: string, command: unknown) {
			commands.set(name, command as MockCommand);
		},
		registerFlag(name: string, flag: unknown) {
			flags.set(name, flag as MockFlag);
		},
		registerTool(tool: unknown) {
			tools.push(tool as MockTool);
		},
		on(name: string, handler: MockHandler) {
			events.set(name, [...(events.get(name) ?? []), handler]);
		},
		getFlag(name: string) {
			return flags.get(name)?.value;
		},
		getActiveTools() {
			return [...activeTools];
		},
		setActiveTools(names: string[]) {
			activeTools = [...names];
		},
		getAllTools() {
			return allTools;
		},
		getThinkingLevel() {
			return "off";
		},
		appendEntry(customType: string, data: unknown) {
			entries.push({ customType, data });
		},
		sendUserMessage(text: string, messageOptions?: unknown) {
			sentUserMessages.push({ text, options: messageOptions });
		},
		sendMessage(message: unknown, messageOptions?: unknown) {
			sentMessages.push({ message, options: messageOptions });
		},
		async exec(command: string, args: string[], execOptions?: MockExecOptions) {
			execCalls.push({ command, args, options: execOptions });
			return options.execResult ?? { stdout: "", stderr: "", code: 0, killed: false };
		},
	};

	return {
		pi: rawPi as never,
		rawPi,
		commands,
		flags,
		events,
		tools,
		entries,
		sentUserMessages,
		sentMessages,
		execCalls,
	};
}

export function createMockContext(overrides: Record<string, unknown> = {}) {
	const notifications: Array<{ message: string; level?: string }> = [];
	const statuses = new Map<string, string | undefined>();
	const widgets = new Map<string, unknown>();
	let footer: unknown;

	const ctx = {
		cwd: overrides.cwd ?? process.cwd(),
		hasUI: overrides.hasUI ?? false,
		model: overrides.model,
		ui: {
			notify(message: string, level?: string) {
				notifications.push({ message, level });
			},
			setStatus(key: string, value: string | undefined) {
				statuses.set(key, value);
			},
			setWidget(key: string, value: unknown) {
				widgets.set(key, value);
			},
			setFooter(value: unknown) {
				footer = value;
			},
			confirm: overrides.confirm ?? (async () => true),
			select: overrides.select ?? (async () => undefined),
			editor: overrides.editor ?? (async () => undefined),
			custom: overrides.custom ?? (async () => undefined),
		},
		isIdle: overrides.isIdle ?? (() => true),
		hasPendingMessages: overrides.hasPendingMessages ?? (() => false),
		abort: overrides.abort ?? (() => undefined),
		reload: overrides.reload ?? (async () => undefined),
		getContextUsage: overrides.getContextUsage ?? (() => undefined),
		sessionManager: overrides.sessionManager ?? {
			getBranch: () => [],
			getEntries: () => [],
			getSessionFile: () => undefined,
		},
		modelRegistry: overrides.modelRegistry ?? {
			getApiKeyAndHeaders: async () => ({ ok: false, error: "missing" }),
			getAvailable: () => [],
			getAll: () => [],
		},
		...overrides,
	};

	return {
		ctx: ctx as never,
		notifications,
		statuses,
		widgets,
		get footer() {
			return footer;
		},
	};
}

export function builtinTool(name: string) {
	return {
		name,
		sourceInfo: { source: "builtin", scope: "builtin" },
	};
}

export function extensionTool(name: string) {
	return {
		name,
		sourceInfo: { source: "extension", scope: "user", path: path.join(os.tmpdir(), name) },
	};
}
