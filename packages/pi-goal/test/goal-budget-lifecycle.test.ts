import assert from "node:assert/strict";
import { test } from "vitest";
import {
	assertPromptHasGoalId,
	assistantUsageEntry,
	lastGoalStatus,
	nonGoalContractSentMessages,
	requireGoalTool,
	requireLastGoal,
	STALE_GOAL_TOOL_REASON,
	startGoalForTest,
} from "./support/goal-fixture.js";

test("tool_execution_end pauses a goal before another turn when terminal tools disappear", async () => {
	let aborts = 0;
	const active = await startGoalForTest({ abort: () => aborts++ });
	const kickoffPrompt = active.mock.sentUserMessages.at(-1)?.text ?? "";
	active.mock.events.get("before_agent_start")?.[0]?.(
		{ prompt: kickoffPrompt, systemPrompt: "base" },
		active.ctx,
	);
	active.mock.rawPi.setActiveTools(["read", "bash"]);

	active.mock.events.get("tool_execution_end")?.[0]?.(
		{ toolCallId: "restricted-tool", toolName: "read", result: {}, isError: false },
		active.ctx,
	);

	assert.equal(lastGoalStatus(active.mock), "paused");
	assert.equal(aborts, 1);
	assert.deepEqual(
		active.mock.events.get("tool_call")?.[0]?.(
			{ toolName: "read", toolCallId: "next-tool", input: {} },
			active.ctx,
		),
		{ block: true, reason: STALE_GOAL_TOOL_REASON },
	);
});

test("tool_execution_end stops budget work, blocks stale tools, and releases the workflow", async () => {
	const branch: Record<string, unknown>[] = [];
	let aborts = 0;
	const budgeted = await startGoalForTest(
		{
			abort: () => aborts++,
			sessionManager: { getBranch: () => branch, getEntries: () => branch },
		},
		"--tokens 10 finish",
	);
	const goalId = requireLastGoal(budgeted.mock).id;
	branch.push(assistantUsageEntry({ totalTokens: 12 }));

	const toolEnd = budgeted.mock.events.get("tool_execution_end")?.[0];
	await toolEnd?.(
		{ toolCallId: "tool-1", toolName: "bash", result: {}, isError: false },
		budgeted.ctx,
	);
	await toolEnd?.(
		{ toolCallId: "tool-2", toolName: "read", result: {}, isError: false },
		budgeted.ctx,
	);

	assert.equal(lastGoalStatus(budgeted.mock), "budget_limited");
	assert.equal(requireLastGoal(budgeted.mock).tokensUsed, 12);
	assert.equal(budgeted.statuses.get("goal"), "budget 12/10 · automatic 0/25");
	assert.equal(nonGoalContractSentMessages(budgeted.mock).length, 0);
	await budgeted.mock.events.get("agent_settled")?.[0]?.({}, budgeted.ctx);
	assert.equal(budgeted.mock.sentUserMessages.length, 1);
	assert.deepEqual(
		budgeted.mock.events.get("tool_call")?.[0]?.(
			{ toolName: "bash", toolCallId: "substantive-after-budget", input: {} },
			budgeted.ctx,
		),
		{ block: true, reason: STALE_GOAL_TOOL_REASON },
	);
	assert.equal(aborts, 2);
	const completion = await requireGoalTool(budgeted.mock, "goal_complete").execute(
		"complete-after-budget",
		{ goal_id: goalId, summary: "All requirements were already implemented and verified." },
		new AbortController().signal,
		() => undefined,
		budgeted.ctx,
	);
	assert.equal(completion.terminate, undefined);
	assert.match(completion.content?.[0]?.text ?? "", /budget_limited, not active/i);
	const released = {
		session: (budgeted.ctx as unknown as { sessionManager: object }).sessionManager,
		group: "agent-workflow",
		busy: false,
	};
	budgeted.mock.eventBus.emit("workflow:mutex:v1", released);
	assert.equal(released.busy, false);
});

