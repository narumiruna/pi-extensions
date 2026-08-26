import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { initTheme } from "@earendil-works/pi-coding-agent";
import {
	CURSOR_MARKER,
	type Focusable,
	KeybindingsManager,
	setKeybindings,
	TUI_KEYBINDINGS,
	visibleWidth,
} from "@earendil-works/pi-tui";
import { test } from "vitest";
import {
	createMenuScreenComponent,
	type MenuScreenComponent,
	type MenuScreenEvent,
} from "../src/components/index.js";
import type { MenuScreen, MenuTransition } from "../src/types.js";

initTheme("dark", false);
const testKeybindings = new KeybindingsManager(TUI_KEYBINDINGS, {
	"tui.select.up": "k",
	"tui.select.down": "j",
	"tui.select.pageUp": "u",
	"tui.select.pageDown": "d",
	"tui.select.confirm": "l",
	"tui.select.cancel": "q",
});
setKeybindings(testKeybindings);

const inputFriendlyKeybindings = {
	matches(data: string, binding: string) {
		const inputs: Record<string, string> = {
			"tui.select.up": "\u001b[A",
			"tui.select.down": "\u001b[B",
			"tui.select.pageUp": "\u001b[5~",
			"tui.select.pageDown": "\u001b[6~",
			"tui.select.confirm": "\r",
			"tui.select.cancel": "\u001b",
		};
		return data === inputs[binding];
	},
	getKeys(binding: string) {
		const keys: Record<string, readonly string[]> = {
			"tui.select.up": ["up"],
			"tui.select.down": ["down"],
			"tui.select.pageUp": ["pageup"],
			"tui.select.pageDown": ["pagedown"],
			"tui.select.confirm": ["enter"],
			"tui.select.cancel": ["escape", "ctrl+c"],
		};
		return keys[binding] ?? [];
	},
};

type ScreenId = "main" | "detail";
type ActionId = "run" | "choose" | "setting" | "toggle";

const actionScreen: MenuScreen<ScreenId, ActionId> = {
	kind: "actions",
	title: "Unsafe\u001b]8;;title\u0007",
	lines: ["A long summary that must wrap safely at narrow terminal widths."],
	items: [
		{ id: "run", label: "Run operation", action: "run" },
		{ id: "detail", label: "Open details", description: "Read-only state", to: "detail" },
		{ id: "close", label: "Close", close: true },
	],
	hint: "close",
};

const detailScreen: MenuScreen<ScreenId, ActionId> = {
	kind: "detail",
	title: "Details",
	lines: [
		"One very long detail line that must remain visible without crossing the terminal width.",
	],
	hint: "back",
};

const choiceScreen: MenuScreen<ScreenId, ActionId> = {
	kind: "choice",
	title: "Information profile",
	lines: ["Current profile: Custom"],
	items: [
		{
			id: "minimal",
			label: "Minimal",
			description: "Small output",
			details: ["Segments: model · git"],
		},
		{
			id: "balanced",
			label: "Balanced",
			description: "Recommended",
			details: ["Segments: model · tokens · git"],
		},
		{
			id: "verbose",
			label: "Verbose\u001b]8;;unsafe\u0007",
			description: "Everything",
			details: ["Unsafe\u001b[31m detail", "Second detail"],
			disabled: true,
			disabledReason: "Unavailable\u0007 here",
		},
	],
	action: "choose",
	currentItemId: "minimal",
	initialItemId: "balanced",
	viewportSize: 2,
	hint: "back",
};

const settingsScreen: MenuScreen<ScreenId, ActionId> = {
	kind: "settings",
	title: "Settings",
	lines: ["Changes save immediately."],
	items: [
		{
			id: "automatic",
			label: "Automatic start",
			description: "Start on every session",
			currentValue: "Off",
			values: ["Off", "On"],
			action: "setting",
		},
		{
			id: "manual",
			label: "Manual mode",
			currentValue: "Off",
			values: ["Off", "On"],
			action: "setting",
		},
	],
};

const multiSelectScreen: MenuScreen<ScreenId, ActionId> = {
	kind: "multiSelect",
	title: "Tools",
	items: [
		{ id: "one", label: "tool_one", selected: true },
		{ id: "two", label: "tool_two", selected: false },
	],
	action: "toggle",
	actions: [{ id: "all", label: "Enable all", action: "run" }],
};

test("standard screens remain bounded and sanitize terminal controls", () => {
	for (const screen of [
		actionScreen,
		detailScreen,
		choiceScreen,
		settingsScreen,
		multiSelectScreen,
	]) {
		for (const width of [20, 40, 80, 120]) {
			const harness = componentHarness(screen);
			const lines = harness.component.render(width);
			assert.ok(lines.length > 0);
			const plainLines = lines.map((line) => stripVTControlCharacters(line));
			assert.equal(plainLines[0], "─".repeat(width), `${screen.kind} top rule at ${width}`);
			assert.equal(plainLines.at(-1), "─".repeat(width), `${screen.kind} bottom rule at ${width}`);
			assert.ok(
				lines.every((line) => visibleWidth(line) <= width),
				`${screen.kind} at ${width}`,
			);
			assert.equal(lines.join("\n").includes("\u001b]8;;title"), false);
			harness.component.dispose?.();
		}
	}
});

