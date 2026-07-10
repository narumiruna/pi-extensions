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
	parseCommand,
	parseTokenBudget,
	validateObjective,
} from "../src/goal.js";

test("goal registers command, completion tool, and lifecycle hooks", () => {
	const mock = createMockPi();
	goal(mock.pi);

	assert.ok(mock.commands.has("goal"));
	assert.equal(typeof mock.commands.get("goal")?.getArgumentCompletions, "function");
	assert.equal(mock.tools[0]?.name, "goal_complete");
	const toolParameters = mock.tools[0]?.parameters as
		| { required?: string[]; properties?: Record<string, unknown> }
		| undefined;
	assert.deepEqual(toolParameters?.required, ["goal_id", "summary"]);
	assert.ok(toolParameters?.properties?.goal_id);
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
			"Resume a paused or budget-limited goal",
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

test("formatStatus reports active, paused, budget-limited, and empty states", () => {
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
	assert.equal(formatStatus({ ...activeGoal, status: "budget_limited" }), "budget 500/2k");
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
	const tool = mock.tools[0] as GoalTool;
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
	const tool = mock.tools[0] as GoalTool;
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
	const replacementTool = replaced.mock.tools[0] as GoalTool;
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
	const resumeTool = resumed.mock.tools[0] as GoalTool;
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
		{
			block: true,
			reason: "Blocked stale /goal tool call after the goal was paused or interrupted.",
		},
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
	const clearTool = cleared.mock.tools[0] as GoalTool;
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
		{
			block: true,
			reason: "Blocked stale /goal tool call after the goal was paused or interrupted.",
		},
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

	const tool = cleared.mock.tools[0] as GoalTool;
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
		{
			block: true,
			reason: "Blocked stale /goal tool call after the goal was paused or interrupted.",
		},
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
			await (changed.mock.tools[0] as GoalTool).execute(
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

test("agent_end keeps retryable interruptions active but pauses non-retryable errors", async () => {
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
	assert.equal(lastGoalStatus(nonRetryable.mock), "paused");
	await nonRetryable.mock.events.get("agent_settled")?.[0]?.({}, nonRetryable.ctx);
	assert.equal(nonRetryable.mock.sentUserMessages.length, 1);
	assert.deepEqual(
		nonRetryable.mock.events.get("tool_call")?.[0]?.(
			{ toolName: "bash", toolCallId: "t1", input: {} },
			nonRetryable.ctx,
		),
		{
			block: true,
			reason: "Blocked stale /goal tool call after the goal was paused or interrupted.",
		},
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
		reason: "Blocked stale /goal tool call after the goal was paused or interrupted.",
	});

	paused.mock.events.get("input")?.[0]?.(
		{ source: "extension", text: "unrelated extension message" },
		paused.ctx,
	);
	assert.deepEqual(pauseToolCall?.({ toolName: "bash", toolCallId: "t2", input: {} }, paused.ctx), {
		block: true,
		reason: "Blocked stale /goal tool call after the goal was paused or interrupted.",
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
