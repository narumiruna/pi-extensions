import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, test } from "vitest";
import { createMockContext, createMockPi } from "../../../test/support.js";
import subagents from "../src/subagents.js";
import {
	installSubagentsTestEnvironment,
	type SchemaObject,
	type SubagentTool,
} from "./subagents-test-helpers.js";

const restoreTestEnvironment = installSubagentsTestEnvironment();
afterAll(restoreTestEnvironment);

test("subagents registers consistent blocking guidance and one management command", () => {
	const mock = createMockPi();
	subagents(mock.pi);

	assert.deepEqual(
		mock.tools.map((candidate) => candidate.name),
		[
			"subagent",
			"subagent_spawn",
			"subagent_send",
			"subagent_await",
			"subagent_manage",
			"subagent_mailbox",
			"subagent_inspect",
			"subagent_consult",
		],
	);
	const tool = mock.tools[0];
	assert.equal(tool?.name, "subagent");
	assert.equal(tool?.label, "Blocking Subagent · Deprecated");
	assert.match(String(tool?.description), /deprecated compatibility tool/i);
	assert.match(String(tool?.description), /blocks the main agent/i);
	assert.match(String(tool?.description), /queued steering/i);
	assert.match(String(tool?.description), /subagent_spawn/i);
	assert.match(String(tool?.description), /subagent_await/i);
	assert.match(String(tool?.promptSnippet), /deprecated.*blocking/i);

	const promptGuidelines = tool?.promptGuidelines;
	assert.ok(Array.isArray(promptGuidelines));
	const guidanceText = promptGuidelines.join("\n");
	assert.match(guidanceText, /subagent.*deprecated/i);
	assert.match(guidanceText, /existing caller|explicit user request/i);
	assert.match(guidanceText, /subagent_spawn.*subagent_await/i);
	assert.match(guidanceText, /chain.*fan-in.*panel.*workflow/i);
	assert.match(guidanceText, /decide how many subagents to spawn/i);
	assert.match(guidanceText, /no subagent/i);
	assert.match(guidanceText, /critical-path work.*main agent can perform directly/i);
	assert.match(
		guidanceText,
		/main agent.*planning.*critical-path.*integration.*final verification.*final answer/i,
	);
	assert.match(
		guidanceText,
		/one ordinary implementation worker.*should not replace.*main agent.*directly/i,
	);
	assert.match(guidanceText, /ordinary planning.*main agent.*explicit.*workflow/i);
	assert.match(guidanceText, /ordinary review.*main agent.*review skill.*deterministic checks/i);
	assert.doesNotMatch(guidanceText, /critical-path work needed for.*next action/i);
	assert.doesNotMatch(guidanceText, /use subagent parallel mode with 2-4/i);
	assert.match(guidanceText, /configured maximum.*session-guidance/i);
	assert.match(String(tool?.description), /current call limit.*session-guidance/i);
	assert.doesNotMatch(`${guidanceText}\n${String(tool?.description)}`, /configured max 8/i);
	assert.match(guidanceText, /omit the aggregator key entirely/i);
	assert.match(guidanceText, /null, empty strings, or an empty object/i);

	const parameters = tool?.parameters as SchemaObject | undefined;
	const thinkingLevels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
	assert.deepEqual(parameters?.properties?.thinkingLevel?.enum, thinkingLevels);
	assert.doesNotMatch(parameters?.properties?.thinkingLevel?.enum?.join(",") ?? "", /huge/);
	assert.match(
		parameters?.properties?.thinkingLevel?.description ?? "",
		/off.*minimal.*xhigh.*max/,
	);
	assert.deepEqual(
		parameters?.properties?.tasks?.items?.properties?.thinkingLevel?.enum,
		thinkingLevels,
	);
	assert.equal(parameters?.properties?.tasks?.maxItems, 64);
	assert.deepEqual(
		parameters?.properties?.chain?.items?.properties?.thinkingLevel?.enum,
		thinkingLevels,
	);
	assert.deepEqual(
		parameters?.properties?.aggregator?.properties?.thinkingLevel?.enum,
		thinkingLevels,
	);
	const resultFormats = ["text", "structured-v1", "structured-v2"];
	assert.deepEqual(parameters?.properties?.resultFormat?.enum, resultFormats);
	assert.deepEqual(
		parameters?.properties?.tasks?.items?.properties?.resultFormat?.enum,
		resultFormats,
	);
	assert.deepEqual(
		parameters?.properties?.chain?.items?.properties?.resultFormat?.enum,
		resultFormats,
	);
	assert.deepEqual(
		parameters?.properties?.aggregator?.properties?.resultFormat?.enum,
		resultFormats,
	);
	assert.equal(
		parameters?.properties?.contract?.properties?.version?.const,
		"pi-subagents:delegation:v2",
	);
	assert.equal(parameters?.properties?.agent?.enum, undefined);
	assert.equal(parameters?.properties?.tasks?.items?.properties?.agent?.enum, undefined);
	assert.equal(parameters?.properties?.chain?.items?.properties?.agent?.enum, undefined);
	assert.equal(parameters?.properties?.aggregator?.properties?.agent?.enum, undefined);
	assert.match(parameters?.properties?.aggregator?.description ?? "", /omit this key entirely/i);
	assert.match(parameters?.properties?.aggregator?.description ?? "", /treated as absent/i);
	assert.match(parameters?.properties?.totalTimeoutMs?.description ?? "", /overall.*workflow/i);
	assert.match(parameters?.properties?.idleTimeoutMs?.description ?? "", /completed/i);
	assert.match(parameters?.properties?.maxTurns?.description ?? "", /assistant turns/i);
	assert.match(parameters?.properties?.maxToolCalls?.description ?? "", /tool calls/i);
	assert.match(guidanceText, /totalTimeoutMs.*blocking workflow/i);
	assert.match(guidanceText, /idleTimeoutMs.*stalled/i);
	assert.equal(
		mock.tools.find((candidate) => candidate.name === "subagent_auto"),
		undefined,
	);
	assert.deepEqual(
		[...mock.commands.keys()].filter((name) => name.startsWith("subagents")),
		["subagents"],
	);
	assert.deepEqual(mock.commands.get("subagents")?.getArgumentCompletions?.("s"), [
		{ value: "settings", label: "settings", description: "Open grouped subagent settings" },
		{ value: "status", label: "status", description: "Show detailed subagent diagnostics" },
	]);
	const toolResultHandler = mock.events.get("tool_result")?.[0];
	assert.deepEqual(
		toolResultHandler?.(
			{ toolName: "subagent", details: { isError: true } },
			createMockContext().ctx,
		),
		{ isError: true },
	);
});

