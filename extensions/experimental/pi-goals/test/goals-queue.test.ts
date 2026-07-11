import assert from "node:assert/strict";
import test from "node:test";
import { createMockContext, createMockPi } from "../../../../test/support.js";
import goals, { completeGoalsArguments, parseCommand } from "../src/goals.js";

type StoredGoal = {
	id: string;
	text: string;
	status: string;
	iteration?: number;
	tokenBudget?: number;
	tokensUsed?: number;
	baselineTokens?: number;
};

type GoalTool = {
	execute: (...args: unknown[]) => Promise<{
		content?: Array<{ type: string; text: string }>;
		terminate?: boolean;
	}>;
};

test("queue commands parse like TypeScript array operations", () => {
	assert.deepEqual(parseCommand("push --tokens 2k later work"), {
		kind: "push",
		objective: "later work",
		tokenBudget: 2_000,
	});
	assert.deepEqual(parseCommand("unshift urgent work"), {
		kind: "unshift",
		objective: "urgent work",
		tokenBudget: undefined,
	});
	assert.deepEqual(parseCommand("pop"), { kind: "pop" });
	assert.deepEqual(parseCommand("shift"), { kind: "shift" });
	assert.equal(parseCommand("pop now"), "Usage: /goals pop");
	assert.equal(parseCommand("push"), "Usage: /goals push <goal_to_complete>");

	assert.deepEqual(
		completeGoalsArguments("")?.map((item) => item.label),
		["pause", "resume", "clear", "edit", "status", "push", "unshift", "pop", "shift", "--tokens"],
	);
	assert.deepEqual(
		completeGoalsArguments("push ")?.map((item) => item.value),
		["push --tokens "],
	);
});

test("push, unshift, pop, and shift mutate the queue in array order", async () => {
	let idle = false;
	const harness = createHarness({ isIdle: () => idle });
	await harness.command("first goal");
	await harness.command("push --tokens 2k last goal");

	let goals = requireGoals(harness.mock);
	assert.deepEqual(
		goals.map(({ text, status, tokenBudget }) => ({ text, status, tokenBudget })),
		[
			{ text: "first goal", status: "active", tokenBudget: undefined },
			{ text: "last goal", status: "queued", tokenBudget: 2_000 },
		],
	);
	assert.equal(harness.mock.sentUserMessages.length, 1, "push must not interrupt the head goal");

	await harness.command("unshift urgent goal");
	assert.deepEqual(
		requireGoals(harness.mock).map((queuedGoal) => queuedGoal.text),
		["first goal", "last goal"],
	);
	idle = true;
	await harness.mock.events.get("agent_settled")?.[0]?.({}, harness.ctx);
	goals = requireGoals(harness.mock);
	assert.deepEqual(
		goals.map(({ text, status }) => ({ text, status })),
		[
			{ text: "urgent goal", status: "active" },
			{ text: "first goal", status: "queued" },
			{ text: "last goal", status: "queued" },
		],
	);
	assert.match(harness.mock.sentUserMessages.at(-1)?.text ?? "", /urgent goal/);
	assert.equal(harness.mock.sentUserMessages.at(-1)?.options, undefined);

	await harness.command("pop");
	assert.deepEqual(
		requireGoals(harness.mock).map((queuedGoal) => queuedGoal.text),
		["urgent goal", "first goal"],
	);

	const removedId = requireGoals(harness.mock)[0]?.id;
	await harness.command("shift");
	goals = requireGoals(harness.mock);
	assert.deepEqual(
		goals.map(({ text, status }) => ({ text, status })),
		[{ text: "first goal", status: "active" }],
	);
	assert.notEqual(goals[0]?.id, removedId);
	assert.match(harness.mock.sentUserMessages.at(-1)?.text ?? "", /first goal/);
	assert.equal(harness.mock.sentUserMessages.at(-1)?.options, undefined);
	assert.match(
		harness.notifications.at(-1)?.message ?? "",
		/shifted.*urgent goal.*started.*first goal/i,
	);
});

