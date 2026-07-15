import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createMockContext, createMockPi } from "../../../test/support.js";
import goal from "../src/goal.js";
import type { ActiveGoal, GoalStateEntryData } from "../src/persistence.js";

const settingsDirectory = mkdtempSync(join(tmpdir(), "pi-goal-queue-settings-"));
const enabledSettingsPath = join(settingsDirectory, "enabled.json");
const disabledSettingsPath = join(settingsDirectory, "disabled.json");
writeFileSync(enabledSettingsPath, '{"experimental":{"goals":true}}\n');
writeFileSync(disabledSettingsPath, "{}\n");

type GoalTool = {
	execute: (...args: unknown[]) => Promise<{
		content?: Array<{ type: string; text: string }>;
		terminate?: boolean;
	}>;
};

test("experimental mode keeps singular registration and exposes canonical queue completions", async () => {
	const harness = await createHarness();
	assert.deepEqual([...harness.mock.commands.keys()], ["goal"]);
	assert.deepEqual(
		harness.mock.tools.map(({ name }) => name),
		["goal_complete", "goal_blocked"],
	);
	assert.equal(harness.mock.commands.has("goals"), false);
	assert.deepEqual(
		(
			harness.mock.commands.get("goal")?.getArgumentCompletions?.("") as
				| Array<{ label: string }>
				| undefined
		)?.map(({ label }) => label),
		[
			"pause",
			"resume",
			"clear",
			"edit",
			"status",
			"add",
			"prioritize",
			"drop-last",
			"skip",
			"--tokens",
		],
	);
	assert.ok(
		harness.notifications.some(
			({ message, level }) => level === "warning" && /experimental.*goals/i.test(message),
		),
	);
});

test("add, prioritize, drop-last, and skip mutate one singular goal queue", async () => {
	let idle = false;
	const harness = await createHarness({ isIdle: () => idle });
	await harness.command("first goal");
	await harness.command("add --tokens 2k last goal");
	assert.deepEqual(stateGoals(harness.mock).map(summary), [
		{ text: "first goal", status: "active", tokenBudget: undefined },
		{ text: "last goal", status: "queued", tokenBudget: 2_000 },
	]);

	await harness.command("prioritize urgent goal");
	assert.equal(lastState(harness.mock)?.pendingAction?.kind, "prioritize");
	assert.deepEqual(
		stateGoals(harness.mock).map(({ text }) => text),
		["first goal", "last goal"],
	);

	idle = true;
	await settled(harness);
	assert.deepEqual(
		stateGoals(harness.mock).map(({ text, status }) => ({ text, status })),
		[
			{ text: "urgent goal", status: "active" },
			{ text: "first goal", status: "queued" },
			{ text: "last goal", status: "queued" },
		],
	);

	await harness.command("drop-last");
	assert.deepEqual(
		stateGoals(harness.mock).map(({ text }) => text),
		["urgent goal", "first goal"],
	);

	idle = false;
	await harness.command("skip");
	assert.equal(lastState(harness.mock)?.pendingAction?.kind, "advance");
	idle = true;
	await settled(harness);
	assert.deepEqual(
		stateGoals(harness.mock).map(({ text, status }) => ({ text, status })),
		[{ text: "first goal", status: "active" }],
	);
});

test("compatibility aliases route through the canonical queue operations", async () => {
	const harness = await createHarness();
	await harness.command("head");
	await harness.command("push tail");
	await harness.command("unshift urgent");
	assert.deepEqual(
		stateGoals(harness.mock).map(({ text }) => text),
		["urgent", "head", "tail"],
	);
	await harness.command("pop");
	assert.deepEqual(
		stateGoals(harness.mock).map(({ text }) => text),
		["urgent", "head"],
	);
	await harness.command("shift");
	assert.deepEqual(
		stateGoals(harness.mock).map(({ text }) => text),
		["head"],
	);
});

