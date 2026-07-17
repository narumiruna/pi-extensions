import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	builtinTool,
	createMockContext,
	createMockPi,
	driveCustomSelector,
	extensionTool,
} from "../../../test/support.js";
import planMode from "../src/plan-mode.js";

const REQUIRED_PLAN_TOOLS = ["plan_mode_question", "plan_mode_complete"];

test("fresh Plan mode uses configured default tools and restores previous tools", async () => {
	await withAgentDir(async (agentDir) => {
		await writeFile(
			join(agentDir, "pi-plan-mode.json"),
			JSON.stringify({
				defaultPlanTools: ["bash", "custom", "write", "missing", "bash"],
			}),
		);
		const mock = createMockPi({
			activeTools: ["read", "write"],
			allTools: [
				builtinTool("read"),
				builtinTool("bash"),
				builtinTool("write"),
				extensionTool("custom"),
			],
		});
		planMode(mock.pi);
		const context = createMockContext();

		await mock.events.get("session_start")?.[0]?.({}, context.ctx);
		await mock.commands.get("plan")?.handler("", context.ctx);
		assert.deepEqual(mock.rawPi.getActiveTools(), ["bash", "custom", ...REQUIRED_PLAN_TOOLS]);

		await mock.commands.get("plan")?.handler("exit", context.ctx);
		assert.deepEqual(mock.rawPi.getActiveTools(), ["read", "write"]);
	});
});

test("missing and empty default tool settings remain distinct", async () => {
	await withAgentDir(async (agentDir) => {
		const allTools = [
			builtinTool("read"),
			builtinTool("bash"),
			builtinTool("grep"),
			builtinTool("write"),
			extensionTool("custom"),
		];
		const missing = createMockPi({ activeTools: ["write"], allTools });
		planMode(missing.pi);
		const missingContext = createMockContext();
		await missing.events.get("session_start")?.[0]?.({}, missingContext.ctx);
		await missing.commands.get("plan")?.handler("", missingContext.ctx);
		assert.deepEqual(missing.rawPi.getActiveTools(), [
			"bash",
			"grep",
			"read",
			...REQUIRED_PLAN_TOOLS,
		]);

		await writeFile(join(agentDir, "pi-plan-mode.json"), JSON.stringify({ defaultPlanTools: [] }));
		const empty = createMockPi({ activeTools: ["write"], allTools });
		planMode(empty.pi);
		const emptyContext = createMockContext();
		await empty.events.get("session_start")?.[0]?.({}, emptyContext.ctx);
		await empty.commands.get("plan")?.handler("", emptyContext.ctx);
		assert.deepEqual(empty.rawPi.getActiveTools(), REQUIRED_PLAN_TOOLS);
	});
});

test("explicit defaults stay fail closed when tool metadata is unavailable", async () => {
	await withAgentDir(async (agentDir) => {
		const settingsPath = join(agentDir, "pi-plan-mode.json");
		await writeFile(settingsPath, JSON.stringify({ defaultPlanTools: [] }));
		const explicit = createMockPi({ activeTools: ["write"], allTools: [] });
		planMode(explicit.pi);
		const explicitContext = createMockContext();
		await explicit.events.get("session_start")?.[0]?.({}, explicitContext.ctx);
		await explicit.commands.get("plan")?.handler("", explicitContext.ctx);
		assert.deepEqual(explicit.rawPi.getActiveTools(), REQUIRED_PLAN_TOOLS);

		await rm(settingsPath);
		const fallback = createMockPi({ activeTools: ["write"], allTools: [] });
		planMode(fallback.pi);
		const fallbackContext = createMockContext();
		await fallback.events.get("session_start")?.[0]?.({}, fallbackContext.ctx);
		await fallback.commands.get("plan")?.handler("", fallbackContext.ctx);
		assert.deepEqual(fallback.rawPi.getActiveTools(), ["read", "bash", ...REQUIRED_PLAN_TOOLS]);
	});
});

