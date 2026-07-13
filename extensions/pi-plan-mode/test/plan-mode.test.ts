import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	builtinTool,
	createMockContext,
	createMockPi,
	extensionTool,
} from "../../../test/support.js";
import planMode, {
	buildPlanModePrompt,
	canSelectToolInPlanMode,
	classifyPlanModeTool,
	completePlanArguments,
	extractProposedPlan,
	isSafeCommand,
	latestAssistantText,
	normalizePlanModeQuestionParams,
	normalizePlanModeSettings,
	parseProposedPlan,
	readPlanModeSettings,
	stripProposedPlanBlocks,
	stripProposedPlanBlocksFromMessage,
	withoutPlanModeQuestionTool,
	withRequiredPlanModeTools,
} from "../src/plan-mode.js";

test("plan-mode registers flag, question tool, command, and safety hooks", () => {
	const mock = createMockPi({ activeTools: ["read", "bash"] });
	planMode(mock.pi);

	assert.ok(mock.flags.has("plan"));
	assert.deepEqual(
		mock.tools.map((tool) => tool.name),
		["plan_mode_question", "plan_mode_complete"],
	);
	assert.ok(mock.commands.has("plan"));
	assert.equal(typeof mock.commands.get("plan")?.getArgumentCompletions, "function");
	assert.ok(mock.events.has("tool_call"));
	assert.ok(mock.events.has("before_agent_start"));
});

test("completePlanArguments suggests management tokens only", () => {
	assert.deepEqual(
		completePlanArguments("")?.map((item) => item.label),
		["show", "finalize", "implement", "exit", "off", "tools"],
	);
	assert.deepEqual(
		completePlanArguments("to")?.map((item) => item.value),
		["tools"],
	);
	assert.equal(completePlanArguments("tools "), null);
	assert.equal(completePlanArguments("write a plan"), null);
	assert.equal(completePlanArguments("unknown"), null);
});

test("tool selection allows safe built-ins and non-built-ins only", () => {
	type PlanTool = Parameters<typeof canSelectToolInPlanMode>[0];
	assert.equal(canSelectToolInPlanMode(builtinTool("read") as PlanTool), true);
	assert.equal(canSelectToolInPlanMode(builtinTool("edit") as PlanTool), false);
	assert.equal(canSelectToolInPlanMode(extensionTool("custom") as PlanTool), true);
	assert.equal(canSelectToolInPlanMode(extensionTool("edit") as PlanTool), true);
	assert.deepEqual(withRequiredPlanModeTools(["read", "plan_mode_question", "read"]), [
		"read",
		"plan_mode_question",
		"plan_mode_complete",
	]);
	assert.deepEqual(withoutPlanModeQuestionTool(["read", "plan_mode_question"]), ["read"]);
});

test("isSafeCommand permits read-only command lists and rejects shell mutation", () => {
	for (const command of [
		"git status --short && git diff --check",
		"git branch --show-current",
		"git remote get-url origin",
		"rg -n 'plan' src | head -20",
		"npm test -- --help",
		"npm run typecheck",
		"cargo test --no-run",
		"sed -n '1,20p' file.ts",
	]) {
		assert.equal(isSafeCommand(command), true, command);
	}
	for (const command of [
		"rm -rf build",
		"npm install",
		"echo $(rm file)",
		"cat file > copy",
		"git status; touch file",
		"cat file & touch file",
		"find . -delete",
		"find . -exec rm {} ;",
		"sed -i 's/a/b/' file",
		"sed -ni 's/a/b/' file",
		"sed -n 'w output' input",
		"sed -n 'e touch output' input",
		"uniq input output",
		"diff left right --output=diff.txt",
		"sort --compress-program='touch output' input",
		"sort -T /tmp input",
		"git grep --open-files-in-pager='sh -c touch output' pattern",
		"git grep -O'sh -c touch output' pattern",
		"git grep -O 'sh -c touch output' pattern",
		"git branch -D old",
		"git branch --unset-upstream",
		"git branch --set-upstream-to=origin/main",
		"git remote add origin url",
		"git remote set-head origin -a",
		"git remote set-branches origin main",
		"npm audit --fix",
		"npm audit fix",
		"env sh -c 'touch file'",
		"date --set tomorrow",
		"sort input -o output",
		"sort -o/tmp/output input",
		"tree -o output",
		"find . -fprint output",
		"find . -fprint0 output",
		"fd pattern --exec touch file",
		"fd pattern -x rm {}",
		"rg pattern --pre 'touch file'",
		"bat file --pager 'sh -c touch file'",
		"git diff --ext-diff",
		"git log --output=log.txt",
		"git remote update",
		"tsc --noEmit --incremental --tsBuildInfoFile info.tsbuildinfo",
		"tsc --noEmit --generateTrace trace",
		"go build ./cmd/app",
		"cargo build",
		"npm run build",
		"awk 'BEGIN { system(\"touch file\") }'",
		"rg x || (echo bad > file)",
		"cat <<EOF",
		"unknown-command --dry-run",
		"",
	]) {
		assert.equal(isSafeCommand(command), false, command);
	}
});

