import assert from "node:assert/strict";
import { resolveMenuScreen } from "@narumitw/pi-tui-kit";
import { createRpcHarness, createTuiHarness } from "@narumitw/pi-tui-kit/testing";
import { test } from "vitest";
import { createMockContext } from "../../../test/support.js";
import { DEFAULT_STAMP_SETTINGS } from "../src/format.js";
import { createStampMenu, showStampMenu } from "../src/menu.js";
import type {
	StampSettingsPatch,
	StampSettingsRuntime,
	StampSettingsState,
} from "../src/settings.js";

test("stamp menu exposes Main, Settings, Status, Help, and read-only invalid state", () => {
	const runtime = memorySettingsRuntime();
	const menu = createStampMenu(runtime);
	const state = runtime.get();
	const main = resolveMenuScreen(menu, "main", state);
	assert.equal(main.kind, "actions");
	if (main.kind !== "actions") assert.fail("Expected actions screen");
	assert.deepEqual(
		main.items.map((item) => item.label),
		["Settings", "Status", "Help", "Close"],
	);

	const settings = resolveMenuScreen(menu, "settings", state);
	assert.equal(settings.kind, "settings");
	if (settings.kind !== "settings") assert.fail("Expected settings screen");
	assert.deepEqual(
		settings.items.map((item) => [item.id, item.currentValue]),
		[
			["hourCycle", "24-hour"],
			["showSeconds", "Show"],
			["dateContext", "Day changes"],
			["locale", "Invariant"],
			["timeZone", "Local"],
			["responseTiming", "Off"],
			["showExactTimeline", "Show"],
			["assistantMetadata", "Off"],
			["showThinkingLevel", "Show"],
			["showCompactAbnormalOutcome", "Show"],
			["showCostSinceUser", "Hide"],
			["toolStamps", "Hide"],
		],
	);
	assert.match((main.lines ?? []).join("\n"), /Timing off/u);
	assert.match((main.lines ?? []).join("\n"), /Timeline shown/u);
	assert.match((main.lines ?? []).join("\n"), /Metadata off/u);
	assert.match((main.lines ?? []).join("\n"), /Thinking shown/u);
	assert.match((main.lines ?? []).join("\n"), /Abnormal shown/u);
	assert.match((main.lines ?? []).join("\n"), /Cost since user hidden/u);
	assert.match((main.lines ?? []).join("\n"), /Tool stamps hidden/u);

	const status = resolveMenuScreen(menu, "status", state);
	assert.equal(status.kind, "detail");
	if (status.kind !== "detail") assert.fail("Expected detail screen");
	assert.match(status.lines.join("\n"), /24-hour.*Built-in/u);
	assert.match(status.lines.join("\n"), /Response timing: Off · Built-in/u);
	assert.match(status.lines.join("\n"), /Exact timeline: Show · Built-in/u);
	assert.match(status.lines.join("\n"), /Assistant metadata: Off · Built-in/u);
	assert.match(status.lines.join("\n"), /Thinking level: Show · Built-in/u);
	assert.match(status.lines.join("\n"), /Compact abnormal outcome: Show · Built-in/u);
	assert.match(status.lines.join("\n"), /Cost since user message: Hide · Built-in/u);
	assert.match(status.lines.join("\n"), /Tool stamps: Hide · Built-in/u);
	assert.match(status.lines.join("\n"), /\/tmp\/pi-stamp\.json/u);

	const invalidState = {
		...state,
		issue: { kind: "invalid" as const, message: "bad settings" },
		canSave: false,
	};
	const invalidMain = resolveMenuScreen(menu, "main", invalidState);
	assert.equal(invalidMain.kind, "actions");
	if (invalidMain.kind !== "actions") assert.fail("Expected actions screen");
	const invalidSettingsItem = invalidMain.items[0];
	assert.ok(invalidSettingsItem);
	assert.equal("to" in invalidSettingsItem ? invalidSettingsItem.to : undefined, "invalid");
	const invalid = resolveMenuScreen(menu, "invalid", invalidState);
	assert.equal(invalid.kind, "detail");
	if (invalid.kind !== "detail") assert.fail("Expected detail screen");
	assert.match(invalid.lines.join("\n"), /will not be overwritten/u);
});

