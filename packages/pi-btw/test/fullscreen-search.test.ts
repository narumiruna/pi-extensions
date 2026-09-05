import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { type Component, getKeybindings, type TUI } from "@earendil-works/pi-tui";
import { test } from "vitest";
import { runBtwFullscreen } from "../src/fullscreen-ui.js";
import { BtwAnsweringView, BtwTranscriptPager } from "../src/transcript-pager.js";

const OPEN_SEARCH = "\u001b[102;6u";
const PREVIOUS_MATCH = "\u001b[13;2u";

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

function createSearchHarness(rows = 14) {
	const writes: string[] = [];
	const styleCalls: string[] = [];
	let handleInput: ((data: string) => void) | undefined;
	const terminal = {
		columns: 80,
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
	const theme = {
		fg: (color: string, text: string) => {
			if (color !== "searchMatchText") return text;
			styleCalls.push(`fg:${text}`);
			return `\u001b[31m${text}\u001b[39m`;
		},
		bg: (color: string, text: string) => {
			if (color === "searchMatchBg") {
				styleCalls.push(`bg:${stripVTControlCharacters(text)}`);
				return `\u001b[42m${text}\u001b[49m`;
			}
			assert.equal(color, "selectedBg");
			styleCalls.push("bg:selectedBg");
			return `\u001b[44m${text}\u001b[49m`;
		},
		underline: (text: string) => {
			styleCalls.push(`underline:${stripVTControlCharacters(text)}`);
			return `\u001b[4m${text}\u001b[24m`;
		},
		inverse: (text: string) => {
			styleCalls.push(`inverse:${stripVTControlCharacters(text)}`);
			return `\u001b[7m${text}\u001b[27m`;
		},
		bold: (text: string) => {
			styleCalls.push(`bold:${stripVTControlCharacters(text)}`);
			return `\u001b[1m${text}\u001b[22m`;
		},
	};
	const ctx = {
		ui: {
			custom: async (factory: (...args: never[]) => Component) => {
				const result = new Promise<unknown>((resolve) => {
					outerDone = resolve;
				});
				factory(
					parent as never,
					theme as never,
					getKeybindings() as never,
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
		styleCalls,
		get input() {
			assert.ok(handleInput);
			return handleInput;
		},
	};
}

async function flushAsyncWork(): Promise<void> {
	await new Promise<void>((resolve) => setImmediate(resolve));
}

function readSearchStatus(writes: readonly string[]): { index: number; count: number } {
	const frame = stripVTControlCharacters(writes.join(""));
	const match = /(\d+)\/(\d+)/u.exec(frame);
	assert.ok(match, `search status was not rendered in ${JSON.stringify(frame)}`);
	return { index: Number(match[1]), count: Number(match[2]) };
}

const cases = ["completed", "answering"] as const;

test.each(cases)(
	"%s side-thread fullscreen searches with callback-theme styles and preserves the composer",
	async (kind) => {
		initTheme("dark");
		const harness = createSearchHarness();
		const answer = Array.from(
			{ length: 48 },
			(_, index) => `needle ${kind} transcript row ${index + 1}`,
		).join("\n");
		let sideTui: TUI | undefined;
		const running = runBtwFullscreen(harness.ctx, (fullscreenCtx) =>
			fullscreenCtx.ui.custom<"closed">((tui, theme, _keys, done) => {
				sideTui = tui;
				const turns = [
					{
						question: `${kind} question`,
						answer,
						kind: "answered" as const,
						response: response(answer),
					},
				];
				if (kind === "completed") {
					return new BtwTranscriptPager(
						tui,
						theme,
						turns,
						(action) => {
							if (action.kind === "close") done("closed");
						},
						{ startAtBottom: true },
					);
				}
				return new BtwAnsweringView(
					tui,
					theme,
					turns,
					"current question",
					() => done("closed"),
					undefined,
					{ steering: { questions: [], onSubmit() {} } },
				);
			}),
		);
		await flushAsyncWork();
		assert.ok(sideTui);
		sideTui.renderNow(true);

		harness.writes.length = 0;
		harness.input(OPEN_SEARCH);
		harness.input("needle");
		sideTui.renderNow(true);
		const initial = readSearchStatus(harness.writes);
		assert.ok(initial.count > 2);
		assert.ok(harness.styleCalls.some((call) => call.startsWith("underline:needle")));
		assert.ok(harness.styleCalls.some((call) => call.startsWith("inverse:needle")));
		assert.ok(harness.styleCalls.some((call) => call.startsWith("bold:needle")));
		const searchFrame = stripVTControlCharacters(harness.writes.join(""));
		assert.match(searchFrame, /needle/);
		assert.match(searchFrame, /btw · side thread/);
		assert.match(searchFrame, kind === "completed" ? /Ctrl\+C/ : /Answering…/);

		harness.writes.length = 0;
		harness.input("\r");
		sideTui.renderNow(true);
		const next = readSearchStatus(harness.writes);
		assert.equal(next.count, initial.count);
		assert.equal(next.index, (initial.index % initial.count) + 1);

		harness.writes.length = 0;
		harness.input(PREVIOUS_MATCH);
		sideTui.renderNow(true);
		assert.deepEqual(readSearchStatus(harness.writes), initial);

		harness.input("\u001b");
		harness.input("composer still works");
		harness.writes.length = 0;
		sideTui.renderNow(true);
		const composerFrame = stripVTControlCharacters(harness.writes.join(""));
		assert.match(composerFrame, /composer still works/);
		assert.doesNotMatch(composerFrame, /Find transcript/);

		harness.input("\u0003");
		assert.equal(await running, "closed");
	},
);
