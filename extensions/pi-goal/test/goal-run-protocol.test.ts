import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { createMockContext, createMockPi } from "../../../test/support.js";
import goal from "../src/goal.js";

const START_CHANNEL = "pi-goal:start";
const CANCEL_CHANNEL = "pi-goal:cancel";

const SETTINGS_DIRECTORY = mkdtempSync(join(tmpdir(), "pi-goal-run-settings-"));
const ENABLED_SETTINGS_PATH = join(SETTINGS_DIRECTORY, "enabled.json");
const DISABLED_SETTINGS_PATH = join(SETTINGS_DIRECTORY, "disabled.json");
const INVALID_SETTINGS_PATH = join(SETTINGS_DIRECTORY, "invalid.json");
const MISSING_SETTINGS_PATH = join(SETTINGS_DIRECTORY, "missing.json");
writeFileSync(ENABLED_SETTINGS_PATH, '{"toolVisibility":"always","rpc":{"enabled":true}}\n');
writeFileSync(DISABLED_SETTINGS_PATH, '{"toolVisibility":"always","rpc":{"enabled":false}}\n');
writeFileSync(INVALID_SETTINGS_PATH, '{"rpc":{"enabled":"yes"}}\n');
after(() => rmSync(SETTINGS_DIRECTORY, { recursive: true, force: true }));

type RunStatus =
	| "active"
	| "complete"
	| "blocked"
	| "paused"
	| "usage_limited"
	| "budget_limited"
	| "cleared";

type RunStateEvent = {
	type: "state";
	runId: string;
	goalId: string;
	status: RunStatus;
	summary?: string;
	reason?: string;
	transition?: { source: string; cause: string };
};

type RunErrorCode =
	| "RPC_DISABLED"
	| "INVALID_REQUEST"
	| "NO_ACTIVE_SESSION"
	| "RUN_ID_IN_USE"
	| "RUN_NOT_FOUND"
	| "GOAL_ALREADY_EXISTS"
	| "ACTIVATION_FAILED"
	| "SUPERSEDED";

type RunErrorEvent = {
	type: "error";
	runId: string;
	operation: "start" | "cancel";
	error: { code: RunErrorCode; message: string };
};

type RunEvent = RunStateEvent | RunErrorEvent;

type GoalTool = {
	name?: string;
	execute: (...args: unknown[]) => Promise<{
		content?: Array<{ type: string; text: string }>;
		terminate?: boolean;
	}>;
};

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

function registerGoal(mock: ReturnType<typeof createMockPi>, settingsPath = ENABLED_SETTINGS_PATH) {
	mock.rawPi.setActiveTools([
		...new Set([...mock.rawPi.getActiveTools(), "goal_complete", "goal_blocked"]),
	]);
	goal(mock.pi, { settingsPath });
}

function bindSession(mock: ReturnType<typeof createMockPi>, context = createMockContext()) {
	mock.events.get("session_start")?.[0]?.({}, context.ctx);
	return context;
}

function runEventChannel(runId: string) {
	return `pi-goal:event:${runId}`;
}

function observeRun(mock: ReturnType<typeof createMockPi>, runId: string) {
	const events: RunEvent[] = [];
	mock.eventBus.on(runEventChannel(runId), (data) => events.push(data as RunEvent));
	return events;
}

function startRun(
	mock: ReturnType<typeof createMockPi>,
	runId: string,
	overrides: Record<string, unknown> = {},
) {
	mock.eventBus.emit(START_CHANNEL, {
		runId,
		objective: "ship the managed run",
		...overrides,
	});
}

function cancelRun(
	mock: ReturnType<typeof createMockPi>,
	runId: string,
	overrides: Record<string, unknown> = {},
) {
	mock.eventBus.emit(CANCEL_CHANNEL, { runId, ...overrides });
}

function states(events: RunEvent[]) {
	return events.filter((event): event is RunStateEvent => event.type === "state");
}