test("deprecated blocking subagent warns once per UI session without changing execution", async () => {
	const result = {
		content: [{ type: "text" as const, text: "LEGACY_RESULT" }],
		details: {
			mode: "single" as const,
			agentScope: "user" as const,
			projectAgentsDir: null,
			results: [],
		},
	};
	let executions = 0;
	const createExtension = () => {
		const mock = createMockPi();
		subagents(mock.pi, {
			loadBlockingExecution: async () => ({
				executeSubagent: async () => {
					executions++;
					return result;
				},
			}),
		});
		return mock;
	};
	const mock = createExtension();
	const tool = mock.tools.find((candidate) => candidate.name === "subagent") as SubagentTool;
	const context = createMockContext({ mode: "tui", hasUI: true });
	const execute = () =>
		tool.execute(
			"deprecated-call",
			{ agent: "explorer", task: "compatibility task" },
			new AbortController().signal,
			undefined,
			context.ctx,
		);
	assert.deepEqual(await execute(), result);
	assert.deepEqual(await execute(), result);
	assert.equal(executions, 2);
	assert.equal(context.notifications.length, 1);
	assert.equal(context.notifications[0]?.level, "warning");
	assert.match(context.notifications[0]?.message ?? "", /subagent is deprecated/i);
	assert.match(context.notifications[0]?.message ?? "", /subagent_spawn/i);

	for (const handler of mock.events.get("session_start") ?? []) {
		await handler({ reason: "new" }, context.ctx);
	}
	assert.deepEqual(await execute(), result);
	assert.equal(context.notifications.length, 2, "a replacement session receives one new warning");
	for (const handler of mock.events.get("session_shutdown") ?? []) {
		await handler({ reason: "quit" }, context.ctx);
	}

	for (const mode of ["print", "json"] as const) {
		const headlessMock = createExtension();
		const headlessTool = headlessMock.tools.find(
			(candidate) => candidate.name === "subagent",
		) as SubagentTool;
		const headlessContext = createMockContext({ mode, hasUI: false });
		assert.deepEqual(
			await headlessTool.execute(
				`${mode}-call`,
				{ agent: "explorer", task: "compatibility task" },
				new AbortController().signal,
				undefined,
				headlessContext.ctx,
			),
			result,
		);
		assert.deepEqual(headlessContext.notifications, []);
	}

	const rpcMock = createExtension();
	const rpcTool = rpcMock.tools.find((candidate) => candidate.name === "subagent") as SubagentTool;
	const rpcContext = createMockContext({ mode: "rpc", hasUI: true });
	assert.deepEqual(
		await rpcTool.execute(
			"rpc-call",
			{ agent: "explorer", task: "compatibility task" },
			new AbortController().signal,
			undefined,
			rpcContext.ctx,
		),
		result,
	);
	assert.equal(rpcContext.notifications.length, 1);
	assert.equal(rpcContext.notifications[0]?.level, "warning");
});

