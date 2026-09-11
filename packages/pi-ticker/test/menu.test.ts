import assert from "node:assert/strict";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { createRpcHarness, createTuiHarness } from "@narumitw/pi-tui-kit/testing";
import { test, vi } from "vitest";
import { showTickerMenu, type TickerMenuOptions } from "../src/menu.js";

function createOptions(initialSymbols: string[]) {
	let symbols = [...initialSymbols];
	let widgetEnabled = true;
	let refreshCount = 0;
	const controller = new AbortController();
	const applied: string[][] = [];
	const options: TickerMenuOptions = {
		signal: controller.signal,
		isCurrent: () => !controller.signal.aborted,
		getSymbols: () => [...symbols],
		async applySymbols(nextSymbols, signal) {
			signal.throwIfAborted();
			symbols = [...nextSymbols];
			applied.push([...symbols]);
		},
		getWidgetEnabled: () => widgetEnabled,
		async applyWidgetEnabled(nextWidgetEnabled, signal) {
			signal.throwIfAborted();
			widgetEnabled = nextWidgetEnabled;
		},
		refresh() {
			refreshCount += 1;
		},
	};
	return {
		options,
		controller,
		applied,
		get symbols() {
			return symbols;
		},
		get widgetEnabled() {
			return widgetEnabled;
		},
		get refreshCount() {
			return refreshCount;
		},
	};
}

function tuiContext(
	tui: ReturnType<typeof createTuiHarness>,
	input: ExtensionCommandContext["ui"]["input"] = async () => undefined,
) {
	const notifications: [string, string | undefined][] = [];
	const ctx = {
		mode: "tui",
		hasUI: true,
		ui: {
			custom: tui.custom,
			input,
			notify(message: string, type?: string) {
				notifications.push([message, type]);
			},
		},
	} as unknown as ExtensionCommandContext;
	return { ctx, notifications };
}

function rpcContext(rpc: ReturnType<typeof createRpcHarness>) {
	const notifications: [string, string | undefined][] = [];
	const ctx = {
		mode: "rpc",
		hasUI: true,
		ui: {
			...rpc.ui,
			notify(message: string, type?: string) {
				notifications.push([message, type]);
			},
		},
	} as unknown as ExtensionCommandContext;
	return { ctx, notifications };
}

async function moveDown(tui: ReturnType<typeof createTuiHarness>, count: number) {
	for (let index = 0; index < count; index += 1) tui.press("tui.select.down");
}

test("removes any unchecked ticker from the current menu", async () => {
	const tui = createTuiHarness({ width: 72, rows: 22 });
	const { ctx } = tuiContext(tui);
	const state = createOptions(["NVDA", "MSFT"]);
	const running = showTickerMenu(ctx, state.options);
	await tui.waitForOpen();
	tui.setFocused(true);
	await moveDown(tui, 1);
	tui.press("tui.select.confirm");
	await tui.waitForPending();
	await tui.waitForOpen();

	assert.deepEqual(state.symbols, ["NVDA"]);
	assert.deepEqual(state.applied, [["NVDA"]]);
	assert.doesNotMatch(tui.render().join("\n"), /MSFT/);
	tui.press("ctrl+c");
	await running;
});

test("adds and selects one custom ticker from the integrated action", async () => {
	const tui = createTuiHarness({ width: 72, rows: 22 });
	const input = vi.fn<ExtensionCommandContext["ui"]["input"]>(async () => "sol-usd");
	const { ctx } = tuiContext(tui, input);
	const state = createOptions(["NVDA"]);
	const running = showTickerMenu(ctx, state.options);
	await tui.waitForOpen();
	tui.setFocused(true);
	await moveDown(tui, 1);
	tui.press("tui.select.confirm");
	await tui.waitForPending();
	await tui.waitForOpen();

	assert.deepEqual(state.symbols, ["NVDA", "SOL-USD"]);
	assert.equal(input.mock.calls.length, 1);
	assert.match(tui.render().join("\n"), /\[x\] SOL-USD/);
	tui.press("ctrl+c");
	await running;
});

test("allows removing the final ticker and leaves an empty menu", async () => {
	const tui = createTuiHarness({ width: 72, rows: 22 });
	const { ctx } = tuiContext(tui);
	const state = createOptions(["MSFT"]);
	const running = showTickerMenu(ctx, state.options);
	await tui.waitForOpen();
	tui.setFocused(true);
	tui.press("tui.select.confirm");
	await tui.waitForPending();
	await tui.waitForOpen();

	assert.deepEqual(state.symbols, []);
	assert.deepEqual(state.applied, [[]]);
	assert.doesNotMatch(tui.render().join("\n"), /MSFT/);
	assert.match(tui.render().join("\n"), /Add custom ticker/);
	tui.press("ctrl+c");
	await running;
});