test("goal_complete advances only after the finishing run settles", async () => {
	const harness = await createHarness();
	await harness.command("first goal");
	await harness.command("add second goal");
	const first = stateGoals(harness.mock)[0];
	assert.ok(first);

	const result = await completionTool(harness.mock).execute(
		"complete-first",
		{ goal_id: first.id, summary: "First goal completed and verified." },
		new AbortController().signal,
		() => undefined,
		harness.ctx,
	);
	assert.equal(result.terminate, true);
	assert.deepEqual(
		stateGoals(harness.mock).map(({ text, status }) => ({ text, status })),
		[
			{ text: "first goal", status: "complete" },
			{ text: "second goal", status: "queued" },
		],
	);

	await harness.mock.events.get("agent_end")?.[0]?.(
		{ messages: [{ role: "assistant", stopReason: "toolUse" }] },
		harness.ctx,
	);
	assert.equal(stateGoals(harness.mock)[0]?.status, "complete");
	await settled(harness);
	assert.deepEqual(
		stateGoals(harness.mock).map(({ text, status }) => ({ text, status })),
		[{ text: "second goal", status: "active" }],
	);
});

test("pending completion advance survives reload before settlement", async () => {
	const interrupted = await createHarness({ isIdle: () => false });
	await interrupted.command("first goal");
	await interrupted.command("add second goal");
	const first = stateGoals(interrupted.mock)[0];
	assert.ok(first);
	await completionTool(interrupted.mock).execute(
		"complete-before-reload",
		{ goal_id: first.id, summary: "First goal completed and verified." },
		new AbortController().signal,
		() => undefined,
		interrupted.ctx,
	);
	const persisted = lastState(interrupted.mock);
	assert.equal(persisted?.pendingAction?.kind, "advance");

	const branch = [{ type: "custom", customType: "goal-state", data: persisted }];
	const restored = await createHarness({
		sessionManager: { getBranch: () => branch, getEntries: () => branch },
	});
	assert.deepEqual(
		stateGoals(restored.mock).map(({ text, status }) => ({ text, status })),
		[{ text: "second goal", status: "active" }],
	);
});

test("busy prioritize preserves intent and excludes old-run tokens from the urgent goal", async () => {
	const branch: Array<Record<string, unknown>> = [assistantUsageEntry(100)];
	let idle = false;
	const harness = await createHarness({
		isIdle: () => idle,
		sessionManager: { getBranch: () => branch, getEntries: () => branch },
	});
	await harness.command("original goal");
	branch.push(assistantUsageEntry(40));
	await harness.command("prioritize urgent goal");
	branch.push(assistantUsageEntry(30));
	await harness.mock.events.get("agent_end")?.[0]?.(
		{ messages: [{ role: "assistant", stopReason: "stop" }] },
		harness.ctx,
	);
	assert.equal(stateGoals(harness.mock)[0]?.tokensUsed, 70);

	idle = true;
	await settled(harness);
	const goals = stateGoals(harness.mock);
	assert.equal(goals[0]?.text, "urgent goal");
	assert.equal(goals[0]?.iteration, 0);
	assert.equal(goals[0]?.tokensUsed, 0);
	assert.equal(goals[1]?.text, "original goal");
	assert.equal(goals[1]?.tokensUsed, 70);
});

test("a completed head is dropped when a busy prioritize intent wins", async () => {
	let idle = false;
	const harness = await createHarness({ isIdle: () => idle });
	await harness.command("finishing goal");
	await harness.command("add later goal");
	await harness.command("prioritize urgent goal");
	const finishing = stateGoals(harness.mock)[0];
	assert.ok(finishing);

	await completionTool(harness.mock).execute(
		"complete-before-priority",
		{ goal_id: finishing.id, summary: "Finishing goal completed and verified." },
		new AbortController().signal,
		() => undefined,
		harness.ctx,
	);
	assert.equal(lastState(harness.mock)?.pendingAction?.kind, "prioritize");

	idle = true;
	await settled(harness);
	assert.deepEqual(
		stateGoals(harness.mock).map(({ text, status }) => ({ text, status })),
		[
			{ text: "urgent goal", status: "active" },
			{ text: "later goal", status: "queued" },
		],
	);
});

