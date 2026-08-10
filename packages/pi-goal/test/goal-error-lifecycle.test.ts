import assert from "node:assert/strict";
import { test, vi } from "vitest";
import {
	findFinalAssistantMessage,
	isRetryableGoalInterruption,
	isUsageLimitedGoalInterruption,
	validateObjective,
} from "../src/goal.js";
import {
	assistantUsageEntry,
	DELAYED_CONTINUATION_SETTINGS_PATH,
	LOW_LIMITS_SETTINGS_PATH,
	lastGoalStatus,
	requireLastGoal,
	STALE_GOAL_TOOL_REASON,
	startGoalForTest,
} from "./support/goal-fixture.js";

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

test("provider error notifications strip terminal controls without changing classification", async () => {
	const stopped = await startGoalForTest();
	await stopped.mock.events.get("agent_end")?.[0]?.(
		{
			messages: [
				{
					role: "assistant",
					stopReason: "error",
					errorMessage:
						"Permission \u001b]52;c;clipboard\u0007 denied \u001b[2Jremotely \u009bnow\r\u0000",
				},
			],
		},
		stopped.ctx,
	);

	const notification = stopped.notifications.at(-1)?.message ?? "";
	assert.equal(lastGoalStatus(stopped.mock), "blocked");
	assertNoTerminalControls(notification);
	assert.doesNotMatch(notification, /clipboard|\[2J/u);
	assert.match(notification, /Permission\s+denied remotely\s+now/u);
});

test("terminal agent errors take precedence over missing goal tools", async () => {
	for (const [errorMessage, expectedStatus] of [
		["You have hit your ChatGPT usage limit.", "usage_limited"],
		["Permission denied by remote service", "blocked"],
	] as const) {
		const stopped = await startGoalForTest();
		stopped.mock.rawPi.setActiveTools(["read", "bash"]);

		await stopped.mock.events.get("agent_end")?.[0]?.(
			{ messages: [{ role: "assistant", stopReason: "error", errorMessage }] },
			stopped.ctx,
		);

		assert.equal(lastGoalStatus(stopped.mock), expectedStatus);
		assert.equal(stopped.mock.sentUserMessages.length, 1);
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
			errorMessage: "HTTP 524: upstream timeout",
		}),
		true,
	);
	assert.equal(
		isRetryableGoalInterruption({
			role: "assistant",
			stopReason: "error",
			errorMessage: "ResourceExhausted: transient backend capacity",
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
	assert.equal(
		retryable.mock.events.get("tool_call")?.[0]?.(
			{ toolName: "bash", toolCallId: "retry-tool", input: {} },
			retryable.ctx,
		),
		undefined,
	);
	await retryable.mock.events.get("agent_settled")?.[0]?.({}, retryable.ctx);
	assert.equal(retryable.mock.sentUserMessages.length, 1);
	assert.equal(lastGoalStatus(retryable.mock), "blocked");
	assert.deepEqual(
		retryable.mock.events.get("tool_call")?.[0]?.(
			{ toolName: "bash", toolCallId: "retry-exhausted-tool", input: {} },
			retryable.ctx,
		),
		{ block: true, reason: STALE_GOAL_TOOL_REASON },
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

test("automatic ownership survives agent_start retry without before_agent_start", async () => {
	const retried = await startGoalForTest({}, "finish", LOW_LIMITS_SETTINGS_PATH);
	await retried.mock.events.get("agent_end")?.[0]?.(
		{ messages: [{ role: "assistant", stopReason: "stop", content: [] }] },
		retried.ctx,
	);
	await retried.mock.events.get("agent_settled")?.[0]?.({}, retried.ctx);
	const continuation = retried.mock.sentUserMessages.at(-1)?.text ?? "";
	retried.mock.events.get("before_agent_start")?.[0]?.(
		{ prompt: continuation, systemPrompt: "base" },
		retried.ctx,
	);
	retried.mock.events.get("turn_end")?.[0]?.(
		{
			message: {
				role: "assistant",
				stopReason: "error",
				errorMessage: "HTTP 524: upstream timeout",
				content: [],
			},
			toolResults: [],
		},
		retried.ctx,
	);
	await retried.mock.events.get("agent_end")?.[0]?.(
		{
			messages: [
				{
					role: "assistant",
					stopReason: "error",
					errorMessage: "HTTP 524: upstream timeout",
					content: [],
				},
			],
		},
		retried.ctx,
	);
	assert.equal(requireLastGoal(retried.mock).automaticModelTurns, 1);

	retried.mock.events.get("agent_start")?.[0]?.({}, retried.ctx);
	retried.mock.events.get("turn_end")?.[0]?.(
		{ message: { role: "assistant", stopReason: "stop", content: [] }, toolResults: [] },
		retried.ctx,
	);
	await retried.mock.events.get("agent_end")?.[0]?.(
		{ messages: [{ role: "assistant", stopReason: "stop", content: [] }] },
		retried.ctx,
	);
	await retried.mock.events.get("agent_settled")?.[0]?.({}, retried.ctx);

	assert.equal(lastGoalStatus(retried.mock), "active");
	assert.equal(requireLastGoal(retried.mock).automaticModelTurns, 2);
});

test("stale exhausted recovery cannot block a replacement goal", async () => {
	const replaced = await startGoalForTest();
	await replaced.mock.events.get("agent_end")?.[0]?.(
		{
			messages: [
				{
					role: "assistant",
					stopReason: "error",
					errorMessage: "HTTP 524 upstream timeout",
				},
			],
		},
		replaced.ctx,
	);
	const oldGoal = requireLastGoal(replaced.mock);
	await replaced.mock.commands.get("goal")?.handler("replacement objective", replaced.ctx);
	const replacement = requireLastGoal(replaced.mock);
	assert.notEqual(replacement.id, oldGoal.id);

	await replaced.mock.events.get("agent_settled")?.[0]?.({}, replaced.ctx);
	assert.equal(requireLastGoal(replaced.mock).id, replacement.id);
	assert.equal(lastGoalStatus(replaced.mock), "active");
});

test("an exhausted goal does not remain active for a retryable provider error", async () => {
	const branch: Array<Record<string, unknown>> = [];
	const budgeted = await startGoalForTest(
		{ sessionManager: { getBranch: () => branch, getEntries: () => branch } },
		"--tokens 10 finish",
	);
	branch.push(assistantUsageEntry({ totalTokens: 12 }));
	await budgeted.mock.events.get("agent_end")?.[0]?.(
		{
			messages: [{ role: "assistant", stopReason: "error", errorMessage: "WebSocket closed 1000" }],
		},
		budgeted.ctx,
	);

	assert.equal(lastGoalStatus(budgeted.mock), "budget_limited");
	assert.equal(budgeted.mock.sentMessages.length, 0);
	assert.deepEqual(
		await budgeted.mock.events.get("session_before_compact")?.[0]?.(
			{ reason: "overflow", willRetry: true },
			budgeted.ctx,
		),
		{ cancel: true },
	);
	await budgeted.mock.events.get("agent_settled")?.[0]?.({}, budgeted.ctx);
	assert.equal(budgeted.mock.sentUserMessages.length, 1);
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
	assert.equal(lastGoalStatus(overflow.mock), "active");

	// Pi retries through agent.continue(), which emits agent_start but not before_agent_start.
	overflow.mock.events.get("agent_start")?.[0]?.({}, overflow.ctx);
	await overflow.mock.events.get("agent_end")?.[0]?.(
		{
			messages: [
				{ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "recovered" }] },
			],
		},
		overflow.ctx,
	);
	await overflow.mock.events.get("agent_settled")?.[0]?.({}, overflow.ctx);

	assert.equal(lastGoalStatus(overflow.mock), "active");
	assert.equal(overflow.mock.sentUserMessages.length, 2);
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

test("idle manual compaction waits the configured interval before fallback dispatch", async () => {
	vi.useFakeTimers();
	try {
		const compacted = await startGoalForTest(
			{ isIdle: () => true },
			"finish",
			DELAYED_CONTINUATION_SETTINGS_PATH,
		);

		await compacted.mock.events.get("session_compact")?.[0]?.(
			{ reason: "manual", willRetry: false },
			compacted.ctx,
		);
		assert.equal(compacted.mock.sentUserMessages.length, 1);

		await vi.advanceTimersByTimeAsync(999);
		assert.equal(compacted.mock.sentUserMessages.length, 1);
		await vi.advanceTimersByTimeAsync(1);
		assert.equal(compacted.mock.sentUserMessages.length, 2);
		assert.match(compacted.mock.sentUserMessages.at(-1)?.text ?? "", /pi-goal-continuation/);
	} finally {
		vi.useRealTimers();
	}
});

test("session shutdown cancels a deferred manual-compaction continuation", async () => {
	const compacted = await startGoalForTest({ isIdle: () => true });

	await compacted.mock.events.get("session_compact")?.[0]?.(
		{ reason: "manual", willRetry: false },
		compacted.ctx,
	);
	compacted.mock.events.get("session_shutdown")?.[0]?.({}, compacted.ctx);
	await new Promise((resolve) => setTimeout(resolve, 10));

	assert.equal(compacted.mock.sentUserMessages.length, 1);
});

test("session replacement cancels a deferred manual-compaction continuation", async () => {
	const compacted = await startGoalForTest({ isIdle: () => true });

	await compacted.mock.events.get("session_compact")?.[0]?.(
		{ reason: "manual", willRetry: false },
		compacted.ctx,
	);
	await compacted.mock.events.get("session_start")?.[0]?.({}, compacted.ctx);
	await new Promise((resolve) => setTimeout(resolve, 10));

	assert.equal(compacted.mock.sentUserMessages.length, 1);
});

test("explicit pause cancels a deferred manual-compaction continuation", async () => {
	const compacted = await startGoalForTest({ isIdle: () => true });

	await compacted.mock.events.get("session_compact")?.[0]?.(
		{ reason: "manual", willRetry: false },
		compacted.ctx,
	);
	await compacted.mock.commands.get("goal")?.handler("pause", compacted.ctx);
	await new Promise((resolve) => setTimeout(resolve, 10));

	assert.equal(compacted.mock.sentUserMessages.length, 1);
	assert.equal(lastGoalStatus(compacted.mock), "paused");
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
		{ source: "interactive", text: "/goal edit revised paused objective" },
		paused.ctx,
	);
	assert.deepEqual(pauseToolCall?.({ toolName: "bash", toolCallId: "t3", input: {} }, paused.ctx), {
		block: true,
		reason: STALE_GOAL_TOOL_REASON,
	});

	paused.mock.events.get("input")?.[0]?.(
		{ source: "interactive", text: "what happened?" },
		paused.ctx,
	);
	assert.equal(
		pauseToolCall?.({ toolName: "bash", toolCallId: "t4", input: {} }, paused.ctx),
		undefined,
	);
});

function assertNoTerminalControls(value: string) {
	for (const character of value) {
		const codePoint = character.codePointAt(0) ?? 0;
		if (character === "\n") continue;
		assert.ok(codePoint > 0x1f && (codePoint < 0x7f || codePoint > 0x9f));
	}
}

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