test("goals_complete advances to the next queued goal and clears after the last", async () => {
	const harness = createHarness();
	await harness.command("first goal");
	await harness.command("push second goal");
	const first = requireGoals(harness.mock)[0];
	assert.ok(first);

	const firstResult = await completionTool(harness.mock).execute(
		"complete-first",
		{ goal_id: first.id, summary: "First goal completed and verified." },
		new AbortController().signal,
		() => undefined,
		harness.ctx,
	);
	assert.equal(firstResult.terminate, true);
	assert.deepEqual(
		requireGoals(harness.mock).map(({ text, status }) => ({ text, status })),
		[
			{ text: "first goal", status: "complete" },
			{ text: "second goal", status: "queued" },
		],
	);
	await harness.mock.events.get("agent_end")?.[0]?.(
		{ messages: [{ role: "assistant", stopReason: "toolUse" }] },
		harness.ctx,
	);
	assert.equal(requireGoals(harness.mock)[0]?.status, "complete");
	await harness.mock.events.get("agent_settled")?.[0]?.({}, harness.ctx);
	const goals = requireGoals(harness.mock);
	assert.deepEqual(
		goals.map(({ text, status }) => ({ text, status })),
		[{ text: "second goal", status: "active" }],
	);
	assert.match(harness.mock.sentUserMessages.at(-1)?.text ?? "", /second goal/);
	assert.equal(harness.mock.sentUserMessages.at(-1)?.options, undefined);

	const second = goals[0];
	assert.ok(second);
	await completionTool(harness.mock).execute(
		"complete-second",
		{ goal_id: second.id, summary: "Second goal completed and verified." },
		new AbortController().signal,
		() => undefined,
		harness.ctx,
	);
	assert.deepEqual(requireGoals(harness.mock), []);
	assert.equal(harness.statuses.get("goals"), "complete");
});

test("an interrupted head keeps its stopped state after an urgent unshift goal completes", async () => {
	const harness = createHarness();
	await harness.command("paused original");
	await harness.command("pause");
	await harness.command("unshift urgent fix");
	const urgent = requireGoals(harness.mock)[0];
	assert.ok(urgent);
	const promptsBeforeCompletion = harness.mock.sentUserMessages.length;

	await completionTool(harness.mock).execute(
		"complete-urgent",
		{ goal_id: urgent.id, summary: "Urgent fix completed and verified." },
		new AbortController().signal,
		() => undefined,
		harness.ctx,
	);
	await harness.mock.events.get("agent_settled")?.[0]?.({}, harness.ctx);

	assert.deepEqual(
		requireGoals(harness.mock).map(({ text, status }) => ({ text, status })),
		[{ text: "paused original", status: "paused" }],
	);
	assert.equal(harness.mock.sentUserMessages.length, promptsBeforeCompletion);
	assert.equal(harness.statuses.get("goals"), "paused");
	assert.match(harness.notifications.at(-1)?.message ?? "", /next goal remains paused/i);
});

test("preempted goal accounting excludes tokens spent on the urgent goal", async () => {
	const branch: Array<Record<string, unknown>> = [assistantUsageEntry(100)];
	const harness = createHarness({
		sessionManager: { getBranch: () => branch, getEntries: () => branch },
	});
	await harness.command("original goal");
	branch.push(assistantUsageEntry(40));
	await harness.command("unshift urgent goal");
	assert.equal(requireGoals(harness.mock)[1]?.tokensUsed, 40);
	const urgent = requireGoals(harness.mock)[0];
	assert.ok(urgent);

	branch.push(assistantUsageEntry(30));
	await completionTool(harness.mock).execute(
		"complete-accounting-urgent",
		{ goal_id: urgent.id, summary: "Urgent goal completed and verified." },
		new AbortController().signal,
		() => undefined,
		harness.ctx,
	);
	await harness.mock.events.get("agent_settled")?.[0]?.({}, harness.ctx);
	branch.push(assistantUsageEntry(10));
	await harness.command("");

	const resumed = requireGoals(harness.mock)[0] as StoredGoal & { tokensUsed?: number };
	assert.equal(resumed.text, "original goal");
	assert.equal(resumed.tokensUsed, 50);
});