test("restored session tool selections override configured defaults", async () => {
	await withAgentDir(async (agentDir) => {
		await writeFile(
			join(agentDir, "pi-plan-mode.json"),
			JSON.stringify({ defaultPlanTools: ["bash", "custom"] }),
		);
		const allTools = [
			builtinTool("read"),
			builtinTool("bash"),
			builtinTool("grep"),
			extensionTool("custom"),
		];

		for (const { data, expected } of [
			{
				data: { enabled: true, awaitingAction: false, selectedToolNames: ["read"] },
				expected: ["read", ...REQUIRED_PLAN_TOOLS],
			},
			{
				data: { enabled: true, awaitingAction: false, selectedToolNames: [] },
				expected: REQUIRED_PLAN_TOOLS,
			},
			{
				data: {
					enabled: true,
					awaitingAction: false,
					selectedToolKeys: ["grep\u001fbuiltin"],
				},
				expected: ["grep", ...REQUIRED_PLAN_TOOLS],
			},
		]) {
			const mock = createMockPi({ activeTools: ["write"], allTools });
			planMode(mock.pi);
			const stateEntry = { type: "custom", customType: "plan-mode-state", data };
			const context = createMockContext({
				sessionManager: {
					getBranch: () => [stateEntry],
					getEntries: () => [stateEntry],
				},
			});

			await mock.events.get("session_start")?.[0]?.({}, context.ctx);
			assert.deepEqual(mock.rawPi.getActiveTools(), expected);
		}
	});
});

test("settings reload resets removed or invalid configured defaults", async () => {
	await withAgentDir(async (agentDir) => {
		const settingsPath = join(agentDir, "pi-plan-mode.json");
		await writeFile(settingsPath, JSON.stringify({ defaultPlanTools: ["bash"] }));
		const allTools = [
			builtinTool("read"),
			builtinTool("bash"),
			builtinTool("grep"),
			builtinTool("write"),
		];
		const mock = createMockPi({ activeTools: ["write"], allTools });
		planMode(mock.pi);
		const context = createMockContext();

		await mock.events.get("session_start")?.[0]?.({}, context.ctx);
		await mock.commands.get("plan")?.handler("", context.ctx);
		assert.deepEqual(mock.rawPi.getActiveTools(), ["bash", ...REQUIRED_PLAN_TOOLS]);
		await mock.commands.get("plan")?.handler("exit", context.ctx);

		await rm(settingsPath);
		await mock.events.get("session_start")?.[0]?.({}, context.ctx);
		await mock.commands.get("plan")?.handler("", context.ctx);
		assert.deepEqual(mock.rawPi.getActiveTools(), ["bash", "grep", "read", ...REQUIRED_PLAN_TOOLS]);
		await mock.commands.get("plan")?.handler("exit", context.ctx);

		await writeFile(settingsPath, JSON.stringify({ defaultPlanTools: "read" }));
		await mock.events.get("session_start")?.[0]?.({}, context.ctx);
		await mock.commands.get("plan")?.handler("", context.ctx);
		assert.deepEqual(mock.rawPi.getActiveTools(), ["bash", "grep", "read", ...REQUIRED_PLAN_TOOLS]);
		assert.match(context.notifications.at(-2)?.message ?? "", /settings ignored/i);
	});
});

test("configured names follow effective sources without dynamic auto-activation", async () => {
	await withAgentDir(async (agentDir) => {
		await writeFile(
			join(agentDir, "pi-plan-mode.json"),
			JSON.stringify({ defaultPlanTools: ["read", "late"] }),
		);
		const allTools = [extensionTool("read"), builtinTool("bash"), builtinTool("write")];
		const mock = createMockPi({ activeTools: ["write"], allTools });
		planMode(mock.pi);
		const context = createMockContext();

		await mock.events.get("session_start")?.[0]?.({}, context.ctx);
		await mock.commands.get("plan")?.handler("", context.ctx);
		assert.deepEqual(mock.rawPi.getActiveTools(), ["read", ...REQUIRED_PLAN_TOOLS]);

		allTools.push(extensionTool("late"));
		assert.deepEqual(mock.rawPi.getActiveTools(), ["read", ...REQUIRED_PLAN_TOOLS]);
		await mock.commands.get("plan")?.handler("exit", context.ctx);
		await mock.commands.get("plan")?.handler("", context.ctx);
		assert.deepEqual(mock.rawPi.getActiveTools(), ["late", "read", ...REQUIRED_PLAN_TOOLS]);
	});
});