test("bounded setting actions persist exact patches", async () => {
	const runtime = memorySettingsRuntime();
	const menu = createStampMenu(runtime);
	const { ctx, notifications } = createMockContext({ mode: "tui" });

	assert.deepEqual(
		await menu.actions["set-hour-cycle"]({
			ctx,
			state: runtime.get(),
			signal: new AbortController().signal,
			itemId: "hourCycle",
			value: "12-hour",
		}),
		{ kind: "stay" },
	);
	await menu.actions["set-seconds"]({
		ctx,
		state: runtime.get(),
		signal: new AbortController().signal,
		itemId: "showSeconds",
		value: "Hide",
	});
	await menu.actions["set-date-context"]({
		ctx,
		state: runtime.get(),
		signal: new AbortController().signal,
		itemId: "dateContext",
		value: "Always",
	});
	await menu.actions["set-response-timing"]({
		ctx,
		state: runtime.get(),
		signal: new AbortController().signal,
		itemId: "responseTiming",
		value: "Duration",
	});
	await menu.actions["set-response-timing"]({
		ctx,
		state: runtime.get(),
		signal: new AbortController().signal,
		itemId: "responseTiming",
		value: "Detailed",
	});
	await menu.actions["set-response-timing"]({
		ctx,
		state: runtime.get(),
		signal: new AbortController().signal,
		itemId: "responseTiming",
		value: "Off",
	});
	for (const value of ["Show", "Hide"] as const) {
		await menu.actions["set-exact-timeline"]({
			ctx,
			state: runtime.get(),
			signal: new AbortController().signal,
			itemId: "showExactTimeline",
			value,
		});
	}
	for (const value of ["Compact", "Expanded", "Off"] as const) {
		await menu.actions["set-assistant-metadata"]({
			ctx,
			state: runtime.get(),
			signal: new AbortController().signal,
			itemId: "assistantMetadata",
			value,
		});
	}
	for (const value of ["Show", "Hide"] as const) {
		await menu.actions["set-thinking-level"]({
			ctx,
			state: runtime.get(),
			signal: new AbortController().signal,
			itemId: "showThinkingLevel",
			value,
		});
	}
	for (const value of ["Show", "Hide"] as const) {
		await menu.actions["set-compact-abnormal-outcome"]({
			ctx,
			state: runtime.get(),
			signal: new AbortController().signal,
			itemId: "showCompactAbnormalOutcome",
			value,
		});
	}
	for (const value of ["Show", "Hide"] as const) {
		await menu.actions["set-cost-since-user"]({
			ctx,
			state: runtime.get(),
			signal: new AbortController().signal,
			itemId: "showCostSinceUser",
			value,
		});
	}
	for (const value of ["Show", "Hide"] as const) {
		await menu.actions["set-tool-stamps"]({
			ctx,
			state: runtime.get(),
			signal: new AbortController().signal,
			itemId: "toolStamps",
			value,
		});
	}
	assert.deepEqual(runtime.patches, [
		{ hourCycle: "12h" },
		{ showSeconds: false },
		{ dateContext: "always" },
		{ responseTiming: "duration" },
		{ responseTiming: "detailed" },
		{ responseTiming: "off" },
		{ showExactTimeline: true },
		{ showExactTimeline: false },
		{ assistantMetadata: "compact" },
		{ assistantMetadata: "expanded" },
		{ assistantMetadata: "off" },
		{ showThinkingLevel: true },
		{ showThinkingLevel: false },
		{ showCompactAbnormalOutcome: true },
		{ showCompactAbnormalOutcome: false },
		{ showCostSinceUser: true },
		{ showCostSinceUser: false },
		{ toolStamps: true },
		{ toolStamps: false },
	]);
	assert.equal(notifications.at(-1)?.level, "info");
});