test("action screens prioritize actionable rows when terminal height is constrained", () => {
	const screen: MenuScreen<ScreenId, ActionId> = {
		...actionScreen,
		lines: [
			"Sync paused: owner unknown.",
			"Close other Pi sessions then restore; Settings and More return.",
		],
		items: [
			{ id: "restore", label: "Restore sync access… (recommended)", action: "run" },
			{ id: "status", label: "Status & changes", action: "run" },
			{ id: "history", label: "History & recovery…", to: "detail" },
			{ id: "help", label: "Help", action: "run" },
		],
	};
	const harness = componentHarness(screen, {
		plainTheme: true,
		rows: 12,
		keybindings: inputFriendlyKeybindings,
	});
	const lines = plainRender(harness.component, 32);
	assert.ok(lines.length <= 12);
	assert.equal(lines[0], "─".repeat(32));
	assert.equal(lines.at(-1), "─".repeat(32));
	assert.match(lines.join("\n"), /→ Restore sync access/u);
	assert.match(lines.join("\n"), /esc\s+close/u);

	const tinyHarness = componentHarness(screen, {
		selectedItemId: "help",
		plainTheme: true,
		rows: 7,
		keybindings: inputFriendlyKeybindings,
	});
	const tinyLines = plainRender(tinyHarness.component, 32);
	assert.ok(tinyLines.length <= 7);
	assert.equal(tinyLines[0], "─".repeat(32));
	assert.equal(tinyLines.at(-1), "─".repeat(32));
	assert.match(tinyLines.join("\n"), /→ Help/u);
	assert.match(tinyLines.join("\n"), /esc\s+close/u);
});

test("action screens honor injected navigation and distinguish Back from Ctrl+C Close", () => {
	const selected = componentHarness(actionScreen, { selectedItemId: "detail" });
	selected.component.handleInput("l");
	assert.deepEqual(selected.events, [{ kind: "activate", itemId: "detail" }]);

	const back = componentHarness({ ...actionScreen, hint: "back" });
	back.component.handleInput("q");
	assert.deepEqual(back.events, [{ kind: "back" }]);

	const close = componentHarness({ ...actionScreen, hint: "back" });
	close.component.handleInput("\u0003");
	assert.deepEqual(close.events, [{ kind: "close" }]);
});

test("disabled action rows keep long labels readable and explain why they are unavailable", () => {
	const label = "Redeem usage limit reset for the current account…";
	const screen: MenuScreen<ScreenId, ActionId> = {
		kind: "actions",
		title: "Usage",
		items: [
			{
				id: "run",
				label,
				description: "Current OAuth account",
				disabled: true,
				disabledReason: "No resets\u0007 available",
				action: "run",
			},
		],
	};
	const harness = componentHarness(screen, { plainTheme: true });
	for (const width of [1, 24, 40, 41, 80, 120]) {
		assert.ok(plainRender(harness.component, width).every((line) => visibleWidth(line) <= width));
	}
	const wide = plainRender(harness.component, 120).join("\n");
	assert.match(wide, new RegExp(`→ \\[-\\] ${label}`));
	assert.match(wide, /Current OAuth account/);
	assert.match(wide, /Unavailable: No resets available/);
	assert.equal(wide.includes("\u0007"), false);

	const narrow = plainRender(harness.component, 24).join("\n");
	assert.match(narrow, /→ \[-\].*…/);
	assert.match(narrow, /Unavailable: No resets\s+available/);
	harness.component.handleInput("l");
	assert.deepEqual(harness.events, []);
});

test("static lists use callback keybindings when they differ from the global manager", () => {
	const actions = componentHarness(actionScreen, {
		selectedItemId: "run",
		keybindings: inputFriendlyKeybindings,
	});
	actions.component.handleInput("\u001b[B");
	actions.component.handleInput("\r");
	assert.deepEqual(actions.events, [{ kind: "activate", itemId: "detail" }]);
	assert.deepEqual(actions.selectionChanges, ["detail"]);

	const choice = componentHarness(choiceScreen, {
		selectedItemId: "minimal",
		keybindings: inputFriendlyKeybindings,
	});
	choice.component.handleInput("\u001b[B");
	choice.component.handleInput("\r");
	assert.deepEqual(choice.events, [{ kind: "activate", itemId: "balanced" }]);
	assert.deepEqual(choice.selectionChanges, ["balanced"]);
});

test("choice screens render current state, initial selection, details, and disabled reasons", () => {
	const harness = componentHarness(choiceScreen, {
		plainTheme: true,
		selectedItemId: "balanced",
	});
	const lines = plainRender(harness.component, 80);
	assert.equal(lines[0], "─".repeat(80));
	assert.equal(lines.at(-1), "─".repeat(80));
	assert.match(lines.join("\n"), /Minimal.*✓ current/);
	assert.match(lines.join("\n"), /→ Balanced/);
	assert.match(lines.join("\n"), /Segments: model · tokens · git/);
	assert.doesNotMatch(lines.join("\n"), /Unsafe.*detail/);
	for (const width of [1, 20, 40, 80, 120]) {
		assert.ok(harness.component.render(width).every((line) => visibleWidth(line) <= width));
	}
});

