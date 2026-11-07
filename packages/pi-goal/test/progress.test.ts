import assert from "node:assert/strict";
import { test } from "vitest";
import { loadGoalStateFromSession, serializeGoalState } from "../src/persistence.js";
import {
	applyRequirementUpdates,
	completionCoverageIssue,
	normalizeRequirements,
} from "../src/progress.js";
import { createGoal, goalSummary } from "../src/runtime.js";
import { nextToolLoopState } from "../src/tool-loops.js";
import {
	findPersistedGoal,
	requireGoalTool,
	requireLastGoal,
	startGoalForTest,
} from "./support/goal-fixture.js";

const requirement = {
	id: "tests",
	text: "Tests pass",
	status: "unverified" as const,
	evidence: "",
};

test("checklist updates are additive, atomic, bounded, and require verification evidence", () => {
	const initial = applyRequirementUpdates(undefined, [requirement]);
	assert.match(completionCoverageIssue(initial) ?? "", /tests/);
	assert.throws(
		() => applyRequirementUpdates(initial, [{ ...requirement, status: "verified" }]),
		/evidence/i,
	);
	assert.throws(
		() => applyRequirementUpdates(initial, [{ ...requirement, text: "Narrower scope" }]),
		/text/i,
	);
	assert.throws(() => applyRequirementUpdates(initial, [requirement, requirement]), /duplicate/i);
	assert.deepEqual(initial, [requirement]);
	const verified = applyRequirementUpdates(initial, [
		{ ...requirement, status: "verified", evidence: "npm test: passed" },
	]);
	assert.equal(completionCoverageIssue(verified), undefined);
	assert.deepEqual(applyRequirementUpdates(verified, []), verified);
	assert.equal(completionCoverageIssue(undefined), undefined);
	assert.deepEqual(normalizeRequirements([{ ...requirement, status: "verified", evidence: "" }]), [
		requirement,
	]);
});

function turn(output = "same", name = "read", isError = false, path = "a") {
	return {
		message: {
			role: "assistant",
			content: [{ type: "toolCall", id: "call", name, arguments: { path } }],
		},
		toolResults: [
			{
				role: "toolResult",
				toolCallId: "call",
				toolName: name,
				content: [{ type: "text", text: output }],
				isError,
			},
		],
	};
}

test("tool-loop diagnostics recognize repeated reads and failures without counting parallel duplicates", () => {
	let state = nextToolLoopState(undefined, turn());
	state = nextToolLoopState(state, turn());
	assert.equal(state.warning, undefined);
	state = nextToolLoopState(state, turn());
	assert.match(state.warning ?? "", /repeated identical tool/i);
	assert.equal(nextToolLoopState(state, turn("changed")).warning, undefined);
	let failures = nextToolLoopState(undefined, turn("failed", "bash", true));
	failures = nextToolLoopState(failures, turn("failed", "bash", true));
	assert.match(
		nextToolLoopState(failures, turn("failed", "bash", true)).warning ?? "",
		/repeated identical tool/i,
	);
	const batch = turn();
	batch.message.content.push({ ...batch.message.content[0], id: "other" });
	batch.toolResults.push({ ...batch.toolResults[0], toolCallId: "other" });
	assert.equal(nextToolLoopState(undefined, batch).warning, undefined);
});

test("Goal progress tool rejects stale updates and gates recorded incomplete coverage", async () => {
	const { mock, ctx } = await startGoalForTest();
	const goal = requireLastGoal(mock);
	const progress = requireGoalTool(mock, "goal_progress");
	await assert.rejects(
		progress.execute(
			"p",
			{ goal_id: "stale", requirements: [requirement] },
			undefined,
			undefined,
			ctx,
		),
		/stale|match/i,
	);
	await progress.execute(
		"p",
		{ goal_id: goal.id, requirements: [requirement] },
		undefined,
		undefined,
		ctx,
	);
	const completion = requireGoalTool(mock, "goal_complete");
	const rejected = await completion.execute(
		"c",
		{ goal_id: goal.id, summary: "Done; tests passed." },
		undefined,
		undefined,
		ctx,
	);
	assert.match(JSON.stringify(rejected.content), /unverified|coverage/i);
	assert.equal(requireLastGoal(mock).status, "active");
	await progress.execute(
		"p",
		{
			goal_id: goal.id,
			requirements: [{ ...requirement, status: "verified", evidence: "npm test: all passed" }],
		},
		undefined,
		undefined,
		ctx,
	);
	await completion.execute(
		"c",
		{ goal_id: goal.id, summary: "Done; npm test passed." },
		undefined,
		undefined,
		ctx,
	);
	assert.equal(findPersistedGoal(mock, "complete")?.status, "complete");
});

