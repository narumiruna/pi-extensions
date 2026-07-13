import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createMockContext, createMockPi } from "../../../test/support.js";
import { buildContextSnapshot, redactPrivateText } from "../src/context.js";
import { DEFAULT_MAX_CONTEXT_BYTES, truncateUtf8, truncateUtf8Tail } from "../src/limits.js";
import { RootOrchestrationState } from "../src/orchestration.js";
import { AgentPersistence } from "../src/persistence.js";
import { JsonLineDecoder } from "../src/protocol.js";
import { AgentRegistry, type ManagedAgent } from "../src/registry.js";
import {
	buildFanInContext,
	mapWithConcurrencyLimit,
	runSingleAgent,
	terminateProcess,
} from "../src/runner.js";
import { normalizeSubagentSettings } from "../src/settings.js";
import {
	assertFollowUpWriteAllowed,
	buildDetachedCompletionMessage,
	buildStatefulTurnPrompt,
	isWriteCapable,
	registerStatefulSubagents,
	resolveSpawnContextMode,
	resolveStatefulTransportKind,
	resolveStatefulTurnTimeout,
} from "../src/stateful.js";
import { WorkspaceManager } from "../src/workspace.js";

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

test("AgentRegistry rejects invalid capacity and wait bounds", async () => {
	assert.throws(
		() => new AgentRegistry(async () => ({ output: "", exitCode: 0 }), { maxActiveTurns: 0 }),
		/positive safe integer/,
	);
	assert.throws(
		() => new AgentRegistry(async () => ({ output: "", exitCode: 0 }), { maxDepth: -1 }),
		/non-negative safe integer/,
	);
	const registry = new AgentRegistry(async () => ({ output: "", exitCode: 0 }));
	const agent = await registry.spawn({ agent: "scout", task: "done", cwd: process.cwd() });
	await assert.rejects(() => registry.wait(agent.id, Number.NaN), /positive finite/);
	await registry.wait(agent.id, 100);
	await registry.close(agent.id);
	await assert.rejects(
		() => registry.spawn({ agent: "scout", task: "child", cwd: process.cwd(), parentId: agent.id }),
		/Cannot spawn under closed agent/,
	);
	await assert.rejects(
		() => registry.spawn({ agent: "scout", task: "  ", cwd: process.cwd() }),
		/tasks cannot be empty/,
	);

	let observedTask = "";
	const boundedRegistry = new AgentRegistry(
		async (_agent, task) => {
			observedTask = task;
			return { output: "y".repeat(200), exitCode: 0 };
		},
		{ maxTaskBytes: 64, maxTurnOutputBytes: 64 },
	);
	const boundedAgent = await boundedRegistry.spawn({
		agent: "scout",
		task: "x".repeat(200),
		cwd: process.cwd(),
	});
	const boundedResult = await boundedRegistry.wait(boundedAgent.id, 100);
	assert.ok(Buffer.byteLength(observedTask) <= 64);
	assert.ok(Buffer.byteLength(boundedResult.agent.history[0].output) <= 64);
});

test("AgentRegistry supports follow-up, wait timeout, interrupt/reuse, limits, and close", async () => {
	const registry = new AgentRegistry(
		async (_agent, task, signal) => {
			if (task === "slow") {
				await new Promise<void>((resolve) =>
					signal.addEventListener("abort", () => resolve(), { once: true }),
				);
			}
			return {
				output: `done:${task}`,
				exitCode: signal.aborted ? 130 : 0,
				aborted: signal.aborted,
			};
		},
		{ maxAgents: 2, maxActiveTurns: 1 },
	);
	const first = await registry.spawn({ agent: "scout", task: "slow", cwd: process.cwd() });
	const second = await registry.spawn({ agent: "reviewer", task: "queued", cwd: process.cwd() });
	const queued = await registry.wait(second.id, 5);
	assert.equal(queued.timedOut, true);
	assert.equal(queued.agent.state, "starting");
	const timed = await registry.wait(first.id, 5);
	assert.equal(timed.timedOut, true);
	const waitController = new AbortController();
	const abortedWait = registry.wait(first.id, 1_000, waitController.signal);
	waitController.abort();
	await assert.rejects(
		abortedWait,
		(error) => error instanceof Error && error.name === "AbortError",
	);
	assert.equal(registry.get(first.id)?.state, "running");
	const interrupted = await registry.interrupt(first.id);
	assert.equal(interrupted.state, "interrupted");
	assert.equal((await registry.wait(second.id, 100)).agent.state, "completed");
	await registry.followUp(first.id, "again");
	const completed = await registry.wait(first.id, 100);
	assert.equal(completed.agent.state, "completed");
	assert.deepEqual(
		completed.agent.history.map((turn) => turn.task),
		["slow", "again"],
	);
	await assert.rejects(
		() => registry.spawn({ agent: "worker", task: "over", cwd: process.cwd() }),
		/capacity/,
	);
	assert.equal((await registry.close(first.id)).state, "closed");
	await assert.rejects(() => registry.close(first.id), /already closed/);
});