test("busy unshift does not charge or increment the urgent goal before its prompt starts", async () => {
	const branch: Array<Record<string, unknown>> = [assistantUsageEntry(100)];
	let idle = false;
	const harness = createHarness({
		isIdle: () => idle,
		sessionManager: { getBranch: () => branch, getEntries: () => branch },
	});
	await harness.command("original goal");
	branch.push(assistantUsageEntry(40));
	await harness.command("unshift urgent goal");
	assert.equal(harness.mock.sentUserMessages.length, 1);

	branch.push(assistantUsageEntry(30));
	await harness.mock.events.get("agent_end")?.[0]?.(
		{ messages: [{ role: "assistant", stopReason: "stop" }] },
		harness.ctx,
	);
	let goals = requireGoals(harness.mock);
	assert.equal(goals[0]?.text, "original goal");
	assert.equal(goals[0]?.iteration, 1);
	assert.equal(goals[0]?.tokensUsed, 70);

	idle = true;
	await harness.mock.events.get("agent_settled")?.[0]?.({}, harness.ctx);
	goals = requireGoals(harness.mock);
	assert.equal(goals[0]?.text, "urgent goal");
	assert.equal(goals[0]?.iteration, 0);
	assert.equal(goals[0]?.tokensUsed, 0);
	assert.equal(goals[1]?.text, "original goal");
	assert.equal(goals[1]?.tokensUsed, 70);
	assert.equal(harness.mock.sentUserMessages.length, 2);

	branch.push(assistantUsageEntry(10));
	await harness.command("");
	goals = requireGoals(harness.mock);
	assert.equal(goals[0]?.tokensUsed, 10);
});

test("busy unshift survives an abrupt reload without session_shutdown", async () => {
	const harness = createHarness({ isIdle: () => false });
	await harness.command("original goal");
	await harness.command("unshift urgent goal");
	const interruptedState = lastGoalState(harness.mock);
	assert.deepEqual(interruptedState?.pendingUnshift, {
		objective: "urgent goal",
		tokenBudget: undefined,
	});

	const restored = createHarness({}, goalStateBranch(interruptedState ?? {}));
	assert.deepEqual(
		requireGoals(restored.mock).map(({ text, status }) => ({ text, status })),
		[
			{ text: "urgent goal", status: "active" },
			{ text: "original goal", status: "queued" },
		],
	);
	assert.match(restored.mock.sentUserMessages.at(-1)?.text ?? "", /urgent goal/);
});

test("busy unshift survives shutdown and starts first after reload", async () => {
	const branch: Array<Record<string, unknown>> = [assistantUsageEntry(100)];
	const harness = createHarness({
		isIdle: () => false,
		sessionManager: { getBranch: () => branch, getEntries: () => branch },
	});
	await harness.command("original goal");
	branch.push(assistantUsageEntry(25));
	await harness.command("unshift urgent goal");

	harness.mock.events.get("session_shutdown")?.[0]?.({}, harness.ctx);
	const shutdownState = lastGoalState(harness.mock);
	assert.deepEqual(
		shutdownState?.goals?.map(({ text, status }) => ({ text, status })),
		[
			{ text: "urgent goal", status: "queued" },
			{ text: "original goal", status: "queued" },
		],
	);
	assert.equal(shutdownState?.goals?.[1]?.tokensUsed, 25);

	const restored = createHarness({}, goalStateBranch(shutdownState ?? {}));
	assert.deepEqual(
		requireGoals(restored.mock).map(({ text, status }) => ({ text, status })),
		[
			{ text: "urgent goal", status: "active" },
			{ text: "original goal", status: "queued" },
		],
	);
	assert.match(restored.mock.sentUserMessages.at(-1)?.text ?? "", /urgent goal/);
});

test("busy unshift drops a concurrently completed head but preserves its queue on shutdown", async () => {
	const harness = createHarness({ isIdle: () => false });
	await harness.command("finishing goal");
	await harness.command("push later goal");
	await harness.command("unshift urgent goal");
	const finishing = requireGoals(harness.mock)[0];
	assert.ok(finishing);
	await completionTool(harness.mock).execute(
		"complete-before-shutdown",
		{ goal_id: finishing.id, summary: "Finishing goal completed and verified." },
		new AbortController().signal,
		() => undefined,
		harness.ctx,
	);

	harness.mock.events.get("session_shutdown")?.[0]?.({}, harness.ctx);
	assert.deepEqual(
		requireGoals(harness.mock).map(({ text, status }) => ({ text, status })),
		[
			{ text: "urgent goal", status: "queued" },
			{ text: "later goal", status: "queued" },
		],
	);
});

