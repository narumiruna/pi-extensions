import assert from "node:assert/strict";
import { mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { test } from "vitest";
import { planModeCompleted } from "../src/completion-tool.js";
import { FINALIZE_PLAN_PROMPT, RETRY_FINALIZE_PLAN_PROMPT } from "../src/finalization-request.js";
import planMode, {
	buildPlanModePrompt,
	completePlanArguments,
	extractProposedPlan,
	latestAssistantText,
	parseProposedPlan,
	stripProposedPlanBlocks,
	stripProposedPlanBlocksFromMessage,
} from "../src/plan-mode.js";
import { createMockContext, createMockPi } from "./support.js";
import { renderMockWidget } from "./widget-support.js";

test("plan-mode registers question tools, command, and safety hooks without a CLI flag", () => {
	const mock = createMockPi({ activeTools: ["read", "bash"] });
	planMode(mock.pi);

	assert.equal(mock.flags.has("plan"), false);
	assert.deepEqual(
		mock.tools.map((tool) => tool.name),
		["plan_mode_question", "plan_mode_complete"],
	);
	assert.ok(mock.commands.has("plan"));
	assert.equal(typeof mock.commands.get("plan")?.getArgumentCompletions, "function");
	assert.ok(mock.events.has("tool_call"));
	assert.ok(mock.events.has("before_agent_start"));
});

test("non-interactive Plan routes do not load interactive UI", async () => {
	const mock = createMockPi({ activeTools: ["read", "bash"] });
	let interactiveLoads = 0;
	planMode(mock.pi, {
		readSettings: async () => ({ kind: "missing" as const }),
		loadInteractiveUi: async () => {
			interactiveLoads += 1;
			return import("../src/interactive-ui.js");
		},
	});
	const context = createMockContext({ mode: "tui" });
	const sessionStart = mock.events.get("session_start")?.[0];
	assert.ok(sessionStart);
	await sessionStart({}, context.ctx);
	assert.equal(interactiveLoads, 0);

	const planCommand = mock.commands.get("plan");
	assert.ok(planCommand);
	await planCommand.handler("start", context.ctx);
	assert.equal(interactiveLoads, 0);
	await planCommand.handler("write a release plan", context.ctx);
	assert.equal(interactiveLoads, 0);
});

test("/plan settings opens in TUI and RPC and rejects print and JSON modes", async () => {
	const mock = createMockPi({ activeTools: ["read", "bash"] });
	let interactiveLoads = 0;
	const settingsModes: string[] = [];
	planMode(mock.pi, {
		readSettings: async () => ({ kind: "missing" as const }),
		loadInteractiveUi: async () => {
			interactiveLoads += 1;
			return {
				showPlanModeSettings: async (ctx: { mode: string }) => {
					settingsModes.push(ctx.mode);
					return { kind: "closed", reason: "close" } as const;
				},
			} as never;
		},
	});
	const planCommand = mock.commands.get("plan");
	assert.ok(planCommand);

	for (const mode of ["tui", "rpc"] as const) {
		const context = createMockContext({ mode, hasUI: true });
		await planCommand.handler("settings", context.ctx);
	}
	for (const mode of ["print", "json"] as const) {
		const context = createMockContext({ mode, hasUI: false });
		await assert.rejects(
			async () => planCommand.handler("settings", context.ctx),
			/requires TUI or RPC/u,
		);
	}

	assert.equal(interactiveLoads, 2);
	assert.deepEqual(settingsModes, ["tui", "rpc"]);
	assert.deepEqual(mock.rawPi.getActiveTools(), [
		"read",
		"bash",
		"plan_mode_question",
		"plan_mode_complete",
	]);
	assert.deepEqual(mock.entries, []);
});

test("stale Plan settings callbacks do not reload interactive UI", async () => {
	const mock = createMockPi({ activeTools: ["read", "bash"] });
	let interactiveLoads = 0;
	let showSettings: ((signal: AbortSignal) => Promise<boolean>) | undefined;
	planMode(mock.pi, {
		readSettings: async () => ({ kind: "missing" as const }),
		loadInteractiveUi: async () => {
			interactiveLoads += 1;
			return {
				showPlanLaunchMenu: async (_ctx: unknown, options: unknown) => {
					showSettings = (options as { settings(signal: AbortSignal): Promise<boolean> }).settings;
				},
			} as never;
		},
	});
	const context = createMockContext({ mode: "tui" });
	const planCommand = mock.commands.get("plan");
	assert.ok(planCommand);
	await planCommand.handler("", context.ctx);
	assert.equal(interactiveLoads, 1);
	assert.ok(showSettings);

	const sessionShutdown = mock.events.get("session_shutdown")?.[0];
	assert.ok(sessionShutdown);
	await sessionShutdown({}, context.ctx);
	await showSettings(new AbortController().signal);

	assert.equal(interactiveLoads, 1);
});

test("plan_mode_complete result renders the plan as Markdown", () => {
	initTheme("dark");
	const mock = createMockPi({ activeTools: ["read", "bash"] });
	planMode(mock.pi);
	const tool = mock.tools.find((candidate) => candidate.name === "plan_mode_complete");
	assert.equal(typeof tool?.renderResult, "function");

	const renderResult = tool?.renderResult as (
		result: unknown,
		options: unknown,
	) => { render(width: number): string[] };
	const ansiPattern = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");
	const renderMarkdown = (result: unknown) =>
		renderResult(result, { expanded: false, isPartial: false })
			.render(80)
			.map((line) => line.replace(ansiPattern, ""))
			.join("\n");

	const result = planModeCompleted("# Title\n\n- item\n\n```ts\nconst x = 1;\n```");
	const rendered = renderMarkdown(result);
	assert.match(rendered, /Proposed Plan/);
	assert.match(rendered, /const x = 1;/);
	assert.doesNotMatch(rendered, /\*\*Proposed Plan\*\*/);
	assert.doesNotMatch(rendered, /# Title/);

	const fallback = renderMarkdown({ content: [], details: result.details });
	assert.match(fallback, /Proposed Plan/);
	assert.match(fallback, /const x = 1;/);
});

test("completePlanArguments suggests management tokens only", () => {
	assert.deepEqual(
		completePlanArguments("")?.map((item) => item.label),
		[
			"start",
			"show",
			"finalize",
			"implement",
			"save",
			"settings",
			"export",
			"exit",
			"off",
			"tools",
		],
	);
	assert.deepEqual(
		completePlanArguments("to")?.map((item) => item.value),
		["tools"],
	);
	assert.equal(completePlanArguments("tools "), null);
	assert.equal(completePlanArguments("write a plan"), null);
	assert.equal(completePlanArguments("unknown"), null);
});

test("missing settings reset a previously loaded fixed thinking level", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-plan-mode-settings-reset-"));
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = directory;
	try {
		const settingsPath = join(directory, "pi-plan-mode.json");
		await writeFile(settingsPath, '{"thinkingLevel":"medium"}');
		const mock = createMockPi({ activeTools: ["read"], thinkingLevel: "low" });
		planMode(mock.pi);
		const context = createMockContext();
		await mock.events.get("session_start")?.[0]?.({}, context.ctx);
		await unlink(settingsPath);
		await mock.events.get("session_start")?.[0]?.({}, context.ctx);
		await mock.commands.get("plan")?.handler("start", context.ctx);
		assert.equal(mock.thinkingLevel, "low");
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		await rm(directory, { recursive: true, force: true });
	}
});

test("malformed persisted Plan state fails closed", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-plan-mode-malformed-state-"));
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = directory;
	try {
		const mock = createMockPi({ activeTools: ["read", "write"] });
		planMode(mock.pi);
		const malformedState = {
			type: "custom",
			customType: "plan-mode-state",
			data: {
				enabled: "yes",
				awaitingAction: 1,
				selectedToolNames: "read",
				previousThinkingLevel: "extreme",
			},
		};
		const context = createMockContext({
			sessionManager: {
				getBranch: () => [malformedState],
				getEntries: () => [malformedState],
			},
		});
		await mock.events.get("session_start")?.[0]?.({}, context.ctx);
		assert.equal(context.statuses.get("plan-mode"), undefined);
		assert.deepEqual(mock.rawPi.getActiveTools(), [
			"read",
			"write",
			"plan_mode_question",
			"plan_mode_complete",
		]);
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		await rm(directory, { recursive: true, force: true });
	}
});