test("AgentRegistry runs lifecycle operations through a transport contract", async () => {
	const calls: string[] = [];
	const registry = new AgentRegistry({
		kind: "fake",
		async runTurn(_agent, task, signal) {
			calls.push(`run:${task}`);
			if (task === "slow") {
				await new Promise<void>((resolve) =>
					signal.addEventListener("abort", () => resolve(), { once: true }),
				);
			}
			return { output: task, exitCode: signal.aborted ? 130 : 0, aborted: signal.aborted };
		},
		async release(agent) {
			calls.push(`release:${agent.id}`);
		},
		async shutdown() {
			calls.push("shutdown");
		},
	});
	const agent = await registry.spawn({ agent: "scout", task: "slow", cwd: process.cwd() });
	await registry.interrupt(agent.id);
	await registry.followUp(agent.id, "next");
	await registry.wait(agent.id, 100);
	await registry.close(agent.id);
	await registry.shutdown();
	assert.deepEqual(calls, ["run:slow", "run:next", `release:${agent.id}`, "shutdown"]);
});

test("AgentRegistry clears stale terminal errors when a detached follow-up starts", async () => {
	let turn = 0;
	const registry = new AgentRegistry(async (_agent, _task, signal) => {
		turn++;
		if (turn === 1) return { output: "", exitCode: 1, error: "first failure" };
		await new Promise<void>((resolve) =>
			signal.addEventListener("abort", () => resolve(), { once: true }),
		);
		return { output: "", exitCode: 130, aborted: true };
	});
	const agent = await registry.spawn({ agent: "scout", task: "first", cwd: process.cwd() });
	await registry.wait(agent.id, 100);
	assert.equal(registry.get(agent.id)?.error, "first failure");
	const followUp = await registry.followUp(agent.id, "second");
	assert.match(followUp.state, /starting|running/);
	assert.equal(followUp.error, undefined);
	await registry.interrupt(agent.id);
});

test("AgentRegistry emits one detached completion event for every settled turn", async () => {
	const completions: Array<{
		agentId: string;
		state: string;
		task: string;
		output: string;
	}> = [];
	const settlers: Array<(outcome: { output: string; exitCode: number }) => void> = [];
	const registry = new AgentRegistry(
		async () =>
			new Promise((resolve) => {
				settlers.push(resolve);
			}),
		{
			onTurnComplete: (completion) => {
				completions.push({
					agentId: completion.agent.id,
					state: completion.agent.state,
					task: completion.task,
					output: completion.output,
				});
			},
		},
	);
	const agent = await registry.spawn({ agent: "scout", task: "first", cwd: process.cwd() });
	assert.deepEqual(completions, []);
	settlers.shift()?.({ output: "first result", exitCode: 0 });
	await registry.wait(agent.id, 100);
	await new Promise((resolve) => setImmediate(resolve));
	assert.deepEqual(completions, [
		{ agentId: agent.id, state: "completed", task: "first", output: "first result" },
	]);

	await registry.followUp(agent.id, "second");
	assert.equal(completions.length, 1);
	settlers.shift()?.({ output: "second result", exitCode: 0 });
	await registry.wait(agent.id, 100);
	await new Promise((resolve) => setImmediate(resolve));
	assert.deepEqual(completions.at(-1), {
		agentId: agent.id,
		state: "completed",
		task: "second",
		output: "second result",
	});
	assert.equal(completions.length, 2);
});

test("detached completion messages retain bounded task, partial output, and errors after redaction", () => {
	const content = buildDetachedCompletionMessage({
		agent: record({ agent: "scout\nspoofed", state: "failed" }),
		task: `inspect <private>task secret</private> ${"界".repeat(200)}`,
		output: `partial output <private>output secret</private> ${"x".repeat(4_000)}`,
		error: `provider failed ${"e".repeat(4_000)}`,
	});
	assert.match(content, /Agent: scout spoofed/);
	assert.match(content, /Task: inspect/);
	assert.match(content, /Error:\nprovider failed/);
	assert.match(content, /Payload:\npartial output/);
	assert.doesNotMatch(content, /task secret|output secret/);
	assert.ok(Buffer.byteLength(content, "utf8") <= 2 * 1024);
});

test("AgentRegistry keeps detached lifecycle stable when completion delivery fails", async () => {
	const registry = new AgentRegistry(async () => ({ output: "done", exitCode: 0 }), {
		onTurnComplete: () => {
			throw new Error("stale parent session");
		},
	});
	const agent = await registry.spawn({ agent: "scout", task: "task", cwd: process.cwd() });
	const settled = await registry.wait(agent.id, 100);
	assert.equal(settled.agent.state, "completed");
	assert.equal(settled.agent.history.at(-1)?.output, "done");
});

test("AgentRegistry emits a detached completion when queued work is interrupted", async () => {
	const completions: Array<{ agentId: string; state: string; task: string }> = [];
	const registry = new AgentRegistry(
		async (_agent, _task, signal) => {
			await new Promise<void>((resolve) =>
				signal.addEventListener("abort", () => resolve(), { once: true }),
			);
			return { output: "", exitCode: 130, aborted: true };
		},
		{
			maxActiveTurns: 1,
			onTurnComplete: (completion) => {
				completions.push({
					agentId: completion.agent.id,
					state: completion.agent.state,
					task: completion.task,
				});
			},
		},
	);
	const active = await registry.spawn({ agent: "scout", task: "active", cwd: process.cwd() });
	const queued = await registry.spawn({ agent: "scout", task: "queued", cwd: process.cwd() });
	assert.equal(registry.get(queued.id)?.state, "starting");
	await registry.interrupt(queued.id);
	await new Promise((resolve) => setImmediate(resolve));
	assert.deepEqual(completions, [{ agentId: queued.id, state: "interrupted", task: "queued" }]);
	await registry.interrupt(active.id);
});

