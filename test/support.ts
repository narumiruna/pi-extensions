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

type MockPiApi = {
	registerCommand(name: string, command: unknown): void;
	registerFlag(name: string, flag: unknown): void;
	registerTool(tool: unknown): void;
	registerProvider(name: string, config: unknown): void;
	unregisterProvider(name: string): void;
	on(name: string, handler: MockHandler): void;
	getFlag(name: string): unknown;
	getActiveTools(): string[];
	setActiveTools(names: string[]): void;
	getAllTools(): unknown[];
	getThinkingLevel(): string;
	setThinkingLevel(level: string): void;
	appendEntry(customType: string, data: unknown): void;
	sendUserMessage(text: string, messageOptions?: unknown): void;
	sendMessage(message: unknown, messageOptions?: unknown): void;
	setModel(model: unknown): Promise<boolean>;
};

export function createMockPi(
	options: {
		activeTools?: string[];
		allTools?: unknown[];
		thinkingLevel?: string;
		clampThinkingLevel?: (level: string) => string;
	} = {},
) {
	const commands = new Map<string, MockCommand>();
	const flags = new Map<string, MockFlag>();
	const events = new Map<string, MockHandler[]>();
	const tools: MockTool[] = [];
	const providers = new Map<string, unknown>();
	const providerRegistrations: Array<{ name: string; config: unknown }> = [];
	const providerUnregistrations: string[] = [];
	const entries: Array<{ customType: string; data: unknown }> = [];
	const sentUserMessages: Array<{ text: string; options?: unknown }> = [];
	const sentMessages: Array<{ message: unknown; options?: unknown }> = [];
	const setModels: unknown[] = [];
	const thinkingLevels: string[] = [];
	let thinkingLevel = options.thinkingLevel ?? "off";
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
		registerProvider(name: string, config: unknown) {
			const previous = providers.get(name);
			const effective =
				previous &&
				typeof previous === "object" &&
				!Array.isArray(previous) &&
				config &&
				typeof config === "object" &&
				!Array.isArray(config)
					? { ...previous, ...config }
					: config;
			providers.set(name, effective);
			providerRegistrations.push({ name, config });
		},
		unregisterProvider(name: string) {
			providers.delete(name);
			providerUnregistrations.push(name);
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
			return thinkingLevel;
		},
		setThinkingLevel(level: string) {
			thinkingLevel = options.clampThinkingLevel?.(level) ?? level;
			thinkingLevels.push(thinkingLevel);
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
		async setModel(model: unknown) {
			setModels.push(model);
			return true;
		},
	};

	return {
		pi: rawPi as never,
		rawPi,
		commands,
		flags,
		events,
		tools,
		providers,
		providerRegistrations,
		providerUnregistrations,
		entries,
		sentUserMessages,
		sentMessages,
		setModels,
		thinkingLevels,
		get thinkingLevel() {
			return thinkingLevel;
		},
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
			input: overrides.input ?? (async () => undefined),
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
			getSessionId: () => "test-session",
			getBranch: () => [],
			getEntries: () => [],
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

export function driveCustomSelector(
	factory: unknown,
	inputs: readonly string[],
	width = 100,
): { renders: string[][]; result: unknown } {
	if (typeof factory !== "function") throw new Error("Expected a custom component factory");
	let result: unknown;
	const component = (
		factory as (...args: unknown[]) => {
			render(width: number): string[];
			handleInput(data: string): void;
		}
	)(
		{ requestRender() {} },
		{
			fg(_color: string, text: string) {
				return text;
			},
			bold(text: string) {
				return text;
			},
		},
		{
			matches(data: string, key: string) {
				return data === key;
			},
		},
		(value: unknown) => {
			result = value;
		},
	);
	const renders = inputs.map((input) => {
		component.handleInput(input);
		return component.render(width);
	});
	return { renders, result };
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