function errors(events: RunEvent[]) {
	return events.filter((event): event is RunErrorEvent => event.type === "error");
}

function lastPersistedGoal(mock: ReturnType<typeof createMockPi>) {
	const entry = mock.entries.filter((candidate) => candidate.customType === "goal-state").at(-1);
	return (
		entry?.data as { goal?: { id?: string; status?: string; text?: string; tokenBudget?: number } }
	)?.goal;
}

function requireGoalTool(mock: ReturnType<typeof createMockPi>, name: string) {
	const tool = mock.tools.find((candidate) => candidate.name === name);
	assert.ok(tool, `expected ${name} to be registered`);
	return tool as unknown as GoalTool;
}

function assistantUsageEntry(totalTokens: number) {
	return { type: "message", message: { role: "assistant", usage: { totalTokens } } };
}

test("managed run RPC is disabled when settings are missing, invalid, or explicitly off", async () => {
	for (const [name, settingsPath] of [
		["missing", MISSING_SETTINGS_PATH],
		["invalid", INVALID_SETTINGS_PATH],
		["explicit", DISABLED_SETTINGS_PATH],
	] as const) {
		const mock = createMockPi({ activeTools: ["read", "bash"] });
		registerGoal(mock, settingsPath);
		bindSession(mock);
		const runId = `disabled-${name}`;
		const events = observeRun(mock, runId);

		startRun(mock, runId);
		await flush();

		assert.deepEqual(
			errors(events).map((event) => event.error.code),
			["RPC_DISABLED"],
		);
		assert.equal(states(events).length, 0);
		assert.equal(lastPersistedGoal(mock), undefined);
		assert.equal(mock.sentUserMessages.length, 0);
	}
});

test("start reports no active session before bind and after shutdown", async () => {
	const mock = createMockPi({ activeTools: ["read", "bash"] });
	registerGoal(mock);
	const beforeEvents = observeRun(mock, "before-session");
	startRun(mock, "before-session");
	await flush();
	assert.deepEqual(
		errors(beforeEvents).map((event) => event.error.code),
		["NO_ACTIVE_SESSION"],
	);

	const context = bindSession(mock);
	mock.events.get("session_shutdown")?.[0]?.({}, context.ctx);
	const afterEvents = observeRun(mock, "after-session");
	startRun(mock, "after-session");
	await flush();
	assert.deepEqual(
		errors(afterEvents).map((event) => event.error.code),
		["NO_ACTIVE_SESSION"],
	);
});

test("enabled start emits run-scoped active state and delivers kickoff", async () => {
	const mock = createMockPi({ activeTools: ["read", "bash"] });
	registerGoal(mock);
	bindSession(mock);
	const events = observeRun(mock, "run-start");

	startRun(mock, "run-start", { objective: "  ship the feature  ", tokenBudget: 50_000 });
	await flush();

	assert.deepEqual(
		states(events).map((event) => event.status),
		["active"],
	);
	const active = states(events)[0];
	assert.ok(active?.goalId);
	assert.equal(active?.runId, "run-start");
	assert.equal(lastPersistedGoal(mock)?.text, "ship the feature");
	assert.equal(lastPersistedGoal(mock)?.tokenBudget, 50_000);
	assert.ok(mock.sentUserMessages.some((message) => /ship the feature/.test(message.text)));
});

test("unsafe or missing run ids are ignored without creating channel injection", async () => {
	const mock = createMockPi({ activeTools: ["read", "bash"] });
	registerGoal(mock);
	bindSession(mock);
	for (const runId of ["", ":other-channel", "with space", "x".repeat(129)]) {
		startRun(mock, runId);
	}
	mock.eventBus.emit(START_CHANNEL, { objective: "missing run id" });
	await flush();

	assert.equal(lastPersistedGoal(mock), undefined);
	assert.equal(mock.sentUserMessages.length, 0);
});