test("AgentRegistry persists closed state even when transport release reports cleanup failure", async () => {
	const snapshots: ManagedAgent[][] = [];
	const registry = new AgentRegistry(
		{
			kind: "fake",
			async runTurn() {
				return { output: "done", exitCode: 0 };
			},
			async release() {
				throw new Error("cleanup failed");
			},
		},
		{
			onChange: (agents) => {
				snapshots.push(agents);
			},
		},
	);
	const agent = await registry.spawn({ agent: "scout", task: "task", cwd: process.cwd() });
	await registry.wait(agent.id, 100);
	await assert.rejects(() => registry.close(agent.id), /cleanup failed/);
	assert.equal(snapshots.at(-1)?.find((candidate) => candidate.id === agent.id)?.state, "closed");
});

test("AgentRegistry releases subtree transport sessions child-first and exactly once", async () => {
	const released: string[] = [];
	const registry = new AgentRegistry({
		kind: "fake",
		async runTurn(_agent, task) {
			return { output: task, exitCode: 0 };
		},
		async release(agent) {
			released.push(agent.id);
		},
	});
	const root = await registry.spawn({ agent: "scout", task: "root", cwd: process.cwd() });
	await registry.wait(root.id, 100);
	const child = await registry.spawn({
		agent: "scout",
		task: "child",
		cwd: process.cwd(),
		parentId: root.id,
	});
	await registry.wait(child.id, 100);
	await registry.closeTree(root.id);
	await registry.closeTree(root.id);
	assert.deepEqual(released, [child.id, root.id]);
});

test("AgentRegistry delivers unread mailbox messages to only the next follow-up turn", async () => {
	const delivered: string[][] = [];
	const registry = new AgentRegistry(async (agent) => {
		delivered.push(agent.currentMailboxMessageIds ?? []);
		return { output: "done", exitCode: 0 };
	});
	const agent = await registry.spawn({ agent: "scout", task: "initial", cwd: process.cwd() });
	await registry.wait(agent.id, 100);
	const message = await registry.sendMessage(agent.id, "once");
	await registry.followUp(agent.id, "first follow-up");
	await registry.wait(agent.id, 100);
	await registry.followUp(agent.id, "second follow-up");
	await registry.wait(agent.id, 100);
	assert.deepEqual(delivered, [[], [message.id], []]);
});

test("AgentRegistry preserves hierarchy and delivers bounded deduplicated mailbox messages", async () => {
	const registry = new AgentRegistry(
		async (_agent, task) => ({ output: `done:${task}`, exitCode: 0 }),
		{
			maxDepth: 2,
			maxChildrenPerAgent: 2,
			maxMailboxMessages: 2,
		},
	);
	const root = await registry.spawn({ agent: "scout", task: "root", cwd: process.cwd() });
	await registry.wait(root.id, 100);
	const child = await registry.spawn({
		agent: "scout",
		task: "child",
		cwd: process.cwd(),
		parentId: root.id,
	});
	await registry.wait(child.id, 100);
	const grandchild = await registry.spawn({
		agent: "scout",
		task: "grandchild",
		cwd: process.cwd(),
		parentId: child.id,
	});
	await registry.wait(grandchild.id, 100);
	await assert.rejects(
		() =>
			registry.spawn({
				agent: "scout",
				task: "too deep",
				cwd: process.cwd(),
				parentId: grandchild.id,
			}),
		/depth limit/,
	);
	assert.equal(registry.get(child.id)?.rootId, root.id);
	assert.equal(registry.get(grandchild.id)?.depth, 2);
	assert.deepEqual(registry.get(root.id)?.children, [child.id]);

	const first = await registry.sendMessage(child.id, "hello", root.id, "same");
	const duplicate = await registry.sendMessage(child.id, "hello", root.id, "same");
	assert.equal(duplicate.id, first.id);
	await registry.sendMessage(child.id, "second", root.id);
	await registry.sendMessage(child.id, "third", root.id);
	const unread = await registry.readMessages(child.id, false);
	assert.deepEqual(
		unread.map((message) => message.content),
		["second", "third"],
	);
	assert.equal((await registry.readMessages(child.id, true)).length, 2);
	assert.equal((await registry.readMessages(child.id, false)).length, 0);

	const rootMessages = await registry.readMessages(root.id, false);
	assert.ok(
		rootMessages.some(
			(message) => message.senderId === child.id && /done:child/.test(message.content),
		),
	);
	const closed = await registry.closeTree(root.id);
	assert.deepEqual(
		closed.map((agent) => agent.id),
		[grandchild.id, child.id, root.id],
	);
	await assert.rejects(() => registry.sendMessage(child.id, "late"), /Cannot message closed/);
});