test("stopped preempted goal excludes urgent tokens after it is resumed", async () => {
	const branch: Array<Record<string, unknown>> = [assistantUsageEntry(100)];
	const harness = createHarness({
		sessionManager: { getBranch: () => branch, getEntries: () => branch },
	});
	await harness.command("original goal");
	branch.push(assistantUsageEntry(40));
	await harness.command("pause");
	await harness.command("unshift urgent goal");
	const urgent = requireGoals(harness.mock)[0];
	assert.ok(urgent);

	branch.push(assistantUsageEntry(30));
	await completionTool(harness.mock).execute(
		"complete-paused-accounting-urgent",
		{ goal_id: urgent.id, summary: "Urgent goal completed and verified." },
		new AbortController().signal,
		() => undefined,
		harness.ctx,
	);
	await harness.mock.events.get("agent_settled")?.[0]?.({}, harness.ctx);
	assert.equal(requireGoals(harness.mock)[0]?.status, "paused");

	await harness.command("resume");
	branch.push(assistantUsageEntry(10));
	await harness.command("");
	assert.equal(requireGoals(harness.mock)[0]?.tokensUsed, 50);
});

test("queue persistence restores all goals and migrates legacy single-goal state", async () => {
	const queuedBranch = goalStateBranch({
		goals: [
			storedGoal("head", "active"),
			storedGoal("later", "queued"),
			storedGoal("malformed-active-tail", "active"),
		],
	});
	const restored = createHarness({}, queuedBranch);
	assert.deepEqual(
		requireGoals(restored.mock).map(({ text, status }) => ({ text, status })),
		[
			{ text: "head", status: "active" },
			{ text: "later", status: "queued" },
			{ text: "malformed-active-tail", status: "queued" },
		],
	);

	const interruptedAdvanceBranch = goalStateBranch({
		goals: [storedGoal("completed", "complete"), storedGoal("after-reload", "queued")],
	});
	const resumedAdvance = createHarness({}, interruptedAdvanceBranch);
	assert.deepEqual(
		requireGoals(resumedAdvance.mock).map(({ text, status }) => ({ text, status })),
		[{ text: "after-reload", status: "active" }],
	);
	assert.match(resumedAdvance.mock.sentUserMessages.at(-1)?.text ?? "", /after-reload/);

	const legacyBranch = goalStateBranch({ goal: storedGoal("legacy", "active") });
	const migrated = createHarness({}, legacyBranch);
	assert.deepEqual(
		requireGoals(migrated.mock).map(({ text, status }) => ({ text, status })),
		[{ text: "legacy", status: "active" }],
	);
});

function createHarness(overrides: Record<string, unknown> = {}, branch: unknown[] = []) {
	const mock = createMockPi();
	goals(mock.pi);
	const context = createMockContext({
		sessionManager: { getBranch: () => branch, getEntries: () => branch },
		...overrides,
	});
	mock.events.get("session_start")?.[0]?.({}, context.ctx);
	return {
		mock,
		...context,
		command: async (args: string) => mock.commands.get("goals")?.handler(args, context.ctx),
	};
}

function completionTool(mock: ReturnType<typeof createMockPi>) {
	const tool = mock.tools.find((candidate) => candidate.name === "goals_complete");
	assert.ok(tool);
	return tool as GoalTool;
}

function lastGoalState(mock: ReturnType<typeof createMockPi>) {
	return mock.entries.filter((entry) => entry.customType === "goals-state").at(-1)?.data as
		| {
				goals?: StoredGoal[];
				goal?: StoredGoal | null;
				pendingUnshift?: { objective: string; tokenBudget?: number };
		  }
		| undefined;
}

function requireGoals(mock: ReturnType<typeof createMockPi>) {
	const goals = lastGoalState(mock)?.goals;
	assert.ok(goals, "expected persisted goals array");
	return goals;
}

function assistantUsageEntry(totalTokens: number) {
	return { type: "message", message: { role: "assistant", usage: { totalTokens } } };
}

function storedGoal(text: string, status: string): StoredGoal & Record<string, unknown> {
	return {
		id: `${text}-id`,
		text,
		status,
		startedAt: 1,
		updatedAt: 2,
		iteration: 0,
		tokensUsed: 0,
		timeUsedSeconds: 0,
		baselineTokens: 0,
	};
}

function goalStateBranch(data: Record<string, unknown>) {
	return [{ type: "custom", customType: "goals-state", data }];
}
