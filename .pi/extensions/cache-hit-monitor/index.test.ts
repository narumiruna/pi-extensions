import assert from "node:assert/strict";
import type { Api, AssistantMessage, Model, ModelCostRates } from "@earendil-works/pi-ai";
import type {
	ExtensionAPI,
	ExtensionContext,
	SessionEntry,
	Theme,
} from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { test } from "vitest";
import cacheHitMonitor, { COMMAND_NAME, renderCacheMonitor, WIDGET_KEY } from "./index.js";
import { createCacheMonitorView, createCacheSample } from "./metrics.js";

const RATES: ModelCostRates = { input: 10, output: 20, cacheRead: 1, cacheWrite: 20 };
const MODEL: Model<Api> = {
	id: "test-model",
	name: "Test model",
	api: "openai-responses",
	provider: "test-provider",
	baseUrl: "https://example.test",
	reasoning: false,
	input: ["text"],
	cost: RATES,
	contextWindow: 200_000,
	maxTokens: 10_000,
};
const THEME = {
	fg: (_role: string, text: string) => text,
	bold: (text: string) => text,
} as unknown as Theme;

type Handler = (event: never, ctx: ExtensionContext) => unknown;
type CommandHandler = (args: string, ctx: ExtensionContext) => unknown;
type WidgetFactory = (_tui: never, theme: Theme) => Component;
type WidgetRecord = [
	string,
	string[] | WidgetFactory | undefined,
	{ placement: "aboveEditor" } | undefined,
];

function assistant(
	input: number,
	cacheRead: number,
	cacheWrite = 0,
	overrides: Partial<AssistantMessage> = {},
): AssistantMessage {
	return {
		role: "assistant",
		api: "openai-responses",
		provider: "test-provider",
		model: "test-model",
		content: [],
		stopReason: "stop",
		timestamp: 1_000,
		usage: {
			input,
			output: 10,
			cacheRead,
			cacheWrite,
			totalTokens: input + cacheRead + cacheWrite + 10,
			cost: {
				input: (input * RATES.input) / 1_000_000,
				output: (10 * RATES.output) / 1_000_000,
				cacheRead: (cacheRead * RATES.cacheRead) / 1_000_000,
				cacheWrite: (cacheWrite * RATES.cacheWrite) / 1_000_000,
				total: 0,
			},
		},
		...overrides,
	};
}

function messageEntry(message: AssistantMessage): SessionEntry {
	return { type: "message", id: crypto.randomUUID(), parentId: null, message } as SessionEntry;
}

function createHarness() {
	const handlers = new Map<string, Handler[]>();
	const commands = new Map<string, CommandHandler>();
	const pi = {
		on(event: string, handler: Handler) {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		},
		registerCommand(name: string, options: { handler: CommandHandler }) {
			commands.set(name, options.handler);
		},
	} as unknown as ExtensionAPI;
	cacheHitMonitor(pi);
	return {
		async emit(event: string, payload: Record<string, unknown>, ctx: ExtensionContext) {
			for (const handler of handlers.get(event) ?? []) await handler(payload as never, ctx);
		},
		async command(args: string, ctx: ExtensionContext) {
			const handler = commands.get(COMMAND_NAME);
			assert.ok(handler);
			await handler(args, ctx);
		},
	};
}

function createContext(
	mode: ExtensionContext["mode"] = "tui",
	initialEntries: SessionEntry[] = [],
) {
	let entries = initialEntries;
	const widgets: WidgetRecord[] = [];
	const notifications: Array<[string, "info" | "warning" | "error" | undefined]> = [];
	const sessionManager = {
		getBranch: () => entries,
	} as unknown as ExtensionContext["sessionManager"];
	const ctx = {
		mode,
		hasUI: mode === "tui" || mode === "rpc",
		sessionManager,
		modelRegistry: {
			find: () => MODEL,
		},
		ui: {
			notify(message: string, level?: "info" | "warning" | "error") {
				notifications.push([message, level]);
			},
			setWidget(
				key: string,
				content: string[] | WidgetFactory | undefined,
				options?: { placement: "aboveEditor" },
			) {
				widgets.push([key, content, options]);
			},
		},
	} as unknown as ExtensionContext;
	return {
		ctx,
		notifications,
		widgets,
		setEntries(next: SessionEntry[]) {
			entries = next;
		},
	};
}

function renderWidget(record: WidgetRecord | undefined, width = 100): string[] | undefined {
	if (!record) return undefined;
	const content = record[1];
	return typeof content === "function" ? content(undefined as never, THEME).render(width) : content;
}