test("choice screens use injected navigation, block disabled activation, and distinguish exits", () => {
	const disabled = componentHarness(choiceScreen, { selectedItemId: "balanced" });
	disabled.component.handleInput("j");
	assert.match(
		stripVTControlCharacters(disabled.component.render(80).join("\n")),
		/Unavailable here/,
	);
	disabled.component.handleInput("l");
	assert.deepEqual(disabled.events, []);
	disabled.component.handleInput("q");
	assert.deepEqual(disabled.events, [{ kind: "back" }]);

	const selected = componentHarness(choiceScreen, { selectedItemId: "minimal" });
	selected.component.handleInput("j");
	selected.component.handleInput(" ");
	assert.deepEqual(selected.events, [{ kind: "activate", itemId: "balanced" }]);

	const closed = componentHarness(choiceScreen);
	closed.component.handleInput("\u0003");
	assert.deepEqual(closed.events, [{ kind: "close" }]);
});

test("disposed choice screens ignore later input and dispose once", () => {
	const harness = componentHarness(choiceScreen, { selectedItemId: "balanced" });
	harness.component.dispose?.();
	harness.component.dispose?.();
	harness.component.handleInput("l");
	assert.deepEqual(harness.events, []);
});

test("choice screens page through a bounded viewport and sanitize all displayed text", () => {
	const items = Array.from({ length: 12 }, (_, index) => ({
		id: `choice-${index}`,
		label:
			index === 10 ? "詳細 🧭" : index === 11 ? "Unsafe\u001b]8;;label\u0007" : `Choice ${index}`,
		details: index === 11 ? ["Unsafe\u001b[31m detail"] : [`Detail ${index}`],
	}));
	const screen: MenuScreen<ScreenId, ActionId> = {
		kind: "choice",
		title: "Large choice",
		items,
		action: "choose",
		viewportSize: 3,
	};
	const harness = componentHarness(screen, { selectedItemId: "choice-0", plainTheme: true });
	harness.component.handleInput("d");
	assert.deepEqual(harness.selectionChanges, ["choice-3"]);
	const unicode = componentHarness(screen, { selectedItemId: "choice-10", plainTheme: true });
	assert.ok(unicode.component.render(8).every((line) => visibleWidth(line) <= 8));
	const unsafe = componentHarness(screen, { selectedItemId: "choice-11", plainTheme: true });
	const raw = unsafe.component.render(24).join("\n");
	const rendered = stripVTControlCharacters(raw);
	assert.equal(raw.includes("\u001b]8;;label"), false);
	assert.equal(raw.includes("\u001b[31m detail"), false);
	assert.match(rendered, /Unsafe .*label/);
	assert.match(rendered, /Unsafe .*detail/);
	assert.ok(harness.component.render(24).every((line) => visibleWidth(line) <= 24));
});

test("choice selection wraps single steps, clamps jumps, and handles empty lists", () => {
	const items = Array.from({ length: 6 }, (_, index) => ({
		id: `choice-${index}`,
		label: `Choice ${index}`,
	}));
	const screen: MenuScreen<ScreenId, ActionId> = {
		kind: "choice",
		title: "Selection movement",
		items,
		action: "choose",
		viewportSize: 2,
	};
	const harness = componentHarness(screen, { selectedItemId: "choice-0" });
	harness.component.handleInput("k");
	harness.component.handleInput("l");
	harness.component.handleInput("j");
	harness.component.handleInput("u");
	harness.component.handleInput("\u001b[F");
	harness.component.handleInput("l");
	harness.component.handleInput("\u001b[H");
	harness.component.handleInput("l");
	assert.deepEqual(harness.events, [
		{ kind: "activate", itemId: "choice-5" },
		{ kind: "activate", itemId: "choice-5" },
		{ kind: "activate", itemId: "choice-0" },
	]);

	const empty = componentHarness({ ...screen, items: [] });
	for (const input of ["k", "j", "u", "d", "\u001b[H", "\u001b[F", "l"]) {
		empty.component.handleInput(input);
	}
	assert.deepEqual(empty.selectionChanges, []);
	assert.deepEqual(empty.events, []);
});

test("theme invalidation rebuilds themed title content", () => {
	let accent = "first";
	const harness = componentHarness(actionScreen, {
		themePrefix: () => accent,
	});
	assert.match(harness.component.render(80).join("\n"), /first:Unsafe/);
	accent = "second";
	harness.component.invalidate();
	assert.match(harness.component.render(80).join("\n"), /second:Unsafe/);
});

test("settings restore a selected row when the screen is reopened", () => {
	const harness = componentHarness(settingsScreen, { selectedItemId: "manual" });
	assert.match(harness.component.render(80).join("\n"), /→ .*Manual mode/);
});

