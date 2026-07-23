import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createMockContext, createMockPi } from "../../../test/support.js";
import { AgentRegistry, type ManagedAgent } from "../src/registry.js";
import { normalizeSubagentSettings } from "../src/settings.js";
import {
	assertFollowUpWriteAllowed,
	formatStatefulAgentLine,
	isWriteCapable,
	registerStatefulSubagents,
	resolveCompletionDelivery,
	resolveSpawnContextMode,
	resolveStatefulTransportKind,
} from "../src/stateful.js";
import { resolveStatefulSubprocessThinkingLevel } from "../src/subprocess-transport.js";
import { WorkspaceManager } from "../src/workspace.js";

function record(overrides: Partial<ManagedAgent> = {}): ManagedAgent {
	return {
		id: "sa_test",
		agent: "scout",
		rootId: "sa_test",
		depth: 0,
		children: [],
		state: "completed",
		createdAt: 1,
		updatedAt: Date.now(),
		cwd: process.cwd(),
		history: [],
		mailbox: [],
		...overrides,
	};
}

test("WorkspaceManager creates and cleans owned disposable worktrees", async () => {
	const repo = mkdtempSync(path.join(os.tmpdir(), "pi-subagent-workspace-repo-"));
	execFileSync("git", ["init", "-q", repo]);
	execFileSync("git", ["-C", repo, "config", "user.email", "test@example.com"]);
	execFileSync("git", ["-C", repo, "config", "user.name", "Test"]);
	writeFileSync(path.join(repo, "tracked.txt"), "base\n");
	mkdirSync(path.join(repo, "nested"));
	writeFileSync(path.join(repo, "nested", "inner.txt"), "inner\n");
	execFileSync("git", ["-C", repo, "add", "tracked.txt", "nested/inner.txt"]);
	execFileSync("git", ["-C", repo, "commit", "-qm", "init"]);
	const manager = new WorkspaceManager();
	const workspace = await manager.create("owner", path.join(repo, "nested"));
	assert.equal(readFileSync(path.join(workspace.path, "inner.txt"), "utf8"), "inner\n");
	assert.equal(readFileSync(path.join(workspace.rootPath, "tracked.txt"), "utf8"), "base\n");
	await assert.rejects(() => manager.create("owner", repo), /owner already exists/);
	rmSync(`${workspace.rootPath}.owner`);
	await assert.rejects(() => manager.cleanup("owner"), /Refusing to clean unowned/);
	writeFileSync(`${workspace.rootPath}.owner`, "owner", { mode: 0o600 });
	await manager.cleanup("owner");
	assert.equal(existsSync(workspace.rootPath), false);
	const second = await manager.create("second", repo);
	await manager.cleanupAll();
	assert.equal(existsSync(second.path), false);
	writeFileSync(path.join(repo, "dirty.txt"), "dirty");
	await assert.rejects(() => manager.create("dirty", repo), /clean Git repository/);
});

test("shared-workspace write classification and follow-up guards are conservative", async () => {
	assert.equal(isWriteCapable(undefined), true);
	assert.equal(isWriteCapable(["read", "grep"]), false);
	assert.equal(isWriteCapable(["read", "bash"]), true);
	assert.equal(isWriteCapable(["edit"]), true);
	const registry = new AgentRegistry(async (_agent, _task, signal) => {
		await new Promise<void>((resolve) =>
			signal.addEventListener("abort", () => resolve(), { once: true }),
		);
		return { output: "interrupted", exitCode: 130, aborted: true };
	});
	const active = await registry.spawn({ agent: "worker", task: "active", cwd: process.cwd() });
	const followUp = record({ agent: "worker", cwd: process.cwd(), state: "completed" });
	assert.throws(
		() => assertFollowUpWriteAllowed(registry, followUp, false, false),
		(error: unknown) => {
			assert.match(String(error), /already active in shared workspace/);
			assert.match(String(error), /prefer one subagent_spawn.*asynchronous work/i);
			assert.match(String(error), /blocking subagent parallel mode.*synchronous outputs/i);
			assert.doesNotMatch(
				String(error),
				/For independent one-shot work, use subagent parallel mode/,
			);
			assert.match(String(error), /let the active agent finish or close/);
			assert.match(String(error), /allowConcurrentWrites/);
			assert.match(String(error), /worktree/);
			return true;
		},
	);
	assert.doesNotThrow(() => assertFollowUpWriteAllowed(registry, followUp, true, false));
	assert.doesNotThrow(() => assertFollowUpWriteAllowed(registry, followUp, false, true));
	await registry.interrupt(active.id);
});

