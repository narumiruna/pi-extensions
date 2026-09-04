import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { initTheme } from "@earendil-works/pi-coding-agent";
import {
	type Component,
	getKeybindings,
	KeybindingsManager,
	setKeybindings,
	type TUI,
	TUI_KEYBINDINGS,
	type TuiAltScreen,
	visibleWidth,
} from "@earendil-works/pi-tui";
import { test } from "vitest";
import { runBtwFullscreen } from "../src/fullscreen-ui.js";
import { BtwAnsweringView, BtwTranscriptPager } from "../src/transcript-pager.js";

function response(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		stopReason: "stop",
		timestamp: Date.now(),
		api: "anthropic-messages",
		provider: "test",
		model: "side",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	} as AssistantMessage;
}

function createFullscreenHarness(
	rows = 12,
	options: { columns?: number; keybindings?: KeybindingsManager } = {},
) {
	const writes: string[] = [];
	const themeCalls: string[] = [];
	const columns = options.columns ?? 80;
	let handleInput: ((data: string) => void) | undefined;
	const terminal = {
		columns,
		rows,
		start(onInput: (data: string) => void) {
			handleInput = onInput;
		},
		stop() {},
		write(data: string) {
			writes.push(data);
		},
		hideCursor() {},
		showCursor() {},
	} as never;
	const parent = {
		mode: "regular",
		terminal,
		getShowHardwareCursor: () => false,
		stop() {},
		start() {},
		renderNow() {},
		requestRender() {},
	} as unknown as TUI;
	let outerDone: ((value: unknown) => void) | undefined;
	let editorText = "main draft";
	const ctx = {
		ui: {
			custom: async (factory: (...args: never[]) => Component) => {
				const result = new Promise<unknown>((resolve) => {
					outerDone = resolve;
				});
				factory(
					parent as never,
					{
						fg: (color: string, text: string) => {
							themeCalls.push(`fg:${color}`);
							return text;
						},
						bg: (color: string, text: string) => {
							themeCalls.push(`bg:${color}`);
							return text;
						},
					} as never,
					(options.keybindings ?? getKeybindings()) as never,
					((value: unknown) => outerDone?.(value)) as never,
				);
				return result;
			},
			getEditorText: () => editorText,
			setEditorText: (value: string) => {
				editorText = value;
			},
		},
	} as never;
	return {
		ctx,
		writes,
		themeCalls,
		columns,
		get input() {
			assert.ok(handleInput);
			return handleInput;
		},
	};
}

async function flushAsyncWork(): Promise<void> {
	await new Promise<void>((resolve) => setImmediate(resolve));
}

const JUMP_TO_LATEST = "↓ Jump to latest message";
const ESCAPE = String.fromCharCode(27);

function getRowMarkers(text: string): RegExpStringIterator<RegExpExecArray> {
	return text.matchAll(new RegExp(`${ESCAPE}\\[(\\d+);1H${ESCAPE}\\[2K`, "gu"));
}

function latestFrame(writes: readonly string[]): string {
	return stripVTControlCharacters(writes.at(-1) ?? "");
}

function findJumpIndicator(writes: readonly string[]): { column: number; row: number } {
	const frame = writes.at(-1) ?? "";
	const indicatorIndex = frame.indexOf(JUMP_TO_LATEST);
	assert.notEqual(indicatorIndex, -1, "jump-to-latest indicator was not rendered");
	const prefix = frame.slice(0, indicatorIndex);
	const rowMarkers = [...getRowMarkers(prefix)];
	const marker = rowMarkers.at(-1);
	assert.ok(marker?.index !== undefined, "indicator row marker was not rendered");
	const row = Number(marker[1]);
	const rowPrefix = prefix.slice(marker.index + marker[0].length);
	return { column: visibleWidth(rowPrefix) + 1, row };
}

function renderedRows(write: string): string[] {
	const markers = [...getRowMarkers(write)];
	return markers.map((marker, index) => {
		assert.ok(marker.index !== undefined);
		const start = marker.index + marker[0].length;
		const end = markers[index + 1]?.index ?? write.length;
		return write.slice(start, end);
	});
}