test("inherit settings clear stale persisted thinking ownership", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-plan-mode-inherit-ownership-"));
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = directory;
	try {
		const mock = createMockPi({ activeTools: ["read"], thinkingLevel: "medium" });
		planMode(mock.pi);
		const inheritedState = {
			type: "custom",
			customType: "plan-mode-state",
			data: {
				enabled: true,
				awaitingAction: false,
				previousThinkingLevel: "low",
				appliedThinkingLevel: "medium",
			},
		};
		const context = createMockContext({
			sessionManager: {
				getBranch: () => [inheritedState],
				getEntries: () => [inheritedState],
			},
		});
		await mock.events.get("session_start")?.[0]?.({}, context.ctx);
		await mock.commands.get("plan")?.handler("exit", context.ctx);
		assert.equal(mock.thinkingLevel, "medium");
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		await rm(directory, { recursive: true, force: true });
	}
});

test("session resume restores active Plan state and required tools", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-plan-mode-resume-"));
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = directory;
	try {
		const mock = createMockPi({ activeTools: ["read", "write"] });
		planMode(mock.pi);
		const resumedState = {
			type: "custom",
			customType: "plan-mode-state",
			data: { enabled: true, awaitingAction: true, latestPlan: "# Resumed" },
		};
		const context = createMockContext({
			sessionManager: {
				getBranch: () => [resumedState],
				getEntries: () => [resumedState],
			},
		});
		await mock.events.get("session_start")?.[0]?.({}, context.ctx);
		assert.equal(context.statuses.get("plan-mode"), "plan ready");
		assert.deepEqual(mock.rawPi.getActiveTools(), [
			"read",
			"write",
			"plan_mode_question",
			"plan_mode_complete",
		]);
		await mock.events.get("session_shutdown")?.[0]?.({}, context.ctx);
		assert.deepEqual(mock.rawPi.getActiveTools(), [
			"read",
			"write",
			"plan_mode_question",
			"plan_mode_complete",
		]);
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		await rm(directory, { recursive: true, force: true });
	}
});

test("session restore fails closed when required Plan helpers are inactive", async () => {
	const restoredState = {
		type: "custom",
		customType: "plan-mode-state",
		data: { enabled: true, awaitingAction: false },
	};
	const mock = createMockPi({ activeTools: ["read"] });
	mock.rawPi.setActiveTools(["read"]);
	planMode(mock.pi);
	const context = createMockContext({
		hasUI: true,
		sessionManager: {
			getBranch: () => [restoredState],
			getEntries: () => [restoredState],
		},
	});

	await mock.events.get("session_start")?.[0]?.({ reason: "resume" }, context.ctx);
	assert.equal(context.statuses.get("plan-mode"), undefined);
	assert.deepEqual(mock.rawPi.getActiveTools(), ["read"]);
	assert.match(context.notifications.at(-1)?.message ?? "", /helper tools are unavailable/i);

	mock.rawPi.setActiveTools(["read", "plan_mode_question", "plan_mode_complete"]);
	await mock.commands.get("plan")?.handler("start", context.ctx);
	assert.equal(context.statuses.get("plan-mode"), "plan active");
});

test("session restore uses only the active branch state", async () => {
	const activeBranch = [
		{
			type: "custom",
			customType: "plan-mode-state",
			data: {
				enabled: true,
				awaitingAction: true,
				latestPlan: "# Active branch",
				latestPlanSource: "plan_mode_complete",
			},
		},
	];
	const mock = createMockPi({ activeTools: ["read"] });
	planMode(mock.pi);
	const context = createMockContext({
		sessionManager: {
			getBranch: () => activeBranch,
			getEntries: () => [
				...activeBranch,
				{
					type: "custom",
					customType: "plan-mode-state",
					data: { enabled: false, awaitingAction: false },
				},
			],
		},
	});
	await mock.events.get("session_start")?.[0]?.({}, context.ctx);
	await mock.commands.get("plan")?.handler("show", context.ctx);
	assert.equal(context.statuses.get("plan-mode"), "plan ready");
	assert.match(
		(mock.sentMessages.at(-1)?.message as { content?: string })?.content ?? "",
		/# Active branch/,
	);
});

test("session restore fails closed for malformed persisted completed plans", async () => {
	for (const data of [
		{
			enabled: true,
			awaitingAction: true,
			latestPlan: "  \n",
			latestPlanSource: "plan_mode_complete",
		},
		{
			enabled: true,
			awaitingAction: true,
			latestPlan: "x".repeat(50_001),
			latestPlanSource: "plan_mode_complete",
		},
	]) {
		const mock = createMockPi({ activeTools: ["read"] });
		planMode(mock.pi);
		const context = createMockContext({
			sessionManager: {
				getEntries: () => [],
				getBranch: () => [{ type: "custom", customType: "plan-mode-state", data }],
			},
		});
		await mock.events.get("session_start")?.[0]?.({}, context.ctx);
		assert.equal(context.statuses.get("plan-mode"), "plan active");
		await mock.commands.get("plan")?.handler("implement", context.ctx);
		assert.equal(mock.sentUserMessages.length, 0);
	}

	const legacy = createMockPi({ activeTools: ["read"] });
	planMode(legacy.pi);
	const legacyContext = createMockContext({
		sessionManager: {
			getEntries: () => [],
			getBranch: () => [
				{
					type: "custom",
					customType: "plan-mode-state",
					data: {
						enabled: true,
						awaitingAction: true,
						latestPlan: "# Legacy state",
					},
				},
			],
		},
	});
	await legacy.events.get("session_start")?.[0]?.({}, legacyContext.ctx);
	assert.equal(legacyContext.statuses.get("plan-mode"), "plan ready");
});

