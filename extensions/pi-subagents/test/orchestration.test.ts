import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createMockContext, createMockPi } from "../../../test/support.js";
import { RootOrchestrationState } from "../src/orchestration.js";
import { AgentRegistry, type ManagedAgent } from "../src/registry.js";
import { normalizeSubagentSettings } from "../src/settings.js";
import {
	assertFollowUpWriteAllowed,
	isWriteCapable,
	registerStatefulSubagents,
	resolveSpawnContextMode,
	resolveStatefulTransportKind,
} from "../src/stateful.js";
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
			assert.match(String(error), /subagent parallel mode/);
			assert.match(String(error), /wait or close/);
			assert.match(String(error), /allowConcurrentWrites/);
			assert.match(String(error), /worktree/);
			return true;
		},
	);
	assert.doesNotThrow(() => assertFollowUpWriteAllowed(registry, followUp, true, false));
	assert.doesNotThrow(() => assertFollowUpWriteAllowed(registry, followUp, false, true));
	await registry.interrupt(active.id);
});

test("root orchestration recovery is revision-bounded and clears synthesized results", () => {
	const state = new RootOrchestrationState();
	state.reset();
	state.beginTurn();
	state.spawn("sa_one");
	const first = state.endTurn();
	assert.ok(first);
	assert.match(first.prompt, /subagent_wait/);
	state.markDelivered(first);

	state.beginTurn();
	assert.equal(state.endTurn(), undefined, "unchanged live work does not loop autonomously");
	state.complete("sa_one");
	const synthesis = state.endTurn();
	assert.ok(synthesis, "completion after the turn schedules a synthesis recovery");
	state.markDelivered(synthesis);
	state.beginTurn();
	assert.equal(state.endTurn(), undefined);
	assert.equal(state.hasUnresolved(), false);
});

test("root orchestration treats newer root work as a bounded coordination attempt", () => {
	const state = new RootOrchestrationState();
	state.reset();
	state.spawn("sa_one");
	assert.ok(state.endTurn());
	state.beginTurn();
	assert.equal(state.endTurn(), undefined);
	assert.deepEqual(state.liveAgentIds(), ["sa_one"]);
});

test("root orchestration lets newer user work supersede a queued recovery", () => {
	const state = new RootOrchestrationState();
	state.reset();
	state.spawn("sa_one");
	const queued = state.endTurn();
	assert.ok(queued);
	assert.match(queued.prompt, new RegExp(queued.nonce));
	assert.deepEqual(state.supersedePending(), queued);
	assert.equal(state.isCurrent(queued), false);
	state.beginTurn();
	assert.equal(state.endTurn(), undefined);
});

test("root orchestration accepts completion synthesized during useful root work", () => {
	const state = new RootOrchestrationState();
	state.reset();
	state.beginTurn();
	state.spawn("sa_one");
	state.complete("sa_one");
	state.observeAvailable();
	assert.equal(state.endTurn(), undefined);
	assert.equal(state.hasUnresolved(), false);
});

test("root orchestration cancels stale tickets and explicit resolution", () => {
	const state = new RootOrchestrationState();
	state.reset();
	state.spawn("sa_one");
	const stale = state.endTurn();
	assert.ok(stale);
	state.complete("sa_one");
	assert.equal(state.isCurrent(stale), false);
	const current = state.endTurn();
	assert.ok(current);
	state.resolve("sa_one");
	assert.equal(state.isCurrent(current), false);
	assert.equal(state.hasUnresolved(), false);
	state.reset();
	assert.equal(state.pendingTicket(), undefined);
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
		registerStatefulSubagents(mock.pi);
		assert.deepEqual(
			mock.tools.map((tool) => tool.name),
			[
				"subagent_spawn",
				"subagent_send",
				"subagent_message",
				"subagent_messages",
				"subagent_wait",
				"subagent_list",
				"subagent_interrupt",
				"subagent_close",
			],
		);
		assert.ok(mock.commands.has("subagents:agents"));
		const context = createMockContext();
		await mock.events.get("session_start")?.[0]?.({}, context.ctx);
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
			execute: (...args: unknown[]) => Promise<unknown>;
			promptGuidelines: string[];
		};
		assert.match(spawnTool.promptGuidelines.join("\n"), /simple or critical-path work/);
		assert.match(
			spawnTool.promptGuidelines.join("\n"),
			/single detached subagent.*isolation or specialization/i,
		);
		assert.match(spawnTool.promptGuidelines.join("\n"), /call subagent_wait rather than yielding/i);
		assert.match(spawnTool.promptGuidelines.join("\n"), /synthesize their results/i);
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

		writeFileSync(
			path.join(dir, "pi-subagents.json"),
			JSON.stringify({ stateful: { enabled: false } }),
		);
		const disabled = createMockPi();
		registerStatefulSubagents(disabled.pi);
		assert.equal(disabled.tools.length, 0);
		assert.equal(disabled.events.size, 0);
	} finally {
		if (originalDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = originalDir;
	}
});

test("stateful settings validate transport and bounded runtime options", () => {
	assert.equal(resolveStatefulTransportKind(undefined), "subprocess");
	assert.equal(resolveStatefulTransportKind("in-process"), "in-process");
	assert.deepEqual(
		normalizeSubagentSettings({
			stateful: {
				enabled: true,
				transport: "in-process",
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
	assert.equal(normalizeSubagentSettings({ stateful: { maxAgents: 0 } }), undefined);
	assert.equal(normalizeSubagentSettings({ stateful: { maxAgents: 1.5 } }), undefined);
	assert.deepEqual(normalizeSubagentSettings({ stateful: { maxDepth: 0 } }), {
		stateful: { maxDepth: 0 },
	});
});