test("custom locale and time-zone screens validate and save canonical raw input", async () => {
	const runtime = memorySettingsRuntime();
	const { ctx, notifications } = createMockContext({ mode: "tui" });
	const menu = createStampMenu(runtime);
	const actionContext = (value?: string) => ({
		ctx,
		state: runtime.get(),
		signal: new AbortController().signal,
		itemId: "custom",
		value,
	});

	assert.deepEqual(await menu.actions["choose-custom-locale"](actionContext()), {
		kind: "stay",
	});
	const localeInput = resolveMenuScreen(menu, "locale", runtime.get());
	assert.equal(localeInput.kind, "input");
	if (localeInput.kind !== "input") assert.fail("Expected locale input screen");
	assert.equal(localeInput.action, "choose-custom-locale");
	assert.deepEqual(await menu.actions["choose-custom-locale"](actionContext("not_a_locale")), {
		kind: "rejected",
	});
	assert.deepEqual(await menu.actions["choose-custom-locale"](actionContext("EN-us")), {
		kind: "back",
	});

	assert.deepEqual(await menu.actions["choose-custom-time-zone"](actionContext()), {
		kind: "stay",
	});
	const timeZoneInput = resolveMenuScreen(menu, "time-zone", runtime.get());
	assert.equal(timeZoneInput.kind, "input");
	if (timeZoneInput.kind !== "input") assert.fail("Expected time-zone input screen");
	assert.equal(timeZoneInput.action, "choose-custom-time-zone");
	assert.deepEqual(await menu.actions["choose-custom-time-zone"](actionContext("Moon/Base")), {
		kind: "rejected",
	});
	assert.deepEqual(await menu.actions["choose-custom-time-zone"](actionContext("utc")), {
		kind: "back",
	});

	assert.deepEqual(runtime.patches, [{ locale: "en-US" }, { timeZone: "UTC" }]);
	assert.ok(notifications.some((notice) => notice.level === "warning"));
});

test("TUI custom input retains a rejected draft and Ctrl+C closes the menu", async () => {
	const runtime = memorySettingsRuntime();
	const tui = createTuiHarness({ width: 60, rows: 24 });
	const { ctx } = createMockContext({
		mode: "tui",
		hasUI: true,
		custom: tui.custom,
	});
	const running = showStampMenu(ctx, runtime, {
		signal: new AbortController().signal,
		isCurrent: () => true,
	});

	await tui.waitForOpen();
	tui.press("tui.select.confirm");
	await tui.waitForOpen();
	for (let index = 0; index < 3; index += 1) tui.press("tui.select.down");
	tui.press("tui.select.confirm");
	await tui.waitForPending();
	await tui.waitForOpen();
	tui.press("tui.select.down");
	tui.press("tui.select.down");
	tui.press("tui.select.confirm");
	await tui.waitForPending();
	await tui.waitForOpen();
	tui.setFocused(true);
	tui.type("not_a_locale");
	tui.press("tui.input.submit");
	await tui.waitForPending();
	const rejectedRender = tui.render().join("\n");
	tui.send("\u0015");
	tui.type("EN-us");
	tui.press("tui.input.submit");
	await tui.waitForPending();
	await tui.waitForOpen();
	tui.press("ctrl+c");

	const result = await running;
	assert.equal(result.kind, "closed");
	assert.equal(tui.openCount, 5);
	assert.match(rejectedRender, /not_a_locale/u);
	assert.deepEqual(runtime.patches, [{ locale: "en-US" }]);
});

test("RPC custom input retries a rejected value before saving", async () => {
	const runtime = memorySettingsRuntime();
	const rpc = createRpcHarness([
		{
			kind: "select",
			title:
				"Stamp\n24-hour · seconds · Day changes · Invariant · Local · Timing off · Timeline shown · Metadata off · Thinking shown · Abnormal shown · Cost since user hidden · Tool stamps hidden",
			options: ["Settings", "Status", "Help", "Close"],
			response: "Settings",
		},
		{
			kind: "select",
			title: "Stamp Settings\nUser settings · /tmp/pi-stamp.json",
			options: [
				"Hour cycle (24-hour)",
				"Seconds (Show)",
				"Date context (Day changes)",
				"Locale (Invariant)",
				"Time zone (Local)",
				"Response timing (Off)",
				"Exact timeline (Show)",
				"Assistant metadata (Off)",
				"Thinking level (Show)",
				"Compact abnormal outcome (Show)",
				"Cost since user message (Hide)",
				"Tool stamps (Hide)",
				"Back",
			],
			response: "Locale (Invariant)",
		},
		{
			kind: "select",
			title: "Stamp Locale\nCurrent: Invariant",
			options: ["Invariant (default)", "System locale", "Custom BCP 47 locale…"],
			response: "Custom BCP 47 locale…",
		},
		{
			kind: "input",
			title: "Custom BCP 47 locale\nCurrent: Invariant",
			placeholder: "Examples: en-US, fr-FR, zh-TW",
			response: "not_a_locale",
		},
		{
			kind: "input",
			title: "Custom BCP 47 locale\nCurrent: Invariant",
			placeholder: "Examples: en-US, fr-FR, zh-TW",
			response: "EN-us",
		},
		{
			kind: "select",
			title: "Stamp Settings\nUser settings · /tmp/pi-stamp.json",
			options: [
				"Hour cycle (24-hour)",
				"Seconds (Show)",
				"Date context (Day changes)",
				"Locale (en-US)",
				"Time zone (Local)",
				"Response timing (Off)",
				"Exact timeline (Show)",
				"Assistant metadata (Off)",
				"Thinking level (Show)",
				"Compact abnormal outcome (Show)",
				"Cost since user message (Hide)",
				"Tool stamps (Hide)",
				"Back",
			],
			response: undefined,
		},
		{
			kind: "select",
			title:
				"Stamp\n24-hour · seconds · Day changes · en-US · Local · Timing off · Timeline shown · Metadata off · Thinking shown · Abnormal shown · Cost since user hidden · Tool stamps hidden",
			options: ["Settings", "Status", "Help", "Close"],
			response: "Close",
		},
	]);
	const { ctx } = createMockContext({
		mode: "rpc",
		hasUI: true,
		...rpc.ui,
	});

	const result = await showStampMenu(ctx, runtime, {
		signal: new AbortController().signal,
		isCurrent: () => true,
	});

	assert.equal(result.kind, "closed");
	assert.equal(rpc.dialogs.filter((dialog) => dialog.kind === "input").length, 2);
	assert.deepEqual(runtime.patches, [{ locale: "en-US" }]);
	rpc.assertConsumed();
});

