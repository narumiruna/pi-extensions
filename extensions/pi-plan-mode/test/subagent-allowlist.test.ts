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
import planMode from "../src/plan-mode.js";

const SETTINGS_FILE = "pi-plan-mode.json";

test("configured roles guard blocking and detached launches only in active Plan mode", async () => {
	await withAgentDir(async (agentDir) => {
		await writeFile(
			join(agentDir, SETTINGS_FILE),
			JSON.stringify({
				defaultPlanTools: ["subagent", "subagent_spawn"],
				allowedPlanSubagents: ["plan-scout", "plan-reviewer"],
			}),
		);
		const mock = createMockPi({
			activeTools: ["read"],
			allTools: [builtinTool("read"), extensionTool("subagent"), extensionTool("subagent_spawn")],
		});
		planMode(mock.pi);
		const context = createMockContext();
		const hook = mock.events.get("tool_call")?.[0];
		assert.ok(hook);

		assert.equal(
			await hook(
				{ toolName: "subagent", input: { agent: "worker", task: "Implement" } },
				context.ctx,
			),
			undefined,
			"inactive Plan mode must not enforce its role policy",
		);

		await mock.events.get("session_start")?.[0]?.({}, context.ctx);
		await mock.commands.get("plan")?.handler("", context.ctx);
		assert.deepEqual(mock.rawPi.getActiveTools(), [
			"subagent",
			"subagent_spawn",
			"plan_mode_question",
			"plan_mode_complete",
		]);
		assert.equal(
			await hook(
				{ toolName: "subagent", input: { agent: "plan-scout", task: "Inspect" } },
				context.ctx,
			),
			undefined,
		);
		assert.match(
			(
				(await hook(
					{
						toolName: "subagent",
						input: {
							tasks: [
								{ agent: "plan-scout", task: "Inspect" },
								{ agent: "worker", task: "Implement" },
							],
						},
					},
					context.ctx,
				)) as { reason?: string } | undefined
			)?.reason ?? "",
			/role\(s\): worker/,
		);
		assert.match(
			(
				(await hook(
					{
						toolName: "subagent_spawn",
						input: { agent: "worker", task: "Implement" },
					},
					context.ctx,
				)) as { reason?: string } | undefined
			)?.reason ?? "",
			/role\(s\): worker/,
		);
		assert.match(
			(
				(await hook({ toolName: "subagent", input: { tasks: [] } }, context.ctx)) as
					| { reason?: string }
					| undefined
			)?.reason ?? "",
			/could not verify subagent roles/,
		);
	});
});

test("omitted and empty role allowlists preserve distinct compatibility behavior", async () => {
	await withAgentDir(async (agentDir) => {
		const settingsPath = join(agentDir, SETTINGS_FILE);
		await writeFile(settingsPath, JSON.stringify({ defaultPlanTools: ["subagent"] }));
		const allTools = [builtinTool("read"), extensionTool("subagent")];
		const omitted = createMockPi({ activeTools: ["read"], allTools });
		planMode(omitted.pi);
		const omittedContext = createMockContext();
		await omitted.events.get("session_start")?.[0]?.({}, omittedContext.ctx);
		await omitted.commands.get("plan")?.handler("", omittedContext.ctx);
		assert.equal(
			await omitted.events.get("tool_call")?.[0]?.(
				{ toolName: "subagent", input: { agent: "worker", task: "Implement" } },
				omittedContext.ctx,
			),
			undefined,
		);

		await writeFile(
			settingsPath,
			JSON.stringify({ defaultPlanTools: ["subagent"], allowedPlanSubagents: [] }),
		);
		const empty = createMockPi({ activeTools: ["read"], allTools });
		planMode(empty.pi);
		const emptyContext = createMockContext();
		await empty.events.get("session_start")?.[0]?.({}, emptyContext.ctx);
		await empty.commands.get("plan")?.handler("", emptyContext.ctx);
		assert.match(
			(
				(await empty.events.get("tool_call")?.[0]?.(
					{ toolName: "subagent", input: { agent: "plan-scout", task: "Inspect" } },
					emptyContext.ctx,
				)) as { reason?: string } | undefined
			)?.reason ?? "",
			/No subagent roles are allowed/,
		);
	});
});

