import assert from "node:assert/strict";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { createTuiHarness } from "@narumitw/pi-tui-kit/testing";
import { test, vi } from "vitest";
import { createMockContext, createMockPi } from "../../../test/support.js";
import { GoalCommandController } from "../src/commands.js";
import { createGoal, GoalRuntime } from "../src/runtime.js";
import { DEFAULT_GOAL_SETTINGS, type GoalSettings } from "../src/settings.js";
import {
	applyGoalSettings,
	formatGoalLimit,
	parseContinuationDelay,
	parseGoalLimit,
	showGoalSettings,
} from "../src/settings-ui.js";

initTheme("dark", false);

function runtime() {
	const mock = createMockPi({ activeTools: ["read"] });
	const state = new GoalRuntime(mock.pi) as GoalRuntime & {
		readonly visibility: ReturnType<GoalRuntime["toolPolicy"]["snapshot"]>;
	};
	state.settings = structuredClone(DEFAULT_GOAL_SETTINGS);
	state.toolPolicy.restore({
		activeTools: ["read"],
		goalToolsUnlocked: false,
		goalToolsHiddenByPolicy: ["goal_complete", "goal_blocked", "goal_wait"],
	});
	Object.defineProperty(state, "visibility", {
		get: () => state.toolPolicy.snapshot(),
	});
	return state;
}

test("goal setting custom limits accept only safe whole numbers greater than zero", () => {
	assert.equal(parseGoalLimit("40"), 40);
	assert.equal(parseGoalLimit(" 25 "), 25);
	for (const invalid of [
		"",
		"0",
		"-1",
		"1.5",
		"Unlimited",
		"off",
		"many",
		String(Number.MAX_SAFE_INTEGER + 1),
	]) {
		assert.equal(parseGoalLimit(invalid), undefined);
	}
	assert.equal(formatGoalLimit(25), "25");
	assert.equal(formatGoalLimit(null), "Unlimited");
});

test("continuation delay accepts non-negative safe whole milliseconds", () => {
	assert.equal(parseContinuationDelay("0"), 0);
	assert.equal(parseContinuationDelay(" 1500 "), 1_500);
	for (const invalid of [
		"",
		"-1",
		"1.5",
		"off",
		"many",
		String(Number.MAX_SAFE_INTEGER + 1),
	]) {
		assert.equal(parseContinuationDelay(invalid), undefined);
	}
});

