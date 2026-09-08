import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	Api,
	AssistantMessage,
	Context,
	Model,
	SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { CURSOR_MARKER, visibleWidth } from "@earendil-works/pi-tui";
import { createTuiHarness } from "@narumitw/pi-tui-kit/testing";
import { test } from "vitest";
import {
	BtwTextRangeSelector,
	buildBtwSelectionLines,
	buildQuickBringToMainSegments,
	formatBtwBringToMain,
	segmentsFromLineRange,
	segmentsFromTextRange,
} from "../src/bring-to-main.js";
import {
	chooseBringToMain,
	loadBringToMainDraft,
	type ResolvedBtwModel,
	runBtwThread,
} from "../src/btw.js";
import {
	buildSideThreadMessages,
	completeSideThreadTurn,
	createSideThread,
	extractAssistantText,
	type SideThread,
} from "../src/side-thread.js";
import {
	BtwAnsweringView,
	BtwTranscriptPager,
	formatSideTranscript,
} from "../src/transcript-pager.js";

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

function keybindings(mapping: Record<string, string> = {}) {
	const defaults: Record<string, string> = {
		"tui.select.up": "\u001b[A",
		"tui.select.down": "\u001b[B",
		"tui.select.pageUp": "\u001b[5~",
		"tui.select.pageDown": "\u001b[6~",
		"tui.select.confirm": "\r",
		"tui.select.cancel": "\u001b",
		"app.thinking.cycle": "\u001b[Z",
	};
	const labels: Record<string, string> = {
		"tui.select.up": "up",
		"tui.select.down": "down",
		"tui.select.pageUp": "pageUp",
		"tui.select.pageDown": "pageDown",
		"tui.select.confirm": "enter",
		"tui.select.cancel": "escape",
		"app.thinking.cycle": "shift+tab",
	};
	return {
		matches(data: string, key: string) {
			return data === (mapping[key] ?? defaults[key]);
		},
		getKeys(key: string) {
			return [mapping[key] ?? labels[key]];
		},
	};
}

function createStandardMenuContext(initialEditor: string, rows = 24) {
	const tui = createTuiHarness({ width: 100, rows });
	let editor = initialEditor;
	const editorWrites: string[] = [];
	const notifications: string[] = [];
	const ctx = {
		mode: "tui",
		hasUI: true,
		ui: {
			custom: async (factory: never, options?: unknown) => {
				assert.equal(options, undefined);
				const entryText = editor;
				const result = await tui.custom(factory);
				editor = entryText;
				return result;
			},
			getEditorText: () => editor,
			setEditorText: (text: string) => {
				editorWrites.push(text);
				editor = text;
			},
			notify(message: string) {
				notifications.push(message);
			},
		},
	} as never;
	return {
		ctx,
		tui,
		editorWrites,
		notifications,
		get editor() {
			return editor;
		},
		changeEditor(text: string) {
			editor = text;
		},
	};
}

function messageText(context: Context): string {
	return context.messages
		.flatMap((message) => {
			if (typeof message.content === "string") return [message.content];
			return message.content
				.filter((part): part is { type: "text"; text: string } => part.type === "text")
				.map((part) => part.text);
		})
		.join("\n");
}

test("side thread sends prior successful turns and injects main context only once", async () => {
	const thread = createSideThread("MAIN-CONTEXT");
	const calls: Array<{ model: Model<Api>; context: Context; options?: SimpleStreamOptions }> = [];
	const replies = [response("A1"), response("A2"), response("A3")];
	const model = { provider: "test", id: "side" } as Model<Api>;
	const completeSimple = async (
		capturedModel: Model<Api>,
		context: Context,
		options?: SimpleStreamOptions,
	) => {
		calls.push({ model: capturedModel, context, options });
		const reply = replies[calls.length - 1];
		assert.ok(reply);
		return reply;
	};

	for (const question of ["Q1", "Q2", "Q3"]) {
		const result = await completeSideThreadTurn({
			thread,
			question,
			model,
			auth: { apiKey: "key", headers: { test: "yes" }, env: { TEST: "yes" } },
			thinkingLevel: "low",
			completeSimple,
		});
		assert.equal(result.kind, "answered");
	}

	assert.equal(calls.length, 3);
	assert.deepEqual(
		calls.map((call) => call.context.messages.map((message) => message.role)),
		[["user"], ["user", "assistant", "user"], ["user", "assistant", "user", "assistant", "user"]],
	);
	const [firstCall, secondCall, thirdCall] = calls;
	assert.ok(firstCall);
	assert.ok(secondCall);
	assert.ok(thirdCall);
	assert.equal((messageText(firstCall.context).match(/MAIN-CONTEXT/g) ?? []).length, 1);
	assert.equal((messageText(secondCall.context).match(/MAIN-CONTEXT/g) ?? []).length, 1);
	assert.equal((messageText(thirdCall.context).match(/MAIN-CONTEXT/g) ?? []).length, 1);
	assert.deepEqual(
		calls.map((call) => call.model),
		[model, model, model],
	);
	assert.deepEqual(
		calls.map((call) => call.options?.reasoning),
		["low", "low", "low"],
	);
	assert.deepEqual(
		thread.turns.map((turn) => ({ question: turn.question, answer: turn.answer })),
		[
			{ question: "Q1", answer: "A1" },
			{ question: "Q2", answer: "A2" },
			{ question: "Q3", answer: "A3" },
		],
	);
});

test("side thread discards a late successful response after cancellation", async () => {
	const thread = createSideThread("context");
	const controller = new AbortController();
	let release: ((value: AssistantMessage) => void) | undefined;
	const pending = completeSideThreadTurn({
		thread,
		question: "cancel me",
		model: { provider: "test", id: "side" } as Model<Api>,
		auth: { apiKey: "key" },
		thinkingLevel: "off",
		signal: controller.signal,
		completeSimple: () =>
			new Promise<AssistantMessage>((resolve) => {
				release = resolve;
			}),
	});
	controller.abort();
	assert.ok(release);
	release(response("late answer"));

	assert.deepEqual(await pending, { kind: "aborted" });
	assert.deepEqual(thread.turns, []);
});

test("side thread turns malformed provider responses into visible errors", async () => {
	for (const malformed of [null, { ...response("answer"), content: undefined }]) {
		const thread = createSideThread("context");
		const result = await completeSideThreadTurn({
			thread,
			question: "handle malformed response",
			model: { provider: "test", id: "side" } as Model<Api>,
			auth: { apiKey: "key" },
			thinkingLevel: "off",
			completeSimple: async () => malformed as never,
		});

		assert.equal(result.kind, "error");
		assert.match(result.kind === "error" ? result.message : "", /malformed response/i);
		assert.deepEqual(thread.turns, []);
	}
});

test("assistant text extraction ignores malformed content blocks", () => {
	assert.equal(
		extractAssistantText({
			...response("unused"),
			content: [null, { type: "text", text: 42 }, { type: "text", text: "valid answer" }],
		} as never),
		"valid answer",
	);
});

test("side thread does not record aborted completions", async () => {
	const thread = createSideThread("context");
	const result = await completeSideThreadTurn({
		thread,
		question: "cancel me",
		model: { provider: "test", id: "side" } as Model<Api>,
		auth: { apiKey: "key" },
		thinkingLevel: "off",
		completeSimple: async () => ({ ...response(""), stopReason: "aborted" }),
	});

	assert.equal(result.kind, "aborted");
	assert.deepEqual(thread.turns, []);
});

test("buildSideThreadMessages keeps failed display turns out of provider context", () => {
	const thread: SideThread = createSideThread("context");
	thread.turns.push({ question: "failed", answer: "Error: boom", kind: "error" });
	const messages = buildSideThreadMessages(thread, "retry");
	assert.equal(messages.length, 1);
	assert.match(JSON.stringify(messages), /retry/);
	assert.doesNotMatch(JSON.stringify(messages), /failed|boom/);
});

test("bring-to-main scopes exclude failed turns and preserve ordered question and answer roles", () => {
	const turns = [
		{ question: "Q1", answer: "A1", kind: "answered" as const, response: response("A1") },
		{ question: "failed", answer: "boom", kind: "error" as const },
		{ question: "Q2", answer: "A2", kind: "answered" as const, response: response("A2") },
	];

	assert.deepEqual(buildQuickBringToMainSegments(turns, { kind: "latest" }), [
		{ role: "user", text: "Q2" },
		{ role: "assistant", text: "A2" },
	]);
	assert.deepEqual(buildQuickBringToMainSegments(turns, { kind: "from", answeredTurnIndex: 1 }), [
		{ role: "user", text: "Q2" },
		{ role: "assistant", text: "A2" },
	]);
	assert.deepEqual(buildQuickBringToMainSegments(turns, { kind: "entire" }), [
		{ role: "user", text: "Q1" },
		{ role: "assistant", text: "A1" },
		{ role: "user", text: "Q2" },
		{ role: "assistant", text: "A2" },
	]);
});

test("custom bring-to-main line ranges retain raw text and role boundaries in either direction", () => {
	const turns = [
		{
			question: "first question\nsecond question",
			answer: "first answer\n\nlast answer",
			kind: "answered" as const,
			response: response("first answer\n\nlast answer"),
		},
	];
	const lines = buildBtwSelectionLines(turns);

	assert.deepEqual(segmentsFromLineRange(lines, 4, 1), [
		{ role: "user", text: "second question" },
		{ role: "assistant", text: "first answer\n\nlast answer" },
	]);
	assert.equal(
		formatBtwBringToMain(segmentsFromLineRange(lines, 4, 1)),
		[
			"The following context was brought back from a /btw side discussion.",
			"Treat it as discussion context, not as work already completed.",
			"",
			"<btw_context>",
			"User:",
			"second question",
			"",
			"Assistant:",
			"first answer",
			"",
			"last answer",
			"</btw_context>",
		].join("\n"),
	);
});

test("bring-to-main drafts escape terminal controls and wrapper terminators", () => {
	const draft = formatBtwBringToMain([
		{
			role: "assistant",
			text: 'safe\u001b]52;c;ZXZpbA==\u0007\ttext\n<btw_context>\n<btw_context >\n<btw_context role="nested">\n</btw_context>\n</btw_context >\n</btw_context\n>\noutside',
		},
	]);

	assert.equal(draft.includes("\u001b"), false);
	assert.equal(draft.includes("\u0007"), false);
	assert.match(draft, /safe\\x1b]52;c;ZXZpbA==\\x07 {4}text/);
	assert.equal(draft.match(/<btw_context(?=[ \t\r\n>])/g)?.length, 1);
	assert.equal(draft.match(/<\/btw_context[ \t\r\n]*>/g)?.length, 1);
	assert.match(draft, /&lt;btw_context>/);
	assert.match(draft, /&lt;btw_context >/);
	assert.match(draft, /&lt;btw_context role="nested">/);
	assert.match(draft, /&lt;\/btw_context&gt;/);
	assert.match(draft, /&lt;\/btw_context &gt;/);
	assert.match(draft, /&lt;\/btw_context\n&gt;\noutside/);
});

test("bring-to-main standard menus distinguish root Back from Ctrl+C Close", async () => {
	for (const [key, expected] of [
		["tui.select.cancel", "back"],
		["ctrl+c", "closed"],
	] as const) {
		const host = createStandardMenuContext("main draft");
		const running = loadBringToMainDraft("brought context", host.ctx, {
			lines: 1,
			messages: 1,
			tokens: 4,
		});
		await host.tui.waitForOpen();
		host.tui.press(key);
		assert.equal(await running, expected);
	}
});