test("the tool selector persists a session override and shutdown restores prior tools", async () => {
	await withAgentDir(async (agentDir) => {
		await writeFile(
			join(agentDir, "pi-plan-mode.json"),
			JSON.stringify({ defaultPlanTools: ["bash", "custom"] }),
		);
		const allTools = [
			builtinTool("read"),
			builtinTool("bash"),
			builtinTool("write"),
			extensionTool("custom"),
		];
		const mock = createMockPi({ activeTools: ["write"], allTools });
		planMode(mock.pi);
		let selectedRead = false;
		const context = createMockContext({
			hasUI: true,
			select: async (_title: unknown, choices: string[]) => {
				if (selectedRead) return "Done";
				selectedRead = true;
				return choices.find((choice) => choice.includes(". read "));
			},
		});

		await mock.events.get("session_start")?.[0]?.({}, context.ctx);
		await mock.commands.get("plan")?.handler("", context.ctx);
		await mock.commands.get("plan")?.handler("tools", context.ctx);
		assert.deepEqual(mock.rawPi.getActiveTools(), [
			"bash",
			"read",
			"custom",
			...REQUIRED_PLAN_TOOLS,
		]);
		const persisted = mock.entries.at(-1);
		assert.ok(persisted);
		assert.deepEqual((persisted.data as { selectedToolNames?: string[] }).selectedToolNames, [
			"bash",
			"custom",
			"read",
		]);

		await mock.events.get("session_shutdown")?.[0]?.({}, context.ctx);
		assert.deepEqual(mock.rawPi.getActiveTools(), ["write"]);

		const resumed = createMockPi({ activeTools: ["write"], allTools });
		planMode(resumed.pi);
		const stateEntry = { type: "custom", ...persisted };
		const resumedContext = createMockContext({
			sessionManager: {
				getBranch: () => [stateEntry],
				getEntries: () => [stateEntry],
			},
		});
		await resumed.events.get("session_start")?.[0]?.({}, resumedContext.ctx);
		assert.deepEqual(resumed.rawPi.getActiveTools(), [
			"bash",
			"read",
			"custom",
			...REQUIRED_PLAN_TOOLS,
		]);
	});
});

test("the Plan-mode tool selector keeps the cursor on the toggled row", async () => {
	await withAgentDir(async (agentDir) => {
		await writeFile(
			join(agentDir, "pi-plan-mode.json"),
			JSON.stringify({ defaultPlanTools: ["bash", "custom"] }),
		);
		const allTools = [
			builtinTool("read"),
			builtinTool("bash"),
			builtinTool("write"),
			extensionTool("custom"),
		];
		const mock = createMockPi({ activeTools: ["write"], allTools });
		planMode(mock.pi);
		let customCalled = false;
		const context = createMockContext({
			hasUI: true,
			custom: async (factory: unknown) => {
				customCalled = true;
				const { renders, result } = driveCustomSelector(factory, [
					"tui.select.down",
					"tui.select.confirm",
					"tui.select.cancel",
				]);
				assert.ok(renders[1]?.some((line) => line.includes("› [x] 2. read")));
				return result;
			},
		});

		await mock.events.get("session_start")?.[0]?.({}, context.ctx);
		await mock.commands.get("plan")?.handler("", context.ctx);
		await mock.commands.get("plan")?.handler("tools", context.ctx);

		assert.equal(customCalled, true);
		assert.deepEqual(mock.rawPi.getActiveTools(), [
			"bash",
			"read",
			"custom",
			...REQUIRED_PLAN_TOOLS,
		]);
	});
});

test("implementation handoff restores tools after using configured defaults", async () => {
	await withAgentDir(async (agentDir) => {
		await writeFile(
			join(agentDir, "pi-plan-mode.json"),
			JSON.stringify({ defaultPlanTools: ["bash"] }),
		);
		const mock = createMockPi({
			activeTools: ["read", "write", "custom"],
			allTools: [
				builtinTool("read"),
				builtinTool("bash"),
				builtinTool("write"),
				extensionTool("custom"),
			],
		});
		planMode(mock.pi);
		const context = createMockContext();
		await mock.events.get("session_start")?.[0]?.({}, context.ctx);
		await mock.commands.get("plan")?.handler("", context.ctx);
		assert.deepEqual(mock.rawPi.getActiveTools(), ["bash", ...REQUIRED_PLAN_TOOLS]);

		const execute = mock.tools.find((tool) => tool.name === "plan_mode_complete")?.execute as
			| ((...args: unknown[]) => Promise<unknown>)
			| undefined;
		assert.ok(execute);
		await execute("complete", { plan: "# Configured handoff" }, undefined, undefined, context.ctx);
		await mock.commands.get("plan")?.handler("implement", context.ctx);
		assert.deepEqual(mock.rawPi.getActiveTools(), ["read", "write", "custom"]);
		assert.match(mock.sentUserMessages.at(-1)?.text ?? "", /# Configured handoff/);
	});
});

async function withAgentDir(run: (agentDir: string) => Promise<void>) {
	const agentDir = await mkdtemp(join(tmpdir(), "pi-plan-mode-default-tools-"));
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	try {
		await run(agentDir);
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		await rm(agentDir, { recursive: true, force: true });
	}
}