test("rejected completion cannot revive a budget-limited goal", async () => {
	const branch: Record<string, unknown>[] = [];
	const budgeted = await startGoalForTest(
		{ sessionManager: { getBranch: () => branch, getEntries: () => branch } },
		"--tokens 10 finish",
	);
	const goalId = requireLastGoal(budgeted.mock).id;
	branch.push(assistantUsageEntry({ totalTokens: 12 }));
	await budgeted.mock.events.get("tool_execution_end")?.[0]?.(
		{ toolCallId: "tool-1", toolName: "bash", result: {}, isError: false },
		budgeted.ctx,
	);

	const rejected = await requireGoalTool(budgeted.mock, "goal_complete").execute(
		"rejected-budget-completion",
		{ goal_id: goalId, summary: "Tests are still failing." },
		new AbortController().signal,
		() => undefined,
		budgeted.ctx,
	);
	assert.equal(rejected.terminate, undefined);
	assert.equal(lastGoalStatus(budgeted.mock), "budget_limited");

	const retry = await requireGoalTool(budgeted.mock, "goal_complete").execute(
		"retry-budget-completion",
		{ goal_id: goalId, summary: "Everything is now complete." },
		new AbortController().signal,
		() => undefined,
		budgeted.ctx,
	);
	assert.equal(retry.terminate, undefined);
	assert.match(retry.content?.[0]?.text ?? "", /budget_limited, not active/i);
});

test("stale completion cannot revive a budget-limited goal", async () => {
	const branch: Record<string, unknown>[] = [];
	const budgeted = await startGoalForTest(
		{ sessionManager: { getBranch: () => branch, getEntries: () => branch } },
		"--tokens 10 finish",
	);
	const goalId = requireLastGoal(budgeted.mock).id;
	branch.push(assistantUsageEntry({ totalTokens: 12 }));
	await budgeted.mock.events.get("tool_execution_end")?.[0]?.(
		{ toolCallId: "tool-1", toolName: "bash", result: {}, isError: false },
		budgeted.ctx,
	);
	branch.push(assistantUsageEntry({ totalTokens: 3 }));

	const rejected = await requireGoalTool(budgeted.mock, "goal_complete").execute(
		"stale-budget-completion",
		{ goal_id: "stale-goal-id", summary: "Everything is complete." },
		new AbortController().signal,
		() => undefined,
		budgeted.ctx,
	);
	assert.equal(rejected.terminate, undefined);
	assert.match(rejected.content?.[0]?.text ?? "", /goal_id does not match/i);
	assert.equal(requireLastGoal(budgeted.mock).tokensUsed, 12);

	const retry = await requireGoalTool(budgeted.mock, "goal_complete").execute(
		"retry-after-stale-budget-completion",
		{ goal_id: goalId, summary: "Everything is complete." },
		new AbortController().signal,
		() => undefined,
		budgeted.ctx,
	);
	assert.match(retry.content?.[0]?.text ?? "", /budget_limited, not active/i);
});

test("budget exhaustion never queues or retries a follow-up wrap-up", async () => {
	const branch: Record<string, unknown>[] = [];
	const budgeted = await startGoalForTest(
		{ sessionManager: { getBranch: () => branch, getEntries: () => branch } },
		"--tokens 10 finish",
	);
	branch.push(assistantUsageEntry({ totalTokens: 12 }));
	const sendMessage = budgeted.mock.rawPi.sendMessage.bind(budgeted.mock.rawPi);
	let attempts = 0;
	budgeted.mock.rawPi.sendMessage = (message, options) => {
		attempts++;
		if (attempts === 1) throw new Error("queue unavailable");
		sendMessage(message, options);
	};

	const toolEnd = budgeted.mock.events.get("tool_execution_end")?.[0];
	await toolEnd?.(
		{ toolCallId: "tool-1", toolName: "bash", result: {}, isError: false },
		budgeted.ctx,
	);
	assert.equal(lastGoalStatus(budgeted.mock), "budget_limited");
	assert.equal(nonGoalContractSentMessages(budgeted.mock).length, 0);
	assert.match(budgeted.notifications.at(-1)?.message ?? "", /token budget reached/i);

	await toolEnd?.(
		{ toolCallId: "tool-2", toolName: "read", result: {}, isError: false },
		budgeted.ctx,
	);
	await toolEnd?.(
		{ toolCallId: "tool-3", toolName: "read", result: {}, isError: false },
		budgeted.ctx,
	);
	assert.equal(attempts, 0);
	assert.equal(nonGoalContractSentMessages(budgeted.mock).length, 0);
});

