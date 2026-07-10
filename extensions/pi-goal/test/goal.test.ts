import assert from "node:assert/strict";
import test from "node:test";
import { createMockContext, createMockPi } from "../../../test/support.js";
import goal, {
	buildGoalSystemPrompt,
	completeGoalArguments,
	findFinalAssistantMessage,
	formatDuration,
	formatStatus,
	formatTokenCount,
	isContradictoryCompletionSummary,
	isRetryableGoalInterruption,
	isUsageLimitedGoalInterruption,
	parseCommand,
	parseTokenBudget,
	validateObjective,
} from "../src/goal.js";

const STALE_GOAL_TOOL_REASON =
	"Blocked stale /goal tool call after the goal stopped or was interrupted.";

test("goal registers command, status tools, and lifecycle hooks", () => {
	const mock = createMockPi();
	goal(mock.pi);

	assert.ok(mock.commands.has("goal"));
	assert.equal(typeof mock.commands.get("goal")?.getArgumentCompletions, "function");
	assert.deepEqual(
		mock.tools.map((tool) => tool.name),
		["goal_complete", "goal_blocked"],
	);
	const completionParameters = mock.tools.find((tool) => tool.name === "goal_complete")
		?.parameters as { required?: string[]; properties?: Record<string, unknown> } | undefined;
	assert.deepEqual(completionParameters?.required, ["goal_id", "summary"]);
	assert.ok(completionParameters?.properties?.goal_id);
	const blockerDefinition = mock.tools.find((tool) => tool.name === "goal_blocked");
	const blockedParameters = blockerDefinition?.parameters as
		| {
				required?: string[];
				properties?: Record<string, { minimum?: number; minLength?: number; maxLength?: number }>;
		  }
		| undefined;
	assert.deepEqual(blockedParameters?.required, [
		"goal_id",
		"reason",
		"evidence",
		"repeated_turns",
	]);
	assert.equal(blockedParameters?.properties?.reason?.minLength, 1);
	assert.equal(blockedParameters?.properties?.reason?.maxLength, 1_000);
	assert.equal(blockedParameters?.properties?.evidence?.minLength, 1);
	assert.equal(blockedParameters?.properties?.evidence?.maxLength, 4_000);
	assert.equal(blockedParameters?.properties?.repeated_turns?.minimum, 3);
	assert.match(
		String(blockerDefinition?.description),
		/same blocker.*three consecutive goal turns/i,
	);
	assert.match(
		String((blockerDefinition?.promptGuidelines as string[] | undefined)?.join(" ")),
		/fresh three-turn blocker audit/i,
	);
	assert.deepEqual([...mock.events.keys()].sort(), [
		"agent_end",
		"agent_settled",
		"before_agent_start",
		"input",
		"session_before_compact",
		"session_compact",
		"session_shutdown",
		"session_start",
		"tool_call",
	]);
});

test("completeGoalArguments suggests /goal subcommands and token options", () => {
	assert.deepEqual(
		completeGoalArguments("")?.map((item) => item.label),
		["pause", "resume", "clear", "edit", "status", "--tokens"],
	);
	assert.deepEqual(
		completeGoalArguments("")?.map((item) => item.description),
		[
			"Pause the active goal",
			"Resume a stopped or budget-limited goal",
			"Clear the current goal",
			"Edit the current goal objective",
			"Show the current goal",
			"Set a token budget before the goal",
		],
	);
	assert.deepEqual(
		completeGoalArguments("pa")?.map((item) => item.value),
		["pause"],
	);
	assert.deepEqual(
		completeGoalArguments("pause")?.map((item) => item.value),
		["pause"],
	);
	assert.deepEqual(
		completeGoalArguments("--t")?.map((item) => item.value),
		["--tokens "],
	);
	assert.deepEqual(
		completeGoalArguments("edit ")?.map((item) => item.value),
		["edit --tokens "],
	);
	assert.deepEqual(
		completeGoalArguments("edit --t")?.map((item) => item.value),
		["edit --tokens "],
	);
	assert.equal(completeGoalArguments("ship objective"), null);
	assert.equal(completeGoalArguments("edit objective"), null);
});

test("parseCommand parses budgets, quoted objectives, and management commands", () => {
	assert.deepEqual(parseCommand('--tokens 1.5k "ship tests"'), {
		kind: "start",
		objective: "ship tests",
		tokenBudget: 1500,
	});
	assert.deepEqual(parseCommand("edit --tokens 2m revise scope"), {
		kind: "edit",
		objective: "revise scope",
		tokenBudget: 2_000_000,
	});
	assert.deepEqual(parseCommand("pause"), { kind: "pause" });
	assert.equal(parseCommand("pause now"), "Usage: /goal pause");
});

test("parseTokenBudget and format helpers use compact units", () => {
	assert.equal(parseTokenBudget("250"), 250);
	assert.equal(parseTokenBudget("2.5k"), 2500);
	assert.equal(parseTokenBudget("0"), undefined);
	assert.equal(formatTokenCount(1500), "1.5k");
	assert.equal(formatTokenCount(2_000_000), "2m");
	assert.equal(formatDuration(59), "59s");
	assert.equal(formatDuration(3660), "1h1m");
});

test("formatStatus reports active, stopped, budget-limited, complete, and empty states", () => {
	const activeGoal = {
		id: "g1",
		text: "finish",
		status: "active",
		startedAt: 0,
		updatedAt: 0,
		iteration: 1,
		tokenBudget: 2000,
		tokensUsed: 500,
		timeUsedSeconds: 90,
		baselineTokens: 0,
	} as const;

	assert.equal(formatStatus(undefined), undefined);
	assert.equal(formatStatus(activeGoal), "active 500/2k");
	assert.equal(formatStatus({ ...activeGoal, status: "paused" }), "paused");
	assert.equal(formatStatus({ ...activeGoal, status: "blocked" }), "blocked");
	assert.equal(formatStatus({ ...activeGoal, status: "usage_limited" }), "usage");
	assert.equal(formatStatus({ ...activeGoal, status: "budget_limited" }), "budget 500/2k");
	assert.equal(formatStatus({ ...activeGoal, status: "complete" }), "complete");
});

test("buildGoalSystemPrompt escapes objective XML and includes goal_id guard rules", () => {
	const prompt = buildGoalSystemPrompt({
		id: "g<1&2>",
		text: "fix <all> & verify",
		status: "active",
		startedAt: 0,
		updatedAt: 0,
		iteration: 2,
		tokenBudget: 1000,
		tokensUsed: 250,
		timeUsedSeconds: 0,
		baselineTokens: 0,
	});

	assert.match(prompt, /fix &lt;all&gt; &amp; verify/);
	assert.match(prompt, /g&lt;1&amp;2&gt;/);
	assert.match(prompt, /Respect the goal token budget \(250\/1k used\)/);
	assert.match(prompt, /Only call the goal_complete tool after/);
	assert.match(prompt, /pass this exact goal_id/);
	assert.match(prompt, /stale-turn guard/);
});