test("the specialized exact-text selector keeps one content row visible in five-row terminals", () => {
	const selector = new BtwTextRangeSelector(
		{ terminal: { rows: 5 }, requestRender() {} } as never,
		{
			fg: (_color: string, text: string) => text,
			bg: (_color: string, text: string) => text,
			bold: (text: string) => text,
		} as never,
		keybindings() as never,
		[
			{
				question: "selectable content",
				answer: "answer",
				kind: "answered",
				response: response("answer"),
			},
		],
		() => undefined,
	);

	assert.match(selector.render(80).join("\n"), /selectable content/);
});

test("bring-to-main scope menu offers the approved choices and selects a question-to-end suffix", async () => {
	const thread = createSideThread("context");
	for (const [question, answer] of [
		["Q1", "A1"],
		["Q2", "A2"],
	] as const) {
		thread.turns.push({ kind: "answered", question, answer, response: response(answer) });
	}
	const prompts: Array<{ title: string; options: string[] }> = [];
	const selections = ["From a question onward…  Choose a starting question", "2. Q2"];
	const ctx = { ui: {} } as never;

	const result = await chooseBringToMain(thread, ctx, {
		showMenu: async (_ctx, title, options) => {
			prompts.push({ title, options: [...options] });
			const value = selections.shift();
			return value ? { kind: "select", value } : { kind: "back" };
		},
		showPreview: async () => ({ kind: "bring" }),
	});

	assert.deepEqual(prompts[0], {
		title: "Bring what back to the main thread?",
		options: [
			"Latest question and answer  1 Q&A · ~2 tokens",
			"From a question onward…  Choose a starting question",
			"Select exact text…  Lines or characters",
			"Entire side thread  2 Q&A · ~3 tokens",
			"Cancel  Return to the side thread",
		],
	});
	assert.equal(result.kind, "bringToMain");
	assert.doesNotMatch(result.kind === "bringToMain" ? result.draft : "", /Q1|A1/);
	assert.match(result.kind === "bringToMain" ? result.draft : "", /Q2[\s\S]*A2/);
});

test("question-suffix preview returns to the previously selected question", async () => {
	const thread = createSideThread("context");
	for (const [question, answer] of [
		["Q1", "A1"],
		["Q2", "A2"],
	] as const) {
		thread.turns.push({ kind: "answered", question, answer, response: response(answer) });
	}
	let scopeMenus = 0;
	let questionMenus = 0;
	const initialQuestions: Array<string | undefined> = [];
	let previews = 0;

	const result = await chooseBringToMain(thread, { ui: {} } as never, {
		showMenu: async (_ctx, title, options, initialValue) => {
			if (title === "Bring what back to the main thread?") {
				scopeMenus += 1;
				const value = options.find((option) => option.startsWith("From a question"));
				return value ? { kind: "select", value } : { kind: "back" };
			}
			questionMenus += 1;
			initialQuestions.push(initialValue);
			return { kind: "select", value: options[1] ?? "" };
		},
		showPreview: async () => {
			previews += 1;
			return previews === 1 ? { kind: "back" } : { kind: "bring" };
		},
	});

	assert.equal(scopeMenus, 1);
	assert.equal(questionMenus, 2);
	assert.deepEqual(initialQuestions, [undefined, "2. Q2"]);
	assert.match(result.kind === "bringToMain" ? result.draft : "", /Q2[\s\S]*A2/);
});

test("Kit-backed question menus restore the selected question after preview Back", async () => {
	const thread = createSideThread("context");
	for (const [question, answer] of [
		["Q1", "A1"],
		["Q2", "A2"],
	] as const) {
		thread.turns.push({ kind: "answered", question, answer, response: response(answer) });
	}
	const host = createStandardMenuContext("main draft");
	const running = chooseBringToMain(thread, host.ctx);
	await host.tui.waitForOpen();
	host.tui.press("tui.select.down");
	host.tui.press("tui.select.confirm");
	await host.tui.waitForOpen();
	host.tui.press("tui.select.down");
	host.tui.press("tui.select.confirm");
	await host.tui.waitForOpen();
	host.tui.press("tui.select.cancel");
	await host.tui.waitForOpen();

	assert.match(host.tui.render().join("\n"), /→ 2\. Q2/);
	host.tui.press("ctrl+c");
	assert.deepEqual(await running, { kind: "closed" });
});

test("large bring-to-main scopes preview the exact draft and support Back", async () => {
	const thread = createSideThread("context");
	for (const [question, answer] of [
		["Q1", "A1"],
		["Q2", "A2"],
	] as const) {
		thread.turns.push({ kind: "answered", question, answer, response: response(answer) });
	}
	let scopeMenuCount = 0;
	let previewDraft = "";
	const initialScopes: Array<string | undefined> = [];
	const result = await chooseBringToMain(thread, { ui: {} } as never, {
		showMenu: async (_ctx, title, options, initialValue) => {
			if (title !== "Bring what back to the main thread?") return { kind: "back" };
			scopeMenuCount += 1;
			initialScopes.push(initialValue);
			const prefix = scopeMenuCount === 1 ? "Entire side thread" : "Latest question and answer";
			const value = options.find((option) => option.startsWith(prefix));
			return value ? { kind: "select", value } : { kind: "back" };
		},
		showPreview: async (_ctx, draft, summary) => {
			previewDraft = draft;
			assert.deepEqual(summary, { lines: 4, messages: 4, tokens: 3 });
			return { kind: "back" };
		},
	});

	assert.match(previewDraft, /Q1[\s\S]*A1[\s\S]*Q2[\s\S]*A2/);
	assert.equal(scopeMenuCount, 2);
	assert.match(initialScopes[1] ?? "", /^Entire side thread/);
	assert.equal(result.kind, "bringToMain");
	assert.doesNotMatch(result.kind === "bringToMain" ? result.draft : "", /Q1|A1/);
});

test("custom text ranges pass their exact formatted draft through preview", async () => {
	const thread = createSideThread("context");
	thread.turns.push({ kind: "answered", question: "Q", answer: "A", response: response("A") });
	const exactDraft = formatBtwBringToMain([{ role: "assistant", text: "exact excerpt" }]);
	let previewDraft = "";
	let selectorCustomOptions: unknown;
	let editor = "main draft";
	const ctx = {
		ui: {
			getEditorText: () => editor,
			setEditorText: (text: string) => {
				editor = text;
			},
			custom: async (_factory: unknown, customOptions?: unknown) => {
				selectorCustomOptions = customOptions;
				return {
					kind: "bringToMain",
					draft: exactDraft,
					summary: { lines: 1, messages: 1, tokens: 4 },
				};
			},
		},
	} as never;

	const result = await chooseBringToMain(thread, ctx, {
		showMenu: async (_ctx, _title, options) => {
			const value = options.find((option) => option.startsWith("Select exact text"));
			return value ? { kind: "select", value } : { kind: "back" };
		},
		showPreview: async (_ctx, draft) => {
			previewDraft = draft;
			return { kind: "bring" };
		},
	});

	assert.equal(selectorCustomOptions, undefined);
	assert.equal(previewDraft, exactDraft);
	assert.deepEqual(result, {
		kind: "bringToMain",
		draft: exactDraft,
		summary: { lines: 1, messages: 1, tokens: 4 },
	});
});

test("exact text selection survives returning from preview", async () => {
	const thread = createSideThread("context");
	thread.turns.push({
		kind: "answered",
		question: "abcd",
		answer: "answer",
		response: response("answer"),
	});
	let editor = "main draft";
	let selectorCount = 0;
	const ctx = {
		ui: {
			getEditorText: () => editor,
			setEditorText: (text: string) => {
				editor = text;
			},
			custom: async (
				factory: (...args: never[]) => {
					handleInput(data: string): void;
					render(width: number): string[];
				},
			) => {
				let result: unknown;
				const component = factory(
					{ terminal: { rows: 10 }, requestRender() {} } as never,
					{
						fg: (_color: string, text: string) => text,
						bg: (_color: string, text: string) => text,
						bold: (text: string) => text,
					} as never,
					keybindings() as never,
					((value: unknown) => {
						result = value;
					}) as never,
				);
				selectorCount += 1;
				if (selectorCount === 1) {
					component.handleInput("\u001b[1;2C");
					component.handleInput("\u001b[1;2C");
				} else {
					assert.match(component.render(80).join("\n"), /Selected: 1 line · 1 message/);
				}
				component.handleInput("\r");
				return result;
			},
		},
	} as never;
	let previewCount = 0;

	const result = await chooseBringToMain(thread, ctx, {
		showMenu: async (_ctx, _title, options) => {
			const value = options.find((option) => option.startsWith("Select exact text"));
			return value ? { kind: "select", value } : { kind: "back" };
		},
		showPreview: async () => {
			previewCount += 1;
			return previewCount === 1 ? { kind: "back" } : { kind: "bring" };
		},
	});

	assert.equal(selectorCount, 2);
	assert.equal(result.kind, "bringToMain");
	assert.match(result.kind === "bringToMain" ? result.draft : "", /User:\nab/);
});

test("adaptive bring-to-main preview preserves content, bounds, resize, Back state, and Close", async () => {
	const thread = createSideThread("context");
	const answer = Array.from({ length: 12 }, (_, index) => `answer line ${index + 1}`).join("\n");
	thread.turns.push({ kind: "answered", question: "Q", answer, response: response(answer) });
	const host = createStandardMenuContext("main draft", 9);
	const running = chooseBringToMain(thread, host.ctx);

	await host.tui.waitForOpen();
	for (let index = 0; index < 3; index += 1) host.tui.press("tui.select.down");
	host.tui.press("tui.select.confirm");
	await host.tui.waitForOpen();
	const initial = host.tui.render(40);
	assert.ok(initial.every((line) => visibleWidth(line) <= 40));
	assert.ok(initial.length <= 6);
	assert.match(initial.join("\n"), /Preview · 2 messages · 13 lines/);
	assert.match(initial.join("\n"), /The following context/);

	const constrained = host.tui.resize({ width: 17, rows: 5 });
	assert.ok(constrained.every((line) => visibleWidth(line) <= 17));
	assert.ok(constrained.length <= 2);
	const expanded = host.tui.resize({ width: 100, rows: 14 });
	assert.ok(expanded.length <= 11);
	host.tui.press("tui.select.pageDown");
	assert.match(host.tui.render().join("\n"), /answer line/);
	host.changeEditor("newer main draft");
	host.tui.press("tui.select.cancel");

	await host.tui.waitForOpen();
	assert.match(host.tui.render().join("\n"), /→ Entire side thread/);
	assert.equal(host.editor, "newer main draft");
	host.tui.press("tui.select.confirm");
	await host.tui.waitForOpen();
	host.tui.press("ctrl+c");
	assert.deepEqual(await running, { kind: "closed" });
});

