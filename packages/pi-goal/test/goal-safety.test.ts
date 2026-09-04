import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
	classifyAssistantTools,
	fingerprintVisibleAssistantOutput,
	hasAssistantToolCall,
	isWorkspaceToolCall,
	nextToolFreeRepeatState,
	normalizeVisibleAssistantOutput,
} from "../src/safety.js";
import {
	LOW_LIMITS_SETTINGS_PATH,
	lastGoalStatus,
	ONE_TURN_LIMIT_SETTINGS_PATH,
	requireLastGoal,
	startGoalForTest,
	UNLIMITED_SETTINGS_PATH,
} from "./support/goal-fixture.js";

test("no-progress classifier normalizes visible output conservatively", () => {
	const blank = [{ role: "assistant", content: [{ type: "text", text: "  ...\u0000 " }] }];
	const thinkingOnly = [
		{ role: "assistant", content: [{ type: "thinking", thinking: "hidden" }, null] },
		{ malformed: true },
	];
	assert.equal(normalizeVisibleAssistantOutput(blank), "");
	assert.equal(normalizeVisibleAssistantOutput(thinkingOnly), "");
	assert.equal(
		normalizeVisibleAssistantOutput([
			{ role: "assistant", content: [{ type: "text", text: "foo\n\tbar" }] },
		]),
		"foo bar",
	);
	assert.equal(
		fingerprintVisibleAssistantOutput([
			{ role: "assistant", content: [{ type: "text", text: "foo\nbar" }] },
		]),
		fingerprintVisibleAssistantOutput([
			{ role: "assistant", content: [{ type: "text", text: "foo bar" }] },
		]),
	);
	assert.equal(
		fingerprintVisibleAssistantOutput(blank),
		fingerprintVisibleAssistantOutput(thinkingOnly),
	);
	assert.equal(
		hasAssistantToolCall([
			{ role: "assistant", content: [{ type: "toolCall", name: "unknown", arguments: {} }] },
		]),
		true,
	);

	let state = { toolFreeRepeatCount: 0 };
	state = nextToolFreeRepeatState(
		state,
		[{ role: "assistant", content: [{ type: "text", text: "  STILL   Working " }] }],
		false,
	);
	assert.equal(state.toolFreeRepeatCount, 1);
	state = nextToolFreeRepeatState(
		state,
		[{ role: "assistant", content: [{ type: "text", text: "still working" }] }],
		false,
	);
	assert.equal(state.toolFreeRepeatCount, 2);
	state = nextToolFreeRepeatState(
		state,
		[{ role: "assistant", content: [{ type: "text", text: "different short output" }] }],
		false,
	);
	assert.equal(state.toolFreeRepeatCount, 1);
	state = nextToolFreeRepeatState(state, blank, true);
	assert.deepEqual(state, { toolFreeRepeatCount: 0 });

	assert.equal(isWorkspaceToolCall("read", { path: "src/a.ts" }), true);
	assert.equal(isWorkspaceToolCall("bash", { command: "npm test" }), true);
	assert.equal(isWorkspaceToolCall("scratch_board", { action: "update" }), false);
	assert.equal(isWorkspaceToolCall("overlay_tick", {}), false);
	assert.equal(
		isWorkspaceToolCall("custom_ui", { path: "x" }, { chromeTools: ["custom_ui"] }),
		false,
	);
	assert.equal(isWorkspaceToolCall("my_deploy", {}, { progressTools: ["my_deploy"] }), true);
	assert.equal(
		classifyAssistantTools([
			{
				role: "assistant",
				content: [{ type: "toolCall", name: "scratch_board", arguments: { id: 1 } }],
			},
		]),
		"chrome",
	);
	assert.equal(
		classifyAssistantTools([
			{
				role: "assistant",
				content: [{ type: "toolCall", name: "read", arguments: { path: "a.ts" } }],
			},
		]),
		"progress",
	);
	let chromeState = { toolFreeRepeatCount: 0 };
	chromeState = nextToolFreeRepeatState(
		chromeState,
		[
			{
				role: "assistant",
				content: [
					{ type: "text", text: "step 1 is the gate" },
					{ type: "toolCall", name: "scratch_board", arguments: { action: "update" } },
				],
			},
		],
		false,
	);
	assert.equal(chromeState.toolFreeRepeatCount, 1);
	chromeState = nextToolFreeRepeatState(
		chromeState,
		[
			{
				role: "assistant",
				content: [
					{ type: "text", text: "step 1 still owns this" },
					{ type: "toolCall", name: "overlay_tick", arguments: {} },
				],
			},
		],
		false,
	);
	assert.equal(
		chromeState.toolFreeRepeatCount,
		2,
		"chrome-only paraphrases must increment even when visible text changes",
	);
});

test("assistant toolCall blocks reset no-progress even when tool_call hook never fires", async () => {
	const active = await startGoalForTest({}, "finish", LOW_LIMITS_SETTINGS_PATH);
	await active.mock.events.get("agent_end")?.[0]?.(
		{ messages: [{ role: "assistant", stopReason: "stop", content: [] }] },
		active.ctx,
	);
	await active.mock.events.get("agent_settled")?.[0]?.({}, active.ctx);
	for (let run = 1; run <= 2; run++) {
		const prompt = active.mock.sentUserMessages.at(-1)?.text ?? "";
		active.mock.events.get("before_agent_start")?.[0]?.(
			{ prompt, systemPrompt: "base" },
			active.ctx,
		);
		await active.mock.events.get("agent_end")?.[0]?.(
			{ messages: [{ role: "assistant", stopReason: "stop", content: [] }] },
			active.ctx,
		);
		await active.mock.events.get("agent_settled")?.[0]?.({}, active.ctx);
	}
	assert.equal(requireLastGoal(active.mock).toolFreeRepeatCount, 2);

	const prompt = active.mock.sentUserMessages.at(-1)?.text ?? "";
	active.mock.events.get("before_agent_start")?.[0]?.({ prompt, systemPrompt: "base" }, active.ctx);
	await active.mock.events.get("agent_end")?.[0]?.(
		{
			messages: [
				{
					role: "assistant",
					stopReason: "toolUse",
					content: [{ type: "toolCall", name: "read", arguments: { path: "src/a.ts" } }],
				},
			],
		},
		active.ctx,
	);
	assert.equal(lastGoalStatus(active.mock), "active");
	assert.equal(requireLastGoal(active.mock).toolFreeRepeatCount, 0);
});