test("valid run ids receive structured request validation errors", async () => {
	const invalidPayloads: Array<{ runId: string; overrides: Record<string, unknown> }> = [
		{ runId: "empty-objective", overrides: { objective: "" } },
		{ runId: "wrong-objective", overrides: { objective: 42 } },
		{ runId: "zero-budget", overrides: { tokenBudget: 0 } },
		{ runId: "fraction-budget", overrides: { tokenBudget: 1.5 } },
		{ runId: "string-budget", overrides: { tokenBudget: "100" } },
	];
	for (const { runId, overrides } of invalidPayloads) {
		const mock = createMockPi({ activeTools: ["read", "bash"] });
		registerGoal(mock);
		bindSession(mock);
		const events = observeRun(mock, runId);
		startRun(mock, runId, overrides);
		await flush();
		assert.deepEqual(
			errors(events).map((event) => event.error.code),
			["INVALID_REQUEST"],
		);
		assert.equal(mock.sentUserMessages.length, 0);
	}
});

test("payload access failures are contained as invalid requests", async () => {
	const mock = createMockPi({ activeTools: ["read", "bash"] });
	registerGoal(mock);
	bindSession(mock);
	const startEvents = observeRun(mock, "throwing-start");
	const throwingStart = {
		runId: "throwing-start",
		get objective(): string {
			throw new Error("objective accessor failed");
		},
	};

	mock.eventBus.emit(START_CHANNEL, throwingStart);
	await flush();

	assert.deepEqual(
		errors(startEvents).map((event) => event.error.code),
		["INVALID_REQUEST"],
	);
	assert.equal(lastPersistedGoal(mock), undefined);

	const revoked = Proxy.revocable({}, {});
	revoked.revoke();
	mock.eventBus.emit(START_CHANNEL, revoked.proxy);
	await flush();
	assert.equal(lastPersistedGoal(mock), undefined);

	const cancelEvents = observeRun(mock, "throwing-cancel");
	startRun(mock, "throwing-cancel");
	await flush();
	const throwingCancel = {
		runId: "throwing-cancel",
		get reason(): string {
			throw new Error("reason accessor failed");
		},
	};
	mock.eventBus.emit(CANCEL_CHANNEL, throwingCancel);
	await flush();

	assert.deepEqual(
		errors(cancelEvents).map((event) => event.error.code),
		["INVALID_REQUEST"],
	);
	assert.equal(lastPersistedGoal(mock)?.status, "active");
});

test("payload evaluation cannot revive a replaced session", async () => {
	const mock = createMockPi({ activeTools: ["read", "bash"] });
	registerGoal(mock);
	const context = bindSession(mock);
	const events = observeRun(mock, "session-changing-payload");
	const payload = {
		runId: "session-changing-payload",
		get objective() {
			mock.events.get("session_shutdown")?.[0]?.({}, context.ctx);
			return "must not start after shutdown";
		},
	};

	mock.eventBus.emit(START_CHANNEL, payload);
	await flush();

	assert.deepEqual(
		errors(events).map((event) => event.error.code),
		["SUPERSEDED"],
	);
	assert.equal(lastPersistedGoal(mock), undefined);
	assert.equal(mock.sentUserMessages.length, 0);
});

test("start rejects a pre-existing manual goal without replacement confirmation", async () => {
	const mock = createMockPi({ activeTools: ["read", "bash"] });
	registerGoal(mock);
	let confirmations = 0;
	const context = bindSession(
		mock,
		createMockContext({
			confirm: async () => {
				confirmations++;
				return true;
			},
		}),
	);
	await mock.commands.get("goal")?.handler("manual goal", context.ctx);
	const manualGoal = lastPersistedGoal(mock);
	const events = observeRun(mock, "cannot-adopt");

	startRun(mock, "cannot-adopt");
	await flush();

	assert.deepEqual(
		errors(events).map((event) => event.error.code),
		["GOAL_ALREADY_EXISTS"],
	);
	assert.equal(lastPersistedGoal(mock)?.id, manualGoal?.id);
	assert.equal(confirmations, 0);
});