test("adaptive bring-to-main preview confirms the exact draft and preserves editor changes", async () => {
	const thread = createSideThread("context");
	thread.turns.push({ kind: "answered", question: "Q", answer: "A", response: response("A") });
	const host = createStandardMenuContext("main draft");
	const running = chooseBringToMain(thread, host.ctx);
	await host.tui.waitForOpen();
	for (let index = 0; index < 3; index += 1) host.tui.press("tui.select.down");
	host.tui.press("tui.select.confirm");
	await host.tui.waitForOpen();
	host.changeEditor("newer main draft");
	host.tui.press("tui.select.confirm");

	const result = await running;
	assert.equal(result.kind, "bringToMain");
	assert.equal(
		result.kind === "bringToMain" ? result.draft : "",
		formatBtwBringToMain([
			{ role: "user", text: "Q" },
			{ role: "assistant", text: "A" },
		]),
	);
	assert.equal(host.editor, "newer main draft");
});

test("disposing the specialized exact-text selector closes without obsolete editor writes", async () => {
	const thread = createSideThread("context");
	thread.turns.push({ kind: "answered", question: "Q", answer: "A", response: response("A") });
	const host = createStandardMenuContext("main draft");
	const running = chooseBringToMain(thread, host.ctx);
	await host.tui.waitForOpen();
	host.tui.press("tui.select.down");
	host.tui.press("tui.select.down");
	host.tui.press("tui.select.confirm");
	await host.tui.waitForOpen();
	host.changeEditor("obsolete session editor");
	host.tui.dispose();

	assert.deepEqual(await running, { kind: "closed" });
	assert.deepEqual(host.editorWrites, []);
	assert.equal(host.editor, "main draft");
});

test("bring-to-main scope menu propagates Ctrl+C as a side-thread close", async () => {
	const thread = createSideThread("context");
	thread.turns.push({ kind: "answered", question: "Q", answer: "A", response: response("A") });

	const result = await chooseBringToMain(thread, { ui: {} } as never, {
		showMenu: async () => ({ kind: "close" }),
	});

	assert.deepEqual(result, { kind: "closed" });
});

test("side-thread sends custom APIs through Pi core's effective provider", async () => {
	initTheme("dark");
	const model = {
		provider: "synthetic-provider",
		id: "synthetic-model",
		api: "synthetic-custom-api",
		reasoning: false,
	} as Model<Api>;
	const selected: ResolvedBtwModel = {
		model,
		auth: { apiKey: "synthetic-key", headers: { "x-test": "yes" } },
	};
	const providerReads: string[] = [];
	const streamCalls: Array<{
		model: Model<Api>;
		context: Context;
		options?: SimpleStreamOptions;
	}> = [];
	let customCalls = 0;
	const ctx = {
		ui: {
			notify() {},
			custom: async (factory: (...args: never[]) => unknown) => {
				customCalls += 1;
				if (customCalls > 1) return { kind: "close" };
				return new Promise((resolve) => {
					factory(
						{ terminal: { rows: 24 }, requestRender() {} } as never,
						{
							fg: (_color: string, text: string) => text,
							bold: (text: string) => text,
						} as never,
						keybindings() as never,
						resolve as never,
					);
				});
			},
		},
		modelRegistry: {
			getProvider(provider: string) {
				providerReads.push(provider);
				return {
					streamSimple(capturedModel: Model<Api>, context: Context, options?: SimpleStreamOptions) {
						streamCalls.push({ model: capturedModel, context, options });
						return { result: async () => response("scoped answer") } as never;
					},
				};
			},
		},
		sessionManager: { getBranch: () => [] },
	} as never;

	assert.deepEqual(
		await runBtwThread({
			initialQuestion: "Can the scoped provider answer?",
			selected,
			thinkingLevel: "off",
			ctx,
		}),
		{ kind: "closed" },
	);
	assert.deepEqual(providerReads, ["synthetic-provider"]);
	assert.equal(streamCalls.length, 1);
	assert.equal(streamCalls[0]?.model, model);
	assert.equal(streamCalls[0]?.options?.apiKey, "synthetic-key");
	assert.deepEqual(streamCalls[0]?.options?.headers, { "x-test": "yes" });
});

test("side-thread command loop opens the composer before the first question", async () => {
	const ctx = {
		ui: { notify() {} },
		sessionManager: { getBranch: () => [] },
	} as never;
	const selected: ResolvedBtwModel = {
		model: { provider: "test", id: "side" } as Model<Api>,
		auth: { apiKey: "key" },
	};
	const transcriptSizes: number[] = [];
	const questions: string[] = [];
	const interactions = [{ kind: "submit" as const, question: "Q1" }, { kind: "close" as const }];

	const result = await runBtwThread({
		selected,
		thinkingLevel: "off",
		ctx,
		dependencies: {
			interact: async (thread) => {
				transcriptSizes.push(thread.turns.length);
				return interactions.shift() ?? { kind: "close" };
			},
			ask: async (thread, question) => {
				questions.push(question);
				const assistant = response("A1");
				thread.turns.push({ kind: "answered", question, answer: "A1", response: assistant });
				return { kind: "answered", response: assistant, answer: "A1" };
			},
		},
	});

	assert.deepEqual(transcriptSizes, [0, 1]);
	assert.deepEqual(questions, ["Q1"]);
	assert.deepEqual(result, { kind: "closed" });
});

test("side-thread command loop updates resumable title, activity, and local thinking state", async () => {
	const state = {
		id: "btw-1",
		title: undefined,
		thread: createSideThread("main context"),
		thinkingLevel: "low" as const,
		createdAt: 10,
		updatedAt: 10,
	};
	const askedWith: string[] = [];
	let interactions = 0;

	await runBtwThread({
		selected: {
			model: { provider: "test", id: "side", reasoning: true } as Model<Api>,
			auth: { apiKey: "key" },
		},
		thinkingLevel: "off",
		state,
		ctx: {
			ui: { notify() {} },
			sessionManager: { getBranch: () => assert.fail("resumed state owns its original context") },
		} as never,
		dependencies: {
			now: () => 42,
			interact: async (_thread, _atBottom, _ctx, _draft, thinking) => {
				interactions += 1;
				if (interactions === 1) {
					assert.equal(thinking.level, "low");
					thinking.onChange("high");
					return { kind: "submit", question: "First\nquestion" };
				}
				return { kind: "close" };
			},
			ask: async (thread, question, _selected, thinkingLevel) => {
				askedWith.push(thinkingLevel);
				const assistant = response("answer");
				thread.turns.push({ kind: "answered", question, answer: "answer", response: assistant });
				return { kind: "answered", response: assistant, answer: "answer" };
			},
		},
	});

	assert.equal(state.title, "First question");
	assert.equal(state.thinkingLevel, "high");
	assert.equal(state.updatedAt, 42);
	assert.deepEqual(askedWith, ["high"]);
	assert.equal(state.thread.turns.length, 1);
});

test("side-thread command loop retains a visible error as resumable activity", async () => {
	const state = {
		id: "btw-error",
		title: undefined,
		thread: createSideThread("main context"),
		thinkingLevel: "off" as const,
		createdAt: 5,
		updatedAt: 5,
	};
	let interactions = 0;

	await runBtwThread({
		initialQuestion: "Failed question",
		selected: {
			model: { provider: "test", id: "side" } as Model<Api>,
			auth: { apiKey: "key" },
		},
		thinkingLevel: "off",
		state,
		ctx: {
			ui: { notify() {} },
			sessionManager: { getBranch: () => assert.fail("provided state owns its context") },
		} as never,
		dependencies: {
			now: () => 9,
			ask: async () => ({ kind: "error", message: "provider unavailable" }),
			interact: async () => {
				interactions += 1;
				return { kind: "close" };
			},
		},
	});

	assert.equal(interactions, 1);
	assert.equal(state.title, "Failed question");
	assert.equal(state.updatedAt, 9);
	assert.deepEqual(state.thread.turns, [
		{ kind: "error", question: "Failed question", answer: "provider unavailable" },
	]);
});

test("side-thread command loop immediately accepts another question after each answer", async () => {
	const ctx = {
		ui: { notify() {} },
		sessionManager: {
			getBranch: () => [
				{ type: "message", message: { role: "user", content: [{ type: "text", text: "main" }] } },
			],
		},
	} as never;
	const selected: ResolvedBtwModel = {
		model: { provider: "test", id: "side", reasoning: true } as Model<Api>,
		auth: { apiKey: "key" },
	};
	const questions: string[] = [];
	const transcriptSizes: number[] = [];
	const interactions = [{ kind: "submit" as const, question: "Q2" }, { kind: "close" as const }];

	await runBtwThread({
		initialQuestion: "Q1",
		selected,
		thinkingLevel: "medium",
		ctx,
		dependencies: {
			ask: async (thread, question, capturedSelected, capturedThinking) => {
				questions.push(question);
				assert.equal(capturedSelected, selected);
				assert.equal(capturedThinking, "medium");
				const assistant = response(`A${questions.length}`);
				thread.turns.push({
					kind: "answered",
					question,
					answer: `A${questions.length}`,
					response: assistant,
				});
				return { kind: "answered", response: assistant, answer: `A${questions.length}` };
			},
			interact: async (thread) => {
				transcriptSizes.push(thread.turns.length);
				return interactions.shift() ?? { kind: "close" };
			},
		},
	});

	assert.deepEqual(questions, ["Q1", "Q2"]);
	assert.deepEqual(transcriptSizes, [1, 2]);
});

test("side-thread thinking changes apply to later questions without changing the initial level", async () => {
	const ctx = {
		ui: { notify() {} },
		sessionManager: { getBranch: () => [] },
	} as never;
	const selected: ResolvedBtwModel = {
		model: { provider: "test", id: "side", reasoning: true } as Model<Api>,
		auth: { apiKey: "key" },
	};
	const thinkingLevels: string[] = [];
	let interactions = 0;

	await runBtwThread({
		initialQuestion: "Q1",
		selected,
		thinkingLevel: "low",
		ctx,
		dependencies: {
			ask: async (thread, question, _selected, thinkingLevel) => {
				thinkingLevels.push(thinkingLevel);
				const assistant = response("answer");
				thread.turns.push({ kind: "answered", question, answer: "answer", response: assistant });
				return { kind: "answered", response: assistant, answer: "answer" };
			},
			interact: async (_thread, _atBottom, _ctx, _draft, thinking) => {
				interactions += 1;
				if (interactions === 1) {
					assert.equal(thinking.level, "low");
					thinking.onChange("high");
					return { kind: "submit", question: "Q2" };
				}
				assert.equal(thinking.level, "high");
				return { kind: "close" };
			},
		},
	});

	assert.deepEqual(thinkingLevels, ["low", "high"]);
});

test("side-thread remembers rapid thinking changes in order and uses the latest level", async () => {
	const persisted: string[] = [];
	const askedWith: string[] = [];
	let interactions = 0;
	await runBtwThread({
		initialQuestion: "Q1",
		selected: {
			model: { provider: "test", id: "side", reasoning: true } as Model<Api>,
			auth: { apiKey: "key" },
		},
		thinkingLevel: "low",
		rememberThinkingLevelChanges: true,
		ctx: {
			ui: { notify() {} },
			sessionManager: { getBranch: () => [] },
		} as never,
		dependencies: {
			persistThinkingLevel: async (level) => {
				persisted.push(level);
			},
			ask: async (thread, question, _selected, level) => {
				askedWith.push(level);
				const assistant = response("answer");
				thread.turns.push({ kind: "answered", question, answer: "answer", response: assistant });
				return { kind: "answered", response: assistant, answer: "answer" };
			},
			interact: async (_thread, _atBottom, _ctx, _draft, thinking) => {
				interactions += 1;
				if (interactions === 1) {
					thinking.onChange("medium");
					thinking.onChange("high");
					return { kind: "submit", question: "Q2" };
				}
				return { kind: "close" };
			},
		},
	});

	assert.deepEqual(askedWith, ["low", "high"]);
	assert.deepEqual(persisted, ["medium", "high"]);
});