test("automatic turn_end hard cap pauses a tool loop before another normal response", async () => {
	let aborts = 0;
	const capped = await startGoalForTest(
		{ abort: () => aborts++ },
		"finish",
		LOW_LIMITS_SETTINGS_PATH,
	);
	const kickoffPrompt = capped.mock.sentUserMessages.at(-1)?.text ?? "";
	capped.mock.events.get("before_agent_start")?.[0]?.(
		{ prompt: kickoffPrompt, systemPrompt: "base" },
		capped.ctx,
	);
	capped.mock.events.get("turn_end")?.[0]?.(
		{ message: { role: "assistant", stopReason: "stop", content: [] }, toolResults: [] },
		capped.ctx,
	);
	assert.equal(requireLastGoal(capped.mock).automaticModelTurns, 0);
	await capped.mock.events.get("agent_end")?.[0]?.(
		{ messages: [{ role: "assistant", stopReason: "stop", content: [] }] },
		capped.ctx,
	);
	await capped.mock.events.get("agent_settled")?.[0]?.({}, capped.ctx);
	const continuationPrompt = capped.mock.sentUserMessages.at(-1)?.text ?? "";
	capped.mock.events.get("before_agent_start")?.[0]?.(
		{ prompt: continuationPrompt, systemPrompt: "base" },
		capped.ctx,
	);

	for (let turn = 1; turn <= 3; turn++) {
		capped.mock.events.get("tool_call")?.[0]?.(
			{ toolName: "read", toolCallId: `tool-${turn}`, input: {} },
			capped.ctx,
		);
		capped.mock.events.get("turn_end")?.[0]?.(
			{
				message: { role: "assistant", stopReason: "toolUse", content: [] },
				toolResults: [],
			},
			capped.ctx,
		);
	}

	const stopped = requireLastGoal(capped.mock);
	assert.equal(stopped.status, "paused");
	assert.equal(stopped.automaticModelTurns, 3);
	assert.equal(stopped.safetyPauseCause, "continuation_limit");
	assert.equal(aborts, 1);
	assert.equal(
		capped.notifications.filter((notice) =>
			/Automatic-work limit reached: 3 of 3 responses/i.test(notice.message),
		).length,
		1,
	);
	await capped.mock.commands.get("goal")?.handler("", capped.ctx);
	assert.match(capped.notifications.at(-1)?.message ?? "", /Automatic work: 3 of 3 responses/i);
	assert.match(
		capped.notifications.at(-1)?.message ?? "",
		/Safety pause: automatic-work limit reached/i,
	);
	capped.mock.events.get("turn_end")?.[0]?.(
		{ message: { role: "assistant", stopReason: "aborted", content: [] }, toolResults: [] },
		capped.ctx,
	);
	assert.equal(requireLastGoal(capped.mock).automaticModelTurns, 3);
	await capped.mock.events.get("agent_end")?.[0]?.(
		{ messages: [{ role: "assistant", stopReason: "aborted", content: [] }] },
		capped.ctx,
	);
	await capped.mock.events.get("agent_settled")?.[0]?.({}, capped.ctx);
	assert.equal(capped.mock.sentUserMessages.length, 2);
});

test("a preceding input transform preserves automatic continuation ownership", async () => {
	let aborts = 0;
	const capped = await startGoalForTest(
		{ abort: () => aborts++ },
		"finish",
		ONE_TURN_LIMIT_SETTINGS_PATH,
	);
	await capped.mock.events.get("agent_end")?.[0]?.(
		{ messages: [{ role: "assistant", stopReason: "stop", content: [] }] },
		capped.ctx,
	);
	await capped.mock.events.get("agent_settled")?.[0]?.({}, capped.ctx);
	const continuation = capped.mock.sentUserMessages.at(-1)?.text ?? "";
	const transformed = `Respond briefly:\n\n${continuation}`;

	capped.mock.events.get("input")?.[0]?.({ source: "extension", text: transformed }, capped.ctx);
	capped.mock.events.get("before_agent_start")?.[0]?.(
		{ prompt: transformed, systemPrompt: "base" },
		capped.ctx,
	);
	capped.mock.events.get("turn_end")?.[0]?.(
		{ message: { role: "assistant", stopReason: "stop", content: [] }, toolResults: [] },
		capped.ctx,
	);

	const stopped = requireLastGoal(capped.mock);
	assert.equal(stopped.status, "paused");
	assert.equal(stopped.automaticModelTurns, 1);
	assert.equal(stopped.safetyPauseCause, "continuation_limit");
	assert.equal(aborts, 1);
});

