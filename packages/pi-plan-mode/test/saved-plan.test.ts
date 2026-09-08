import assert from "node:assert/strict";
import { test } from "vitest";
import planMode, { completePlanArguments } from "../src/plan-mode.js";
import { restorePlanModeState } from "../src/state.js";
import { createCustomSelectorHarness, createMockContext, createMockPi } from "./support.js";
import { renderMockWidget } from "./widget-support.js";

const PLAN = `# Saved implementation plan

1. Preserve the plan in this session.
2. Implement it later.`;
const STATE_ENTRY_TYPE = "plan-mode-state";
const STABLE_READ_EDIT_TOOLS = ["read", "edit", "plan_mode_question", "plan_mode_complete"];
const MODEL = { provider: "test-provider", id: "test-model" };
const AVAILABLE_MODEL_REGISTRY = {
	getApiKeyAndHeaders: async () => ({ ok: true as const }),
};

function stateEntry(data: Record<string, unknown>) {
	return { type: "custom", customType: STATE_ENTRY_TYPE, data };
}

function latestState(entries: readonly { data: unknown }[]) {
	return entries.at(-1)?.data as
		| {
				enabled?: boolean;
				latestPlan?: string;
				savedPlan?: { plan?: string; source?: string };
				activeImplementation?: { plan?: string };
		  }
		| undefined;
}

async function completePlan(
	mock: ReturnType<typeof createMockPi>,
	ctx: ReturnType<typeof createMockContext>["ctx"],
) {
	const complete = mock.tools.find((candidate) => candidate.name === "plan_mode_complete")
		?.execute as ((...args: unknown[]) => Promise<unknown>) | undefined;
	assert.ok(complete);
	await complete("complete", { plan: PLAN }, undefined, undefined, ctx);
}

test("saved Plan state restores from the active branch and rejects malformed values", () => {
	const savedPlan = { plan: PLAN, source: "plan_mode_complete" };
	const restored = restorePlanModeState(
		[stateEntry({ enabled: false, awaitingAction: false, savedPlan })],
		STATE_ENTRY_TYPE,
	) as ReturnType<typeof restorePlanModeState> & { savedPlan?: unknown };
	assert.deepEqual(restored.savedPlan, savedPlan);
	assert.equal(restored.enabled, false);
	assert.equal(restored.latestPlan, undefined);
	assert.equal(restored.activeImplementation, undefined);

	for (const invalidSavedPlan of [
		undefined,
		null,
		{},
		{ plan: " \n", source: "plan_mode_complete" },
		{ plan: "x".repeat(50_001), source: "plan_mode_complete" },
		{ plan: PLAN, source: "unknown" },
	]) {
		const invalid = restorePlanModeState(
			[stateEntry({ enabled: false, awaitingAction: false, savedPlan: invalidSavedPlan })],
			STATE_ENTRY_TYPE,
		) as ReturnType<typeof restorePlanModeState> & { savedPlan?: unknown };
		assert.equal(invalid.savedPlan, undefined);
	}

	const activeImplementation = {
		id: "implementation-1",
		plan: "# Active implementation",
		source: "plan_mode_complete",
		startedAt: 42,
	};
	const mixed = restorePlanModeState(
		[
			stateEntry({
				enabled: false,
				awaitingAction: false,
				activeImplementation,
				savedPlan,
			}),
		],
		STATE_ENTRY_TYPE,
	) as ReturnType<typeof restorePlanModeState> & { savedPlan?: unknown };
	assert.deepEqual(mixed.activeImplementation, { ...activeImplementation, retention: "keep" });
	assert.equal(mixed.savedPlan, undefined);
});