test("applyGoalSettings extends an owned continuation timer from its original settled boundary", async () => {
	vi.useFakeTimers();
	try {
		const mock = createMockPi({
			activeTools: ["goal_complete", "goal_blocked", "goal_wait"],
		});
		const state = new GoalRuntime(mock.pi);
		state.settings = {
			...structuredClone(DEFAULT_GOAL_SETTINGS),
			continuationLimits: {
				...DEFAULT_GOAL_SETTINGS.continuationLimits,
				minIntervalMs: 1_000,
			},
		};
		state.activeGoal = createGoal("current objective", undefined, 0);
		const context = createMockContext({ isIdle: () => true });
		assert.equal(state.requestContinuation(state.activeGoal), true);
		assert.equal(state.scheduleContinuationDispatch(context.ctx, state.activeGoal.id), true);

		await vi.advanceTimersByTimeAsync(500);
		applyGoalSettings(
			state,
			{
				...structuredClone(state.settings),
				continuationLimits: {
					...state.settings.continuationLimits,
					minIntervalMs: 2_000,
				},
			},
			context.ctx,
			{ save() {} },
		);

		await vi.advanceTimersByTimeAsync(500);
		assert.equal(mock.sentUserMessages.length, 0);
		await vi.advanceTimersByTimeAsync(999);
		assert.equal(mock.sentUserMessages.length, 0);
		await vi.advanceTimersByTimeAsync(1);
		assert.equal(mock.sentUserMessages.length, 1);
		assert.match(mock.sentUserMessages[0]?.text ?? "", /automatic continuation #0/i);
	} finally {
		vi.useRealTimers();
	}
});

test("applyGoalSettings dispatches an eligible settled continuation immediately when delay turns Off", async () => {
	vi.useFakeTimers();
	try {
		const mock = createMockPi({
			activeTools: ["goal_complete", "goal_blocked", "goal_wait"],
		});
		const state = new GoalRuntime(mock.pi);
		state.settings = {
			...structuredClone(DEFAULT_GOAL_SETTINGS),
			continuationLimits: {
				...DEFAULT_GOAL_SETTINGS.continuationLimits,
				minIntervalMs: 1_000,
			},
		};
		state.activeGoal = createGoal("current objective", undefined, 0);
		const context = createMockContext({ isIdle: () => true });
		assert.equal(state.requestContinuation(state.activeGoal), true);
		assert.equal(state.scheduleContinuationDispatch(context.ctx, state.activeGoal.id), true);
		await vi.advanceTimersByTimeAsync(500);

		const off = {
			...structuredClone(state.settings),
			continuationLimits: {
				...state.settings.continuationLimits,
				minIntervalMs: 0,
			},
		};
		assert.throws(
			() =>
				applyGoalSettings(state, off, context.ctx, {
					save() {
						throw new Error("disk full");
					},
				}),
			/disk full/,
		);
		assert.equal(state.settings.continuationLimits.minIntervalMs, 1_000);
		assert.equal(mock.sentUserMessages.length, 0);

		applyGoalSettings(state, off, context.ctx, { save() {} });

		assert.equal(mock.sentUserMessages.length, 1);
		assert.match(mock.sentUserMessages[0]?.text ?? "", /automatic continuation #0/i);
		await vi.advanceTimersByTimeAsync(500);
		assert.equal(mock.sentUserMessages.length, 1);
	} finally {
		vi.useRealTimers();
	}
});

test("applyGoalSettings saves before committing runtime settings and enforces lower limits", () => {
	const state = runtime();
	let saved: GoalSettings | undefined;
	let enforced = 0;
	state.enforceAutomaticTurnLimit = () => {
		enforced++;
		return false;
	};
	const next: GoalSettings = {
		...structuredClone(DEFAULT_GOAL_SETTINGS),
		continuationLimits: { automaticTurns: 10, noProgressTurns: 2, minIntervalMs: 1_000 },
	};
	const context = createMockContext();

	applyGoalSettings(state as never, next, context.ctx, {
		save(settings: GoalSettings) {
			saved = structuredClone(settings);
		},
	});

	assert.deepEqual(saved, next);
	assert.deepEqual(state.settings, next);
	assert.equal(enforced, 1);
});

test("applyGoalSettings restores effective tool policy when persistence fails", () => {
	const state = runtime();
	const before = structuredClone(state.visibility);
	const next: GoalSettings = {
		...structuredClone(DEFAULT_GOAL_SETTINGS),
		toolVisibility: "always",
	};
	const context = createMockContext();

	assert.throws(
		() =>
			applyGoalSettings(state as never, next, context.ctx, {
				save() {
					throw new Error("disk full");
				},
			}),
		/disk full/,
	);
	assert.deepEqual(state.settings, DEFAULT_GOAL_SETTINGS);
	assert.deepEqual(state.visibility, before);
});

test("applyGoalSettings rolls back file and effective state after runtime application fails", () => {
	const mock = createMockPi({ activeTools: ["goal_complete", "goal_blocked", "goal_wait"] });
	const state = new GoalRuntime(mock.pi);
	state.settings = {
		...structuredClone(DEFAULT_GOAL_SETTINGS),
		experimental: { goals: true },
	};
	state.activeGoal = createGoal("current objective", undefined, 0);
	state.queuedGoals = [createGoal("queued objective", undefined, 0)];
	const previous = structuredClone(state.settings);
	const next = { ...structuredClone(previous), experimental: { goals: false } };
	const saved: GoalSettings[] = [];
	let persistCalls = 0;
	state.persistGoal = () => {
		persistCalls++;
		if (persistCalls === 1) throw new Error("stale context");
	};
	const context = createMockContext({ mode: "tui", hasUI: true });

	assert.throws(
		() =>
			applyGoalSettings(state, next, context.ctx, {
				save(settings) {
					saved.push(structuredClone(settings));
				},
			}),
		/stale context/,
	);
	assert.deepEqual(saved, [next, previous]);
	assert.deepEqual(state.settings, previous);
	assert.equal(state.queueFrozen, false);
	assert.equal(state.activeGoal?.status, "active");
});

test("disabling a retained queue pauses and aborts in-flight Goal work", () => {
	const mock = createMockPi({ activeTools: ["goal_complete", "goal_blocked", "goal_wait"] });
	const state = new GoalRuntime(mock.pi);
	state.settings = {
		...structuredClone(DEFAULT_GOAL_SETTINGS),
		experimental: { goals: true },
	};
	state.activeGoal = createGoal("current objective", undefined, 0);
	state.queuedGoals = [createGoal("queued objective", undefined, 0)];
	state.requestContinuation(state.activeGoal);
	state.beginAgentRun(state.activeGoal.id, "automatic");
	let aborts = 0;
	const context = createMockContext({
		mode: "tui",
		hasUI: true,
		abort: () => aborts++,
	});
	const next = { ...structuredClone(state.settings), experimental: { goals: false } };

	applyGoalSettings(state, next, context.ctx, { save() {} });

	assert.equal(aborts, 1);
	assert.equal(state.queueFrozen, true);
	assert.equal(state.activeGoal?.status, "active");
	assert.equal(state.activeGoal?.activeStartedAt, undefined);
	assert.equal(state.continuationIntent, undefined);
	assert.equal(state.staleGoalToolCallsBlocked, true);
});

test("freezing a queue preserves an unrelated in-flight run", () => {
	const mock = createMockPi({ activeTools: ["goal_complete", "goal_blocked", "goal_wait"] });
	const state = new GoalRuntime(mock.pi);
	state.settings = {
		...structuredClone(DEFAULT_GOAL_SETTINGS),
		experimental: { goals: true },
	};
	state.activeGoal = createGoal("current objective", undefined, 0);
	state.queuedGoals = [createGoal("queued objective", undefined, 0)];
	state.beginAgentRun(null, undefined);
	let aborts = 0;
	const context = createMockContext({
		mode: "tui",
		hasUI: true,
		abort: () => aborts++,
	});
	const next = { ...structuredClone(state.settings), experimental: { goals: false } };

	applyGoalSettings(state, next, context.ctx, { save() {} });

	assert.equal(aborts, 0);
	assert.equal(state.queueFrozen, true);
	assert.equal(state.agentRunGoalId, null);
	assert.equal(state.activeGoal?.activeStartedAt, undefined);
	assert.equal(state.guardAbortGoalId, undefined);
	assert.equal(state.queueFreezeAwaitingSettle, false);
	assert.equal(state.staleGoalToolCallsBlocked, false);
});

test("revealing lazy Goal tools rejects a busy unrelated run", () => {
	const state = runtime();
	state.settings = {
		...structuredClone(DEFAULT_GOAL_SETTINGS),
		toolVisibility: "after-first-goal",
	};
	const before = structuredClone(state.visibility);
	const next = { ...structuredClone(state.settings), toolVisibility: "always" as const };
	let saves = 0;
	const context = createMockContext({ mode: "tui", hasUI: true, isIdle: () => false });

	assert.throws(
		() =>
			applyGoalSettings(state, next, context.ctx, {
				save() {
					saves++;
				},
			}),
		/wait for Pi to become idle/i,
	);
	assert.equal(saves, 0);
	assert.equal(state.settings.toolVisibility, "after-first-goal");
	assert.deepEqual(state.visibility, before);
});

test("hiding always-visible Goal tools rejects a busy unrelated run", () => {
	const mock = createMockPi({
		activeTools: ["read", "goal_complete", "goal_blocked", "goal_wait"],
	});
	const state = new GoalRuntime(mock.pi);
	state.settings = structuredClone(DEFAULT_GOAL_SETTINGS);
	const before = state.toolPolicy.snapshot();
	const next = {
		...structuredClone(state.settings),
		toolVisibility: "after-first-goal" as const,
	};
	let saves = 0;
	const context = createMockContext({ mode: "tui", hasUI: true, isIdle: () => false });

	assert.throws(
		() =>
			applyGoalSettings(state, next, context.ctx, {
				save() {
					saves++;
				},
			}),
		/wait for Pi to become idle/i,
	);
	assert.equal(saves, 0);
	assert.equal(state.settings.toolVisibility, "always");
	assert.deepEqual(state.toolPolicy.snapshot(), before);
});

test("lowering the no-progress limit pauses and aborts in-flight Goal work", () => {
	const mock = createMockPi({ activeTools: ["goal_complete", "goal_blocked", "goal_wait"] });
	const state = new GoalRuntime(mock.pi);
	state.settings = {
		...structuredClone(DEFAULT_GOAL_SETTINGS),
		continuationLimits: { automaticTurns: 25, noProgressTurns: 5, minIntervalMs: 0 },
	};
	state.activeGoal = createGoal("current objective", undefined, 0);
	state.activeGoal.toolFreeRepeatCount = 3;
	state.beginAgentRun(state.activeGoal.id, "automatic");
	let aborts = 0;
	const context = createMockContext({
		mode: "tui",
		hasUI: true,
		abort: () => aborts++,
	});
	const next = {
		...structuredClone(state.settings),
		continuationLimits: { automaticTurns: 25, noProgressTurns: 3, minIntervalMs: 0 },
	};

	applyGoalSettings(state, next, context.ctx, { save() {} });

	assert.equal(aborts, 1);
	assert.equal(state.activeGoal?.status, "paused");
	assert.equal(state.activeGoal?.safetyPauseCause, "no_progress");
});

test("lowering a reached limit preserves an unrelated in-flight run", () => {
	const mock = createMockPi({ activeTools: ["goal_complete", "goal_blocked", "goal_wait"] });
	const state = new GoalRuntime(mock.pi);
	state.settings = {
		...structuredClone(DEFAULT_GOAL_SETTINGS),
		continuationLimits: { automaticTurns: 25, noProgressTurns: 5, minIntervalMs: 0 },
	};
	state.activeGoal = createGoal("current objective", undefined, 0);
	state.activeGoal.toolFreeRepeatCount = 3;
	state.beginAgentRun(null, undefined);
	let aborts = 0;
	const context = createMockContext({
		mode: "tui",
		hasUI: true,
		abort: () => aborts++,
	});
	const next = {
		...structuredClone(state.settings),
		continuationLimits: { automaticTurns: 25, noProgressTurns: 3, minIntervalMs: 0 },
	};

	applyGoalSettings(state, next, context.ctx, { save() {} });

	assert.equal(aborts, 0);
	assert.equal(state.agentRunGoalId, null);
	assert.equal(state.activeGoal?.status, "paused");
	assert.equal(state.activeGoal?.safetyPauseCause, "no_progress");
});

test("replacement confirmation does not replace a goal that changed while open", async () => {
	const mock = createMockPi({ activeTools: ["goal_complete", "goal_blocked", "goal_wait"] });
	const state = new GoalRuntime(mock.pi);
	state.activeGoal = createGoal("previewed objective", undefined, 0);
	const replacement = createGoal("replacement objective", undefined, 0);
	const context = createMockContext({
		mode: "tui",
		hasUI: true,
		confirm: async () => {
			state.activeGoal = replacement;
			return true;
		},
	});
	const controller = new GoalCommandController(state);

	await controller.startGoal("new objective", undefined, context.ctx);

	assert.equal(state.activeGoal?.id, replacement.id);
	assert.equal(mock.sentUserMessages.length, 0);
	assert.match(context.notifications.at(-1)?.message ?? "", /goal queue changed.*try again/i);
});

test("replacement confirmation sanitizes terminal controls without changing goal data", async () => {
	const mock = createMockPi({ activeTools: ["goal_complete", "goal_blocked", "goal_wait"] });
	const state = new GoalRuntime(mock.pi);
	state.activeGoal = createGoal("current\u001b]8;;bad\u0007 objective", undefined, 0);
	state.queuedGoals = [createGoal("queued\u001b objective", undefined, 0)];
	let preview = "";
	const context = createMockContext({
		mode: "tui",
		hasUI: true,
		confirm: async (_title: string, message: string) => {
			preview = message;
			return false;
		},
	});
	const controller = new GoalCommandController(state);

	await controller.startGoal("new\u009b31m objective", undefined, context.ctx);

	for (const control of ["\u0007", "\u001b", "\u009b"]) {
		assert.equal(preview.includes(control), false);
	}
	assert.match(preview, /Current goal: current objective/);
	assert.doesNotMatch(preview, /]8;;bad/);
	assert.match(preview, /Queued goals also removed:\n1\. queued objective/);
	assert.match(preview, /New goal: new 31m objective/);
	assert.equal(state.activeGoal?.text, "current\u001b]8;;bad\u0007 objective");
});

test("unfreezing waits for an aborted frozen run to settle before dispatching", async () => {
	const mock = createMockPi({ activeTools: ["goal_complete", "goal_blocked", "goal_wait"] });
	const state = new GoalRuntime(mock.pi);
	state.settings = {
		...structuredClone(DEFAULT_GOAL_SETTINGS),
		experimental: { goals: false },
	};
	state.activeGoal = createGoal("current objective", undefined, 0);
	state.queuedGoals = [createGoal("queued objective", undefined, 0)];
	state.beginAgentRun(state.activeGoal.id, "manual");
	state.queueFrozen = true;
	state.guardAbortGoalId = state.activeGoal.id;
	state.queueFreezeAwaitingSettle = true;
	const context = createMockContext({ mode: "tui", hasUI: true, isIdle: () => true });
	const enabled = { ...structuredClone(state.settings), experimental: { goals: true } };
	const controller = new GoalCommandController(state);

	applyGoalSettings(state, enabled, context.ctx, { save() {} });
	const dispatchedEarly = await controller.resumeQueueAfterUnfreeze(context.ctx);

	assert.equal(dispatchedEarly, false);
	assert.equal(state.queueFrozen, true);
	assert.equal(state.guardAbortGoalId, state.activeGoal.id);
	assert.equal(mock.sentUserMessages.length, 0);

	state.clearSettledSafetyTracking();
	state.queueFreezeAwaitingSettle = false;
	const dispatchedAfterSettle = await controller.resumeQueueAfterUnfreeze(context.ctx);

	assert.equal(dispatchedAfterSettle, true);
	assert.equal(state.queueFrozen, false);
	assert.equal(typeof state.activeGoal?.activeStartedAt, "number");
	assert.equal(mock.sentUserMessages.length, 1);
});

test("unfreezing an active retained queue dispatches Goal work immediately", async () => {
	const mock = createMockPi({ activeTools: ["goal_complete", "goal_blocked", "goal_wait"] });
	const state = new GoalRuntime(mock.pi);
	state.settings = {
		...structuredClone(DEFAULT_GOAL_SETTINGS),
		experimental: { goals: true },
	};
	state.activeGoal = createGoal("current objective", undefined, 0);
	state.queuedGoals = [createGoal("queued objective", undefined, 0)];
	state.queueFrozen = false;
	const controller = new GoalCommandController(state);
	const context = createMockContext({ mode: "tui", hasUI: true, isIdle: () => true });

	const dispatched = await controller.resumeQueueAfterUnfreeze(context.ctx);

	assert.equal(dispatched, true);
	assert.equal(mock.sentUserMessages.length, 1);
	assert.match(mock.sentUserMessages[0]?.text ?? "", /Continue the active \/goal/i);
});

test("unfreezing a pending priority dispatches it at the idle boundary", async () => {
	const mock = createMockPi({ activeTools: ["goal_complete", "goal_blocked", "goal_wait"] });
	const state = new GoalRuntime(mock.pi);
	state.settings = {
		...structuredClone(DEFAULT_GOAL_SETTINGS),
		experimental: { goals: true },
	};
	state.activeGoal = createGoal("current objective", undefined, 0);
	state.pendingQueueAction = { kind: "prioritize", objective: "urgent objective" };
	const controller = new GoalCommandController(state);
	const context = createMockContext({ mode: "tui", hasUI: true, isIdle: () => true });

	const dispatched = await controller.resumeQueueAfterUnfreeze(context.ctx);

	assert.equal(dispatched, true);
	assert.equal(state.pendingQueueAction, undefined);
	assert.equal(state.activeGoal?.text, "urgent objective");
	assert.equal(mock.sentUserMessages.length, 1);
});

test("standard settings keep all six controls on one level", async () => {
	const state = runtime();
	let title = "";
	let options: string[] = [];
	const context = createMockContext({
		hasUI: true,
		mode: "tui",
		select: async (receivedTitle: string, receivedOptions: string[]) => {
			title = receivedTitle;
			options = receivedOptions;
			return undefined;
		},
	});
	await showGoalSettings(state, context.ctx, { settingsPath: "/tmp/pi-goal.json" });
	assert.match(title, /Pi Goal Settings/);
	assert.deepEqual(options, [
		"Automatic-work limit",
		"No-progress guard",
		"Continuation delay",
		"Goal tools",
		"Ordered goal queue",
		"Managed run RPC",
	]);
});

test("Continuation delay applies Off or custom milliseconds immediately", async () => {
	for (const scenario of [
		{
			initial: 0,
			selections: ["Continuation delay", "Set delay…", undefined],
			input: "1500",
			expected: 1_500,
		},
		{
			initial: 1_500,
			selections: ["Continuation delay", "Off", undefined],
			input: undefined,
			expected: 0,
		},
	] as const) {
		const state = runtime();
		state.settings.continuationLimits.minIntervalMs = scenario.initial;
		let saved: GoalSettings | undefined;
		const selections: Array<string | undefined> = [...scenario.selections];
		const context = createMockContext({
			hasUI: true,
			mode: "tui",
			select: async () => selections.shift(),
			input: async () => scenario.input,
		});

		await showGoalSettings(state, context.ctx, {
			settingsPath: "/tmp/pi-goal.json",
			save(settings) {
				saved = structuredClone(settings);
			},
		});

		assert.equal(saved?.continuationLimits.minIntervalMs, scenario.expected);
		assert.equal(state.settings.continuationLimits.minIntervalMs, scenario.expected);
	}
});

test("Continuation delay rolls back after a save failure", async () => {
	const state = runtime();
	const selections = ["Continuation delay", "Set delay…", undefined];
	const context = createMockContext({
		hasUI: true,
		mode: "tui",
		select: async () => selections.shift(),
		input: async () => "2500",
	});

	await showGoalSettings(state, context.ctx, {
		settingsPath: "/tmp/pi-goal.json",
		save() {
			throw new Error("disk full");
		},
	});

	assert.equal(state.settings.continuationLimits.minIntervalMs, 0);
	assert.match(context.notifications.at(-1)?.message ?? "", /previous value remains/i);
});

test("automatic-work settings can open directly from the safety recovery flow", async () => {
	const state = runtime();
	let title = "";
	let options: string[] = [];
	const context = createMockContext({
		hasUI: true,
		mode: "tui",
		select: async (receivedTitle: string, receivedOptions: string[]) => {
			title = receivedTitle;
			options = receivedOptions;
			return undefined;
		},
	});

	await showGoalSettings(state, context.ctx, {
		settingsPath: "/tmp/pi-goal.json",
		initialScreen: "automatic",
	});

	assert.match(title, /Automatic-work limit/i);
	assert.deepEqual(options, ["Set response limit…", "Unlimited…"]);
});

test("automatic-work finite limit editor starts from the current value or built-in default", async () => {
	for (const scenario of [
		{
			initial: null,
			prefill: "25",
			entered: "25",
			expected: 25,
		},
		{
			initial: 50,
			prefill: "50",
			entered: "40",
			expected: 40,
		},
	] as const) {
		const state = runtime();
		state.settings.continuationLimits.automaticTurns = scenario.initial;
		let saved: GoalSettings | undefined;
		let editorTitle = "";
		let editorPrefill = "";
		const selections = ["Automatic-work limit", "Set response limit…", undefined];
		const context = createMockContext({
			hasUI: true,
			mode: "tui",
			select: async () => selections.shift(),
			editor: async (title: string, prefill: string) => {
				editorTitle = title;
				editorPrefill = prefill;
				return scenario.entered;
			},
		});

		await showGoalSettings(state, context.ctx, {
			settingsPath: "/tmp/pi-goal.json",
			save(settings) {
				saved = structuredClone(settings);
			},
		});

		assert.match(editorTitle, /default: 25/i);
		assert.equal(editorPrefill, scenario.prefill);
		assert.equal(saved?.continuationLimits.automaticTurns, scenario.expected);
		assert.equal(state.settings.continuationLimits.automaticTurns, scenario.expected);
	}
});

test("cancelling the automatic-work finite limit editor changes nothing", async () => {
	const state = runtime();
	state.settings.continuationLimits.automaticTurns = 50;
	let saves = 0;
	const selections = ["Automatic-work limit", "Set response limit…", undefined];
	const context = createMockContext({
		hasUI: true,
		mode: "tui",
		select: async () => selections.shift(),
		editor: async () => undefined,
	});

	await showGoalSettings(state, context.ctx, {
		settingsPath: "/tmp/pi-goal.json",
		save() {
			saves++;
		},
	});

	assert.equal(saves, 0);
	assert.equal(state.settings.continuationLimits.automaticTurns, 50);
});

test("Unlimited automatic work requires a concrete confirmation and cancellation changes nothing", async () => {
	for (const confirmed of [false, true]) {
		const state = runtime();
		let confirmation = "";
		let saves = 0;
		const selections = ["Automatic-work limit", "Unlimited…", undefined];
		const context = createMockContext({
			hasUI: true,
			mode: "tui",
			select: async () => selections.shift(),
			confirm: async (_title: string, message: string) => {
				confirmation = message;
				return confirmed;
			},
		});

		await showGoalSettings(state, context.ctx, {
			settingsPath: "/tmp/pi-goal.json",
			save() {
				saves++;
			},
		});

		assert.match(confirmation, /tool loops can continue.*without a response-count limit/i);
		assert.equal(saves, confirmed ? 1 : 0);
		assert.equal(state.settings.continuationLimits.automaticTurns, confirmed ? null : 25);
	}
});

test("lowering a reached automatic-work limit previews the immediate pause", async () => {
	for (const confirmed of [false, true]) {
		const state = runtime();
		state.settings.continuationLimits.automaticTurns = 40;
		state.activeGoal = createGoal("active objective", undefined, 0);
		state.activeGoal.automaticModelTurns = 25;
		let preview = "";
		let saves = 0;
		const selections = ["Automatic-work limit", "Set response limit…", undefined];
		const context = createMockContext({
			hasUI: true,
			mode: "tui",
			select: async () => selections.shift(),
			editor: async () => "20",
			confirm: async (_title: string, message: string) => {
				preview = message;
				return confirmed;
			},
		});

		await showGoalSettings(state, context.ctx, {
			settingsPath: "/tmp/pi-goal.json",
			save() {
				saves++;
			},
		});

		assert.match(preview, /already used 25.*limit to 20.*pause.*without deleting progress/is);
		assert.equal(saves, confirmed ? 1 : 0);
		assert.equal(state.settings.continuationLimits.automaticTurns, confirmed ? 20 : 40);
		assert.equal(state.activeGoal?.status, confirmed ? "paused" : "active");
	}
});

test("automatic-work save failure preserves the previous valid setting", async () => {
	const state = runtime();
	const selections = ["Automatic-work limit", "Set response limit…", undefined];
	const context = createMockContext({
		hasUI: true,
		mode: "tui",
		select: async () => selections.shift(),
		editor: async () => "40",
	});

	await showGoalSettings(state, context.ctx, {
		settingsPath: "/tmp/pi-goal.json",
		save() {
			throw new Error("disk full");
		},
	});

	assert.equal(state.settings.continuationLimits.automaticTurns, 25);
	assert.match(context.notifications.at(-1)?.message ?? "", /previous value remains/i);
});

test("automatic-work settings stay readable and keyboard-operable at supported widths", async () => {
	const state = runtime();
	const tui = createTuiHarness({ width: 80, rows: 30 });
	const context = createMockContext({ mode: "tui", hasUI: true, custom: tui.custom });

	try {
		const running = showGoalSettings(state, context.ctx, {
			settingsPath: "/tmp/pi-goal.json",
			save() {},
		});
		await tui.waitForOpen();
		for (const width of [40, 80, 120]) {
			const lines = tui.render(width);
			assert.ok(lines.every((line) => visibleWidth(line) <= width));
			assert.match(lines.join(" "), /Automatic-work limit/i);
		}

		tui.press("tui.select.confirm");
		await tui.waitForPending();
		await tui.waitForOpen();
		for (const width of [40, 80, 120]) {
			const lines = tui.render(width);
			const frame = lines.join(" ").replace(/\s+/gu, " ");
			assert.ok(lines.every((line) => visibleWidth(line) <= width));
			assert.match(frame, /Set response limit…/i);
			assert.match(frame, /Default: 25/i);
			assert.match(frame, /Unlimited…/i);
			assert.doesNotMatch(frame, /25 responses \(default\)/i);
		}
		tui.press("tui.select.cancel");
		await tui.waitForOpen();
		assert.match(tui.render().join(" "), /Automatic-work limit/i);
		tui.press("ctrl+c");
		await running;
	} finally {
		tui.dispose();
	}
});

test("automatic-work editing stops without side effects when its menu is disposed", async () => {
	const state = runtime();
	let saves = 0;
	const selections = ["Automatic-work limit", "Set response limit…", undefined];
	const context = createMockContext({
		hasUI: true,
		mode: "tui",
		select: async () => selections.shift(),
		editor: async () => {
			state.closeMenuSession();
			return "10";
		},
	});

	await showGoalSettings(state, context.ctx, {
		settingsPath: "/tmp/pi-goal.json",
		save() {
			saves++;
		},
	});

	assert.equal(saves, 0);
	assert.equal(state.settings.continuationLimits.automaticTurns, 25);
});

test("automatic-work editing rejects a replacement active goal without saving", async () => {
	const state = runtime();
	state.activeGoal = createGoal("original", undefined, 0);
	let saves = 0;
	const selections = ["Automatic-work limit", "Set response limit…", undefined];
	const context = createMockContext({
		hasUI: true,
		mode: "tui",
		select: async () => selections.shift(),
		editor: async () => {
			state.activeGoal = createGoal("replacement", undefined, 0);
			return "10";
		},
	});

	await showGoalSettings(state, context.ctx, {
		settingsPath: "/tmp/pi-goal.json",
		save() {
			saves++;
		},
	});

	assert.equal(saves, 0);
	assert.equal(state.settings.continuationLimits.automaticTurns, 25);
	assert.match(context.notifications.at(-1)?.message ?? "", /active goal changed/i);
});

test("Managed run RPC setting defaults off and saves immediately", async () => {
	const state = runtime();
	let saved: GoalSettings | undefined;
	const selections = ["Managed run RPC", undefined];
	const context = createMockContext({
		hasUI: true,
		mode: "tui",
		select: async () => selections.shift(),
	});

	assert.equal(state.settings.rpc.enabled, false);
	await showGoalSettings(state, context.ctx, {
		settingsPath: "/tmp/pi-goal.json",
		save(settings) {
			saved = structuredClone(settings);
		},
	});

	assert.equal(saved?.rpc.enabled, true);
	assert.equal(state.settings.rpc.enabled, true);
	assert.match(context.notifications.at(-1)?.message ?? "", /Managed run RPC: On/i);
});

test("Managed run RPC setting disables immediately", async () => {
	const state = runtime();
	state.settings = {
		...structuredClone(state.settings),
		rpc: { enabled: true },
	};
	let saved: GoalSettings | undefined;
	const selections = ["Managed run RPC", undefined];
	const context = createMockContext({
		hasUI: true,
		mode: "tui",
		select: async () => selections.shift(),
	});

	await showGoalSettings(state, context.ctx, {
		settingsPath: "/tmp/pi-goal.json",
		save(settings) {
			saved = structuredClone(settings);
		},
	});

	assert.equal(saved?.rpc.enabled, false);
	assert.equal(state.settings.rpc.enabled, false);
	assert.match(context.notifications.at(-1)?.message ?? "", /Managed run RPC: Off/i);
});

test("Managed run RPC setting rolls back when save fails", async () => {
	const state = runtime();
	const selections = ["Managed run RPC", undefined];
	const context = createMockContext({
		hasUI: true,
		mode: "tui",
		select: async () => selections.shift(),
	});

	await showGoalSettings(state, context.ctx, {
		settingsPath: "/tmp/pi-goal.json",
		save() {
			throw new Error("disk full");
		},
	});

	assert.equal(state.settings.rpc.enabled, false);
	assert.match(context.notifications.at(-1)?.message ?? "", /previous value remains/i);
});

test("standard Goal tools setting saves and applies immediately", async () => {
	const state = runtime();
	let saved: GoalSettings | undefined;
	const selections = ["Goal tools", undefined];
	const context = createMockContext({
		hasUI: true,
		mode: "tui",
		select: async () => selections.shift(),
	});
	await showGoalSettings(state, context.ctx, {
		settingsPath: "/tmp/pi-goal.json",
		save(settings) {
			saved = structuredClone(settings);
		},
	});
	assert.equal(saved?.toolVisibility, "after-first-goal");
	assert.equal(state.settings.toolVisibility, "after-first-goal");
});

test("invalid settings use a standard read-only detail screen", async () => {
	const state = runtime();
	state.settingsLoadIssue = { kind: "invalid", reason: "invalid settings shape" };
	let title = "";
	const context = createMockContext({
		hasUI: true,
		mode: "tui",
		select: async (receivedTitle: string) => {
			title = receivedTitle;
			return undefined;
		},
	});
	await showGoalSettings(state, context.ctx, { settingsPath: "/tmp/pi-goal.json" });
	assert.match(title, /Read only/i);
	assert.match(title, /Invalid settings file/i);
	assert.match(title, /Automatic-work limit: Up to 25 responses/i);
	assert.match(title, /Continuation delay: Off/i);
	assert.match(title, /Managed run RPC: Off/i);
});

test("showGoalSettings uses an observable manual fallback outside TUI", async () => {
	const state = runtime();
	const context = createMockContext({ hasUI: true, mode: "rpc" });
	await showGoalSettings(state, context.ctx, { settingsPath: "/tmp/pi-goal.json" });
	assert.match(context.notifications.at(-1)?.message ?? "", /Edit pi-goal settings manually/);
});
