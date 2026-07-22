import assert from "node:assert/strict";
import test from "node:test";
import type { AgentTurnCompletion, ManagedAgent } from "../src/registry.js";
import { CompletionDeliveryBroker } from "../src/stateful.js";

function completion(id: string, output = `output:${id}`): AgentTurnCompletion {
	const agent: ManagedAgent = {
		id,
		agent: "scout",
		rootId: id,
		depth: 0,
		children: [],
		state: "completed",
		createdAt: 1,
		updatedAt: 2,
		cwd: process.cwd(),
		history: [],
		mailbox: [],
	};
	return { agent, task: `task:${id}`, output };
}

function deliveryHarness(options: { idle?: boolean; pending?: boolean } = {}) {
	const sent: Array<{ message: Record<string, unknown>; options: Record<string, unknown> }> = [];
	const pi = {
		sendMessage(message: Record<string, unknown>, messageOptions: Record<string, unknown>) {
			sent.push({ message, options: messageOptions });
		},
	};
	const ctx = {
		isIdle: () => options.idle ?? true,
		hasPendingMessages: () => options.pending ?? false,
	};
	return { pi, ctx, sent };
}

test("next-turn completion delivery never wakes an idle root", () => {
	const harness = deliveryHarness();
	const broker = new CompletionDeliveryBroker(harness.pi as never, harness.ctx, "next-turn");
	broker.enqueue(completion("sa_one"));
	broker.flush();

	assert.equal(harness.sent.length, 1);
	assert.deepEqual(harness.sent[0]?.options, { deliverAs: "steer", triggerTurn: false });
	assert.equal(harness.sent[0]?.message.customType, "pi-subagent-completion");
	assert.match(String(harness.sent[0]?.message.content), /Agent ID: sa_one/);
	assert.deepEqual(harness.sent[0]?.message.details, {
		agentId: "sa_one",
		agent: "scout",
		state: "completed",
	});
	broker.close();
});

test("auto-resume batches simultaneous completions into one root synthesis turn", () => {
	const harness = deliveryHarness();
	const broker = new CompletionDeliveryBroker(harness.pi as never, harness.ctx, "auto-resume");
	broker.enqueue(completion("sa_one"));
	broker.enqueue(completion("sa_two"));
	broker.flush();

	assert.equal(harness.sent.length, 1);
	assert.deepEqual(harness.sent[0]?.options, { deliverAs: "steer", triggerTurn: true });
	assert.match(String(harness.sent[0]?.message.content), /SUBAGENT_COMPLETION_BATCH/);
	assert.match(String(harness.sent[0]?.message.content), /Agent ID: sa_one/);
	assert.match(String(harness.sent[0]?.message.content), /Agent ID: sa_two/);
	assert.deepEqual(harness.sent[0]?.message.details, {
		completionCount: 2,
		completions: [
			{ agentId: "sa_one", agent: "scout", state: "completed" },
			{ agentId: "sa_two", agent: "scout", state: "completed" },
		],
	});
	broker.close();
});

test("completion timer coalesces a burst into one batched wake", async () => {
	const harness = deliveryHarness();
	const broker = new CompletionDeliveryBroker(harness.pi as never, harness.ctx, "auto-resume");
	broker.enqueue(completion("sa_timer_one"));
	broker.enqueue(completion("sa_timer_two"));
	await new Promise((resolve) => setTimeout(resolve, 20));
	assert.equal(harness.sent.length, 1);
	assert.match(String(harness.sent[0]?.message.content), /SUBAGENT_COMPLETION_BATCH/);
	assert.deepEqual(harness.sent[0]?.options, { deliverAs: "steer", triggerTurn: true });
	broker.close();
});

test("large completion bursts stay bounded and request only one synthesis turn", () => {
	const harness = deliveryHarness();
	const broker = new CompletionDeliveryBroker(harness.pi as never, harness.ctx, "auto-resume");
	for (let index = 0; index < 17; index++) broker.enqueue(completion(`sa_${index}`));
	broker.flush();

	assert.equal(harness.sent.length, 2);
	assert.deepEqual(
		harness.sent.map((entry) => entry.options),
		[
			{ deliverAs: "steer", triggerTurn: false },
			{ deliverAs: "steer", triggerTurn: true },
		],
	);
	assert.ok(Buffer.byteLength(String(harness.sent[0]?.message.content), "utf8") <= 50 * 1024);
	broker.close();
});

test("auto-resume allows only one in-flight wake until the parent starts", () => {
	const harness = deliveryHarness();
	const broker = new CompletionDeliveryBroker(harness.pi as never, harness.ctx, "auto-resume");
	broker.enqueue(completion("sa_first"));
	broker.flush();
	broker.enqueue(completion("sa_second"));
	broker.flush();
	broker.onParentTurnStart();
	broker.enqueue(completion("sa_third"));
	broker.flush();

	assert.deepEqual(
		harness.sent.map((entry) => entry.options),
		[
			{ deliverAs: "steer", triggerTurn: true },
			{ deliverAs: "steer", triggerTurn: false },
			{ deliverAs: "steer", triggerTurn: true },
		],
	);
	broker.close();
});