test("a following prefix transform preserves automatic continuation ownership", async () => {
	let aborts = 0;
	const capped = await startGoalForTest(
		{ abort: () => aborts++ },
		"finish",
		ONE_TURN_LIMIT_SETTINGS_PATH,
	);
	await capped.mock.events.get("agent_end")?.[0]?.(
		{ messages: [{ role: "assistant", stopReason: "stop", content: [] }] },
		capped.ctx,
	);
	await capped.mock.events.get("agent_settled")?.[0]?.({}, capped.ctx);
	const continuation = capped.mock.sentUserMessages.at(-1)?.text ?? "";
	const transformed = `Respond briefly:\n\n${continuation}`;

	capped.mock.events.get("input")?.[0]?.({ source: "extension", text: continuation }, capped.ctx);
	capped.mock.events.get("before_agent_start")?.[0]?.(
		{ prompt: transformed, systemPrompt: "base" },
		capped.ctx,
	);
	capped.mock.events.get("turn_end")?.[0]?.(
		{ message: { role: "assistant", stopReason: "stop", content: [] }, toolResults: [] },
		capped.ctx,
	);

	const stopped = requireLastGoal(capped.mock);
	assert.equal(stopped.status, "paused");
	assert.equal(stopped.automaticModelTurns, 1);
	assert.equal(stopped.safetyPauseCause, "continuation_limit");
	assert.equal(aborts, 1);
});

test("a preceding input transform preserves Goal prompt ownership", async () => {
	const active = await startGoalForTest({}, "finish", LOW_LIMITS_SETTINGS_PATH);
	const kickoff = active.mock.sentUserMessages.at(-1)?.text ?? "";
	const transformed = `Respond briefly:\n\n${kickoff}`;
	const safety = requireLastGoal(active.mock);
	safety.automaticModelTurns = 2;
	safety.toolFreeRepeatCount = 2;
	safety.lastToolFreeOutputFingerprint = "5".repeat(64);

	active.mock.events.get("input")?.[0]?.({ source: "extension", text: transformed }, active.ctx);
	active.mock.events.get("before_agent_start")?.[0]?.(
		{ prompt: transformed, systemPrompt: "base" },
		active.ctx,
	);

	assert.equal(requireLastGoal(active.mock).automaticModelTurns, 0);
	assert.equal(requireLastGoal(active.mock).toolFreeRepeatCount, 0);
});

test("a following prefix transform preserves Goal prompt ownership", async () => {
	const active = await startGoalForTest({}, "finish", LOW_LIMITS_SETTINGS_PATH);
	const kickoff = active.mock.sentUserMessages.at(-1)?.text ?? "";
	const transformed = `Respond briefly:\n\n${kickoff}`;
	const safety = requireLastGoal(active.mock);
	safety.automaticModelTurns = 2;
	safety.toolFreeRepeatCount = 2;
	safety.lastToolFreeOutputFingerprint = "4".repeat(64);

	active.mock.events.get("input")?.[0]?.({ source: "extension", text: kickoff }, active.ctx);
	active.mock.events.get("before_agent_start")?.[0]?.(
		{ prompt: transformed, systemPrompt: "base" },
		active.ctx,
	);

	assert.equal(requireLastGoal(active.mock).automaticModelTurns, 0);
	assert.equal(requireLastGoal(active.mock).toolFreeRepeatCount, 0);
});

test("a following marker quote or appended text cannot claim a Goal prompt", async () => {
	for (const variant of ["quoted-marker", "appended-text"] as const) {
		const active = await startGoalForTest({}, "finish", LOW_LIMITS_SETTINGS_PATH);
		const kickoff = active.mock.sentUserMessages.at(-1)?.text ?? "";
		const marker = kickoff.match(/<!-- pi-goal-prompt:[^>]+-->/u)?.[0] ?? "";
		assert.notEqual(marker, "");
		const safety = requireLastGoal(active.mock);
		safety.automaticModelTurns = 2;
		safety.toolFreeRepeatCount = 2;
		safety.lastToolFreeOutputFingerprint = "3".repeat(64);
		const external =
			variant === "quoted-marker"
				? `External monitor quoted ${marker}`
				: `${kickoff}\n\nExternal monitor result: approved`;

		active.mock.events.get("input")?.[0]?.({ source: "extension", text: kickoff }, active.ctx);
		active.mock.events.get("before_agent_start")?.[0]?.(
			{ prompt: external, systemPrompt: "base" },
			active.ctx,
		);

		assert.equal(requireLastGoal(active.mock).automaticModelTurns, 2, variant);
		assert.equal(requireLastGoal(active.mock).toolFreeRepeatCount, 2, variant);
	}
});

test("quoted or externally extended continuation markers remain non-owned", async () => {
	for (const variant of ["quoted-marker", "appended-text"] as const) {
		const active = await startGoalForTest({}, "finish", LOW_LIMITS_SETTINGS_PATH);
		await active.mock.events.get("agent_end")?.[0]?.(
			{ messages: [{ role: "assistant", stopReason: "stop", content: [] }] },
			active.ctx,
		);
		await active.mock.events.get("agent_settled")?.[0]?.({}, active.ctx);
		const continuation = active.mock.sentUserMessages.at(-1)?.text ?? "";
		const marker = continuation.match(/<!-- pi-goal-continuation:[^>]+-->/u)?.[0] ?? "";
		assert.notEqual(marker, "");
		const external =
			variant === "quoted-marker"
				? `External monitor quoted ${marker}`
				: `${continuation}\n\nExternal monitor result: approved`;

		// pi-goal sees the exact prompt before a later input handler rewrites it.
		active.mock.events.get("input")?.[0]?.(
			{ source: "extension", text: continuation, streamingBehavior: "followUp" },
			active.ctx,
		);
		active.mock.events.get("before_agent_start")?.[0]?.(
			{ prompt: external, systemPrompt: "base" },
			active.ctx,
		);
		active.mock.events.get("turn_end")?.[0]?.(
			{ message: { role: "assistant", stopReason: "stop", content: [] }, toolResults: [] },
			active.ctx,
		);

		assert.equal(requireLastGoal(active.mock).automaticModelTurns, 0, variant);
	}
});

