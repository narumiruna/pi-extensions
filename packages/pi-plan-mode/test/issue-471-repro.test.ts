import assert from "node:assert/strict";
import { test } from "vitest";
import { PLAN_MODE_MAX_CHARS } from "../src/completion-tool.js";
import planModeExtension from "../src/plan-mode.js";
import { type ActiveImplementationPlan, restorePlanModeState } from "../src/state.js";
import { createCustomSelectorHarness, createMockContext, createMockPi } from "./support.js";
import { renderMockWidget } from "./widget-support.js";

const PLAN = `# Compaction-safe implementation

Marker: PLAN-PERSIST-TEST-42

1. Preserve the exact approved plan.
2. Verify it after compaction.`;
const STATE_ENTRY_TYPE = "plan-mode-state";
const KEEP_SETTINGS = {
	readSettings: async () => ({
		kind: "loaded" as const,
		settings: {
			thinkingLevel: "inherit" as const,
			implementationPlanRetention: "keep" as const,
		},
	}),
};

function planMode(
	pi: Parameters<typeof planModeExtension>[0],
	options?: Parameters<typeof planModeExtension>[1],
) {
	return planModeExtension(pi, options ?? KEEP_SETTINGS);
}

function stateEntry(data: Record<string, unknown>) {
	return { type: "custom", customType: STATE_ENTRY_TYPE, data };
}

function latestState(entries: readonly { data: unknown }[]) {
	return entries.at(-1)?.data as
		| {
				enabled?: boolean;
				latestPlan?: string;
				activeImplementation?: ActiveImplementationPlan;
		  }
		| undefined;
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((settle) => {
		resolve = settle;
	});
	return { promise, resolve };
}

test("active implementation state restores independently from Plan mode", () => {
	const activeImplementation: ActiveImplementationPlan = {
		id: "implementation-1",
		plan: PLAN,
		source: "plan_mode_complete",
		startedAt: 42,
	};
	const restored = restorePlanModeState(
		[
			stateEntry({
				enabled: false,
				awaitingAction: false,
				activeImplementation,
				selectedToolNames: ["read"],
			}),
		],
		STATE_ENTRY_TYPE,
	);

	assert.deepEqual(restored.activeImplementation, { ...activeImplementation, retention: "keep" });
	assert.deepEqual(restored.selectedToolNames, ["read"]);
	assert.equal(restored.latestPlan, undefined);
	assert.equal(restored.awaitingAction, false);
});

test("active implementation restoration fails closed on malformed retained state", () => {
	const valid = {
		id: "implementation-1",
		plan: PLAN,
		source: "plan_mode_complete",
		startedAt: 42,
	};
	const invalidValues = [
		undefined,
		null,
		{},
		{ ...valid, id: "" },
		{ ...valid, plan: " \n" },
		{ ...valid, plan: "x".repeat(PLAN_MODE_MAX_CHARS + 1) },
		{ ...valid, source: "unknown" },
		{ ...valid, startedAt: -1 },
		{ ...valid, startedAt: Number.NaN },
	];

	for (const activeImplementation of invalidValues) {
		const restored = restorePlanModeState(
			[
				stateEntry({
					enabled: false,
					awaitingAction: false,
					activeImplementation,
					selectedToolNames: ["read"],
				}),
			],
			STATE_ENTRY_TYPE,
		);
		assert.equal(restored.activeImplementation, undefined);
		assert.deepEqual(restored.selectedToolNames, ["read"]);
	}
});

test("legacy plans obey the completion size bound before restore or readiness", async () => {
	const oversizedPlan = "x".repeat(PLAN_MODE_MAX_CHARS + 1);
	const restored = restorePlanModeState(
		[
			stateEntry({
				enabled: true,
				awaitingAction: true,
				latestPlan: oversizedPlan,
			}),
		],
		STATE_ENTRY_TYPE,
	);
	assert.equal(restored.latestPlan, undefined);
	assert.equal(restored.awaitingAction, false);

	const mock = createMockPi({ activeTools: ["read"] });
	planMode(mock.pi);
	const context = createMockContext();
	await mock.commands.get("plan")?.handler("start", context.ctx);
	await mock.events.get("agent_end")?.[0]?.(
		{
			messages: [
				{
					role: "assistant",
					content: `<proposed_plan>\n${oversizedPlan}\n</proposed_plan>`,
				},
			],
		},
		context.ctx,
	);
	assert.equal(context.statuses.get("plan-mode"), "plan active");
	assert.match(context.notifications.at(-1)?.message ?? "", /must not exceed 50000/i);
});