test("tool policy classifies built-ins and extension tools consistently", () => {
	type PlanTool = Parameters<typeof classifyPlanModeTool>[0];
	assert.equal(classifyPlanModeTool(builtinTool("read") as PlanTool), "read-only");
	assert.equal(classifyPlanModeTool(builtinTool("bash") as PlanTool), "limited");
	assert.equal(classifyPlanModeTool(builtinTool("write") as PlanTool), "blocked");
	assert.equal(classifyPlanModeTool(extensionTool("custom") as PlanTool), "user-opt-in");
});

test("active Plan mode blocks update_plan and blocked built-ins at the tool hook", async () => {
	const mock = createMockPi({
		activeTools: ["read", "bash", "update_plan", "danger"],
		allTools: [
			builtinTool("read"),
			builtinTool("bash"),
			builtinTool("danger"),
			extensionTool("edit"),
		],
	});
	planMode(mock.pi);
	const context = createMockContext();
	await mock.commands.get("plan")?.handler("", context.ctx);
	const hook = mock.events.get("tool_call")?.[0];
	const blocked = await hook?.({ toolName: "update_plan", input: {} }, context.ctx);
	const blockedBuiltin = await hook?.({ toolName: "danger", input: {} }, context.ctx);
	const allowed = await hook?.({ toolName: "read", input: {} }, context.ctx);
	const optedInExtension = await hook?.({ toolName: "edit", input: {} }, context.ctx);
	assert.deepEqual(blocked, {
		block: true,
		reason:
			"Plan mode blocks update_plan because it tracks execution progress rather than conversational planning.",
	});
	assert.deepEqual(blockedBuiltin, {
		block: true,
		reason: "Plan mode blocks built-in tool 'danger' because its policy class is blocked.",
	});
	assert.equal(allowed, undefined);
	assert.equal(optedInExtension, undefined);
});

test("plan_mode_question reports non-interactive cancellation", async () => {
	const mock = createMockPi();
	planMode(mock.pi);
	const execute = mock.tools[0]?.execute as
		| ((...args: unknown[]) => Promise<{ details?: { reason?: string } }>)
		| undefined;
	assert.ok(execute);
	const context = createMockContext({ hasUI: false });
	await mock.commands.get("plan")?.handler("", context.ctx);
	const result = await execute(
		"call-1",
		{
			questions: [
				{
					id: "scope",
					header: "Scope",
					question: "How broad?",
					options: [
						{ label: "Small", description: "Only the bug." },
						{ label: "Broad", description: "Include cleanup." },
					],
				},
			],
		},
		undefined,
		undefined,
		context.ctx,
	);
	assert.equal(result.details?.reason, "ui_unavailable");
});

test("normalizePlanModeQuestionParams validates question shape", () => {
	const result = normalizePlanModeQuestionParams({
		questions: [
			{
				id: "scope",
				header: "Scope",
				question: "How broad?",
				options: [
					{ label: "Small", description: "Only the bug." },
					{ label: "Broad", description: "Include nearby cleanup." },
				],
			},
		],
	});

	assert.equal(result.ok, true);
	if (result.ok) assert.equal(result.questions[0]?.options[1]?.label, "Broad");
	assert.deepEqual(normalizePlanModeQuestionParams({ questions: [] }), {
		ok: false,
		error: "questions must contain 1-3 items",
	});
});

