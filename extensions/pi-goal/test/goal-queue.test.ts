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

test("automatic queue advance preserves a shelved goal safety epoch", async () => {
	const urgent = storedGoal("urgent goal", "active");
	const shelved = {
		...storedGoal("shelved goal", "queued"),
		automaticModelTurns: 7,
		toolFreeRepeatCount: 2,
		lastToolFreeOutputFingerprint: "a".repeat(64),
	};
	const state: GoalStateEntryData = { goal: urgent, queue: [shelved] };
	const branch = [{ type: "custom", customType: "goal-state", data: state }];
	const harness = await createHarness({
		sessionManager: { getBranch: () => branch, getEntries: () => branch },
	});

	await completionTool(harness.mock).execute(
		"complete-urgent-for-safety",
		{ goal_id: urgent.id, summary: "Urgent goal completed and verified." },
		new AbortController().signal,
		() => undefined,
		harness.ctx,
	);
	await settled(harness);
	const activated = stateGoals(harness.mock)[0];
	assert.equal(activated?.text, "shelved goal");
	assert.equal(activated?.automaticModelTurns, 7);
	assert.equal(activated?.toolFreeRepeatCount, 2);
	assert.equal(activated?.lastToolFreeOutputFingerprint, "a".repeat(64));

	const prompt = harness.mock.sentUserMessages.at(-1)?.text ?? "";
	harness.mock.events.get("input")?.[0]?.({ source: "extension", text: prompt }, harness.ctx);
	harness.mock.events.get("before_agent_start")?.[0]?.(
		{ prompt, systemPrompt: "base" },
		harness.ctx,
	);
	const started = stateGoals(harness.mock)[0];
	assert.equal(started?.automaticModelTurns, 7);
	assert.equal(started?.toolFreeRepeatCount, 2);
	assert.equal(started?.lastToolFreeOutputFingerprint, "a".repeat(64));
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

test("pending prioritize does not inject or account the old goal on unrelated turns", async () => {
	const branch: Array<Record<string, unknown>> = [assistantUsageEntry(100)];
	let aborts = 0;
	let idle = false;
	const harness = await createHarness({
		isIdle: () => idle,
		abort: () => {
			aborts += 1;
		},
		sessionManager: { getBranch: () => branch, getEntries: () => branch },
	});
	await harness.command("original goal");
	await harness.command("prioritize urgent goal");

	const beforeStart = harness.mock.events.get("before_agent_start")?.[0];
	const result = await beforeStart?.(
		{ prompt: "unrelated user work", systemPrompt: "base" },
		harness.ctx,
	);
	assert.equal(result, undefined);
	assert.equal(aborts, 0);
	branch.push(assistantUsageEntry(25));

	await harness.mock.events.get("tool_execution_end")?.[0]?.({}, harness.ctx);
	assert.equal(stateGoals(harness.mock)[0]?.tokensUsed, 0);
	await harness.mock.events.get("session_before_compact")?.[0]?.(
		{ reason: "threshold", willRetry: false },
		harness.ctx,
	);
	assert.equal(stateGoals(harness.mock)[0]?.tokensUsed, 0);
	await harness.mock.events.get("session_compact")?.[0]?.(
		{ reason: "threshold", willRetry: false },
		harness.ctx,
	);
	assert.equal(stateGoals(harness.mock)[0]?.tokensUsed, 0);
	await harness.command("");
	assert.equal(stateGoals(harness.mock)[0]?.tokensUsed, 0);

	await harness.mock.events.get("agent_end")?.[0]?.(
		{ messages: [{ role: "assistant", stopReason: "stop" }] },
		harness.ctx,
	);
	assert.equal(stateGoals(harness.mock)[0]?.tokensUsed, 0);
	assert.equal(lastState(harness.mock)?.pendingAction?.kind, "prioritize");

	idle = true;
	await settled(harness);
	assert.deepEqual(
		stateGoals(harness.mock).map(({ text, status, tokensUsed }) => ({ text, status, tokensUsed })),
		[
			{ text: "urgent goal", status: "active", tokensUsed: 0 },
			{ text: "original goal", status: "queued", tokensUsed: 0 },
		],
	);
});

test("pending prioritize excludes unrelated usage during shutdown", async () => {
	const branch: Array<Record<string, unknown>> = [assistantUsageEntry(100)];
	const harness = await createHarness({
		isIdle: () => false,
		sessionManager: { getBranch: () => branch, getEntries: () => branch },
	});
	await harness.command("original goal");
	await harness.command("prioritize urgent goal");
	await harness.mock.events.get("before_agent_start")?.[0]?.(
		{ prompt: "unrelated user work", systemPrompt: "base" },
		harness.ctx,
	);
	branch.push(assistantUsageEntry(25));

	await harness.mock.events.get("session_shutdown")?.[0]?.({}, harness.ctx);
	assert.equal(stateGoals(harness.mock)[0]?.tokensUsed, 0);
	assert.equal(lastState(harness.mock)?.pendingAction?.kind, "prioritize");

	const persisted = lastState(harness.mock);
	const restoredBranch = [...branch, { type: "custom", customType: "goal-state", data: persisted }];
	let restoredIdle = false;
	const restored = await createHarness({
		isIdle: () => restoredIdle,
		sessionManager: {
			getBranch: () => restoredBranch,
			getEntries: () => restoredBranch,
		},
	});
	await restored.mock.events.get("agent_end")?.[0]?.(
		{ messages: [{ role: "assistant", stopReason: "stop" }] },
		restored.ctx,
	);
	assert.deepEqual(
		stateGoals(restored.mock).map(({ text, status, tokensUsed, iteration }) => ({
			text,
			status,
			tokensUsed,
			iteration,
		})),
		[{ text: "original goal", status: "active", tokensUsed: 0, iteration: 0 }],
	);
	assert.equal(lastState(restored.mock)?.pendingAction?.kind, "prioritize");

	restoredIdle = true;
	await settled(restored);
	assert.deepEqual(
		stateGoals(restored.mock).map(({ text, status, tokensUsed }) => ({ text, status, tokensUsed })),
		[
			{ text: "urgent goal", status: "active", tokensUsed: 0 },
			{ text: "original goal", status: "queued", tokensUsed: 0 },
		],
	);
});

test("pending prioritize preserves budget wrap-up completion ownership", async () => {
	const branch: Array<Record<string, unknown>> = [assistantUsageEntry(0)];
	let idle = false;
	const harness = await createHarness({
		isIdle: () => idle,
		sessionManager: { getBranch: () => branch, getEntries: () => branch },
	});
	await harness.command("--tokens 10 budgeted goal");
	const budgeted = stateGoals(harness.mock)[0];
	assert.ok(budgeted);
	branch.push(assistantUsageEntry(12));
	await harness.mock.events.get("tool_execution_end")?.[0]?.({}, harness.ctx);
	assert.equal(stateGoals(harness.mock)[0]?.status, "budget_limited");
	await harness.command("prioritize urgent goal");
	await harness.mock.events.get("before_agent_start")?.[0]?.(
		{ prompt: "budget wrap-up", systemPrompt: "base" },
		harness.ctx,
	);

	const result = await completionTool(harness.mock).execute(
		"budget-wrap-completion",
		{ goal_id: budgeted.id, summary: "Budgeted goal completed and verified." },
		new AbortController().signal,
		() => undefined,
		harness.ctx,
	);
	assert.match(result.content?.[0]?.text ?? "", /^Goal complete:/);
	assert.equal(result.terminate, true);

	await harness.mock.events.get("agent_end")?.[0]?.(
		{ messages: [{ role: "assistant", stopReason: "toolUse" }] },
		harness.ctx,
	);
	idle = true;
	await settled(harness);
	assert.deepEqual(
		stateGoals(harness.mock).map(({ text, status }) => ({ text, status })),
		[{ text: "urgent goal", status: "active" }],
	);
});

test("pending priority lets an unfinished budget wrap-up close at agent_end", async () => {
	const branch: Array<Record<string, unknown>> = [assistantUsageEntry(0)];
	let idle = false;
	const harness = await createHarness({
		isIdle: () => idle,
		sessionManager: { getBranch: () => branch, getEntries: () => branch },
	});
	await harness.command("--tokens 10 budgeted goal");
	branch.push(assistantUsageEntry(12));
	await harness.mock.events.get("tool_execution_end")?.[0]?.({}, harness.ctx);
	await harness.command("prioritize urgent goal");
	await harness.mock.events.get("before_agent_start")?.[0]?.(
		{ prompt: "budget wrap-up", systemPrompt: "base" },
		harness.ctx,
	);

	await harness.mock.events.get("agent_end")?.[0]?.(
		{ messages: [{ role: "assistant", stopReason: "stop" }] },
		harness.ctx,
	);
	const toolGate = await harness.mock.events.get("tool_call")?.[0]?.(
		{ toolName: "bash", input: { command: "pwd" } },
		harness.ctx,
	);
	assert.equal(toolGate, undefined);

	idle = true;
	await settled(harness);
	assert.equal(stateGoals(harness.mock)[0]?.text, "urgent goal");
});

test("pending prioritize preserves Pi-owned retry turns", async () => {
	let idle = false;
	const harness = await createHarness({ isIdle: () => idle });
	await harness.command("recovering goal");
	const recovering = stateGoals(harness.mock)[0];
	const ownedPrompt = harness.mock.sentUserMessages.at(-1)?.text;
	assert.ok(recovering);
	assert.ok(ownedPrompt);
	const beforeStart = harness.mock.events.get("before_agent_start")?.[0];
	await beforeStart?.({ prompt: ownedPrompt, systemPrompt: "base" }, harness.ctx);
	await harness.command("prioritize urgent goal");
	await harness.mock.events.get("agent_end")?.[0]?.(
		{
			messages: [
				{ role: "assistant", stopReason: "error", errorMessage: "rate limit; please retry" },
			],
		},
		harness.ctx,
	);

	const retryStart = await beforeStart?.(
		{ prompt: "automatic provider retry", systemPrompt: "base" },
		harness.ctx,
	);
	assert.match(
		String((retryStart as { systemPrompt?: string } | undefined)?.systemPrompt),
		/recovering goal/,
	);
	const completed = await completionTool(harness.mock).execute(
		"retry-completion",
		{ goal_id: recovering.id, summary: "Recovering goal completed and verified." },
		new AbortController().signal,
		() => undefined,
		harness.ctx,
	);
	assert.match(completed.content?.[0]?.text ?? "", /^Goal complete:/);

	await harness.mock.events.get("agent_end")?.[0]?.(
		{ messages: [{ role: "assistant", stopReason: "toolUse" }] },
		harness.ctx,
	);
	idle = true;
	await settled(harness);
	assert.equal(stateGoals(harness.mock)[0]?.text, "urgent goal");
});

test("exhausted retry finalizes before pending priority dispatches at settlement", async () => {
	let idle = false;
	const harness = await createHarness({ isIdle: () => idle });
	await harness.command("recovering goal");
	const ownedPrompt = harness.mock.sentUserMessages.at(-1)?.text;
	assert.ok(ownedPrompt);
	await harness.mock.events.get("before_agent_start")?.[0]?.(
		{ prompt: ownedPrompt, systemPrompt: "base" },
		harness.ctx,
	);
	await harness.command("prioritize urgent goal");
	await harness.mock.events.get("agent_end")?.[0]?.(
		{
			messages: [
				{ role: "assistant", stopReason: "error", errorMessage: "HTTP 524 upstream timeout" },
			],
		},
		harness.ctx,
	);

	idle = true;
	await settled(harness);
	assert.deepEqual(
		stateGoals(harness.mock).map(({ text, status }) => ({ text, status })),
		[
			{ text: "urgent goal", status: "active" },
			{ text: "recovering goal", status: "blocked" },
		],
	);
});

test("extension input cannot claim a pending Pi retry under priority", async () => {
	let idle = false;
	const harness = await createHarness({ isIdle: () => idle });
	await harness.command("recovering goal");
	const recovering = stateGoals(harness.mock)[0];
	const ownedPrompt = harness.mock.sentUserMessages.at(-1)?.text;
	assert.ok(recovering);
	assert.ok(ownedPrompt);
	const beforeStart = harness.mock.events.get("before_agent_start")?.[0];
	await beforeStart?.({ prompt: ownedPrompt, systemPrompt: "base" }, harness.ctx);
	await harness.command("prioritize urgent goal");
	await harness.mock.events.get("agent_end")?.[0]?.(
		{
			messages: [
				{ role: "assistant", stopReason: "error", errorMessage: "rate limit; please retry" },
			],
		},
		harness.ctx,
	);
	await harness.mock.events.get("input")?.[0]?.(
		{ source: "extension", text: "unrelated extension work" },
		harness.ctx,
	);

	const unrelatedStart = await beforeStart?.(
		{ prompt: "unrelated extension work", systemPrompt: "base" },
		harness.ctx,
	);
	assert.equal(unrelatedStart, undefined);
	const staleCompletion = await completionTool(harness.mock).execute(
		"extension-stale-completion",
		{ goal_id: recovering.id, summary: "Recovering goal completed and verified." },
		new AbortController().signal,
		() => undefined,
		harness.ctx,
	);
	assert.match(staleCompletion.content?.[0]?.text ?? "", /does not own the active goal/i);

	await harness.mock.events.get("agent_end")?.[0]?.(
		{ messages: [{ role: "assistant", stopReason: "stop" }] },
		harness.ctx,
	);
	idle = true;
	await settled(harness);
	assert.equal(stateGoals(harness.mock)[0]?.text, "urgent goal");
});

test("pending prioritize rejects terminal reports from unrelated turns", async () => {
	const harness = await createHarness({ isIdle: () => false });
	await harness.command("original goal");
	const original = stateGoals(harness.mock)[0];
	assert.ok(original);
	await harness.command("prioritize urgent goal");
	await harness.mock.events.get("before_agent_start")?.[0]?.(
		{ prompt: "unrelated user work", systemPrompt: "base" },
		harness.ctx,
	);

	const result = await completionTool(harness.mock).execute(
		"unowned-completion",
		{ goal_id: original.id, summary: "Original goal completed and verified." },
		new AbortController().signal,
		() => undefined,
		harness.ctx,
	);
	assert.match(result.content?.[0]?.text ?? "", /does not own the active goal/i);
	assert.equal(result.terminate, undefined);

	const blocked = await blockedTool(harness.mock).execute(
		"unowned-blocked",
		{
			goal_id: original.id,
			reason: "External access required",
			evidence: "Three verified attempts require external access.",
			repeated_turns: 3,
		},
		new AbortController().signal,
		() => undefined,
		harness.ctx,
	);
	assert.match(blocked.content?.[0]?.text ?? "", /does not own the active goal/i);
	assert.equal(blocked.terminate, undefined);
	assert.equal(stateGoals(harness.mock)[0]?.status, "active");
	assert.equal(lastState(harness.mock)?.pendingAction?.kind, "prioritize");
});

test("failed finalized priority activation pauses without absorbing unrelated usage", async () => {
	const branch: Array<Record<string, unknown>> = [assistantUsageEntry(100)];
	let idle = false;
	const harness = await createHarness({
		isIdle: () => idle,
		sessionManager: { getBranch: () => branch, getEntries: () => branch },
	});
	await harness.command("original goal");
	await harness.command("prioritize urgent goal");
	await harness.mock.events.get("before_agent_start")?.[0]?.(
		{ prompt: "unrelated user work", systemPrompt: "base" },
		harness.ctx,
	);
	branch.push(assistantUsageEntry(25));
	harness.mock.rawPi.setActiveTools(["goal_complete"]);

	idle = true;
	await settled(harness);
	assert.deepEqual(
		stateGoals(harness.mock).map(({ text, status, tokensUsed }) => ({ text, status, tokensUsed })),
		[{ text: "original goal", status: "paused", tokensUsed: 0 }],
	);
	assert.equal(lastState(harness.mock)?.pendingAction, undefined);
});

test("pending prioritize consumes an accepted displaced-goal prompt before startup", async () => {
	let aborts = 0;
	const harness = await createHarness({
		isIdle: () => false,
		abort: () => {
			aborts += 1;
		},
	});
	await harness.command("original goal");
	const displacedPrompt = harness.mock.sentUserMessages.at(-1)?.text;
	assert.ok(displacedPrompt);
	await harness.command("prioritize urgent goal");

	const result = await harness.mock.events.get("input")?.[0]?.(
		{ source: "extension", text: displacedPrompt },
		harness.ctx,
	);
	assert.deepEqual(result, { action: "handled" });
	assert.equal(aborts, 0);
	assert.equal(lastState(harness.mock)?.pendingAction?.kind, "prioritize");
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

test("restored exhausted queued heads remain budget-limited without a kickoff prompt", async () => {
	const exhausted = {
		...storedGoal("exhausted queued head", "queued"),
		tokenBudget: 10,
		tokensUsed: 10,
	};
	const state: GoalStateEntryData = { goal: exhausted };
	const branch = [{ type: "custom", customType: "goal-state", data: state }];
	const restored = await createHarness({
		sessionManager: { getBranch: () => branch, getEntries: () => branch },
	});

	assert.equal(restored.mock.sentUserMessages.length, 0);
	assert.equal(stateGoals(restored.mock)[0]?.status, "budget_limited");
	assert.equal(restored.statuses.get("goal"), "budget 10/10");
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

test("restored priority dispatches before the displaced head is budget-limited", async () => {
	const state: GoalStateEntryData = {
		goal: { ...storedGoal("budgeted head", "active"), tokenBudget: 10 },
		pendingAction: { kind: "prioritize", objective: "urgent goal" },
	};
	const branch = [
		assistantUsageEntry(12),
		{ type: "custom", customType: "goal-state", data: state },
	];
	const restored = await createHarness({
		sessionManager: { getBranch: () => branch, getEntries: () => branch },
	});

	assert.deepEqual(
		stateGoals(restored.mock).map(({ text, status }) => ({ text, status })),
		[
			{ text: "urgent goal", status: "active" },
			{ text: "budgeted head", status: "queued" },
		],
	);
	assert.equal(lastState(restored.mock)?.pendingAction, undefined);
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

test("restored skip dispatches before the skipped head is budget-limited", async () => {
	const oldHead = { ...storedGoal("budgeted head", "active"), tokenBudget: 10 };
	const state: GoalStateEntryData = {
		goal: oldHead,
		queue: [storedGoal("next head", "queued")],
		pendingAction: {
			kind: "advance",
			goalId: oldHead.id,
			reason: "skip",
			completedText: oldHead.text,
		},
	};
	const branch = [
		assistantUsageEntry(12),
		{ type: "custom", customType: "goal-state", data: state },
	];
	const restored = await createHarness({
		sessionManager: { getBranch: () => branch, getEntries: () => branch },
	});

	assert.deepEqual(
		stateGoals(restored.mock).map(({ text, status }) => ({ text, status })),
		[{ text: "next head", status: "active" }],
	);
	assert.equal(lastState(restored.mock)?.pendingAction, undefined);
});

test("a pending busy skip consumes an accepted owned prompt before advancement", async () => {
	let aborts = 0;
	const harness = await createHarness({
		isIdle: () => false,
		abort: () => {
			aborts += 1;
		},
	});
	await harness.command("old head");
	const ownedPrompt = harness.mock.sentUserMessages.at(-1)?.text;
	assert.ok(ownedPrompt);
	await harness.command("add next head");
	await harness.command("skip");

	const result = await harness.mock.events.get("input")?.[0]?.(
		{ source: "extension", text: ownedPrompt },
		harness.ctx,
	);
	assert.deepEqual(result, { action: "handled" });
	assert.equal(aborts, 0);
});

test("a pending busy skip does not abort unrelated user work before advancement", async () => {
	let aborts = 0;
	const harness = await createHarness({
		isIdle: () => false,
		abort: () => {
			aborts += 1;
		},
	});
	await harness.command("old head");
	await harness.command("add next head");
	await harness.command("skip");

	const beforeStart = harness.mock.events.get("before_agent_start")?.[0];
	const result = await beforeStart?.(
		{ prompt: "newer unrelated work", systemPrompt: "base" },
		harness.ctx,
	);
	assert.equal(result, undefined);
	assert.equal(aborts, 0);
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

test("pending skip terminates completion before missing or mismatched id rejection", async () => {
	const harness = await createHarness({ isIdle: () => false });
	await harness.command("old head");
	await harness.command("add next head");
	const oldHead = stateGoals(harness.mock)[0];
	assert.ok(oldHead);
	await harness.command("skip");

	for (const goalId of ["", "different-goal-id"]) {
		const result = await completionTool(harness.mock).execute(
			`stale-complete-after-skip-${goalId || "missing"}`,
			{ goal_id: goalId, summary: "Old head completed and verified." },
			new AbortController().signal,
			() => undefined,
			harness.ctx,
		);
		assert.equal(result.terminate, true);
		assert.match(result.content?.[0]?.text ?? "", /queued to be skipped/i);
	}
	assert.equal(lastState(harness.mock)?.goal?.status, "active");
	assert.deepEqual(lastState(harness.mock)?.pendingAction, {
		kind: "advance",
		goalId: oldHead.id,
		reason: "skip",
		completedText: "old head",
	});
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

test("pending skip terminates blocked reports before missing or mismatched id rejection", async () => {
	const harness = await createHarness({ isIdle: () => false });
	await harness.command("old head");
	await harness.command("add next head");
	const oldHead = stateGoals(harness.mock)[0];
	assert.ok(oldHead);
	await harness.command("skip");

	for (const goalId of ["", "different-goal-id"]) {
		const result = await blockedTool(harness.mock).execute(
			`stale-block-after-skip-${goalId || "missing"}`,
			{
				goal_id: goalId,
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
	}
	assert.equal(lastState(harness.mock)?.goal?.status, "active");
	assert.deepEqual(lastState(harness.mock)?.pendingAction, {
		kind: "advance",
		goalId: oldHead.id,
		reason: "skip",
		completedText: "old head",
	});
});

test("finalized priority dispatches from idle manual compaction", async () => {
	const branch: Array<Record<string, unknown>> = [assistantUsageEntry(100)];
	let idle = false;
	const harness = await createHarness({
		isIdle: () => idle,
		sessionManager: { getBranch: () => branch, getEntries: () => branch },
	});
	await harness.command("old head");
	await harness.command("prioritize urgent head");
	await harness.mock.events.get("before_agent_start")?.[0]?.(
		{ prompt: "unrelated user work", systemPrompt: "base" },
		harness.ctx,
	);
	const finalizedState = lastState(harness.mock);
	branch.push(assistantUsageEntry(25), {
		type: "custom",
		customType: "goal-state",
		data: finalizedState,
	});

	idle = true;
	await harness.mock.events.get("session_compact")?.[0]?.(
		{ reason: "manual", willRetry: false },
		harness.ctx,
	);
	assert.deepEqual(
		stateGoals(harness.mock).map(({ text, status, tokensUsed }) => ({ text, status, tokensUsed })),
		[
			{ text: "urgent head", status: "active", tokensUsed: 0 },
			{ text: "old head", status: "queued", tokensUsed: 0 },
		],
	);
});

test("manual compaction dispatches pending priority before old-head budget limiting", async () => {
	const branch: Array<Record<string, unknown>> = [];
	let idle = true;
	const harness = await createHarness({
		isIdle: () => idle,
		sessionManager: { getBranch: () => branch, getEntries: () => branch },
	});
	await harness.command("--tokens 10 old head");
	await harness.command("add tail");
	idle = false;
	await harness.command("prioritize urgent head");
	const state = lastState(harness.mock);
	branch.push(assistantUsageEntry(12), { type: "custom", customType: "goal-state", data: state });
	idle = true;
	const beforeCompact = await harness.mock.events.get("session_before_compact")?.[0]?.(
		{ reason: "manual", willRetry: false },
		harness.ctx,
	);
	assert.equal(beforeCompact, undefined);
	await harness.mock.events.get("session_compact")?.[0]?.(
		{ reason: "manual", willRetry: false },
		harness.ctx,
	);
	assert.deepEqual(
		stateGoals(harness.mock).map(({ text, status }) => ({ text, status })),
		[
			{ text: "urgent head", status: "active" },
			{ text: "old head", status: "queued" },
			{ text: "tail", status: "queued" },
		],
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
		automaticModelTurns: 0,
		toolFreeRepeatCount: 0,
		...(status === "active" ? { activeStartedAt: 1 } : {}),
	};
}