test("stateful agent lines escape terminal controls from retained agent data", () => {
	const line = formatStatefulAgentLine(
		record({
			agent: "scout\u001b]8;;https://example.com\u0007linked",
			currentTask: "first line\nsecond line\u009b31m",
		}),
	);
	// biome-ignore lint/suspicious/noControlCharactersInRegex: Verify terminal-control escaping.
	assert.doesNotMatch(line, /[\u0000-\u001f\u007f-\u009f]/u);
	assert.match(line, /scout.*linked/);
	assert.match(line, /first line second line/);
});

test("selected context entries imply all mode only when context mode is omitted", () => {
	assert.equal(resolveSpawnContextMode(undefined, ["entry"]), "all");
	assert.equal(resolveSpawnContextMode(undefined, []), "all");
	assert.equal(resolveSpawnContextMode(undefined, undefined), "none");
	assert.equal(resolveSpawnContextMode("none", ["entry"]), "none");
	assert.equal(resolveSpawnContextMode(3, ["entry"]), 3);
});

test("stateful tools are available by default, disable cleanly, and expose the lifecycle surface", async () => {
	const originalDir = process.env.PI_CODING_AGENT_DIR;
	const dir = mkdtempSync(path.join(os.tmpdir(), "pi-subagent-config-"));
	process.env.PI_CODING_AGENT_DIR = dir;
	try {
		const mock = createMockPi();
		const controller = registerStatefulSubagents(mock.pi);
		assert.deepEqual(controller.getRuntimeStatus(), {
			enabled: true,
			initialized: false,
			transport: "subprocess",
			completionDelivery: "next-turn",
			activeAgents: 0,
			retainedAgents: 0,
		});
		assert.deepEqual(controller.listAgents(), []);
		assert.equal(await controller.clearAgents(), 0);
		assert.deepEqual(
			mock.tools.map((tool) => tool.name),
			[
				"subagent_spawn",
				"subagent_send",
				"subagent_message",
				"subagent_messages",
				"subagent_list",
				"subagent_interrupt",
				"subagent_close",
			],
		);
		assert.ok(mock.commands.has("subagents:agents"));
		const context = createMockContext();
		await mock.events.get("session_start")?.[0]?.({}, context.ctx);
		assert.deepEqual(controller.getRuntimeStatus(), {
			enabled: true,
			initialized: true,
			transport: "subprocess",
			completionDelivery: "next-turn",
			activeAgents: 0,
			retainedAgents: 0,
		});
		const list = mock.tools.find((tool) => tool.name === "subagent_list") as {
			execute: (...args: unknown[]) => Promise<{ content: Array<{ text: string }> }>;
		};
		const listed = await list.execute("id", {}, undefined, undefined, context.ctx);
		assert.equal(listed.content[0].text, "No stateful subagents.");

		const project = mkdtempSync(path.join(os.tmpdir(), "pi-subagent-project-"));
		const projectAgents = path.join(project, ".pi", "agents");
		mkdirSync(projectAgents, { recursive: true });
		writeFileSync(
			path.join(projectAgents, "project.md"),
			"---\nname: project\ndescription: project agent\n---\nDo project work.",
		);
		const untrusted = createMockContext({ cwd: project, isProjectTrusted: () => false });
		const spawnTool = mock.tools.find((tool) => tool.name === "subagent_spawn") as {
			description: string;
			execute: (...args: unknown[]) => Promise<unknown>;
			parameters: {
				properties?: Record<string, { description?: string; enum?: string[] }>;
			};
			promptGuidelines: string[];
		};
		const thinkingLevels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
		assert.deepEqual(spawnTool.parameters.properties?.thinkingLevel?.enum, thinkingLevels);
		assert.match(
			spawnTool.parameters.properties?.thinkingLevel?.description ?? "",
			/task difficulty/i,
		);
		assert.match(spawnTool.description, /thinking level.*task difficulty/i);
		const spawnGuidance = spawnTool.promptGuidelines.join("\n");
		assert.match(spawnGuidance, /simple or critical-path work/);
		assert.match(spawnGuidance, /prefer one subagent_spawn.*broad.*research/i);
		assert.match(spawnGuidance, /next-turn.*default/i);
		assert.match(spawnGuidance, /current response.*does not depend/i);
		assert.match(spawnGuidance, /blocking subagent.*final answer.*depends/i);
		assert.doesNotMatch(spawnGuidance, /even when.*final answer.*depends/i);
		assert.match(spawnGuidance, /do not.*blocking parallel.*same turn/i);
		assert.match(spawnGuidance, /single subagent_spawn.*isolation or specialization/i);
		assert.doesNotMatch(
			spawnGuidance,
			/use one blocking subagent parallel call for multiple independent one-shot tasks/i,
		);
		assert.match(spawnGuidance, /useful non-overlapping.*immediately/i);
		assert.match(spawnGuidance, /tell the user.*end the response/i);
		assert.match(spawnGuidance, /do not poll.*subagent_list/i);
		assert.match(spawnGuidance, /synthesize available.*completion/i);
		assert.match(spawnGuidance, /subagent_spawn.*lowest sufficient.*thinking level/i);
		assert.match(spawnGuidance, /off.*minimal.*extraction.*mechanical/i);
		assert.match(spawnGuidance, /low.*straightforward.*bounded/i);
		assert.match(spawnGuidance, /medium.*multi-step/i);
		assert.match(spawnGuidance, /high.*debugging.*design.*review/i);
		assert.match(spawnGuidance, /xhigh.*ambiguous.*cross-system.*high-risk/i);
		assert.match(spawnGuidance, /max.*hardest.*quality.*latency.*cost/i);
		for (const guideline of spawnTool.promptGuidelines) {
			assert.match(
				guideline,
				/subagent_spawn/,
				`flattened spawn guideline must identify subagent_spawn: ${guideline}`,
			);
		}
		const originalDepth = process.env.PI_SUBAGENT_DEPTH;
		process.env.PI_SUBAGENT_DEPTH = "1";
		try {
			await assert.rejects(
				() =>
					spawnTool.execute(
						"id",
						{ agent: "scout", task: "nested" },
						undefined,
						undefined,
						context.ctx,
					),
				/recursion depth limit/,
			);
		} finally {
			if (originalDepth === undefined) delete process.env.PI_SUBAGENT_DEPTH;
			else process.env.PI_SUBAGENT_DEPTH = originalDepth;
		}
		await assert.rejects(
			() =>
				spawnTool.execute(
					"id",
					{
						agent: "project",
						task: "task",
						cwd: project,
						agentScope: "project",
						confirmProjectAgents: false,
					},
					undefined,
					undefined,
					createMockContext({ isProjectTrusted: () => true }).ctx,
				),
			/overridden cwd/,
		);
		await assert.rejects(
			() =>
				spawnTool.execute(
					"id",
					{
						agent: "project",
						task: "task",
						agentScope: "project",
						confirmProjectAgents: false,
					},
					undefined,
					undefined,
					untrusted.ctx,
				),
			/trusted project/,
		);
		await mock.events.get("session_shutdown")?.[0]?.({}, context.ctx);
		assert.deepEqual(controller.getRuntimeStatus(), {
			enabled: true,
			initialized: false,
			transport: "subprocess",
			completionDelivery: "next-turn",
			activeAgents: 0,
			retainedAgents: 0,
		});

		writeFileSync(
			path.join(dir, "pi-subagents.json"),
			JSON.stringify({ stateful: { completionDelivery: "auto-resume" } }),
		);
		const autoResume = createMockPi();
		registerStatefulSubagents(autoResume.pi);
		const autoResumeSpawn = autoResume.tools.find((tool) => tool.name === "subagent_spawn");
		assert.ok(Array.isArray(autoResumeSpawn?.promptGuidelines));
		const autoResumeGuidance = autoResumeSpawn.promptGuidelines.join("\n");
		assert.match(autoResumeGuidance, /auto-resume/i);
		assert.match(autoResumeGuidance, /even when.*final answer.*depends/i);
		assert.doesNotMatch(autoResumeGuidance, /next-turn.*default/i);

		writeFileSync(
			path.join(dir, "pi-subagents.json"),
			JSON.stringify({ stateful: { enabled: false } }),
		);
		const disabled = createMockPi();
		const disabledController = registerStatefulSubagents(disabled.pi);
		assert.equal(disabled.tools.length, 0);
		assert.equal(disabled.events.size, 0);
		assert.deepEqual(disabledController.getRuntimeStatus(), {
			enabled: false,
			initialized: false,
			transport: "subprocess",
			completionDelivery: "next-turn",
			activeAgents: 0,
			retainedAgents: 0,
		});
		assert.deepEqual(disabledController.listAgents(), []);
		assert.equal(await disabledController.clearAgents(), 0);
	} finally {
		if (originalDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = originalDir;
	}
});

test("stateful subprocess thinking uses spawn override before the agent default", () => {
	const agents = [{ name: "scout", thinkingLevel: "low" as const }, { name: "reviewer" }];
	assert.equal(
		resolveStatefulSubprocessThinkingLevel(agents, record({ thinkingLevel: "high" })),
		"high",
	);
	assert.equal(resolveStatefulSubprocessThinkingLevel(agents, record()), "low");
	assert.equal(
		resolveStatefulSubprocessThinkingLevel(agents, record({ agent: "reviewer" })),
		undefined,
	);
});

test("stateful settings validate transport, completion delivery, and bounded runtime options", () => {
	assert.equal(resolveStatefulTransportKind(undefined), "subprocess");
	assert.equal(resolveStatefulTransportKind("in-process"), "in-process");
	assert.equal(resolveCompletionDelivery(undefined), "next-turn");
	assert.equal(resolveCompletionDelivery("auto-resume"), "auto-resume");
	assert.deepEqual(
		normalizeSubagentSettings({
			stateful: {
				enabled: true,
				transport: "in-process",
				completionDelivery: "auto-resume",
				maxAgents: 8,
				maxDepth: 2,
				maxChildrenPerAgent: 3,
				maxMailboxMessages: 10,
				maxMailboxMessageBytes: 4096,
			},
			agents: {},
		}),
		{
			stateful: {
				enabled: true,
				transport: "in-process",
				completionDelivery: "auto-resume",
				maxAgents: 8,
				maxDepth: 2,
				maxChildrenPerAgent: 3,
				maxMailboxMessages: 10,
				maxMailboxMessageBytes: 4096,
			},
		},
	);
	assert.deepEqual(normalizeSubagentSettings({ stateful: { transport: "subprocess" } }), {
		stateful: { transport: "subprocess" },
	});
	assert.equal(normalizeSubagentSettings({ stateful: { transport: "native" } }), undefined);
	assert.equal(
		normalizeSubagentSettings({ stateful: { completionDelivery: "always" } }),
		undefined,
	);
	assert.equal(normalizeSubagentSettings({ stateful: { maxAgents: 0 } }), undefined);
	assert.equal(normalizeSubagentSettings({ stateful: { maxAgents: 1.5 } }), undefined);
	assert.deepEqual(normalizeSubagentSettings({ stateful: { maxDepth: 0 } }), {
		stateful: { maxDepth: 0 },
	});
});