test("plan save exits Plan mode, restores runtime state, and keeps the plan out of context", async () => {
	const mock = createMockPi({ activeTools: ["read", "edit"], thinkingLevel: "low" });
	planMode(mock.pi, {
		readSettings: async () => ({
			kind: "loaded" as const,
			settings: { thinkingLevel: "medium" as const },
		}),
	});
	const context = createMockContext({ hasUI: true });
	await mock.events.get("session_start")?.[0]?.({}, context.ctx);
	await mock.commands.get("plan")?.handler("start", context.ctx);
	assert.equal(mock.thinkingLevel, "medium");
	await completePlan(mock, context.ctx);

	await mock.commands.get("plan")?.handler("save", context.ctx);

	assert.equal(context.statuses.get("plan-mode"), "plan saved");
	assert.match(
		renderMockWidget(context.widgets.get("plan-mode-plan")).join("\n"),
		/saved for later/i,
	);
	assert.deepEqual(mock.rawPi.getActiveTools(), [
		"read",
		"edit",
		"plan_mode_question",
		"plan_mode_complete",
	]);
	assert.equal(mock.thinkingLevel, "low");
	assert.equal(mock.sentUserMessages.length, 0);
	assert.match(context.notifications.at(-1)?.message ?? "", /saved for later/i);
	assert.deepEqual(latestState(mock.entries)?.savedPlan, {
		plan: PLAN,
		source: "plan_mode_complete",
	});
	assert.equal(latestState(mock.entries)?.enabled, false);
	assert.equal(latestState(mock.entries)?.latestPlan, undefined);
	assert.equal(latestState(mock.entries)?.activeImplementation, undefined);

	const contextHook = mock.events.get("context")?.[0];
	assert.ok(contextHook);
	const transformed = (await contextHook(
		{
			messages: [
				{
					role: "assistant",
					content: [
						{
							type: "toolCall",
							id: "complete-1",
							name: "plan_mode_complete",
							arguments: { plan: PLAN },
						},
					],
				},
				{
					role: "toolResult",
					toolCallId: "complete-1",
					toolName: "plan_mode_complete",
					content: [{ type: "text", text: PLAN }],
					details: { version: 1, source: "plan_mode_complete", plan: PLAN },
				},
				{ role: "custom", customType: "proposed-plan", content: PLAN },
				{ role: "user", content: "Unrelated work" },
			],
		},
		context.ctx,
	)) as { messages: unknown[] };
	assert.match(JSON.stringify(transformed.messages[0]), /CONTRACT v1: NORMAL/u);
	assert.deepEqual(transformed.messages.slice(1), [{ role: "user", content: "Unrelated work" }]);

	const entriesBeforeRepeat = mock.entries.length;
	await mock.commands.get("plan")?.handler("save", context.ctx);
	assert.equal(mock.entries.length, entriesBeforeRepeat);
	assert.equal(context.statuses.get("plan-mode"), "plan saved");
	assert.match(context.notifications.at(-1)?.message ?? "", /no completed plan/i);
});

test("automatic and manual ready menus expose Save for later", async () => {
	for (const automatic of [true, false]) {
		const mock = createMockPi({ activeTools: ["read", "edit"] });
		planMode(mock.pi, { readSettings: async () => ({ kind: "missing" as const }) });
		const context = createMockContext({
			hasUI: true,
			select: async (title: string, options: string[]) => {
				assert.match(title, /Plan reinjection: Off; use conversation history only/i);
				assert.deepEqual(
					options.filter((option) => option !== "Close"),
					automatic
						? [
								"Implement here",
								"Start fresh and implement",
								"Export plan…",
								"Save for later",
								"Stay in Plan mode",
								"Discard plan and exit",
							]
						: [
								"Show latest proposed plan",
								"Implement here",
								"Start fresh and implement",
								"Export plan…",
								"Save for later",
								"Stay in Plan mode",
								"Discard plan and exit",
							],
				);
				return "Save for later";
			},
		});
		await mock.commands.get("plan")?.handler("start", context.ctx);
		await completePlan(mock, context.ctx);
		if (automatic) await mock.events.get("agent_settled")?.[0]?.({}, context.ctx);
		else await mock.commands.get("plan")?.handler("", context.ctx);

		assert.equal(context.statuses.get("plan-mode"), "plan saved");
		assert.equal(latestState(mock.entries)?.savedPlan?.plan, PLAN);
	}
});

