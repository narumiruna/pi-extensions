import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { createMockContext, createMockPi } from "../../../test/support.js";
import goal from "../src/goal.js";

// Cross-extension RPC over Pi's session-local events bus. These tests cover the
// pi-goal half: the pi-goal:rpc:start request/reply handshake, pi-goal:state
// lifecycle broadcasts (including terminal summary/reason), and session-local
// bind/unbind behavior. They never touch pi-subagents.

type GoalTool = {
	name?: string;
	execute: (...args: unknown[]) => Promise<{
		content?: Array<{ type: string; text: string }>;
		terminate?: boolean;
	}>;
};

type RpcSuccess = { success: true; data: { goalId: string; status: string } };
type RpcFailure = { success: false; error: string };
type RpcReply = RpcSuccess | RpcFailure;

type StateEvent = {
	goalId: string;
	status: string;
	summary?: string;
	reason?: string;
};

const GOAL_SETTINGS_DIRECTORY = mkdtempSync(join(tmpdir(), "pi-goal-rpc-settings-"));
const ALWAYS_SETTINGS_PATH = join(GOAL_SETTINGS_DIRECTORY, "always.json");
writeFileSync(ALWAYS_SETTINGS_PATH, '{"toolVisibility":"always"}\n');
after(() => rmSync(GOAL_SETTINGS_DIRECTORY, { recursive: true, force: true }));

function registerGoal(pi: Parameters<typeof goal>[0]) {
	pi.setActiveTools([...new Set([...pi.getActiveTools(), "goal_complete", "goal_blocked"])]);
	goal(pi, { settingsPath: ALWAYS_SETTINGS_PATH });
}

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

function lastPersistedGoal(mock: ReturnType<typeof createMockPi>) {
	const entry = mock.entries.filter((entry) => entry.customType === "goal-state").at(-1);
	return (
		entry?.data as { goal?: { id?: string; status?: string; text?: string } | null } | undefined
	)?.goal;
}

function requireGoalTool(mock: ReturnType<typeof createMockPi>, name: string) {
	const tool = mock.tools.find((tool) => tool.name === name);
	assert.ok(tool, `expected ${name} to be registered`);
	return tool as unknown as GoalTool;
}

function rpcStart(
	mock: ReturnType<typeof createMockPi>,
	payload: Record<string, unknown>,
	requestId = payload.requestId,
) {
	const replies: RpcReply[] = [];
	const id = typeof requestId === "string" ? requestId : "";
	assert.ok(id, "test rpc:start must carry a requestId");
	mock.eventBus.on(`pi-goal:rpc:start:reply:${id}`, (data) => replies.push(data as RpcReply));
	mock.eventBus.emit("pi-goal:rpc:start", payload);
	return { replies };
}

test("rpc start replies with the active goal id and status, and broadcasts active state", async () => {
	const mock = createMockPi({ activeTools: ["read", "bash", "goal_complete", "goal_blocked"] });
	registerGoal(mock.pi);
	const context = createMockContext();
	const stateEvents: StateEvent[] = [];
	mock.eventBus.on("pi-goal:state", (data) => stateEvents.push(data as StateEvent));
	mock.events.get("session_start")?.[0]?.({}, context.ctx);

	const { replies } = rpcStart(mock, {
		requestId: "req-1",
		objective: "  ship the feature  ",
	});
	await flush();

	assert.equal(replies.length, 1);
	assert.equal(replies[0]?.success, true);
	const reply = replies[0] as RpcSuccess;
	assert.equal(reply.data.status, "active");
	assert.equal(typeof reply.data.goalId, "string");
	assert.ok(reply.data.goalId);
	assert.equal(lastPersistedGoal(mock)?.text, "ship the feature");
	// The kickoff prompt was delivered.
	assert.ok(
		mock.sentUserMessages.some((message) => /ship the feature/.test(message.text)),
		"expected a goal kickoff message",
	);
	// An authoritative active state event was broadcast on persist.
	assert.ok(
		stateEvents.some((event) => event.status === "active" && event.goalId === reply.data.goalId),
		"expected an active pi-goal:state event",
	);
});

test("rpc pause transitions the active goal and broadcasts its reason", async () => {
	const mock = createMockPi({ activeTools: ["read", "bash", "goal_complete", "goal_blocked"] });
	registerGoal(mock.pi);
	let aborts = 0;
	const context = createMockContext({ abort: () => aborts++ });
	const stateEvents: StateEvent[] = [];
	mock.eventBus.on("pi-goal:state", (data) => stateEvents.push(data as StateEvent));
	mock.events.get("session_start")?.[0]?.({}, context.ctx);
	const { replies } = rpcStart(mock, { requestId: "req-pause", objective: "pause task" });
	await flush();
	const goalId = (replies[0] as RpcSuccess).data.goalId;

	mock.eventBus.emit("pi-goal:rpc:pause", { goalId, reason: "parent agent stopped" });

	assert.equal(lastPersistedGoal(mock)?.status, "paused");
	assert.equal(aborts, 1);
	const pausedEvent = stateEvents.filter((event) => event.status === "paused").at(-1);
	assert.equal(pausedEvent?.goalId, goalId);
	assert.equal(pausedEvent?.reason, "parent agent stopped");
});