test("ready Plan mode wins over malformed mixed ready and implementation state", () => {
	const restored = restorePlanModeState(
		[
			stateEntry({
				enabled: true,
				awaitingAction: true,
				latestPlan: "# Ready",
				latestPlanSource: "plan_mode_complete",
				activeImplementation: {
					id: "implementation-1",
					plan: PLAN,
					source: "plan_mode_complete",
					startedAt: 42,
				},
			}),
		],
		STATE_ENTRY_TYPE,
	);

	assert.equal(restored.latestPlan, "# Ready");
	assert.equal(restored.awaitingAction, true);
	assert.equal(restored.activeImplementation, undefined);
});

test("the latest branch-local state can clear an older active implementation", () => {
	const restored = restorePlanModeState(
		[
			stateEntry({
				enabled: false,
				awaitingAction: false,
				activeImplementation: {
					id: "implementation-1",
					plan: PLAN,
					source: "plan_mode_complete",
					startedAt: 42,
				},
			}),
			{ type: "message", message: { role: "assistant", content: "work" } },
			stateEntry({ enabled: false, awaitingAction: false }),
		],
		STATE_ENTRY_TYPE,
	);

	assert.equal(restored.activeImplementation, undefined);
	assert.equal(restored.enabled, false);
});

test("issue 471: an active implementation plan is restored after compaction removes its handoff", async () => {
	const mock = createMockPi({ activeTools: ["read", "edit"] });
	planMode(mock.pi);
	const context = createMockContext();
	await mock.events.get("session_start")?.[0]?.({}, context.ctx);

	await mock.commands.get("plan")?.handler("start", context.ctx);
	const complete = mock.tools.find((candidate) => candidate.name === "plan_mode_complete")
		?.execute as ((...args: unknown[]) => Promise<unknown>) | undefined;
	assert.ok(complete);
	await complete("complete", { plan: PLAN }, undefined, undefined, context.ctx);
	await mock.commands.get("plan")?.handler("implement", context.ctx);

	const contextHook = mock.events.get("context")?.[0];
	assert.ok(contextHook);
	const compactedMessages = [
		{
			role: "compactionSummary",
			summary: "The accepted implementation plan was summarized without its exact steps.",
		},
		{ role: "assistant", content: [{ type: "text", text: "Continuing after compaction." }] },
	];
	const transformed = (await contextHook({ messages: compactedMessages }, context.ctx)) as {
		messages: Record<string, unknown>[];
	};

	assert.equal(transformed.messages.length, 4);
	assert.deepEqual(transformed.messages[0], compactedMessages[0]);
	assert.match(String(transformed.messages[1]?.content), /CONTRACT v1: NORMAL/u);
	assert.equal(transformed.messages[2]?.role, "custom");
	assert.equal(transformed.messages[2]?.customType, "plan-mode-implementation-context");
	assert.match(String(transformed.messages[2]?.content), /ACTIVE IMPLEMENTATION PLAN/);
	assert.ok(String(transformed.messages[2]?.content).endsWith(PLAN));
	assert.deepEqual(transformed.messages[3], compactedMessages[1]);

	const persisted = mock.entries.at(-1)?.data as {
		enabled?: boolean;
		activeImplementation?: { plan?: string };
	};
	assert.equal(persisted.enabled, false);
	assert.equal(persisted.activeImplementation?.plan, PLAN);
});

