import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createMockContext, createMockPi } from "../../../test/support.js";
import { buildContextSnapshot, redactPrivateText } from "../src/context.js";
import { DEFAULT_MAX_CONTEXT_BYTES, truncateUtf8 } from "../src/limits.js";
import { AgentPersistence } from "../src/persistence.js";
import { JsonLineDecoder } from "../src/protocol.js";
import { AgentRegistry, type ManagedAgent } from "../src/registry.js";
import {
	buildFanInContext,
	mapWithConcurrencyLimit,
	runSingleAgent,
	terminateProcess,
} from "../src/runner.js";
import { normalizeSubagentSettings } from "../src/settings.js";
import {
	buildStatefulTurnPrompt,
	registerStatefulSubagents,
	resolveStatefulTurnTimeout,
} from "../src/stateful.js";

function record(overrides: Partial<ManagedAgent> = {}): ManagedAgent {
	return {
		id: "sa_test",
		agent: "scout",
		state: "completed",
		createdAt: 1,
		updatedAt: Date.now(),
		cwd: process.cwd(),
		history: [],
		...overrides,
	};
}

test("JsonLineDecoder handles fragmented, malformed, trailing, and oversized lines", () => {
	const values: unknown[] = [];
	const malformed: string[] = [];
	const oversized: number[] = [];
	const decoder = new JsonLineDecoder({
		maxLineBytes: 16,
		onValue: (value) => values.push(value),
		onMalformed: (line) => malformed.push(line),
		onOversized: (bytes) => oversized.push(bytes),
	});
	decoder.push('{"ok":');
	decoder.push("1}\nnot-json\n");
	decoder.push("x".repeat(17));
	decoder.push('\n{"tail":2}');
	decoder.finish();
	assert.deepEqual(values, [{ ok: 1 }, { tail: 2 }]);
	assert.deepEqual(malformed, ["not-json"]);
	assert.equal(oversized.length, 1);
});

test("UTF-8 and fan-in truncation are bounded and marked", () => {
	const bounded = truncateUtf8("界".repeat(100), 80);
	assert.ok(Buffer.byteLength(bounded.text) <= 80);
	assert.equal(bounded.truncated, true);
	assert.doesNotMatch(bounded.text, /�/);
	const fanIn = buildFanInContext([
		{
			...record(),
			agentSource: "built-in",
			task: "large",
			exitCode: 0,
			messages: [],
			stderr: "",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				cost: 0,
				contextTokens: 0,
				turns: 0,
			},
			finalOutput: "x".repeat(DEFAULT_MAX_CONTEXT_BYTES),
		},
	]);
	assert.ok(Buffer.byteLength(fanIn) <= DEFAULT_MAX_CONTEXT_BYTES);
	assert.match(fanIn, /truncated/);
});

test("context snapshots keep only user/assistant text, recent turns, and redact private content", () => {
	const snapshot = buildContextSnapshot(
		[
			{ type: "message", message: { role: "user", content: [{ type: "text", text: "old" }] } },
			{
				type: "message",
				message: { role: "toolResult", content: [{ type: "text", text: "secret tool output" }] },
			},
			{
				type: "message",
				message: {
					role: "assistant",
					content: [
						{ type: "thinking", thinking: "hidden" },
						{ type: "text", text: "answer" },
					],
				},
			},
			{
				type: "message",
				message: {
					role: "user",
					content: [{ type: "text", text: "new\n[subagent-private] token" }],
				},
			},
		],
		1,
	);
	assert.doesNotMatch(snapshot.text, /old|tool output|hidden|token/);
	assert.match(snapshot.text, /new/);
	assert.equal(snapshot.turns, 1);
	assert.equal(redactPrivateText("a<private>secret</private>b"), "a[private content omitted]b");
});