test("saved Plan management can show, implement, clear, or cancel", async () => {
	for (const scenario of [
		{ mode: "tui", selection: "Show saved plan", expected: "saved" },
		{ mode: "rpc", selection: "Implement here", expected: "history" },
		{ mode: "tui", selection: "Clear saved plan", expected: "cleared" },
		{ mode: "tui", selection: undefined, expected: "saved" },
	] as const) {
		const savedEntry = stateEntry({
			enabled: false,
			awaitingAction: false,
			savedPlan: { plan: PLAN, source: "plan_mode_complete" },
		});
		const mock = createMockPi({ activeTools: ["read", "edit"] });
		planMode(mock.pi, { readSettings: async () => ({ kind: "missing" as const }) });
		const context = createMockContext({
			mode: scenario.mode,
			model: MODEL,
			modelRegistry: AVAILABLE_MODEL_REGISTRY,
			sessionManager: {
				getBranch: () => [savedEntry],
				getEntries: () => [savedEntry],
			},
			select: async (title: string, options: string[]) => {
				assert.match(title, /Plan reinjection: Off; use conversation history only/i);
				assert.deepEqual(
					options.filter((option) => option !== "Close"),
					[
						"Show saved plan",
						"Implement here",
						"Start fresh and implement",
						"Export plan…",
						"Settings",
						"Clear saved plan",
					],
				);
				return scenario.selection;
			},
		});
		await mock.events.get("session_start")?.[0]?.({}, context.ctx);
		const entriesBeforeMenu = mock.entries.length;
		await mock.commands.get("plan")?.handler("", context.ctx);

		if (scenario.expected === "saved") {
			assert.equal(context.statuses.get("plan-mode"), "plan saved");
			if (scenario.selection) {
				assert.match(
					String((mock.sentMessages.at(-1)?.message as { content?: string })?.content),
					/Saved Plan.*Saved implementation plan/is,
				);
			} else {
				assert.equal(mock.entries.length, entriesBeforeMenu);
			}
			await mock.events.get("session_shutdown")?.[0]?.({}, context.ctx);
			assert.equal(latestState(mock.entries)?.savedPlan?.plan, PLAN);
		} else if (scenario.expected === "history") {
			assert.equal(context.statuses.get("plan-mode"), undefined);
			assert.match(mock.sentUserMessages.at(-1)?.text ?? "", /Saved implementation plan/);
			assert.equal(latestState(mock.entries)?.savedPlan, undefined);
			assert.equal(latestState(mock.entries)?.activeImplementation, undefined);
		} else {
			assert.equal(context.statuses.get("plan-mode"), undefined);
			assert.equal(latestState(mock.entries)?.savedPlan, undefined);
		}
	}
});

test("failed ready implementation restores a manual Plan thinking level", async () => {
	const mock = createMockPi({ activeTools: ["read", "edit"], thinkingLevel: "low" });
	planMode(mock.pi, {
		readSettings: async () => ({
			kind: "loaded" as const,
			settings: { thinkingLevel: "medium" as const },
		}),
	});
	const context = createMockContext();
	await mock.events.get("session_start")?.[0]?.({}, context.ctx);
	await mock.commands.get("plan")?.handler("start", context.ctx);
	mock.rawPi.setThinkingLevel("high");
	await mock.events.get("thinking_level_select")?.[0]?.(
		{ level: "high", previousLevel: "medium" },
		context.ctx,
	);
	await completePlan(mock, context.ctx);
	mock.rawPi.sendUserMessage = () => {
		throw new Error("ready handoff failed");
	};

	await mock.commands.get("plan")?.handler("implement", context.ctx);

	assert.equal(context.statuses.get("plan-mode"), "plan ready");
	assert.equal(mock.thinkingLevel, "high");
	assert.equal(latestState(mock.entries)?.latestPlan, PLAN);
	assert.match(context.notifications.at(-1)?.message ?? "", /ready handoff failed/);
});