test("settings use Pi's searchable, aligned, bounded presentation", () => {
	const harness = componentHarness(largeSettingsScreen(), {
		plainTheme: true,
		selectedItemId: "setting-0",
	});
	const lines = plainRender(harness.component, 60);

	assert.equal(lines[0], "─".repeat(60));
	assert.equal(lines.at(-1), "─".repeat(60));
	assert.ok(lines.includes("Large settings"));
	assert.ok(lines.includes("Changes save immediately."));
	assert.ok(lines.some((line) => line.startsWith("> ")));
	const firstRow = lines.find((line) => line.includes("Setting 0"));
	const secondRow = lines.find((line) => line.includes("Longer setting 1"));
	assert.ok(firstRow);
	assert.ok(secondRow);
	assert.equal(firstRow.indexOf("Off"), secondRow.indexOf("On"));
	assert.ok(lines.some((line) => line.includes("Setting 9")));
	assert.equal(
		lines.some((line) => line.includes("Setting 10")),
		false,
	);
	assert.ok(lines.some((line) => line.includes("(1/12)")));
	assert.ok(lines.some((line) => line.includes("Description for setting 0")));
	const rendered = lines.join("\n");
	for (const hint of ["Type to search", "change", "back", "close"]) {
		assert.ok(rendered.includes(hint));
	}
});

test("settings search reports no matches and all presentation remains width-safe", () => {
	const harness = componentHarness(
		{
			kind: "settings",
			title: "介面設定",
			lines: ["搜尋並立即儲存設定。"],
			items: [
				{
					id: "display",
					label: "介面顯示設定",
					description: "選取項目的詳細說明",
					currentValue: "開啟",
					values: ["開啟", "關閉"],
					action: "setting",
				},
			],
		},
		{ plainTheme: true },
	);

	harness.component.handleInput("z");
	assert.ok(
		plainRender(harness.component, 40).some((line) => line.includes("No matching settings")),
	);
	harness.component.handleInput("\u007f");
	assert.ok(plainRender(harness.component, 40).some((line) => line.includes("介面顯示設定")));

	const empty = componentHarness(
		{ kind: "settings", title: "Empty settings", items: [] },
		{ plainTheme: true },
	);
	assert.ok(
		plainRender(empty.component, 40).some((line) => line.includes("No settings available")),
	);
	for (const width of [1, 2, 8, 20, 40]) {
		assert.ok(
			harness.component.render(width).every((line) => visibleWidth(line) <= width),
			`settings search at ${width}`,
		);
	}
});

test("settings fuzzy search activates stable raw rows and values", async () => {
	const rawValue = "On\u0007raw";
	const requests: Array<{ itemId: string; value: string; previousValue: string }> = [];
	const harness = componentHarness(
		{
			kind: "settings",
			title: "Settings",
			items: [
				{
					id: "automatic",
					label: "Automatic mode",
					currentValue: "Off",
					values: ["Off", "On"],
					action: "setting",
				},
				{
					id: "manual-raw",
					label: "Manual\u0007 mode",
					currentValue: "Off",
					values: ["Off", rawValue],
					action: "setting",
				},
			],
		},
		{
			plainTheme: true,
			onSettingChange: async (request) => {
				requests.push(request);
				return true;
			},
		},
	);

	for (const input of ["m", "a", "n"]) harness.component.handleInput(input);
	const filtered = plainRender(harness.component, 60).join("\n");
	assert.match(filtered, /Manual mode/);
	assert.doesNotMatch(filtered, /Automatic mode/);
	harness.component.handleInput("l");
	await harness.component.waitForPending();
	assert.deepEqual(requests, [{ itemId: "manual-raw", value: rawValue, previousValue: "Off" }]);
	assert.equal(harness.selectionChanges.at(-1), "manual-raw");
});

test("settings search keeps disabled rows inert and distinguishes Back from Close", async () => {
	let changes = 0;
	const disabled = settingsScreen.items[1];
	assert.ok(disabled);
	const automatic = settingsScreen.items[0];
	assert.ok(automatic);
	const back = componentHarness(
		{ ...settingsScreen, items: [automatic, { ...disabled, disabled: true }] },
		{
			onSettingChange: async () => {
				changes += 1;
				return true;
			},
		},
	);
	for (const input of ["m", "a", "n"]) back.component.handleInput(input);
	back.component.handleInput("l");
	await back.component.waitForPending();
	assert.equal(changes, 0);
	back.component.handleInput("q");
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.deepEqual(back.events, [{ kind: "back" }]);

	const close = componentHarness(settingsScreen);
	close.component.handleInput("\u0003");
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.deepEqual(close.events, [{ kind: "close" }]);
});

test("settings forward component focus to the search input for IME", () => {
	const harness = componentHarness(settingsScreen, { plainTheme: true });
	const focusable = harness.component as MenuScreenComponent & Focusable;
	assert.equal("focused" in focusable, true);
	assert.equal(focusable.focused, false);
	focusable.focused = true;
	assert.equal(harness.component.render(80).join("\n").includes(CURSOR_MARKER), true);
});

test("settings sanitize terminal controls from bracketed search paste", () => {
	const harness = componentHarness(settingsScreen, { plainTheme: true });
	const pasted =
		"\u001b[200~man\u001b]8;;https://unsafe.example\u0007ual\u009dtitle\u009c\u001b[201~";
	harness.component.handleInput(pasted);
	const rendered = harness.component.render(80).join("\n");
	assert.equal(rendered.includes("\u001b]8;;https://unsafe.example"), false);
	assert.equal(rendered.includes("\u0007"), false);
	assert.equal(rendered.includes("\u009d"), false);
	assert.equal(rendered.includes("\u009c"), false);
});