test("stateful follow-up prompts redact retained history and honor global timeout", () => {
	const originalTimeout = process.env.PI_SUBAGENT_TIMEOUT_MS;
	process.env.PI_SUBAGENT_TIMEOUT_MS = "4321";
	try {
		const prompt = buildStatefulTurnPrompt(
			record({
				context: "parent <private>ctx-secret</private>",
				history: [
					{
						task: "task <private>task-secret</private>",
						output: "[subagent-private] hidden-line\nvisible output",
						startedAt: 1,
						completedAt: 2,
						exitCode: 0,
					},
				],
			}),
			"next task",
		);
		assert.match(prompt.text, /Current task:\nnext task/);
		assert.match(prompt.text, /visible output/);
		assert.doesNotMatch(prompt.text, /ctx-secret|task-secret|hidden-line/);
		assert.equal(resolveStatefulTurnTimeout(undefined), 4321);
		assert.equal(resolveStatefulTurnTimeout({ timeoutMs: 99 }), 99);
	} finally {
		if (originalTimeout === undefined) delete process.env.PI_SUBAGENT_TIMEOUT_MS;
		else process.env.PI_SUBAGENT_TIMEOUT_MS = originalTimeout;
	}
});

test("mapWithConcurrencyLimit preserves input order and enforces its active limit", async () => {
	let active = 0;
	let peak = 0;
	const results = await mapWithConcurrencyLimit([0, 1, 2, 3, 4, 5], 4, async (value) => {
		active++;
		peak = Math.max(peak, active);
		await new Promise((resolve) => setTimeout(resolve, value % 2 ? 2 : 5));
		active--;
		return value * 2;
	});
	assert.equal(peak, 4);
	assert.deepEqual(results, [0, 2, 4, 6, 8, 10]);

	const controller = new AbortController();
	controller.abort();
	let started = 0;
	const skipped = await mapWithConcurrencyLimit(
		[1, 2],
		1,
		async (value) => {
			started++;
			return value;
		},
		controller.signal,
		(value) => -value,
	);
	assert.equal(started, 0);
	assert.deepEqual(skipped, [-1, -2]);
});

test("AgentRegistry supports follow-up, wait timeout, interrupt/reuse, limits, and close", async () => {
	const registry = new AgentRegistry(
		async (_agent, task, signal) => {
			if (task === "slow") {
				await new Promise<void>((resolve) =>
					signal.addEventListener("abort", () => resolve(), { once: true }),
				);
			}
			return {
				output: `done:${task}`,
				exitCode: signal.aborted ? 130 : 0,
				aborted: signal.aborted,
			};
		},
		{ maxAgents: 2, maxActiveTurns: 1 },
	);
	const first = await registry.spawn({ agent: "scout", task: "slow", cwd: process.cwd() });
	const second = await registry.spawn({ agent: "reviewer", task: "queued", cwd: process.cwd() });
	const queued = await registry.wait(second.id, 5);
	assert.equal(queued.timedOut, true);
	assert.equal(queued.agent.state, "starting");
	const timed = await registry.wait(first.id, 5);
	assert.equal(timed.timedOut, true);
	const interrupted = await registry.interrupt(first.id);
	assert.equal(interrupted.state, "interrupted");
	assert.equal((await registry.wait(second.id, 100)).agent.state, "completed");
	await registry.followUp(first.id, "again");
	const completed = await registry.wait(first.id, 100);
	assert.equal(completed.agent.state, "completed");
	assert.deepEqual(
		completed.agent.history.map((turn) => turn.task),
		["slow", "again"],
	);
	await assert.rejects(
		() => registry.spawn({ agent: "worker", task: "over", cwd: process.cwd() }),
		/capacity/,
	);
	assert.equal((await registry.close(first.id)).state, "closed");
	await assert.rejects(() => registry.close(first.id), /already closed/);
});