test("pending priority survives reload after the displaced head completes", async () => {
	const interrupted = await createHarness({ isIdle: () => false });
	await interrupted.command("finishing goal");
	await interrupted.command("add later goal");
	await interrupted.command("prioritize urgent goal");
	const finishing = stateGoals(interrupted.mock)[0];
	assert.ok(finishing);
	await completionTool(interrupted.mock).execute(
		"complete-before-reload",
		{ goal_id: finishing.id, summary: "Finishing goal completed and verified." },
		new AbortController().signal,
		() => undefined,
		interrupted.ctx,
	);
	const persisted = lastState(interrupted.mock);
	assert.equal(persisted?.goal?.status, "complete");
	assert.equal(persisted?.pendingAction?.kind, "prioritize");

	const branch = [{ type: "custom", customType: "goal-state", data: persisted }];
	const restored = await createHarness({
		sessionManager: { getBranch: () => branch, getEntries: () => branch },
	});
	assert.deepEqual(
		stateGoals(restored.mock).map(({ text, status }) => ({ text, status })),
		[
			{ text: "urgent goal", status: "active" },
			{ text: "later goal", status: "queued" },
		],
	);
});

test("completed head retains pending priority when terminal tools are temporarily unavailable", async () => {
	let idle = false;
	const interrupted = await createHarness({ isIdle: () => idle });
	await interrupted.command("finishing goal");
	await interrupted.command("add later goal");
	await interrupted.command("prioritize urgent goal");
	const finishing = stateGoals(interrupted.mock)[0];
	assert.ok(finishing);
	await completionTool(interrupted.mock).execute(
		"complete-before-tool-policy",
		{ goal_id: finishing.id, summary: "Finishing goal completed and verified." },
		new AbortController().signal,
		() => undefined,
		interrupted.ctx,
	);

	interrupted.mock.rawPi.setActiveTools(["goal_complete"]);
	idle = true;
	await settled(interrupted);
	const retained = lastState(interrupted.mock);
	assert.equal(retained?.goal?.status, "complete");
	assert.equal(retained?.pendingAction?.kind, "prioritize");

	const branch = [{ type: "custom", customType: "goal-state", data: retained }];
	const restored = await createHarness({
		sessionManager: { getBranch: () => branch, getEntries: () => branch },
	});
	assert.deepEqual(
		stateGoals(restored.mock).map(({ text }) => text),
		["urgent goal", "later goal"],
	);
});

test("pending prioritize survives abrupt reload and starts before the displaced head", async () => {
	const interrupted = await createHarness({ isIdle: () => false });
	await interrupted.command("original goal");
	await interrupted.command("prioritize urgent goal");
	const persisted = lastState(interrupted.mock);
	assert.equal(persisted?.pendingAction?.kind, "prioritize");

	const branch = [{ type: "custom", customType: "goal-state", data: persisted }];
	const restored = await createHarness({
		sessionManager: { getBranch: () => branch, getEntries: () => branch },
	});
	assert.deepEqual(
		stateGoals(restored.mock).map(({ text, status }) => ({ text, status })),
		[
			{ text: "urgent goal", status: "active" },
			{ text: "original goal", status: "queued" },
		],
	);
});

test("pending prioritize survives shutdown with independent accounting", async () => {
	const branch: Array<Record<string, unknown>> = [assistantUsageEntry(100)];
	const interrupted = await createHarness({
		isIdle: () => false,
		sessionManager: { getBranch: () => branch, getEntries: () => branch },
	});
	await interrupted.command("original goal");
	branch.push(assistantUsageEntry(25));
	await interrupted.command("prioritize urgent goal");
	await interrupted.mock.events.get("session_shutdown")?.[0]?.({}, interrupted.ctx);
	const persisted = lastState(interrupted.mock);
	assert.equal(persisted?.pendingAction?.kind, "prioritize");
	assert.equal(persisted?.goal?.tokensUsed, 25);

	const restoredBranch = [
		assistantUsageEntry(100),
		assistantUsageEntry(25),
		{ type: "custom", customType: "goal-state", data: persisted },
	];
	const restored = await createHarness({
		sessionManager: { getBranch: () => restoredBranch, getEntries: () => restoredBranch },
	});
	assert.deepEqual(
		stateGoals(restored.mock).map(({ text, status }) => ({ text, status })),
		[
			{ text: "urgent goal", status: "active" },
			{ text: "original goal", status: "queued" },
		],
	);
	assert.equal(stateGoals(restored.mock)[1]?.tokensUsed, 25);
});