test("goal prompts include the active goal_id guard", async () => {
	const started = await startGoalForTest();
	const initialGoal = requireLastGoal(started.mock);
	assertPromptHasGoalId(started.mock.sentUserMessages[0]?.text ?? "", initialGoal.id);

	const systemPrompt = started.mock.events.get("before_agent_start")?.[0]?.(
		{ systemPrompt: "base" },
		started.ctx,
	) as { systemPrompt?: string } | undefined;
	assertPromptHasGoalId(systemPrompt?.systemPrompt ?? "", initialGoal.id);

	await started.mock.events.get("agent_end")?.[0]?.(
		{ messages: [{ role: "assistant", stopReason: "stop" }] },
		started.ctx,
	);
	assert.equal(started.mock.sentUserMessages.length, 1);
	await started.mock.events.get("agent_settled")?.[0]?.({}, started.ctx);
	assertPromptHasGoalId(started.mock.sentUserMessages.at(-1)?.text ?? "", initialGoal.id);

	await started.mock.commands.get("goal")?.handler("pause", started.ctx);
	await started.mock.commands.get("goal")?.handler("resume", started.ctx);
	const resumedGoal = requireLastGoal(started.mock);
	assertPromptHasGoalId(started.mock.sentUserMessages.at(-1)?.text ?? "", resumedGoal.id);

	await started.mock.commands.get("goal")?.handler("edit verify edited objective", started.ctx);
	const editedGoal = requireLastGoal(started.mock);
	assertPromptHasGoalId(started.mock.sentUserMessages.at(-1)?.text ?? "", editedGoal.id);
});

test("goal_complete requires current goal_id before validating summary", async () => {
	const { mock, ctx } = await startGoalForTest();
	const tool = requireGoalTool(mock, "goal_complete");
	const currentGoal = requireLastGoal(mock);

	try {
		const missingId = await tool.execute(
			"call-missing-id",
			{ summary: "Implemented and verified with npm test." },
			new AbortController().signal,
			() => undefined,
			ctx,
		);

		assert.equal(missingId.terminate, undefined);
		assert.match(missingId.content?.[0]?.text ?? "", /goal_id/i);
		assert.equal(lastGoalStatus(mock), "active");

		const staleId = await tool.execute(
			"call-stale-id",
			{ goal_id: "stale-goal", summary: "Not complete: tests still fail." },
			new AbortController().signal,
			() => undefined,
			ctx,
		);

		assert.equal(staleId.terminate, undefined);
		assert.match(staleId.content?.[0]?.text ?? "", /goal_id/i);
		assert.doesNotMatch(staleId.content?.[0]?.text ?? "", /summary/i);
		assert.doesNotMatch(staleId.content?.[0]?.text ?? "", new RegExp(escapeRegExp(currentGoal.id)));
		assert.equal(requireLastGoal(mock).id, currentGoal.id);
		assert.equal(lastGoalStatus(mock), "active");
	} finally {
		mock.events.get("session_shutdown")?.[0]?.({}, ctx);
	}
});

test("goal_complete rejects contradictory summaries and accepts verified completion", async () => {
	assert.equal(isContradictoryCompletionSummary("Not complete: tests still fail."), true);
	assert.equal(isContradictoryCompletionSummary("Tests still fail."), true);
	assert.equal(isContradictoryCompletionSummary("Implemented and verified with npm test."), false);
	assert.equal(isContradictoryCompletionSummary("Remaining tasks: none."), false);
	assert.equal(
		isContradictoryCompletionSummary("Could not complete earlier, but now fixed and verified."),
		false,
	);
	assert.equal(isContradictoryCompletionSummary("Was failing before, now passes."), false);
	assert.equal(
		isContradictoryCompletionSummary("Coverage was below threshold, now passes."),
		false,
	);

	const { mock, ctx } = await startGoalForTest();
	const tool = requireGoalTool(mock, "goal_complete");
	const goalId = requireLastGoal(mock).id;

	const rejected = await tool.execute(
		"call-1",
		{ goal_id: goalId, summary: "Not complete: tests still fail." },
		new AbortController().signal,
		() => undefined,
		ctx,
	);

	assert.equal(rejected.terminate, undefined);
	assert.match(rejected.content?.[0]?.text ?? "", /rejected/i);
	assert.equal(lastGoalStatus(mock), "active");

	const emptyRejected = await tool.execute(
		"call-empty",
		{ goal_id: goalId, summary: "   " },
		new AbortController().signal,
		() => undefined,
		ctx,
	);

	assert.equal(emptyRejected.terminate, undefined);
	assert.match(emptyRejected.content?.[0]?.text ?? "", /summary is empty/i);
	assert.equal(lastGoalStatus(mock), "active");

	const accepted = await tool.execute(
		"call-2",
		{ goal_id: goalId, summary: "Implemented and verified with npm test." },
		new AbortController().signal,
		() => undefined,
		ctx,
	);

	assert.equal(accepted.terminate, true);
	assert.equal(lastGoalStatus(mock), null);

	const noActiveRejected = await tool.execute(
		"call-no-active",
		{ goal_id: goalId, summary: "Implemented and verified with npm test." },
		new AbortController().signal,
		() => undefined,
		ctx,
	);

	assert.equal(noActiveRejected.terminate, undefined);
	assert.match(noActiveRejected.content?.[0]?.text ?? "", /no active goal/i);
	assert.equal(lastGoalStatus(mock), null);
	mock.events.get("session_shutdown")?.[0]?.({}, ctx);
});