test("Plan-mode settings validate inherit and fixed thinking levels", async () => {
	assert.deepEqual(normalizePlanModeSettings({}), { thinkingLevel: "inherit" });
	assert.deepEqual(normalizePlanModeSettings({ thinkingLevel: "medium" }), {
		thinkingLevel: "medium",
	});
	assert.deepEqual(normalizePlanModeSettings({ thinkingLevel: "max" }), {
		thinkingLevel: "max",
	});
	assert.equal(normalizePlanModeSettings({ thinkingLevel: "extreme" }), undefined);

	const directory = await mkdtemp(join(tmpdir(), "pi-plan-mode-test-"));
	try {
		const path = join(directory, "pi-plan-mode.json");
		await writeFile(path, '{"thinkingLevel":"high"}');
		assert.deepEqual(await readPlanModeSettings(path), {
			kind: "loaded",
			settings: { thinkingLevel: "high" },
		});
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("Plan-mode settings migrate to the canonical package filename", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-plan-mode-migration-"));
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = directory;
	try {
		await writeFile(
			join(directory, "plan-mode.json"),
			'{"thinkingLevel":"high","futureOption":true}',
		);
		const loaded = await readPlanModeSettings();
		assert.equal(loaded.kind, "loaded");
		assert.match(loaded.notice ?? "", /migrated/i);
		assert.deepEqual(JSON.parse(await readFile(join(directory, "pi-plan-mode.json"), "utf8")), {
			thinkingLevel: "high",
			futureOption: true,
		});
		await assert.rejects(access(join(directory, "plan-mode.json")));

		await writeFile(join(directory, "plan-mode.json"), '{"thinkingLevel":"low"}');
		await writeFile(join(directory, "pi-plan-mode.json"), '{"thinkingLevel":"medium"}');
		const preferred = await readPlanModeSettings();
		assert.deepEqual(preferred.kind === "loaded" ? preferred.settings : undefined, {
			thinkingLevel: "medium",
		});
		assert.match(preferred.notice ?? "", /ignored/i);

		await writeFile(join(directory, "pi-plan-mode.json"), "invalid");
		const invalid = await readPlanModeSettings();
		assert.equal(invalid.kind, "invalid");
		assert.equal(
			await readFile(join(directory, "plan-mode.json"), "utf8"),
			'{"thinkingLevel":"low"}',
		);

		await unlink(join(directory, "pi-plan-mode.json"));
		await writeFile(join(directory, "plan-mode.json"), "invalid");
		assert.equal((await readPlanModeSettings()).kind, "invalid");
		await assert.rejects(access(join(directory, "pi-plan-mode.json")));

		await writeFile(join(directory, "plan-mode.json"), '{"thinkingLevel":"high"}');
		await symlink("missing-target", join(directory, "pi-plan-mode.json"));
		const fallback = await readPlanModeSettings();
		assert.deepEqual(fallback.kind === "loaded" ? fallback.settings : undefined, {
			thinkingLevel: "high",
		});
		assert.match(fallback.notice ?? "", /migration failed/i);
		assert.equal(
			await readFile(join(directory, "plan-mode.json"), "utf8"),
			'{"thinkingLevel":"high"}',
		);
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		await rm(directory, { recursive: true, force: true });
	}
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
		await mock.commands.get("plan")?.handler("", context.ctx);
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
		assert.deepEqual(mock.rawPi.getActiveTools(), ["read", "write"]);
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
			"plan_mode_question",
			"plan_mode_complete",
		]);
		await mock.events.get("session_shutdown")?.[0]?.({}, context.ctx);
		assert.deepEqual(mock.rawPi.getActiveTools(), ["read", "write"]);
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		await rm(directory, { recursive: true, force: true });
	}
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
		await mock.commands.get("plan")?.handler("", context.ctx);
		assert.equal(mock.thinkingLevel, "medium");
		await mock.commands.get("plan")?.handler("exit", context.ctx);
		assert.equal(mock.thinkingLevel, "low");

		await mock.commands.get("plan")?.handler("", context.ctx);
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
		await clamped.commands.get("plan")?.handler("", clampedContext.ctx);
		assert.equal(clamped.thinkingLevel, "low");
		await clamped.commands.get("plan")?.handler("exit", clampedContext.ctx);
		assert.equal(clamped.thinkingLevel, "high");
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		await rm(directory, { recursive: true, force: true });
	}
});