test("stopped displaced goals remain stopped after the priority goal completes", async () => {
	const harness = await createHarness();
	await harness.command("paused original");
	await harness.command("pause");
	await harness.command("prioritize urgent fix");
	const urgent = stateGoals(harness.mock)[0];
	assert.ok(urgent);
	const promptsBeforeCompletion = harness.mock.sentUserMessages.length;

	await completionTool(harness.mock).execute(
		"complete-urgent",
		{ goal_id: urgent.id, summary: "Urgent fix completed and verified." },
		new AbortController().signal,
		() => undefined,
		harness.ctx,
	);
	await settled(harness);
	assert.deepEqual(
		stateGoals(harness.mock).map(({ text, status }) => ({ text, status })),
		[{ text: "paused original", status: "paused" }],
	);
	assert.equal(harness.mock.sentUserMessages.length, promptsBeforeCompletion);
});

test("resumed displaced goals exclude tokens spent on the priority goal", async () => {
	const branch: Array<Record<string, unknown>> = [assistantUsageEntry(100)];
	const harness = await createHarness({
		sessionManager: { getBranch: () => branch, getEntries: () => branch },
	});
	await harness.command("original goal");
	branch.push(assistantUsageEntry(40));
	await harness.command("pause");
	await harness.command("prioritize urgent goal");
	const urgent = stateGoals(harness.mock)[0];
	assert.ok(urgent);
	branch.push(assistantUsageEntry(30));
	await completionTool(harness.mock).execute(
		"complete-priority-accounting",
		{ goal_id: urgent.id, summary: "Priority goal completed and verified." },
		new AbortController().signal,
		() => undefined,
		harness.ctx,
	);
	await settled(harness);
	await harness.command("resume");
	branch.push(assistantUsageEntry(10));
	await harness.command("");
	assert.equal(stateGoals(harness.mock)[0]?.tokensUsed, 50);
});

test("pending busy skip survives reload without reactivating the old head", async () => {
	const interrupted = await createHarness({ isIdle: () => false });
	await interrupted.command("old head");
	await interrupted.command("add next head");
	await interrupted.command("skip");
	const persisted = lastState(interrupted.mock);
	assert.equal(persisted?.pendingAction?.kind, "advance");

	const branch = [{ type: "custom", customType: "goal-state", data: persisted }];
	const restored = await createHarness({
		sessionManager: { getBranch: () => branch, getEntries: () => branch },
	});
	assert.deepEqual(
		stateGoals(restored.mock).map(({ text, status }) => ({ text, status })),
		[{ text: "next head", status: "active" }],
	);
});

test("a pending busy skip suppresses the old goal prompt before advancement", async () => {
	const harness = await createHarness({ isIdle: () => false });
	await harness.command("old head");
	await harness.command("add next head");
	await harness.command("skip");
	const beforeStart = harness.mock.events.get("before_agent_start")?.[0];
	const result = await beforeStart?.(
		{ prompt: "newer unrelated work", systemPrompt: "base" },
		harness.ctx,
	);
	assert.equal(result, undefined);
});

test("pending skip rejects stale completion without rewriting the skip intent", async () => {
	let idle = false;
	const harness = await createHarness({ isIdle: () => idle });
	await harness.command("old head");
	await harness.command("add next head");
	const oldHead = stateGoals(harness.mock)[0];
	assert.ok(oldHead);
	await harness.command("skip");

	const result = await completionTool(harness.mock).execute(
		"complete-after-skip",
		{ goal_id: oldHead.id, summary: "Old head completed and verified." },
		new AbortController().signal,
		() => undefined,
		harness.ctx,
	);
	assert.equal(result.terminate, true);
	assert.match(result.content?.[0]?.text ?? "", /queued to be skipped/i);
	assert.equal(lastState(harness.mock)?.goal?.status, "active");
	assert.deepEqual(lastState(harness.mock)?.pendingAction, {
		kind: "advance",
		goalId: oldHead.id,
		reason: "skip",
		completedText: "old head",
	});

	idle = true;
	await settled(harness);
	assert.deepEqual(
		stateGoals(harness.mock).map(({ text }) => text),
		["next head"],
	);
});