test("duplicate run ids are rejected without starting twice", async () => {
	const mock = createMockPi({ activeTools: ["read", "bash"] });
	registerGoal(mock);
	bindSession(mock);
	const events = observeRun(mock, "duplicate-run");
	startRun(mock, "duplicate-run");
	await flush();

	startRun(mock, "duplicate-run", { objective: "second objective" });
	await flush();

	assert.deepEqual(
		states(events).map((event) => event.status),
		["active"],
	);
	assert.deepEqual(
		errors(events).map((event) => event.error.code),
		["RUN_ID_IN_USE"],
	);
	assert.equal(mock.sentUserMessages.length, 1);
});

test("cancel pauses only the matching managed run", async () => {
	const mock = createMockPi({ activeTools: ["read", "bash"] });
	registerGoal(mock);
	let aborts = 0;
	bindSession(mock, createMockContext({ abort: () => aborts++ }));
	const events = observeRun(mock, "cancel-run");
	startRun(mock, "cancel-run");
	await flush();

	cancelRun(mock, "cancel-run", { reason: "parent cancelled" });
	await flush();

	assert.deepEqual(
		states(events).map((event) => event.status),
		["active", "paused"],
	);
	assert.equal(states(events).at(-1)?.reason, "parent cancelled");
	assert.equal(lastPersistedGoal(mock)?.status, "paused");
	assert.equal(aborts, 1);
});

test("cancel during the first active event prevents kickoff delivery", async () => {
	const mock = createMockPi({ activeTools: ["read", "bash"] });
	registerGoal(mock);
	const context = bindSession(mock);
	const events = observeRun(mock, "cancel-before-kickoff");
	mock.eventBus.on(runEventChannel("cancel-before-kickoff"), (data) => {
		const event = data as RunEvent;
		if (event.type === "state" && event.status === "active") {
			cancelRun(mock, "cancel-before-kickoff", { reason: "cancel before kickoff" });
		}
	});

	startRun(mock, "cancel-before-kickoff");
	await flush();

	assert.deepEqual(
		states(events).map((event) => event.status),
		["active", "paused"],
	);
	assert.equal(mock.sentUserMessages.length, 0);
	assert.equal(lastPersistedGoal(mock)?.status, "paused");
	assert.equal(context.statuses.get("goal"), "paused");
});

test("unknown, stale, and manual runs cannot be cancelled", async () => {
	const mock = createMockPi({ activeTools: ["read", "bash"] });
	registerGoal(mock);
	const context = bindSession(mock);
	await mock.commands.get("goal")?.handler("manual goal", context.ctx);
	const events = observeRun(mock, "not-owned");

	cancelRun(mock, "not-owned");
	await flush();

	assert.deepEqual(
		errors(events).map((event) => event.error.code),
		["RUN_NOT_FOUND"],
	);
	assert.equal(lastPersistedGoal(mock)?.status, "active");
});

test("cancel rejects malformed reasons without mutating the run", async () => {
	for (const reason of [42, "x".repeat(1_001)]) {
		const mock = createMockPi({ activeTools: ["read", "bash"] });
		registerGoal(mock);
		bindSession(mock);
		const runId = `bad-reason-${typeof reason}`;
		const events = observeRun(mock, runId);
		startRun(mock, runId);
		await flush();

		cancelRun(mock, runId, { reason });
		await flush();

		assert.deepEqual(
			errors(events).map((event) => event.error.code),
			["INVALID_REQUEST"],
		);
		assert.equal(lastPersistedGoal(mock)?.status, "active");
	}
});