test("AgentRegistry bounds mailbox input and reports rejected child turns to their parent", async () => {
	const registry = new AgentRegistry(
		async (_agent, task) => {
			if (task === "reject") throw new Error("transport rejected");
			return { output: task, exitCode: 0 };
		},
		{ maxMailboxMessageBytes: 64 },
	);
	const root = await registry.spawn({ agent: "scout", task: "root", cwd: process.cwd() });
	await registry.wait(root.id, 100);
	const child = await registry.spawn({
		agent: "scout",
		task: "reject",
		cwd: process.cwd(),
		parentId: root.id,
	});
	assert.equal((await registry.wait(child.id, 100)).agent.state, "failed");
	const completion = await registry.readMessages(root.id, false);
	assert.equal(completion.length, 1);
	assert.match(completion[0].content, /transport rejected/);
	assert.equal(registry.get(child.id)?.history.at(-1)?.exitCode, 1);

	await assert.rejects(() => registry.sendMessage(child.id, "  "), /cannot be empty/);
	await assert.rejects(
		() => registry.sendMessage(child.id, "message", "missing"),
		/Unknown subagent/,
	);
	const other = await registry.spawn({ agent: "scout", task: "other", cwd: process.cwd() });
	await registry.wait(other.id, 100);
	await assert.rejects(
		() => registry.sendMessage(child.id, "message", other.id),
		/cannot cross agent trees/,
	);
	const bounded = await registry.sendMessage(child.id, "x".repeat(200));
	assert.ok(Buffer.byteLength(bounded.content, "utf8") <= 64);
	assert.match(bounded.content, /truncated/);
	await registry.sendMessage(child.id, "second");
	await registry.sendMessage(child.id, "third");
	assert.equal((await registry.readMessages(child.id, true, 2)).length, 2);
	assert.equal((await registry.readMessages(child.id, false)).length, 1);
	await assert.rejects(
		() => registry.sendMessage(child.id, "message", "root", "k".repeat(257)),
		/cannot exceed 256/,
	);
});

test("AgentRegistry shutdown aborts active work and drains queued work without starting it", async () => {
	const started: string[] = [];
	const registry = new AgentRegistry(
		async (_agent, task, signal) => {
			started.push(task);
			await new Promise<void>((resolve) =>
				signal.addEventListener("abort", () => resolve(), { once: true }),
			);
			return { output: "stopped", exitCode: 130, aborted: true };
		},
		{ maxActiveTurns: 1 },
	);
	const active = await registry.spawn({ agent: "scout", task: "active", cwd: process.cwd() });
	const queued = await registry.spawn({ agent: "scout", task: "queued", cwd: process.cwd() });
	await registry.shutdown();
	assert.deepEqual(started, ["active"]);
	assert.equal(registry.get(active.id)?.state, "idle");
	assert.equal(registry.get(queued.id)?.state, "idle");
});

test("AgentRegistry eviction preserves active ancestry and removes expired trees leaf-first", async () => {
	let now = 1_000;
	const registry = new AgentRegistry(
		async (_agent, task, signal) => {
			if (task === "slow") {
				await new Promise<void>((resolve) =>
					signal.addEventListener("abort", () => resolve(), { once: true }),
				);
			}
			return { output: "done", exitCode: signal.aborted ? 130 : 0, aborted: signal.aborted };
		},
		{ idleTtlMs: 100, now: () => now },
	);
	const root = await registry.spawn({ agent: "scout", task: "done", cwd: process.cwd() });
	await registry.wait(root.id, 100);
	const child = await registry.spawn({
		agent: "scout",
		task: "slow",
		cwd: process.cwd(),
		parentId: root.id,
	});
	now += 101;
	assert.equal(await registry.sweepExpired(), 0);
	assert.ok(registry.get(root.id));
	await registry.interrupt(child.id);
	assert.equal(registry.get(root.id)?.updatedAt, now);
	now += 101;
	assert.equal(await registry.sweepExpired(), 2);
	assert.equal(registry.get(root.id), undefined);
	assert.equal(registry.get(child.id), undefined);
});

test("AgentRegistry expiry prunes stale child links and releases its transport", async () => {
	let now = 1_000;
	const released: string[] = [];
	const registry = new AgentRegistry(
		{
			kind: "fake",
			async runTurn() {
				return { output: "done", exitCode: 0 };
			},
			async release(agent) {
				released.push(agent.id);
			},
		},
		{
			idleTtlMs: 100,
			now: () => now,
		},
	);
	const root = await registry.spawn({ agent: "scout", task: "root", cwd: process.cwd() });
	await registry.wait(root.id, 100);
	const child = await registry.spawn({
		agent: "scout",
		task: "child",
		cwd: process.cwd(),
		parentId: root.id,
	});
	await registry.wait(child.id, 100);
	now += 50;
	await registry.sendMessage(root.id, "refresh parent");
	now += 51;
	assert.equal(await registry.sweepExpired(), 1);
	assert.equal(registry.get(child.id), undefined);
	assert.deepEqual(registry.get(root.id)?.children, []);
	assert.deepEqual(released, [child.id]);
	assert.equal((await registry.close(root.id)).state, "closed");
	assert.deepEqual(released, [child.id, root.id]);
});

test("AgentRegistry bounds retained closed records", async () => {
	const registry = new AgentRegistry(async () => ({ output: "done", exitCode: 0 }), {
		maxAgents: 2,
	});
	for (let index = 0; index < 4; index++) {
		const agent = await registry.spawn({
			agent: "scout",
			task: String(index),
			cwd: process.cwd(),
		});
		await registry.wait(agent.id, 100);
		await registry.close(agent.id);
	}
	assert.equal(registry.list(true).length, 2);
});