test("Plan mode restores an intentionally empty active-tool set", async () => {
	const mock = createMockPi({ activeTools: [], allTools: [] });
	planMode(mock.pi);
	const context = createMockContext();
	await mock.commands.get("plan")?.handler("", context.ctx);
	assert.deepEqual(mock.rawPi.getActiveTools(), [
		"read",
		"bash",
		"plan_mode_question",
		"plan_mode_complete",
	]);
	await mock.commands.get("plan")?.handler("exit", context.ctx);
	assert.deepEqual(mock.rawPi.getActiveTools(), []);
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
		await mock.commands.get("plan")?.handler("", context.ctx);
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
		select: async () => "Implement this plan",
	});
	await mock.commands.get("plan")?.handler("design it", context.ctx);
	assert.deepEqual(mock.sentUserMessages[0], { text: "design it", options: undefined });
	assert.deepEqual(mock.rawPi.getActiveTools(), [
		"bash",
		"read",
		"plan_mode_question",
		"plan_mode_complete",
	]);

	await mock.events.get("agent_end")?.[0]?.(
		{ messages: [{ role: "assistant", content: "<proposed_plan>\n# Ship it\n</proposed_plan>" }] },
		context.ctx,
	);
	assert.deepEqual(mock.rawPi.getActiveTools(), [
		"bash",
		"read",
		"plan_mode_question",
		"plan_mode_complete",
	]);
	await mock.events.get("agent_settled")?.[0]?.({}, context.ctx);
	assert.deepEqual(mock.rawPi.getActiveTools(), ["read", "bash", "custom"]);
	assert.match(
		mock.sentUserMessages.at(-1)?.text ?? "",
		/Implement this proposed plan now:\n\n# Ship it/,
	);
	assert.equal(context.statuses.get("plan-mode"), undefined);
});