test("implementation transition rejects a busy run before committing and succeeds when idle", async () => {
	let idle = true;
	const mock = createMockPi({ activeTools: ["read", "edit"] });
	planMode(mock.pi);
	const context = createMockContext({ mode: "tui", hasUI: true, isIdle: () => idle });
	await mock.events.get("session_start")?.[0]?.({}, context.ctx);
	await mock.commands.get("plan")?.handler("start", context.ctx);
	const complete = mock.tools.find((candidate) => candidate.name === "plan_mode_complete")
		?.execute as ((...args: unknown[]) => Promise<unknown>) | undefined;
	assert.ok(complete);
	await complete("complete", { plan: PLAN }, undefined, undefined, context.ctx);
	const entriesBeforeBusyAttempt = mock.entries.length;

	idle = false;
	await mock.commands.get("plan")?.handler("implement", context.ctx);
	assert.equal(context.statuses.get("plan-mode"), "plan ready");
	assert.deepEqual(mock.rawPi.getActiveTools(), [
		"read",
		"edit",
		"plan_mode_question",
		"plan_mode_complete",
	]);
	assert.equal(mock.entries.length, entriesBeforeBusyAttempt);
	assert.equal(mock.sentUserMessages.length, 0);
	assert.match(context.notifications.at(-1)?.message ?? "", /run is active.*retry/i);
	const heldAttempt = {
		session: (context.ctx as unknown as { sessionManager: object }).sessionManager,
		group: "agent-workflow",
		busy: false,
	};
	mock.eventBus.emit("workflow:mutex:v1", heldAttempt);
	assert.equal(heldAttempt.busy, true);

	idle = true;
	await mock.commands.get("plan")?.handler("implement", context.ctx);
	assert.equal(context.statuses.get("plan-mode"), "plan implementing");
	assert.match(
		renderMockWidget(context.widgets.get("plan-mode-plan")).join("\n"),
		/implementation plan active/i,
	);
	assert.deepEqual(mock.rawPi.getActiveTools(), [
		"read",
		"edit",
		"plan_mode_question",
		"plan_mode_complete",
	]);
	assert.equal(mock.sentUserMessages.at(-1)?.options, undefined);
	const activeState = latestState(mock.entries);
	assert.equal(activeState?.activeImplementation?.plan, PLAN);
	assert.equal(activeState.activeImplementation?.source, "plan_mode_complete");
	assert.match(activeState.activeImplementation?.id ?? "", /^[0-9a-f-]{36}$/u);
	assert.ok((activeState.activeImplementation?.startedAt ?? -1) >= 0);
	const releasedAttempt = {
		session: (context.ctx as unknown as { sessionManager: object }).sessionManager,
		group: "agent-workflow",
		busy: false,
	};
	mock.eventBus.emit("workflow:mutex:v1", releasedAttempt);
	assert.equal(releasedAttempt.busy, false);

	const sendsBeforeRepeat = mock.sentUserMessages.length;
	await mock.commands.get("plan")?.handler("implement", context.ctx);
	assert.equal(mock.sentUserMessages.length, sendsBeforeRepeat);
	assert.equal(latestState(mock.entries)?.activeImplementation?.plan, PLAN);
});

test("failed implementation delivery restores ready state without retained implementation", async () => {
	const mock = createMockPi({ activeTools: ["read", "custom"] });
	planMode(mock.pi);
	const context = createMockContext();
	await mock.commands.get("plan")?.handler("start", context.ctx);
	const complete = mock.tools.find((candidate) => candidate.name === "plan_mode_complete")
		?.execute as ((...args: unknown[]) => Promise<unknown>) | undefined;
	assert.ok(complete);
	await complete("complete", { plan: PLAN }, undefined, undefined, context.ctx);
	mock.rawPi.sendUserMessage = () => {
		throw new Error("Extension context is no longer active");
	};

	await mock.commands.get("plan")?.handler("implement", context.ctx);
	assert.equal(context.statuses.get("plan-mode"), "plan ready");
	assert.deepEqual(mock.rawPi.getActiveTools(), [
		"read",
		"custom",
		"plan_mode_question",
		"plan_mode_complete",
	]);
	const restored = latestState(mock.entries);
	assert.equal(restored?.latestPlan, PLAN);
	assert.equal(restored?.activeImplementation, undefined);
	assert.match(context.notifications.at(-1)?.message ?? "", /no longer active/);
	const retainedAttempt = {
		session: (context.ctx as unknown as { sessionManager: object }).sessionManager,
		group: "agent-workflow",
		busy: false,
	};
	mock.eventBus.emit("workflow:mutex:v1", retainedAttempt);
	assert.equal(retainedAttempt.busy, true);
});