test("stays hidden by default, then previews and finalizes detailed metrics when shown", async () => {
	const harness = createHarness();
	const current = createContext();
	await harness.emit("session_start", {}, current.ctx);
	assert.equal(current.widgets.length, 0);

	await harness.command("", current.ctx);
	assert.deepEqual(current.notifications, [["Cache hit monitor shown.", "info"]]);
	assert.deepEqual(renderWidget(current.widgets.at(-1), 160)?.slice(1), [
		"Prompt cache · waiting for provider cache usage",
		"Hit = cacheRead / (input + cacheRead + cacheWrite). All-zero cache fields remain unknown until this provider reports cache activity.",
	]);

	const first = assistant(200, 800);
	await harness.emit("message_update", { message: first, assistantMessageEvent: {} }, current.ctx);
	const live = renderWidget(current.widgets.at(-1));
	assert.match(live?.join("\n") ?? "", /LIVE.*hit 80\.0%/s);
	const updateCount = current.widgets.length;
	const outputDelta = assistant(200, 800, 0, {
		content: [{ type: "text", text: "more generated text" }],
	});
	outputDelta.usage.output = 20;
	outputDelta.usage.totalTokens += 10;
	outputDelta.usage.cost.output = (20 * RATES.output) / 1_000_000;
	await harness.emit(
		"message_update",
		{ message: outputDelta, assistantMessageEvent: {} },
		current.ctx,
	);
	assert.equal(current.widgets.length, updateCount);

	await harness.emit("message_end", { message: first }, current.ctx);
	assert.doesNotMatch(renderWidget(current.widgets.at(-1))?.join("\n") ?? "", /LIVE/);

	const second = assistant(400, 600, 100, { timestamp: 3_000 });
	await harness.emit("message_update", { message: second, assistantMessageEvent: {} }, current.ctx);
	const compared = renderWidget(current.widgets.at(-1), 120)?.join("\n") ?? "";
	assert.match(compared, /loss 25\.5 pp/);
	assert.match(compared, /re-billed 400 \(40\.0%\)/);
	assert.match(compared, /miss premium ~\$0\.0044/);
});

test("does not display all-zero cache fields until the provider reports cache activity", async () => {
	const harness = createHarness();
	const current = createContext();
	await harness.emit("session_start", {}, current.ctx);
	await harness.command("", current.ctx);
	const waitingCount = current.widgets.length;

	await harness.emit("message_update", { message: assistant(1_000, 0) }, current.ctx);
	assert.equal(current.widgets.length, waitingCount);
	assert.match(renderWidget(current.widgets.at(-1))?.join("\n") ?? "", /waiting/);

	const cached = assistant(200, 800);
	await harness.emit("message_update", { message: cached }, current.ctx);
	await harness.emit("message_end", { message: cached }, current.ctx);
	await harness.emit(
		"message_update",
		{ message: assistant(1_000, 0, 0, { timestamp: 2_000 }) },
		current.ctx,
	);
	const rendered = renderWidget(current.widgets.at(-1), 120)?.join("\n") ?? "";
	assert.match(rendered, /hit 0\.0%/);
	assert.match(rendered, /re-billed 1k \(100\.0%\)/);
	assert.match(rendered, /miss premium ~\$0\.0090/);
});

test("the command toggles the widget closed and rejects arguments", async () => {
	const harness = createHarness();
	const current = createContext("tui", [messageEntry(assistant(200, 800))]);
	await harness.emit("session_start", {}, current.ctx);
	await harness.command("", current.ctx);
	assert.match(renderWidget(current.widgets.at(-1))?.join("\n") ?? "", /hit 80\.0%/);

	await harness.command("", current.ctx);
	assert.deepEqual(current.widgets.at(-1), [WIDGET_KEY, undefined, undefined]);
	assert.deepEqual(current.notifications, [
		["Cache hit monitor shown.", "info"],
		["Cache hit monitor hidden.", "info"],
	]);
	await assert.rejects(() => harness.command("unexpected", current.ctx), {
		message: `Usage: /${COMMAND_NAME}`,
	});
});

test("clears a partial live preview if an agent run ends without a final message", async () => {
	const harness = createHarness();
	const current = createContext();
	await harness.emit("session_start", {}, current.ctx);
	await harness.command("", current.ctx);
	await harness.emit("message_update", { message: assistant(200, 800) }, current.ctx);
	assert.match(renderWidget(current.widgets.at(-1))?.join("\n") ?? "", /LIVE/);

	await harness.emit("agent_end", { messages: [] }, current.ctx);
	assert.doesNotMatch(renderWidget(current.widgets.at(-1))?.join("\n") ?? "", /LIVE/);
	assert.match(
		renderWidget(current.widgets.at(-1))?.join("\n") ?? "",
		/waiting for provider cache usage/,
	);
});