test("AgentRegistry shutdown aborts active work and drains queued work without starting it", async () => {
	const started: string[] = [];
	const registry = new AgentRegistry(
		async (_agent, task, signal) => {
			started.push(task);
			await new Promise<void>((resolve) =>
				signal.addEventListener("abort", () => resolve(), { once: true }),
			);
			return { output: "stopped", exitCode: 130, aborted: true };
		},
		{ maxActiveTurns: 1 },
	);
	const active = await registry.spawn({ agent: "scout", task: "active", cwd: process.cwd() });
	const queued = await registry.spawn({ agent: "scout", task: "queued", cwd: process.cwd() });
	await registry.shutdown();
	assert.deepEqual(started, ["active"]);
	assert.equal(registry.get(active.id)?.state, "idle");
	assert.equal(registry.get(queued.id)?.state, "idle");
});

test("AgentRegistry evicts expired idle agents without touching active work", async () => {
	let now = 1_000;
	const registry = new AgentRegistry(async () => ({ output: "done", exitCode: 0 }), {
		idleTtlMs: 100,
		now: () => now,
	});
	const agent = await registry.spawn({ agent: "scout", task: "done", cwd: process.cwd() });
	await registry.wait(agent.id, 100);
	now += 101;
	assert.equal(await registry.sweepExpired(), 1);
	assert.equal(registry.get(agent.id), undefined);
});

test("AgentRegistry keeps lifecycle usable when persistence callbacks fail", async () => {
	const registry = new AgentRegistry(async () => ({ output: "done", exitCode: 0 }), {
		onChange: async () => {
			throw new Error("disk unavailable");
		},
	});
	const agent = await registry.spawn({ agent: "scout", task: "done", cwd: process.cwd() });
	assert.equal((await registry.wait(agent.id, 100)).agent.state, "completed");
});

test("AgentRegistry restores persisted running agents as inert idle agents", () => {
	const registry = new AgentRegistry(async () => ({ output: "", exitCode: 0 }));
	registry.restore([record({ state: "running", currentTask: "must not resume" })]);
	const restored = registry.get("sa_test");
	assert.equal(restored?.state, "idle");
	assert.equal(restored?.currentTask, undefined);
});

test("AgentPersistence atomically saves, restores, redacts, deletes, and quarantines bad state", async () => {
	const dir = mkdtempSync(path.join(os.tmpdir(), "pi-subagent-state-"));
	const persistence = new AgentPersistence("session", { stateDir: dir, maxStoredAgents: 2 });
	await persistence.save([
		record({
			context: "<private>secret</private>",
			history: [
				{
					task: "task",
					output: "[subagent-private] hidden\nvisible",
					startedAt: 1,
					completedAt: 2,
					exitCode: 0,
				},
			],
		}),
	]);
	const raw = readFileSync(persistence.filePath, "utf8");
	assert.doesNotMatch(raw, /secret|hidden/);
	assert.equal(persistence.load()[0]?.state, "idle");
	const competing = new AgentPersistence("session", { stateDir: dir, maxStoredAgents: 2 });
	await Promise.all([
		persistence.save([record({ id: "one" })]),
		competing.save([record({ id: "two" })]),
	]);
	assert.ok(["one", "two"].includes(persistence.load()[0]?.id ?? ""));
	await persistence.delete();
	assert.deepEqual(persistence.load(), []);
	writeFileSync(persistence.filePath, JSON.stringify({ version: 999, agents: [] }));
	assert.deepEqual(persistence.load(), []);
	writeFileSync(persistence.filePath, "not json");
	assert.deepEqual(persistence.load(), []);
	assert.ok(
		readdirSync(dir).some((name) =>
			name.startsWith(`${path.basename(persistence.filePath)}.invalid-`),
		),
	);
});