test("saved Plan direct routes show, reject busy implementation, roll back failures, and clear", async () => {
	let idle = true;
	const savedEntry = stateEntry({
		enabled: false,
		awaitingAction: false,
		savedPlan: { plan: PLAN, source: "plan_mode_complete" },
	});
	const mock = createMockPi({ activeTools: ["read", "edit"] });
	planMode(mock.pi);
	const context = createMockContext({
		mode: "tui",
		hasUI: true,
		isIdle: () => idle,
		model: MODEL,
		modelRegistry: AVAILABLE_MODEL_REGISTRY,
		sessionManager: {
			getBranch: () => [savedEntry],
			getEntries: () => [savedEntry],
		},
	});
	await mock.events.get("session_start")?.[0]?.({}, context.ctx);

	await mock.commands.get("plan")?.handler("show", context.ctx);
	assert.equal(mock.sentUserMessages.length, 0);
	assert.match(
		String((mock.sentMessages.at(-1)?.message as { content?: string })?.content),
		/Saved Plan.*Saved implementation plan/is,
	);

	mock.rawPi.sendUserMessage = () => {
		throw new Error("saved handoff failed");
	};
	await mock.commands.get("plan")?.handler("implement", context.ctx);
	assert.equal(context.statuses.get("plan-mode"), "plan saved");
	assert.equal(latestState(mock.entries)?.savedPlan?.plan, PLAN);
	assert.equal(latestState(mock.entries)?.activeImplementation, undefined);
	assert.match(context.notifications.at(-1)?.message ?? "", /saved handoff failed/);

	mock.rawPi.sendUserMessage = (text: string, options?: unknown) => {
		mock.sentUserMessages.push({ text, options });
	};
	idle = false;
	await mock.commands.get("plan")?.handler("implement", context.ctx);
	assert.equal(context.statuses.get("plan-mode"), "plan saved");
	assert.equal(mock.sentUserMessages.length, 0);
	assert.match(context.notifications.at(-1)?.message ?? "", /run is active.*retry/i);

	idle = true;
	await mock.commands.get("plan")?.handler("implement", context.ctx);
	assert.equal(context.statuses.get("plan-mode"), undefined);
	assert.equal(mock.sentUserMessages.at(-1)?.options, undefined);
	assert.match(mock.sentUserMessages.at(-1)?.text ?? "", /Saved implementation plan/);
	assert.equal(latestState(mock.entries)?.savedPlan, undefined);
	assert.equal(latestState(mock.entries)?.activeImplementation, undefined);

	const clearMock = createMockPi({ activeTools: ["read"] });
	planMode(clearMock.pi);
	const clearContext = createMockContext({
		sessionManager: {
			getBranch: () => [savedEntry],
			getEntries: () => [savedEntry],
		},
	});
	await clearMock.events.get("session_start")?.[0]?.({}, clearContext.ctx);
	await clearMock.commands.get("plan")?.handler("exit", clearContext.ctx);
	assert.equal(clearContext.statuses.get("plan-mode"), undefined);
	assert.equal(latestState(clearMock.entries)?.savedPlan, undefined);
	assert.match(clearContext.notifications.at(-1)?.message ?? "", /saved plan cleared/i);
});

test("saved Plan implementation preflight retains state on auth failure or session replacement", async () => {
	const savedEntry = stateEntry({
		enabled: false,
		awaitingAction: false,
		savedPlan: { plan: PLAN, source: "plan_mode_complete" },
	});
	const authFailure = createMockPi({ activeTools: ["read", "edit"] });
	planMode(authFailure.pi);
	const authFailureContext = createMockContext({
		hasUI: true,
		model: MODEL,
		modelRegistry: {
			getApiKeyAndHeaders: async () => ({ ok: false as const, error: "No test auth" }),
		},
		sessionManager: {
			getBranch: () => [savedEntry],
			getEntries: () => [savedEntry],
		},
	});
	await authFailure.events.get("session_start")?.[0]?.({}, authFailureContext.ctx);
	await authFailure.commands.get("plan")?.handler("implement", authFailureContext.ctx);
	assert.equal(authFailureContext.statuses.get("plan-mode"), "plan saved");
	assert.equal(authFailure.sentUserMessages.length, 0);
	assert.match(authFailureContext.notifications.at(-1)?.message ?? "", /No test auth/);

	let resolveAuth!: (result: { ok: true }) => void;
	const authPending = new Promise<{ ok: true }>((resolve) => {
		resolveAuth = resolve;
	});
	const replaced = createMockPi({ activeTools: ["read", "edit"] });
	planMode(replaced.pi);
	const replacedContext = createMockContext({
		hasUI: true,
		model: MODEL,
		modelRegistry: { getApiKeyAndHeaders: () => authPending },
		sessionManager: {
			getBranch: () => [savedEntry],
			getEntries: () => [savedEntry],
		},
	});
	await replaced.events.get("session_start")?.[0]?.({}, replacedContext.ctx);
	const pendingImplementation = replaced.commands
		.get("plan")
		?.handler("implement", replacedContext.ctx);
	await replaced.events.get("session_shutdown")?.[0]?.({}, replacedContext.ctx);
	resolveAuth({ ok: true });
	await pendingImplementation;
	assert.equal(replaced.sentUserMessages.length, 0);
	assert.equal(latestState(replaced.entries)?.savedPlan?.plan, PLAN);
});

