import assert from "node:assert/strict";
import { resolveMenuScreen } from "@narumitw/pi-tui-kit";
import { test } from "vitest";
import { createMockContext } from "../../../test/support.js";
import {
	type CodexCompactSettingsRuntime,
	type CodexCompactSettingsState,
	DEFAULT_CODEX_COMPACT_SETTINGS,
} from "../src/settings.js";
import {
	compactMenuStatus,
	createCodexCompactMenu,
	showCodexCompactMenu,
} from "../src/settings-menu.js";

function memoryRuntime(kind: CodexCompactSettingsState["kind"] = "missing") {
	let state: CodexCompactSettingsState = {
		kind,
		path: "/tmp/pi-codex-compact.json",
		settings: { ...DEFAULT_CODEX_COMPACT_SETTINGS },
		...(kind === "invalid" ? { issue: "bad file" } : { document: {} }),
	};
	const patches: unknown[] = [];
	const runtime: CodexCompactSettingsRuntime = {
		get: () => structuredClone(state),
		async reload() {
			return structuredClone(state);
		},
		async update(patch) {
			patches.push(patch);
			state = { ...state, kind: "loaded", settings: { ...state.settings, ...patch } };
			return structuredClone(state);
		},
		async flush() {},
	};
	return { runtime, patches };
}

test("root menu makes manual compaction primary and exposes its effective route", () => {
	const current = memoryRuntime();
	const customModel = {
		provider: "company-codex-proxy",
		id: "gpt-5.6",
		api: "openai-codex-responses",
	};
	const customContext = createMockContext({ model: customModel }).ctx;
	assert.deepEqual(compactMenuStatus(customContext), {
		model: "company-codex-proxy/gpt-5.6",
		api: "openai-codex-responses",
	});
	const openAIStatus = compactMenuStatus(
		createMockContext({ model: { ...customModel, api: "openai-responses" } }).ctx,
	);
	assert.equal(openAIStatus.api, "openai-responses");
	const ineligibleStatus = compactMenuStatus(
		createMockContext({ model: { ...customModel, api: "anthropic-messages" } }).ctx,
	);
	const menu = createCodexCompactMenu(current.runtime, {
		status: { model: "openai-codex/gpt-5.6", api: "openai-codex-responses" },
	});
	assert.equal(menu.start, "main");
	const main = resolveMenuScreen(menu, "main", current.runtime.get());
	assert.equal(main.kind, "actions");
	if (main.kind !== "actions") assert.fail("Expected actions screen");
	assert.deepEqual(
		main.items.map((item) => item.label),
		["Compact now", "Settings", "Close"],
	);
	assert.match(main.lines?.join("\n") ?? "", /openai-codex\/gpt-5\.6/);
	assert.match(main.lines?.join("\n") ?? "", /Responses Remote V2/);
	const ineligible = resolveMenuScreen(
		createCodexCompactMenu(current.runtime, { status: ineligibleStatus }),
		"main",
		current.runtime.get(),
	);
	assert.equal(ineligible.kind, "actions");
	if (ineligible.kind !== "actions") assert.fail("Expected ineligible actions screen");
	assert.match(
		ineligible.lines?.join("\n") ?? "",
		/Pi native \(API anthropic-messages does not support Responses compaction\)/,
	);
	const disabled = resolveMenuScreen(menu, "main", {
		...current.runtime.get(),
		settings: { ...current.runtime.get().settings, enabled: false },
	});
	assert.equal(disabled.kind, "actions");
	if (disabled.kind !== "actions") assert.fail("Expected disabled actions screen");
	assert.match(disabled.lines?.join("\n") ?? "", /Pi native \(remote compaction is disabled\)/);
	const openAI = resolveMenuScreen(
		createCodexCompactMenu(current.runtime, { status: openAIStatus }),
		"main",
		current.runtime.get(),
	);
	assert.equal(openAI.kind, "actions");
	if (openAI.kind !== "actions") assert.fail("Expected OpenAI actions screen");
	assert.match(openAI.lines?.join("\n") ?? "", /Responses Compact API/);
});

test("settings screen exposes bounded controls and invalid files remain repairable", () => {
	const current = memoryRuntime();
	const menu = createCodexCompactMenu(current.runtime);
	const screen = resolveMenuScreen(menu, "settings", current.runtime.get());
	assert.equal(screen.kind, "settings");
	if (screen.kind !== "settings") assert.fail("Expected settings screen");
	assert.deepEqual(
		screen.items.map((item) => [item.id, item.currentValue]),
		[
			["enabled", "On"],
			["protocol", "Auto"],
			["requestTimeoutMs", "5 min"],
			["maxRetries", "2"],
			["replacementTokenBudget", "64K tokens"],
			["notifyOnFallback", "On"],
		],
	);

	const invalid = memoryRuntime("invalid");
	const invalidMenu = createCodexCompactMenu(invalid.runtime);
	const invalidMain = resolveMenuScreen(invalidMenu, "main", invalid.runtime.get());
	assert.equal(invalidMain.kind, "actions");
	if (invalidMain.kind !== "actions") assert.fail("Expected invalid root actions");
	assert.equal("to" in invalidMain.items[1] ? invalidMain.items[1].to : undefined, "invalid");
	const detail = resolveMenuScreen(invalidMenu, "invalid", invalid.runtime.get());
	assert.equal(detail.kind, "detail");
	if (detail.kind !== "detail") assert.fail("Expected invalid detail");
	assert.match(detail.lines.join("\n"), /will not be overwritten/);
});