test("rpc start honors a token budget", async () => {
	const mock = createMockPi({ activeTools: ["read", "bash", "goal_complete", "goal_blocked"] });
	registerGoal(mock.pi);
	const context = createMockContext();
	mock.events.get("session_start")?.[0]?.({}, context.ctx);

	const { replies } = rpcStart(mock, {
		requestId: "req-budget",
		objective: "scoped task",
		tokenBudget: 50_000,
	});
	await flush();

	assert.equal(replies[0]?.success, true);
	const goal = lastPersistedGoal(mock);
	assert.equal(goal?.status, "active");
	assert.equal(
		(mock.entries.at(-1)?.data as { goal?: { tokenBudget?: number } } | undefined)?.goal
			?.tokenBudget,
		50_000,
	);
});

test("rpc start fails fast for a malformed payload (missing objective)", async () => {
	const mock = createMockPi({ activeTools: ["read", "bash", "goal_complete", "goal_blocked"] });
	registerGoal(mock.pi);
	const context = createMockContext();
	mock.events.get("session_start")?.[0]?.({}, context.ctx);

	const { replies } = rpcStart(mock, { requestId: "req-missing", objective: "" });
	await flush();

	assert.equal(replies.length, 1);
	assert.equal(replies[0]?.success, false);
	assert.match((replies[0] as RpcFailure).error, /goal_to_complete|objective/i);
	assert.equal(mock.sentUserMessages.length, 0);
});

test("rpc start rejects an oversized objective even when padded", async () => {
	const mock = createMockPi({ activeTools: ["read", "bash", "goal_complete", "goal_blocked"] });
	registerGoal(mock.pi);
	const context = createMockContext();
	mock.events.get("session_start")?.[0]?.({}, context.ctx);

	const { replies } = rpcStart(mock, {
		requestId: "req-oversized",
		objective: `  ${"x".repeat(4_001)}  `,
	});
	await flush();

	assert.equal(replies[0]?.success, false);
	assert.match((replies[0] as RpcFailure).error, /too long/i);
	assert.equal(mock.sentUserMessages.length, 0);
});

test("rpc start fails fast for a malformed payload (non-string objective)", async () => {
	const mock = createMockPi({ activeTools: ["read", "bash", "goal_complete", "goal_blocked"] });
	registerGoal(mock.pi);
	const context = createMockContext();
	mock.events.get("session_start")?.[0]?.({}, context.ctx);

	const { replies } = rpcStart(mock, { requestId: "req-type", objective: 42 });
	await flush();

	assert.equal(replies[0]?.success, false);
	assert.match((replies[0] as RpcFailure).error, /objective must be a string/i);
});

test("rpc start fails fast for an invalid token budget", async () => {
	const mock = createMockPi({ activeTools: ["read", "bash", "goal_complete", "goal_blocked"] });
	registerGoal(mock.pi);
	const context = createMockContext();
	mock.events.get("session_start")?.[0]?.({}, context.ctx);

	for (const tokenBudget of [-1, 0, 1.5, "100", true]) {
		const { replies } = rpcStart(mock, {
			requestId: `req-budget-${String(tokenBudget)}`,
			objective: "task",
			tokenBudget,
		});
		await flush();
		assert.equal(
			replies[0]?.success,
			false,
			`expected failure for tokenBudget ${String(tokenBudget)}`,
		);
		assert.match((replies[0] as RpcFailure).error, /tokenBudget must be a positive integer/i);
	}
	assert.equal(mock.sentUserMessages.length, 0);
});

test("rpc start rejects a pre-existing goal without interactive replacement", async () => {
	const mock = createMockPi({ activeTools: ["read", "bash", "goal_complete", "goal_blocked"] });
	registerGoal(mock.pi);
	let confirmCalls = 0;
	const context = createMockContext({
		confirm: async () => {
			confirmCalls += 1;
			return true;
		},
	});
	mock.events.get("session_start")?.[0]?.({}, context.ctx);
	// Establish an active goal through the normal slash-command path first.
	await mock.commands.get("goal")?.handler("first goal", context.ctx);
	const firstGoal = lastPersistedGoal(mock);
	assert.equal(firstGoal?.status, "active");

	const { replies } = rpcStart(mock, { requestId: "req-existing", objective: "second goal" });
	await flush();

	assert.equal(replies.length, 1);
	assert.equal(replies[0]?.success, false);
	assert.match((replies[0] as RpcFailure).error, /already exists/i);
	// No interactive confirmation and the original goal is untouched.
	assert.equal(confirmCalls, 0);
	assert.equal(lastPersistedGoal(mock)?.id, firstGoal?.id);
});