test("restores active-branch history and resets comparison at the compaction boundary", async () => {
	const first = assistant(200, 800);
	const second = assistant(400, 600, 0, { timestamp: 2_000 });
	const harness = createHarness();
	const current = createContext("tui", [messageEntry(first), messageEntry(second)]);
	await harness.emit("session_start", {}, current.ctx);
	await harness.command("", current.ctx);
	assert.match(renderWidget(current.widgets.at(-1))?.join("\n") ?? "", /Reuse vs #1/);

	current.setEntries([
		messageEntry(first),
		messageEntry(second),
		{ type: "compaction", id: "compact", parentId: null } as SessionEntry,
	]);
	await harness.emit("session_compact", {}, current.ctx);
	let rendered = renderWidget(current.widgets.at(-1), 120)?.join("\n") ?? "";
	assert.match(rendered, /request #2.*hit 60\.0%/s);
	assert.match(rendered, /no comparable request in the current cache epoch/);

	const afterCompaction = assistant(900, 100, 0, { timestamp: 4_000 });
	current.setEntries([
		messageEntry(first),
		messageEntry(second),
		{ type: "compaction", id: "compact", parentId: null } as SessionEntry,
		messageEntry(afterCompaction),
	]);
	await harness.emit("session_compact", {}, current.ctx);
	rendered = renderWidget(current.widgets.at(-1), 120)?.join("\n") ?? "";
	assert.match(rendered, /request #3.*hit 10\.0%/s);
	assert.match(rendered, /no comparable request in the current cache epoch/);
	assert.match(rendered, /Session {2}3 req/);
	assert.match(rendered, /re-billed\s+400/);
});

test("renders restored totals for a summary-only branch", async () => {
	const summary = assistant(100, 900);
	const harness = createHarness();
	const current = createContext("tui", [
		{
			type: "branch_summary",
			id: "branch-summary",
			parentId: null,
			usage: summary.usage,
		} as SessionEntry,
	]);
	await harness.emit("session_start", {}, current.ctx);
	await harness.command("", current.ctx);

	const rendered = renderWidget(current.widgets.at(-1), 120)?.join("\n") ?? "";
	assert.match(rendered, /summary usage only/);
	assert.match(rendered, /Session {2}1 req.*hit 90\.0%/);
});

test("renders restored summary totals when cache accounting is unavailable", async () => {
	const summary = assistant(1_000, 0);
	const harness = createHarness();
	const current = createContext("tui", [
		{
			type: "compaction",
			id: "compact",
			parentId: null,
			usage: summary.usage,
		} as SessionEntry,
	]);
	await harness.emit("session_start", {}, current.ctx);
	await harness.command("", current.ctx);

	const rendered = renderWidget(current.widgets.at(-1), 120)?.join("\n") ?? "";
	assert.match(rendered, /summary usage only/);
	assert.match(rendered, /Session {2}1 req.*hit n\/a.*uncached 1k.*cost \$0\.010.*saved ~n\/a/);
});

test("clears replacement UI and ignores stale replacement-session events", async () => {
	const harness = createHarness();
	const previous = createContext();
	const current = createContext();
	await harness.emit("session_start", {}, previous.ctx);
	await harness.command("", previous.ctx);
	await harness.emit("session_start", {}, current.ctx);
	assert.deepEqual(current.widgets.at(-1), [WIDGET_KEY, undefined, undefined]);
	await harness.command("", current.ctx);
	const currentCount = current.widgets.length;

	await harness.emit("message_update", { message: assistant(100, 900) }, previous.ctx);
	await harness.emit("session_shutdown", {}, previous.ctx);
	assert.equal(current.widgets.length, currentCount);

	await harness.emit("session_shutdown", {}, current.ctx);
	assert.deepEqual(current.widgets.at(-1), [WIDGET_KEY, undefined, undefined]);
});

test("uses plain string widgets in RPC mode and remains silent without UI", async () => {
	const harness = createHarness();
	const rpc = createContext("rpc", [messageEntry(assistant(200, 800))]);
	await harness.emit("session_start", {}, rpc.ctx);
	assert.equal(rpc.widgets.length, 0);
	await harness.command("", rpc.ctx);
	const rpcContent = rpc.widgets.at(-1)?.[1];
	assert.ok(Array.isArray(rpcContent));
	assert.match(rpcContent.join("\n"), /hit 80\.0%/);

	const json = createContext("json", [messageEntry(assistant(200, 800))]);
	await harness.emit("session_start", {}, json.ctx);
	assert.equal(json.widgets.length, 0);
	await assert.rejects(() => harness.command("", json.ctx), {
		message: `/${COMMAND_NAME} requires TUI or RPC mode.`,
	});
});

test("renders every line within narrow widths and strips unsafe model text", () => {
	const sample = createCacheSample(
		assistant(200, 800, 0, {
			provider: "\u001b]8;;bad\u0007provider",
			model: "model\n\u202eunsafe",
		}),
		0,
		MODEL,
	);
	assert.ok(sample);
	const lines = renderCacheMonitor(createCacheMonitorView([sample]), THEME, 32);
	const plain = lines.map(stripTerminalSequences);

	assert.ok(lines.every((line) => visibleWidth(line) <= 32));
	assert.match(plain.join("\n"), /provider\/model unsafe/);
	assert.ok(
		plain.every((line) =>
			[...line].every((character) => {
				const codePoint = character.codePointAt(0) ?? 0;
				return (codePoint >= 32 || character === "\n") && codePoint !== 127 && codePoint !== 0x202e;
			}),
		),
	);
});