test("pending skip rejects stale blocked reports without rewriting terminal state", async () => {
	let idle = false;
	const harness = await createHarness({ isIdle: () => idle });
	await harness.command("old head");
	await harness.command("add next head");
	const oldHead = stateGoals(harness.mock)[0];
	assert.ok(oldHead);
	await harness.command("skip");

	const result = await blockedTool(harness.mock).execute(
		"block-after-skip",
		{
			goal_id: oldHead.id,
			reason: "External access required",
			evidence: "Three verified attempts require external access.",
			repeated_turns: 3,
		},
		new AbortController().signal,
		() => undefined,
		harness.ctx,
	);
	assert.equal(result.terminate, true);
	assert.match(result.content?.[0]?.text ?? "", /queued to be skipped/i);
	assert.equal(lastState(harness.mock)?.goal?.status, "active");
	assert.equal(lastState(harness.mock)?.pendingAction?.kind, "advance");

	idle = true;
	await settled(harness);
	assert.deepEqual(
		stateGoals(harness.mock).map(({ text }) => text),
		["next head"],
	);
});

test("manual compaction dispatches pending priority instead of the old continuation", async () => {
	const branch: Array<Record<string, unknown>> = [];
	let idle = true;
	const harness = await createHarness({
		isIdle: () => idle,
		sessionManager: { getBranch: () => branch, getEntries: () => branch },
	});
	await harness.command("old head");
	await harness.command("add tail");
	idle = false;
	await harness.command("prioritize urgent head");
	const state = lastState(harness.mock);
	branch.push({ type: "custom", customType: "goal-state", data: state });
	idle = true;
	await harness.mock.events.get("session_compact")?.[0]?.(
		{ reason: "manual", willRetry: false },
		harness.ctx,
	);
	assert.deepEqual(
		stateGoals(harness.mock).map(({ text }) => text),
		["urgent head", "old head", "tail"],
	);
	assert.doesNotMatch(harness.mock.sentUserMessages.at(-1)?.text ?? "", /pi-goal-continuation:/i);
});

test("retry and compaction lifecycle snapshots preserve the queued tail", async () => {
	const branch: Array<Record<string, unknown>> = [assistantUsageEntry(0)];
	const harness = await createHarness({
		sessionManager: { getBranch: () => branch, getEntries: () => branch },
	});
	await harness.command("head");
	await harness.command("add tail");
	await harness.mock.events.get("agent_end")?.[0]?.(
		{
			messages: [
				{ role: "assistant", stopReason: "error", errorMessage: "rate limit; please retry" },
			],
		},
		harness.ctx,
	);
	assert.deepEqual(
		stateGoals(harness.mock).map(({ text, status }) => ({ text, status })),
		[
			{ text: "head", status: "active" },
			{ text: "tail", status: "queued" },
		],
	);

	const state = lastState(harness.mock);
	branch.push({ type: "custom", customType: "goal-state", data: state });
	await harness.mock.events.get("session_compact")?.[0]?.(
		{ reason: "manual", willRetry: false },
		harness.ctx,
	);
	assert.deepEqual(
		stateGoals(harness.mock).map(({ text }) => text),
		["head", "tail"],
	);
});

test("budget limiting the head preserves the queued tail", async () => {
	const branch: Array<Record<string, unknown>> = [assistantUsageEntry(0)];
	const harness = await createHarness({
		sessionManager: { getBranch: () => branch, getEntries: () => branch },
	});
	await harness.command("--tokens 10 budgeted head");
	await harness.command("add later goal");
	branch.push(assistantUsageEntry(12));
	await harness.mock.events.get("tool_execution_end")?.[0]?.({}, harness.ctx);
	assert.deepEqual(
		stateGoals(harness.mock).map(({ text, status }) => ({ text, status })),
		[
			{ text: "budgeted head", status: "budget_limited" },
			{ text: "later goal", status: "queued" },
		],
	);
});