test("session restore recovers only valid completion details after the latest state", async () => {
	const completion = {
		type: "message",
		message: {
			role: "toolResult",
			toolName: "plan_mode_complete",
			details: {
				version: 1,
				source: "plan_mode_complete",
				plan: "# Recovered",
			},
		},
	};
	const mock = createMockPi({ activeTools: ["read"] });
	planMode(mock.pi);
	const context = createMockContext({
		sessionManager: {
			getEntries: () => [],
			getBranch: () => [
				{
					type: "custom",
					customType: "plan-mode-state",
					data: { enabled: true, awaitingAction: false },
				},
				completion,
			],
		},
	});
	await mock.events.get("session_start")?.[0]?.({}, context.ctx);
	assert.equal(context.statuses.get("plan-mode"), "plan ready");
	await mock.commands.get("plan")?.handler("show", context.ctx);
	assert.match(
		(mock.sentMessages.at(-1)?.message as { content?: string })?.content ?? "",
		/# Recovered/,
	);

	const discarded = createMockPi({ activeTools: ["read"] });
	planMode(discarded.pi);
	const discardedContext = createMockContext({
		sessionManager: {
			getEntries: () => [],
			getBranch: () => [
				completion,
				{
					type: "custom",
					customType: "plan-mode-state",
					data: { enabled: true, awaitingAction: false },
				},
			],
		},
	});
	await discarded.events.get("session_start")?.[0]?.({}, discardedContext.ctx);
	assert.equal(discardedContext.statuses.get("plan-mode"), "plan active");

	const malformed = createMockPi({ activeTools: ["read"] });
	planMode(malformed.pi);
	const malformedContext = createMockContext({
		sessionManager: {
			getEntries: () => [],
			getBranch: () => [
				{
					type: "custom",
					customType: "plan-mode-state",
					data: { enabled: true, awaitingAction: false },
				},
				{
					...completion,
					message: {
						...completion.message,
						details: { version: 2, source: "plan_mode_complete", plan: "# Bad" },
					},
				},
			],
		},
	});
	await malformed.events.get("session_start")?.[0]?.({}, malformedContext.ctx);
	assert.equal(malformedContext.statuses.get("plan-mode"), "plan active");
});

test("Plan thinking level restores only while the extension owns the applied value", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-plan-mode-agent-"));
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = directory;
	try {
		await writeFile(join(directory, "pi-plan-mode.json"), '{"thinkingLevel":"medium"}');
		const mock = createMockPi({ activeTools: ["read", "bash"], thinkingLevel: "low" });
		planMode(mock.pi);
		const context = createMockContext();
		await mock.events.get("session_start")?.[0]?.({}, context.ctx);
		await mock.commands.get("plan")?.handler("start", context.ctx);
		assert.equal(mock.thinkingLevel, "medium");
		await mock.commands.get("plan")?.handler("exit", context.ctx);
		assert.equal(mock.thinkingLevel, "low");

		await mock.commands.get("plan")?.handler("start", context.ctx);
		mock.rawPi.setThinkingLevel("high");
		await mock.commands.get("plan")?.handler("exit", context.ctx);
		assert.equal(mock.thinkingLevel, "high");

		const clamped = createMockPi({
			activeTools: ["read"],
			thinkingLevel: "high",
			clampThinkingLevel: (level) => (level === "medium" ? "low" : level),
		});
		planMode(clamped.pi);
		const clampedContext = createMockContext();
		await clamped.events.get("session_start")?.[0]?.({}, clampedContext.ctx);
		await clamped.commands.get("plan")?.handler("start", clampedContext.ctx);
		assert.equal(clamped.thinkingLevel, "low");
		await clamped.commands.get("plan")?.handler("exit", clampedContext.ctx);
		assert.equal(clamped.thinkingLevel, "high");
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		await rm(directory, { recursive: true, force: true });
	}
});

test("Plan activation adds only its helpers to an intentionally empty active-tool set", async () => {
	const mock = createMockPi({ activeTools: [], allTools: [] });
	planMode(mock.pi);
	const context = createMockContext();
	await mock.commands.get("plan")?.handler("start", context.ctx);
	assert.deepEqual(mock.rawPi.getActiveTools(), ["plan_mode_question", "plan_mode_complete"]);
	await mock.commands.get("plan")?.handler("exit", context.ctx);
	assert.deepEqual(mock.rawPi.getActiveTools(), ["plan_mode_question", "plan_mode_complete"]);
});

test("manual thinking changes survive active Plan-mode shutdown and resume", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-plan-mode-manual-resume-"));
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = directory;
	try {
		await writeFile(join(directory, "pi-plan-mode.json"), '{"thinkingLevel":"medium"}');
		const mock = createMockPi({ activeTools: ["read"], thinkingLevel: "low" });
		planMode(mock.pi);
		const context = createMockContext();
		await mock.events.get("session_start")?.[0]?.({}, context.ctx);
		await mock.commands.get("plan")?.handler("start", context.ctx);
		mock.rawPi.setThinkingLevel("high");
		await mock.events.get("session_shutdown")?.[0]?.({}, context.ctx);

		const persisted = mock.entries.at(-1);
		const persistedEntries = persisted ? [{ type: "custom", ...persisted }] : [];
		const resumedContext = createMockContext({
			sessionManager: {
				getBranch: () => persistedEntries,
				getEntries: () => persistedEntries,
			},
		});
		await mock.events.get("session_start")?.[0]?.({}, resumedContext.ctx);
		assert.equal(mock.thinkingLevel, "high");
		await mock.commands.get("plan")?.handler("exit", resumedContext.ctx);
		assert.equal(mock.thinkingLevel, "high");
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		await rm(directory, { recursive: true, force: true });
	}
});

test("Plan lifecycle enters with a prompt and hands a valid plan to implementation", async () => {
	const mock = createMockPi({ activeTools: ["read", "bash", "custom"] });
	planMode(mock.pi);
	const context = createMockContext({
		hasUI: true,
		select: async () => "Implement here",
	});
	await mock.commands.get("plan")?.handler("design it", context.ctx);
	assert.deepEqual(mock.sentUserMessages[0], { text: "design it", options: undefined });
	assert.deepEqual(mock.rawPi.getActiveTools(), [
		"read",
		"bash",
		"custom",
		"plan_mode_question",
		"plan_mode_complete",
	]);

	await mock.events.get("agent_end")?.[0]?.(
		{ messages: [{ role: "assistant", content: "<proposed_plan>\n# Ship it\n</proposed_plan>" }] },
		context.ctx,
	);
	assert.deepEqual(mock.rawPi.getActiveTools(), [
		"read",
		"bash",
		"custom",
		"plan_mode_question",
		"plan_mode_complete",
	]);
	await mock.events.get("agent_settled")?.[0]?.({}, context.ctx);
	assert.deepEqual(mock.rawPi.getActiveTools(), [
		"read",
		"bash",
		"custom",
		"plan_mode_question",
		"plan_mode_complete",
	]);
	assert.equal(mock.sentUserMessages.at(-1)?.text, "Implement the plan.");
	assert.equal(context.statuses.get("plan-mode"), undefined);
});