test("progress survives branch restoration and budgets, but objective edits discard obsolete coverage", async () => {
	const { mock, ctx } = await startGoalForTest();
	const id = requireLastGoal(mock).id;
	await requireGoalTool(mock, "goal_progress").execute(
		"p",
		{ goal_id: id, requirements: [requirement] },
		undefined,
		undefined,
		ctx,
	);
	const stored = requireLastGoal(mock);
	const branch = [{ type: "custom", customType: "goal-state", data: { goal: stored } }];
	const restored = loadGoalStateFromSession({
		sessionManager: { getBranch: () => branch, getEntries: () => [] },
	});
	assert.deepEqual(restored.goal?.requirements, [requirement]);
	assert.deepEqual(serializeGoalState(restored.goal).goal?.requirements, [requirement]);
	await mock.commands.get("goal")?.handler("edit --tokens 100k finish", ctx);
	const budgetId = requireLastGoal(mock).id;
	await requireGoalTool(mock, "goal_progress").execute(
		"read",
		{ goal_id: budgetId },
		undefined,
		undefined,
		ctx,
	);
	await mock.commands.get("goal")?.handler("status", ctx);
	assert.match(JSON.stringify(mock.entries.at(-1)), /Tests pass/);
	await mock.commands.get("goal")?.handler("edit different objective", ctx);
	await mock.commands.get("goal")?.handler("status", ctx);
	assert.doesNotMatch(JSON.stringify(mock.entries.at(-1)), /Tests pass/);
});

test("cancelled and stopped progress updates cannot mutate the saved checklist", async () => {
	const { mock, ctx } = await startGoalForTest();
	const id = requireLastGoal(mock).id;
	const tool = requireGoalTool(mock, "goal_progress");
	const signal = AbortSignal.abort();
	const before = mock.entries.length;
	await assert.rejects(
		tool.execute("p", { goal_id: id, requirements: [requirement] }, signal, undefined, ctx),
		/cancelled/i,
	);
	assert.equal(mock.entries.length, before);
	await mock.commands.get("goal")?.handler("pause", ctx);
	await assert.rejects(
		tool.execute("p", { goal_id: id, requirements: [requirement] }, undefined, undefined, ctx),
		/active Goal/i,
	);
});

test("tool diagnostics are warning-only, deduplicated, persisted, and ignore a stale run", async () => {
	const { mock, ctx, notifications } = await startGoalForTest();
	for (let i = 0; i < 4; i++) await mock.events.get("turn_end")?.[0]?.(turn(), ctx);
	assert.equal(requireLastGoal(mock).status, "active");
	assert.equal(
		notifications.filter((item) => /Repeated identical tool/i.test(item.message)).length,
		1,
	);
	const saved = mock.entries.filter((e) => e.customType === "goal-state").at(-1)?.data;
	assert.match(JSON.stringify(saved), /Repeated identical tool/);
	assert.doesNotMatch(JSON.stringify(saved), /"path"/);
	await mock.commands.get("goal")?.handler("pause", ctx);
	const count = mock.entries.length;
	await mock.events.get("turn_end")?.[0]?.(turn(), ctx);
	assert.equal(mock.entries.length, count);
});

test("diagnostics compare source-order batches, ignore bookkeeping, and age out missing results", () => {
	let state = nextToolLoopState(undefined, turn());
	state = nextToolLoopState(state, turn());
	const unmatched = turn();
	unmatched.toolResults = [];
	assert.equal(nextToolLoopState(state, unmatched).warning, undefined);
	let bookkeeping = nextToolLoopState(undefined, turn("same", "goal_progress"));
	for (let i = 0; i < 8; i++)
		bookkeeping = nextToolLoopState(bookkeeping, turn("same", "goal_progress"));
	assert.equal(bookkeeping.warning, undefined);
	assert.equal(bookkeeping.samples.length, 6);
	for (let i = 0; i < 6; i++)
		state = nextToolLoopState(state, {
			message: { role: "assistant", content: [] },
			toolResults: [],
		});
	assert.equal(nextToolLoopState(state, turn()).warning, undefined);
	const a = turn();
	a.message.content.push({ ...a.message.content[0], id: "other", arguments: { path: "b" } });
	a.toolResults.push({ ...a.toolResults[0], toolCallId: "other" });
	const first = nextToolLoopState(undefined, a);
	a.toolResults.reverse();
	a.message.content.reverse();
	assert.deepEqual(nextToolLoopState(undefined, a).samples[0].sort(), first.samples[0].sort());
});

test("recovery review explains the reason, evidence, remaining work, and next action safely", () => {
	const goal = {
		...createGoal("ship", 100, 0),
		status: "blocked" as const,
		stopReason: "Missing token\u001b[31m",
		requirements: [requirement],
	};
	const summary = goalSummary(goal);
	assert.match(summary, /Why stopped: Missing token/);
	assert.match(summary, /Remaining: 1/);
	assert.match(summary, /Last recorded evidence: none/i);
	assert.match(summary, /Next action:.*resolve.*\/goal resume/i);
	assert.equal(summary.includes("\u001b"), false);
});