test("a failed superseding prompt restores the exact active implementation", async () => {
	const mock = createMockPi({ activeTools: ["read", "edit"] });
	planMode(mock.pi);
	const context = createMockContext();
	await mock.events.get("session_start")?.[0]?.({}, context.ctx);
	await mock.commands.get("plan")?.handler("start", context.ctx);
	const complete = mock.tools.find((candidate) => candidate.name === "plan_mode_complete")
		?.execute as ((...args: unknown[]) => Promise<unknown>) | undefined;
	assert.ok(complete);
	await complete("complete", { plan: PLAN }, undefined, undefined, context.ctx);
	await mock.commands.get("plan")?.handler("implement", context.ctx);
	const activeBeforeFailure = latestState(mock.entries)?.activeImplementation;
	assert.ok(activeBeforeFailure);
	mock.rawPi.sendUserMessage = () => {
		throw new Error("replacement delivery failed");
	};

	await mock.commands.get("plan")?.handler("design a replacement", context.ctx);

	assert.equal(context.statuses.get("plan-mode"), "plan implementing");
	assert.deepEqual(mock.rawPi.getActiveTools(), [
		"read",
		"edit",
		"plan_mode_question",
		"plan_mode_complete",
	]);
	const restored = latestState(mock.entries);
	assert.equal(restored?.enabled, false);
	assert.deepEqual(restored?.activeImplementation, activeBeforeFailure);
	assert.match(context.notifications.at(-1)?.message ?? "", /replacement delivery failed/);
});

test("active context avoids exact handoff duplication and replaces stale injected blocks", async () => {
	const mock = createMockPi({ activeTools: ["read", "edit"] });
	planMode(mock.pi);
	const context = createMockContext();
	await mock.events.get("session_start")?.[0]?.({}, context.ctx);
	await mock.commands.get("plan")?.handler("start", context.ctx);
	const complete = mock.tools.find((candidate) => candidate.name === "plan_mode_complete")
		?.execute as ((...args: unknown[]) => Promise<unknown>) | undefined;
	assert.ok(complete);
	await complete("complete", { plan: PLAN }, undefined, undefined, context.ctx);
	await mock.commands.get("plan")?.handler("implement", context.ctx);
	const contextHook = mock.events.get("context")?.[0];
	assert.ok(contextHook);

	const handoff = { role: "user", content: mock.sentUserMessages.at(-1)?.text };
	const withHandoff = (await contextHook(
		{ messages: [{ role: "user", content: "plan it" }, handoff] },
		context.ctx,
	)) as { messages: Record<string, unknown>[] };
	assert.equal(
		withHandoff.messages.filter(
			(message) => message.customType === "plan-mode-implementation-context",
		).length,
		0,
	);
	assert.match(String(withHandoff.messages[0]?.content), /CONTRACT v1: NORMAL/u);
	assert.deepEqual(withHandoff.messages.slice(1), [{ role: "user", content: "plan it" }, handoff]);

	const staleHandoff = {
		role: "user",
		content: String(mock.sentUserMessages.at(-1)?.text).replace(PLAN, "# Superseded plan"),
	};
	const withStaleHandoff = (await contextHook(
		{ messages: [staleHandoff, handoff, handoff] },
		context.ctx,
	)) as { messages: Record<string, unknown>[] };
	assert.match(String(withStaleHandoff.messages[0]?.content), /CONTRACT v1: NORMAL/u);
	assert.deepEqual(withStaleHandoff.messages.slice(1), [handoff]);

	const toolCall = {
		role: "assistant",
		content: [{ type: "toolCall", id: "read-1", name: "read", arguments: { path: "a" } }],
	};
	const toolResult = {
		role: "toolResult",
		toolCallId: "read-1",
		toolName: "read",
		content: [{ type: "text", text: "ok" }],
	};
	const compacted = [
		{ role: "compactionSummary", summary: "lossy" },
		{
			role: "custom",
			customType: "plan-mode-implementation-context",
			content: "stale",
		},
		toolCall,
		toolResult,
	];
	const once = (await contextHook({ messages: compacted }, context.ctx)) as {
		messages: Record<string, unknown>[];
	};
	const twice = (await contextHook({ messages: once.messages }, context.ctx)) as {
		messages: Record<string, unknown>[];
	};
	for (const transformed of [once.messages, twice.messages]) {
		assert.deepEqual(transformed[0], compacted[0]);
		assert.match(String(transformed[1]?.content), /CONTRACT v1: NORMAL/u);
		assert.equal(transformed[2]?.customType, "plan-mode-implementation-context");
		assert.match(String(transformed[2]?.content), /PLAN-PERSIST-TEST-42/);
		assert.deepEqual(transformed.slice(3), [toolCall, toolResult]);
		assert.equal(
			transformed.filter((message) => message.customType === "plan-mode-implementation-context")
				.length,
			1,
		);
	}
});