test("pi-goal:state carries the completion summary on a terminal complete event", async () => {
	const mock = createMockPi({ activeTools: ["read", "bash", "goal_complete", "goal_blocked"] });
	registerGoal(mock.pi);
	const context = createMockContext();
	const stateEvents: StateEvent[] = [];
	mock.eventBus.on("pi-goal:state", (data) => stateEvents.push(data as StateEvent));
	mock.events.get("session_start")?.[0]?.({}, context.ctx);

	const { replies } = rpcStart(mock, { requestId: "req-complete", objective: "finish it" });
	await flush();
	const goalId = (replies[0] as RpcSuccess).data.goalId;

	const complete = requireGoalTool(mock, "goal_complete");
	await complete.execute(
		"complete-1",
		{ goal_id: goalId, summary: "All requirements verified against current evidence." },
		new AbortController().signal,
		() => undefined,
		context.ctx,
	);

	const completeEvent = stateEvents.filter((event) => event.status === "complete").at(-1);
	assert.ok(completeEvent, "expected a complete pi-goal:state event");
	assert.equal(completeEvent?.goalId, goalId);
	assert.equal(completeEvent?.summary, "All requirements verified against current evidence.");
});

test("pi-goal:state carries the blocked reason on a terminal blocked event", async () => {
	const mock = createMockPi({ activeTools: ["read", "bash", "goal_complete", "goal_blocked"] });
	registerGoal(mock.pi);
	const context = createMockContext();
	const stateEvents: StateEvent[] = [];
	mock.eventBus.on("pi-goal:state", (data) => stateEvents.push(data as StateEvent));
	mock.events.get("session_start")?.[0]?.({}, context.ctx);

	const { replies } = rpcStart(mock, { requestId: "req-blocked", objective: "blocked task" });
	await flush();
	const goalId = (replies[0] as RpcSuccess).data.goalId;

	const blocked = requireGoalTool(mock, "goal_blocked");
	await blocked.execute(
		"blocked-1",
		{
			goal_id: goalId,
			reason: "Needs a production API key that only the user can provision.",
			evidence: "Attempted three auth flows; each failed with missing credentials.",
			repeated_turns: 3,
		},
		new AbortController().signal,
		() => undefined,
		context.ctx,
	);

	const blockedEvent = stateEvents.filter((event) => event.status === "blocked").at(-1);
	assert.ok(blockedEvent, "expected a blocked pi-goal:state event");
	assert.equal(blockedEvent?.goalId, goalId);
	assert.match(blockedEvent?.reason ?? "", /production API key/);
});

test("pi-goal:state carries the usage-limited reason from the agent error", async () => {
	const mock = createMockPi({ activeTools: ["read", "bash", "goal_complete", "goal_blocked"] });
	registerGoal(mock.pi);
	const context = createMockContext();
	const stateEvents: StateEvent[] = [];
	mock.eventBus.on("pi-goal:state", (data) => stateEvents.push(data as StateEvent));
	mock.events.get("session_start")?.[0]?.({}, context.ctx);

	const { replies } = rpcStart(mock, { requestId: "req-usage", objective: "usage task" });
	await flush();
	const goalId = (replies[0] as RpcSuccess).data.goalId;

	mock.events.get("agent_end")?.[0]?.(
		{
			messages: [
				{
					role: "assistant",
					stopReason: "error",
					errorMessage: "You have exceeded your usage limit for this period.",
				},
			],
		},
		context.ctx,
	);

	const usageEvent = stateEvents.filter((event) => event.status === "usage_limited").at(-1);
	assert.ok(usageEvent, "expected a usage_limited pi-goal:state event");
	assert.equal(usageEvent?.goalId, goalId);
	assert.match(usageEvent?.reason ?? "", /exceeded your usage limit/);
});