test("plan show displays only a stored plan without triggering a model turn", async () => {
	const mock = createMockPi({ activeTools: ["read"] });
	planMode(mock.pi);
	const context = createMockContext();
	await mock.commands.get("plan")?.handler("start", context.ctx);
	await mock.commands.get("plan")?.handler("show", context.ctx);
	assert.equal(mock.sentMessages.length, 1, "the hidden Plan contract is the only message");
	assert.equal(mock.sentUserMessages.length, 0);
	assert.match(context.notifications.at(-1)?.message ?? "", /No completed plan/i);

	const execute = mock.tools.find((candidate) => candidate.name === "plan_mode_complete")
		?.execute as ((...args: unknown[]) => Promise<unknown>) | undefined;
	assert.ok(execute);
	await execute("complete", { plan: "# Show me" }, undefined, undefined, context.ctx);
	await mock.commands.get("plan")?.handler("show", context.ctx);
	assert.equal(mock.sentMessages.length, 2);
	assert.equal(mock.sentUserMessages.length, 0);
	assert.match(
		(mock.sentMessages.at(-1)?.message as { content?: string })?.content ?? "",
		/# Show me/,
	);
});

test("plan show keeps a completed plan ready when display delivery fails", async () => {
	const mock = createMockPi({ activeTools: ["read"] });
	planMode(mock.pi);
	const context = createMockContext();
	await mock.commands.get("plan")?.handler("start", context.ctx);
	const execute = mock.tools.find((candidate) => candidate.name === "plan_mode_complete")
		?.execute as ((...args: unknown[]) => Promise<unknown>) | undefined;
	assert.ok(execute);
	await execute("complete", { plan: "# Still ready" }, undefined, undefined, context.ctx);
	mock.rawPi.sendMessage = () => {
		throw new Error("display unavailable");
	};

	await assert.doesNotReject(async () => {
		await mock.commands.get("plan")?.handler("show", context.ctx);
	});
	assert.equal(context.statuses.get("plan-mode"), "plan ready");
	assert.match(context.notifications.at(-1)?.message ?? "", /display unavailable/);
});

test("plan finalize requires active mode and uses idle-safe delivery", async () => {
	let idle = true;
	const mock = createMockPi({ activeTools: ["read"] });
	planMode(mock.pi);
	const context = createMockContext({ isIdle: () => idle });
	await mock.commands.get("plan")?.handler("finalize", context.ctx);
	assert.equal(mock.sentUserMessages.length, 0);
	assert.match(context.notifications.at(-1)?.message ?? "", /not active/i);

	await mock.commands.get("plan")?.handler("start", context.ctx);
	await mock.commands.get("plan")?.handler("finalize", context.ctx);
	assert.equal(mock.sentUserMessages.at(-1)?.text, FINALIZE_PLAN_PROMPT);
	assert.equal(mock.sentUserMessages.at(-1)?.options, undefined);

	idle = false;
	await mock.commands.get("plan")?.handler("finalize", context.ctx);
	assert.deepEqual(mock.sentUserMessages.at(-1)?.options, { deliverAs: "followUp" });
});

test("busy mode-changing commands fail closed while Plan follow-ups remain available", async () => {
	let idle = true;
	const mock = createMockPi({ activeTools: ["read", "write"], thinkingLevel: "low" });
	planMode(mock.pi, { readSettings: async () => ({ kind: "missing" as const }) });
	const context = createMockContext({
		mode: "tui",
		hasUI: true,
		isIdle: () => idle,
	});
	await mock.events.get("session_start")?.[0]?.({}, context.ctx);
	await mock.commands.get("plan")?.handler("start", context.ctx);
	const complete = mock.tools.find((candidate) => candidate.name === "plan_mode_complete")
		?.execute as ((...args: unknown[]) => Promise<unknown>) | undefined;
	assert.ok(complete);
	await complete("ready", { plan: "# Ready" }, undefined, undefined, context.ctx);

	idle = false;
	const snapshot = {
		entries: mock.entries.length,
		tools: mock.rawPi.getActiveTools(),
		thinking: mock.thinkingLevel,
		status: context.statuses.get("plan-mode"),
		messages: mock.sentUserMessages.length,
	};
	for (const command of ["exit", "save", "implement", "export busy-plan.md"]) {
		await mock.commands.get("plan")?.handler(command, context.ctx);
		assert.match(context.notifications.at(-1)?.message ?? "", /run is active.*retry/i);
		assert.equal(mock.entries.length, snapshot.entries);
		assert.deepEqual(mock.rawPi.getActiveTools(), snapshot.tools);
		assert.equal(mock.thinkingLevel, snapshot.thinking);
		assert.equal(context.statuses.get("plan-mode"), snapshot.status);
		assert.equal(mock.sentUserMessages.length, snapshot.messages);
	}

	await mock.commands.get("plan")?.handler("revise the ready plan", context.ctx);
	assert.equal(mock.sentUserMessages.at(-1)?.text, "revise the ready plan");
	assert.deepEqual(mock.sentUserMessages.at(-1)?.options, { deliverAs: "followUp" });
	await mock.commands.get("plan")?.handler("finalize", context.ctx);
	assert.equal(mock.sentUserMessages.at(-1)?.text, FINALIZE_PLAN_PROMPT);
	assert.deepEqual(mock.sentUserMessages.at(-1)?.options, { deliverAs: "followUp" });
});

test("busy inactive Plan starts fail observably without changing state in every command mode", async () => {
	for (const mode of ["tui", "rpc", "print", "json"] as const) {
		const mock = createMockPi({ activeTools: ["read", "write"] });
		planMode(mock.pi, { readSettings: async () => ({ kind: "missing" as const }) });
		const context = createMockContext({
			mode,
			hasUI: mode === "tui" || mode === "rpc",
			isIdle: () => false,
		});
		await mock.events.get("session_start")?.[0]?.({}, context.ctx);
		const command = mock.commands.get("plan");
		assert.ok(command);

		for (const input of ["start", "design a release"]) {
			if (mode === "tui" || mode === "rpc") {
				await command.handler(input, context.ctx);
				assert.match(context.notifications.at(-1)?.message ?? "", /run is active.*retry/i);
			} else {
				await assert.rejects(
					async () => command.handler(input, context.ctx),
					/run is active.*retry/i,
				);
			}
			assert.deepEqual(mock.rawPi.getActiveTools(), [
				"read",
				"write",
				"plan_mode_question",
				"plan_mode_complete",
			]);
			assert.equal(mock.entries.length, 0);
			assert.equal(mock.sentUserMessages.length, 0);
		}
	}
});

test("busy active Plan exits fail observably without releasing tools in every command mode", async () => {
	for (const mode of ["tui", "rpc", "print", "json"] as const) {
		let idle = true;
		const mock = createMockPi({ activeTools: ["read", "write"] });
		planMode(mock.pi, { readSettings: async () => ({ kind: "missing" as const }) });
		const context = createMockContext({
			mode,
			hasUI: mode === "tui" || mode === "rpc",
			isIdle: () => idle,
		});
		await mock.events.get("session_start")?.[0]?.({}, context.ctx);
		const command = mock.commands.get("plan");
		assert.ok(command);
		await command.handler("start", context.ctx);
		const entriesAfterStart = mock.entries.length;

		idle = false;
		if (mode === "tui" || mode === "rpc") {
			await command.handler("exit", context.ctx);
			assert.match(context.notifications.at(-1)?.message ?? "", /run is active.*retry/i);
		} else {
			await assert.rejects(
				async () => command.handler("exit", context.ctx),
				/run is active.*retry/i,
			);
		}
		assert.deepEqual(mock.rawPi.getActiveTools(), [
			"read",
			"write",
			"plan_mode_question",
			"plan_mode_complete",
		]);
		assert.equal(mock.entries.length, entriesAfterStart);
		assert.equal(context.statuses.get("plan-mode"), "plan active");
	}
});