test("hard cap aborts Pi recovery started after a retryable boundary error", async () => {
	let aborts = 0;
	const capped = await startGoalForTest(
		{ abort: () => aborts++ },
		"finish",
		ONE_TURN_LIMIT_SETTINGS_PATH,
	);
	await capped.mock.events.get("agent_end")?.[0]?.(
		{ messages: [{ role: "assistant", stopReason: "stop", content: [] }] },
		capped.ctx,
	);
	await capped.mock.events.get("agent_settled")?.[0]?.({}, capped.ctx);
	const continuation = capped.mock.sentUserMessages.at(-1)?.text ?? "";
	capped.mock.events.get("before_agent_start")?.[0]?.(
		{ prompt: continuation, systemPrompt: "base" },
		capped.ctx,
	);
	const retryableError = {
		role: "assistant",
		stopReason: "error",
		errorMessage: "HTTP 524: upstream timeout",
		content: [],
	};
	capped.mock.events.get("turn_end")?.[0]?.(
		{ message: retryableError, toolResults: [] },
		capped.ctx,
	);
	await capped.mock.events.get("agent_end")?.[0]?.({ messages: [retryableError] }, capped.ctx);
	assert.equal(lastGoalStatus(capped.mock), "paused");
	assert.equal(aborts, 1);

	capped.mock.events.get("agent_start")?.[0]?.({}, capped.ctx);
	assert.equal(aborts, 1);
	capped.mock.events.get("context")?.[0]?.({ messages: [] }, capped.ctx);
	assert.equal(aborts, 2);
	capped.mock.events.get("turn_end")?.[0]?.(
		{ message: { role: "assistant", stopReason: "aborted", content: [] }, toolResults: [] },
		capped.ctx,
	);
	await capped.mock.events.get("agent_end")?.[0]?.(
		{ messages: [{ role: "assistant", stopReason: "aborted", content: [] }] },
		capped.ctx,
	);
	await capped.mock.events.get("agent_settled")?.[0]?.({}, capped.ctx);
	assert.equal(requireLastGoal(capped.mock).automaticModelTurns, 1);
	assert.equal(capped.mock.sentUserMessages.length, 2);
});

test("an aborted automatic response does not consume the final hard-cap turn", async () => {
	const interrupted = await startGoalForTest({}, "finish", ONE_TURN_LIMIT_SETTINGS_PATH);
	await interrupted.mock.events.get("agent_end")?.[0]?.(
		{ messages: [{ role: "assistant", stopReason: "stop", content: [] }] },
		interrupted.ctx,
	);
	await interrupted.mock.events.get("agent_settled")?.[0]?.({}, interrupted.ctx);
	const continuation = interrupted.mock.sentUserMessages.at(-1)?.text ?? "";
	interrupted.mock.events.get("before_agent_start")?.[0]?.(
		{ prompt: continuation, systemPrompt: "base" },
		interrupted.ctx,
	);
	const aborted = { role: "assistant", stopReason: "aborted", content: [] };
	interrupted.mock.events.get("turn_end")?.[0]?.(
		{ message: aborted, toolResults: [] },
		interrupted.ctx,
	);
	assert.equal(lastGoalStatus(interrupted.mock), "active");
	assert.equal(requireLastGoal(interrupted.mock).automaticModelTurns, 0);
	await interrupted.mock.events.get("agent_end")?.[0]?.({ messages: [aborted] }, interrupted.ctx);
	assert.equal(lastGoalStatus(interrupted.mock), "paused");
	assert.equal(requireLastGoal(interrupted.mock).safetyPauseCause, undefined);
});

test("terminal errors take precedence when an automatic response reaches the hard cap", async () => {
	for (const [errorMessage, expectedStatus] of [
		["usage limit reached for this account", "usage_limited"],
		["invalid request payload", "blocked"],
	] as const) {
		const capped = await startGoalForTest({}, "finish", ONE_TURN_LIMIT_SETTINGS_PATH);
		await capped.mock.events.get("agent_end")?.[0]?.(
			{ messages: [{ role: "assistant", stopReason: "stop", content: [] }] },
			capped.ctx,
		);
		await capped.mock.events.get("agent_settled")?.[0]?.({}, capped.ctx);
		const continuation = capped.mock.sentUserMessages.at(-1)?.text ?? "";
		capped.mock.events.get("before_agent_start")?.[0]?.(
			{ prompt: continuation, systemPrompt: "base" },
			capped.ctx,
		);
		const error = { role: "assistant", stopReason: "error", errorMessage, content: [] };
		capped.mock.events.get("turn_end")?.[0]?.({ message: error, toolResults: [] }, capped.ctx);
		assert.equal(lastGoalStatus(capped.mock), "active");
		await capped.mock.events.get("agent_end")?.[0]?.({ messages: [error] }, capped.ctx);
		assert.equal(lastGoalStatus(capped.mock), expectedStatus);
		assert.equal(requireLastGoal(capped.mock).automaticModelTurns, 1);
	}
});