test("active plans can be shown and cleared through existing direct routes", async () => {
	const mock = createMockPi({ activeTools: ["read", "edit"] });
	planMode(mock.pi);
	const context = createMockContext();
	await mock.events.get("session_start")?.[0]?.({}, context.ctx);
	await mock.commands.get("plan")?.handler("start", context.ctx);
	const complete = mock.tools.find((candidate) => candidate.name === "plan_mode_complete")
		?.execute as ((...args: unknown[]) => Promise<unknown>) | undefined;
	assert.ok(complete);
	await complete("complete", { plan: PLAN }, undefined, undefined, context.ctx);
	await mock.commands.get("plan")?.handler("implement", context.ctx);

	await mock.commands.get("plan")?.handler("show", context.ctx);
	assert.match(
		String((mock.sentMessages.at(-1)?.message as { content?: string })?.content),
		/Active Implementation Plan.*PLAN-PERSIST-TEST-42/is,
	);

	await mock.commands.get("plan")?.handler("exit", context.ctx);
	assert.equal(context.statuses.get("plan-mode"), undefined);
	assert.equal(context.widgets.get("plan-mode-plan"), undefined);
	assert.equal(latestState(mock.entries)?.activeImplementation, undefined);
	const contextHook = mock.events.get("context")?.[0];
	assert.ok(contextHook);
	const transformed = (await contextHook(
		{
			messages: [
				{ role: "compactionSummary", summary: "lossy" },
				{ role: "user", content: mock.sentUserMessages.at(-1)?.text },
			],
		},
		context.ctx,
	)) as { messages: Record<string, unknown>[] };
	assert.deepEqual(transformed.messages[0], { role: "compactionSummary", summary: "lossy" });
	assert.match(String(transformed.messages[1]?.content), /CONTRACT v1: NORMAL/u);
	assert.equal(transformed.messages.length, 2);
});

test("a Plan-mode question cannot commit or open its next prompt after Plan mode exits", async () => {
	const selection = deferred<string | undefined>();
	const selectStarted = deferred<void>();
	let selectCalls = 0;
	const mock = createMockPi({ activeTools: ["read"] });
	planMode(mock.pi);
	const context = createMockContext({
		mode: "rpc",
		hasUI: true,
		select: async () => {
			selectCalls += 1;
			if (selectCalls > 1) throw new Error("stale question prompt reopened");
			selectStarted.resolve();
			return selection.promise;
		},
	});
	await mock.commands.get("plan")?.handler("start", context.ctx);
	const question = mock.tools.find((candidate) => candidate.name === "plan_mode_question")
		?.execute as ((...args: unknown[]) => Promise<unknown>) | undefined;
	assert.ok(question);
	const pendingAnswer = question(
		"question",
		{
			questions: [
				{
					id: "scope",
					header: "Scope",
					question: "Which scope?",
					options: [
						{ label: "Narrow", description: "Change only this path." },
						{ label: "Broad", description: "Change sibling paths too." },
					],
				},
				{
					id: "tests",
					header: "Tests",
					question: "Which tests?",
					options: [
						{ label: "Focused", description: "Run focused tests." },
						{ label: "Full", description: "Run every test." },
					],
				},
			],
		},
		undefined,
		undefined,
		context.ctx,
	);
	await selectStarted.promise;
	await mock.commands.get("plan")?.handler("exit", context.ctx);
	await mock.commands.get("plan")?.handler("start", context.ctx);
	selection.resolve("1. Narrow — Change only this path.");

	const result = (await pendingAnswer) as { details?: { cancelled?: boolean; reason?: string } };
	assert.equal(result.details?.cancelled, true);
	assert.equal(result.details?.reason, "cancelled");
	assert.equal(selectCalls, 1);
});