test("goal_complete rejects stale goal_id after replacement, pause/resume, and clear", async () => {
	const replaced = await startGoalForTest();
	const replacementTool = requireGoalTool(replaced.mock, "goal_complete");
	const originalGoal = requireLastGoal(replaced.mock);

	await replaced.mock.commands.get("goal")?.handler("ship replacement objective", replaced.ctx);
	const replacementGoal = requireLastGoal(replaced.mock);
	assert.notEqual(replacementGoal.id, originalGoal.id);

	const staleReplacement = await replacementTool.execute(
		"call-stale-replacement",
		{ goal_id: originalGoal.id, summary: "Not complete: tests still fail." },
		new AbortController().signal,
		() => undefined,
		replaced.ctx,
	);

	assert.equal(staleReplacement.terminate, undefined);
	assert.match(staleReplacement.content?.[0]?.text ?? "", /goal_id/i);
	assert.doesNotMatch(
		staleReplacement.content?.[0]?.text ?? "",
		new RegExp(escapeRegExp(replacementGoal.id)),
	);
	assert.equal(requireLastGoal(replaced.mock).id, replacementGoal.id);
	assert.equal(lastGoalStatus(replaced.mock), "active");

	const resumed = await startGoalForTest();
	const resumeTool = requireGoalTool(resumed.mock, "goal_complete");
	const beforePauseGoal = requireLastGoal(resumed.mock);
	await resumed.mock.commands.get("goal")?.handler("pause", resumed.ctx);

	const stalePaused = await resumeTool.execute(
		"call-stale-paused",
		{ goal_id: beforePauseGoal.id, summary: "Not complete: tests still fail." },
		new AbortController().signal,
		() => undefined,
		resumed.ctx,
	);

	assert.equal(stalePaused.terminate, undefined);
	assert.match(stalePaused.content?.[0]?.text ?? "", /paused|not active/i);
	assert.equal(lastGoalStatus(resumed.mock), "paused");
	assert.deepEqual(
		resumed.mock.events.get("tool_call")?.[0]?.(
			{ toolName: "bash", toolCallId: "t-after-stale-complete", input: {} },
			resumed.ctx,
		),
		{ block: true, reason: STALE_GOAL_TOOL_REASON },
	);

	await resumed.mock.commands.get("goal")?.handler("resume", resumed.ctx);
	const afterResumeGoal = requireLastGoal(resumed.mock);
	assert.notEqual(afterResumeGoal.id, beforePauseGoal.id);

	const staleAfterResume = await resumeTool.execute(
		"call-stale-after-resume",
		{ goal_id: beforePauseGoal.id, summary: "Not complete: tests still fail." },
		new AbortController().signal,
		() => undefined,
		resumed.ctx,
	);

	assert.equal(staleAfterResume.terminate, undefined);
	assert.match(staleAfterResume.content?.[0]?.text ?? "", /goal_id/i);
	assert.doesNotMatch(
		staleAfterResume.content?.[0]?.text ?? "",
		new RegExp(escapeRegExp(afterResumeGoal.id)),
	);
	assert.equal(requireLastGoal(resumed.mock).id, afterResumeGoal.id);
	assert.equal(lastGoalStatus(resumed.mock), "active");

	const cleared = await startGoalForTest();
	const clearTool = requireGoalTool(cleared.mock, "goal_complete");
	const beforeClearGoal = requireLastGoal(cleared.mock);
	await cleared.mock.commands.get("goal")?.handler("clear", cleared.ctx);

	const staleAfterClear = await clearTool.execute(
		"call-stale-after-clear",
		{ goal_id: beforeClearGoal.id, summary: "Implemented and verified." },
		new AbortController().signal,
		() => undefined,
		cleared.ctx,
	);

	assert.equal(staleAfterClear.terminate, undefined);
	assert.match(staleAfterClear.content?.[0]?.text ?? "", /no active goal/i);
	assert.equal(lastGoalStatus(cleared.mock), null);
});

test("goal_blocked rejects calls without an active goal", async () => {
	const mock = createMockPi();
	goal(mock.pi);
	const context = createMockContext();
	mock.events.get("session_start")?.[0]?.({}, context.ctx);
	const blockerTool = requireGoalTool(mock, "goal_blocked");

	const result = await blockerTool.execute(
		"block-without-goal",
		{
			goal_id: "missing",
			reason: "Need access",
			evidence: "Three attempts failed",
			repeated_turns: 3,
		},
		new AbortController().signal,
		() => undefined,
		context.ctx,
	);

	assert.match(result.content?.[0]?.text ?? "", /no active goal/i);
	assert.equal(result.terminate, undefined);
	assert.equal(lastGoalStatus(mock), null);
});

test("goal_blocked requires a current active goal and strict blocker evidence", async () => {
	const blocked = await startGoalForTest();
	const blockerTool = requireGoalTool(blocked.mock, "goal_blocked");
	const completionTool = requireGoalTool(blocked.mock, "goal_complete");
	const currentGoal = requireLastGoal(blocked.mock);

	const stale = await blockerTool.execute(
		"block-stale",
		{ goal_id: "stale", reason: "", evidence: "", repeated_turns: 0 },
		new AbortController().signal,
		() => undefined,
		blocked.ctx,
	);
	assert.match(stale.content?.[0]?.text ?? "", /goal_id/i);
	assert.equal(lastGoalStatus(blocked.mock), "active");

	for (const [params, rejection] of [
		[
			{
				goal_id: currentGoal.id,
				reason: "Need access",
				evidence: "Tried available paths",
				repeated_turns: 2,
			},
			/at least 3/i,
		],
		[
			{ goal_id: currentGoal.id, reason: "Need access", evidence: "   ", repeated_turns: 3 },
			/evidence is empty/i,
		],
		[
			{
				goal_id: currentGoal.id,
				reason: "   ",
				evidence: "Three attempts failed",
				repeated_turns: 3,
			},
			/reason is empty/i,
		],
		[
			{
				goal_id: currentGoal.id,
				reason: "r".repeat(1_001),
				evidence: "Three attempts failed",
				repeated_turns: 3,
			},
			/reason is too long/i,
		],
		[
			{
				goal_id: currentGoal.id,
				reason: "Need access",
				evidence: "e".repeat(4_001),
				repeated_turns: 3,
			},
			/evidence is too long/i,
		],
		[
			{
				goal_id: currentGoal.id,
				reason: "Need access",
				evidence: "Three attempts failed",
				repeated_turns: 3.5,
			},
			/whole number/i,
		],
	] as const) {
		const result = await blockerTool.execute(
			"block-rejected",
			params,
			new AbortController().signal,
			() => undefined,
			blocked.ctx,
		);
		assert.match(result.content?.[0]?.text ?? "", rejection);
		assert.equal(result.terminate, undefined);
		assert.equal(lastGoalStatus(blocked.mock), "active");
	}

	const accepted = await blockerTool.execute(
		"block-accepted",
		{
			goal_id: currentGoal.id,
			reason: "Repository access requires the user",
			evidence: "Three separate attempts confirmed that no available credential can read it.",
			repeated_turns: 3,
		},
		new AbortController().signal,
		() => undefined,
		blocked.ctx,
	);

	assert.equal(accepted.terminate, true);
	assert.match(accepted.content?.[0]?.text ?? "", /goal blocked/i);
	assert.equal(lastGoalStatus(blocked.mock), "blocked");
	assert.equal(blocked.statuses.get("goal"), "blocked");
	assert.match(blocked.notifications.at(-1)?.message ?? "", /goal blocked/i);
	assert.deepEqual(
		blocked.mock.events.get("tool_call")?.[0]?.(
			{ toolName: "bash", toolCallId: "stale-after-block", input: {} },
			blocked.ctx,
		),
		{ block: true, reason: STALE_GOAL_TOOL_REASON },
	);

	const completion = await completionTool.execute(
		"complete-blocked",
		{ goal_id: currentGoal.id, summary: "Implemented and verified." },
		new AbortController().signal,
		() => undefined,
		blocked.ctx,
	);
	assert.match(completion.content?.[0]?.text ?? "", /blocked, not active/i);
	assert.equal(completion.terminate, undefined);
	assert.equal(lastGoalStatus(blocked.mock), "blocked");

	const alreadyStopped = await blockerTool.execute(
		"block-stopped",
		{
			goal_id: currentGoal.id,
			reason: "Still blocked",
			evidence: "The external state is unchanged.",
			repeated_turns: 4,
		},
		new AbortController().signal,
		() => undefined,
		blocked.ctx,
	);
	assert.match(alreadyStopped.content?.[0]?.text ?? "", /blocked, not active/i);
	assert.equal(alreadyStopped.terminate, undefined);
});