test("manual edits terminate the prior managed run as superseded", async () => {
	const mock = createMockPi({ activeTools: ["read", "bash"] });
	registerGoal(mock);
	const context = bindSession(mock);
	const events = observeRun(mock, "edited-run");
	startRun(mock, "edited-run", { objective: "managed objective" });
	await flush();
	const managedGoalId = states(events)[0]?.goalId;
	assert.ok(managedGoalId);

	await mock.commands.get("goal")?.handler("edit manually revised objective", context.ctx);
	await flush();

	assert.deepEqual(
		states(events).map((event) => event.status),
		["active", "cleared"],
	);
	assert.match(states(events).at(-1)?.reason ?? "", /superseded/i);
	assert.notEqual(lastPersistedGoal(mock)?.id, managedGoalId);
	assert.equal(lastPersistedGoal(mock)?.text, "manually revised objective");
});

test("completion emits one terminal event with summary and suppresses clear duplication", async () => {
	const mock = createMockPi({ activeTools: ["read", "bash"] });
	registerGoal(mock);
	const context = bindSession(mock);
	const events = observeRun(mock, "complete-run");
	startRun(mock, "complete-run");
	await flush();
	const goalId = states(events)[0]?.goalId;
	assert.ok(goalId);

	await requireGoalTool(mock, "goal_complete").execute(
		"complete-1",
		{ goal_id: goalId, summary: "All requirements verified." },
		new AbortController().signal,
		() => undefined,
		context.ctx,
	);

	assert.deepEqual(
		states(events).map((event) => event.status),
		["active", "complete"],
	);
	assert.equal(states(events).at(-1)?.summary, "All requirements verified.");
	assert.equal(states(events).filter((event) => event.status !== "active").length, 1);

	startRun(mock, "complete-run", { objective: "must not reopen" });
	await flush();
	assert.deepEqual(
		errors(events).map((event) => event.error.code),
		["RUN_ID_IN_USE"],
	);
});

test("a completion listener can start the next managed run", async () => {
	const mock = createMockPi({ activeTools: ["read", "bash"] });
	registerGoal(mock);
	const context = bindSession(mock);
	const firstEvents = observeRun(mock, "chained-first");
	const secondEvents = observeRun(mock, "chained-second");
	mock.eventBus.on(runEventChannel("chained-first"), (data) => {
		const event = data as RunEvent;
		if (event.type === "state" && event.status === "complete") {
			startRun(mock, "chained-second", { objective: "second managed objective" });
		}
	});
	startRun(mock, "chained-first", { objective: "first managed objective" });
	await flush();
	const goalId = states(firstEvents)[0]?.goalId;
	assert.ok(goalId);

	await requireGoalTool(mock, "goal_complete").execute(
		"complete-chained-first",
		{ goal_id: goalId, summary: "First run verified." },
		new AbortController().signal,
		() => undefined,
		context.ctx,
	);
	await flush();

	assert.deepEqual(
		states(firstEvents).map((event) => event.status),
		["active", "complete"],
	);
	assert.deepEqual(
		states(secondEvents).map((event) => event.status),
		["active"],
	);
	assert.deepEqual(errors(secondEvents), []);
	assert.equal(lastPersistedGoal(mock)?.text, "second managed objective");
	assert.equal(lastPersistedGoal(mock)?.status, "active");
});

test("terminal listeners cannot make stale pause work mutate a replacement", async () => {
	const mock = createMockPi({ activeTools: ["read", "bash"] });
	registerGoal(mock);
	const context = bindSession(mock);
	const firstEvents = observeRun(mock, "pause-first");
	const secondEvents = observeRun(mock, "pause-second");
	mock.eventBus.on(runEventChannel("pause-first"), (data) => {
		const event = data as RunEvent;
		if (event.type === "state" && event.status === "paused") {
			void mock.commands.get("goal")?.handler("clear", context.ctx);
			startRun(mock, "pause-second", { objective: "replacement after pause" });
		}
	});
	startRun(mock, "pause-first", { objective: "cancelled managed objective" });
	await flush();

	cancelRun(mock, "pause-first", { reason: "advance to replacement" });
	await flush();

	assert.deepEqual(
		states(firstEvents).map((event) => event.status),
		["active", "paused"],
	);
	assert.deepEqual(
		states(secondEvents).map((event) => event.status),
		["active"],
	);
	assert.equal(lastPersistedGoal(mock)?.text, "replacement after pause");
	assert.equal(
		context.notifications.some(
			(notification) => notification.message === "Goal paused: replacement after pause",
		),
		false,
	);
});