test("auto-resume holds active-turn completions until settlement", () => {
	const options = { idle: false, pending: false };
	const harness = deliveryHarness(options);
	const broker = new CompletionDeliveryBroker(harness.pi as never, harness.ctx, "auto-resume");
	broker.enqueue(completion("sa_active"));
	broker.flush();
	assert.equal(harness.sent.length, 0);

	options.idle = true;
	broker.onParentSettled();
	broker.flush();
	assert.deepEqual(harness.sent[0]?.options, { deliverAs: "steer", triggerTurn: true });
	broker.onParentSettled();
	broker.flush();
	assert.equal(harness.sent.length, 1);
	broker.close();
});

test("changing delivery policy flushes an active-root batch without waiting for settlement", () => {
	const harness = deliveryHarness({ idle: false });
	const broker = new CompletionDeliveryBroker(harness.pi as never, harness.ctx, "auto-resume");
	broker.enqueue(completion("sa_policy"));
	broker.flush();
	assert.equal(harness.sent.length, 0);
	broker.setDelivery("next-turn");
	broker.flush();
	assert.deepEqual(harness.sent[0]?.options, { deliverAs: "steer", triggerTurn: false });
	broker.close();
});

test("auto-resume lets pending user input suppress its wake", () => {
	const harness = deliveryHarness({ idle: true, pending: true });
	const broker = new CompletionDeliveryBroker(harness.pi as never, harness.ctx, "auto-resume");
	broker.enqueue(completion("sa_pending"));
	broker.flush();
	assert.deepEqual(harness.sent[0]?.options, { deliverAs: "steer", triggerTurn: false });
	broker.close();
});

test("a synchronous parent-start acknowledgement clears the pre-set wake latch", () => {
	const sent: Array<Record<string, unknown>> = [];
	let broker: CompletionDeliveryBroker;
	broker = new CompletionDeliveryBroker(
		{
			sendMessage(_message: unknown, options: Record<string, unknown>) {
				sent.push(options);
				broker.onParentTurnStart();
			},
		} as never,
		{ isIdle: () => true, hasPendingMessages: () => false },
		"auto-resume",
	);
	broker.enqueue(completion("sa_first"));
	broker.flush();
	broker.enqueue(completion("sa_second"));
	broker.flush();
	assert.deepEqual(sent, [
		{ deliverAs: "steer", triggerTurn: true },
		{ deliverAs: "steer", triggerTurn: true },
	]);
	broker.close();
});

test("a synchronous auto-resume delivery error falls back to the next user turn", () => {
	const sent: Array<Record<string, unknown>> = [];
	let attempts = 0;
	const broker = new CompletionDeliveryBroker(
		{
			sendMessage(_message: unknown, options: Record<string, unknown>) {
				attempts++;
				if (attempts === 1) throw new Error("wake rejected");
				sent.push(options);
			},
		} as never,
		{ isIdle: () => true, hasPendingMessages: () => false },
		"auto-resume",
	);
	broker.enqueue(completion("sa_fallback"));
	broker.flush();
	assert.deepEqual(sent, [{ deliverAs: "nextTurn", triggerTurn: false }]);
	broker.close();
});

test("double delivery failure retains the complete unsent suffix in order", () => {
	let failing = true;
	let attempts = 0;
	let errors = 0;
	const sent: Array<{ message: Record<string, unknown>; options: Record<string, unknown> }> = [];
	const broker = new CompletionDeliveryBroker(
		{
			sendMessage(message: Record<string, unknown>, options: Record<string, unknown>) {
				attempts++;
				if (failing) throw new Error("delivery rejected");
				sent.push({ message, options });
			},
		} as never,
		{ isIdle: () => true, hasPendingMessages: () => false },
		"auto-resume",
		{
			onDeliveryError: () => {
				errors++;
				throw new Error("observer failed");
			},
		},
	);
	for (let index = 0; index < 17; index++) broker.enqueue(completion(`sa_${index}`));
	broker.flush();
	assert.equal(attempts, 2);
	assert.equal(errors, 1);
	assert.equal(sent.length, 0);

	failing = false;
	broker.enqueue(completion("sa_17"));
	broker.flush();
	assert.equal(sent.length, 2);
	assert.match(String(sent[0]?.message.content), /Agent ID: sa_0/);
	assert.match(String(sent[1]?.message.content), /Agent ID: sa_16/);
	assert.match(String(sent[1]?.message.content), /Agent ID: sa_17/);
	assert.deepEqual(sent[1]?.options, { deliverAs: "steer", triggerTurn: true });
	broker.close();
});

test("closing a completion broker drops session-stale queued notifications", async () => {
	const harness = deliveryHarness();
	const broker = new CompletionDeliveryBroker(harness.pi as never, harness.ctx, "auto-resume");
	broker.enqueue(completion("sa_stale"));
	broker.close();
	await new Promise((resolve) => setTimeout(resolve, 5));
	assert.deepEqual(harness.sent, []);
});