test("terminal details do not leak across session bindings", async () => {
	const mock = createMockPi({ activeTools: ["read", "bash", "goal_complete", "goal_blocked"] });
	registerGoal(mock.pi);
	const firstContext = createMockContext();
	mock.events.get("session_start")?.[0]?.({}, firstContext.ctx);
	const { replies } = rpcStart(mock, { requestId: "req-old", objective: "old task" });
	await flush();
	const blocked = requireGoalTool(mock, "goal_blocked");
	await blocked.execute(
		"blocked-old",
		{
			goal_id: (replies[0] as RpcSuccess).data.goalId,
			reason: "Old session reason",
			evidence: "The same dependency failed on three separate turns.",
			repeated_turns: 3,
		},
		new AbortController().signal,
		() => undefined,
		firstContext.ctx,
	);
	mock.events.get("session_shutdown")?.[0]?.({}, firstContext.ctx);

	const restoredGoal = {
		id: "restored-other-goal",
		text: "restored task",
		status: "blocked",
		startedAt: 1,
		updatedAt: 2,
		iteration: 1,
		tokensUsed: 0,
		timeUsedSeconds: 0,
		baselineTokens: 0,
	};
	const branch = [{ type: "custom", customType: "goal-state", data: { goal: restoredGoal } }];
	const secondContext = createMockContext({
		sessionManager: { getBranch: () => branch, getEntries: () => branch },
	});
	const stateEvents: StateEvent[] = [];
	mock.eventBus.on("pi-goal:state", (data) => stateEvents.push(data as StateEvent));
	mock.events.get("session_start")?.[0]?.({}, secondContext.ctx);
	mock.events.get("session_shutdown")?.[0]?.({}, secondContext.ctx);

	const restoredEvent = stateEvents
		.filter((event) => event.goalId === restoredGoal.id && event.status === "blocked")
		.at(-1);
	assert.ok(restoredEvent, "expected restored blocked state to persist on shutdown");
	assert.equal(restoredEvent?.reason, undefined);
});

test("rpc start replies failure before a session context is bound", async () => {
	const mock = createMockPi({ activeTools: ["read", "bash", "goal_complete", "goal_blocked"] });
	registerGoal(mock.pi);
	// Deliberately do not fire session_start: no session context is bound.

	const { replies } = rpcStart(mock, { requestId: "req-unbound-start", objective: "task" });
	await flush();

	assert.equal(replies.length, 1);
	assert.equal(replies[0]?.success, false);
	assert.match((replies[0] as RpcFailure).error, /no active pi-goal session context/i);
	assert.equal(mock.sentUserMessages.length, 0);
});

test("rpc start replies failure after session shutdown unbinds the context", async () => {
	const mock = createMockPi({ activeTools: ["read", "bash", "goal_complete", "goal_blocked"] });
	registerGoal(mock.pi);
	const context = createMockContext();
	mock.events.get("session_start")?.[0]?.({}, context.ctx);
	mock.events.get("session_shutdown")?.[0]?.({}, context.ctx);

	const { replies } = rpcStart(mock, { requestId: "req-unbound-shutdown", objective: "task" });
	await flush();

	assert.equal(replies.length, 1);
	assert.equal(replies[0]?.success, false);
	assert.match((replies[0] as RpcFailure).error, /no active pi-goal session context/i);
	assert.equal(mock.sentUserMessages.length, 0);
});

test("pi-goal:state never carries a summary or reason for an active goal", async () => {
	const mock = createMockPi({ activeTools: ["read", "bash", "goal_complete", "goal_blocked"] });
	registerGoal(mock.pi);
	const context = createMockContext();
	const stateEvents: StateEvent[] = [];
	mock.eventBus.on("pi-goal:state", (data) => stateEvents.push(data as StateEvent));
	mock.events.get("session_start")?.[0]?.({}, context.ctx);

	const { replies } = rpcStart(mock, {
		requestId: "req-active-only",
		objective: "active task",
	});
	await flush();

	const activeEvents = stateEvents.filter((event) => event.status === "active");
	assert.ok(activeEvents.length > 0, "expected active state events");
	for (const event of activeEvents) {
		assert.equal(event.summary, undefined, "active state must not carry a summary");
		assert.equal(event.reason, undefined, "active state must not carry a reason");
	}

	const blocked = requireGoalTool(mock, "goal_blocked");
	await blocked.execute(
		"blocked-before-resume",
		{
			goal_id: (replies[0] as RpcSuccess).data.goalId,
			reason: "Old terminal reason",
			evidence: "The same external dependency failed on three separate turns.",
			repeated_turns: 3,
		},
		new AbortController().signal,
		() => undefined,
		context.ctx,
	);
	await mock.commands.get("goal")?.handler("resume", context.ctx);
	await mock.commands.get("goal")?.handler("pause", context.ctx);

	const pausedEvent = stateEvents.filter((event) => event.status === "paused").at(-1);
	assert.ok(pausedEvent, "expected a paused state event");
	assert.equal(pausedEvent?.reason, undefined, "old terminal reasons must not leak");
});