test("blocking parallel calls honor the configured worker limit", async () => {
	const directory = mkdtempSync(path.join(os.tmpdir(), "pi-subagents-parallel-limit-"));
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = directory;
	try {
		writeFileSync(
			path.join(directory, "pi-subagents.json"),
			JSON.stringify({ blocking: { maxParallelTasks: 1 }, stateful: { enabled: false } }),
		);
		const mock = createMockPi();
		subagents(mock.pi);
		const tool = mock.tools.find((candidate) => candidate.name === "subagent") as SubagentTool;
		assert.ok(tool);
		assert.match(String(mock.tools[0]?.description), /current call limit.*session-guidance/i);
		const guidance = mock.tools[0]?.promptGuidelines;
		assert.ok(Array.isArray(guidance));
		assert.match(guidance.join("\n"), /configured maximum.*session-guidance/i);
		assert.doesNotMatch(
			`${String(mock.tools[0]?.description)}\n${guidance.join("\n")}`,
			/configured max 1/i,
		);

		await assert.rejects(
			() =>
				tool.execute(
					"parallel-limit",
					{
						tasks: [
							{ agent: "explorer", task: "first" },
							{
								agent: "reviewer",
								task: "second",
								cwd: path.join(directory, "missing"),
							},
						],
					},
					undefined,
					undefined,
					createMockContext().ctx,
				),
			/configured max is 1/i,
		);

		writeFileSync(
			path.join(directory, "pi-subagents.json"),
			JSON.stringify({ blocking: { maxParallelTasks: 9 }, stateful: { enabled: false } }),
		);
		const raisedMock = createMockPi();
		subagents(raisedMock.pi);
		const raisedTool = raisedMock.tools.find(
			(candidate) => candidate.name === "subagent",
		) as SubagentTool;
		const raisedResult = await raisedTool.execute(
			"raised-parallel-limit",
			{
				tasks: Array.from({ length: 9 }, (_, index) => ({
					agent: "missing",
					task: `task ${index + 1}`,
				})),
			},
			undefined,
			undefined,
			createMockContext().ctx,
		);
		assert.equal(raisedResult.details?.results.length, 9);
		assert.doesNotMatch(raisedResult.content?.[0]?.text ?? "", /too many parallel tasks/i);
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		rmSync(directory, { recursive: true, force: true });
	}
});