test("explicit finalization retries once after settlement and then fails visibly", async () => {
	const mock = createMockPi({ activeTools: ["read"] });
	planMode(mock.pi);
	const context = createMockContext({ mode: "tui", hasUI: true });
	await mock.commands.get("plan")?.handler("start", context.ctx);
	await mock.commands.get("plan")?.handler("finalize", context.ctx);

	const agentEnd = mock.events.get("agent_end")?.[0];
	const agentSettled = mock.events.get("agent_settled")?.[0];
	assert.ok(agentEnd);
	assert.ok(agentSettled);
	await agentEnd(
		{ messages: [{ role: "assistant", content: "The tool is unavailable.", stopReason: "stop" }] },
		context.ctx,
	);
	await agentSettled({}, context.ctx);
	assert.equal(mock.sentUserMessages.at(-1)?.text, RETRY_FINALIZE_PLAN_PROMPT);
	assert.equal(mock.sentUserMessages.length, 2);

	await agentEnd(
		{ messages: [{ role: "assistant", content: "Still unavailable.", stopReason: "stop" }] },
		context.ctx,
	);
	await agentSettled({}, context.ctx);
	assert.equal(mock.sentUserMessages.length, 2);
	assert.match(context.notifications.at(-1)?.message ?? "", /ended twice/i);
	assert.equal(context.statuses.get("plan-mode"), "plan active");
});

test("structured finalization outcomes and cancellation suppress extension retries", async () => {
	for (const outcome of ["question", "complete", "aborted", "error", "ordinary"] as const) {
		const mock = createMockPi({ activeTools: ["read"] });
		planMode(mock.pi);
		const context = createMockContext();
		await mock.commands.get("plan")?.handler("start", context.ctx);
		if (outcome !== "ordinary") await mock.commands.get("plan")?.handler("finalize", context.ctx);

		if (outcome === "question") {
			const question = mock.tools.find((candidate) => candidate.name === "plan_mode_question")
				?.execute as ((...args: unknown[]) => Promise<unknown>) | undefined;
			assert.ok(question);
			await question(
				"question",
				{
					questions: [
						{
							id: "choice",
							header: "Choice",
							question: "Choose one?",
							options: [
								{ label: "A", description: "Choose A." },
								{ label: "B", description: "Choose B." },
							],
						},
					],
				},
				undefined,
				undefined,
				context.ctx,
			);
		}
		if (outcome === "complete") {
			const complete = mock.tools.find((candidate) => candidate.name === "plan_mode_complete")
				?.execute as ((...args: unknown[]) => Promise<unknown>) | undefined;
			assert.ok(complete);
			await complete("complete", { plan: "# Done" }, undefined, undefined, context.ctx);
		}

		await mock.events.get("agent_end")?.[0]?.(
			{
				messages: [
					{
						role: "assistant",
						content: "No structured result.",
						stopReason: outcome === "aborted" ? "aborted" : outcome === "error" ? "error" : "stop",
					},
				],
			},
			context.ctx,
		);
		await mock.events.get("agent_settled")?.[0]?.({}, context.ctx);
		assert.equal(mock.sentUserMessages.length, outcome === "ordinary" ? 0 : 1);
	}
});

test("exact canonical user prompt is tracked for one bounded retry", async () => {
	let pending = true;
	const mock = createMockPi({ activeTools: ["read"] });
	planMode(mock.pi);
	const context = createMockContext({ hasPendingMessages: () => pending });
	await mock.events.get("session_start")?.[0]?.({}, context.ctx);
	await mock.commands.get("plan")?.handler("start", context.ctx);
	await mock.events.get("message_start")?.[0]?.(
		{ message: { role: "user", content: FINALIZE_PLAN_PROMPT } },
		context.ctx,
	);
	await mock.events.get("agent_end")?.[0]?.(
		{ messages: [{ role: "assistant", content: "No tool.", stopReason: "stop" }] },
		context.ctx,
	);
	await mock.events.get("agent_settled")?.[0]?.({}, context.ctx);
	assert.equal(mock.sentUserMessages.length, 0);

	pending = false;
	await mock.events.get("agent_settled")?.[0]?.({}, context.ctx);
	assert.equal(mock.sentUserMessages.at(-1)?.text, RETRY_FINALIZE_PLAN_PROMPT);
});

test("session shutdown and explicit exit cancel pending finalization retries", async () => {
	for (const cancellation of ["shutdown", "exit"] as const) {
		const mock = createMockPi({ activeTools: ["read"] });
		planMode(mock.pi);
		const context = createMockContext();
		await mock.events.get("session_start")?.[0]?.({}, context.ctx);
		await mock.commands.get("plan")?.handler("start", context.ctx);
		await mock.commands.get("plan")?.handler("finalize", context.ctx);
		await mock.events.get("agent_end")?.[0]?.(
			{ messages: [{ role: "assistant", content: "No tool.", stopReason: "stop" }] },
			context.ctx,
		);
		if (cancellation === "shutdown") {
			await mock.events.get("session_shutdown")?.[0]?.({}, context.ctx);
		} else {
			await mock.commands.get("plan")?.handler("exit", context.ctx);
		}
		await mock.events.get("agent_settled")?.[0]?.({}, context.ctx);
		assert.equal(mock.sentUserMessages.length, 1);
	}
});

test("/plan start is a no-op while an active Plan workflow is already ready", async () => {
	const mock = createMockPi({ activeTools: ["read"] });
	planMode(mock.pi);
	const context = createMockContext();
	await mock.commands.get("plan")?.handler("start", context.ctx);
	const execute = mock.tools.find((candidate) => candidate.name === "plan_mode_complete")
		?.execute as ((...args: unknown[]) => Promise<unknown>) | undefined;
	assert.ok(execute);
	await execute("ready", { plan: "# Ready" }, undefined, undefined, context.ctx);
	const entriesBeforeStart = mock.entries.length;

	await mock.commands.get("plan")?.handler("start", context.ctx);

	assert.equal(context.statuses.get("plan-mode"), "plan ready");
	assert.equal(mock.entries.length, entriesBeforeStart);
	assert.equal(mock.sentUserMessages.length, 0);
	assert.match(context.notifications.at(-1)?.message ?? "", /already active/i);
});