test("a session-level Plan tools selection remains guarded", async () => {
	await withAgentDir(async (agentDir) => {
		await writeFile(
			join(agentDir, SETTINGS_FILE),
			JSON.stringify({ defaultPlanTools: [], allowedPlanSubagents: ["plan-scout"] }),
		);
		const mock = createMockPi({
			activeTools: ["read"],
			allTools: [builtinTool("read"), extensionTool("subagent")],
		});
		planMode(mock.pi);
		let selectedSubagent = false;
		const context = createMockContext({
			hasUI: true,
			select: async (_title: unknown, choices: string[]) => {
				if (selectedSubagent) return "Done";
				selectedSubagent = true;
				return choices.find((choice) => choice.includes(". subagent "));
			},
		});

		await mock.events.get("session_start")?.[0]?.({}, context.ctx);
		await mock.commands.get("plan")?.handler("", context.ctx);
		await mock.commands.get("plan")?.handler("tools", context.ctx);
		assert.ok(mock.rawPi.getActiveTools().includes("subagent"));
		assert.match(
			(
				(await mock.events.get("tool_call")?.[0]?.(
					{ toolName: "subagent", input: { agent: "worker", task: "Implement" } },
					context.ctx,
				)) as { reason?: string } | undefined
			)?.reason ?? "",
			/role\(s\): worker/,
		);
	});
});

test("session reload replaces and removes the role policy", async () => {
	await withAgentDir(async (agentDir) => {
		const settingsPath = join(agentDir, SETTINGS_FILE);
		await writeFile(
			settingsPath,
			JSON.stringify({ defaultPlanTools: ["subagent"], allowedPlanSubagents: ["plan-scout"] }),
		);
		const mock = createMockPi({
			activeTools: ["read"],
			allTools: [builtinTool("read"), extensionTool("subagent")],
		});
		planMode(mock.pi);
		const context = createMockContext();
		const hook = mock.events.get("tool_call")?.[0];
		assert.ok(hook);

		await mock.events.get("session_start")?.[0]?.({}, context.ctx);
		await mock.commands.get("plan")?.handler("", context.ctx);
		assert.ok(
			await hook(
				{ toolName: "subagent", input: { agent: "worker", task: "Implement" } },
				context.ctx,
			),
		);
		await mock.commands.get("plan")?.handler("exit", context.ctx);

		await writeFile(
			settingsPath,
			JSON.stringify({ defaultPlanTools: ["subagent"], allowedPlanSubagents: ["worker"] }),
		);
		await mock.events.get("session_start")?.[0]?.({}, context.ctx);
		await mock.commands.get("plan")?.handler("", context.ctx);
		assert.equal(
			await hook(
				{ toolName: "subagent", input: { agent: "worker", task: "Implement" } },
				context.ctx,
			),
			undefined,
		);
		assert.ok(
			await hook(
				{ toolName: "subagent", input: { agent: "plan-scout", task: "Inspect" } },
				context.ctx,
			),
		);
		await mock.commands.get("plan")?.handler("exit", context.ctx);

		await rm(settingsPath);
		await mock.events.get("session_start")?.[0]?.({}, context.ctx);
		await mock.commands.get("plan")?.handler("", context.ctx);
		assert.equal(
			await hook(
				{ toolName: "subagent", input: { agent: "worker", task: "Implement" } },
				context.ctx,
			),
			undefined,
		);
	});
});

test("configured role policy is inert when no subagent tools are installed", async () => {
	await withAgentDir(async (agentDir) => {
		await writeFile(
			join(agentDir, SETTINGS_FILE),
			JSON.stringify({ allowedPlanSubagents: ["plan-scout"] }),
		);
		const mock = createMockPi({ activeTools: ["read"], allTools: [builtinTool("read")] });
		planMode(mock.pi);
		const context = createMockContext();
		await mock.events.get("session_start")?.[0]?.({}, context.ctx);
		await mock.commands.get("plan")?.handler("", context.ctx);
		assert.equal(mock.rawPi.getActiveTools().includes("subagent"), false);
		assert.equal(
			await mock.events.get("tool_call")?.[0]?.(
				{ toolName: "custom_delegate", input: { agent: "worker" } },
				context.ctx,
			),
			undefined,
		);
	});
});

async function withAgentDir(run: (agentDir: string) => Promise<void>) {
	const agentDir = await mkdtemp(join(tmpdir(), "pi-plan-mode-subagent-allowlist-"));
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