test("settings preserve pasted query spaces without stealing Space activation", async () => {
	let changedItemId: string | undefined;
	const harness = componentHarness(settingsScreen, {
		plainTheme: true,
		keybindings: inputFriendlyKeybindings,
		onSettingChange: async ({ itemId }) => {
			changedItemId = itemId;
			return true;
		},
	});
	harness.component.handleInput("\u001b[200~mode manual\u001b[201~");
	const rendered = plainRender(harness.component, 80).join("\n");
	assert.match(rendered, /Manual mode/);
	assert.doesNotMatch(rendered, /Automatic start/);
	harness.component.handleInput(" ");
	await harness.component.waitForPending();
	assert.equal(changedItemId, "manual");
});

test("menu hints sanitize configured keybinding labels", () => {
	const unsafeKey = "\u001b]8;;https://unsafe.example\u0007enter";
	const keybindings = {
		matches: () => false,
		getKeys: (binding: string) => (binding === "tui.select.confirm" ? [unsafeKey] : []),
	};
	for (const screen of [actionScreen, settingsScreen]) {
		const harness = componentHarness(screen, { keybindings, plainTheme: true });
		const rendered = harness.component.render(80).join("\n");
		assert.equal(rendered.includes("\u001b]8;;https://unsafe.example"), false);
	}
});

test("disabled settings keep their unavailable marker when long values truncate", () => {
	const setting = settingsScreen.items[0];
	assert.ok(setting);
	const harness = componentHarness(
		{
			...settingsScreen,
			items: [{ ...setting, currentValue: "x".repeat(100), disabled: true }],
		},
		{ plainTheme: true },
	);
	assert.ok(plainRender(harness.component, 50).some((line) => line.includes("unavailable")));
});

test("disabled settings cannot invoke their action", async () => {
	let changes = 0;
	const firstSetting = settingsScreen.items[0];
	assert.ok(firstSetting);
	const harness = componentHarness(
		{
			...settingsScreen,
			items: [{ ...firstSetting, disabled: true }],
		},
		{
			onSettingChange: async () => {
				changes += 1;
				return true;
			},
		},
	);
	harness.component.handleInput("l");
	await harness.component.waitForPending();
	assert.equal(changes, 0);
});

test("settings sanitize display values without changing action payloads", async () => {
	const currentValue = "Off\u001b]8;;unsafe\u0007\nvalue";
	const nextValue = "On\u001b[31m\nraw";
	let receivedValue = "";
	const harness = componentHarness(
		{
			kind: "settings",
			title: "Settings",
			items: [
				{
					id: "unsafe",
					label: "Unsafe",
					currentValue,
					values: [currentValue, nextValue],
					action: "setting",
				},
			],
		},
		{
			onSettingChange: async ({ value }) => {
				receivedValue = value;
				return true;
			},
		},
	);
	assert.equal(harness.component.render(80).join("\n").includes("\u001b]8"), false);
	harness.component.handleInput("l");
	await harness.component.waitForPending();
	assert.equal(receivedValue, nextValue);
	assert.equal(harness.component.render(80).join("\n").includes("\u001b[31m"), false);
});

test("settings changes serialize, roll back rejection, and drain before Back", async () => {
	let releaseFirst: (() => void) | undefined;
	const requests: string[] = [];
	const firstGate = new Promise<void>((resolve) => {
		releaseFirst = resolve;
	});
	const harness = componentHarness(settingsScreen, {
		onSettingChange: async ({ value }) => {
			requests.push(value);
			if (requests.length === 1) await firstGate;
			return value !== "Off";
		},
	});

	harness.component.handleInput("l");
	harness.component.handleInput("l");
	await Promise.resolve();
	assert.deepEqual(requests, ["On"]);
	harness.component.handleInput("q");
	assert.deepEqual(harness.events, []);
	releaseFirst?.();
	await harness.component.waitForPending();
	assert.deepEqual(requests, ["On", "Off"]);
	assert.deepEqual(harness.events, [{ kind: "back" }]);
	assert.match(harness.component.render(80).join("\n"), /On/);
});

test("accepted setting transitions fire only after pending state is settled", async () => {
	const harness = componentHarness(settingsScreen, {
		onSettingChange: async () => ({ accepted: true, transition: { kind: "close" } }),
	});
	harness.component.handleInput("l");
	assert.deepEqual(harness.transitions, []);
	await harness.component.waitForPending();
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.deepEqual(harness.transitions, [{ kind: "close" }]);
});

test("multi-select retains its cursor and restores a rejected optimistic toggle", async () => {
	const requests: Array<{ itemId: string; selected: boolean }> = [];
	const harness = componentHarness(multiSelectScreen, {
		selectedItemId: "two",
		onMultiSelectChange: async (request) => {
			requests.push(request);
			return false;
		},
	});
	harness.component.handleInput("l");
	await harness.component.waitForPending();
	assert.deepEqual(requests, [{ itemId: "two", selected: true, previousSelected: false }]);
	const rendered = harness.component.render(80).join("\n");
	assert.match(rendered, /› \[ \] tool_two/);
});