test("plan implement fails closed without a plan and hands off a stored plan", async () => {
	const mock = createMockPi({ activeTools: ["read", "custom"] });
	planMode(mock.pi);
	const context = createMockContext();
	await mock.commands.get("plan")?.handler("start", context.ctx);
	await mock.commands.get("plan")?.handler("implement", context.ctx);
	assert.equal(context.statuses.get("plan-mode"), "plan active");
	assert.equal(mock.sentUserMessages.length, 0);
	assert.match(context.notifications.at(-1)?.message ?? "", /No completed plan/i);

	const execute = mock.tools.find((candidate) => candidate.name === "plan_mode_complete")
		?.execute as ((...args: unknown[]) => Promise<unknown>) | undefined;
	assert.ok(execute);
	await execute("complete", { plan: "# Implement me" }, undefined, undefined, context.ctx);
	await mock.commands.get("plan")?.handler("implement", context.ctx);
	assert.equal(context.statuses.get("plan-mode"), undefined);
	assert.deepEqual(mock.rawPi.getActiveTools(), [
		"read",
		"custom",
		"plan_mode_question",
		"plan_mode_complete",
	]);
	assert.equal(mock.sentUserMessages.at(-1)?.text, "Implement the plan.");
});

test("failed finalize delivery keeps Plan mode active", async () => {
	const mock = createMockPi({ activeTools: ["read"] });
	mock.rawPi.sendUserMessage = () => {
		throw new Error("Extension context is no longer active");
	};
	planMode(mock.pi);
	const context = createMockContext();
	await mock.commands.get("plan")?.handler("start", context.ctx);
	await mock.commands.get("plan")?.handler("finalize", context.ctx);
	assert.equal(context.statuses.get("plan-mode"), "plan active");
	assert.match(context.notifications.at(-1)?.message ?? "", /no longer active/);
});

test("inline prompt delivery failure rolls back newly entered Plan mode", async () => {
	const mock = createMockPi({ activeTools: ["read", "bash"] });
	mock.rawPi.sendUserMessage = () => {
		throw new Error("Extension context is no longer active");
	};
	planMode(mock.pi);
	const context = createMockContext();
	await mock.commands.get("plan")?.handler("design it", context.ctx);
	assert.equal(context.statuses.get("plan-mode"), undefined);
	assert.deepEqual(mock.rawPi.getActiveTools(), [
		"read",
		"bash",
		"plan_mode_question",
		"plan_mode_complete",
	]);
	assert.match(context.notifications.at(-1)?.message ?? "", /no longer active/);
});

test("failed activation contract and state commits preserve the stable helper envelope", async () => {
	for (const failure of ["contract", "state"] as const) {
		const mock = createMockPi({ activeTools: ["read"] });
		planMode(mock.pi);
		const context = createMockContext({ hasUI: true });
		await mock.events.get("session_start")?.[0]?.({ reason: "startup" }, context.ctx);
		assert.deepEqual(mock.rawPi.getActiveTools(), [
			"read",
			"plan_mode_question",
			"plan_mode_complete",
		]);

		if (failure === "contract") {
			mock.rawPi.sendMessage = () => {
				throw new Error("mock contract failure\u001b]52;c;payload\u0007");
			};
			await mock.commands.get("plan")?.handler("start", context.ctx);
			const message = context.notifications.at(-1)?.message ?? "";
			assert.equal(
				[...message].some((character) => {
					const code = character.charCodeAt(0);
					return code <= 31 || (code >= 127 && code <= 159);
				}),
				false,
			);
		} else {
			const appendEntry = mock.rawPi.appendEntry.bind(mock.rawPi);
			mock.rawPi.appendEntry = () => {
				throw new Error("mock state failure");
			};
			await assert.rejects(
				mock.commands.get("plan")?.handler("start", context.ctx) as Promise<unknown>,
				/mock state failure/,
			);
			mock.rawPi.appendEntry = appendEntry;
		}

		assert.deepEqual(mock.rawPi.getActiveTools(), [
			"read",
			"plan_mode_question",
			"plan_mode_complete",
		]);
		assert.equal(context.statuses.get("plan-mode"), undefined);
	}
});

test("invalid proposed plans remain unready and notify the user", async () => {
	const mock = createMockPi({ activeTools: ["read", "bash"] });
	planMode(mock.pi);
	const context = createMockContext();
	await mock.commands.get("plan")?.handler("start", context.ctx);
	await mock.events.get("agent_end")?.[0]?.(
		{ messages: [{ role: "assistant", content: "<proposed_plan>unfinished" }] },
		context.ctx,
	);
	assert.match(context.notifications.at(-1)?.message ?? "", /closing tag is missing/);
	assert.equal(context.statuses.get("plan-mode"), "plan active");
});

test("prose-only promise to present a plan remains active without false readiness", async () => {
	const mock = createMockPi({ activeTools: ["read", "bash"] });
	planMode(mock.pi);
	const context = createMockContext();
	await mock.commands.get("plan")?.handler("start", context.ctx);

	await mock.events.get("agent_end")?.[0]?.(
		{
			messages: [
				{
					role: "assistant",
					content: "Now I have a complete understanding. Let me present the plan.",
				},
			],
		},
		context.ctx,
	);

	assert.equal(context.statuses.get("plan-mode"), "plan active");
	assert.equal(mock.sentMessages.length, 1, "only the hidden Plan contract is published");
});