test("budget wrap-up permission closes at agent_end and stale context is filtered", async () => {
	const branch: Record<string, unknown>[] = [];
	const budgeted = await startGoalForTest(
		{ sessionManager: { getBranch: () => branch, getEntries: () => branch } },
		"--tokens 10 finish",
	);
	const goalId = requireLastGoal(budgeted.mock).id;
	branch.push(assistantUsageEntry({ totalTokens: 12 }));
	await budgeted.mock.events.get("tool_execution_end")?.[0]?.(
		{ toolCallId: "tool-1", toolName: "bash", result: {}, isError: false },
		budgeted.ctx,
	);
	await budgeted.mock.events.get("agent_end")?.[0]?.(
		{ messages: [{ role: "assistant", stopReason: "stop" }] },
		budgeted.ctx,
	);

	const rejected = await requireGoalTool(budgeted.mock, "goal_complete").execute(
		"late-completion",
		{ goal_id: goalId, summary: "Late stale completion." },
		new AbortController().signal,
		() => undefined,
		budgeted.ctx,
	);
	assert.match(rejected.content?.[0]?.text ?? "", /budget_limited, not active/i);
	assert.equal(rejected.terminate, undefined);

	const contextResult = budgeted.mock.events.get("context")?.[0]?.(
		{
			messages: [
				{ role: "user", content: "keep" },
				{ role: "custom", customType: "goal-budget-wrap-up", content: "stale" },
			],
		},
		budgeted.ctx,
	) as { messages?: unknown[] } | undefined;
	assert.deepEqual(contextResult?.messages, [{ role: "user", content: "keep" }]);
});

test("budget stop preserves a pending transformed follow-up without resuming Goal work", async () => {
	const branch: Record<string, unknown>[] = [];
	const budgeted = await startGoalForTest(
		{ sessionManager: { getBranch: () => branch, getEntries: () => branch } },
		"--tokens 10 finish",
	);
	const goalId = requireLastGoal(budgeted.mock).id;
	budgeted.mock.events.get("input")?.[0]?.(
		{ source: "interactive", text: "/skill:review", streamingBehavior: "followUp" },
		budgeted.ctx,
	);
	branch.push(assistantUsageEntry({ totalTokens: 12 }));
	await budgeted.mock.events.get("tool_execution_end")?.[0]?.(
		{ toolCallId: "tool-1", toolName: "bash", result: {}, isError: false },
		budgeted.ctx,
	);

	budgeted.mock.events.get("before_agent_start")?.[0]?.(
		{ prompt: "budget wrap-up", systemPrompt: "base" },
		budgeted.ctx,
	);

	assert.equal(
		budgeted.mock.events.get("tool_call")?.[0]?.(
			{ toolName: "read", toolCallId: "after-budget-read", input: {} },
			budgeted.ctx,
		),
		undefined,
	);
	const completion = await requireGoalTool(budgeted.mock, "goal_complete").execute(
		"after-budget-complete",
		{ goal_id: goalId, summary: "All requirements were implemented and verified." },
		new AbortController().signal,
		() => undefined,
		budgeted.ctx,
	);
	assert.equal(completion.terminate, undefined);
	assert.match(completion.content?.[0]?.text ?? "", /current run does not own/i);
});

test("budget stop queues no custom work and remains stopped through agent_end", async () => {
	const branch: Record<string, unknown>[] = [];
	const budgeted = await startGoalForTest(
		{ sessionManager: { getBranch: () => branch, getEntries: () => branch } },
		"--tokens 10 finish",
	);
	branch.push(assistantUsageEntry({ totalTokens: 12 }));
	await budgeted.mock.events.get("tool_execution_end")?.[0]?.(
		{ toolCallId: "tool-1", toolName: "bash", result: {}, isError: false },
		budgeted.ctx,
	);
	assert.equal(nonGoalContractSentMessages(budgeted.mock).length, 0);
	await budgeted.mock.events.get("agent_end")?.[0]?.(
		{ messages: [{ role: "assistant", stopReason: "stop", content: [] }] },
		budgeted.ctx,
	);
	assert.equal(lastGoalStatus(budgeted.mock), "budget_limited");
	assert.deepEqual(
		budgeted.mock.events.get("tool_call")?.[0]?.(
			{ toolName: "read", toolCallId: "after-budget", input: {} },
			budgeted.ctx,
		),
		{ block: true, reason: STALE_GOAL_TOOL_REASON },
	);
});