test("mouse wheel and history keys scroll the native side-thread viewport", async () => {
	initTheme("dark");
	const harness = createFullscreenHarness();
	const answer = Array.from({ length: 40 }, (_, index) => `line ${index + 1}`).join("\n");
	let sideTui: TUI | undefined;
	const running = runBtwFullscreen(harness.ctx, (fullscreenCtx) =>
		fullscreenCtx.ui.custom<"closed">((tui, theme, _keys, done) => {
			sideTui = tui;
			return new BtwTranscriptPager(
				tui,
				theme,
				[{ question: "question", answer, kind: "answered", response: response(answer) }],
				(action) => {
					if (action.kind === "close") done("closed");
				},
				{ startAtBottom: true },
			);
		}),
	);
	await flushAsyncWork();
	assert.ok(sideTui);

	sideTui.renderNow(true);
	assert.doesNotMatch(latestFrame(harness.writes), /Jump to latest message/u);
	const viewport = sideTui as TuiAltScreen;
	const initialTop = viewport.viewportTop;
	assert.ok(initialTop > 0, "long transcript should use the native primary scroll viewport");

	harness.writes.length = 0;
	harness.input("\u001b[<64;1;1M");
	sideTui.renderNow(true);
	const wheelOlderTop = viewport.viewportTop;
	assert.ok(
		wheelOlderTop < initialTop,
		"wheel-up over the fixed header should reveal older history",
	);
	const wheelFrame = stripVTControlCharacters(harness.writes.join(""));
	assert.match(wheelFrame, /btw · side thread/);
	assert.match(wheelFrame, /Ctrl\+C/);
	assert.match(wheelFrame, /PgUp\/PgDn/);
	assert.match(wheelFrame, /↓ Jump to latest message · End/u);
	assert.ok(harness.themeCalls.includes("fg:text"));
	assert.ok(harness.themeCalls.includes("fg:muted"));
	assert.ok(harness.themeCalls.includes("bg:selectedBg"));

	harness.input("\u001b[<65;1;1M");
	sideTui.renderNow(true);
	assert.ok(viewport.viewportTop > wheelOlderTop, "wheel-down should reveal newer history");

	const beforePageUp = viewport.viewportTop;
	harness.input("\u001b[5~");
	sideTui.renderNow(true);
	const pageOlderTop = viewport.viewportTop;
	assert.ok(pageOlderTop < beforePageUp, "PageUp should use the same primary transcript viewport");
	harness.input("\u001b[6~");
	sideTui.renderNow(true);
	assert.ok(viewport.viewportTop > pageOlderTop, "PageDown should return toward newer history");

	harness.writes.length = 0;
	harness.input("\u001b[F");
	sideTui.renderNow(true);
	assert.equal(viewport.isFollowingOutput, true);
	assert.doesNotMatch(latestFrame(harness.writes), /Jump to latest message/u);

	harness.input("\u0003");
	assert.equal(await running, "closed");
});

test("mouse wheel scrolls transcript history while an answer and composer stay visible", async () => {
	initTheme("dark");
	const harness = createFullscreenHarness(14);
	const answer = Array.from({ length: 40 }, (_, index) => `earlier ${index + 1}`).join("\n");
	let sideTui: TUI | undefined;
	const running = runBtwFullscreen(harness.ctx, (fullscreenCtx) =>
		fullscreenCtx.ui.custom<"cancelled">((tui, theme, _keys, done) => {
			sideTui = tui;
			return new BtwAnsweringView(
				tui,
				theme,
				[
					{
						question: "earlier question",
						answer,
						kind: "answered",
						response: response(answer),
					},
				],
				"current question",
				() => done("cancelled"),
				undefined,
				{ steering: { questions: [], onSubmit() {} } },
			);
		}),
	);
	await flushAsyncWork();
	assert.ok(sideTui);

	sideTui.renderNow(true);
	const viewport = sideTui as TuiAltScreen;
	const initialTop = viewport.viewportTop;
	assert.ok(initialTop > 0);
	harness.writes.length = 0;
	harness.input("\u001b[<64;1;1M");
	sideTui.renderNow(true);
	assert.ok(viewport.viewportTop < initialTop);
	const wheelFrame = stripVTControlCharacters(harness.writes.join(""));
	assert.match(wheelFrame, /btw · side thread/);
	assert.match(wheelFrame, /Answering…/);
	assert.match(wheelFrame, /Ctrl\+C/);
	assert.match(wheelFrame, /↓ Jump to latest message · End/u);

	const indicator = findJumpIndicator(harness.writes);
	harness.writes.length = 0;
	harness.input(`\u001b[<0;${indicator.column};${indicator.row}M`);
	sideTui.renderNow(true);
	assert.equal(viewport.isFollowingOutput, true);
	assert.doesNotMatch(latestFrame(harness.writes), /Jump to latest message/u);

	harness.input("\u0003");
	assert.equal(await running, "cancelled");
});