test("hard-cap cleanup guard does not abort an unrelated queued follow-up", async () => {
	let aborts = 0;
	const capped = await startGoalForTest(
		{ abort: () => aborts++ },
		"finish",
		ONE_TURN_LIMIT_SETTINGS_PATH,
	);
	await capped.mock.events.get("agent_end")?.[0]?.(
		{ messages: [{ role: "assistant", stopReason: "stop", content: [] }] },
		capped.ctx,
	);
	await capped.mock.events.get("agent_settled")?.[0]?.({}, capped.ctx);
	const continuation = capped.mock.sentUserMessages.at(-1)?.text ?? "";
	capped.mock.events.get("before_agent_start")?.[0]?.(
		{ prompt: continuation, systemPrompt: "base" },
		capped.ctx,
	);
	capped.mock.events.get("input")?.[0]?.(
		{
			source: "extension",
			text: "unrelated extension follow-up",
			streamingBehavior: "followUp",
		},
		capped.ctx,
	);
	capped.mock.events.get("turn_end")?.[0]?.(
		{ message: { role: "assistant", stopReason: "stop", content: [] }, toolResults: [] },
		capped.ctx,
	);
	assert.equal(lastGoalStatus(capped.mock), "paused");
	assert.equal(aborts, 1);

	capped.mock.events.get("agent_start")?.[0]?.({}, capped.ctx);
	assert.equal(aborts, 1);
	assert.equal(
		capped.mock.events.get("tool_call")?.[0]?.(
			{ toolName: "read", toolCallId: "unrelated-follow-up-read", input: {} },
			capped.ctx,
		),
		undefined,
	);
});

test("queued custom follow-up starts without cleanup abort or stale tool blocking", async () => {
	let aborts = 0;
	const capped = await startGoalForTest(
		{ abort: () => aborts++ },
		"finish",
		ONE_TURN_LIMIT_SETTINGS_PATH,
	);
	await capped.mock.events.get("agent_end")?.[0]?.(
		{ messages: [{ role: "assistant", stopReason: "stop", content: [] }] },
		capped.ctx,
	);
	await capped.mock.events.get("agent_settled")?.[0]?.({}, capped.ctx);
	const continuation = capped.mock.sentUserMessages.at(-1)?.text ?? "";
	capped.mock.events.get("before_agent_start")?.[0]?.(
		{ prompt: continuation, systemPrompt: "base" },
		capped.ctx,
	);
	capped.mock.events.get("turn_end")?.[0]?.(
		{ message: { role: "assistant", stopReason: "stop", content: [] }, toolResults: [] },
		capped.ctx,
	);
	assert.equal(lastGoalStatus(capped.mock), "paused");
	assert.equal(aborts, 1);

	capped.mock.events.get("agent_start")?.[0]?.({}, capped.ctx);
	assert.equal(aborts, 1);
	const customFollowUp = {
		role: "custom",
		customType: "other-extension-follow-up",
		content: "unrelated custom work",
	};
	capped.mock.events.get("message_start")?.[0]?.({ message: customFollowUp }, capped.ctx);
	capped.mock.events.get("context")?.[0]?.({ messages: [customFollowUp] }, capped.ctx);
	assert.equal(aborts, 1);
	assert.equal(
		capped.mock.events.get("tool_call")?.[0]?.(
			{ toolName: "read", toolCallId: "custom-follow-up-read", input: {} },
			capped.ctx,
		),
		undefined,
	);
});

test("a queued follow-up marker is not consumed by an earlier matching steer", async () => {
	let aborts = 0;
	const capped = await startGoalForTest(
		{ abort: () => aborts++ },
		"finish",
		ONE_TURN_LIMIT_SETTINGS_PATH,
	);
	await capped.mock.events.get("agent_end")?.[0]?.(
		{ messages: [{ role: "assistant", stopReason: "stop", content: [] }] },
		capped.ctx,
	);
	await capped.mock.events.get("agent_settled")?.[0]?.({}, capped.ctx);
	const continuation = capped.mock.sentUserMessages.at(-1)?.text ?? "";
	capped.mock.events.get("before_agent_start")?.[0]?.(
		{ prompt: continuation, systemPrompt: "base" },
		capped.ctx,
	);
	capped.mock.events.get("input")?.[0]?.(
		{ source: "extension", text: "same prompt", streamingBehavior: "followUp" },
		capped.ctx,
	);
	capped.mock.events.get("input")?.[0]?.(
		{ source: "extension", text: "same prompt", streamingBehavior: "steer" },
		capped.ctx,
	);
	capped.mock.events.get("message_start")?.[0]?.(
		{ message: { role: "user", content: [{ type: "text", text: "same prompt" }] } },
		capped.ctx,
	);
	capped.mock.events.get("turn_end")?.[0]?.(
		{ message: { role: "assistant", stopReason: "stop", content: [] }, toolResults: [] },
		capped.ctx,
	);
	assert.equal(lastGoalStatus(capped.mock), "paused");
	assert.equal(requireLastGoal(capped.mock).automaticModelTurns, 1);
	assert.equal(aborts, 1);

	capped.mock.events.get("agent_start")?.[0]?.({}, capped.ctx);
	assert.equal(aborts, 1);
	assert.equal(
		capped.mock.events.get("tool_call")?.[0]?.(
			{ toolName: "read", toolCallId: "matching-follow-up-read", input: {} },
			capped.ctx,
		),
		undefined,
	);
});