test("blocked and usage-limited transitions preserve terminal reasons", async () => {
	const blockedMock = createMockPi({ activeTools: ["read", "bash"] });
	registerGoal(blockedMock);
	const blockedContext = bindSession(blockedMock);
	const blockedEvents = observeRun(blockedMock, "blocked-run");
	startRun(blockedMock, "blocked-run");
	await flush();
	const blockedGoalId = states(blockedEvents)[0]?.goalId;
	assert.ok(blockedGoalId);
	await requireGoalTool(blockedMock, "goal_blocked").execute(
		"blocked-1",
		{
			goal_id: blockedGoalId,
			reason: "Production credentials are required.",
			evidence: "Three attempts failed because credentials are unavailable.",
			repeated_turns: 3,
		},
		new AbortController().signal,
		() => undefined,
		blockedContext.ctx,
	);
	assert.equal(states(blockedEvents).at(-1)?.status, "blocked");
	assert.match(states(blockedEvents).at(-1)?.reason ?? "", /credentials/i);
	assert.deepEqual(states(blockedEvents).at(-1)?.transition, {
		source: "agent",
		cause: "blocked_report",
	});

	const usageMock = createMockPi({ activeTools: ["read", "bash"] });
	registerGoal(usageMock);
	const usageContext = bindSession(usageMock);
	const usageEvents = observeRun(usageMock, "usage-run");
	startRun(usageMock, "usage-run");
	await flush();
	usageMock.events.get("agent_end")?.[0]?.(
		{
			messages: [
				{
					role: "assistant",
					stopReason: "error",
					errorMessage: "You have exceeded your usage limit for this period.",
				},
			],
		},
		usageContext.ctx,
	);
	await flush();
	assert.equal(states(usageEvents).at(-1)?.status, "usage_limited");
	assert.match(states(usageEvents).at(-1)?.reason ?? "", /usage limit/i);
	assert.deepEqual(states(usageEvents).at(-1)?.transition, {
		source: "provider",
		cause: "usage_exhausted",
	});
});

test("budget exhaustion emits the budget-limited terminal state", async () => {
	const branch: Array<Record<string, unknown>> = [];
	const mock = createMockPi({ activeTools: ["read", "bash"] });
	registerGoal(mock);
	const context = bindSession(
		mock,
		createMockContext({
			sessionManager: { getBranch: () => branch, getEntries: () => branch },
		}),
	);
	const events = observeRun(mock, "budget-run");
	startRun(mock, "budget-run", { tokenBudget: 10 });
	await flush();
	branch.push(assistantUsageEntry(12));

	await mock.events.get("tool_execution_end")?.[0]?.(
		{ toolCallId: "budget-tool", toolName: "bash", result: {}, isError: false },
		context.ctx,
	);

	assert.deepEqual(
		states(events).map((event) => event.status),
		["active", "budget_limited"],
	);
	assert.match(states(events).at(-1)?.reason ?? "", /token budget/i);
});

test("manual clear emits one cleared terminal event for its managed run", async () => {
	const mock = createMockPi({ activeTools: ["read", "bash"] });
	registerGoal(mock);
	const context = bindSession(mock);
	const events = observeRun(mock, "clear-run");
	startRun(mock, "clear-run");
	await flush();

	await mock.commands.get("goal")?.handler("clear", context.ctx);

	assert.deepEqual(
		states(events).map((event) => event.status),
		["active", "cleared"],
	);
	assert.equal(states(events).at(-1)?.reason, "goal cleared");
});