test("failed priority delivery restores and pauses the previous active head", async () => {
	const harness = await createHarness();
	await harness.command("original goal");
	harness.mock.rawPi.sendUserMessage = () => {
		throw new Error("priority delivery unavailable");
	};
	await harness.command("prioritize urgent goal");
	assert.deepEqual(
		stateGoals(harness.mock).map(({ text, status }) => ({ text, status })),
		[{ text: "original goal", status: "paused" }],
	);
	assert.equal(lastState(harness.mock)?.pendingAction, undefined);
});

test("failed priority tool preparation clears intent and pauses the active head", async () => {
	const harness = await createHarness();
	await harness.command("original goal");
	harness.mock.rawPi.setActiveTools(["goal_complete"]);
	await harness.command("prioritize urgent goal");
	assert.deepEqual(
		stateGoals(harness.mock).map(({ text, status }) => ({ text, status })),
		[{ text: "original goal", status: "paused" }],
	);
	assert.equal(lastState(harness.mock)?.pendingAction, undefined);
});

test("an old head id cannot complete the newly activated goal", async () => {
	const harness = await createHarness();
	await harness.command("first goal");
	await harness.command("add second goal");
	const first = stateGoals(harness.mock)[0];
	assert.ok(first);
	await completionTool(harness.mock).execute(
		"complete-first-for-stale-id",
		{ goal_id: first.id, summary: "First goal completed and verified." },
		new AbortController().signal,
		() => undefined,
		harness.ctx,
	);
	await settled(harness);
	const stale = await completionTool(harness.mock).execute(
		"stale-completion",
		{ goal_id: first.id, summary: "Second goal completed and verified." },
		new AbortController().signal,
		() => undefined,
		harness.ctx,
	);
	assert.match(stale.content?.[0]?.text ?? "", /goal_id does not match/i);
	assert.equal(stateGoals(harness.mock)[0]?.text, "second goal");
});

test("failed next-goal delivery pauses the next head without losing it", async () => {
	const harness = await createHarness();
	await harness.command("first goal");
	await harness.command("add second goal");
	const first = stateGoals(harness.mock)[0];
	assert.ok(first);
	await completionTool(harness.mock).execute(
		"complete-first-before-failure",
		{ goal_id: first.id, summary: "First goal completed and verified." },
		new AbortController().signal,
		() => undefined,
		harness.ctx,
	);
	harness.mock.rawPi.sendUserMessage = () => {
		throw new Error("delivery unavailable");
	};
	await settled(harness);
	assert.deepEqual(
		stateGoals(harness.mock).map(({ text, status }) => ({ text, status })),
		[{ text: "second goal", status: "paused" }],
	);
});

test("a restrictive tool policy pauses the next queued head", async () => {
	const harness = await createHarness();
	await harness.command("first goal");
	await harness.command("add second goal");
	const first = stateGoals(harness.mock)[0];
	assert.ok(first);
	await completionTool(harness.mock).execute(
		"complete-before-policy",
		{ goal_id: first.id, summary: "First goal completed and verified." },
		new AbortController().signal,
		() => undefined,
		harness.ctx,
	);
	harness.mock.rawPi.setActiveTools(["goal_complete"]);
	await settled(harness);
	assert.deepEqual(
		stateGoals(harness.mock).map(({ text, status }) => ({ text, status })),
		[{ text: "second goal", status: "paused" }],
	);
});

test("separate factory runtimes keep independent queues", async () => {
	const root = await createHarness();
	const child = await createHarness();
	await root.command("root head");
	await root.command("add root tail");
	await child.command("child head");
	await child.command("add child tail");

	const rootHead = stateGoals(root.mock)[0];
	assert.ok(rootHead);
	await completionTool(root.mock).execute(
		"complete-root",
		{ goal_id: rootHead.id, summary: "Root head completed and verified." },
		new AbortController().signal,
		() => undefined,
		root.ctx,
	);
	await settled(root);
	assert.deepEqual(
		stateGoals(root.mock).map(({ text }) => text),
		["root tail"],
	);
	assert.deepEqual(
		stateGoals(child.mock).map(({ text }) => text),
		["child head", "child tail"],
	);
});