test("rolls back a toggle when persistence fails", async () => {
	const tui = createTuiHarness({ width: 72, rows: 22 });
	const { ctx, notifications } = tuiContext(tui);
	const state = createOptions(["NVDA", "AAPL"]);
	state.options.applySymbols = async () => {
		throw new Error("disk unavailable");
	};
	const running = showTickerMenu(ctx, state.options);
	await tui.waitForOpen();
	tui.setFocused(true);
	tui.press("tui.select.confirm");
	await tui.waitForPending();

	assert.deepEqual(state.symbols, ["NVDA", "AAPL"]);
	assert.match(notifications.at(-1)?.[0] ?? "", /disk unavailable/);
	assert.match(tui.render().join("\n"), /\[x\] NVDA/);
	tui.press("ctrl+c");
	await running;
});

test("starts with no predefined candidates or reset action", async () => {
	const rpc = createRpcHarness([{ kind: "select", response: "Close" }]);
	const { ctx } = rpcContext(rpc);
	const state = createOptions([]);
	await showTickerMenu(ctx, state.options);

	assert.deepEqual(state.symbols, []);
	assert.deepEqual(state.applied, []);
	assert.deepEqual(rpc.dialogs[0]?.options, [
		"Add custom ticker…",
		"Widget: On",
		"Refresh now",
		"Close",
	]);
	rpc.assertConsumed();
});

test("toggles and persists widget visibility from the TUI manager", async () => {
	const tui = createTuiHarness({ width: 72, rows: 22 });
	const { ctx } = tuiContext(tui);
	const state = createOptions(["NVDA"]);
	const running = showTickerMenu(ctx, state.options);
	await tui.waitForOpen();
	tui.setFocused(true);
	await moveDown(tui, 2);
	assert.match(tui.render().join("\n"), /› Widget: On/);
	tui.press("tui.select.confirm");
	await tui.waitForPending();

	assert.equal(state.widgetEnabled, false);
	assert.match(tui.render().join("\n"), /› Widget: Off/);
	tui.press("ctrl+c");
	await running;
});

test("toggles and persists widget visibility in RPC mode", async () => {
	const rpc = createRpcHarness([
		{ kind: "select", response: "Widget: On" },
		{ kind: "select", response: "Close" },
	]);
	const { ctx } = rpcContext(rpc);
	const state = createOptions(["NVDA"]);
	await showTickerMenu(ctx, state.options);

	assert.equal(state.widgetEnabled, false);
	assert.ok(rpc.dialogs[1]?.options?.includes("Widget: Off"));
	rpc.assertConsumed();
});

test("keeps RPC widget state unchanged when persistence fails", async () => {
	const rpc = createRpcHarness([
		{ kind: "select", response: "Widget: On" },
		{ kind: "select", response: "Close" },
	]);
	const { ctx, notifications } = rpcContext(rpc);
	const state = createOptions(["NVDA"]);
	state.options.applyWidgetEnabled = async () => {
		throw new Error("disk unavailable");
	};
	await showTickerMenu(ctx, state.options);

	assert.equal(state.widgetEnabled, true);
	assert.ok(rpc.dialogs[1]?.options?.includes("Widget: On"));
	assert.match(notifications.at(-1)?.[0] ?? "", /disk unavailable/);
	rpc.assertConsumed();
});

test("reorders the focused ticker directly in the TUI manager", async () => {
	const tui = createTuiHarness({ width: 72, rows: 22 });
	const { ctx } = tuiContext(tui);
	const state = createOptions(["NVDA", "AAPL", "NET"]);
	const running = showTickerMenu(ctx, state.options);
	await tui.waitForOpen();
	tui.setFocused(true);
	assert.match(tui.render().join("\n"), /Manage tickers/);
	assert.doesNotMatch(tui.render().join("\n"), /Reorder tickers/);

	tui.press("tui.select.down");
	tui.send("\u001b[1;2B");
	await tui.waitForPending();

	assert.deepEqual(state.symbols, ["NVDA", "NET", "AAPL"]);
	assert.match(tui.render().join("\n"), /› \[x\] AAPL/);
	tui.press("ctrl+c");
	await running;
});