test("shutdown cancellation cannot let a stale pre-start tool menu activate Plan mode", async () => {
	const selectStarted = deferred<void>();
	const mock = createMockPi({
		activeTools: ["read", "edit"],
		allTools: [
			{ name: "read", description: "Read", sourceInfo: { source: "builtin", scope: "builtin" } },
			{ name: "edit", description: "Edit", sourceInfo: { source: "builtin", scope: "builtin" } },
		],
	});
	planMode(mock.pi);
	const context = createMockContext({
		mode: "tui",
		custom: async (factory: unknown) => {
			const harness = createCustomSelectorHarness(factory);
			selectStarted.resolve();
			return harness.resultPromise;
		},
	});
	const pendingMenu = mock.commands.get("plan")?.handler("tools", context.ctx);
	await selectStarted.promise;
	await mock.events.get("session_shutdown")?.[0]?.({}, context.ctx);
	await pendingMenu;

	assert.deepEqual(mock.rawPi.getActiveTools(), [
		"read",
		"edit",
		"plan_mode_question",
		"plan_mode_complete",
	]);
	assert.equal(context.statuses.get("plan-mode"), undefined);
});

test("a state change while a pre-start tool menu is open cannot activate Plan mode", async () => {
	const selectStarted = deferred<void>();
	let menuHarness: ReturnType<typeof createCustomSelectorHarness> | undefined;
	const mock = createMockPi({
		activeTools: ["read", "edit"],
		allTools: [
			{ name: "read", description: "Read", sourceInfo: { source: "builtin", scope: "builtin" } },
			{ name: "edit", description: "Edit", sourceInfo: { source: "builtin", scope: "builtin" } },
		],
	});
	planMode(mock.pi);
	const context = createMockContext({
		mode: "tui",
		custom: async (factory: unknown) => {
			menuHarness = createCustomSelectorHarness(factory);
			selectStarted.resolve();
			return menuHarness.resultPromise;
		},
	});
	const pendingMenu = mock.commands.get("plan")?.handler("tools", context.ctx);
	await selectStarted.promise;
	await mock.commands.get("plan")?.handler("exit", context.ctx);
	assert.ok(menuHarness);
	menuHarness.handleInput("tui.select.cancel");
	await pendingMenu;

	assert.deepEqual(mock.rawPi.getActiveTools(), [
		"read",
		"edit",
		"plan_mode_question",
		"plan_mode_complete",
	]);
	assert.equal(context.statuses.get("plan-mode"), undefined);
});

test("the active-plan menu shows without superseding and cancellation is read-only", async () => {
	for (const selection of ["Show active implementation plan", undefined]) {
		const mock = createMockPi({ activeTools: ["read", "edit"] });
		planMode(mock.pi);
		const context = createMockContext({
			hasUI: true,
			select: async (_title: string, options: string[]) =>
				selection ? options.find((option) => option.startsWith(selection)) : undefined,
		});
		await mock.events.get("session_start")?.[0]?.({}, context.ctx);
		await mock.commands.get("plan")?.handler("start", context.ctx);
		const complete = mock.tools.find((candidate) => candidate.name === "plan_mode_complete")
			?.execute as ((...args: unknown[]) => Promise<unknown>) | undefined;
		assert.ok(complete);
		await complete("complete", { plan: PLAN }, undefined, undefined, context.ctx);
		await mock.commands.get("plan")?.handler("implement", context.ctx);
		const entriesBeforeMenu = mock.entries.length;

		await mock.commands.get("plan")?.handler("", context.ctx);
		assert.equal(context.statuses.get("plan-mode"), "plan implementing");
		assert.equal(latestState(mock.entries)?.activeImplementation?.plan, PLAN);
		if (selection) {
			assert.match(
				String((mock.sentMessages.at(-1)?.message as { content?: string })?.content),
				/PLAN-PERSIST-TEST-42/,
			);
		} else {
			assert.equal(mock.entries.length, entriesBeforeMenu);
		}
	}
});

