import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "vitest";
import { createMockContext, createMockPi } from "../../../test/support.js";
import { discoverAgents } from "../src/agents.js";
import subagentsV3 from "../src/subagents-v3.js";
import type { ChildRequest, ChildResult } from "../src/types.js";

interface RegisteredTool {
	name: string;
	description: string;
	parameters: {
		properties?: Record<
			string,
			{ description?: string; minimum?: number; maximum?: number; maxLength?: number }
		>;
	};
	prepareArguments?: (args: unknown) => unknown;
	execute: (
		toolCallId: string,
		params: Record<string, unknown>,
		signal: AbortSignal | undefined,
		onUpdate: ((value: unknown) => void) | undefined,
		ctx: unknown,
	) => Promise<{
		content: Array<{ type: string; text: string }>;
		details: Record<string, unknown>;
	}>;
}

let agentDirectory: string;
let previousAgentDirectory: string | undefined;

beforeEach(() => {
	previousAgentDirectory = process.env.PI_CODING_AGENT_DIR;
	agentDirectory = mkdtempSync(path.join(os.tmpdir(), "pi-subagents-v3-agent-"));
	process.env.PI_CODING_AGENT_DIR = agentDirectory;
	delete process.env.PI_SUBAGENT_DEPTH;
});

afterEach(() => {
	if (previousAgentDirectory === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = previousAgentDirectory;
	delete process.env.PI_SUBAGENT_DEPTH;
	rmSync(agentDirectory, { recursive: true, force: true });
});

test("registers only the five minimal subagent-v3 tools with bounded schemas", () => {
	const mock = createMockPi();
	subagentsV3(mock.pi);
	const tools = mock.tools as unknown as RegisteredTool[];
	assert.deepEqual(
		tools.map((tool) => tool.name),
		[
			"subagent-v3-start",
			"subagent-v3-inspect",
			"subagent-v3-cancel",
			"subagent-v3-wait",
			"subagent-v3-consult",
		],
	);
	assert.equal(tools[0]?.parameters.properties?.task?.maxLength, 50 * 1024);
	assert.equal(
		tools[0]?.parameters.properties?.timeout?.description,
		"Timeout in seconds (optional, no default timeout)",
	);
	assert.equal(tools[0]?.parameters.properties?.timeoutMs, undefined);
	assert.equal(
		tools[3]?.parameters.properties?.timeout?.description,
		"Timeout in seconds (optional, no default timeout)",
	);
	assert.equal(tools[3]?.parameters.properties?.timeoutMs, undefined);
	assert.deepEqual(
		tools[0]?.prepareArguments?.({ agent: "worker", task: "old", timeoutMs: 1500 }),
		{
			agent: "worker",
			task: "old",
			timeout: 1.5,
		},
	);
	assert.deepEqual(tools[3]?.prepareArguments?.({ jobId: "job_old", timeoutMs: 30_000 }), {
		jobId: "job_old",
		timeout: 30,
	});
	assert.deepEqual(Object.keys(tools[1]?.parameters.properties ?? {}), []);
	assert.match(tools[4]?.description ?? "", /read-only/i);
	assert.deepEqual([...mock.commands.keys()], []);
});

test("rejects invalid execution timeouts with Pi bash semantics", async () => {
	const mock = createMockPi();
	subagentsV3(mock.pi);
	const start = tool(mock, "subagent-v3-start");
	const context = createMockContext();
	await assert.rejects(
		() =>
			start.execute(
				"non-positive",
				{ agent: "worker", task: "task", timeout: 0 },
				undefined,
				undefined,
				context.ctx,
			),
		/Invalid timeout: must be a finite number of seconds/,
	);
	await assert.rejects(
		() =>
			start.execute(
				"oversized",
				{ agent: "worker", task: "task", timeout: 2_147_483.648 },
				undefined,
				undefined,
				context.ctx,
			),
		/Invalid timeout: maximum is 2147483\.647 seconds/,
	);
});

test("starts in the background, delivers one completion, and returns terminal output from wait", async () => {
	let resolveChild!: (result: ChildResult) => void;
	const child = new Promise<ChildResult>((resolve) => {
		resolveChild = resolve;
	});
	let childRequest: ChildRequest | undefined;
	const mock = createMockPi();
	subagentsV3(mock.pi, {
		runChild: async (request) => {
			childRequest = request;
			return child;
		},
	});
	const context = createMockContext({ cwd: process.cwd(), isProjectTrusted: () => false });
	const start = tool(mock, "subagent-v3-start");
	const wait = tool(mock, "subagent-v3-wait");
	const inspect = tool(mock, "subagent-v3-inspect");
	const started = await start.execute(
		"start",
		{ agent: "explorer", task: "Inspect one thing", timeout: 1 },
		undefined,
		undefined,
		context.ctx,
	);
	assert.equal(started.details.state, "queued");
	assert.equal(started.details.timeout, 1);
	const jobId = String(started.details.jobId);
	await Promise.resolve();
	assert.equal(childRequest?.timeout, 1);
	const running = await inspect.execute("inspect", {}, undefined, undefined, context.ctx);
	assert.equal((running.details.jobs as Array<{ state: string }>)[0]?.state, "running");

	resolveChild({
		state: "completed",
		result: "Grounded result",
		limitations: [],
		truncated: false,
	});
	const terminal = await wait.execute("wait", { jobId }, undefined, undefined, context.ctx);
	assert.deepEqual(terminal.details, {
		jobId,
		state: "completed",
		timedOut: false,
		result: "Grounded result",
	});
	assert.equal(mock.sentMessages.length, 1);
	assert.equal(
		(mock.sentMessages[0]?.message as { customType?: unknown } | undefined)?.customType,
		"pi-subagents-v3-completion",
	);
	assert.deepEqual(mock.sentMessages[0]?.options, { deliverAs: "steer" });
	const completedInspection = await inspect.execute(
		"inspect-completed",
		{},
		undefined,
		undefined,
		context.ctx,
	);
	assert.doesNotMatch(
		JSON.stringify([running.details, completedInspection.details]),
		/Inspect one thing|Grounded result/,
	);
});

test("wait timeout leaves the job active and cancellation rejects a stale late result", async () => {
	let resolveChild!: (result: ChildResult) => void;
	const mock = createMockPi();
	subagentsV3(mock.pi, {
		runChild: ({ signal }) =>
			new Promise<ChildResult>((resolve) => {
				resolveChild = resolve;
				signal.addEventListener(
					"abort",
					() =>
						resolve({
							state: "completed",
							result: "stale completion",
							limitations: [],
							truncated: false,
						}),
					{ once: true },
				);
			}),
	});
	const context = createMockContext();
	const started = await tool(mock, "subagent-v3-start").execute(
		"start",
		{ agent: "worker", task: "bounded task" },
		undefined,
		undefined,
		context.ctx,
	);
	assert.equal(started.details.timeout, undefined);
	const jobId = String(started.details.jobId);
	await Promise.resolve();
	const waited = await tool(mock, "subagent-v3-wait").execute(
		"wait",
		{ jobId, timeout: 0.001 },
		undefined,
		undefined,
		context.ctx,
	);
	assert.deepEqual(waited.details, { jobId, state: "running", timedOut: true });
	const waitController = new AbortController();
	waitController.abort();
	await assert.rejects(
		() =>
			tool(mock, "subagent-v3-wait").execute(
				"wait-cancelled",
				{ jobId },
				waitController.signal,
				undefined,
				context.ctx,
			),
		(error: Error) => error.name === "AbortError",
	);

	const cancelTool = tool(mock, "subagent-v3-cancel");
	const cancelled = await cancelTool.execute(
		"cancel",
		{ jobId },
		undefined,
		undefined,
		context.ctx,
	);
	assert.deepEqual(cancelled.details, { jobId, state: "cancelled" });
	assert.deepEqual(
		(await cancelTool.execute("cancel-again", { jobId }, undefined, undefined, context.ctx))
			.details,
		{ jobId, state: "cancelled" },
	);
	resolveChild({
		state: "completed",
		result: "another stale completion",
		limitations: [],
		truncated: false,
	});
	await Promise.resolve();
	const terminal = await tool(mock, "subagent-v3-wait").execute(
		"wait-terminal",
		{ jobId },
		undefined,
		undefined,
		context.ctx,
	);
	assert.equal(terminal.details.state, "cancelled");
	assert.doesNotMatch(JSON.stringify(terminal.details), /stale completion/);
	assert.equal(mock.sentMessages.length, 1);
});

test("consult enforces the read-only request and shutdown suppresses stale delivery", async () => {
	const requests: ChildRequest[] = [];
	const mock = createMockPi();
	subagentsV3(mock.pi, {
		runConsultChild: async (request) => {
			requests.push(request);
			return {
				state: "completed",
				result: "Consulted",
				limitations: [],
				truncated: false,
			};
		},
		runChild: async ({ signal }) => {
			await new Promise<void>((resolve) =>
				signal.addEventListener("abort", () => resolve(), { once: true }),
			);
			return {
				state: "cancelled",
				error: "cancelled",
				limitations: [],
				truncated: false,
			};
		},
	});
	const context = createMockContext();
	const consulted = await tool(mock, "subagent-v3-consult").execute(
		"consult",
		{ agent: "worker", task: "Review without editing" },
		undefined,
		undefined,
		context.ctx,
	);
	assert.equal(consulted.details.state, "completed");
	assert.equal(requests[0]?.readOnly, true);
	assert.equal(requests[0]?.timeout, undefined);

	await tool(mock, "subagent-v3-start").execute(
		"start",
		{ agent: "worker", task: "Long work" },
		undefined,
		undefined,
		context.ctx,
	);
	await Promise.resolve();
	for (const handler of mock.events.get("session_shutdown") ?? []) {
		await handler({ reason: "quit" }, context.ctx);
	}
	assert.equal(mock.sentMessages.length, 0);
});

test("trusted project agents override user agents and inspection exposes only bounded metadata", async () => {
	const userAgents = path.join(agentDirectory, "agents");
	mkdirSync(userAgents, { recursive: true });
	writeFileSync(
		path.join(userAgents, "reviewer.md"),
		"---\nname: reviewer\ndescription: User reviewer\ntools: read\n---\nUser prompt\n",
	);
	const project = mkdtempSync(path.join(os.tmpdir(), "pi-subagents-v3-project-"));
	try {
		const projectAgents = path.join(project, ".pi", "agents");
		mkdirSync(projectAgents, { recursive: true });
		writeFileSync(
			path.join(projectAgents, "reviewer.md"),
			"---\nname: reviewer\ndescription: Project reviewer\ntools: read\ntimeoutMs: 1\n---\nSECRET PROJECT PROMPT\n",
		);
		const mock = createMockPi();
		subagentsV3(mock.pi);
		const inspect = tool(mock, "subagent-v3-inspect");
		const untrusted = await inspect.execute(
			"inspect-user",
			{},
			undefined,
			undefined,
			createMockContext({ cwd: project, isProjectTrusted: () => false }).ctx,
		);
		const trusted = await inspect.execute(
			"inspect-project",
			{},
			undefined,
			undefined,
			createMockContext({ cwd: project, isProjectTrusted: () => true }).ctx,
		);
		const userReviewer = (untrusted.details.agents as Array<Record<string, unknown>>).find(
			(agent) => agent.name === "reviewer",
		);
		const projectReviewer = (trusted.details.agents as Array<Record<string, unknown>>).find(
			(agent) => agent.name === "reviewer",
		);
		assert.equal(userReviewer?.source, "user");
		assert.equal(projectReviewer?.source, "project");
		const discoveredReviewer = discoverAgents(project, true).agents.find(
			(candidate) => candidate.name === "reviewer",
		);
		assert.equal(Object.hasOwn(discoveredReviewer ?? {}, "timeoutMs"), false);
		assert.doesNotMatch(JSON.stringify(trusted.details), /SECRET PROJECT PROMPT/);
	} finally {
		rmSync(project, { recursive: true, force: true });
	}
});

function tool(mock: ReturnType<typeof createMockPi>, name: string): RegisteredTool {
	const registered = (mock.tools as unknown as RegisteredTool[]).find(
		(candidate) => candidate.name === name,
	);
	assert.ok(registered, `Missing tool ${name}`);
	return registered;
}