test("disabled settings freeze retained queues without losing state", async () => {
	const frozenState: GoalStateEntryData = {
		goal: storedGoal("head", "active"),
		queue: [storedGoal("later", "queued")],
	};
	const branch = [{ type: "custom", customType: "goal-state", data: frozenState }];
	const harness = await createHarness(
		{ sessionManager: { getBranch: () => branch, getEntries: () => branch } },
		false,
	);

	assert.equal(harness.statuses.get("goal"), "queue off");
	assert.equal(harness.mock.sentUserMessages.length, 0);
	await harness.command("");
	assert.match(harness.notifications.at(-1)?.message ?? "", /queue.*off|re-enable/i);
	await harness.command("resume");
	assert.match(harness.notifications.at(-1)?.message ?? "", /re-enable.*reload/i);
	assert.equal(lastState(harness.mock)?.queue?.[0]?.text, "later");

	const retained = lastState(harness.mock);
	assert.ok(retained);
	const restoredBranch = [{ type: "custom", customType: "goal-state", data: retained }];
	const restored = await createHarness({
		sessionManager: { getBranch: () => restoredBranch, getEntries: () => restoredBranch },
	});
	assert.equal(restored.statuses.get("goal"), "active 0s");
	assert.deepEqual(
		stateGoals(restored.mock).map(({ text }) => text),
		["head", "later"],
	);

	await harness.command("clear");
	assert.deepEqual(lastState(harness.mock), { goal: null });
});

async function createHarness(overrides: Record<string, unknown> = {}, enabled = true) {
	const mock = createMockPi({ activeTools: ["goal_complete", "goal_blocked"] });
	goal(mock.pi, { settingsPath: enabled ? enabledSettingsPath : disabledSettingsPath });
	const context = createMockContext(overrides);
	await mock.events.get("session_start")?.[0]?.({}, context.ctx);
	return {
		mock,
		...context,
		command: async (args: string) => mock.commands.get("goal")?.handler(args, context.ctx),
	};
}

async function settled(harness: Awaited<ReturnType<typeof createHarness>>) {
	await harness.mock.events.get("agent_settled")?.[0]?.({}, harness.ctx);
}

function completionTool(mock: ReturnType<typeof createMockPi>) {
	return findGoalTool(mock, "goal_complete");
}

function blockedTool(mock: ReturnType<typeof createMockPi>) {
	return findGoalTool(mock, "goal_blocked");
}

function findGoalTool(mock: ReturnType<typeof createMockPi>, name: string) {
	const tool = mock.tools.find((candidate) => candidate.name === name);
	assert.ok(tool);
	return tool as GoalTool;
}

function lastState(mock: ReturnType<typeof createMockPi>) {
	return mock.entries.filter(({ customType }) => customType === "goal-state").at(-1)?.data as
		| GoalStateEntryData
		| undefined;
}

function stateGoals(mock: ReturnType<typeof createMockPi>): ActiveGoal[] {
	const state = lastState(mock);
	assert.ok(state?.goal);
	return [state.goal, ...(state.queue ?? [])];
}

function summary({ text, status, tokenBudget }: ActiveGoal) {
	return { text, status, tokenBudget };
}

function assistantUsageEntry(totalTokens: number) {
	return { type: "message", message: { role: "assistant", usage: { totalTokens } } };
}

function storedGoal(text: string, status: ActiveGoal["status"]): ActiveGoal {
	return {
		id: `${text}-id`,
		text,
		status,
		startedAt: 1,
		updatedAt: 1,
		iteration: 0,
		tokensUsed: 0,
		timeUsedSeconds: 0,
		baselineTokens: 0,
		...(status === "active" ? { activeStartedAt: 1 } : {}),
	};
}