test("configured bottom key skips Ctrl+C and wins over the focused composer", async (t) => {
	initTheme("dark");
	const previousKeybindings = getKeybindings();
	const keybindings = new KeybindingsManager(TUI_KEYBINDINGS, {
		"tui.altScreen.bottom": ["ctrl+c", "x"],
	});
	setKeybindings(keybindings);
	t.onTestFinished(() => setKeybindings(previousKeybindings));
	const harness = createFullscreenHarness(12, { keybindings });
	const answer = Array.from({ length: 40 }, (_, index) => `history ${index + 1}`).join("\n");
	const actions: string[] = [];
	let sideTui: TUI | undefined;
	const running = runBtwFullscreen(harness.ctx, (fullscreenCtx) =>
		fullscreenCtx.ui.custom<"closed">((tui, theme, _keys, done) => {
			sideTui = tui;
			return new BtwTranscriptPager(
				tui,
				theme,
				[{ question: "question", answer, kind: "answered", response: response(answer) }],
				(action) => {
					actions.push(action.kind);
					if (action.kind === "close") done("closed");
				},
				{ startAtBottom: true, initialQuestion: "draft" },
			);
		}),
	);
	await flushAsyncWork();
	assert.ok(sideTui);

	sideTui.renderNow(true);
	const viewport = sideTui as TuiAltScreen;
	harness.writes.length = 0;
	harness.input("\u001b[<64;1;1M");
	sideTui.renderNow(true);
	assert.match(latestFrame(harness.writes), /↓ Jump to latest message · X/u);

	harness.writes.length = 0;
	harness.input("x");
	sideTui.renderNow(true);
	const returnedFrame = latestFrame(harness.writes);
	assert.equal(viewport.isFollowingOutput, true);
	assert.doesNotMatch(returnedFrame, /Jump to latest message/u);
	assert.match(returnedFrame, /draft/u);
	assert.doesNotMatch(returnedFrame, /draftx/u);
	assert.deepEqual(actions, []);

	harness.input("\u0003");
	assert.equal(await running, "closed");
	assert.deepEqual(actions, ["close"]);
});

test("narrow indicator without a usable key stays bounded and defers to search", async (t) => {
	initTheme("dark");
	const previousKeybindings = getKeybindings();
	const keybindings = new KeybindingsManager(TUI_KEYBINDINGS, {
		"tui.altScreen.bottom": ["ctrl+c"],
	});
	setKeybindings(keybindings);
	t.onTestFinished(() => setKeybindings(previousKeybindings));
	const harness = createFullscreenHarness(7, { columns: 40, keybindings });
	const answer = Array.from({ length: 40 }, (_, index) => `history ${index + 1}`).join("\n");
	let sideTui: TUI | undefined;
	const running = runBtwFullscreen(harness.ctx, (fullscreenCtx) =>
		fullscreenCtx.ui.custom<"closed">((tui, theme, _keys, done) => {
			sideTui = tui;
			return new BtwTranscriptPager(
				tui,
				theme,
				[{ question: "question", answer, kind: "answered", response: response(answer) }],
				(action) => {
					if (action.kind === "close") done("closed");
				},
				{ startAtBottom: true },
			);
		}),
	);
	await flushAsyncWork();
	assert.ok(sideTui);

	sideTui.renderNow(true);
	const viewport = sideTui as TuiAltScreen;
	harness.writes.length = 0;
	harness.input("\u001b[<64;1;1M");
	sideTui.renderNow(true);
	const manualTop = viewport.viewportTop;
	const indicator = findJumpIndicator(harness.writes);
	const indicatorFrame = latestFrame(harness.writes);
	assert.match(indicatorFrame, /↓ Jump to latest message/u);
	assert.doesNotMatch(indicatorFrame, /Jump to latest message ·/u);
	for (const row of renderedRows(harness.writes.at(-1) ?? "")) {
		const width = visibleWidth(stripVTControlCharacters(row));
		assert.ok(width <= harness.columns, `rendered row width ${width}: ${JSON.stringify(row)}`);
	}

	harness.input("\u001b[102;6u");
	sideTui.renderNow(true);
	assert.equal(sideTui.hasOverlay(), true);
	harness.input(`\u001b[<0;${indicator.column};${indicator.row}M`);
	sideTui.renderNow(true);
	assert.equal(viewport.viewportTop, manualTop);
	assert.equal(viewport.isFollowingOutput, false);

	harness.input("\u001b");
	sideTui.renderNow(true);
	const visibleIndicator = findJumpIndicator(harness.writes);
	harness.input(`\u001b[<0;${visibleIndicator.column};${visibleIndicator.row}M`);
	sideTui.renderNow(true);
	assert.equal(viewport.isFollowingOutput, true);

	harness.input("\u0003");
	assert.equal(await running, "closed");
});