test("failed kickoff emits active then one cleared rollback event", async () => {
	const mock = createMockPi({ activeTools: ["read", "bash"] });
	mock.rawPi.sendUserMessage = () => {
		throw new Error("kickoff failed");
	};
	registerGoal(mock);
	bindSession(mock);
	const events = observeRun(mock, "failed-kickoff");

	startRun(mock, "failed-kickoff");
	await flush();

	assert.deepEqual(
		states(events).map((event) => event.status),
		["active", "cleared"],
	);
	assert.equal(errors(events).length, 0);
	assert.match(states(events).at(-1)?.reason ?? "", /activation|delivery|cleared/i);
});

test("a pending start cannot emit for a replacement run after supersession", async () => {
	const mock = createMockPi({ activeTools: ["read", "bash"] });
	let releaseKickoff!: () => void;
	mock.rawPi.sendUserMessage = () =>
		new Promise<void>((resolve) => {
			releaseKickoff = resolve;
		});
	registerGoal(mock);
	const context = bindSession(mock);
	const firstEvents = observeRun(mock, "first-run");
	startRun(mock, "first-run");
	await mock.commands.get("goal")?.handler("clear", context.ctx);

	mock.rawPi.sendUserMessage = () => undefined;
	const secondEvents = observeRun(mock, "second-run");
	startRun(mock, "second-run", { objective: "replacement run" });
	await flush();
	assert.deepEqual(
		states(secondEvents).map((event) => event.status),
		["active"],
	);

	releaseKickoff();
	await flush();

	assert.deepEqual(
		states(firstEvents).map((event) => event.status),
		["active", "cleared"],
	);
	assert.equal(errors(firstEvents).length, 0);
	assert.equal(lastPersistedGoal(mock)?.id, states(secondEvents)[0]?.goalId);
});

test("run event listener failures do not interrupt persistence or sibling listeners", async () => {
	const mock = createMockPi({ activeTools: ["read", "bash"] });
	registerGoal(mock);
	bindSession(mock);
	mock.eventBus.on(runEventChannel("listener-run"), () => {
		throw new Error("observer failed");
	});
	const events = observeRun(mock, "listener-run");

	startRun(mock, "listener-run");
	await flush();

	assert.deepEqual(
		states(events).map((event) => event.status),
		["active"],
	);
	assert.equal(lastPersistedGoal(mock)?.status, "active");
});

test("disabling RPC rejects new starts while the accepted run can drain", async () => {
	const settingsPath = join(SETTINGS_DIRECTORY, "draining.json");
	writeFileSync(settingsPath, '{"toolVisibility":"always","rpc":{"enabled":true}}\n');
	const mock = createMockPi({ activeTools: ["read", "bash"] });
	registerGoal(mock, settingsPath);
	bindSession(mock);
	const acceptedEvents = observeRun(mock, "draining-run");
	startRun(mock, "draining-run");
	await flush();
	assert.deepEqual(
		states(acceptedEvents).map((event) => event.status),
		["active"],
	);

	const selections = ["Settings…", "Managed run RPC", undefined, "Close"];
	const settingsContext = createMockContext({
		hasUI: true,
		mode: "tui",
		select: async () => selections.shift(),
	});
	await mock.commands.get("goal")?.handler("", settingsContext.ctx);

	const rejectedEvents = observeRun(mock, "rejected-after-disable");
	startRun(mock, "rejected-after-disable");
	cancelRun(mock, "draining-run", { reason: "drained after disable" });
	await flush();

	assert.deepEqual(
		errors(rejectedEvents).map((event) => event.error.code),
		["RPC_DISABLED"],
	);
	assert.deepEqual(
		states(acceptedEvents).map((event) => event.status),
		["active", "paused"],
	);
	assert.equal(states(acceptedEvents).at(-1)?.reason, "drained after disable");
});