test("session persistence restores stopped states with resumable command hints", async () => {
	for (const [status, statusline] of [
		["paused", "paused"],
		["blocked", "blocked"],
		["usage_limited", "usage"],
		["budget_limited", "budget 5/10"],
	] as const) {
		const restored = restoreGoalForTest(status);
		assert.equal(restored.statuses.get("goal"), statusline);

		await restored.mock.commands.get("goal")?.handler("", restored.ctx);
		assert.match(restored.notifications.at(-1)?.message ?? "", new RegExp(`Status: ${status}`));
		assert.match(restored.notifications.at(-1)?.message ?? "", /\/goal resume/);
	}
});

test("resume safely reactivates every resumable stopped status and rotates goal_id", async () => {
	for (const status of ["paused", "blocked", "usage_limited", "budget_limited"] as const) {
		const restored = restoreGoalForTest(status);
		const beforeResume = restored.sessionGoal;

		await restored.mock.commands.get("goal")?.handler("resume", restored.ctx);

		const resumed = requireLastGoal(restored.mock);
		assert.equal(resumed.status, "active", `${status} should resume`);
		assert.notEqual(resumed.id, beforeResume.id);
		assert.equal(restored.statuses.get("goal"), "active 5/10");
		assert.equal(restored.mock.sentUserMessages.length, 1);
		assert.match(restored.mock.sentUserMessages[0]?.text ?? "", /explicitly resumed/i);
		assert.equal(
			restored.mock.events.get("tool_call")?.[0]?.(
				{ toolName: "bash", toolCallId: `tool-after-${status}`, input: {} },
				restored.ctx,
			),
			undefined,
		);
	}
});

test("resume rejects active goals and exhausted budgets without rotating goal_id", async () => {
	const active = await startGoalForTest();
	const activeGoal = requireLastGoal(active.mock);
	const activeMessageCount = active.mock.sentUserMessages.length;
	await active.mock.commands.get("goal")?.handler("resume", active.ctx);
	assert.match(active.notifications.at(-1)?.message ?? "", /only paused, blocked/i);
	assert.equal(requireLastGoal(active.mock).id, activeGoal.id);
	assert.equal(active.mock.sentUserMessages.length, activeMessageCount);

	for (const status of ["paused", "blocked", "usage_limited", "budget_limited"] as const) {
		const exhausted = restoreGoalForTest(status, { tokensUsed: 10 });
		await exhausted.mock.commands.get("goal")?.handler("resume", exhausted.ctx);
		assert.match(exhausted.notifications.at(-1)?.message ?? "", /still reached/i);
		exhausted.mock.events.get("session_shutdown")?.[0]?.({}, exhausted.ctx);
		assert.equal(lastGoalStatus(exhausted.mock), status);
		assert.equal(requireLastGoal(exhausted.mock).id, exhausted.sessionGoal.id);
		assert.equal(exhausted.mock.sentUserMessages.length, 0);
	}
});

test("failed resume delivery restores the stopped state and original goal_id", async () => {
	const restored = restoreGoalForTest("blocked");
	restored.mock.rawPi.sendUserMessage = () => {
		throw new Error("runtime became busy");
	};

	await restored.mock.commands.get("goal")?.handler("resume", restored.ctx);

	assert.equal(lastGoalStatus(restored.mock), "blocked");
	assert.equal(requireLastGoal(restored.mock).id, restored.sessionGoal.id);
	assert.equal(restored.statuses.get("goal"), "blocked");
	assert.equal(restored.mock.sentUserMessages.length, 0);
	assert.match(restored.notifications.at(-1)?.message ?? "", /runtime became busy/i);
	assert.deepEqual(
		restored.mock.events.get("tool_call")?.[0]?.(
			{ toolName: "bash", toolCallId: "stale-after-failed-resume", input: {} },
			restored.ctx,
		),
		{ block: true, reason: STALE_GOAL_TOOL_REASON },
	);
});

test("editing paused, blocked, or usage-limited goals preserves their stopped state", async () => {
	for (const status of ["paused", "blocked", "usage_limited"] as const) {
		const restored = restoreGoalForTest(status);
		const oldId = restored.sessionGoal.id;
		await restored.mock.commands.get("goal")?.handler("edit revised objective", restored.ctx);

		const edited = requireLastGoal(restored.mock);
		assert.equal(edited.status, status);
		assert.notEqual(edited.id, oldId);
		assert.equal(restored.mock.sentUserMessages.length, 0);
	}
});

test("pause remains active-only for new stopped statuses", async () => {
	for (const status of ["blocked", "usage_limited", "budget_limited"] as const) {
		const restored = restoreGoalForTest(status);
		await restored.mock.commands.get("goal")?.handler("pause", restored.ctx);
		assert.match(restored.notifications.at(-1)?.message ?? "", /only active goals can be paused/i);
		assert.equal(
			restored.statuses.get("goal"),
			status === "usage_limited" ? "usage" : status === "budget_limited" ? "budget 5/10" : status,
		);
	}
});