test("saved Plan survives resume and blocks replacement workflows", async () => {
	const savedEntry = stateEntry({
		enabled: false,
		awaitingAction: false,
		savedPlan: { plan: PLAN, source: "plan_mode_complete" },
	});
	const mock = createMockPi({ activeTools: ["read", "edit"] });
	planMode(mock.pi);
	const context = createMockContext({
		hasUI: true,
		sessionManager: {
			getBranch: () => [savedEntry],
			getEntries: () => [savedEntry],
		},
	});
	await mock.events.get("session_start")?.[0]?.({}, context.ctx);
	await mock.commands.get("plan")?.handler("start", context.ctx);
	await mock.commands.get("plan")?.handler("design something else", context.ctx);
	await mock.commands.get("plan")?.handler("tools", context.ctx);
	assert.equal(mock.sentUserMessages.length, 0);
	assert.deepEqual(mock.rawPi.getActiveTools(), STABLE_READ_EDIT_TOOLS);
	assert.equal(context.statuses.get("plan-mode"), "plan saved");
	assert.match(context.notifications.at(-1)?.message ?? "", /implement or clear/i);
	await mock.events.get("session_shutdown")?.[0]?.({}, context.ctx);
	assert.equal(latestState(mock.entries)?.savedPlan?.plan, PLAN);
});

test("saved Plan no-UI management is observable without changing state", async () => {
	for (const mode of ["print", "json"] as const) {
		const savedEntry = stateEntry({
			enabled: false,
			awaitingAction: false,
			savedPlan: { plan: PLAN, source: "plan_mode_complete" },
		});
		const mock = createMockPi({ activeTools: ["read", "edit"] });
		planMode(mock.pi);
		const context = createMockContext({
			mode,
			hasUI: false,
			sessionManager: {
				getBranch: () => [savedEntry],
				getEntries: () => [savedEntry],
			},
		});
		await mock.events.get("session_start")?.[0]?.({}, context.ctx);
		await assert.rejects(
			mock.commands.get("plan")?.handler("", context.ctx) as Promise<unknown>,
			/\/plan start.*\/plan <prompt>/i,
		);
		await assert.rejects(
			mock.commands.get("plan")?.handler("design something else", context.ctx) as Promise<unknown>,
			/implement or clear/i,
		);
		await assert.rejects(
			mock.commands.get("plan")?.handler("tools", context.ctx) as Promise<unknown>,
			/implement or clear/i,
		);
		await assert.rejects(
			mock.commands.get("plan")?.handler("show", context.ctx) as Promise<unknown>,
			/saved plan.*print|print.*saved plan/i,
		);
		await assert.rejects(
			mock.commands.get("plan")?.handler("implement", context.ctx) as Promise<unknown>,
			/saved plan.*print|print.*saved plan/i,
		);
		assert.equal(context.statuses.get("plan-mode"), "plan saved");
		assert.deepEqual(mock.rawPi.getActiveTools(), STABLE_READ_EDIT_TOOLS);
		await mock.events.get("session_shutdown")?.[0]?.({}, context.ctx);
		assert.equal(latestState(mock.entries)?.savedPlan?.plan, PLAN);
	}
});