test("shutdown cancels a queued terminal publication from the old session", async () => {
	const mock = createMockPi({ activeTools: ["read", "bash"] });
	registerGoal(mock);
	const context = bindSession(mock);
	const events = observeRun(mock, "shutdown-terminal");
	startRun(mock, "shutdown-terminal");
	await flush();

	cancelRun(mock, "shutdown-terminal");
	mock.events.get("session_shutdown")?.[0]?.({}, context.ctx);
	await flush();

	assert.deepEqual(
		states(events).map((event) => event.status),
		["active"],
	);
	assert.equal(lastPersistedGoal(mock)?.status, "paused");
});

test("shutdown invalidates a start continuation still awaiting kickoff delivery", async () => {
	const mock = createMockPi({ activeTools: ["read", "bash"] });
	let rejectKickoff!: (error: Error) => void;
	mock.rawPi.sendUserMessage = () =>
		new Promise<void>((_resolve, reject) => {
			rejectKickoff = reject;
		});
	registerGoal(mock);
	const firstContext = bindSession(mock);
	const events = observeRun(mock, "shutdown-pending");
	startRun(mock, "shutdown-pending");
	assert.deepEqual(
		states(events).map((event) => event.status),
		["active"],
	);

	mock.events.get("session_shutdown")?.[0]?.({}, firstContext.ctx);
	rejectKickoff(new Error("late kickoff rejection"));
	await flush();

	assert.deepEqual(
		states(events).map((event) => event.status),
		["active"],
	);
	assert.equal(
		firstContext.notifications.some((notice) =>
			/Goal (?:prompt failed|started)/.test(notice.message),
		),
		false,
	);
	assert.equal(lastPersistedGoal(mock)?.status, "active");
});

test("session replacement invalidates old run ownership and terminal details", async () => {
	const mock = createMockPi({ activeTools: ["read", "bash"] });
	registerGoal(mock);
	const firstContext = bindSession(mock);
	const firstEvents = observeRun(mock, "old-run");
	startRun(mock, "old-run");
	await flush();
	const oldGoalId = states(firstEvents)[0]?.goalId;
	assert.ok(oldGoalId);
	await requireGoalTool(mock, "goal_blocked").execute(
		"blocked-old",
		{
			goal_id: oldGoalId,
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
		id: "restored-manual-goal",
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
	mock.events.get("session_start")?.[0]?.({}, secondContext.ctx);
	const staleEvents = observeRun(mock, "old-run");
	cancelRun(mock, "old-run");
	await flush();

	assert.deepEqual(
		errors(staleEvents).map((event) => event.error.code),
		["RUN_NOT_FOUND"],
	);
	assert.equal(lastPersistedGoal(mock)?.id, restoredGoal.id);
	assert.equal(lastPersistedGoal(mock)?.status, "blocked");
});

test("removed RPC, global state, and versioned channels are inert", async () => {
	const mock = createMockPi({ activeTools: ["read", "bash"] });
	registerGoal(mock);
	const context = bindSession(mock);
	const oldReplies: unknown[] = [];
	const oldStates: unknown[] = [];
	const versionedEvents: unknown[] = [];
	mock.eventBus.on("pi-goal:rpc:start:reply:legacy", (data) => oldReplies.push(data));
	mock.eventBus.on("pi-goal:state", (data) => oldStates.push(data));
	mock.eventBus.on("pi-goal:v1:event:unused-version", (data) => versionedEvents.push(data));

	mock.eventBus.emit("pi-goal:rpc:start", {
		requestId: "legacy",
		objective: "legacy objective",
	});
	mock.eventBus.emit("pi-goal:rpc:pause", { requestId: "legacy" });
	mock.eventBus.emit("pi-goal:v1:start", {
		runId: "unused-version",
		objective: "versioned objective",
	});
	mock.eventBus.emit("pi-goal:v1:cancel", { runId: "unused-version" });
	await mock.commands.get("goal")?.handler("manual objective", context.ctx);
	await flush();

	assert.deepEqual(oldReplies, []);
	assert.deepEqual(oldStates, []);
	assert.deepEqual(versionedEvents, []);
	assert.equal(lastPersistedGoal(mock)?.text, "manual objective");
});
