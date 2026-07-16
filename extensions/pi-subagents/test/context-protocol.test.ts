import assert from "node:assert/strict";
import test from "node:test";
import { buildContextSnapshot, redactPrivateText } from "../src/context.js";
import { DEFAULT_MAX_CONTEXT_BYTES, truncateUtf8, truncateUtf8Tail } from "../src/limits.js";
import { JsonLineDecoder } from "../src/protocol.js";
import type { ManagedAgent } from "../src/registry.js";
import { buildFanInContext, mapWithConcurrencyLimit } from "../src/runner.js";
import { buildStatefulTurnPrompt, resolveStatefulTurnTimeout } from "../src/stateful.js";

function record(overrides: Partial<ManagedAgent> = {}): ManagedAgent {
	return {
		id: "sa_test",
		agent: "scout",
		rootId: "sa_test",
		depth: 0,
		children: [],
		state: "completed",
		createdAt: 1,
		updatedAt: Date.now(),
		cwd: process.cwd(),
		history: [],
		mailbox: [],
		...overrides,
	};
}

test("JsonLineDecoder handles fragmented, malformed, trailing, and oversized lines", () => {
	const values: unknown[] = [];
	const malformed: string[] = [];
	const oversized: number[] = [];
	const decoder = new JsonLineDecoder({
		maxLineBytes: 16,
		onValue: (value) => values.push(value),
		onMalformed: (line) => malformed.push(line),
		onOversized: (bytes) => oversized.push(bytes),
	});
	decoder.push('{"ok":');
	decoder.push("1}\nnot-json\n");
	decoder.push("x".repeat(17));
	decoder.push('\n{"tail":2}');
	decoder.finish();
	assert.deepEqual(values, [{ ok: 1 }, { tail: 2 }]);
	assert.deepEqual(malformed, ["not-json"]);
	assert.equal(oversized.length, 1);

	const unicodeValues: unknown[] = [];
	const unicodeDecoder = new JsonLineDecoder({ onValue: (value) => unicodeValues.push(value) });
	const unicodeLine = Buffer.from('{"text":"界"}\n');
	const characterStart = unicodeLine.indexOf(Buffer.from("界"));
	unicodeDecoder.push(unicodeLine.subarray(0, characterStart + 1));
	unicodeDecoder.push(unicodeLine.subarray(characterStart + 1));
	unicodeDecoder.finish();
	assert.deepEqual(unicodeValues, [{ text: "界" }]);
	assert.throws(
		() => new JsonLineDecoder({ maxLineBytes: Number.NaN, onValue: () => undefined }),
		/positive safe integer/,
	);
});

test("UTF-8 and fan-in truncation are bounded and marked", () => {
	const bounded = truncateUtf8("界".repeat(100), 80);
	assert.ok(Buffer.byteLength(bounded.text) <= 80);
	assert.equal(bounded.truncated, true);
	assert.doesNotMatch(bounded.text, /�/);
	const tail = truncateUtf8Tail(`old-${"界".repeat(100)}-new`, 80);
	assert.ok(Buffer.byteLength(tail.text) <= 80);
	assert.doesNotMatch(tail.text, /�/);
	assert.match(tail.text, /-new$/);
	assert.deepEqual(truncateUtf8("value", Number.NaN), {
		text: "",
		truncated: true,
		originalBytes: 5,
	});
	assert.equal(truncateUtf8("value", Number.POSITIVE_INFINITY).text, "value");
	const fanIn = buildFanInContext([
		{
			...record(),
			agentSource: "built-in",
			task: "large",
			exitCode: 0,
			messages: [],
			stderr: "",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				cost: 0,
				contextTokens: 0,
				turns: 0,
			},
			finalOutput: "x".repeat(DEFAULT_MAX_CONTEXT_BYTES),
		},
	]);
	assert.ok(Buffer.byteLength(fanIn) <= DEFAULT_MAX_CONTEXT_BYTES);
	assert.match(fanIn, /truncated/);
});