test("save failure is rejected without changing effective settings", async () => {
	const runtime = memorySettingsRuntime({
		rejectUpdate: new Error("save\u001b[31m\u202espoofed rejected"),
	});
	const menu = createStampMenu(runtime);
	const { ctx, notifications } = createMockContext({ mode: "tui" });
	const result = await menu.actions["set-seconds"]({
		ctx,
		state: runtime.get(),
		signal: new AbortController().signal,
		itemId: "showSeconds",
		value: "Hide",
	});
	assert.deepEqual(result, { kind: "rejected" });
	assert.equal(runtime.get().settings.showSeconds, true);
	const message = notifications.at(-1)?.message ?? "";
	assert.equal(message.includes("\u001b"), false);
	assert.equal(message.includes("\u202e"), false);
});

test("RPC adapts the standard menu and an aborted owner closes stale work", async () => {
	const runtime = memorySettingsRuntime();
	const choices: string[][] = [];
	const { ctx } = createMockContext({
		mode: "rpc",
		select: async (_title: string, options: string[]) => {
			choices.push(options);
			return "Close";
		},
	});
	const controller = new AbortController();
	const result = await showStampMenu(ctx, runtime, {
		signal: controller.signal,
		isCurrent: () => true,
	});
	assert.equal(result.kind, "closed");
	assert.deepEqual(choices[0], ["Settings", "Status", "Help", "Close"]);

	controller.abort();
	assert.equal(
		(
			await showStampMenu(ctx, runtime, {
				signal: controller.signal,
				isCurrent: () => false,
			})
		).kind,
		"stale",
	);
});

function memorySettingsRuntime(
	options: { rejectUpdate?: Error } = {},
): StampSettingsRuntime & { patches: StampSettingsPatch[] } {
	let state: StampSettingsState = {
		settings: { ...DEFAULT_STAMP_SETTINGS },
		sources: {
			hourCycle: "built-in",
			showSeconds: "built-in",
			dateContext: "built-in",
			locale: "built-in",
			timeZone: "built-in",
			responseTiming: "built-in",
			assistantMetadata: "built-in",
			showExactTimeline: "built-in",
			showThinkingLevel: "built-in",
			showCompactAbnormalOutcome: "built-in",
			showCostSinceUser: "built-in",
			toolStamps: "built-in",
		},
		canSave: true,
	};
	const patches: StampSettingsPatch[] = [];
	return {
		patches,
		get: () => state,
		getPath: () => "/tmp/pi-stamp.json",
		reload: async () => state,
		update: async (patch) => {
			if (options.rejectUpdate) throw options.rejectUpdate;
			patches.push(patch);
			state = {
				...state,
				settings: { ...state.settings, ...patch },
				sources: {
					...state.sources,
					...Object.fromEntries(Object.keys(patch).map((key) => [key, "user"])),
				},
			};
			return state;
		},
		flush: async () => undefined,
	};
}