test("AgentRegistry serializes state snapshots so slow persistence cannot overwrite completion", async () => {
	const savedStates: string[] = [];
	let saveCount = 0;
	let releaseSlowSave: (() => void) | undefined;
	const slowSave = new Promise<void>((resolve) => {
		releaseSlowSave = resolve;
	});
	const registry = new AgentRegistry(async () => ({ output: "done", exitCode: 0 }), {
		onChange: async (agents) => {
			saveCount++;
			if (saveCount === 2) await slowSave;
			savedStates.push(agents[0]?.state ?? "missing");
		},
	});
	const agent = await registry.spawn({ agent: "scout", task: "task", cwd: process.cwd() });
	await registry.wait(agent.id, 100);
	await new Promise((resolve) => setImmediate(resolve));
	releaseSlowSave?.();
	await new Promise((resolve) => setImmediate(resolve));
	assert.deepEqual(savedStates, ["starting", "starting", "completed"]);
});

test("AgentRegistry keeps lifecycle usable when persistence callbacks fail", async () => {
	const registry = new AgentRegistry(async () => ({ output: "done", exitCode: 0 }), {
		onChange: async () => {
			throw new Error("disk unavailable");
		},
	});
	const agent = await registry.spawn({ agent: "scout", task: "done", cwd: process.cwd() });
	assert.equal((await registry.wait(agent.id, 100)).agent.state, "completed");
});

test("AgentRegistry restores valid records inertly and rejects cyclic hierarchy", () => {
	const registry = new AgentRegistry(async () => ({ output: "", exitCode: 0 }));
	registry.restore([
		record({ state: "running", currentTask: "must not resume" }),
		record({ id: "child", rootId: "wrong", parentId: "sa_test", depth: 99 }),
		record({ id: "cycle-a", rootId: "cycle-a", parentId: "cycle-b", depth: 1 }),
		record({ id: "cycle-b", rootId: "cycle-a", parentId: "cycle-a", depth: 2 }),
	]);
	const restored = registry.get("sa_test");
	assert.equal(restored?.state, "idle");
	assert.equal(restored?.currentTask, undefined);
	assert.deepEqual(restored?.children, ["child"]);
	assert.equal(registry.get("child")?.rootId, "sa_test");
	assert.equal(registry.get("child")?.depth, 1);
	assert.equal(registry.get("cycle-a"), undefined);
	assert.equal(registry.get("cycle-b"), undefined);
});

test("AgentPersistence atomically saves, restores, redacts, deletes, and quarantines bad state", async () => {
	const dir = mkdtempSync(path.join(os.tmpdir(), "pi-subagent-state-"));
	const persistence = new AgentPersistence("session", { stateDir: dir, maxStoredAgents: 2 });
	await persistence.save([
		record({
			context: "<private>secret</private>",
			mailbox: [
				{
					id: "msg",
					senderId: "root",
					recipientId: "sa_test",
					content: "<private>mail-secret</private>visible",
					createdAt: 1,
				},
			],
			history: [
				{
					task: "task",
					output: "[subagent-private] hidden\nvisible",
					startedAt: 1,
					completedAt: 2,
					exitCode: 0,
				},
			],
		}),
	]);
	const raw = readFileSync(persistence.filePath, "utf8");
	assert.doesNotMatch(raw, /secret|hidden/);
	assert.match(raw, /visible/);
	const restoredState = persistence.load()[0];
	assert.equal(restoredState?.state, "idle");
	assert.equal(restoredState?.mailbox[0]?.content, "[private content omitted]visible");
	const competing = new AgentPersistence("session", { stateDir: dir, maxStoredAgents: 2 });
	await Promise.all([
		persistence.save([record({ id: "one" })]),
		competing.save([record({ id: "two" })]),
	]);
	assert.ok(["one", "two"].includes(persistence.load()[0]?.id ?? ""));
	const hierarchyPersistence = new AgentPersistence("hierarchy", {
		stateDir: dir,
		maxStoredAgents: 2,
	});
	const persistenceNow = Date.now();
	await hierarchyPersistence.save([
		record({ id: "root", rootId: "root", updatedAt: persistenceNow }),
		record({
			id: "child",
			rootId: "root",
			parentId: "root",
			depth: 1,
			updatedAt: persistenceNow + 2,
		}),
		record({ id: "other", rootId: "other", updatedAt: persistenceNow + 1 }),
	]);
	assert.deepEqual(
		hierarchyPersistence.load().map((agent) => agent.id),
		["root", "child"],
	);
	assert.throws(
		() => new AgentPersistence("invalid", { stateDir: dir, maxStoredAgents: 0 }),
		/positive safe integer/,
	);
	await persistence.delete();
	assert.deepEqual(persistence.load(), []);
	writeFileSync(
		persistence.filePath,
		JSON.stringify({
			version: 1,
			updatedAt: Date.now(),
			agents: [
				{
					id: "legacy",
					agent: "scout",
					state: "completed",
					createdAt: Date.now(),
					updatedAt: Date.now(),
					cwd: process.cwd(),
					history: [],
				},
			],
		}),
	);
	assert.equal(persistence.load()[0]?.rootId, "legacy");
	writeFileSync(
		persistence.filePath,
		JSON.stringify({
			version: 2,
			updatedAt: Date.now(),
			agents: [
				{
					id: "malformed",
					agent: "scout",
					state: "idle",
					createdAt: Date.now(),
					updatedAt: Date.now(),
					cwd: process.cwd(),
					history: [{}],
				},
			],
		}),
	);
	assert.deepEqual(persistence.load(), []);
	writeFileSync(persistence.filePath, JSON.stringify({ version: 999, agents: [] }));
	assert.deepEqual(persistence.load(), []);
	writeFileSync(persistence.filePath, "not json");
	assert.deepEqual(persistence.load(), []);
	assert.ok(
		readdirSync(dir).some((name) =>
			name.startsWith(`${path.basename(persistence.filePath)}.invalid-`),
		),
	);
});