test("multi-select rejection restores the last committed value after rapid toggles", async () => {
	let releaseFirst: (() => void) | undefined;
	let calls = 0;
	const firstGate = new Promise<void>((resolve) => {
		releaseFirst = resolve;
	});
	const harness = componentHarness(
		{
			...multiSelectScreen,
			items: [{ id: "one", label: "tool_one", selected: false }],
			actions: [],
		},
		{
			onMultiSelectChange: async () => {
				calls += 1;
				if (calls === 1) await firstGate;
				return false;
			},
		},
	);
	harness.component.handleInput("l");
	harness.component.handleInput("l");
	releaseFirst?.();
	await harness.component.waitForPending();
	assert.equal(calls, 2);
	assert.match(harness.component.render(80).join("\n"), /› \[ \] tool_one/);
});

test("multi-select supports explicit bulk action rows", async () => {
	const harness = componentHarness(multiSelectScreen, { selectedItemId: "two" });
	harness.component.handleInput("j");
	assert.match(harness.component.render(80).join("\n"), /› Enable all/);
	harness.component.handleInput("l");
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.deepEqual(harness.events, [{ kind: "activate", itemId: "all" }]);
});

test("disabled multi-select action rows show their reason and remain inert", async () => {
	const harness = componentHarness(
		{
			...multiSelectScreen,
			items: [],
			actions: [
				{
					id: "all",
					label: "Enable all available tools",
					description: "Bulk action",
					disabled: true,
					disabledReason: "Policy\u0007 blocks this action",
					action: "run",
				},
			],
		},
		{ plainTheme: true },
	);
	for (const width of [1, 20, 80]) {
		assert.ok(plainRender(harness.component, width).every((line) => visibleWidth(line) <= width));
	}
	const narrowAction = plainRender(harness.component, 20).find((line) => line.includes("[-]"));
	assert.ok(narrowAction?.endsWith("…"));
	const rendered = plainRender(harness.component, 80).join("\n");
	assert.match(rendered, /› \[-\] Enable all available tools/);
	assert.match(rendered, /Unavailable: Policy blocks this action/);
	assert.match(rendered, /Bulk action/);
	assert.equal(rendered.includes("\u0007"), false);
	harness.component.handleInput("l");
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.deepEqual(harness.events, []);
});

test("bounded multi-select keeps first, middle, last, and paged selections visible", () => {
	const screen = largeMultiSelectScreen();
	const middle = componentHarness(screen, { selectedItemId: "tool-10" });
	const middleText = middle.component.render(80).join("\n");
	assert.match(middleText, /tool_8/);
	assert.match(middleText, /› \[ \] tool_10/);
	assert.match(middleText, /tool_12/);
	assert.doesNotMatch(middleText, /tool_7|tool_13/);
	assert.match(middleText, /11\/21/);
	assert.match(middleText, /Description for tool 10/);

	const first = componentHarness(screen, { selectedItemId: "tool-0" });
	assert.match(first.component.render(80).join("\n"), /tool_0[\s\S]*tool_4/);
	assert.doesNotMatch(first.component.render(80).join("\n"), /tool_5/);

	const last = componentHarness(screen, { selectedItemId: "all" });
	const lastText = last.component.render(80).join("\n");
	assert.match(lastText, /tool_16[\s\S]*› Enable all/);
	assert.doesNotMatch(lastText, /tool_15/);

	const pageDown = testKeybindings.getKeys("tui.select.pageDown")[0];
	const pageUp = testKeybindings.getKeys("tui.select.pageUp")[0];
	assert.ok(pageDown);
	assert.ok(pageUp);
	first.component.handleInput(pageDown);
	assert.match(first.component.render(80).join("\n"), /› \[ \] tool_5/);
	first.component.handleInput(pageDown);
	first.component.handleInput(pageDown);
	first.component.handleInput(pageDown);
	assert.match(first.component.render(80).join("\n"), /› Enable all/);
	first.component.handleInput(pageUp);
	assert.match(first.component.render(80).join("\n"), /› \[ \] tool_15/);
});

test("bounded multi-select remains width-safe and small lists stay visually unchanged", () => {
	const small = componentHarness({ ...multiSelectScreen, viewportSize: 5 });
	const original = componentHarness(multiSelectScreen);
	assert.deepEqual(small.component.render(80), original.component.render(80));

	const narrow = componentHarness(largeMultiSelectScreen(), { selectedItemId: "tool-10" });
	for (const line of narrow.component.render(18)) assert.ok(visibleWidth(line) <= 18);
});

test("off-screen multi-select rollback settles by stable id before Back", async () => {
	let release: (() => void) | undefined;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	const harness = componentHarness(largeMultiSelectScreen(), {
		selectedItemId: "tool-0",
		onMultiSelectChange: async () => {
			await gate;
			return false;
		},
	});
	harness.component.handleInput("l");
	harness.component.handleInput("d");
	assert.match(harness.component.render(80).join("\n"), /› \[ \] tool_5/);
	release?.();
	await harness.component.waitForPending();
	harness.component.handleInput("u");
	assert.match(harness.component.render(80).join("\n"), /› \[ \] tool_0/);
	harness.component.handleInput("l");
	harness.component.handleInput("q");
	assert.deepEqual(harness.events, []);
	await harness.component.waitForPending();
	assert.deepEqual(harness.events, [{ kind: "back" }]);
});