test("mid-stream steer does not suppress hard-cap cleanup abort", async () => {
	let aborts = 0;
	const capped = await startGoalForTest(
		{ abort: () => aborts++ },
		"finish",
		ONE_TURN_LIMIT_SETTINGS_PATH,
	);
	await capped.mock.events.get("agent_end")?.[0]?.(
		{ messages: [{ role: "assistant", stopReason: "stop", content: [] }] },
		capped.ctx,
	);
	await capped.mock.events.get("agent_settled")?.[0]?.({}, capped.ctx);
	const continuation = capped.mock.sentUserMessages.at(-1)?.text ?? "";
	capped.mock.events.get("before_agent_start")?.[0]?.(
		{ prompt: continuation, systemPrompt: "base" },
		capped.ctx,
	);
	capped.mock.events.get("input")?.[0]?.(
		{ source: "extension", text: "unrelated steer", streamingBehavior: "steer" },
		capped.ctx,
	);
	capped.mock.events.get("turn_end")?.[0]?.(
		{ message: { role: "assistant", stopReason: "stop", content: [] }, toolResults: [] },
		capped.ctx,
	);
	assert.equal(aborts, 1);
	capped.mock.events.get("agent_start")?.[0]?.({}, capped.ctx);
	assert.equal(aborts, 1);
	capped.mock.events.get("context")?.[0]?.({ messages: [] }, capped.ctx);
	assert.equal(aborts, 2);
});

test("queued user follow-up resets safety only when its message starts", async () => {
	const active = await startGoalForTest({}, "finish", LOW_LIMITS_SETTINGS_PATH);
	await active.mock.events.get("agent_end")?.[0]?.(
		{ messages: [{ role: "assistant", stopReason: "stop", content: [] }] },
		active.ctx,
	);
	await active.mock.events.get("agent_settled")?.[0]?.({}, active.ctx);
	const continuation = active.mock.sentUserMessages.at(-1)?.text ?? "";
	active.mock.events.get("before_agent_start")?.[0]?.(
		{ prompt: continuation, systemPrompt: "base" },
		active.ctx,
	);
	const safety = requireLastGoal(active.mock);
	safety.automaticModelTurns = 2;
	safety.toolFreeRepeatCount = 2;
	safety.lastToolFreeOutputFingerprint = "f".repeat(64);
	active.mock.events.get("input")?.[0]?.(
		{ source: "interactive", text: "user follow-up", streamingBehavior: "followUp" },
		active.ctx,
	);
	assert.equal(requireLastGoal(active.mock).automaticModelTurns, 2);
	assert.equal(requireLastGoal(active.mock).toolFreeRepeatCount, 2);

	active.mock.events.get("message_start")?.[0]?.(
		{ message: { role: "user", content: [{ type: "text", text: "user follow-up" }] } },
		active.ctx,
	);
	assert.equal(requireLastGoal(active.mock).automaticModelTurns, 0);
	assert.equal(requireLastGoal(active.mock).toolFreeRepeatCount, 0);
	active.mock.events.get("turn_end")?.[0]?.(
		{ message: { role: "assistant", stopReason: "stop", content: [] }, toolResults: [] },
		active.ctx,
	);
	assert.equal(requireLastGoal(active.mock).automaticModelTurns, 0);
	assert.match(continuation, /pi-goal-continuation:/);
});

test("expanded queued follow-up claims manual ownership at its delivery boundary", async () => {
	const active = await startGoalForTest({}, "finish", LOW_LIMITS_SETTINGS_PATH);
	await active.mock.events.get("agent_end")?.[0]?.(
		{ messages: [{ role: "assistant", stopReason: "stop", content: [] }] },
		active.ctx,
	);
	await active.mock.events.get("agent_settled")?.[0]?.({}, active.ctx);
	const continuation = active.mock.sentUserMessages.at(-1)?.text ?? "";
	active.mock.events.get("before_agent_start")?.[0]?.(
		{ prompt: continuation, systemPrompt: "base" },
		active.ctx,
	);
	const safety = requireLastGoal(active.mock);
	safety.automaticModelTurns = 2;
	safety.toolFreeRepeatCount = 2;
	safety.lastToolFreeOutputFingerprint = "9".repeat(64);
	active.mock.events.get("input")?.[0]?.(
		{ source: "interactive", text: "/skill:review", streamingBehavior: "followUp" },
		active.ctx,
	);

	active.mock.events.get("message_start")?.[0]?.(
		{
			message: {
				role: "user",
				content: [{ type: "text", text: "Expanded review skill instructions" }],
			},
		},
		active.ctx,
	);
	active.mock.events.get("turn_end")?.[0]?.(
		{ message: { role: "assistant", stopReason: "stop", content: [] }, toolResults: [] },
		active.ctx,
	);

	assert.equal(requireLastGoal(active.mock).automaticModelTurns, 0);
	assert.equal(requireLastGoal(active.mock).toolFreeRepeatCount, 0);
});

describe("owned goal lifecycle boundaries do not consume a transformed follow-up", () => {
	for (const order of ["message-before-agent", "agent-before-message"] as const) {
		test(order, async () => {
			const active = await startGoalForTest({}, "finish", LOW_LIMITS_SETTINGS_PATH);
			const ownedPrompt = active.mock.sentUserMessages.at(-1)?.text ?? "";
			const safety = requireLastGoal(active.mock);
			safety.automaticModelTurns = 2;
			safety.toolFreeRepeatCount = 2;
			safety.lastToolFreeOutputFingerprint = "7".repeat(64);
			active.mock.events.get("input")?.[0]?.(
				{ source: "interactive", text: "/skill:review", streamingBehavior: "followUp" },
				active.ctx,
			);

			const startMessage = () =>
				active.mock.events.get("message_start")?.[0]?.(
					{ message: { role: "user", content: [{ type: "text", text: ownedPrompt }] } },
					active.ctx,
				);
			const startAgent = () =>
				active.mock.events.get("before_agent_start")?.[0]?.(
					{ prompt: ownedPrompt, systemPrompt: "base" },
					active.ctx,
				);
			if (order === "message-before-agent") {
				startMessage();
				startAgent();
			} else {
				startAgent();
				startMessage();
			}

			assert.equal(requireLastGoal(active.mock).automaticModelTurns, 0);
			assert.equal(requireLastGoal(active.mock).toolFreeRepeatCount, 0);
			const afterOwnedPrompt = requireLastGoal(active.mock);
			afterOwnedPrompt.automaticModelTurns = 2;
			afterOwnedPrompt.toolFreeRepeatCount = 2;
			afterOwnedPrompt.lastToolFreeOutputFingerprint = "6".repeat(64);

			active.mock.events.get("message_start")?.[0]?.(
				{
					message: {
						role: "user",
						content: [{ type: "text", text: "Expanded review skill instructions" }],
					},
				},
				active.ctx,
			);
			assert.equal(requireLastGoal(active.mock).automaticModelTurns, 0);
			assert.equal(requireLastGoal(active.mock).toolFreeRepeatCount, 0);
		});
	}
});