test("context snapshots keep only user/assistant text, recent turns, and redact private content", () => {
	const snapshot = buildContextSnapshot(
		[
			{ type: "message", message: { role: "user", content: [{ type: "text", text: "old" }] } },
			{
				type: "message",
				message: { role: "toolResult", content: [{ type: "text", text: "secret tool output" }] },
			},
			{
				type: "message",
				message: {
					role: "assistant",
					content: [
						{ type: "thinking", thinking: "hidden" },
						{ type: "text", text: "answer" },
					],
				},
			},
			{
				type: "message",
				message: {
					role: "user",
					content: [{ type: "text", text: "new\n[subagent-private] token" }],
				},
			},
		],
		1,
	);
	assert.doesNotMatch(snapshot.text, /old|tool output|hidden|token/);
	assert.match(snapshot.text, /new/);
	assert.equal(snapshot.turns, 1);
	assert.equal(redactPrivateText("a<private>secret</private>b"), "a[private content omitted]b");
	assert.equal(
		redactPrivateText("a<private>outer<private>inner</private>tail</private>b"),
		"a[private content omitted]b",
	);
	assert.equal(redactPrivateText("a<private>unterminated"), "a[private content omitted]");

	const selected = buildContextSnapshot(
		[
			{ id: "one", type: "message", message: { role: "user", content: "omit" } },
			{ id: "two", type: "message", message: { role: "user", content: "keep" } },
		],
		"summary",
		1_000,
		["two"],
	);
	assert.equal(selected.text, "## user\nkeep");
	assert.deepEqual(selected.sourceIds, ["two"]);

	const deduplicated = buildContextSnapshot(
		[
			{ id: "same", type: "message", message: { role: "user", content: "first" } },
			{ id: "same", type: "message", message: { role: "user", content: "duplicate" } },
		],
		"all",
	);
	assert.equal(deduplicated.text, "## user\nfirst");
	assert.deepEqual(deduplicated.sourceIds, ["same"]);

	const summarized = buildContextSnapshot(
		[
			...Array.from({ length: 5 }, (_, index) => ({
				id: `old-${index}`,
				type: "message",
				message: { role: index % 2 ? "assistant" : "user", content: "old".repeat(50) },
			})),
			{
				id: "latest",
				type: "message",
				message: { role: "assistant", content: `${"new".repeat(50)}LATEST_END` },
			},
		],
		"summary",
		100,
	);
	assert.ok(Buffer.byteLength(summarized.text) <= 100);
	assert.match(summarized.text, /LATEST_END$/);
});

test("stateful follow-up prompts redact retained history and honor global timeout", () => {
	const originalTimeout = process.env.PI_SUBAGENT_TIMEOUT_MS;
	process.env.PI_SUBAGENT_TIMEOUT_MS = "4321";
	try {
		const prompt = buildStatefulTurnPrompt(
			record({
				context: "parent <private>ctx-secret</private>",
				currentMailboxMessageIds: ["new-message"],
				mailbox: [
					{
						id: "old-message",
						senderId: "root",
						recipientId: "sa_test",
						content: "old mailbox content",
						createdAt: 1,
						readAt: 2,
					},
					{
						id: "new-message",
						senderId: "root",
						recipientId: "sa_test",
						content: "new <private>mail-secret</private> content",
						createdAt: 3,
						readAt: 4,
					},
				],
				history: [
					{
						task: "task <private>task-secret</private>",
						output: "[subagent-private] hidden-line\nvisible output",
						startedAt: 1,
						completedAt: 2,
						exitCode: 0,
					},
				],
			}),
			"next <private>current-secret</private> task",
		);
		assert.match(prompt.text, /Current task:\nnext \[private content omitted\] task/);
		assert.match(prompt.text, /new \[private content omitted\] content/);
		assert.match(prompt.text, /visible output/);
		assert.doesNotMatch(
			prompt.text,
			/ctx-secret|task-secret|current-secret|mail-secret|hidden-line|old mailbox/,
		);
		assert.equal(resolveStatefulTurnTimeout(undefined), 4321);
		assert.equal(resolveStatefulTurnTimeout({ timeoutMs: 99 }), 99);
	} finally {
		if (originalTimeout === undefined) delete process.env.PI_SUBAGENT_TIMEOUT_MS;
		else process.env.PI_SUBAGENT_TIMEOUT_MS = originalTimeout;
	}
});

test("mapWithConcurrencyLimit preserves input order and enforces its active limit", async () => {
	let active = 0;
	let peak = 0;
	const results = await mapWithConcurrencyLimit([0, 1, 2, 3, 4, 5], 4, async (value) => {
		active++;
		peak = Math.max(peak, active);
		await new Promise((resolve) => setTimeout(resolve, value % 2 ? 2 : 5));
		active--;
		return value * 2;
	});
	assert.equal(peak, 4);
	assert.deepEqual(results, [0, 2, 4, 6, 8, 10]);

	const controller = new AbortController();
	controller.abort();
	let started = 0;
	const skipped = await mapWithConcurrencyLimit(
		[1, 2],
		1,
		async (value) => {
			started++;
			return value;
		},
		controller.signal,
		(value) => -value,
	);
	assert.equal(started, 0);
	assert.deepEqual(skipped, [-1, -2]);
});