test("reorders tickers and preserves the new order in RPC mode", async () => {
	const rpc = createRpcHarness([
		{ kind: "select", response: "Reorder tickers…" },
		{ kind: "select", response: "2. AAPL" },
		{ kind: "select", response: "Move down" },
		{ kind: "select", response: undefined },
		{ kind: "select", response: undefined },
		{ kind: "select", response: "Close" },
	]);
	const { ctx } = rpcContext(rpc);
	const state = createOptions(["NVDA", "AAPL", "NET"]);
	await showTickerMenu(ctx, state.options);

	assert.deepEqual(state.symbols, ["NVDA", "NET", "AAPL"]);
	assert.deepEqual(state.applied, [["NVDA", "NET", "AAPL"]]);
	assert.deepEqual(rpc.dialogs[2]?.options, ["Move up", "Move down"]);
	assert.deepEqual(rpc.dialogs[4]?.options, ["1. NVDA", "2. NET", "3. AAPL", "Back"]);
	assert.deepEqual(rpc.dialogs[5]?.options?.slice(0, 3), ["[x] NVDA", "[x] NET", "[x] AAPL"]);
	rpc.assertConsumed();
});

test("adapts toggle and custom-input actions to RPC", async () => {
	const rpc = createRpcHarness([
		{ kind: "select", response: "[x] AAPL" },
		{ kind: "select", response: "Add custom ticker…" },
		{
			kind: "input",
			title: "Add custom ticker",
			placeholder: "Yahoo symbol, for example MSFT or SOL-USD",
			response: "SOL-USD",
		},
		{ kind: "select", response: "Close" },
	]);
	const { ctx } = rpcContext(rpc);
	const state = createOptions(["NVDA", "AAPL"]);
	await showTickerMenu(ctx, state.options);

	assert.deepEqual(state.symbols, ["NVDA", "SOL-USD"]);
	assert.deepEqual(state.applied, [["NVDA"], ["NVDA", "SOL-USD"]]);
	rpc.assertConsumed();
});

test.each([
	{ name: "cancelled", response: undefined, notice: undefined },
	{ name: "empty", response: "   ", notice: undefined },
	{ name: "duplicate", response: "NVDA", notice: /already selected/ },
	{ name: "multiple", response: "BTC-USD ETH-USD", notice: /exactly one/ },
])("keeps settings unchanged for $name custom input", async ({ response, notice }) => {
	const rpc = createRpcHarness([
		{ kind: "select", response: "Add custom ticker…" },
		{
			kind: "input",
			title: "Add custom ticker",
			placeholder: "Yahoo symbol, for example MSFT or SOL-USD",
			response,
		},
		{ kind: "select", response: "Close" },
	]);
	const { ctx, notifications } = rpcContext(rpc);
	const state = createOptions(["NVDA"]);
	await showTickerMenu(ctx, state.options);

	assert.deepEqual(state.symbols, ["NVDA"]);
	assert.deepEqual(state.applied, []);
	if (notice) assert.match(notifications.at(-1)?.[0] ?? "", notice);
	else assert.equal(notifications.length, 0);
	rpc.assertConsumed();
});

test("aborts and drains pending toggle work when the menu owner is replaced", async () => {
	const tui = createTuiHarness({ width: 72, rows: 22 });
	const { ctx } = tuiContext(tui);
	const state = createOptions(["NVDA", "AAPL"]);
	let started!: () => void;
	const actionStarted = new Promise<void>((resolve) => {
		started = resolve;
	});
	let drained = false;
	state.options.applySymbols = async (_symbols, signal) => {
		started();
		if (!signal.aborted) {
			await new Promise<void>((resolve) =>
				signal.addEventListener("abort", () => resolve(), { once: true }),
			);
		}
		drained = true;
	};
	const running = showTickerMenu(ctx, state.options);
	await tui.waitForOpen();
	tui.setFocused(true);
	tui.press("tui.select.confirm");
	await actionStarted;
	state.controller.abort();
	await running;

	assert.equal(drained, true);
	assert.deepEqual(state.applied, []);
});

test("does not open custom UI or mutate settings in JSON mode", async () => {
	const custom = vi.fn<ExtensionCommandContext["ui"]["custom"]>();
	const ctx = {
		mode: "json",
		hasUI: false,
		ui: { custom },
	} as unknown as ExtensionCommandContext;
	const state = createOptions(["NVDA"]);
	await showTickerMenu(ctx, state.options);

	assert.equal(custom.mock.calls.length, 0);
	assert.deepEqual(state.applied, []);
});

test("aborts a pending RPC menu when its owner is replaced", async () => {
	const rpc = createRpcHarness([{ kind: "select", waitForAbort: true }]);
	const { ctx } = rpcContext(rpc);
	const state = createOptions(["NVDA"]);
	const running = showTickerMenu(ctx, state.options);
	await rpc.waitForCall();
	state.controller.abort();
	await running;

	assert.deepEqual(state.applied, []);
	rpc.assertConsumed();
});