describe("owned continuation lifecycle boundaries do not consume a transformed follow-up", () => {
	for (const order of ["message-before-agent", "agent-before-message"] as const) {
		test(order, async () => {
			const active = await startGoalForTest({}, "finish", LOW_LIMITS_SETTINGS_PATH);
			await active.mock.events.get("agent_end")?.[0]?.(
				{ messages: [{ role: "assistant", stopReason: "stop", content: [] }] },
				active.ctx,
			);
			await active.mock.events.get("agent_settled")?.[0]?.({}, active.ctx);
			const continuation = active.mock.sentUserMessages.at(-1)?.text ?? "";
			const safety = requireLastGoal(active.mock);
			safety.automaticModelTurns = 2;
			safety.toolFreeRepeatCount = 2;
			safety.lastToolFreeOutputFingerprint = "8".repeat(64);
			active.mock.events.get("input")?.[0]?.(
				{ source: "interactive", text: "/skill:review", streamingBehavior: "followUp" },
				active.ctx,
			);

			const startMessage = () =>
				active.mock.events.get("message_start")?.[0]?.(
					{ message: { role: "user", content: [{ type: "text", text: continuation }] } },
					active.ctx,
				);
			const startAgent = () =>
				active.mock.events.get("before_agent_start")?.[0]?.(
					{ prompt: continuation, systemPrompt: "base" },
					active.ctx,
				);
			if (order === "message-before-agent") {
				startMessage();
				startAgent();
			} else {
				startAgent();
				startMessage();
			}

			assert.equal(requireLastGoal(active.mock).automaticModelTurns, 2);
			assert.equal(requireLastGoal(active.mock).toolFreeRepeatCount, 2);
			active.mock.events.get("message_start")?.[0]?.(
				{
					message: {
						role: "user",
						content: [{ type: "text", text: "Expanded review skill instructions" }],
					},
				},
				active.ctx,
			);
			assert.equal(requireLastGoal(active.mock).automaticModelTurns, 0);
			assert.equal(requireLastGoal(active.mock).toolFreeRepeatCount, 0);
		});
	}
});

test("provider retry does not consume a pending transformed follow-up", async () => {
	const active = await startGoalForTest({}, "finish", LOW_LIMITS_SETTINGS_PATH);
	await active.mock.events.get("agent_end")?.[0]?.(
		{ messages: [{ role: "assistant", stopReason: "stop", content: [] }] },
		active.ctx,
	);
	await active.mock.events.get("agent_settled")?.[0]?.({}, active.ctx);
	const continuation = active.mock.sentUserMessages.at(-1)?.text ?? "";
	active.mock.events.get("before_agent_start")?.[0]?.(
		{ prompt: continuation, systemPrompt: "base" },
		active.ctx,
	);
	active.mock.events.get("input")?.[0]?.(
		{ source: "interactive", text: "/skill:review", streamingBehavior: "followUp" },
		active.ctx,
	);
	const retryableError = {
		role: "assistant",
		stopReason: "error",
		errorMessage: "HTTP 524: upstream timeout",
		content: [],
	};
	await active.mock.events.get("agent_end")?.[0]?.({ messages: [retryableError] }, active.ctx);

	active.mock.events.get("before_agent_start")?.[0]?.(
		{ prompt: "provider retry", systemPrompt: "base" },
		active.ctx,
	);
	active.mock.events.get("turn_end")?.[0]?.(
		{ message: { role: "assistant", stopReason: "stop", content: [] }, toolResults: [] },
		active.ctx,
	);
	assert.equal(requireLastGoal(active.mock).automaticModelTurns, 1);

	active.mock.events.get("message_start")?.[0]?.(
		{
			message: {
				role: "user",
				content: [{ type: "text", text: "Expanded review skill instructions" }],
			},
		},
		active.ctx,
	);
	assert.equal(requireLastGoal(active.mock).automaticModelTurns, 0);
});

