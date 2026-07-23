import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AgentPersistence } from "../src/persistence.js";
import { AgentRegistry, type ManagedAgent } from "../src/registry.js";
import { buildDetachedCompletionMessage } from "../src/stateful.js";

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

test("AgentRegistry retains an explicit spawn thinking level across follow-ups and copies", async () => {
	const observed: Array<string | undefined> = [];
	const registry = new AgentRegistry(async (agent) => {
		observed.push(agent.thinkingLevel);
		return { output: "done", exitCode: 0 };
	});
	const spawned = await registry.spawn({
		agent: "scout",
		task: "first",
		cwd: process.cwd(),
		thinkingLevel: "high",
	});
	assert.equal(spawned.thinkingLevel, "high");
	await registry.wait(spawned.id, 100);
	const followUp = await registry.followUp(spawned.id, "second");
	assert.equal(followUp.thinkingLevel, "high");
	await registry.wait(spawned.id, 100);
	assert.deepEqual(observed, ["high", "high"]);
	assert.equal(registry.get(spawned.id)?.thinkingLevel, "high");
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
			thinkingLevel: "high",
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
	assert.equal(restoredState?.thinkingLevel, "high");
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
	assert.equal(persistence.load()[0]?.thinkingLevel, undefined);
	writeFileSync(
		persistence.filePath,
		JSON.stringify({
			version: 2,
			updatedAt: Date.now(),
			agents: [
				{
					id: "invalid-thinking",
					agent: "scout",
					thinkingLevel: "huge",
					state: "idle",
					createdAt: Date.now(),
					updatedAt: Date.now(),
					cwd: process.cwd(),
					history: [],
				},
			],
		}),
	);
	assert.deepEqual(persistence.load(), []);
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
