import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
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
	assert.equal(mock.tools[0]?.name, "plan_mode_question");
	assert.ok(mock.commands.has("plan"));
	assert.equal(typeof mock.commands.get("plan")?.getArgumentCompletions, "function");
	assert.ok(mock.events.has("tool_call"));
	assert.ok(mock.events.has("before_agent_start"));
});

test("completePlanArguments suggests management tokens only", () => {
	assert.deepEqual(
		completePlanArguments("")?.map((item) => item.label),
		["exit", "off", "tools"],
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
		"git branch -D old",
		"git remote add origin url",
		"npm audit --fix",
		"env sh -c 'touch file'",
		"date --set tomorrow",
		"sort input -o output",
		"tree -o output",
		"find . -fprint output",
		"git diff --output=patch",
		"git remote update",
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

test("active Plan mode blocks update_plan at the tool hook", async () => {
	const mock = createMockPi({ activeTools: ["read", "bash", "update_plan"] });
	planMode(mock.pi);
	const context = createMockContext();
	await mock.commands.get("plan")?.handler("", context.ctx);
	const hook = mock.events.get("tool_call")?.[0];
	const blocked = await hook?.({ toolName: "update_plan", input: {} }, context.ctx);
	const allowed = await hook?.({ toolName: "read", input: {} }, context.ctx);
	assert.deepEqual(blocked, {
		block: true,
		reason:
			"Plan mode blocks update_plan because it tracks execution progress rather than conversational planning.",
	});
	assert.equal(allowed, undefined);
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

test("session resume restores active Plan state and required tools", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-plan-mode-resume-"));
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = directory;
	try {
		const mock = createMockPi({ activeTools: ["read", "write"] });
		planMode(mock.pi);
		const context = createMockContext({
			sessionManager: {
				getBranch: () => [],
				getEntries: () => [
					{
						type: "custom",
						customType: "plan-mode-state",
						data: { enabled: true, awaitingAction: true, latestPlan: "# Resumed" },
					},
				],
			},
		});
		await mock.events.get("session_start")?.[0]?.({}, context.ctx);
		assert.equal(context.statuses.get("plan-mode"), "plan ready");
		assert.deepEqual(mock.rawPi.getActiveTools(), ["read", "plan_mode_question"]);
		await mock.events.get("session_shutdown")?.[0]?.({}, context.ctx);
		assert.deepEqual(mock.rawPi.getActiveTools(), ["read", "write"]);
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		await rm(directory, { recursive: true, force: true });
	}
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

test("Plan lifecycle enters with a prompt and hands a valid plan to implementation", async () => {
	const mock = createMockPi({ activeTools: ["read", "bash", "custom"] });
	planMode(mock.pi);
	const context = createMockContext({
		hasUI: true,
		select: async () => "Implement this plan",
	});
	await mock.commands.get("plan")?.handler("design it", context.ctx);
	assert.deepEqual(mock.sentUserMessages[0], { text: "design it", options: undefined });
	assert.deepEqual(mock.rawPi.getActiveTools(), ["bash", "read", "plan_mode_question"]);

	await mock.events.get("agent_end")?.[0]?.(
		{ messages: [{ role: "assistant", content: "<proposed_plan>\n# Ship it\n</proposed_plan>" }] },
		context.ctx,
	);
	await new Promise((resolve) => setTimeout(resolve, 10));
	assert.deepEqual(mock.rawPi.getActiveTools(), ["read", "bash", "custom"]);
	assert.match(
		mock.sentUserMessages.at(-1)?.text ?? "",
		/Implement this proposed plan now:\n\n# Ship it/,
	);
	assert.equal(context.statuses.get("plan-mode"), undefined);
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
});

test("Codex-like prompt includes replacement, default, and compactness rules", () => {
	const prompt = buildPlanModePrompt();
	assert.match(prompt, /recommended option.*assumption/i);
	assert.match(prompt, /complete replacement/i);
	assert.match(prompt, /at most one <proposed_plan>/i);
	assert.match(prompt, /behavior-level/i);
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