test("active-plan menu actions work in TUI and RPC without hidden route changes", async () => {
	for (const scenario of [
		{ mode: "tui", selection: "Start a new plan", expectedStatus: "plan active" },
		{ mode: "rpc", selection: "Clear active implementation plan", expectedStatus: undefined },
	] as const) {
		const mock = createMockPi({ activeTools: ["read", "edit"] });
		planMode(mock.pi);
		const context = createMockContext({
			mode: scenario.mode,
			select: async (_title: string, options: string[]) => {
				assert.ok(options.includes("Settings"));
				return options.find((option) => option.startsWith(scenario.selection));
			},
		});
		await mock.events.get("session_start")?.[0]?.({}, context.ctx);
		await mock.commands.get("plan")?.handler("start", context.ctx);
		const complete = mock.tools.find((candidate) => candidate.name === "plan_mode_complete")
			?.execute as ((...args: unknown[]) => Promise<unknown>) | undefined;
		assert.ok(complete);
		await complete("complete", { plan: PLAN }, undefined, undefined, context.ctx);
		await mock.commands.get("plan")?.handler("implement", context.ctx);

		await mock.commands.get("plan")?.handler("", context.ctx);
		assert.equal(context.statuses.get("plan-mode"), scenario.expectedStatus);
		assert.equal(latestState(mock.entries)?.activeImplementation, undefined);
	}
});

test("/plan start supersedes an active implementation without starting a model turn", async () => {
	const mock = createMockPi({ activeTools: ["read", "edit"] });
	planMode(mock.pi);
	const context = createMockContext();
	await mock.events.get("session_start")?.[0]?.({}, context.ctx);
	await mock.commands.get("plan")?.handler("start", context.ctx);
	const complete = mock.tools.find((candidate) => candidate.name === "plan_mode_complete")
		?.execute as ((...args: unknown[]) => Promise<unknown>) | undefined;
	assert.ok(complete);
	await complete("complete", { plan: PLAN }, undefined, undefined, context.ctx);
	await mock.commands.get("plan")?.handler("implement", context.ctx);
	const sentBeforeStart = mock.sentUserMessages.length;

	await mock.commands.get("plan")?.handler("start", context.ctx);

	assert.equal(context.statuses.get("plan-mode"), "plan active");
	assert.equal(latestState(mock.entries)?.activeImplementation, undefined);
	assert.equal(mock.sentUserMessages.length, sentBeforeStart);
});

test("starting a new Plan-mode workflow supersedes the active implementation", async () => {
	const mock = createMockPi({ activeTools: ["read", "edit"] });
	planMode(mock.pi);
	const context = createMockContext();
	await mock.events.get("session_start")?.[0]?.({}, context.ctx);
	await mock.commands.get("plan")?.handler("start", context.ctx);
	const complete = mock.tools.find((candidate) => candidate.name === "plan_mode_complete")
		?.execute as ((...args: unknown[]) => Promise<unknown>) | undefined;
	assert.ok(complete);
	await complete("complete", { plan: PLAN }, undefined, undefined, context.ctx);
	await mock.commands.get("plan")?.handler("implement", context.ctx);
	const oldHandoff = { role: "user", content: mock.sentUserMessages.at(-1)?.text };

	await mock.commands.get("plan")?.handler("design a replacement", context.ctx);
	assert.equal(context.statuses.get("plan-mode"), "plan active");
	assert.equal(latestState(mock.entries)?.activeImplementation, undefined);
	const contextHook = mock.events.get("context")?.[0];
	assert.ok(contextHook);
	const transformed = (await contextHook(
		{ messages: [oldHandoff, { role: "user", content: "design a replacement" }] },
		context.ctx,
	)) as { messages: Record<string, unknown>[] };
	assert.match(String(transformed.messages[0]?.content), /CONTRACT v1: PLAN/u);
	assert.deepEqual(transformed.messages.slice(1), [
		{ role: "user", content: "design a replacement" },
	]);
});