test("stateful tools are opt-in and expose the complete lifecycle surface", async () => {
	const originalDir = process.env.PI_CODING_AGENT_DIR;
	const dir = mkdtempSync(path.join(os.tmpdir(), "pi-subagent-config-"));
	process.env.PI_CODING_AGENT_DIR = dir;
	try {
		writeFileSync(
			path.join(dir, "pi-subagents-config.json"),
			JSON.stringify({ stateful: { enabled: true } }),
		);
		const mock = createMockPi();
		registerStatefulSubagents(mock.pi);
		assert.deepEqual(
			mock.tools.map((tool) => tool.name),
			[
				"subagent_spawn",
				"subagent_send",
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
		};
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
	} finally {
		if (originalDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = originalDir;
	}
});

test("stateful settings validate bounded runtime options without breaking agent overrides", () => {
	assert.deepEqual(
		normalizeSubagentSettings({ stateful: { enabled: true, maxAgents: 8 }, agents: {} }),
		{
			stateful: { enabled: true, maxAgents: 8 },
		},
	);
	assert.equal(normalizeSubagentSettings({ stateful: { maxAgents: 0 } }), undefined);
});

test("runSingleAgent normalizes invalid cwd without spawning or throwing", async () => {
	const result = await runSingleAgent(
		process.cwd(),
		[
			{
				name: "test",
				description: "test",
				systemPrompt: "",
				source: "built-in",
				filePath: "built-in:test",
			},
		],
		"test",
		"task",
		path.join(os.tmpdir(), "definitely-missing-pi-subagent-cwd"),
		undefined,
		undefined,
		undefined,
		100,
		undefined,
		(results) => ({ mode: "single", agentScope: "user", projectAgentsDir: null, results }),
	);
	assert.equal(result.exitCode, 1);
	assert.equal(result.stopReason, "error");
	assert.match(result.errorMessage ?? "", /Invalid subagent cwd/);
});

test("runSingleAgent preserves partial output on mid-stream abort and handles pre-abort", async () => {
	const script = [
		"const message={role:'assistant',content:[{type:'text',text:'PARTIAL'}],timestamp:Date.now()};",
		"process.stdout.write(JSON.stringify({type:'message_end',message})+'\\n');",
		"setInterval(()=>{},1000);",
	].join("");
	const agents = [
		{
			name: "test",
			description: "test",
			systemPrompt: "",
			source: "built-in" as const,
			filePath: "built-in:test",
		},
	];
	const makeDetails = (results: Parameters<Parameters<typeof runSingleAgent>[10]>[0]) => ({
		mode: "single" as const,
		agentScope: "user" as const,
		projectAgentsDir: null,
		results,
	});
	const controller = new AbortController();
	let sawPartial = false;
	const running = runSingleAgent(
		process.cwd(),
		agents,
		"test",
		"task",
		undefined,
		undefined,
		controller.signal,
		undefined,
		1_000,
		(partial) => {
			if (partial.content[0]?.type === "text" && partial.content[0].text === "PARTIAL") {
				sawPartial = true;
				controller.abort();
			}
		},
		makeDetails,
		{ command: process.execPath, argsPrefix: ["-e", script, "--"] },
	);
	const aborted = await running;
	assert.equal(sawPartial, true);
	assert.equal(aborted.aborted, true);
	assert.equal(aborted.exitCode, 130);
	assert.equal(aborted.finalOutput, "PARTIAL");

	const preAborted = new AbortController();
	preAborted.abort();
	const beforeStart = await runSingleAgent(
		process.cwd(),
		agents,
		"test",
		"task",
		undefined,
		undefined,
		preAborted.signal,
		undefined,
		1_000,
		undefined,
		makeDetails,
		{ command: process.execPath, argsPrefix: ["-e", "setInterval(()=>{},1000)", "--"] },
	);
	assert.equal(beforeStart.aborted, true);
	assert.equal(beforeStart.exitCode, 130);
});

test("terminateProcess escalates when a child ignores SIGTERM", {
	skip: process.platform === "win32",
}, async () => {
	const child = spawn(
		process.execPath,
		[
			"-e",
			"process.on('SIGTERM',()=>{}); process.stdout.write('ready\\n'); setInterval(()=>{},1000)",
		],
		{ detached: true, stdio: ["ignore", "pipe", "ignore"] },
	);
	await new Promise<void>((resolve) => child.stdout?.once("data", () => resolve()));
	const started = Date.now();
	terminateProcess(child, 30);
	await new Promise<void>((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error("child did not exit")), 1000);
		child.once("close", () => {
			clearTimeout(timer);
			resolve();
		});
	});
	assert.ok(Date.now() - started < 1000);
});