test("manual action closes the menu and records one explicit request", async () => {
	const memory = memoryRuntime();
	let requests = 0;
	const menu = createCodexCompactMenu(memory.runtime, {
		onCompactRequested: () => {
			requests += 1;
		},
	});
	const result = await menu.actions["compact-now"]({
		ctx: createMockContext({ mode: "tui" }).ctx,
		state: memory.runtime.get(),
		signal: new AbortController().signal,
		itemId: "compact-now",
	});
	assert.deepEqual(result, { kind: "close" });
	assert.equal(requests, 1);
});

test("menu actions persist exact setting patches", async () => {
	const memory = memoryRuntime();
	const menu = createCodexCompactMenu(memory.runtime);
	const { ctx } = createMockContext({ mode: "tui" });
	const action = (value: string) => ({
		ctx,
		state: memory.runtime.get(),
		signal: new AbortController().signal,
		itemId: "setting",
		value,
	});
	await menu.actions["set-enabled"](action("Off"));
	await menu.actions["set-protocol"](action("Responses Compact"));
	await menu.actions["set-timeout"](action("10 min"));
	await menu.actions["set-retries"](action("1"));
	await menu.actions["set-retention"](action("96K tokens"));
	await menu.actions["set-notify"](action("Off"));
	assert.deepEqual(memory.patches, [
		{ enabled: false },
		{ protocol: "responses-compact" },
		{ requestTimeoutMs: 600_000 },
		{ maxRetries: 1 },
		{ replacementTokenBudget: 96_000 },
		{ notifyOnFallback: false },
	]);
});

test("stale settings saves do not notify through a disposed menu", async () => {
	const memory = memoryRuntime();
	let release!: () => void;
	const blocked = new Promise<void>((resolve) => {
		release = resolve;
	});
	const runtime: CodexCompactSettingsRuntime = {
		...memory.runtime,
		async update(patch) {
			await blocked;
			return memory.runtime.update(patch);
		},
	};
	const menu = createCodexCompactMenu(runtime);
	const controller = new AbortController();
	const { ctx, notifications } = createMockContext({ mode: "tui" });
	const pending = menu.actions["set-enabled"]({
		ctx,
		state: runtime.get(),
		signal: controller.signal,
		itemId: "enabled",
		value: "Off",
	});
	controller.abort();
	release();
	assert.deepEqual(await pending, { kind: "rejected" });
	assert.deepEqual(notifications, []);
});

test("TUI manual action compacts once after close and reports core errors", async () => {
	const memory = memoryRuntime();
	let compactions = 0;
	let compactOptions: { onError?: (error: Error) => void } | undefined;
	const { ctx, notifications } = createMockContext({
		mode: "tui",
		model: { provider: "openai-codex", id: "gpt-5.6", api: "openai-codex-responses" },
		select: async (_title: string, options: string[]) =>
			options.find((option) => option.startsWith("Compact now")),
		compact: (options: { onError?: (error: Error) => void }) => {
			compactions += 1;
			compactOptions = options;
		},
	});
	await showCodexCompactMenu(memory.runtime, ctx, {
		signal: new AbortController().signal,
		isCurrent: () => true,
	});
	assert.equal(compactions, 1);
	compactOptions?.onError?.(new Error("nothing to compact"));
	assert.match(notifications.at(-1)?.message ?? "", /nothing to compact/);
	assert.equal(notifications.at(-1)?.level, "error");
});

test("stale menu ownership cannot trigger delayed manual compaction", async () => {
	const memory = memoryRuntime();
	let current = true;
	let compactions = 0;
	const { ctx } = createMockContext({
		mode: "tui",
		select: async (_title: string, options: string[]) => {
			current = false;
			return options.find((option) => option.startsWith("Compact now"));
		},
		compact: () => {
			compactions += 1;
		},
	});
	await showCodexCompactMenu(memory.runtime, ctx, {
		signal: new AbortController().signal,
		isCurrent: () => current,
	});
	assert.equal(compactions, 0);
});

test("non-TUI command reports through RPC and remains silent in print mode", async () => {
	const memory = memoryRuntime();
	let compactions = 0;
	const rpc = createMockContext({
		mode: "rpc",
		hasUI: true,
		compact: () => {
			compactions += 1;
		},
	});
	await showCodexCompactMenu(memory.runtime, rpc.ctx, {
		signal: new AbortController().signal,
		isCurrent: () => true,
	});
	assert.match(rpc.notifications[0]?.message ?? "", /pi-codex-compact\.json/);

	const print = createMockContext({ mode: "print", hasUI: false });
	await showCodexCompactMenu(memory.runtime, print.ctx, {
		signal: new AbortController().signal,
		isCurrent: () => true,
	});
	assert.deepEqual(print.notifications, []);
	assert.equal(compactions, 0);
});
