import assert from "node:assert/strict";
import { initTheme } from "@earendil-works/pi-coding-agent";
import {
	getKeybindings,
	KeybindingsManager,
	setKeybindings,
	TUI_KEYBINDINGS,
	visibleWidth,
} from "@earendil-works/pi-tui";
import { createTuiHarness } from "@narumitw/pi-tui-kit/testing";
import { test } from "vitest";
import { resolveBtwShortcuts, setBtwShortcuts } from "../src/keybindings.js";
import {
	BtwAnsweringView,
	BtwTranscriptPager,
	type TranscriptPagerAction,
} from "../src/transcript-pager.js";

const definitions = {
	...TUI_KEYBINDINGS,
	"app.thinking.cycle": { defaultKeys: "shift+tab" },
} as const;
const turns = [
	{
		kind: "answered" as const,
		question: "Q",
		answer: "A",
		response: {
			role: "assistant",
			content: [{ type: "text", text: "A" }],
			stopReason: "stop",
		} as never,
	},
];

test("composer hints reflect custom keys, fallback preserves non-default editing, and paste stays a draft", async () => {
	initTheme("dark");
	const previous = getKeybindings();
	const keys = new KeybindingsManager(definitions, { "tui.editor.deleteCharBackward": "ctrl+q" });
	setKeybindings(keys);
	const harness = createTuiHarness({ width: 160, rows: 24, keybindings: keys as never });
	let cycles = 0;
	const running = harness.custom<TranscriptPagerAction>((tui, theme, keybindings, done) => {
		setBtwShortcuts(
			tui,
			resolveBtwShortcuts({ exit: "ctrl+q", cycleThinkingLevel: "f6", bringToMain: "f7" }, keys),
		);
		return new BtwTranscriptPager(tui, theme, turns, done, {
			thinking: {
				level: "low",
				levels: ["low", "high"],
				keybindings,
				onChange: () => {
					cycles += 1;
				},
			},
		});
	});
	try {
		await harness.waitForOpen();
		const lines = harness.render().join("\n");
		assert.match(lines, /F7 bring to main/);
		assert.match(lines, /F6 cycle/);
		assert.match(lines, /Ctrl\+C exit/);
		assert.doesNotMatch(lines, /Ctrl\+R bring|Ctrl\+Q exit|Shift\+Tab cycle/);
		harness.type("abc");
		harness.send("\u0011");
		harness.send("\u001b[200~");
		harness.send("\u001b[17~");
		harness.send("\u001b[201~");
		assert.equal(cycles, 0);
		harness.send("\u001b[17~");
		assert.equal(cycles, 1);
		for (const width of [1, 12, 32, 80])
			assert.ok(harness.render(width).every((line) => visibleWidth(line) <= width));
		harness.send("\u001b[18~");
		const result = await running;
		assert.equal(result.kind, "bringToMain");
		if (result.kind === "bringToMain") assert.ok(result.questionDraft.startsWith("ab"));
	} finally {
		harness.dispose();
		setKeybindings(previous);
	}
});

test("answering view cycles via custom key, preserves steering submission and aborts on custom exit", async () => {
	initTheme("dark");
	const harness = createTuiHarness({ width: 160, rows: 24 });
	const keys = new KeybindingsManager(definitions);
	const submitted: string[] = [];
	let cycles = 0;
	let view: BtwAnsweringView | undefined;
	const running = harness.custom<string>((tui, theme, keybindings, done) => {
		setBtwShortcuts(tui, resolveBtwShortcuts({ exit: "ctrl+q", cycleThinkingLevel: "f6" }, keys));
		view = new BtwAnsweringView(tui, theme, [], "Q", () => done("cancelled"), "low", {
			steering: {
				questions: [],
				onSubmit: (question) => submitted.push(question),
				thinking: {
					level: "low",
					levels: ["low", "high"],
					keybindings,
					onChange: () => {
						cycles += 1;
					},
				},
			},
		});
		return view;
	});
	try {
		await harness.waitForOpen();
		assert.match(harness.render().join("\n"), /Ctrl\+Q cancel/);
		assert.match(harness.render().join("\n"), /F6 cycle/);
		assert.deepEqual(view?.render(0), []);
		for (const width of [1, 12, 32, 80])
			assert.ok(harness.render(width).every((line) => visibleWidth(line) <= width));
		harness.send("\u001b[17~");
		assert.equal(cycles, 1);
		harness.type("steering");
		harness.press("tui.input.submit");
		assert.deepEqual(submitted, ["steering"]);
		harness.send("\u001b[113;5:3u");
		assert.equal(view?.signal.aborted, false);
		harness.send("\u0011");
		assert.equal(await running, "cancelled");
		assert.equal(view?.signal.aborted, true);
	} finally {
		harness.dispose();
	}
});

test("unavailable shortcuts have no activation hint and bring-to-main stays unavailable without answered turns", async () => {
	initTheme("dark");
	const harness = createTuiHarness({ width: 160, rows: 24 });
	let changes = 0;
	const keys = new KeybindingsManager(definitions, {
		"app.thinking.cycle": "ctrl+c",
		"tui.editor.undo": "ctrl+r",
	});
	const running = harness.custom<TranscriptPagerAction>((tui, theme, keybindings, done) => {
		setBtwShortcuts(tui, resolveBtwShortcuts({}, keys));
		return new BtwTranscriptPager(tui, theme, [], done, {
			thinking: {
				level: "low",
				levels: ["low", "high"],
				keybindings,
				onChange() {
					changes += 1;
				},
			},
		});
	});
	try {
		await harness.waitForOpen();
		assert.doesNotMatch(harness.render().join("\n"), /cycle|bring to main/);
		harness.press("ctrl+c");
		assert.deepEqual(await running, { kind: "close" });
		assert.equal(changes, 0);
	} finally {
		harness.dispose();
	}
});