test("disabled multi-select rows are focusable, explained, sanitized, and never toggle", async () => {
	let toggles = 0;
	const harness = componentHarness(
		{
			kind: "multiSelect",
			title: "Tools",
			items: [
				{ id: "enabled", label: "enabled", selected: false },
				{
					id: "blocked\u001b]8;;raw\u0007",
					label: "blocked\u001b[31m",
					selected: false,
					disabled: true,
					disabledReason: "Policy\u001b]8;;unsafe\u0007 blocks this tool",
				},
			],
			action: "toggle",
		},
		{
			selectedItemId: "blocked\u001b]8;;raw\u0007",
			onMultiSelectChange: async () => {
				toggles += 1;
				return true;
			},
		},
	);
	const rendered = harness.component.render(80).join("\n");
	assert.match(rendered, /› \[-\] blocked .*unavailable/);
	assert.match(rendered, /Policy .*blocks this tool/);
	assert.equal(rendered.includes("\u001b]8;;unsafe"), false);
	harness.component.handleInput("l");
	harness.component.handleInput(" ");
	await harness.component.waitForPending();
	assert.equal(toggles, 0);
});

test("searchable multi-select filters label and declared search text by stable raw id", async () => {
	const requests: Array<{ itemId: string; selected: boolean; previousSelected: boolean }> = [];
	const screen: MenuScreen<ScreenId, ActionId> = {
		kind: "multiSelect",
		title: "Searchable tools",
		enableSearch: true,
		items: [
			{
				id: "read\u0007raw",
				label: "讀取 📖",
				searchText: "filesystem inspect\u001b]8;;unsafe\u0007 built-in",
				selected: false,
			},
			{ id: "write", label: "Write", searchText: "mutation", selected: true },
		],
		action: "toggle",
		actions: [{ id: "save", label: "Save changes", action: "run" }],
	};
	const harness = componentHarness(screen, {
		plainTheme: true,
		selectedItemId: "write",
		keybindings: inputFriendlyKeybindings,
		onMultiSelectChange: async (request) => {
			requests.push(request);
			return true;
		},
	});

	for (const input of ["f", "s"]) harness.component.handleInput(input);
	const filtered = plainRender(harness.component, 60).join("\n");
	assert.match(filtered, /讀取 📖/);
	assert.doesNotMatch(filtered, /Write/);
	assert.match(filtered, /Save changes/);
	harness.component.handleInput("\r");
	await harness.component.waitForPending();
	assert.deepEqual(requests, [
		{ itemId: "read\u0007raw", selected: true, previousSelected: false },
	]);

	for (const input of ["\u007f", "\u007f"]) harness.component.handleInput(input);
	assert.match(plainRender(harness.component, 60).join("\n"), /› \[x\] 讀取 📖/);
});

test("searchable multi-select keeps actions available for no matches and distinguishes empty", async () => {
	const screen: MenuScreen<ScreenId, ActionId> = {
		kind: "multiSelect",
		title: "Searchable tools",
		enableSearch: true,
		items: [{ id: "read", label: "Read", selected: false }],
		action: "toggle",
		actions: [{ id: "save", label: "Save changes", action: "run" }],
	};
	const noMatch = componentHarness(screen, {
		plainTheme: true,
		keybindings: inputFriendlyKeybindings,
	});
	for (const input of ["z", "z", "z"]) noMatch.component.handleInput(input);
	const rendered = plainRender(noMatch.component, 60).join("\n");
	assert.match(rendered, /No matching items/);
	assert.match(rendered, /› Save changes/);
	noMatch.component.handleInput("\r");
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.deepEqual(noMatch.events, [{ kind: "activate", itemId: "save" }]);

	const empty = componentHarness(
		{ ...screen, items: [] },
		{ plainTheme: true, keybindings: inputFriendlyKeybindings },
	);
	assert.match(plainRender(empty.component, 60).join("\n"), /No items available/);
	assert.doesNotMatch(plainRender(empty.component, 60).join("\n"), /No matching items/);
});

test("searchable multi-select forwards focus and sanitizes bracketed paste", () => {
	const harness = componentHarness(
		{
			kind: "multiSelect",
			title: "Searchable tools",
			enableSearch: true,
			items: [
				{ id: "read", label: "讀取 📖", searchText: "filesystem", selected: false },
				{ id: "write", label: "Write", selected: false },
			],
			action: "toggle",
		},
		{ plainTheme: true, keybindings: inputFriendlyKeybindings },
	);
	const focusable = harness.component as MenuScreenComponent & Focusable;
	assert.equal("focused" in focusable, true);
	focusable.focused = true;
	assert.equal(harness.component.render(80).join("\n").includes(CURSOR_MARKER), true);
	focusable.focused = false;

	harness.component.handleInput("\u001b[200~📖\u0007\u009d\u009c\u001b[201~");
	const rendered = harness.component.render(80).join("\n");
	assert.match(stripVTControlCharacters(rendered), /讀取 📖/);
	assert.doesNotMatch(stripVTControlCharacters(rendered), /Write/);
	assert.equal(rendered.includes("\u001b[200~"), false);
	assert.equal(rendered.includes("\u0007"), false);
	assert.equal(rendered.includes("\u009d"), false);
	assert.equal(rendered.includes("\u009c"), false);
	for (const width of [1, 2, 8, 20, 40, 80]) {
		assert.ok(harness.component.render(width).every((line) => visibleWidth(line) <= width));
	}
});