test("print and JSON modes can save and clear a ready plan", async () => {
	for (const mode of ["print", "json"] as const) {
		const mock = createMockPi({ activeTools: ["read", "edit"] });
		planMode(mock.pi);
		const context = createMockContext({ mode, hasUI: false });
		await mock.events.get("session_start")?.[0]?.({}, context.ctx);
		await mock.commands.get("plan")?.handler("start", context.ctx);
		await completePlan(mock, context.ctx);

		await mock.commands.get("plan")?.handler("save", context.ctx);
		assert.equal(context.statuses.get("plan-mode"), "plan saved");
		assert.equal(latestState(mock.entries)?.savedPlan?.plan, PLAN);
		assert.deepEqual(mock.rawPi.getActiveTools(), [
			"read",
			"edit",
			"plan_mode_question",
			"plan_mode_complete",
		]);

		await assert.rejects(
			mock.commands.get("plan")?.handler("show", context.ctx) as Promise<unknown>,
			/saved plan.*print|print.*saved plan/i,
		);
		await assert.rejects(
			mock.commands.get("plan")?.handler("implement", context.ctx) as Promise<unknown>,
			/saved plan.*print|print.*saved plan/i,
		);
		assert.equal(latestState(mock.entries)?.savedPlan?.plan, PLAN);
		assert.equal(mock.sentUserMessages.length, 0);

		await mock.commands.get("plan")?.handler(mode === "json" ? "off" : "exit", context.ctx);
		assert.equal(context.statuses.get("plan-mode"), undefined);
		assert.equal(latestState(mock.entries)?.savedPlan, undefined);
	}
});

test("session shutdown disposes a saved Plan menu without a late transition", async () => {
	let menuHarness: ReturnType<typeof createCustomSelectorHarness> | undefined;
	let markStarted!: () => void;
	const started = new Promise<void>((resolve) => {
		markStarted = resolve;
	});
	const savedEntry = stateEntry({
		enabled: false,
		awaitingAction: false,
		savedPlan: { plan: PLAN, source: "plan_mode_complete" },
	});
	const mock = createMockPi({ activeTools: ["read", "edit"] });
	planMode(mock.pi);
	const context = createMockContext({
		mode: "tui",
		sessionManager: {
			getBranch: () => [savedEntry],
			getEntries: () => [savedEntry],
		},
		custom: async (factory: unknown) => {
			menuHarness = createCustomSelectorHarness(factory);
			markStarted();
			return menuHarness.resultPromise;
		},
	});
	await mock.events.get("session_start")?.[0]?.({}, context.ctx);
	const pendingMenu = mock.commands.get("plan")?.handler("", context.ctx);
	await started;
	await mock.events.get("session_shutdown")?.[0]?.({}, context.ctx);
	await pendingMenu;

	assert.ok(menuHarness);
	assert.equal(context.statuses.get("plan-mode"), undefined);
	assert.deepEqual(mock.rawPi.getActiveTools(), STABLE_READ_EDIT_TOOLS);
	assert.equal(latestState(mock.entries)?.savedPlan?.plan, PLAN);
	assert.equal(mock.sentMessages.length, 0);
	assert.equal(mock.sentUserMessages.length, 0);
});

test("plan save autocomplete is public and saving fails closed without a ready plan", async () => {
	assert.deepEqual(
		completePlanArguments("")?.map((item) => item.value),
		["start", "show", "finalize", "implement", "save", "export", "exit", "off", "tools"],
	);
	assert.deepEqual(
		completePlanArguments("sa")?.map((item) => item.value),
		["save"],
	);
	assert.equal(completePlanArguments("save "), null);

	const mock = createMockPi({ activeTools: ["read"] });
	planMode(mock.pi);
	const context = createMockContext({ hasUI: true });
	await mock.commands.get("plan")?.handler("save", context.ctx);
	assert.equal(context.statuses.get("plan-mode"), undefined);
	assert.equal(mock.sentUserMessages.length, 0);
	assert.equal(latestState(mock.entries)?.savedPlan, undefined);
	assert.match(context.notifications.at(-1)?.message ?? "", /no completed plan/i);

	const printMock = createMockPi({ activeTools: ["read"] });
	planMode(printMock.pi);
	const printContext = createMockContext({ mode: "print", hasUI: false });
	await assert.rejects(
		printMock.commands.get("plan")?.handler("save", printContext.ctx) as Promise<unknown>,
		/no completed plan/i,
	);
});