test("plan show displays only a stored plan without triggering a model turn", async () => {
	const mock = createMockPi({ activeTools: ["read"] });
	planMode(mock.pi);
	const context = createMockContext();
	await mock.commands.get("plan")?.handler("", context.ctx);
	await mock.commands.get("plan")?.handler("show", context.ctx);
	assert.equal(mock.sentMessages.length, 0);
	assert.equal(mock.sentUserMessages.length, 0);
	assert.match(context.notifications.at(-1)?.message ?? "", /No completed plan/i);

	const execute = mock.tools.find((candidate) => candidate.name === "plan_mode_complete")
		?.execute as ((...args: unknown[]) => Promise<unknown>) | undefined;
	assert.ok(execute);
	await execute("complete", { plan: "# Show me" }, undefined, undefined, context.ctx);
	await mock.commands.get("plan")?.handler("show", context.ctx);
	assert.equal(mock.sentMessages.length, 1);
	assert.equal(mock.sentUserMessages.length, 0);
	assert.match((mock.sentMessages[0]?.message as { content?: string })?.content ?? "", /# Show me/);
});

test("plan show keeps a completed plan ready when display delivery fails", async () => {
	const mock = createMockPi({ activeTools: ["read"] });
	planMode(mock.pi);
	const context = createMockContext();
	await mock.commands.get("plan")?.handler("", context.ctx);
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

	await mock.commands.get("plan")?.handler("", context.ctx);
	await mock.commands.get("plan")?.handler("finalize", context.ctx);
	assert.match(mock.sentUserMessages.at(-1)?.text ?? "", /plan_mode_complete/);
	assert.equal(mock.sentUserMessages.at(-1)?.options, undefined);

	idle = false;
	await mock.commands.get("plan")?.handler("finalize", context.ctx);
	assert.deepEqual(mock.sentUserMessages.at(-1)?.options, { deliverAs: "followUp" });
});

test("plan implement fails closed without a plan and hands off a stored plan", async () => {
	const mock = createMockPi({ activeTools: ["read", "custom"] });
	planMode(mock.pi);
	const context = createMockContext();
	await mock.commands.get("plan")?.handler("", context.ctx);
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
	assert.deepEqual(mock.rawPi.getActiveTools(), ["read", "custom"]);
	assert.match(mock.sentUserMessages.at(-1)?.text ?? "", /# Implement me/);
});

test("failed implementation delivery restores the completed plan and required tools", async () => {
	const mock = createMockPi({ activeTools: ["read", "custom"] });
	planMode(mock.pi);
	const context = createMockContext();
	await mock.commands.get("plan")?.handler("", context.ctx);
	const execute = mock.tools.find((candidate) => candidate.name === "plan_mode_complete")
		?.execute as ((...args: unknown[]) => Promise<unknown>) | undefined;
	assert.ok(execute);
	await execute("complete", { plan: "# Retry later" }, undefined, undefined, context.ctx);
	mock.rawPi.sendUserMessage = () => {
		throw new Error("handoff failed");
	};

	await mock.commands.get("plan")?.handler("implement", context.ctx);
	assert.equal(context.statuses.get("plan-mode"), "plan ready");
	assert.deepEqual(mock.rawPi.getActiveTools(), [
		"read",
		"plan_mode_question",
		"plan_mode_complete",
	]);
	assert.equal((mock.entries.at(-1)?.data as { latestPlan?: string })?.latestPlan, "# Retry later");
	assert.match(context.notifications.at(-1)?.message ?? "", /handoff failed/);
});

test("failed finalize delivery keeps Plan mode active", async () => {
	const mock = createMockPi({ activeTools: ["read"] });
	mock.rawPi.sendUserMessage = () => {
		throw new Error("Extension context is no longer active");
	};
	planMode(mock.pi);
	const context = createMockContext();
	await mock.commands.get("plan")?.handler("", context.ctx);
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
	assert.deepEqual(mock.rawPi.getActiveTools(), ["read", "bash"]);
	assert.match(context.notifications.at(-1)?.message ?? "", /no longer active/);
});

test("invalid proposed plans remain unready and notify the user", async () => {
	const mock = createMockPi({ activeTools: ["read", "bash"] });
	planMode(mock.pi);
	const context = createMockContext();
	await mock.commands.get("plan")?.handler("", context.ctx);
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
	await mock.commands.get("plan")?.handler("", context.ctx);

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
	assert.equal(mock.sentMessages.length, 0);
});

test("plan_mode_complete stores a visible terminating plan contract", async () => {
	const mock = createMockPi({ activeTools: ["read", "bash"] });
	planMode(mock.pi);
	const context = createMockContext();
	await mock.commands.get("plan")?.handler("", context.ctx);

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
	await mock.commands.get("plan")?.handler("", context.ctx);
	const execute = mock.tools.find((candidate) => candidate.name === "plan_mode_complete")
		?.execute as ((...args: unknown[]) => Promise<unknown>) | undefined;
	assert.ok(execute);

	await execute("complete", { plan: "# Ready" }, undefined, undefined, context.ctx);
	assert.equal(selectCalls, 0);
	await mock.events.get("agent_settled")?.[0]?.({}, context.ctx);
	await mock.events.get("agent_settled")?.[0]?.({}, context.ctx);
	assert.equal(selectCalls, 1);
	assert.equal(mock.sentMessages.length, 0);
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
	await mock.commands.get("plan")?.handler("", context.ctx);
	await mock.events.get("agent_end")?.[0]?.(
		{ messages: [{ role: "assistant", content: "<proposed_plan>\n# Legacy\n</proposed_plan>" }] },
		context.ctx,
	);
	assert.equal(selectCalls, 0);
	assert.equal(mock.sentMessages.length, 0);

	await mock.events.get("agent_settled")?.[0]?.({}, context.ctx);
	await mock.events.get("agent_settled")?.[0]?.({}, context.ctx);
	assert.equal(selectCalls, 1);
	assert.equal(mock.sentMessages.length, 1);
	assert.match((mock.sentMessages[0]?.message as { content?: string })?.content ?? "", /# Legacy/);
});

test("settled plan presentation waits for idle without pending messages", async () => {
	let idle = false;
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
	await mock.commands.get("plan")?.handler("", context.ctx);
	const execute = mock.tools.find((candidate) => candidate.name === "plan_mode_complete")
		?.execute as ((...args: unknown[]) => Promise<unknown>) | undefined;
	assert.ok(execute);
	await execute("complete", { plan: "# Wait" }, undefined, undefined, context.ctx);

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
	await mock.commands.get("plan")?.handler("", context.ctx);
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
	await mock.commands.get("plan")?.handler("", context.ctx);
	const event = {
		messages: [{ role: "assistant", content: "<proposed_plan>\n# Retry\n</proposed_plan>" }],
	};
	await mock.events.get("agent_end")?.[0]?.(event, context.ctx);
	await mock.events.get("agent_end")?.[0]?.(event, context.ctx);
	await mock.events.get("agent_settled")?.[0]?.({}, context.ctx);
	assert.equal(selectCalls, 1);
	assert.equal(mock.sentMessages.length, 1);
});

test("no-UI completion remains ready without opening or duplicating presentation", async () => {
	const mock = createMockPi({ activeTools: ["read"] });
	planMode(mock.pi);
	const context = createMockContext({ hasUI: false });
	await mock.commands.get("plan")?.handler("", context.ctx);
	const execute = mock.tools.find((candidate) => candidate.name === "plan_mode_complete")
		?.execute as ((...args: unknown[]) => Promise<unknown>) | undefined;
	assert.ok(execute);
	await execute("complete", { plan: "# Headless" }, undefined, undefined, context.ctx);
	await mock.events.get("agent_settled")?.[0]?.({}, context.ctx);
	assert.equal(context.statuses.get("plan-mode"), "plan ready");
	assert.equal(mock.sentMessages.length, 0);
});

test("stale settled legacy presentation is ignored without losing ready state", async () => {
	const mock = createMockPi({ activeTools: ["read"] });
	mock.rawPi.sendMessage = () => {
		throw new Error("This extension ctx is stale after session replacement or reload");
	};
	planMode(mock.pi);
	const context = createMockContext({ hasUI: false });
	await mock.commands.get("plan")?.handler("", context.ctx);
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
	await mock.commands.get("plan")?.handler("", context.ctx);
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
	await mock.commands.get("plan")?.handler("", context.ctx);
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
	const context = createMockContext();
	await mock.commands.get("plan")?.handler("", context.ctx);
	const widget = context.widgets.get("plan-mode-plan") as string[];
	assert.match(widget.join("\n"), /plan_mode_complete/);
	assert.doesNotMatch(widget.join("\n"), /proposed_plan/);
	await mock.commands.get("plan")?.handler("", context.ctx);
	assert.match(context.notifications.at(-1)?.message ?? "", /plan_mode_complete/);
	assert.doesNotMatch(context.notifications.at(-1)?.message ?? "", /proposed_plan/);
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

	await mock.commands.get("plan")?.handler("", context.ctx);
	const active = (await contextHook({ messages: allMessages }, context.ctx)) as {
		messages: unknown[];
	};
	assert.deepEqual(active.messages, allMessages);
});

test("Plan prompt requires the standalone completion contract", () => {
	const prompt = buildPlanModePrompt();
	assert.match(prompt, /recommended option.*assumption/i);
	assert.match(prompt, /plan_mode_complete/i);
	assert.match(prompt, /alone as (?:your )?(?:final|last) action/i);
	assert.match(prompt, /end.*plan_mode_question.*plan_mode_complete/is);
	assert.match(prompt, /clarification.*plan_mode_complete.*unchanged/is);
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