test("compaction cancels before retry when persisted usage has exhausted the budget", async () => {
	const branch: Record<string, unknown>[] = [];
	const budgeted = await startGoalForTest(
		{ sessionManager: { getBranch: () => branch, getEntries: () => branch } },
		"--tokens 10 finish",
	);
	branch.push(assistantUsageEntry({ totalTokens: 12 }));

	const result = await budgeted.mock.events.get("session_before_compact")?.[0]?.(
		{ reason: "overflow", willRetry: true },
		budgeted.ctx,
	);
	assert.deepEqual(result, { cancel: true });
	assert.equal(lastGoalStatus(budgeted.mock), "budget_limited");
	assert.equal(nonGoalContractSentMessages(budgeted.mock).length, 0);
	assert.equal(budgeted.mock.sentUserMessages.length, 1);

	await budgeted.mock.events.get("session_compact")?.[0]?.(
		{ reason: "overflow", willRetry: true },
		budgeted.ctx,
	);
	await budgeted.mock.events.get("agent_settled")?.[0]?.({}, budgeted.ctx);
	assert.equal(budgeted.mock.sentUserMessages.length, 1);
});

test("budget edits require an actual increase before rotating the stale id", async () => {
	const branch: Record<string, unknown>[] = [];
	const budgeted = await startGoalForTest(
		{ sessionManager: { getBranch: () => branch, getEntries: () => branch } },
		"--tokens 10 finish",
	);
	branch.push(assistantUsageEntry({ totalTokens: 10 }));
	await budgeted.mock.events.get("agent_end")?.[0]?.(
		{ messages: [{ role: "assistant", stopReason: "stop" }] },
		budgeted.ctx,
	);
	const exhaustedGoal = requireLastGoal(budgeted.mock);
	assert.equal(exhaustedGoal.status, "budget_limited");

	await budgeted.mock.commands.get("goal")?.handler("edit unchanged budget", budgeted.ctx);
	const unchanged = requireLastGoal(budgeted.mock);
	assert.equal(unchanged.status, "budget_limited");
	assert.equal(unchanged.id, exhaustedGoal.id);
	assert.equal(unchanged.text, exhaustedGoal.text);
	assert.equal(budgeted.mock.sentUserMessages.length, 1);
	assert.match(budgeted.notifications.at(-1)?.message ?? "", /raise the budget/i);

	await budgeted.mock.commands
		.get("goal")
		?.handler("edit --tokens 20 increased budget", budgeted.ctx);
	const increased = requireLastGoal(budgeted.mock);
	assert.equal(increased.status, "active");
	assert.equal(increased.tokenBudget, 20);
	assert.notEqual(increased.id, unchanged.id);
	assert.equal(budgeted.mock.sentUserMessages.length, 2);
	assertPromptHasGoalId(budgeted.mock.sentUserMessages.at(-1)?.text ?? "", increased.id);
});

test("failed budget-increase edit delivery restores the limited goal and stale id", async () => {
	const branch: Record<string, unknown>[] = [];
	const budgeted = await startGoalForTest(
		{ sessionManager: { getBranch: () => branch, getEntries: () => branch } },
		"--tokens 10 original objective",
	);
	branch.push(assistantUsageEntry({ totalTokens: 10 }));
	await budgeted.mock.events.get("agent_end")?.[0]?.(
		{ messages: [{ role: "assistant", stopReason: "stop" }] },
		budgeted.ctx,
	);
	const limited = requireLastGoal(budgeted.mock);
	budgeted.mock.rawPi.sendUserMessage = () => {
		throw new Error("edit delivery failed");
	};

	await budgeted.mock.commands
		.get("goal")
		?.handler("edit --tokens 20 changed objective", budgeted.ctx);
	const restored = requireLastGoal(budgeted.mock);
	assert.equal(restored.id, limited.id);
	assert.equal(restored.text, limited.text);
	assert.equal(restored.tokenBudget, limited.tokenBudget);
	assert.equal(restored.status, "budget_limited");
	assert.match(budgeted.notifications.at(-1)?.message ?? "", /edit delivery failed/i);
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
	assert.equal(nonGoalContractSentMessages(budgeted.mock).length, 0);

	await budgeted.mock.events.get("agent_settled")?.[0]?.({}, budgeted.ctx);
	assert.equal(budgeted.mock.sentUserMessages.length, 1);
});