test("agent_settled dispatches one idle continuation after agent_end records intent", async () => {
	const settled = await startGoalForTest();

	await settled.mock.events.get("agent_end")?.[0]?.(
		{ messages: [{ role: "assistant", stopReason: "stop" }] },
		settled.ctx,
	);
	assert.equal(settled.mock.sentUserMessages.length, 1);

	await settled.mock.events.get("agent_settled")?.[0]?.({}, settled.ctx);
	assert.equal(settled.mock.sentUserMessages.length, 2);
	assert.equal(settled.mock.sentUserMessages.at(-1)?.options, undefined);
	assert.match(settled.mock.sentUserMessages.at(-1)?.text ?? "", /automatic continuation #1/i);

	await settled.mock.events.get("agent_settled")?.[0]?.({}, settled.ctx);
	assert.equal(settled.mock.sentUserMessages.length, 2);
});

test("agent_settled retains intent until idle and pending-message gates allow dispatch", async () => {
	let idle = false;
	let pending = true;
	const settled = await startGoalForTest({
		isIdle: () => idle,
		hasPendingMessages: () => pending,
	});

	await settled.mock.events.get("agent_end")?.[0]?.(
		{ messages: [{ role: "assistant", stopReason: "stop" }] },
		settled.ctx,
	);
	await settled.mock.events.get("agent_settled")?.[0]?.({}, settled.ctx);
	assert.equal(settled.mock.sentUserMessages.length, 1);

	idle = true;
	await settled.mock.events.get("agent_settled")?.[0]?.({}, settled.ctx);
	assert.equal(settled.mock.sentUserMessages.length, 1);

	pending = false;
	await settled.mock.events.get("agent_settled")?.[0]?.({}, settled.ctx);
	assert.equal(settled.mock.sentUserMessages.length, 2);
});

test("failed settled dispatch retains intent for a later idle retry", async () => {
	const retried = await startGoalForTest();
	await retried.mock.events.get("agent_end")?.[0]?.(
		{ messages: [{ role: "assistant", stopReason: "stop" }] },
		retried.ctx,
	);

	const sendUserMessage = retried.mock.rawPi.sendUserMessage.bind(retried.mock.rawPi);
	retried.mock.rawPi.sendUserMessage = () => {
		throw new Error("runtime unavailable");
	};
	await retried.mock.events.get("agent_settled")?.[0]?.({}, retried.ctx);
	assert.equal(retried.mock.sentUserMessages.length, 1);
	assert.match(retried.notifications.at(-1)?.message ?? "", /runtime unavailable/i);

	retried.mock.rawPi.sendUserMessage = sendUserMessage;
	await retried.mock.events.get("agent_settled")?.[0]?.({}, retried.ctx);
	assert.equal(retried.mock.sentUserMessages.length, 2);
});

test("new work supersedes an older continuation intent before it settles", async () => {
	const superseded = await startGoalForTest();
	await superseded.mock.events.get("agent_end")?.[0]?.(
		{ messages: [{ role: "assistant", stopReason: "stop" }] },
		superseded.ctx,
	);

	superseded.mock.events.get("before_agent_start")?.[0]?.(
		{ prompt: "queued user work", systemPrompt: "base" },
		superseded.ctx,
	);
	await superseded.mock.events.get("agent_settled")?.[0]?.({}, superseded.ctx);

	assert.equal(superseded.mock.sentUserMessages.length, 1);
});

test("newer work supersedes an accepted continuation delivery that lost the start race", async () => {
	const raced = await startGoalForTest();
	await raced.mock.events.get("agent_end")?.[0]?.(
		{ messages: [{ role: "assistant", stopReason: "stop" }] },
		raced.ctx,
	);
	await raced.mock.events.get("agent_settled")?.[0]?.({}, raced.ctx);
	const staleContinuation = raced.mock.sentUserMessages.at(-1)?.text ?? "";

	raced.mock.events.get("before_agent_start")?.[0]?.(
		{ prompt: "newer extension work", systemPrompt: "base" },
		raced.ctx,
	);
	assert.deepEqual(
		raced.mock.events.get("input")?.[0]?.(
			{ source: "extension", text: staleContinuation },
			raced.ctx,
		),
		{ action: "handled" },
	);

	await raced.mock.events.get("agent_end")?.[0]?.(
		{ messages: [{ role: "assistant", stopReason: "stop" }] },
		raced.ctx,
	);
	await raced.mock.events.get("agent_settled")?.[0]?.({}, raced.ctx);
	assert.equal(raced.mock.sentUserMessages.length, 3);
	assert.notEqual(raced.mock.sentUserMessages.at(-1)?.text, staleContinuation);
});

test("pause aborts the current turn, blocks stale tools, and persists paused state", async () => {
	let pauseAborts = 0;
	const paused = await startGoalForTest({ abort: () => pauseAborts++ });
	await paused.mock.events.get("agent_end")?.[0]?.(
		{ messages: [{ role: "assistant", stopReason: "stop" }] },
		paused.ctx,
	);
	await paused.mock.events.get("agent_settled")?.[0]?.({}, paused.ctx);
	const staleContinuation = paused.mock.sentUserMessages.at(-1)?.text ?? "";
	assert.match(staleContinuation, /pi-goal-continuation/);

	await paused.mock.commands.get("goal")?.handler("pause", paused.ctx);

	assert.equal(pauseAborts, 1);
	assert.equal(lastGoalStatus(paused.mock), "paused");
	assert.equal(paused.statuses.get("goal"), "paused");
	assert.deepEqual(
		paused.mock.events.get("input")?.[0]?.(
			{ source: "extension", text: staleContinuation },
			paused.ctx,
		),
		{ action: "handled" },
	);
	assert.deepEqual(
		paused.mock.events.get("tool_call")?.[0]?.(
			{ toolName: "bash", toolCallId: "t1", input: {} },
			paused.ctx,
		),
		{ block: true, reason: STALE_GOAL_TOOL_REASON },
	);
});

test("clear removes goal state without aborting or blocking stale tools", async () => {
	let clearAborts = 0;
	const cleared = await startGoalForTest({ abort: () => clearAborts++ });
	const beforeClearGoal = requireLastGoal(cleared.mock);
	await cleared.mock.events.get("agent_end")?.[0]?.(
		{ messages: [{ role: "assistant", stopReason: "stop" }] },
		cleared.ctx,
	);
	await cleared.mock.events.get("agent_settled")?.[0]?.({}, cleared.ctx);
	const staleContinuation = cleared.mock.sentUserMessages.at(-1)?.text ?? "";
	assert.match(staleContinuation, /pi-goal-continuation/);

	await cleared.mock.commands.get("goal")?.handler("clear", cleared.ctx);

	assert.equal(clearAborts, 0);
	assert.equal(lastGoalStatus(cleared.mock), null);
	assert.equal(cleared.statuses.get("goal"), undefined);
	assert.deepEqual(
		cleared.mock.events.get("input")?.[0]?.(
			{ source: "extension", text: staleContinuation },
			cleared.ctx,
		),
		{ action: "handled" },
	);
	assert.equal(
		cleared.mock.events.get("tool_call")?.[0]?.(
			{ toolName: "edit", toolCallId: "t-clear", input: {} },
			cleared.ctx,
		),
		undefined,
	);

	const tool = requireGoalTool(cleared.mock, "goal_complete");
	const staleCompletion = await tool.execute(
		"call-after-clear",
		{ goal_id: beforeClearGoal.id, summary: "Implemented and verified." },
		new AbortController().signal,
		() => undefined,
		cleared.ctx,
	);

	assert.equal(staleCompletion.terminate, undefined);
	assert.match(staleCompletion.content?.[0]?.text ?? "", /no active goal/i);
});

test("clear releases stale tool-call block from a paused goal", async () => {
	let pauseAborts = 0;
	const paused = await startGoalForTest({ abort: () => pauseAborts++ });
	await paused.mock.events.get("agent_end")?.[0]?.(
		{ messages: [{ role: "assistant", stopReason: "stop" }] },
		paused.ctx,
	);

	await paused.mock.commands.get("goal")?.handler("pause", paused.ctx);

	assert.equal(pauseAborts, 1);
	assert.equal(lastGoalStatus(paused.mock), "paused");
	assert.deepEqual(
		paused.mock.events.get("tool_call")?.[0]?.(
			{ toolName: "bash", toolCallId: "t-paused", input: {} },
			paused.ctx,
		),
		{ block: true, reason: STALE_GOAL_TOOL_REASON },
	);

	await paused.mock.commands.get("goal")?.handler("clear", paused.ctx);

	assert.equal(lastGoalStatus(paused.mock), null);
	assert.equal(paused.statuses.get("goal"), undefined);
	assert.equal(
		paused.mock.events.get("tool_call")?.[0]?.(
			{ toolName: "bash", toolCallId: "t-after-clear", input: {} },
			paused.ctx,
		),
		undefined,
	);
});

test("state changes between agent_end and agent_settled cancel stale continuation intent", async () => {
	for (const action of ["pause", "clear", "replace", "complete"] as const) {
		let aborts = 0;
		const changed = await startGoalForTest({ abort: () => aborts++ });
		const originalGoal = requireLastGoal(changed.mock);
		await changed.mock.events.get("agent_end")?.[0]?.(
			{ messages: [{ role: "assistant", stopReason: "stop" }] },
			changed.ctx,
		);

		if (action === "pause" || action === "clear") {
			await changed.mock.commands.get("goal")?.handler(action, changed.ctx);
		} else if (action === "replace") {
			await changed.mock.commands.get("goal")?.handler("replacement objective", changed.ctx);
		} else {
			await requireGoalTool(changed.mock, "goal_complete").execute(
				"complete-before-settled",
				{ goal_id: originalGoal.id, summary: "Implemented and verified." },
				new AbortController().signal,
				() => undefined,
				changed.ctx,
			);
		}

		const messagesBeforeSettled = changed.mock.sentUserMessages.length;
		await changed.mock.events.get("agent_settled")?.[0]?.({}, changed.ctx);
		assert.equal(
			changed.mock.sentUserMessages.length,
			messagesBeforeSettled,
			`${action} must not dispatch the stale continuation`,
		);
	}
});

test("budget exhaustion between agent_end and agent_settled cancels continuation intent", async () => {
	const branch = [
		{
			type: "message",
			message: { role: "assistant", usage: { input: 0, output: 0 } },
		},
	];
	const budgeted = await startGoalForTest(
		{
			sessionManager: { getBranch: () => branch, getEntries: () => [] },
		},
		"--tokens 1 finish",
	);

	branch.push({
		type: "message",
		message: { role: "assistant", usage: { input: 1, output: 0 } },
	});
	await budgeted.mock.events.get("agent_end")?.[0]?.(
		{ messages: [{ role: "assistant", stopReason: "stop" }] },
		budgeted.ctx,
	);
	assert.equal(lastGoalStatus(budgeted.mock), "budget_limited");

	await budgeted.mock.events.get("agent_settled")?.[0]?.({}, budgeted.ctx);
	assert.equal(budgeted.mock.sentUserMessages.length, 1);
});

test("usage-limit classification recognizes quota failures without swallowing unrelated errors", () => {
	for (const errorMessage of [
		"You have hit your ChatGPT usage limit.",
		"GoUsageLimitError",
		"Monthly usage limit reached; enable available balance",
		"Provider account is out of budget",
		"Your organization quota has been exceeded",
		"RESOURCE_EXHAUSTED: quota exhausted",
		"insufficient_quota",
		"Billing hard limit reached",
		"Please check your plan and billing details",
		"Your credit balance is too low to access the API",
		"Payment Required: insufficient credits",
	]) {
		assert.equal(
			isUsageLimitedGoalInterruption({ role: "assistant", stopReason: "error", errorMessage }),
			true,
			errorMessage,
		);
	}
	for (const errorMessage of [
		"WebSocket closed 1000",
		"rate_limit_exceeded",
		"HTTP 429 Too Many Requests",
		"Unauthorized: invalid API key",
		"multi-auth rotation failed: 2 credentials tried",
	]) {
		assert.equal(
			isUsageLimitedGoalInterruption({ role: "assistant", stopReason: "error", errorMessage }),
			false,
			errorMessage,
		);
	}
	assert.equal(
		isUsageLimitedGoalInterruption({
			role: "assistant",
			stopReason: "aborted",
			errorMessage: "usage limit",
		}),
		false,
	);
	for (const errorMessage of [
		"rate_limit_exceeded",
		"HTTP 429 Too Many Requests",
		"Internal server error 503",
	]) {
		assert.equal(
			isRetryableGoalInterruption({ role: "assistant", stopReason: "error", errorMessage }),
			true,
			errorMessage,
		);
	}
});

test("agent_end maps abort, quota failure, and terminal error to distinct stopped states", async () => {
	for (const [assistant, status, notification] of [
		[{ role: "assistant", stopReason: "aborted" }, "paused", /paused after interruption/i],
		[
			{
				role: "assistant",
				stopReason: "error",
				errorMessage: "You have hit your ChatGPT usage limit.",
			},
			"usage_limited",
			/usage limit/i,
		],
		[
			{
				role: "assistant",
				stopReason: "error",
				errorMessage: "Permission denied by remote service",
			},
			"blocked",
			/blocked after agent error/i,
		],
	] as const) {
		let aborts = 0;
		const stopped = await startGoalForTest({ abort: () => aborts++ });
		await stopped.mock.events.get("agent_end")?.[0]?.({ messages: [assistant] }, stopped.ctx);

		assert.equal(lastGoalStatus(stopped.mock), status);
		assert.equal(aborts, 1);
		assert.match(stopped.notifications.at(-1)?.message ?? "", notification);
		await stopped.mock.events.get("agent_settled")?.[0]?.({}, stopped.ctx);
		assert.equal(stopped.mock.sentUserMessages.length, 1);
		const staleToolCall = stopped.mock.events.get("tool_call")?.[0];
		assert.deepEqual(
			staleToolCall?.({ toolName: "bash", toolCallId: `stale-${status}`, input: {} }, stopped.ctx),
			{ block: true, reason: STALE_GOAL_TOOL_REASON },
		);
		stopped.mock.events.get("input")?.[0]?.(
			{ source: "extension", text: "unrelated extension work" },
			stopped.ctx,
		);
		assert.deepEqual(
			staleToolCall?.(
				{ toolName: "bash", toolCallId: `still-stale-${status}`, input: {} },
				stopped.ctx,
			),
			{ block: true, reason: STALE_GOAL_TOOL_REASON },
		);
		await stopped.mock.commands.get("goal")?.handler("resume", stopped.ctx);
		assert.equal(lastGoalStatus(stopped.mock), "active");
		assert.equal(
			staleToolCall?.(
				{ toolName: "bash", toolCallId: `resumed-${status}`, input: {} },
				stopped.ctx,
			),
			undefined,
		);
	}
});

test("agent_end keeps retryable interruptions active but stops on non-retryable errors", async () => {
	assert.equal(
		isRetryableGoalInterruption({
			role: "assistant",
			stopReason: "error",
			errorMessage: "WebSocket closed 1000",
		}),
		true,
	);
	assert.equal(
		isRetryableGoalInterruption({
			role: "assistant",
			stopReason: "error",
			errorMessage: "prompt is too long: 213462 tokens > 200000 maximum",
		}),
		true,
	);
	assert.equal(
		isRetryableGoalInterruption({
			role: "assistant",
			stopReason: "error",
			errorMessage:
				"This endpoint's maximum context length is 128000 tokens. However, you requested about 140000 tokens.",
		}),
		true,
	);
	assert.equal(
		isRetryableGoalInterruption({
			role: "assistant",
			stopReason: "error",
			errorMessage: "context_length_exceeded",
		}),
		true,
	);
	assert.equal(
		isRetryableGoalInterruption({
			role: "assistant",
			stopReason: "error",
			errorMessage: "You have hit your ChatGPT usage limit.",
		}),
		false,
	);

	const retryable = await startGoalForTest();
	await retryable.mock.events.get("agent_end")?.[0]?.(
		{
			messages: [{ role: "assistant", stopReason: "error", errorMessage: "WebSocket closed 1000" }],
		},
		retryable.ctx,
	);

	assert.equal(lastGoalStatus(retryable.mock), "active");
	await retryable.mock.events.get("agent_settled")?.[0]?.({}, retryable.ctx);
	assert.equal(retryable.mock.sentUserMessages.length, 1);
	assert.equal(
		retryable.mock.events.get("tool_call")?.[0]?.(
			{ toolName: "bash", toolCallId: "retry-tool", input: {} },
			retryable.ctx,
		),
		undefined,
	);

	let aborts = 0;
	const nonRetryable = await startGoalForTest({ abort: () => aborts++ });
	await nonRetryable.mock.events.get("agent_end")?.[0]?.(
		{
			messages: [
				{
					role: "assistant",
					stopReason: "error",
					errorMessage: "You have hit your ChatGPT usage limit.",
				},
			],
		},
		nonRetryable.ctx,
	);

	assert.equal(aborts, 1);
	assert.equal(lastGoalStatus(nonRetryable.mock), "usage_limited");
	await nonRetryable.mock.events.get("agent_settled")?.[0]?.({}, nonRetryable.ctx);
	assert.equal(nonRetryable.mock.sentUserMessages.length, 1);
	assert.deepEqual(
		nonRetryable.mock.events.get("tool_call")?.[0]?.(
			{ toolName: "bash", toolCallId: "t1", input: {} },
			nonRetryable.ctx,
		),
		{ block: true, reason: STALE_GOAL_TOOL_REASON },
	);
});

test("agent_end keeps Codex retry-hinted errors active without stale tool blocking", async () => {
	let aborts = 0;
	const retryable = await startGoalForTest({ abort: () => aborts++ });
	const errorMessage =
		"Codex error: An error occurred while processing your request. You can retry your request.\n\n[codex-generic-retry] provider returned error; treating Codex retryable backend failure as retryable.";

	assert.equal(
		isRetryableGoalInterruption({ role: "assistant", stopReason: "error", errorMessage }),
		true,
	);
	await retryable.mock.events.get("agent_end")?.[0]?.(
		{ messages: [{ role: "assistant", stopReason: "error", errorMessage }] },
		retryable.ctx,
	);

	assert.equal(aborts, 0);
	assert.equal(lastGoalStatus(retryable.mock), "active");
	assert.equal(
		retryable.mock.events.get("tool_call")?.[0]?.(
			{ toolName: "bash", toolCallId: "codex-retry-tool", input: {} },
			retryable.ctx,
		),
		undefined,
	);
});

test("overflow compaction retry keeps the goal active and does not block retry tools", async () => {
	let aborts = 0;
	const overflow = await startGoalForTest({ abort: () => aborts++ });

	await overflow.mock.events.get("agent_end")?.[0]?.(
		{
			messages: [
				{
					role: "assistant",
					stopReason: "error",
					errorMessage: "prompt is too long: 213462 tokens > 200000 maximum",
				},
			],
		},
		overflow.ctx,
	);

	assert.equal(aborts, 0);
	assert.equal(lastGoalStatus(overflow.mock), "active");
	assert.equal(overflow.mock.sentUserMessages.length, 1);
	assert.equal(
		overflow.mock.events.get("tool_call")?.[0]?.(
			{ toolName: "read", toolCallId: "retry-tool", input: {} },
			overflow.ctx,
		),
		undefined,
	);

	overflow.mock.events.get("session_before_compact")?.[0]?.({}, overflow.ctx);
	await overflow.mock.events.get("session_compact")?.[0]?.({}, overflow.ctx);
	await overflow.mock.events.get("agent_settled")?.[0]?.({}, overflow.ctx);

	assert.equal(lastGoalStatus(overflow.mock), "active");
	assert.equal(overflow.mock.sentUserMessages.length, 1);
	assert.equal(
		overflow.mock.events.get("tool_call")?.[0]?.(
			{ toolName: "bash", toolCallId: "post-compact-retry-tool", input: {} },
			overflow.ctx,
		),
		undefined,
	);
});

test("compaction with willRetry true does not enqueue a goal continuation", async () => {
	const retrying = await startGoalForTest();

	retrying.mock.events.get("session_before_compact")?.[0]?.(
		{ reason: "overflow", willRetry: true },
		retrying.ctx,
	);
	await retrying.mock.events.get("session_compact")?.[0]?.(
		{ reason: "overflow", willRetry: true },
		retrying.ctx,
	);
	await retrying.mock.events.get("agent_settled")?.[0]?.({}, retrying.ctx);

	assert.equal(lastGoalStatus(retrying.mock), "active");
	assert.equal(retrying.mock.sentUserMessages.length, 1);
});

test("manual compaction cancels stale continuation and sends one fresh continuation", async () => {
	let idle = true;
	const compacted = await startGoalForTest({ isIdle: () => idle });
	await compacted.mock.events.get("agent_end")?.[0]?.(
		{ messages: [{ role: "assistant", stopReason: "stop" }] },
		compacted.ctx,
	);
	await compacted.mock.events.get("agent_settled")?.[0]?.({}, compacted.ctx);
	const staleContinuation = compacted.mock.sentUserMessages.at(-1)?.text ?? "";
	assert.match(staleContinuation, /pi-goal-continuation/);

	compacted.mock.events.get("session_before_compact")?.[0]?.(
		{ reason: "threshold", willRetry: false },
		compacted.ctx,
	);
	assert.deepEqual(
		compacted.mock.events.get("input")?.[0]?.(
			{ source: "extension", text: staleContinuation },
			compacted.ctx,
		),
		{ action: "handled" },
	);

	idle = false;
	await compacted.mock.events.get("session_compact")?.[0]?.(
		{ reason: "threshold", willRetry: false },
		compacted.ctx,
	);
	assert.equal(compacted.mock.sentUserMessages.length, 2);

	idle = true;
	await compacted.mock.events.get("agent_settled")?.[0]?.({}, compacted.ctx);
	const freshContinuation = compacted.mock.sentUserMessages.at(-1)?.text ?? "";
	assert.equal(compacted.mock.sentUserMessages.length, 3);
	assert.match(freshContinuation, /pi-goal-continuation/);
	assert.notEqual(freshContinuation, staleContinuation);
	assert.equal(
		compacted.mock.events.get("input")?.[0]?.(
			{ source: "extension", text: freshContinuation },
			compacted.ctx,
		),
		undefined,
	);

	await compacted.mock.events.get("session_compact")?.[0]?.(
		{ reason: "threshold", willRetry: false },
		compacted.ctx,
	);
	assert.equal(compacted.mock.sentUserMessages.length, 3);
});

test("stale goal tool calls are blocked after pause until a fresh non-goal prompt arrives", async () => {
	const paused = await startGoalForTest();
	await paused.mock.commands.get("goal")?.handler("pause", paused.ctx);

	const pauseToolCall = paused.mock.events.get("tool_call")?.[0];
	assert.deepEqual(pauseToolCall?.({ toolName: "bash", toolCallId: "t1", input: {} }, paused.ctx), {
		block: true,
		reason: STALE_GOAL_TOOL_REASON,
	});

	paused.mock.events.get("input")?.[0]?.(
		{ source: "extension", text: "unrelated extension message" },
		paused.ctx,
	);
	assert.deepEqual(pauseToolCall?.({ toolName: "bash", toolCallId: "t2", input: {} }, paused.ctx), {
		block: true,
		reason: STALE_GOAL_TOOL_REASON,
	});

	paused.mock.events.get("input")?.[0]?.(
		{ source: "interactive", text: "what happened?" },
		paused.ctx,
	);
	assert.equal(
		pauseToolCall?.({ toolName: "bash", toolCallId: "t3", input: {} }, paused.ctx),
		undefined,
	);
});

test("findFinalAssistantMessage returns the last assistant with a known stop reason", () => {
	assert.deepEqual(
		findFinalAssistantMessage([
			{ role: "assistant", stopReason: "stop" },
			{ role: "assistant", stopReason: "error", errorMessage: "bad" },
		]),
		{ role: "assistant", stopReason: "error", errorMessage: "bad" },
	);
	assert.deepEqual(
		findFinalAssistantMessage([
			{
				role: "assistant",
				stopReason: "error",
				errorMessage: "context_length_exceeded",
				provider: "openai",
				model: "gpt-test",
				usage: { input: 10, output: 2 },
				timestamp: 123,
			},
		]),
		{
			role: "assistant",
			stopReason: "error",
			errorMessage: "context_length_exceeded",
			provider: "openai",
			model: "gpt-test",
			usage: {
				input: 10,
				output: 2,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 12,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: 123,
		},
	);
	assert.equal(validateObjective(""), "Usage: /goal <goal_to_complete>");
});

type GoalTool = {
	execute: (...args: unknown[]) => Promise<{
		content?: Array<{ type: string; text: string }>;
		terminate?: boolean;
	}>;
};

type StoredGoal = {
	id: string;
	status?: string;
};

function assertPromptHasGoalId(prompt: string, goalId: string) {
	assert.match(prompt, new RegExp(`<goal_id>\\s*${escapeRegExp(goalId)}\\s*</goal_id>`));
	assert.match(prompt, /pass this exact goal_id/);
	assert.match(prompt, /stale-turn guard/);
}

function escapeRegExp(value: string) {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function requireGoalTool(mock: ReturnType<typeof createMockPi>, name: string) {
	const tool = mock.tools.find((tool) => tool.name === name);
	assert.ok(tool, `expected ${name} to be registered`);
	return tool as unknown as GoalTool;
}

function restoreGoalForTest(
	status: "paused" | "blocked" | "usage_limited" | "budget_limited",
	overrides: { tokenBudget?: number; tokensUsed?: number } = {},
) {
	const sessionGoal = {
		id: `restored-${status}`,
		text: `restore ${status}`,
		status,
		startedAt: 1,
		updatedAt: 2,
		iteration: 3,
		tokenBudget: overrides.tokenBudget ?? 10,
		tokensUsed: overrides.tokensUsed ?? 5,
		timeUsedSeconds: 4,
		baselineTokens: 0,
	};
	const branch = [
		{
			type: "custom",
			customType: "goal-state",
			data: { goal: sessionGoal },
		},
	];
	const mock = createMockPi();
	goal(mock.pi);
	const context = createMockContext({
		sessionManager: { getBranch: () => branch, getEntries: () => branch },
	});
	mock.events.get("session_start")?.[0]?.({}, context.ctx);
	return { mock, ...context, sessionGoal };
}

async function startGoalForTest(overrides: Record<string, unknown> = {}, command = "finish") {
	const mock = createMockPi();
	goal(mock.pi);
	const context = createMockContext(overrides);
	mock.events.get("session_start")?.[0]?.({}, context.ctx);
	await mock.commands.get("goal")?.handler(command, context.ctx);
	return { mock, ...context };
}

function requireLastGoal(mock: ReturnType<typeof createMockPi>) {
	const goal = lastGoal(mock);
	assert.ok(goal, "expected a persisted goal");
	return goal;
}

function lastGoal(mock: ReturnType<typeof createMockPi>) {
	const entry = mock.entries.filter((entry) => entry.customType === "goal-state").at(-1);
	return ((entry?.data as { goal?: StoredGoal | null } | undefined)?.goal ??
		null) as StoredGoal | null;
}

function lastGoalStatus(mock: ReturnType<typeof createMockPi>) {
	return lastGoal(mock)?.status ?? null;
}