test("WorkspaceManager creates and cleans owned disposable worktrees", async () => {
	const repo = mkdtempSync(path.join(os.tmpdir(), "pi-subagent-workspace-repo-"));
	execFileSync("git", ["init", "-q", repo]);
	execFileSync("git", ["-C", repo, "config", "user.email", "test@example.com"]);
	execFileSync("git", ["-C", repo, "config", "user.name", "Test"]);
	writeFileSync(path.join(repo, "tracked.txt"), "base\n");
	mkdirSync(path.join(repo, "nested"));
	writeFileSync(path.join(repo, "nested", "inner.txt"), "inner\n");
	execFileSync("git", ["-C", repo, "add", "tracked.txt", "nested/inner.txt"]);
	execFileSync("git", ["-C", repo, "commit", "-qm", "init"]);
	const manager = new WorkspaceManager();
	const workspace = await manager.create("owner", path.join(repo, "nested"));
	assert.equal(readFileSync(path.join(workspace.path, "inner.txt"), "utf8"), "inner\n");
	assert.equal(readFileSync(path.join(workspace.rootPath, "tracked.txt"), "utf8"), "base\n");
	await assert.rejects(() => manager.create("owner", repo), /owner already exists/);
	rmSync(`${workspace.rootPath}.owner`);
	await assert.rejects(() => manager.cleanup("owner"), /Refusing to clean unowned/);
	writeFileSync(`${workspace.rootPath}.owner`, "owner", { mode: 0o600 });
	await manager.cleanup("owner");
	assert.equal(existsSync(workspace.rootPath), false);
	const second = await manager.create("second", repo);
	await manager.cleanupAll();
	assert.equal(existsSync(second.path), false);
	writeFileSync(path.join(repo, "dirty.txt"), "dirty");
	await assert.rejects(() => manager.create("dirty", repo), /clean Git repository/);
});

test("shared-workspace write classification and follow-up guards are conservative", async () => {
	assert.equal(isWriteCapable(undefined), true);
	assert.equal(isWriteCapable(["read", "grep"]), false);
	assert.equal(isWriteCapable(["read", "bash"]), true);
	assert.equal(isWriteCapable(["edit"]), true);
	const registry = new AgentRegistry(async (_agent, _task, signal) => {
		await new Promise<void>((resolve) =>
			signal.addEventListener("abort", () => resolve(), { once: true }),
		);
		return { output: "interrupted", exitCode: 130, aborted: true };
	});
	const active = await registry.spawn({ agent: "worker", task: "active", cwd: process.cwd() });
	const followUp = record({ agent: "worker", cwd: process.cwd(), state: "completed" });
	assert.throws(
		() => assertFollowUpWriteAllowed(registry, followUp, false, false),
		(error: unknown) => {
			assert.match(String(error), /already active in shared workspace/);
			assert.match(String(error), /subagent parallel mode/);
			assert.match(String(error), /wait or close/);
			assert.match(String(error), /allowConcurrentWrites/);
			assert.match(String(error), /worktree/);
			return true;
		},
	);
	assert.doesNotThrow(() => assertFollowUpWriteAllowed(registry, followUp, true, false));
	assert.doesNotThrow(() => assertFollowUpWriteAllowed(registry, followUp, false, true));
	await registry.interrupt(active.id);
});

test("root orchestration recovery is revision-bounded and clears synthesized results", () => {
	const state = new RootOrchestrationState();
	state.reset();
	state.beginTurn();
	state.spawn("sa_one");
	const first = state.endTurn();
	assert.ok(first);
	assert.match(first.prompt, /subagent_wait/);
	state.markDelivered(first);

	state.beginTurn();
	assert.equal(state.endTurn(), undefined, "unchanged live work does not loop autonomously");
	state.complete("sa_one");
	const synthesis = state.endTurn();
	assert.ok(synthesis, "completion after the turn schedules a synthesis recovery");
	state.markDelivered(synthesis);
	state.beginTurn();
	assert.equal(state.endTurn(), undefined);
	assert.equal(state.hasUnresolved(), false);
});

test("root orchestration treats newer root work as a bounded coordination attempt", () => {
	const state = new RootOrchestrationState();
	state.reset();
	state.spawn("sa_one");
	assert.ok(state.endTurn());
	state.beginTurn();
	assert.equal(state.endTurn(), undefined);
	assert.deepEqual(state.liveAgentIds(), ["sa_one"]);
});

