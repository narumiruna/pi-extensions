import assert from "node:assert/strict";
import test from "node:test";
import type {
	Api,
	AssistantMessage,
	Context,
	Model,
	SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { CURSOR_MARKER, visibleWidth } from "@earendil-works/pi-tui";
import { type ResolvedBtwModel, runBtwThread } from "../src/btw.js";
import {
	buildSideThreadMessages,
	completeSideThreadTurn,
	createSideThread,
	type SideThread,
} from "../src/side-thread.js";
import { BtwTranscriptPager, formatSideTranscript } from "../src/transcript-pager.js";

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

	await runBtwThread({
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
		model: { provider: "test", id: "side" } as Model<Api>,
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
	const emptyView = composer.render(40).join("\n");
	assert.doesNotMatch(emptyView, /turns|Q1|You:|Assistant:|%/);
	assert.match(emptyView, /Enter send.*Ctrl\+C exit/);
	assert.equal(emptyView.includes(CURSOR_MARKER), true);
	for (const character of "first question") composer.handleInput(character);
	composer.handleInput("\r");

	assert.deepEqual(actions, [{ kind: "submit", question: "first question" }]);
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
	assert.doesNotMatch(lines.join("\n"), /Q1|You:|Assistant:|turns|%/);
	assert.match(lines.join("\n"), /Enter.*Ctrl\+C/);
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
	assert.match(blank.render(40).join("\n"), /cannot be empty/i);

	assert.deepEqual(actions, [{ kind: "submit", question: "qf" }, { kind: "close" }]);
});