test("side-thread remembered thinking survives in pi-btw settings", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-btw-thread-settings-test-"));
	const settingsPath = join(directory, "pi-btw.json");
	try {
		let interactions = 0;
		await runBtwThread({
			initialQuestion: "Q1",
			selected: {
				model: { provider: "test", id: "side", reasoning: true } as Model<Api>,
				auth: { apiKey: "key" },
			},
			thinkingLevel: "low",
			rememberThinkingLevelChanges: true,
			settingsPath,
			ctx: {
				ui: { notify() {} },
				sessionManager: { getBranch: () => [] },
			} as never,
			dependencies: {
				ask: async (thread, question) => {
					const assistant = response("answer");
					thread.turns.push({ kind: "answered", question, answer: "answer", response: assistant });
					return { kind: "answered", response: assistant, answer: "answer" };
				},
				interact: async (_thread, _atBottom, _ctx, _draft, thinking) => {
					interactions += 1;
					if (interactions === 1) thinking.onChange("high");
					return { kind: "close" };
				},
			},
		});
		assert.equal(
			(JSON.parse(await readFile(settingsPath, "utf8")) as { thinkingLevel: string }).thinkingLevel,
			"high",
		);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("side-thread remembering off changes locally without writing settings", async () => {
	const askedWith: string[] = [];
	let interactions = 0;
	await runBtwThread({
		initialQuestion: "Q1",
		selected: {
			model: { provider: "test", id: "side", reasoning: true } as Model<Api>,
			auth: { apiKey: "key" },
		},
		thinkingLevel: "low",
		rememberThinkingLevelChanges: false,
		ctx: {
			ui: { notify() {} },
			sessionManager: { getBranch: () => [] },
		} as never,
		dependencies: {
			persistThinkingLevel: async () => assert.fail("remembering off must not persist"),
			ask: async (thread, question, _selected, level) => {
				askedWith.push(level);
				const assistant = response("answer");
				thread.turns.push({ kind: "answered", question, answer: "answer", response: assistant });
				return { kind: "answered", response: assistant, answer: "answer" };
			},
			interact: async (_thread, _atBottom, _ctx, _draft, thinking) => {
				interactions += 1;
				if (interactions === 1) {
					thinking.onChange("high");
					return { kind: "submit", question: "Q2" };
				}
				return { kind: "close" };
			},
		},
	});

	assert.deepEqual(askedWith, ["low", "high"]);
});

test("side-thread save failure keeps the local thinking level and warns once", async () => {
	const notifications: Array<{ message: string; level: string }> = [];
	const askedWith: string[] = [];
	let interactions = 0;
	await runBtwThread({
		initialQuestion: "Q1",
		selected: {
			model: { provider: "test", id: "side", reasoning: true } as Model<Api>,
			auth: { apiKey: "key" },
		},
		thinkingLevel: "low",
		rememberThinkingLevelChanges: true,
		ctx: {
			ui: {
				notify(message: string, level: string) {
					notifications.push({ message, level });
				},
			},
			sessionManager: { getBranch: () => [] },
		} as never,
		dependencies: {
			persistThinkingLevel: async () => Promise.reject(new Error("read-only filesystem")),
			ask: async (thread, question, _selected, level) => {
				askedWith.push(level);
				const assistant = response("answer");
				thread.turns.push({ kind: "answered", question, answer: "answer", response: assistant });
				return { kind: "answered", response: assistant, answer: "answer" };
			},
			interact: async (_thread, _atBottom, _ctx, _draft, thinking) => {
				interactions += 1;
				if (interactions === 1) {
					thinking.onChange("high");
					return { kind: "submit", question: "Q2" };
				}
				return { kind: "close" };
			},
		},
	});

	assert.deepEqual(askedWith, ["low", "high"]);
	assert.equal(notifications.length, 1);
	assert.equal(notifications[0]?.level, "warning");
	assert.match(
		notifications[0]?.message ?? "",
		/changed to high.*could not be remembered.*read-only/i,
	);
});

test("side-thread catches synchronous thinking persistence failures", async () => {
	const notifications: Array<{ message: string; level: string }> = [];
	let interactions = 0;
	await runBtwThread({
		initialQuestion: "Q1",
		selected: {
			model: { provider: "test", id: "side", reasoning: true } as Model<Api>,
			auth: { apiKey: "key" },
		},
		thinkingLevel: "low",
		rememberThinkingLevelChanges: true,
		ctx: {
			ui: {
				notify(message: string, level: string) {
					notifications.push({ message, level });
				},
			},
			sessionManager: { getBranch: () => [] },
		} as never,
		dependencies: {
			persistThinkingLevel: (() => {
				throw new Error("synchronous persistence failure");
			}) as never,
			ask: async (thread, question) => {
				const assistant = response("answer");
				thread.turns.push({ kind: "answered", question, answer: "answer", response: assistant });
				return { kind: "answered", response: assistant, answer: "answer" };
			},
			interact: async (_thread, _atBottom, _ctx, _draft, thinking) => {
				interactions += 1;
				thinking.onChange("high");
				return { kind: "close" };
			},
		},
	});

	assert.equal(interactions, 1);
	assert.equal(notifications.length, 1);
	assert.match(notifications[0]?.message ?? "", /synchronous persistence failure/);
});

test("side-thread thinking starts clamped to the selected model's capabilities", async () => {
	const captured: string[] = [];
	await runBtwThread({
		initialQuestion: "Q1",
		selected: {
			model: { provider: "test", id: "plain", reasoning: false } as Model<Api>,
			auth: { apiKey: "key" },
		},
		thinkingLevel: "high",
		ctx: {
			ui: { notify() {} },
			sessionManager: { getBranch: () => [] },
		} as never,
		dependencies: {
			ask: async (thread, question, _selected, thinkingLevel) => {
				captured.push(thinkingLevel);
				const assistant = response("answer");
				thread.turns.push({ kind: "answered", question, answer: "answer", response: assistant });
				return { kind: "answered", response: assistant, answer: "answer" };
			},
			interact: async (_thread, _atBottom, _ctx, _draft, thinking) => {
				captured.push(thinking.level);
				return { kind: "close" };
			},
		},
	});

	assert.deepEqual(captured, ["off", "off"]);
});

test("cancelling an in-progress side answer exits without reopening the composer", async () => {
	const notifications: Array<{ message: string; level: string }> = [];
	const ctx = {
		ui: {
			notify(message: string, level: string) {
				notifications.push({ message, level });
			},
		},
		sessionManager: { getBranch: () => [] },
	} as never;
	let interactions = 0;

	await runBtwThread({
		initialQuestion: "Q1",
		selected: {
			model: { provider: "test", id: "side" } as Model<Api>,
			auth: { apiKey: "key" },
		},
		thinkingLevel: "off",
		ctx,
		dependencies: {
			ask: async () => ({ kind: "aborted" }),
			interact: async () => {
				interactions += 1;
				return { kind: "close" };
			},
		},
	});

	assert.equal(interactions, 0);
	assert.deepEqual(notifications, [{ message: "Cancelled", level: "info" }]);
});

test("side-thread cancellation tolerates a replaced notification context", async () => {
	const result = await runBtwThread({
		initialQuestion: "Q1",
		selected: {
			model: { provider: "test", id: "side" } as Model<Api>,
			auth: { apiKey: "key" },
		},
		thinkingLevel: "off",
		ctx: {
			ui: {
				notify() {
					throw new Error("Extension context is no longer active");
				},
			},
			sessionManager: { getBranch: () => [] },
		} as never,
		dependencies: {
			ask: async () => ({ kind: "aborted" }),
			interact: async () => assert.fail("cancelled requests must not reopen the composer"),
		},
	});

	assert.deepEqual(result, { kind: "closed" });
});

test("cancelled bring-to-main selection restores the unsubmitted side-question draft", async () => {
	const ctx = {
		ui: { notify() {} },
		sessionManager: { getBranch: () => [] },
	} as never;
	const drafts: Array<string | undefined> = [];
	let interactions = 0;
	const result = await runBtwThread({
		initialQuestion: "Q1",
		selected: {
			model: { provider: "test", id: "side" } as Model<Api>,
			auth: { apiKey: "key" },
		},
		thinkingLevel: "off",
		ctx,
		dependencies: {
			ask: async (thread) => {
				const assistant = response("A1");
				thread.turns.push({ kind: "answered", question: "Q1", answer: "A1", response: assistant });
				return { kind: "answered", response: assistant, answer: "A1" };
			},
			interact: async (_thread, _atBottom, _ctx, draft) => {
				drafts.push(draft);
				interactions += 1;
				return interactions === 1
					? { kind: "bringToMain", questionDraft: "unfinished question" }
					: { kind: "close" };
			},
			chooseBringToMain: async () => ({ kind: "back" }),
		},
	});

	assert.deepEqual(drafts, [undefined, "unfinished question"]);
	assert.deepEqual(result, { kind: "closed" });
});

test("cancelled main-editor loading returns to the side composer with its draft", async () => {
	const ctx = {
		ui: { notify() {} },
		sessionManager: { getBranch: () => [] },
	} as never;
	const drafts: Array<string | undefined> = [];
	let interactions = 0;
	const result = await runBtwThread({
		initialQuestion: "Q1",
		selected: {
			model: { provider: "test", id: "side" } as Model<Api>,
			auth: { apiKey: "key" },
		},
		thinkingLevel: "off",
		ctx,
		dependencies: {
			ask: async (thread) => {
				const assistant = response("A1");
				thread.turns.push({ kind: "answered", question: "Q1", answer: "A1", response: assistant });
				return { kind: "answered", response: assistant, answer: "A1" };
			},
			interact: async (_thread, _atBottom, _ctx, draft) => {
				drafts.push(draft);
				interactions += 1;
				return interactions === 1
					? { kind: "bringToMain", questionDraft: "unfinished question" }
					: { kind: "close" };
			},
			chooseBringToMain: async () => ({
				kind: "bringToMain",
				draft: "selected draft",
				summary: { lines: 1, messages: 1, tokens: 4 },
			}),
			deliverBringToMain: async () => "back",
		},
	});

	assert.deepEqual(drafts, [undefined, "unfinished question"]);
	assert.deepEqual(result, { kind: "closed" });
});

test("side-thread command loop loads an explicit bring-to-main draft without mutating the session", async () => {
	const branch = [{ type: "message", message: { role: "user", content: "main" } }];
	const ctx = {
		ui: { notify() {} },
		sessionManager: { getBranch: () => branch },
	} as never;
	const assistant = response("A1");
	const delivered: Array<{ draft: string; summary: unknown }> = [];
	const result = await runBtwThread({
		initialQuestion: "Q1",
		selected: {
			model: { provider: "test", id: "side" } as Model<Api>,
			auth: { apiKey: "key" },
		},
		thinkingLevel: "off",
		ctx,
		dependencies: {
			ask: async (thread) => {
				thread.turns.push({ kind: "answered", question: "Q1", answer: "A1", response: assistant });
				return { kind: "answered", response: assistant, answer: "A1" };
			},
			interact: async () => ({ kind: "bringToMain", questionDraft: "" }),
			chooseBringToMain: async () => ({
				kind: "bringToMain",
				draft: "selected draft",
				summary: { lines: 1, messages: 1, tokens: 4 },
			}),
			deliverBringToMain: async (draft, _ctx, summary) => {
				delivered.push({ draft, summary });
				return "loaded";
			},
		},
	});

	assert.deepEqual(result, { kind: "closed" });
	assert.deepEqual(delivered, [
		{
			draft: "selected draft",
			summary: { lines: 1, messages: 1, tokens: 4 },
		},
	]);
	assert.equal(branch.length, 1);
});

test("appending a bring-to-main draft is recommended and reports the concrete outcome", async () => {
	const host = createStandardMenuContext("original editor");
	const running = loadBringToMainDraft("brought context", host.ctx, {
		lines: 1,
		messages: 1,
		tokens: 4,
	});
	await host.tui.waitForOpen();
	assert.match(host.tui.render().join("\n"), /Append after current draft Recommended/);
	host.changeEditor("newer editor");
	host.tui.press("tui.select.confirm");

	assert.equal(await running, "loaded");
	assert.equal(host.editor, "newer editor\n\nbrought context");
	assert.deepEqual(host.notifications, [
		"Appended 1 message (~4 tokens) to the existing main-editor draft. Review and submit when ready.",
	]);
});

test("replace requires destructive confirmation with Back selected first", async () => {
	const host = createStandardMenuContext("original editor");
	const running = loadBringToMainDraft("brought context", host.ctx, {
		lines: 1,
		messages: 1,
		tokens: 4,
	});
	await host.tui.waitForOpen();
	host.tui.press("tui.select.down");
	host.tui.press("tui.select.confirm");
	await host.tui.waitForOpen();
	const confirmation = host.tui.render().join("\n");
	assert.match(confirmation, /→ Back Keep current editor text/);
	assert.match(confirmation, /⚠ Replace current draft Cannot be undone/);
	host.tui.press("tui.select.confirm");
	await host.tui.waitForOpen();
	host.tui.press("tui.select.cancel");

	assert.equal(await running, "back");
	assert.equal(host.editor, "original editor");
});

test("confirmed replace reports the discarded-draft outcome", async () => {
	const host = createStandardMenuContext("original editor");
	const running = loadBringToMainDraft("brought context", host.ctx, {
		lines: 1,
		messages: 2,
		tokens: 4,
	});
	await host.tui.waitForOpen();
	host.tui.press("tui.select.down");
	host.tui.press("tui.select.confirm");
	await host.tui.waitForOpen();
	host.tui.press("tui.select.down");
	host.tui.press("tui.select.confirm");

	assert.equal(await running, "loaded");
	assert.equal(host.editor, "brought context");
	assert.deepEqual(host.notifications, [
		"Replaced the main-editor draft with 2 messages (~4 tokens). Review and submit when ready.",
	]);
});

test("replace re-prompts instead of discarding an editor update made during confirmation", async () => {
	const host = createStandardMenuContext("original editor");
	const running = loadBringToMainDraft("brought context", host.ctx, {
		lines: 1,
		messages: 1,
		tokens: 4,
	});
	await host.tui.waitForOpen();
	host.tui.press("tui.select.down");
	host.tui.press("tui.select.confirm");
	await host.tui.waitForOpen();
	host.changeEditor("concurrent editor update");
	host.tui.press("tui.select.down");
	host.tui.press("tui.select.confirm");
	await host.tui.waitForOpen();
	host.tui.press("tui.select.cancel");

	assert.equal(await running, "back");
	assert.equal(host.editor, "concurrent editor update");
	assert.match(host.notifications[0] ?? "", /changed during confirmation/);
});

test("disposing a bring-to-main standard menu closes without writing through its obsolete context", async () => {
	const tui = createTuiHarness();
	let editor = "original editor";
	const editorWrites: string[] = [];
	const ctx = {
		mode: "tui",
		hasUI: true,
		ui: {
			custom: tui.custom,
			getEditorText: () => editor,
			setEditorText: (text: string) => {
				editorWrites.push(text);
				editor = text;
			},
			notify() {},
		},
	} as never;

	const running = loadBringToMainDraft("brought context", ctx, {
		lines: 1,
		messages: 1,
		tokens: 4,
	});
	await tui.waitForOpen();
	tui.dispose();

	assert.equal(await running, "closed");
	assert.deepEqual(editorWrites, []);
	assert.equal(editor, "original editor");
});

test("empty main editor receives an editable draft with a concrete success message", async () => {
	let editor = "";
	const notifications: string[] = [];
	const ctx = {
		ui: {
			getEditorText: () => editor,
			setEditorText: (text: string) => {
				editor = text;
			},
			notify(message: string) {
				notifications.push(message);
			},
		},
	} as never;

	const result = await loadBringToMainDraft("brought context", ctx, {
		lines: 1,
		messages: 1,
		tokens: 1,
	});

	assert.equal(result, "loaded");
	assert.equal(editor, "brought context");
	assert.deepEqual(notifications, [
		"Brought 1 message (~1 token) to the main editor. Review and submit when ready.",
	]);
});

test("cancelling bring-to-main loading preserves editor updates made while the menu is open", async () => {
	const host = createStandardMenuContext("original editor");
	const running = loadBringToMainDraft("brought context", host.ctx, {
		lines: 1,
		messages: 1,
		tokens: 4,
	});
	await host.tui.waitForOpen();
	host.changeEditor("newer editor");
	host.tui.press("tui.select.cancel");

	assert.equal(await running, "back");
	assert.equal(host.editor, "newer editor");
});

test("empty transcript composer accepts the first side-thread question", () => {
	const actions: unknown[] = [];
	const tui = { terminal: { rows: 24 }, requestRender() {} };
	const theme = {
		fg(_color: string, text: string) {
			return text;
		},
		bold(text: string) {
			return text;
		},
	};
	const composer = new BtwTranscriptPager(tui as never, theme as never, [], (action) =>
		actions.push(action),
	);

	composer.focused = true;
	const emptyLines = composer.render(40);
	const emptyView = emptyLines.join("\n");
	assert.match(emptyLines[0] ?? "", /─ btw · side thread/);
	assert.doesNotMatch(emptyView, /turns|Q1|You:|Assistant:|%|history/);
	assert.match(emptyView, /btw • Enter send • Ctrl\+C exit/);
	assert.equal(emptyView.includes(CURSOR_MARKER), true);
	for (const character of "first question") composer.handleInput(character);
	composer.handleInput("\r");

	assert.deepEqual(actions, [{ kind: "submit", question: "first question" }]);
});

test("transcript cycles its local thinking level with Pi's configured thinking shortcut", () => {
	initTheme("dark");
	const changes: string[] = [];
	const tui = { terminal: { rows: 24 }, requestRender() {} };
	const theme = {
		fg(_color: string, text: string) {
			return text;
		},
		bold(text: string) {
			return text;
		},
	};
	const pager = new BtwTranscriptPager(
		tui as never,
		theme as never,
		[{ question: "Q1", answer: "A1", kind: "answered", response: response("A1") }],
		() => undefined,
		{
			thinking: {
				level: "low",
				levels: ["off", "low", "high"],
				keybindings: keybindings({ "app.thinking.cycle": "t" }) as never,
				onChange: (level) => changes.push(level),
			},
		},
	);

	assert.match(pager.render(80).join("\n"), /thinking low.*T cycle/i);
	pager.handleInput("t");

	assert.deepEqual(changes, ["high"]);
	assert.match(pager.render(80).join("\n"), /thinking high/i);
});

test("disposing the side-thread composer closes it exactly once", () => {
	const actions: unknown[] = [];
	const pager = new BtwTranscriptPager(
		{ terminal: { rows: 24 }, requestRender() {} } as never,
		{
			fg: (_color: string, text: string) => text,
			bold: (text: string) => text,
		} as never,
		[],
		(action) => actions.push(action),
	);
	pager.dispose();
	pager.dispose();
	pager.handleInput("question");

	assert.deepEqual(actions, [{ kind: "close" }]);
});

test("transcript offers opt-in bring-to-main action only after a successful answer", () => {
	initTheme("dark");
	const actions: unknown[] = [];
	const tui = { terminal: { rows: 24 }, requestRender() {} };
	const theme = {
		fg(_color: string, text: string) {
			return text;
		},
		bold(text: string) {
			return text;
		},
	};
	const empty = new BtwTranscriptPager(tui as never, theme as never, [], (action) =>
		actions.push(action),
	);
	empty.handleInput("\u0012");
	assert.doesNotMatch(empty.render(80).join("\n"), /bring to main/i);

	const answered = new BtwTranscriptPager(
		tui as never,
		theme as never,
		[{ question: "Q1", answer: "A1", kind: "answered", response: response("A1") }],
		(action) => actions.push(action),
	);
	assert.match(answered.render(80).join("\n"), /Ctrl\+R bring to main/);
	assert.match(answered.render(40).join("\n"), /Ctrl\+R/);
	assert.match(answered.render(29).join("\n"), /Ctrl\+R/);
	answered.handleInput("\u0012");

	assert.deepEqual(actions, [{ kind: "bringToMain", questionDraft: "" }]);
});

test("bring-to-main preserves expanded large-paste content in the composer draft", () => {
	initTheme("dark");
	const actions: unknown[] = [];
	const tui = { terminal: { rows: 24 }, requestRender() {} };
	const theme = {
		fg(_color: string, text: string) {
			return text;
		},
		bold(text: string) {
			return text;
		},
	};
	const pager = new BtwTranscriptPager(
		tui as never,
		theme as never,
		[{ question: "Q1", answer: "A1", kind: "answered", response: response("A1") }],
		(action) => actions.push(action),
	);
	const pasted = "large paste ".repeat(100);
	pager.handleInput(`\u001b[200~${pasted}\u001b[201~`);
	pager.handleInput("\u0012");

	assert.deepEqual(actions, [{ kind: "bringToMain", questionDraft: pasted }]);
});

test("character ranges preserve a selected newline at the next line start", () => {
	const lines = buildBtwSelectionLines([
		{ question: "foo\nbar", answer: "A", kind: "answered", response: response("A") },
	]);

	assert.deepEqual(segmentsFromTextRange(lines, { line: 0, column: 0 }, { line: 1, column: 0 }), [
		{ role: "user", text: "foo\n" },
	]);
	assert.deepEqual(segmentsFromTextRange(lines, { line: 0, column: 3 }, { line: 1, column: 0 }), [
		{ role: "user", text: "\n" },
	]);
});

test("character ranges treat extended grapheme clusters as single characters", () => {
	const lines = buildBtwSelectionLines([
		{
			question: "e\u0301👍🏽👨‍👩‍👧",
			answer: "A",
			kind: "answered",
			response: response("A"),
		},
	]);

	assert.deepEqual(segmentsFromTextRange(lines, { line: 0, column: 0 }, { line: 0, column: 1 }), [
		{ role: "user", text: "e\u0301" },
	]);
	assert.deepEqual(segmentsFromTextRange(lines, { line: 0, column: 1 }, { line: 0, column: 3 }), [
		{ role: "user", text: "👍🏽👨‍👩‍👧" },
	]);
});

test("character ranges preserve exact text and role boundaries in either direction", () => {
	const lines = buildBtwSelectionLines([
		{ question: "abc", answer: "de\nfgh", kind: "answered", response: response("de\nfgh") },
	]);
	const expected = [
		{ role: "user" as const, text: "bc" },
		{ role: "assistant" as const, text: "de" },
	];

	assert.deepEqual(
		segmentsFromTextRange(lines, { line: 0, column: 1 }, { line: 1, column: 2 }),
		expected,
	);
	assert.deepEqual(
		segmentsFromTextRange(lines, { line: 1, column: 2 }, { line: 0, column: 1 }),
		expected,
	);
});

test("text range selector exposes selection status, non-color markers, and configured actions", () => {
	const actions: unknown[] = [];
	const tui = { terminal: { rows: 10 }, requestRender() {} };
	const theme = {
		fg(_color: string, text: string) {
			return text;
		},
		bg(_color: string, text: string) {
			return text;
		},
		bold(text: string) {
			return text;
		},
	};
	const selector = new BtwTextRangeSelector(
		tui as never,
		theme as never,
		keybindings({
			"tui.select.up": "k",
			"tui.select.down": "j",
			"tui.select.confirm": "y",
			"tui.select.cancel": "q",
		}) as never,
		[{ question: "abc", answer: "de", kind: "answered", response: response("de") }],
		(action) => actions.push(action),
	);

	const empty = selector.render(100).join("\n");
	assert.match(empty, /Select text to bring to main/);
	assert.match(empty, /Selected: none/);
	assert.match(empty, /Y bring.*Q back.*Ctrl\+C close/);
	assert.match(selector.render(40).join("\n"), /Y bring.*Q back.*Ctrl\+C close/);
	selector.handleInput(" ");
	const selected = selector.render(100).join("\n");
	assert.match(selected, /Selected: 1 line · 1 message · ~1 token/);
	assert.match(selected, /●> User/);
	assert.match(selected, /K\/J extend lines/);
});

test("configured confirm bindings take precedence over selector shortcuts", () => {
	const actions: unknown[] = [];
	const selector = new BtwTextRangeSelector(
		{ terminal: { rows: 10 }, requestRender() {} } as never,
		{
			fg: (_color: string, text: string) => text,
			bg: (_color: string, text: string) => text,
			bold: (text: string) => text,
		} as never,
		{
			matches: (data: string, key: string) =>
				key === "tui.select.confirm" ? data === " " : keybindings().matches(data, key),
			getKeys: (key: string) =>
				key === "tui.select.confirm" ? ["space"] : keybindings().getKeys(key),
		} as never,
		[{ question: "abc", answer: "de", kind: "answered", response: response("de") }],
		(action) => actions.push(action),
	);

	selector.handleInput("\u001b[1;2C");
	const rendered = selector.render(100).join("\n");
	assert.match(rendered, /Space bring/);
	assert.doesNotMatch(rendered, /Space (?:lines|clear)/);
	selector.handleInput(" ");

	assert.deepEqual(actions, [{ kind: "confirm", segments: [{ role: "user", text: "a" }] }]);
});

test("text range selector moves like an editor and extends character selection with Shift+Arrows", () => {
	const actions: unknown[] = [];
	const tui = { terminal: { rows: 10 }, requestRender() {} };
	const theme = {
		fg(_color: string, text: string) {
			return text;
		},
		bg(_color: string, text: string) {
			return `[${text}]`;
		},
		bold(text: string) {
			return text;
		},
	};
	const selector = new BtwTextRangeSelector(
		tui as never,
		theme as never,
		keybindings({
			"tui.select.up": "k",
			"tui.select.down": "j",
			"tui.select.confirm": "y",
		}) as never,
		[{ question: "abc", answer: "de", kind: "answered", response: response("de") }],
		(action) => actions.push(action),
	);

	selector.handleInput("j");
	selector.handleInput("k");
	selector.handleInput("\u001b[C");
	selector.handleInput("\u001b[1;2C");
	selector.handleInput("\u001b[1;2C");
	selector.handleInput("\u001b[1;2B");
	const narrow = selector.render(24);
	assert.ok(narrow.every((line) => visibleWidth(line) <= 24));
	assert.match(selector.render(120).join("\n"), /Shift\+Arrows select.*Arrows move.*Y bring.*back/);
	selector.handleInput("y");

	assert.deepEqual(actions, [
		{
			kind: "confirm",
			segments: [
				{ role: "user", text: "bc" },
				{ role: "assistant", text: "de" },
			],
		},
	]);
});

test("Shift+Arrow selects one complete grapheme cluster", () => {
	const actions: unknown[] = [];
	const tui = { terminal: { rows: 10 }, requestRender() {} };
	const theme = {
		fg(_color: string, text: string) {
			return text;
		},
		bg(_color: string, text: string) {
			return text;
		},
		bold(text: string) {
			return text;
		},
	};
	const selector = new BtwTextRangeSelector(
		tui as never,
		theme as never,
		keybindings({ "tui.select.confirm": "y" }) as never,
		[{ question: "e\u0301👍🏽", answer: "A", kind: "answered", response: response("A") }],
		(action) => actions.push(action),
	);

	selector.handleInput("\u001b[1;2C");
	selector.handleInput("y");

	assert.deepEqual(actions, [{ kind: "confirm", segments: [{ role: "user", text: "e\u0301" }] }]);
});

test("text range selector uses Space to select and extend whole raw lines", () => {
	const actions: unknown[] = [];
	const tui = { terminal: { rows: 10 }, requestRender() {} };
	const theme = {
		fg(_color: string, text: string) {
			return text;
		},
		bg(_color: string, text: string) {
			return `[${text}]`;
		},
		bold(text: string) {
			return text;
		},
	};
	const selector = new BtwTextRangeSelector(
		tui as never,
		theme as never,
		keybindings({ "tui.select.down": "j", "tui.select.confirm": "y" }) as never,
		[
			{
				question: "one\ntwo",
				answer: "three",
				kind: "answered",
				response: response("three"),
			},
		],
		(action) => actions.push(action),
	);

	selector.handleInput(" ");
	selector.handleInput("j");
	selector.handleInput("j");
	assert.match(selector.render(120).join("\n"), /Space clear.*extend lines/);
	selector.handleInput("y");

	assert.deepEqual(actions, [
		{
			kind: "confirm",
			segments: [
				{ role: "user", text: "one\ntwo" },
				{ role: "assistant", text: "three" },
			],
		},
	]);
});

test("Shift+Arrow switches a Space line selection to character selection", () => {
	const actions: unknown[] = [];
	const tui = { terminal: { rows: 10 }, requestRender() {} };
	const theme = {
		fg(_color: string, text: string) {
			return text;
		},
		bg(_color: string, text: string) {
			return text;
		},
		bold(text: string) {
			return text;
		},
	};
	const selector = new BtwTextRangeSelector(
		tui as never,
		theme as never,
		keybindings({ "tui.select.confirm": "y" }) as never,
		[{ question: "one", answer: "three", kind: "answered", response: response("three") }],
		(action) => actions.push(action),
	);

	selector.handleInput(" ");
	selector.handleInput(" ");
	selector.handleInput("y");
	assert.deepEqual(actions, []);
	selector.handleInput(" ");
	selector.handleInput("\u001b[1;2C");
	selector.handleInput("y");

	assert.deepEqual(actions, [{ kind: "confirm", segments: [{ role: "user", text: "o" }] }]);
});

test("text range selector keeps a horizontally moved character cursor visible", () => {
	const tui = { terminal: { rows: 10 }, requestRender() {} };
	const theme = {
		fg(_color: string, text: string) {
			return text;
		},
		bg(_color: string, text: string) {
			return text;
		},
		bold(text: string) {
			return text;
		},
	};
	const selector = new BtwTextRangeSelector(
		tui as never,
		theme as never,
		keybindings() as never,
		[{ question: "0123456789ABCDEFGHIJ", answer: "A", kind: "answered", response: response("A") }],
		() => undefined,
	);
	for (let index = 0; index < 18; index += 1) selector.handleInput("\u001b[C");
	const rendered = selector.render(24);

	assert.ok(rendered.every((line) => visibleWidth(line) <= 24));
	assert.match(rendered.join("\n"), /….*│I/);
});

test("text range selector measures terminal cells to keep a CJK cursor visible", () => {
	const tui = { terminal: { rows: 10 }, requestRender() {} };
	const theme = {
		fg(_color: string, text: string) {
			return text;
		},
		bg(_color: string, text: string) {
			return text;
		},
		bold(text: string) {
			return text;
		},
	};
	const selector = new BtwTextRangeSelector(
		tui as never,
		theme as never,
		keybindings() as never,
		[{ question: "界".repeat(12), answer: "A", kind: "answered", response: response("A") }],
		() => undefined,
	);
	for (let index = 0; index < 10; index += 1) selector.handleInput("\u001b[C");
	const rendered = selector.render(24);

	assert.ok(rendered.every((line) => visibleWidth(line) <= 24));
	assert.match(rendered.find((line) => line.includes("User")) ?? "", /│/);
});

test("text range selector distinguishes back from closing the side thread", () => {
	const actions: unknown[] = [];
	const tui = { terminal: { rows: 10 }, requestRender() {} };
	const theme = {
		fg(_color: string, text: string) {
			return text;
		},
		bg(_color: string, text: string) {
			return text;
		},
		bold(text: string) {
			return text;
		},
	};
	const turns = [
		{ question: "Q", answer: "A", kind: "answered" as const, response: response("A") },
	];
	const customKeys = keybindings({ "tui.select.cancel": "q" });
	new BtwTextRangeSelector(tui as never, theme as never, customKeys as never, turns, (action) =>
		actions.push(action),
	).handleInput("q");
	new BtwTextRangeSelector(tui as never, theme as never, customKeys as never, turns, (action) =>
		actions.push(action),
	).handleInput("\u0003");

	assert.deepEqual(actions, [{ kind: "back" }, { kind: "close" }]);
});

test("text range selector scrolls raw lines and escapes controls in its display", () => {
	const tui = { terminal: { rows: 8 }, requestRender() {} };
	const theme = {
		fg(_color: string, text: string) {
			return text;
		},
		bg(_color: string, text: string) {
			return text;
		},
		bold(text: string) {
			return text;
		},
	};
	const answer = Array.from({ length: 20 }, (_, index) =>
		index === 19 ? "latest\u001b[2J" : `line ${index + 1}`,
	).join("\n");
	const selector = new BtwTextRangeSelector(
		tui as never,
		theme as never,
		keybindings() as never,
		[{ question: "Q", answer, kind: "answered", response: response(answer) }],
		() => undefined,
	);
	for (let index = 0; index < 20; index += 1) selector.handleInput("\u001b[B");
	const rendered = selector.render(60).join("\n");

	assert.match(rendered, /latest\\x1b\[2J/);
	assert.equal(rendered.includes("\u001b[2J"), false);
});

test("side-thread header and footer remain visible when the editor grows", () => {
	initTheme("dark");
	const tui = { terminal: { rows: 10 }, requestRender() {} };
	const theme = {
		fg(_color: string, text: string) {
			return text;
		},
		bold(text: string) {
			return text;
		},
	};
	const composer = new BtwTranscriptPager(tui as never, theme as never, [], () => undefined);
	composer.focused = true;
	for (const character of "long input ".repeat(30)) composer.handleInput(character);
	const rendered = composer.render(20);

	assert.match(rendered[0] ?? "", /btw/);
	assert.match(rendered.join("\n"), /Ctrl\+C/);
	assert.equal(rendered.join("\n").includes(CURSOR_MARKER), true);
	assert.ok(rendered.length <= tui.terminal.rows - 3);
});

test("constrained composer keeps an earlier editor cursor visible", () => {
	initTheme("dark");
	const tui = { terminal: { rows: 10 }, requestRender() {} };
	const theme = {
		fg(_color: string, text: string) {
			return text;
		},
		bold(text: string) {
			return text;
		},
	};
	const composer = new BtwTranscriptPager(tui as never, theme as never, [], () => undefined);
	composer.focused = true;
	const text = Array.from({ length: 10 }, (_, index) => `line ${index + 1}`).join("\n");
	composer.handleInput(`\u001b[200~${text}\u001b[201~`);
	for (let index = 0; index < 9; index += 1) composer.handleInput("\u001b[A");

	const rendered = composer.render(20).join("\n");
	assert.equal(rendered.includes(CURSOR_MARKER), true);
	assert.match(rendered, /Ctrl\+C/);
});

test("side-thread header stays fixed across narrow renders and history scrolling", () => {
	initTheme("dark");
	const tui = { terminal: { rows: 10 }, requestRender() {} };
	const theme = {
		fg(_color: string, text: string) {
			return text;
		},
		bold(text: string) {
			return text;
		},
	};
	const answer = Array.from({ length: 20 }, (_, index) => `line ${index + 1}`).join("\n");
	const pager = new BtwTranscriptPager(
		tui as never,
		theme as never,
		[{ question: "question", answer, kind: "answered", response: response(answer) }],
		() => undefined,
		{ startAtBottom: true },
	);

	const initial = pager.render(80);
	pager.handleInput("\u001b[5~");
	const scrolled = pager.render(80);
	const narrow = pager.render(8);
	assert.match(initial[0] ?? "", /─ btw · side thread/);
	assert.match(scrolled[0] ?? "", /─ btw · side thread/);
	assert.match(narrow[0] ?? "", /btw/);
	assert.ok(narrow.every((line) => visibleWidth(line) <= 8));
});

test("side-thread header is presentation-only", () => {
	initTheme("dark");
	const tui = { terminal: { rows: 24 }, requestRender() {} };
	const theme = {
		fg(_color: string, text: string) {
			return text;
		},
		bold(text: string) {
			return text;
		},
	};
	const thread = createSideThread("main context");
	thread.turns.push({
		question: "previous question",
		answer: "previous answer",
		kind: "answered",
		response: response("previous answer"),
	});
	const snapshot = structuredClone(thread.turns);
	const pager = new BtwTranscriptPager(tui as never, theme as never, thread.turns, () => undefined);

	assert.match(pager.render(80)[0] ?? "", /btw · side thread/);
	assert.deepEqual(thread.turns, snapshot);
	assert.doesNotMatch(
		JSON.stringify(buildSideThreadMessages(thread, "next question")),
		/side thread/,
	);
});

test("transcript pager starts later turns at the bottom and respects narrow widths", () => {
	initTheme("dark");
	const tui = { terminal: { rows: 10 }, requestRender() {} };
	const theme = {
		fg(_color: string, text: string) {
			return text;
		},
		bold(text: string) {
			return text;
		},
	};
	const longAnswer = Array.from({ length: 30 }, (_, index) => `line ${index + 1}`).join("\n");
	const turns = [
		{
			question: "Q1",
			answer: longAnswer,
			kind: "answered" as const,
			response: response(longAnswer),
		},
	];
	const pager = new BtwTranscriptPager(tui as never, theme as never, turns, () => undefined, {
		startAtBottom: true,
	});
	const lines = pager.render(20);

	assert.ok(lines.every((line) => visibleWidth(line) <= 20));
	assert.ok(lines.length <= tui.terminal.rows - 3);
	assert.doesNotMatch(lines.join("\n"), /Q1|You:|Assistant:|turns|%|history/);
	assert.match(lines.join("\n"), /btw.*Enter.*Ctrl\+C/);
});

test("scrollable transcript reveals history controls only when they are useful", () => {
	initTheme("dark");
	const tui = { terminal: { rows: 10 }, requestRender() {} };
	const theme = {
		fg(_color: string, text: string) {
			return text;
		},
		bold(text: string) {
			return text;
		},
	};
	const answer = Array.from({ length: 20 }, (_, index) => `line ${index + 1}`).join("\n");
	const composer = new BtwTranscriptPager(
		tui as never,
		theme as never,
		[{ question: "question", answer, kind: "answered", response: response(answer) }],
		() => undefined,
		{ startAtBottom: true },
	);

	const rendered = composer.render(80).join("\n");
	assert.match(rendered, /↑ older.*PgUp\/PgDn history/);
	const compact = composer.render(40).join("\n");
	assert.match(compact, /Ctrl\+R/);
	assert.match(compact, /PgUp\/PgDn/);
});

test("transcript honors an explicit top start on its first render", () => {
	initTheme("dark");
	const tui = { terminal: { rows: 10 }, requestRender() {} };
	const theme = {
		fg(_color: string, text: string) {
			return text;
		},
		bold(text: string) {
			return text;
		},
	};
	const answer = Array.from({ length: 20 }, (_, index) => `line ${index + 1}`).join("\n");
	const composer = new BtwTranscriptPager(
		tui as never,
		theme as never,
		[{ question: "FIRST QUESTION", answer, kind: "answered", response: response(answer) }],
		() => undefined,
	);
	const rendered = composer.render(80).join("\n");

	assert.match(rendered, /FIRST QUESTION/);
	assert.doesNotMatch(rendered, /line 20/);
});

test("transcript keeps following the bottom when PageUp has no scrollback", () => {
	initTheme("dark");
	const tui = { terminal: { rows: 100 }, requestRender() {} };
	const theme = {
		fg(_color: string, text: string) {
			return text;
		},
		bold(text: string) {
			return text;
		},
	};
	const answer = `EARLIEST ${"middle content ".repeat(20)}LATEST`;
	const composer = new BtwTranscriptPager(
		tui as never,
		theme as never,
		[{ question: "question", answer, kind: "answered", response: response(answer) }],
		() => undefined,
		{ startAtBottom: true },
	);
	composer.render(80);
	composer.handleInput("\u001b[5~");
	tui.terminal.rows = 10;

	assert.match(composer.render(20).join("\n"), /LATEST/);
});

test("transcript preserves an intentional scroll position across fit and reflow", () => {
	initTheme("dark");
	const tui = { terminal: { rows: 10 }, requestRender() {} };
	const theme = {
		fg(_color: string, text: string) {
			return text;
		},
		bold(text: string) {
			return text;
		},
	};
	const answer = `EARLIEST ${"middle content ".repeat(20)}LATEST`;
	const composer = new BtwTranscriptPager(
		tui as never,
		theme as never,
		[{ question: "question", answer, kind: "answered", response: response(answer) }],
		() => undefined,
		{ startAtBottom: true },
	);
	composer.render(20);
	for (let index = 0; index < 20; index += 1) composer.handleInput("\u001b[5~");
	tui.terminal.rows = 100;
	composer.render(80);
	tui.terminal.rows = 10;
	const reflowed = composer.render(20).join("\n");

	assert.doesNotMatch(reflowed, /LATEST/);
});

test("transcript stays anchored to the latest answer when terminal width changes", () => {
	initTheme("dark");
	const tui = { terminal: { rows: 10 }, requestRender() {} };
	const theme = {
		fg(_color: string, text: string) {
			return text;
		},
		bold(text: string) {
			return text;
		},
	};
	const answer = `${"reflow content ".repeat(20)}LATEST`;
	const composer = new BtwTranscriptPager(
		tui as never,
		theme as never,
		[{ question: "question", answer, kind: "answered", response: response(answer) }],
		() => undefined,
		{ startAtBottom: true },
	);

	assert.match(composer.render(80).join("\n"), /LATEST/);
	assert.match(composer.render(20).join("\n"), /LATEST/);
});

test("answering view keeps following the bottom when PageUp has no scrollback", () => {
	initTheme("dark");
	const tui = { terminal: { rows: 100 }, requestRender() {} };
	const theme = {
		fg(_color: string, text: string) {
			return text;
		},
		bold(text: string) {
			return text;
		},
	};
	const answer = `EARLIEST ${"middle content ".repeat(20)}LATEST`;
	const view = new BtwAnsweringView(
		tui as never,
		theme as never,
		[{ question: "Earlier question", answer, kind: "answered", response: response(answer) }],
		"CURRENT QUESTION",
		() => undefined,
	);
	try {
		view.render(80);
		view.handleInput("\u001b[5~");
		tui.terminal.rows = 10;
		assert.match(view.render(20).join("\n"), /CURRENT QUESTION/);
	} finally {
		view.dispose();
	}
});

test("answering view preserves an intentional scroll position across fit and reflow", () => {
	initTheme("dark");
	const tui = { terminal: { rows: 10 }, requestRender() {} };
	const theme = {
		fg(_color: string, text: string) {
			return text;
		},
		bold(text: string) {
			return text;
		},
	};
	const answer = `EARLIEST ${"middle content ".repeat(20)}LATEST`;
	const view = new BtwAnsweringView(
		tui as never,
		theme as never,
		[{ question: "Earlier question", answer, kind: "answered", response: response(answer) }],
		"CURRENT QUESTION",
		() => undefined,
	);
	try {
		view.render(20);
		for (let index = 0; index < 20; index += 1) view.handleInput("\u001b[5~");
		tui.terminal.rows = 100;
		view.render(80);
		tui.terminal.rows = 10;
		const reflowed = view.render(20).join("\n");
		assert.doesNotMatch(reflowed, /CURRENT QUESTION/);
	} finally {
		view.dispose();
	}
});

test("answering view preserves the transcript and offers compact cancellation", () => {
	initTheme("dark");
	const tui = { terminal: { rows: 24 }, requestRender() {} };
	const theme = {
		fg(_color: string, text: string) {
			return text;
		},
		bold(text: string) {
			return text;
		},
	};
	let cancelled = 0;
	const view = new BtwAnsweringView(
		tui as never,
		theme as never,
		[
			{
				question: "Earlier question",
				answer: "Earlier answer",
				kind: "answered",
				response: response("Earlier answer"),
			},
		],
		"Current question",
		() => {
			cancelled += 1;
		},
	);
	try {
		const rendered = view.render(80).join("\n");
		assert.match(rendered, /─ btw · side thread/);
		assert.match(rendered, /Earlier question/);
		assert.match(rendered, /Earlier answer/);
		assert.match(rendered, /Current question/);
		assert.match(rendered, /Answering….*Ctrl\+C cancel/);
		assert.doesNotMatch(rendered, /openai|codex|provider|model/i);
		view.handleInput("\u0003");
		assert.equal(cancelled, 1);
		assert.equal(view.signal.aborted, true);
	} finally {
		view.dispose();
	}
});

test("disposing an answering view aborts and closes it exactly once", () => {
	initTheme("dark");
	let cancelled = 0;
	const view = new BtwAnsweringView(
		{ terminal: { rows: 24 }, requestRender() {} } as never,
		{
			fg: (_color: string, text: string) => text,
			bold: (text: string) => text,
		} as never,
		[],
		"question",
		() => {
			cancelled += 1;
		},
	);
	view.dispose();
	view.dispose();

	assert.equal(cancelled, 1);
	assert.equal(view.signal.aborted, true);
});

test("answering view never exceeds the available height in a short terminal", () => {
	initTheme("dark");
	const tui = { terminal: { rows: 4 }, requestRender() {} };
	const theme = {
		fg(_color: string, text: string) {
			return text;
		},
		bold(text: string) {
			return text;
		},
	};
	const view = new BtwAnsweringView(tui as never, theme as never, [], "question", () => undefined);

	try {
		assert.ok(view.render(40).length <= tui.terminal.rows - 3);
	} finally {
		view.dispose();
	}
});

test("answering view keeps the pending question visible after terminal reflow", () => {
	initTheme("dark");
	const tui = { terminal: { rows: 10 }, requestRender() {} };
	const theme = {
		fg(_color: string, text: string) {
			return text;
		},
		bold(text: string) {
			return text;
		},
	};
	const answer = "earlier content ".repeat(20);
	const view = new BtwAnsweringView(
		tui as never,
		theme as never,
		[{ question: "Earlier question", answer, kind: "answered", response: response(answer) }],
		"CURRENT QUESTION",
		() => undefined,
	);

	try {
		assert.match(view.render(80).join("\n"), /CURRENT QUESTION/);
		assert.match(view.render(20).join("\n"), /CURRENT QUESTION/);
	} finally {
		view.dispose();
	}
});

test("transcript renders like a plain conversation without role labels", () => {
	initTheme("dark");
	const tui = { terminal: { rows: 24 }, requestRender() {} };
	const theme = {
		fg(_color: string, text: string) {
			return text;
		},
		bold(text: string) {
			return text;
		},
	};
	const composer = new BtwTranscriptPager(
		tui as never,
		theme as never,
		[
			{
				question: "How does this work?",
				answer: "It uses the current context.",
				kind: "answered",
				response: response("It uses the current context."),
			},
		],
		() => undefined,
	);
	const rendered = composer.render(60).join("\n");

	assert.match(rendered, /How does this work\?/);
	assert.match(rendered, /It uses the current context\./);
	assert.doesNotMatch(rendered, /Q1|You:|Assistant:|turns|%/);
	assert.equal(rendered.includes("\u001b]133;"), false);
});

test("side transcript escapes executable terminal controls", () => {
	const formatted = formatSideTranscript([
		{
			question: "question\u001b]52;c;ZXZpbA==\u0007",
			answer: "answer\u001b[2J",
			kind: "answered",
			response: response("answer"),
		},
	]);

	assert.equal(formatted.includes("\u001b"), false);
	assert.equal(formatted.includes("\u0007"), false);
	assert.equal(formatted.includes("\\x1b"), true);
	assert.doesNotMatch(formatted, /Q1|---|You:|Assistant:/);
	assert.equal(formatted, "question\\x1b]52;c;ZXZpbA==\\x07\n\nanswer\\x1b[2J");
});

test("transcript composer submits typed questions by default and only Ctrl+C closes it", () => {
	const actions: unknown[] = [];
	const tui = { terminal: { rows: 24 }, requestRender() {} };
	const theme = {
		fg(_color: string, text: string) {
			return text;
		},
		bold(text: string) {
			return text;
		},
	};
	const turns = [
		{ question: "Q1", answer: "A1", kind: "answered" as const, response: response("A1") },
	];

	const composer = new BtwTranscriptPager(tui as never, theme as never, turns, (action) =>
		actions.push(action),
	);
	composer.handleInput("q");
	composer.handleInput("\x1b");
	composer.handleInput("f");
	composer.handleInput("\r");

	const close = new BtwTranscriptPager(tui as never, theme as never, turns, (action) =>
		actions.push(action),
	);
	close.handleInput("\u0003");

	const blank = new BtwTranscriptPager(tui as never, theme as never, turns, (action) =>
		actions.push(action),
	);
	blank.handleInput("\r");
	const blankWarning = blank.render(60).join("\n");
	assert.match(blankWarning, /cannot be empty/i);
	assert.match(blankWarning, /Ctrl\+C exit/);
	assert.match(blank.render(20).join("\n"), /Empty.*Ctrl\+C/);

	assert.deepEqual(actions, [{ kind: "submit", question: "qf" }, { kind: "close" }]);
});

test("side-thread steering drains queued questions one at a time before reopening the composer", async () => {
	const branch = [{ type: "message", message: { role: "user", content: "main" } }];
	const questions: string[] = [];
	const thinkingLevels: string[] = [];
	let interactions = 0;
	const result = await runBtwThread({
		initialQuestion: "Q1",
		selected: {
			model: { provider: "test", id: "side", reasoning: true } as Model<Api>,
			auth: { apiKey: "key" },
		},
		thinkingLevel: "low",
		ctx: {
			ui: { notify() {} },
			sessionManager: { getBranch: () => branch },
		} as never,
		dependencies: {
			ask: (async (
				thread: SideThread,
				question: string,
				_selected: ResolvedBtwModel,
				thinkingLevel: string,
				_ctx: unknown,
				steering: {
					submit(question: string): void;
					thinking: { onChange(level: "high"): void };
				},
			) => {
				questions.push(question);
				thinkingLevels.push(thinkingLevel);
				if (question === "Q1") {
					steering.submit("Q2");
					steering.submit("Q3");
					steering.thinking.onChange("high");
				}
				const assistant = response(`A${questions.length}`);
				thread.turns.push({
					kind: "answered",
					question,
					answer: `A${questions.length}`,
					response: assistant,
				});
				return {
					kind: "answered",
					response: assistant,
					answer: `A${questions.length}`,
				};
			}) as never,
			interact: async () => {
				interactions += 1;
				return { kind: "close" };
			},
		},
	});

	assert.deepEqual(result, { kind: "closed" });
	assert.deepEqual(questions, ["Q1", "Q2", "Q3"]);
	assert.deepEqual(thinkingLevels, ["low", "high", "high"]);
	assert.equal(interactions, 1);
	assert.deepEqual(branch, [{ type: "message", message: { role: "user", content: "main" } }]);
});

test("side-thread steering continues after the active answer fails", async () => {
	const asked: string[] = [];
	let interactions = 0;
	const result = await runBtwThread({
		initialQuestion: "Q1",
		selected: {
			model: { provider: "test", id: "side" } as Model<Api>,
			auth: { apiKey: "key" },
		},
		thinkingLevel: "off",
		ctx: {
			ui: { notify() {} },
			sessionManager: { getBranch: () => [] },
		} as never,
		dependencies: {
			ask: (async (
				thread: SideThread,
				question: string,
				_selected: ResolvedBtwModel,
				_level: string,
				_ctx: unknown,
				steering: { submit(question: string): void },
			) => {
				asked.push(question);
				if (question === "Q1") {
					steering.submit("recover with Q2");
					return { kind: "error", message: "first answer failed" };
				}
				const assistant = response("recovered");
				thread.turns.push({
					kind: "answered",
					question,
					answer: "recovered",
					response: assistant,
				});
				return { kind: "answered", response: assistant, answer: "recovered" };
			}) as never,
			interact: async () => {
				interactions += 1;
				return { kind: "close" };
			},
		},
	});

	assert.deepEqual(result, { kind: "closed" });
	assert.deepEqual(asked, ["Q1", "recover with Q2"]);
	assert.equal(interactions, 1);
});

test("cancelling an active answer discards its side-thread steering queue", async () => {
	const asked: string[] = [];
	let interactions = 0;
	const result = await runBtwThread({
		initialQuestion: "Q1",
		selected: {
			model: { provider: "test", id: "side" } as Model<Api>,
			auth: { apiKey: "key" },
		},
		thinkingLevel: "off",
		ctx: {
			ui: { notify() {} },
			sessionManager: { getBranch: () => [] },
		} as never,
		dependencies: {
			ask: (async (
				_thread: SideThread,
				question: string,
				_selected: ResolvedBtwModel,
				_level: string,
				_ctx: unknown,
				steering: { submit(question: string): void },
			) => {
				asked.push(question);
				steering.submit("must be discarded");
				return { kind: "aborted" };
			}) as never,
			interact: async () => {
				interactions += 1;
				return { kind: "close" };
			},
		},
	});

	assert.deepEqual(result, { kind: "closed" });
	assert.deepEqual(asked, ["Q1"]);
	assert.equal(interactions, 0);
});

test("answering view accepts Pi-style steering while preserving IME focus and expanded paste", () => {
	initTheme("dark");
	const queued: string[] = [];
	const changes: string[] = [];
	const tui = { terminal: { rows: 24 }, requestRender() {} };
	const theme = {
		fg(_color: string, text: string) {
			return text;
		},
		bold(text: string) {
			return text;
		},
	};
	const view = new BtwAnsweringView(
		tui as never,
		theme as never,
		[],
		"Current question",
		() => undefined,
		"low",
		{
			steering: {
				questions: queued,
				onSubmit: (question) => queued.push(question),
				thinking: {
					level: "low",
					levels: ["low", "high"],
					keybindings: keybindings({ "app.thinking.cycle": "t" }) as never,
					onChange: (level) => changes.push(level),
				},
			},
		},
	);
	try {
		view.focused = true;
		assert.equal(view.render(80).join("\n").includes(CURSOR_MARKER), true);
		const pasted = "steering paste ".repeat(100);
		view.handleInput(`\u001b[200~${pasted}\u001b[201~`);
		view.handleInput("\r");
		view.handleInput("second steering");
		view.handleInput("\r");
		view.handleInput("t");

		assert.deepEqual(queued, [pasted.trim(), "second steering"]);
		assert.deepEqual(changes, ["high"]);
		const rendered = view.render(100).join("\n");
		assert.match(rendered, /Steering: steering paste/);
		assert.ok(rendered.indexOf("steering paste") < rendered.indexOf("second steering"));
		assert.match(rendered, /Answering….*Enter steer.*Ctrl\+C cancel/);
		assert.match(rendered, /thinking high/i);
	} finally {
		view.dispose();
	}
});

test("answering steering rejects blank questions and bounds unsafe queue display", () => {
	initTheme("dark");
	const queued = [
		"first\u001b]52;c;ZXZpbA==\u0007 steering",
		"second steering",
		"third steering",
		"fourth steering",
	];
	let cancelled = 0;
	const tui = { terminal: { rows: 9 }, requestRender() {} };
	const theme = {
		fg(_color: string, text: string) {
			return text;
		},
		bold(text: string) {
			return text;
		},
	};
	const view = new BtwAnsweringView(
		tui as never,
		theme as never,
		[],
		"Current question",
		() => {
			cancelled += 1;
		},
		"off",
		{
			steering: {
				questions: queued,
				onSubmit: (question) => queued.push(question),
			},
		},
	);
	view.focused = true;
	view.handleInput("   ");
	view.handleInput("\r");
	const rendered = view.render(28);
	assert.match(rendered.join("\n"), /cannot be empty|Empty/i);
	assert.equal(rendered.join("\n").includes("\u001b]52"), false);
	assert.match(rendered.join("\n"), /more/i);
	assert.ok(rendered.every((line) => visibleWidth(line) <= 28));
	assert.ok(rendered.length <= tui.terminal.rows - 3);
	view.handleInput("\u0003");
	view.dispose();
	assert.equal(cancelled, 1);
	assert.equal(view.signal.aborted, true);
});