test("a superseded session start cannot publish stale settings or UI state", async () => {
	const settingsLoads: ReturnType<typeof deferred<{ kind: "missing" }>>[] = [];
	const mock = createMockPi({ activeTools: ["read", "edit"] });
	planMode(mock.pi, {
		readSettings: () => {
			const load = deferred<{ kind: "missing" }>();
			settingsLoads.push(load);
			return load.promise;
		},
	});
	const sessionStart = mock.events.get("session_start")?.[0];
	const contextHook = mock.events.get("context")?.[0];
	assert.ok(sessionStart);
	assert.ok(contextHook);
	const activeImplementation: ActiveImplementationPlan = {
		id: "implementation-1",
		plan: PLAN,
		source: "plan_mode_complete",
		startedAt: 42,
	};
	const staleContext = createMockContext({
		sessionManager: {
			getBranch: () => [
				stateEntry({ enabled: false, awaitingAction: false, activeImplementation }),
			],
			getEntries: () => [],
		},
	});
	const currentContext = createMockContext();

	const staleStart = sessionStart({}, staleContext.ctx) as Promise<void>;
	assert.equal(settingsLoads.length, 1);
	const currentStart = sessionStart({}, currentContext.ctx) as Promise<void>;
	assert.equal(settingsLoads.length, 2);
	settingsLoads[1]?.resolve({ kind: "missing" });
	await currentStart;
	settingsLoads[0]?.resolve({ kind: "missing" });
	await staleStart;

	assert.equal(staleContext.statuses.has("plan-mode"), false);
	assert.equal(staleContext.notifications.length, 0);
	assert.equal(currentContext.statuses.get("plan-mode"), undefined);
	const transformed = (await contextHook(
		{ messages: [{ role: "branchSummary", summary: "current session" }] },
		currentContext.ctx,
	)) as { messages: Record<string, unknown>[] };
	assert.deepEqual(transformed.messages, [{ role: "branchSummary", summary: "current session" }]);
});

test("resume and shutdown retain branch-local implementation state while clearing session UI", async () => {
	const activeImplementation: ActiveImplementationPlan = {
		id: "implementation-1",
		plan: PLAN,
		source: "plan_mode_complete",
		startedAt: 42,
	};
	const resumedEntry = stateEntry({
		enabled: false,
		awaitingAction: false,
		activeImplementation,
	});
	const mock = createMockPi({ activeTools: ["read", "edit"] });
	planMode(mock.pi);
	const context = createMockContext({
		sessionManager: {
			getBranch: () => [resumedEntry],
			getEntries: () => [resumedEntry],
		},
	});

	await mock.events.get("session_start")?.[0]?.({}, context.ctx);
	assert.equal(context.statuses.get("plan-mode"), "plan implementing");
	const contextHook = mock.events.get("context")?.[0];
	assert.ok(contextHook);
	const transformed = (await contextHook(
		{ messages: [{ role: "branchSummary", summary: "continued branch" }] },
		context.ctx,
	)) as { messages: Record<string, unknown>[] };
	assert.match(String(transformed.messages[1]?.content), /CONTRACT v1: NORMAL/u);
	assert.equal(transformed.messages[2]?.customType, "plan-mode-implementation-context");
	assert.match(String(transformed.messages[2]?.content), /PLAN-PERSIST-TEST-42/);

	await mock.events.get("session_shutdown")?.[0]?.({}, context.ctx);
	assert.equal(context.statuses.get("plan-mode"), undefined);
	assert.equal(context.widgets.get("plan-mode-plan"), undefined);
	assert.equal(latestState(mock.entries)?.activeImplementation?.plan, PLAN);
});