test("searchable multi-select preserves pasted query spaces without stealing Space", async () => {
	let toggledItemId: string | undefined;
	const harness = componentHarness(
		{
			kind: "multiSelect",
			title: "Searchable tools",
			enableSearch: true,
			items: [{ id: "target", label: "bar foo", selected: false }],
			action: "toggle",
		},
		{
			plainTheme: true,
			keybindings: inputFriendlyKeybindings,
			onMultiSelectChange: async ({ itemId }) => {
				toggledItemId = itemId;
				return true;
			},
		},
	);
	harness.component.handleInput("\u001b[200~foo bar\u001b[201~");
	assert.match(plainRender(harness.component, 80).join("\n"), /bar foo/);
	harness.component.handleInput(" ");
	await harness.component.waitForPending();
	assert.equal(toggledItemId, "target");
});

test("searchable multi-select rollback remains keyed by hidden item id", async () => {
	let release: (() => void) | undefined;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	const harness = componentHarness(
		{
			kind: "multiSelect",
			title: "Searchable tools",
			enableSearch: true,
			items: [
				{ id: "read", label: "Read", searchText: "filesystem", selected: false },
				{ id: "write", label: "Write", searchText: "mutation", selected: false },
			],
			action: "toggle",
		},
		{
			plainTheme: true,
			keybindings: inputFriendlyKeybindings,
			onMultiSelectChange: async () => {
				await gate;
				return false;
			},
		},
	);
	for (const input of ["f", "s", "\r", "z"]) harness.component.handleInput(input);
	assert.match(plainRender(harness.component, 60).join("\n"), /No matching items/);
	release?.();
	await harness.component.waitForPending();
	for (const input of ["\u007f", "\u007f", "\u007f"]) harness.component.handleInput(input);
	assert.match(plainRender(harness.component, 60).join("\n"), /› \[ \] Read/);
});

test("multi-select search is opt-in and default rendering remains unchanged", () => {
	const harness = componentHarness(multiSelectScreen, {
		plainTheme: true,
		keybindings: inputFriendlyKeybindings,
	});
	const before = harness.component.render(80);
	assert.equal("focused" in harness.component, false);
	harness.component.handleInput("f");
	assert.deepEqual(harness.component.render(80), before);
	assert.doesNotMatch(before.join("\n"), /Type to search/);
});

function largeMultiSelectScreen(): MenuScreen<ScreenId, ActionId> {
	return {
		kind: "multiSelect",
		title: "Large tools",
		viewportSize: 5,
		items: Array.from({ length: 20 }, (_, index) => ({
			id: `tool-${index}`,
			label: `tool_${index}`,
			description: `Description for tool ${index}`,
			selected: false,
		})),
		action: "toggle",
		actions: [{ id: "all", label: "Enable all", action: "run" }],
	};
}

function largeSettingsScreen(): MenuScreen<ScreenId, ActionId> {
	return {
		kind: "settings",
		title: "Large settings",
		lines: ["Changes save immediately."],
		items: Array.from({ length: 12 }, (_, index) => ({
			id: `setting-${index}`,
			label: index === 1 ? "Longer setting 1" : `Setting ${index}`,
			description: `Description for setting ${index}`,
			currentValue: index % 2 === 0 ? "Off" : "On",
			values: ["Off", "On"],
			action: "setting" as const,
		})),
	};
}

function plainRender(component: MenuScreenComponent, width: number) {
	return component.render(width).map((line) => stripVTControlCharacters(line));
}

function componentHarness(
	screen: MenuScreen<ScreenId, ActionId>,
	options: {
		selectedItemId?: string;
		themePrefix?: () => string;
		plainTheme?: boolean;
		rows?: number;
		keybindings?: {
			matches(data: string, binding: string): boolean;
			getKeys(binding: string): readonly string[];
		};
		onSettingChange?: (request: {
			itemId: string;
			value: string;
			previousValue: string;
		}) => Promise<boolean | { accepted: boolean; transition: MenuTransition<ScreenId> }>;
		onMultiSelectChange?: (request: {
			itemId: string;
			selected: boolean;
			previousSelected: boolean;
		}) => Promise<boolean | { accepted: boolean; transition: MenuTransition<ScreenId> }>;
	} = {},
) {
	const events: MenuScreenEvent[] = [];
	const transitions: MenuTransition<ScreenId>[] = [];
	const selectionChanges: string[] = [];
	const themePrefix = options.themePrefix ?? (() => "accent");
	const component = createMenuScreenComponent({
		screen,
		selectedItemId: options.selectedItemId,
		tui: { terminal: { rows: options.rows ?? 24 }, requestRender() {} },
		theme: {
			fg(color: string, text: string) {
				if (options.plainTheme) return text;
				return color === "accent" ? `${themePrefix()}:${text}` : text;
			},
			bold(text: string) {
				return text;
			},
		},
		keybindings: options.keybindings ?? testKeybindings,
		onEvent: (event) => events.push(event),
		onSelectionChange: (itemId) => selectionChanges.push(itemId),
		onSettingChange: options.onSettingChange,
		onMultiSelectChange: options.onMultiSelectChange,
		onTransition: (transition) => transitions.push(transition),
	});
	return { component, events, transitions, selectionChanges };
}