test("root orchestration lets newer user work supersede a queued recovery", () => {
	const state = new RootOrchestrationState();
	state.reset();
	state.spawn("sa_one");
	const queued = state.endTurn();
	assert.ok(queued);
	assert.match(queued.prompt, new RegExp(queued.nonce));
	assert.deepEqual(state.supersedePending(), queued);
	assert.equal(state.isCurrent(queued), false);
	state.beginTurn();
	assert.equal(state.endTurn(), undefined);
});

test("root orchestration accepts completion synthesized during useful root work", () => {
	const state = new RootOrchestrationState();
	state.reset();
	state.beginTurn();
	state.spawn("sa_one");
	state.complete("sa_one");
	state.observeAvailable();
	assert.equal(state.endTurn(), undefined);
	assert.equal(state.hasUnresolved(), false);
});

test("root orchestration cancels stale tickets and explicit resolution", () => {
	const state = new RootOrchestrationState();
	state.reset();
	state.spawn("sa_one");
	const stale = state.endTurn();
	assert.ok(stale);
	state.complete("sa_one");
	assert.equal(state.isCurrent(stale), false);
	const current = state.endTurn();
	assert.ok(current);
	state.resolve("sa_one");
	assert.equal(state.isCurrent(current), false);
	assert.equal(state.hasUnresolved(), false);
	state.reset();
	assert.equal(state.pendingTicket(), undefined);
});

test("selected context entries imply all mode only when context mode is omitted", () => {
	assert.equal(resolveSpawnContextMode(undefined, ["entry"]), "all");
	assert.equal(resolveSpawnContextMode(undefined, []), "all");
	assert.equal(resolveSpawnContextMode(undefined, undefined), "none");
	assert.equal(resolveSpawnContextMode("none", ["entry"]), "none");
	assert.equal(resolveSpawnContextMode(3, ["entry"]), 3);
});