test("queued non-goal follow-up does not inherit automatic recovery ownership", async () => {
	const active = await startGoalForTest({}, "finish", LOW_LIMITS_SETTINGS_PATH);
	await active.mock.events.get("agent_end")?.[0]?.(
		{ messages: [{ role: "assistant", stopReason: "stop", content: [] }] },
		active.ctx,
	);
	await active.mock.events.get("agent_settled")?.[0]?.({}, active.ctx);
	const continuation = active.mock.sentUserMessages.at(-1)?.text ?? "";
	active.mock.events.get("before_agent_start")?.[0]?.(
		{ prompt: continuation, systemPrompt: "base" },
		active.ctx,
	);
	active.mock.events.get("input")?.[0]?.(
		{ source: "extension", text: "unrelated follow-up", streamingBehavior: "followUp" },
		active.ctx,
	);
	const retryableError = {
		role: "assistant",
		stopReason: "error",
		errorMessage: "HTTP 524: upstream timeout",
		content: [],
	};
	active.mock.events.get("turn_end")?.[0]?.(
		{ message: retryableError, toolResults: [] },
		active.ctx,
	);
	await active.mock.events.get("agent_end")?.[0]?.({ messages: [retryableError] }, active.ctx);
	const turnsBeforeFollowUp = requireLastGoal(active.mock).automaticModelTurns;
	const followUpStart = active.mock.events.get("before_agent_start")?.[0]?.(
		{ prompt: "unrelated follow-up", systemPrompt: "base" },
		active.ctx,
	) as { message?: { customType?: string } } | undefined;
	assert.equal(followUpStart?.message?.customType, "goal-contract");
	active.mock.events.get("turn_end")?.[0]?.(
		{ message: { role: "assistant", stopReason: "stop", content: [] }, toolResults: [] },
		active.ctx,
	);
	assert.equal(requireLastGoal(active.mock).automaticModelTurns, turnsBeforeFollowUp);
	await active.mock.events.get("agent_end")?.[0]?.(
		{ messages: [{ role: "assistant", stopReason: "stop", content: [] }] },
		active.ctx,
	);
	await active.mock.events.get("agent_settled")?.[0]?.({}, active.ctx);
	assert.equal(active.mock.sentUserMessages.length, 3);
});

/** Session-chrome: no path, no command. Names must not matter (not `todo`). */
function chromeOnlyAssistant(text: string, toolName: string, args: Record<string, unknown>) {
	return {
		role: "assistant" as const,
		stopReason: "toolUse" as const,
		content: [
			{ type: "text", text },
			{ type: "toolCall", name: toolName, arguments: args },
		],
	};
}

test("session-chrome automatic runs with paraphrased text still trip no-progress", async () => {
	const stalled = await startGoalForTest({}, "close remaining Xid holes", UNLIMITED_SETTINGS_PATH);
	await stalled.mock.events.get("agent_end")?.[0]?.(
		{
			messages: [
				{
					role: "assistant",
					stopReason: "stop",
					content: [{ type: "text", text: "starting" }],
				},
			],
		},
		stalled.ctx,
	);
	await stalled.mock.events.get("agent_settled")?.[0]?.({}, stalled.ctx);

	const chromeTurns = [
		{
			text: "Step 1 is still the gate: hashing and block-submit must never overlap.",
			toolName: "scratch_board",
			input: { action: "update", id: 1, status: "in_progress" },
		},
		{
			text: "Step 1 still owns this: I'll close remaining SIGTERM holes.",
			toolName: "session_flags",
			input: { flag: "working" },
		},
		{
			text: "Continuing the goal. Step 1 remains incomplete.",
			toolName: "overlay_tick",
			input: {},
		},
	];
	for (const [i, turn] of chromeTurns.entries()) {
		const prompt = stalled.mock.sentUserMessages.at(-1)?.text ?? "";
		stalled.mock.events.get("before_agent_start")?.[0]?.(
			{ prompt, systemPrompt: "base" },
			stalled.ctx,
		);
		stalled.mock.events.get("tool_call")?.[0]?.(
			{
				toolName: turn.toolName,
				toolCallId: `chrome-${i + 1}`,
				input: turn.input,
			},
			stalled.ctx,
		);
		await stalled.mock.events.get("agent_end")?.[0]?.(
			{ messages: [chromeOnlyAssistant(turn.text, turn.toolName, turn.input)] },
			stalled.ctx,
		);
		await stalled.mock.events.get("agent_settled")?.[0]?.({}, stalled.ctx);
	}

	const stopped = requireLastGoal(stalled.mock);
	assert.equal(
		stopped.status,
		"paused",
		"chrome-only continuations (no path, no command) must not reset no-progress, regardless of tool name",
	);
	assert.equal(stopped.safetyPauseCause, "no_progress");
	assert.ok(
		(stopped.toolFreeRepeatCount ?? 0) >= 3,
		`expected no-progress count >= 3, got ${stopped.toolFreeRepeatCount}`,
	);
	assert.equal(
		stalled.mock.sentUserMessages.length,
		4,
		"must not keep injecting Continue the active /goal after three chrome-only runs",
	);
});

test("three blank automatic runs pause for no progress without a fourth continuation", async () => {
	const stalled = await startGoalForTest({}, "finish", LOW_LIMITS_SETTINGS_PATH);
	await stalled.mock.events.get("agent_end")?.[0]?.(
		{
			messages: [
				{ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "done" }] },
			],
		},
		stalled.ctx,
	);
	await stalled.mock.events.get("agent_settled")?.[0]?.({}, stalled.ctx);

	for (let run = 1; run <= 3; run++) {
		const prompt = stalled.mock.sentUserMessages.at(-1)?.text ?? "";
		stalled.mock.events.get("before_agent_start")?.[0]?.(
			{ prompt, systemPrompt: "base" },
			stalled.ctx,
		);
		await stalled.mock.events.get("agent_end")?.[0]?.(
			{
				messages: [
					{ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "   ...  " }] },
				],
			},
			stalled.ctx,
		);
		await stalled.mock.events.get("agent_settled")?.[0]?.({}, stalled.ctx);
	}

	const stopped = requireLastGoal(stalled.mock);
	assert.equal(stopped.status, "paused");
	assert.equal(stopped.toolFreeRepeatCount, 3);
	assert.equal(stopped.safetyPauseCause, "no_progress");
	assert.equal(stalled.mock.sentUserMessages.length, 4);
	assert.match(stalled.notifications.at(-1)?.message ?? "", /no progress.*3 automatic runs/i);
});