test("plan_mode_complete stores a visible terminating plan contract", async () => {
	const mock = createMockPi({ activeTools: ["read", "bash"] });
	planMode(mock.pi);
	const context = createMockContext();
	await mock.commands.get("plan")?.handler("start", context.ctx);

	const tool = mock.tools.find((candidate) => candidate.name === "plan_mode_complete");
	assert.ok(tool);
	const execute = tool.execute as
		| ((...args: unknown[]) => Promise<{
				content: Array<{ type: string; text: string }>;
				details?: { version?: number; plan?: string; source?: string };
				terminate?: boolean;
		  }>)
		| undefined;
	assert.ok(execute);

	const result = await execute(
		"call-complete",
		{ plan: "# Ship it\n\n## Test Plan\n\n- Run checks." },
		undefined,
		undefined,
		context.ctx,
	);
	assert.equal(result.terminate, true);
	assert.match(result.content[0]?.text ?? "", /# Ship it/);
	assert.deepEqual(result.details, {
		version: 1,
		source: "plan_mode_complete",
		plan: "# Ship it\n\n## Test Plan\n\n- Run checks.",
	});
	assert.equal(context.statuses.get("plan-mode"), "plan ready");
});

test("plan completion dispatches the ready menu once after agent_settled", async () => {
	let selectCalls = 0;
	const mock = createMockPi({ activeTools: ["read"] });
	planMode(mock.pi);
	const context = createMockContext({
		hasUI: true,
		select: async () => {
			selectCalls += 1;
			return "Stay in Plan mode";
		},
	});
	await mock.commands.get("plan")?.handler("start", context.ctx);
	const execute = mock.tools.find((candidate) => candidate.name === "plan_mode_complete")
		?.execute as ((...args: unknown[]) => Promise<unknown>) | undefined;
	assert.ok(execute);

	await execute("complete", { plan: "# Ready" }, undefined, undefined, context.ctx);
	assert.equal(selectCalls, 0);
	await mock.events.get("agent_settled")?.[0]?.({}, context.ctx);
	await mock.events.get("agent_settled")?.[0]?.({}, context.ctx);
	assert.equal(selectCalls, 1);
	assert.equal(mock.sentMessages.length, 1, "only the hidden Plan contract is published");
	assert.equal(context.statuses.get("plan-mode"), "plan ready");
});

test("legacy plan completion is presented once only after settlement", async () => {
	let selectCalls = 0;
	const mock = createMockPi({ activeTools: ["read"] });
	planMode(mock.pi);
	const context = createMockContext({
		hasUI: true,
		select: async () => {
			selectCalls += 1;
			return "Stay in Plan mode";
		},
	});
	await mock.commands.get("plan")?.handler("start", context.ctx);
	await mock.events.get("agent_end")?.[0]?.(
		{ messages: [{ role: "assistant", content: "<proposed_plan>\n# Legacy\n</proposed_plan>" }] },
		context.ctx,
	);
	assert.equal(selectCalls, 0);
	assert.equal(mock.sentMessages.length, 1, "only the hidden Plan contract is published");

	await mock.events.get("agent_settled")?.[0]?.({}, context.ctx);
	await mock.events.get("agent_settled")?.[0]?.({}, context.ctx);
	assert.equal(selectCalls, 1);
	assert.equal(mock.sentMessages.length, 2);
	assert.match(
		(mock.sentMessages.at(-1)?.message as { content?: string })?.content ?? "",
		/# Legacy/,
	);
});

test("settled plan presentation waits for idle without pending messages", async () => {
	let idle = true;
	let pending = false;
	let selectCalls = 0;
	const mock = createMockPi({ activeTools: ["read"] });
	planMode(mock.pi);
	const context = createMockContext({
		hasUI: true,
		isIdle: () => idle,
		hasPendingMessages: () => pending,
		select: async () => {
			selectCalls += 1;
			return "Stay in Plan mode";
		},
	});
	await mock.commands.get("plan")?.handler("start", context.ctx);
	const execute = mock.tools.find((candidate) => candidate.name === "plan_mode_complete")
		?.execute as ((...args: unknown[]) => Promise<unknown>) | undefined;
	assert.ok(execute);
	await execute("complete", { plan: "# Wait" }, undefined, undefined, context.ctx);

	idle = false;
	await mock.events.get("agent_settled")?.[0]?.({}, context.ctx);
	idle = true;
	pending = true;
	await mock.events.get("agent_settled")?.[0]?.({}, context.ctx);
	assert.equal(selectCalls, 0);
	pending = false;
	await mock.events.get("agent_settled")?.[0]?.({}, context.ctx);
	assert.equal(selectCalls, 1);
});

test("duplicate and replacement completions present only the latest plan once", async () => {
	let selectCalls = 0;
	const mock = createMockPi({ activeTools: ["read"] });
	planMode(mock.pi);
	const context = createMockContext({
		hasUI: true,
		select: async () => {
			selectCalls += 1;
			return "Stay in Plan mode";
		},
	});
	await mock.commands.get("plan")?.handler("start", context.ctx);
	const execute = mock.tools.find((candidate) => candidate.name === "plan_mode_complete")
		?.execute as ((...args: unknown[]) => Promise<unknown>) | undefined;
	assert.ok(execute);

	await execute("first", { plan: "# First" }, undefined, undefined, context.ctx);
	await execute("duplicate", { plan: "# First" }, undefined, undefined, context.ctx);
	await execute("replacement", { plan: "# Replacement" }, undefined, undefined, context.ctx);
	await mock.events.get("agent_settled")?.[0]?.({}, context.ctx);
	await mock.events.get("agent_settled")?.[0]?.({}, context.ctx);
	assert.equal(selectCalls, 1);
	assert.equal((mock.entries.at(-1)?.data as { latestPlan?: string })?.latestPlan, "# Replacement");
});

test("repeated legacy agent_end events produce one settled presentation", async () => {
	let selectCalls = 0;
	const mock = createMockPi({ activeTools: ["read"] });
	planMode(mock.pi);
	const context = createMockContext({
		hasUI: true,
		select: async () => {
			selectCalls += 1;
			return "Stay in Plan mode";
		},
	});
	await mock.commands.get("plan")?.handler("start", context.ctx);
	const event = {
		messages: [{ role: "assistant", content: "<proposed_plan>\n# Retry\n</proposed_plan>" }],
	};
	await mock.events.get("agent_end")?.[0]?.(event, context.ctx);
	await mock.events.get("agent_end")?.[0]?.(event, context.ctx);
	await mock.events.get("agent_settled")?.[0]?.({}, context.ctx);
	assert.equal(selectCalls, 1);
	assert.equal(mock.sentMessages.length, 2);
});

test("no-UI completion remains ready without opening or duplicating presentation", async () => {
	const mock = createMockPi({ activeTools: ["read"] });
	planMode(mock.pi);
	const context = createMockContext({ hasUI: false });
	await mock.commands.get("plan")?.handler("start", context.ctx);
	const execute = mock.tools.find((candidate) => candidate.name === "plan_mode_complete")
		?.execute as ((...args: unknown[]) => Promise<unknown>) | undefined;
	assert.ok(execute);
	await execute("complete", { plan: "# Headless" }, undefined, undefined, context.ctx);
	await mock.events.get("agent_settled")?.[0]?.({}, context.ctx);
	assert.equal(context.statuses.get("plan-mode"), "plan ready");
	assert.equal(mock.sentMessages.length, 1, "only the hidden Plan contract is published");
});

test("stale settled legacy presentation is ignored without losing ready state", async () => {
	const mock = createMockPi({ activeTools: ["read"] });
	const sendMessage = mock.rawPi.sendMessage.bind(mock.rawPi);
	mock.rawPi.sendMessage = (message, options) => {
		if ((message as { customType?: string }).customType === "proposed-plan") {
			throw new Error("This extension ctx is stale after session replacement or reload");
		}
		sendMessage(message, options);
	};
	planMode(mock.pi);
	const context = createMockContext({ hasUI: false });
	await mock.commands.get("plan")?.handler("start", context.ctx);
	await mock.events.get("agent_end")?.[0]?.(
		{
			messages: [{ role: "assistant", content: "<proposed_plan>\n# Persisted\n</proposed_plan>" }],
		},
		context.ctx,
	);
	await assert.doesNotReject(async () => {
		await mock.events.get("agent_settled")?.[0]?.({}, context.ctx);
	});
	assert.equal(context.statuses.get("plan-mode"), "plan ready");
});

test("a newer Plan turn cancels stale ready presentation", async () => {
	let selectCalls = 0;
	const mock = createMockPi({ activeTools: ["read"] });
	planMode(mock.pi);
	const context = createMockContext({
		hasUI: true,
		select: async () => {
			selectCalls += 1;
			return "Stay in Plan mode";
		},
	});
	await mock.commands.get("plan")?.handler("start", context.ctx);
	const execute = mock.tools.find((candidate) => candidate.name === "plan_mode_complete")
		?.execute as ((...args: unknown[]) => Promise<unknown>) | undefined;
	assert.ok(execute);
	await execute("complete", { plan: "# Stale" }, undefined, undefined, context.ctx);
	await mock.events.get("before_agent_start")?.[0]?.({ systemPrompt: "base" }, context.ctx);
	await mock.events.get("agent_settled")?.[0]?.({}, context.ctx);
	assert.equal(selectCalls, 0);
	assert.equal(context.statuses.get("plan-mode"), "plan active");
});

test("plan_mode_complete rejects inactive and invalid submissions", async () => {
	const mock = createMockPi({ activeTools: ["read"] });
	planMode(mock.pi);
	const context = createMockContext();
	const execute = mock.tools.find((candidate) => candidate.name === "plan_mode_complete")
		?.execute as ((...args: unknown[]) => Promise<unknown>) | undefined;
	assert.ok(execute);

	await assert.rejects(
		execute("inactive", { plan: "# Plan" }, undefined, undefined, context.ctx),
		/only available while Plan mode is active/,
	);
	await mock.commands.get("plan")?.handler("start", context.ctx);
	await assert.rejects(
		execute("empty", { plan: "  \n" }, undefined, undefined, context.ctx),
		/must not be empty/,
	);
	await assert.rejects(
		execute("large", { plan: "x".repeat(50_001) }, undefined, undefined, context.ctx),
		/must not exceed 50000 characters/,
	);
	assert.equal(context.statuses.get("plan-mode"), "plan active");
});

test("proposed-plan parser distinguishes valid and malformed output", () => {
	assert.deepEqual(parseProposedPlan("No plan"), { kind: "absent" });
	assert.deepEqual(parseProposedPlan("<proposed_plan>\n# Plan\n</proposed_plan>"), {
		kind: "valid",
		plan: "# Plan",
	});
	assert.equal(parseProposedPlan("<proposed_plan>\n\n</proposed_plan>").kind, "empty");
	assert.equal(
		parseProposedPlan("<proposed_plan>a</proposed_plan><proposed_plan>b</proposed_plan>").kind,
		"multiple",
	);
	assert.equal(parseProposedPlan("before <proposed_plan>bad</proposed_plan>").kind, "malformed");
	assert.equal(parseProposedPlan("<proposed_plan>unfinished").kind, "unclosed");
	assert.equal(parseProposedPlan("<PROPOSED_PLAN>\n# Plan\n</PROPOSED_PLAN>").kind, "malformed");
});

test("active Plan UI advertises the completion tool rather than legacy XML", async () => {
	const mock = createMockPi({ activeTools: ["read"] });
	planMode(mock.pi);
	let activeMenu = "";
	const context = createMockContext({
		hasUI: true,
		select: async (title: string) => {
			activeMenu = title;
			return undefined;
		},
	});
	await mock.commands.get("plan")?.handler("start", context.ctx);
	const widget = renderMockWidget(context.widgets.get("plan-mode-plan"));
	assert.equal(widget[0], "─".repeat(80));
	assert.match(widget.join("\n"), /plan_mode_complete/);
	assert.doesNotMatch(widget.join("\n"), /proposed_plan/);
	await mock.commands.get("plan")?.handler("", context.ctx);
	assert.match(activeMenu, /plan_mode_complete/);
	assert.doesNotMatch(activeMenu, /proposed_plan/);
});

test("inactive context discards completed-plan tool results", async () => {
	const mock = createMockPi({ activeTools: ["read"] });
	planMode(mock.pi);
	const context = createMockContext();
	const contextHook = mock.events.get("context")?.[0];
	assert.ok(contextHook);
	const assistantWithCalls = {
		role: "assistant",
		content: [
			{ type: "text", text: "keep explanation" },
			{ type: "toolCall", id: "plan-call", name: "plan_mode_complete", arguments: {} },
			{ type: "toolCall", id: "read-call", name: "read", arguments: {} },
		],
	};
	const assistantWithOnlyCompletion = {
		role: "assistant",
		content: [
			{ type: "toolCall", id: "only-plan-call", name: "plan_mode_complete", arguments: {} },
		],
	};
	const completionResult = {
		role: "toolResult",
		toolCallId: "plan-call",
		toolName: "plan_mode_complete",
		content: [{ type: "text", text: "**Proposed Plan**\n\n# Discarded" }],
		details: { version: 1, source: "plan_mode_complete", plan: "# Discarded" },
	};
	const unrelatedResult = {
		role: "toolResult",
		toolCallId: "read-call",
		toolName: "read",
		content: [{ type: "text", text: "keep me" }],
	};
	const allMessages = [
		assistantWithCalls,
		assistantWithOnlyCompletion,
		completionResult,
		unrelatedResult,
	];

	const inactive = (await contextHook({ messages: allMessages }, context.ctx)) as {
		messages: unknown[];
	};
	assert.deepEqual(inactive.messages, [
		{
			...assistantWithCalls,
			content: [assistantWithCalls.content[0], assistantWithCalls.content[2]],
		},
		unrelatedResult,
	]);

	await mock.commands.get("plan")?.handler("start", context.ctx);
	const active = (await contextHook({ messages: allMessages }, context.ctx)) as {
		messages: unknown[];
	};
	assert.equal((active.messages[0] as { customType?: string }).customType, "plan-mode-transition");
	assert.match(JSON.stringify(active.messages[0]), /CONTRACT v1: PLAN/u);
	assert.deepEqual(active.messages.slice(1), allMessages);
});

test("Plan prompt requires the standalone completion contract", () => {
	const prompt = buildPlanModePrompt();
	assert.match(prompt, /recommended option.*assumption/i);
	assert.match(prompt, /plan_mode_complete/i);
	assert.match(prompt, /alone as (?:your )?(?:final|last) action/i);
	assert.match(prompt, /end.*plan_mode_question.*plan_mode_complete/is);
	assert.match(prompt, /clarification.*plan_mode_complete.*unchanged/is);
	assert.match(prompt, /listed in the current request's active tools/i);
	assert.match(prompt, /actual error/i);
	assert.match(prompt, /behavior-level/i);
	assert.doesNotMatch(prompt, /<proposed_plan>/i);
});

test("proposed-plan helpers extract and remove plan blocks", () => {
	assert.equal(extractProposedPlan("Intro\n<proposed_plan>\n# Plan\n</proposed_plan>"), "# Plan");
	assert.equal(
		stripProposedPlanBlocks("A\n<proposed_plan>\nsecret\n</proposed_plan>\nB"),
		"A\n\nB",
	);
	assert.equal(
		stripProposedPlanBlocks("A<proposed_plan>malformed</proposed_plan>B"),
		"A<proposed_plan>malformed</proposed_plan>B",
	);
	assert.deepEqual(
		stripProposedPlanBlocksFromMessage({
			role: "assistant",
			content: [{ type: "text", text: "Keep\n<proposed_plan>\nremove\n</proposed_plan>" }],
		}),
		{ role: "assistant", content: [{ type: "text", text: "Keep\n" }] },
	);
	assert.equal(
		latestAssistantText([
			{ role: "user", content: "ignore" },
			{ message: { role: "assistant", content: [{ type: "text", text: "answer" }] } },
		]),
		"answer",
	);
});