test("stateful tools are available by default, disable cleanly, and expose the lifecycle surface", async () => {
	const originalDir = process.env.PI_CODING_AGENT_DIR;
	const dir = mkdtempSync(path.join(os.tmpdir(), "pi-subagent-config-"));
	process.env.PI_CODING_AGENT_DIR = dir;
	try {
		const mock = createMockPi();
		registerStatefulSubagents(mock.pi);
		assert.deepEqual(
			mock.tools.map((tool) => tool.name),
			[
				"subagent_spawn",
				"subagent_send",
				"subagent_message",
				"subagent_messages",
				"subagent_wait",
				"subagent_list",
				"subagent_interrupt",
				"subagent_close",
			],
		);
		assert.ok(mock.commands.has("subagents:agents"));
		const context = createMockContext();
		await mock.events.get("session_start")?.[0]?.({}, context.ctx);
		const list = mock.tools.find((tool) => tool.name === "subagent_list") as {
			execute: (...args: unknown[]) => Promise<{ content: Array<{ text: string }> }>;
		};
		const listed = await list.execute("id", {}, undefined, undefined, context.ctx);
		assert.equal(listed.content[0].text, "No stateful subagents.");

		const project = mkdtempSync(path.join(os.tmpdir(), "pi-subagent-project-"));
		const projectAgents = path.join(project, ".pi", "agents");
		mkdirSync(projectAgents, { recursive: true });
		writeFileSync(
			path.join(projectAgents, "project.md"),
			"---\nname: project\ndescription: project agent\n---\nDo project work.",
		);
		const untrusted = createMockContext({ cwd: project, isProjectTrusted: () => false });
		const spawnTool = mock.tools.find((tool) => tool.name === "subagent_spawn") as {
			execute: (...args: unknown[]) => Promise<unknown>;
			promptGuidelines: string[];
		};
		assert.match(spawnTool.promptGuidelines.join("\n"), /simple or critical-path work/);
		assert.match(
			spawnTool.promptGuidelines.join("\n"),
			/single detached subagent.*isolation or specialization/i,
		);
		assert.match(spawnTool.promptGuidelines.join("\n"), /call subagent_wait rather than yielding/i);
		assert.match(spawnTool.promptGuidelines.join("\n"), /synthesize their results/i);
		const originalDepth = process.env.PI_SUBAGENT_DEPTH;
		process.env.PI_SUBAGENT_DEPTH = "1";
		try {
			await assert.rejects(
				() =>
					spawnTool.execute(
						"id",
						{ agent: "scout", task: "nested" },
						undefined,
						undefined,
						context.ctx,
					),
				/recursion depth limit/,
			);
		} finally {
			if (originalDepth === undefined) delete process.env.PI_SUBAGENT_DEPTH;
			else process.env.PI_SUBAGENT_DEPTH = originalDepth;
		}
		await assert.rejects(
			() =>
				spawnTool.execute(
					"id",
					{
						agent: "project",
						task: "task",
						cwd: project,
						agentScope: "project",
						confirmProjectAgents: false,
					},
					undefined,
					undefined,
					createMockContext({ isProjectTrusted: () => true }).ctx,
				),
			/overridden cwd/,
		);
		await assert.rejects(
			() =>
				spawnTool.execute(
					"id",
					{
						agent: "project",
						task: "task",
						agentScope: "project",
						confirmProjectAgents: false,
					},
					undefined,
					undefined,
					untrusted.ctx,
				),
			/trusted project/,
		);
		await mock.events.get("session_shutdown")?.[0]?.({}, context.ctx);

		writeFileSync(
			path.join(dir, "pi-subagents.json"),
			JSON.stringify({ stateful: { enabled: false } }),
		);
		const disabled = createMockPi();
		registerStatefulSubagents(disabled.pi);
		assert.equal(disabled.tools.length, 0);
		assert.equal(disabled.events.size, 0);
	} finally {
		if (originalDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = originalDir;
	}
});

test("stateful settings validate transport and bounded runtime options", () => {
	assert.equal(resolveStatefulTransportKind(undefined), "subprocess");
	assert.equal(resolveStatefulTransportKind("in-process"), "in-process");
	assert.deepEqual(
		normalizeSubagentSettings({
			stateful: {
				enabled: true,
				transport: "in-process",
				maxAgents: 8,
				maxDepth: 2,
				maxChildrenPerAgent: 3,
				maxMailboxMessages: 10,
				maxMailboxMessageBytes: 4096,
			},
			agents: {},
		}),
		{
			stateful: {
				enabled: true,
				transport: "in-process",
				maxAgents: 8,
				maxDepth: 2,
				maxChildrenPerAgent: 3,
				maxMailboxMessages: 10,
				maxMailboxMessageBytes: 4096,
			},
		},
	);
	assert.deepEqual(normalizeSubagentSettings({ stateful: { transport: "subprocess" } }), {
		stateful: { transport: "subprocess" },
	});
	assert.equal(normalizeSubagentSettings({ stateful: { transport: "native" } }), undefined);
	assert.equal(normalizeSubagentSettings({ stateful: { maxAgents: 0 } }), undefined);
	assert.equal(normalizeSubagentSettings({ stateful: { maxAgents: 1.5 } }), undefined);
	assert.deepEqual(normalizeSubagentSettings({ stateful: { maxDepth: 0 } }), {
		stateful: { maxDepth: 0 },
	});
});

test("runSingleAgent normalizes invalid cwd without spawning or throwing", async () => {
	const result = await runSingleAgent(
		process.cwd(),
		[
			{
				name: "test",
				description: "test",
				systemPrompt: "",
				source: "built-in",
				filePath: "built-in:test",
			},
		],
		"test",
		"task",
		path.join(os.tmpdir(), "definitely-missing-pi-subagent-cwd"),
		undefined,
		undefined,
		undefined,
		100,
		undefined,
		(results) => ({ mode: "single", agentScope: "user", projectAgentsDir: null, results }),
	);
	assert.equal(result.exitCode, 1);
	assert.equal(result.stopReason, "error");
	assert.match(result.errorMessage ?? "", /Invalid subagent cwd/);
});

test("runSingleAgent preserves partial output on mid-stream abort and handles pre-abort", async () => {
	const script = [
		"const message={role:'assistant',content:[{type:'text',text:'PARTIAL'}],timestamp:Date.now()};",
		"process.stdout.write(JSON.stringify({type:'message_end',message})+'\\n');",
		"setInterval(()=>{},1000);",
	].join("");
	const agents = [
		{
			name: "test",
			description: "test",
			systemPrompt: "",
			source: "built-in" as const,
			filePath: "built-in:test",
		},
	];
	const makeDetails = (results: Parameters<Parameters<typeof runSingleAgent>[10]>[0]) => ({
		mode: "single" as const,
		agentScope: "user" as const,
		projectAgentsDir: null,
		results,
	});
	const controller = new AbortController();
	let sawPartial = false;
	const running = runSingleAgent(
		process.cwd(),
		agents,
		"test",
		"task",
		undefined,
		undefined,
		controller.signal,
		undefined,
		1_000,
		(partial) => {
			if (partial.content[0]?.type === "text" && partial.content[0].text === "PARTIAL") {
				sawPartial = true;
				controller.abort();
			}
		},
		makeDetails,
		{ command: process.execPath, argsPrefix: ["-e", script, "--"] },
	);
	const aborted = await running;
	assert.equal(sawPartial, true);
	assert.equal(aborted.aborted, true);
	assert.equal(aborted.exitCode, 130);
	assert.equal(aborted.finalOutput, "PARTIAL");

	const preAborted = new AbortController();
	preAborted.abort();
	const beforeStart = await runSingleAgent(
		process.cwd(),
		agents,
		"test",
		"task",
		undefined,
		undefined,
		preAborted.signal,
		undefined,
		1_000,
		undefined,
		makeDetails,
		{ command: process.execPath, argsPrefix: ["-e", "setInterval(()=>{},1000)", "--"] },
	);
	assert.equal(beforeStart.aborted, true);
	assert.equal(beforeStart.exitCode, 130);
});

test("terminateProcess escalates when a child ignores SIGTERM", {
	skip: process.platform === "win32",
}, async () => {
	const child = spawn(
		process.execPath,
		[
			"-e",
			"process.on('SIGTERM',()=>{}); process.stdout.write('ready\\n'); setInterval(()=>{},1000)",
		],
		{ detached: true, stdio: ["ignore", "pipe", "ignore"] },
	);
	await new Promise<void>((resolve) => child.stdout?.once("data", () => resolve()));
	const started = Date.now();
	terminateProcess(child, 30);
	await new Promise<void>((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error("child did not exit")), 1000);
		child.once("close", () => {
			clearTimeout(timer);
			resolve();
		});
	});
	assert.ok(Date.now() - started < 1000);
});
