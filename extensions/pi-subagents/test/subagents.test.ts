import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createMockContext, createMockPi } from "../../../test/support.js";
import { discoverAgents, formatAgentList } from "../src/agents.js";
import subagents, {
	buildPiArgs,
	formatTokens,
	formatUsageStats,
	normalizeSubagentSettings,
	parsePositiveInteger,
	resolveSubagentThinkingLevel,
	sameToolSet,
	uniqueToolNames,
} from "../src/subagents.js";

type SchemaObject = {
	properties?: Record<string, SchemaObject>;
	items?: SchemaObject;
	enum?: string[];
	description?: string;
};

type SubagentTool = {
	execute: (...args: unknown[]) => Promise<{
		details?: {
			results: Array<{ thinkingLevel?: string }>;
			aggregator?: { thinkingLevel?: string };
		};
	}>;
};

test("subagents registers self-directed fan-out guidance and configuration command", () => {
	const mock = createMockPi();
	subagents(mock.pi);

	const tool = mock.tools[0];
	assert.equal(tool?.name, "subagent");
	assert.match(String(tool?.promptSnippet), /decide whether to spawn 0, 1, or multiple subagents/i);

	const promptGuidelines = tool?.promptGuidelines;
	assert.ok(Array.isArray(promptGuidelines));
	const guidanceText = promptGuidelines.join("\n");
	assert.match(guidanceText, /decide how many subagents to spawn/i);
	assert.match(guidanceText, /no subagent/i);
	assert.match(guidanceText, /blocking subagent/i);
	assert.match(guidanceText, /one-shot.*parallel.*single.*subagent.*call/i);
	assert.match(guidanceText, /critical-path/i);
	assert.match(guidanceText, /subagent_spawn.*parallel, isolation, or specialization benefit/i);
	assert.match(
		guidanceText,
		/call subagent_wait when coordination is the only useful next action/i,
	);
	assert.match(guidanceText, /do not yield permanently/i);
	assert.match(guidanceText, /synthesize their results/i);
	assert.match(guidanceText, /2-4 parallel read-only subagents/i);
	assert.match(guidanceText, /hard max 8/i);

	const parameters = tool?.parameters as SchemaObject | undefined;
	const thinkingLevels = ["off", "minimal", "low", "medium", "high", "xhigh"];
	assert.deepEqual(parameters?.properties?.thinkingLevel?.enum, thinkingLevels);
	assert.doesNotMatch(parameters?.properties?.thinkingLevel?.enum?.join(",") ?? "", /huge/);
	assert.match(parameters?.properties?.thinkingLevel?.description ?? "", /off.*minimal.*xhigh/);
	assert.deepEqual(
		parameters?.properties?.tasks?.items?.properties?.thinkingLevel?.enum,
		thinkingLevels,
	);
	assert.deepEqual(
		parameters?.properties?.chain?.items?.properties?.thinkingLevel?.enum,
		thinkingLevels,
	);
	assert.deepEqual(
		parameters?.properties?.aggregator?.properties?.thinkingLevel?.enum,
		thinkingLevels,
	);
	assert.ok(mock.commands.has("subagents:config"));
	const toolResultHandler = mock.events.get("tool_result")?.[0];
	assert.deepEqual(
		toolResultHandler?.(
			{ toolName: "subagent", details: { isError: true } },
			createMockContext().ctx,
		),
		{ isError: true },
	);
});

test("subagent recursion guard rejects nested delegation before spawning", async () => {
	const mock = createMockPi();
	subagents(mock.pi);
	const tool = mock.tools[0] as SubagentTool;
	const originalDepth = process.env.PI_SUBAGENT_DEPTH;
	process.env.PI_SUBAGENT_DEPTH = "1";
	try {
		await assert.rejects(
			() =>
				tool.execute(
					"call",
					{ agent: "scout", task: "nested" },
					undefined,
					undefined,
					createMockContext().ctx,
				),
			/recursion depth limit/,
		);
	} finally {
		if (originalDepth === undefined) delete process.env.PI_SUBAGENT_DEPTH;
		else process.env.PI_SUBAGENT_DEPTH = originalDepth;
	}
});

test("one-shot project agents require project trust even when confirmation is disabled", async () => {
	const cwd = mkdtempSync(path.join(os.tmpdir(), "pi-subagents-untrusted-"));
	const agentsDir = path.join(cwd, ".pi", "agents");
	mkdirSync(agentsDir, { recursive: true });
	writeFileSync(
		path.join(agentsDir, "project.md"),
		"---\nname: project\ndescription: project agent\n---\nProject prompt.",
	);
	const mock = createMockPi();
	subagents(mock.pi);
	const tool = mock.tools[0] as SubagentTool;
	await assert.rejects(
		() =>
			tool.execute(
				"call",
				{
					agent: "project",
					task: "task",
					agentScope: "project",
					confirmProjectAgents: false,
				},
				undefined,
				undefined,
				createMockContext({ cwd, isProjectTrusted: () => false }).ctx,
			),
		/trusted project/,
	);
});

test("discoverAgents includes built-ins and lets project agents override by name", () => {
	const cwd = mkdtempSync(path.join(os.tmpdir(), "pi-subagents-test-"));
	const agentsDir = path.join(cwd, ".pi", "agents");
	mkdirSync(agentsDir, { recursive: true });
	writeFileSync(
		path.join(agentsDir, "scout.md"),
		[
			"---",
			"name: scout",
			"description: Project-specific scout",
			"tools: read,bash",
			"model: gpt-test",
			"thinkingLevel: high",
			"---",
			"Project scout prompt.",
		].join("\n"),
	);

	const baseResult = discoverAgents(cwd, "project");
	const baseScout = baseResult.agents.find((agent) => agent.name === "scout");
	assert.equal(baseScout?.thinkingLevel, "high");

	const result = discoverAgents(cwd, "project", {
		agents: { scout: { timeoutMs: 1234, thinkingLevel: "low" } },
	});
	const scout = result.agents.find((agent) => agent.name === "scout");

	assert.equal(result.projectAgentsDir, agentsDir);
	assert.equal(scout?.source, "project");
	assert.deepEqual(scout?.tools, ["read", "bash"]);
	assert.equal(scout?.model, "gpt-test");
	assert.equal(scout?.thinkingLevel, "low");
	assert.equal(scout?.timeoutMs, 1234);

	const cleared = discoverAgents(cwd, "project", { agents: { scout: { thinkingLevel: null } } });
	assert.equal(cleared.agents.find((agent) => agent.name === "scout")?.thinkingLevel, undefined);
	assert.ok(result.agents.some((agent) => agent.name === "worker" && agent.source === "built-in"));
});

test("formatAgentList returns concise text and remaining count", () => {
	const agents = discoverAgents(process.cwd(), "project").agents;
	const formatted = formatAgentList(agents, 2);

	assert.match(formatted.text, /scout \(built-in\)/);
	assert.equal(formatted.remaining, Math.max(0, agents.length - 2));
});

test("subagent settings normalize known override fields only", () => {
	assert.deepEqual(
		normalizeSubagentSettings({
			agents: {
				scout: { tools: ["read"], model: null, timeoutMs: 1, thinkingLevel: "medium" },
				clearThinking: { thinkingLevel: null },
				bad: { tools: [1] },
				badThinking: { thinkingLevel: "huge" },
			},
		}),
		{
			agents: {
				scout: { tools: ["read"], model: null, timeoutMs: 1, thinkingLevel: "medium" },
				clearThinking: { thinkingLevel: null },
			},
		},
	);
	assert.equal(normalizeSubagentSettings({ agents: [] }), undefined);
});

test("subagent formatting and set helpers are deterministic", () => {
	assert.equal(parsePositiveInteger("42ms"), 42);
	assert.equal(parsePositiveInteger("0"), undefined);
	assert.equal(formatTokens(1530), "1.5k");
	assert.equal(
		formatUsageStats(
			{ input: 1500, output: 20, cacheRead: 0, cacheWrite: 0, cost: 0.0123, turns: 2 },
			"gpt",
		),
		"2 turns ↑1.5k ↓20 $0.0123 gpt",
	);
	assert.equal(
		formatUsageStats(
			{ input: 1500, output: 20, cacheRead: 0, cacheWrite: 0, cost: 0.0123, turns: 2 },
			"gpt",
			"high",
		),
		"2 turns ↑1.5k ↓20 $0.0123 gpt thinking:high",
	);
	assert.deepEqual(uniqueToolNames(["read", "read", "bash"]), ["read", "bash"]);
	assert.equal(sameToolSet(["read", "bash"], ["bash", "read"]), true);
});

test("subagent thinking levels resolve by local, top-level, then agent default", () => {
	const agents = [{ name: "scout", thinkingLevel: "low" }, { name: "reviewer" }] as const;

	assert.equal(resolveSubagentThinkingLevel(agents, "scout", "medium", "high"), "high");
	assert.equal(resolveSubagentThinkingLevel(agents, "scout", "medium"), "medium");
	assert.equal(resolveSubagentThinkingLevel(agents, "scout"), "low");
	assert.equal(resolveSubagentThinkingLevel(agents, "reviewer"), undefined);
	assert.equal(resolveSubagentThinkingLevel(agents, "missing", "minimal"), "minimal");
});

test("buildPiArgs passes thinking only when requested", () => {
	assert.deepEqual(buildPiArgs({ task: "do it" }), [
		"--mode",
		"json",
		"-p",
		"--no-session",
		"Task: do it",
	]);
	assert.deepEqual(
		buildPiArgs({
			model: "sonnet",
			thinkingLevel: "high",
			tools: ["read", "bash"],
			systemPromptPath: "/tmp/prompt.md",
			task: "review code",
		}),
		[
			"--mode",
			"json",
			"-p",
			"--no-session",
			"--model",
			"sonnet",
			"--thinking",
			"high",
			"--tools",
			"read,bash",
			"--append-system-prompt",
			"/tmp/prompt.md",
			"Task: review code",
		],
	);
	assert.deepEqual(buildPiArgs({ thinkingLevel: "off", tools: [], task: "no tools" }), [
		"--mode",
		"json",
		"-p",
		"--no-session",
		"--thinking",
		"off",
		"--no-tools",
		"Task: no tools",
	]);
});

test("subagent execute resolves thinking level in single, chain, parallel, and aggregator modes", async () => {
	const mock = createMockPi();
	subagents(mock.pi);
	const tool = mock.tools[0] as SubagentTool;
	const { ctx } = createMockContext();
	const signal = new AbortController().signal;

	const single = await tool.execute(
		"single",
		{ agent: "missing", task: "single", thinkingLevel: "medium" },
		signal,
		() => undefined,
		ctx,
	);
	assert.equal(single.details?.results[0]?.thinkingLevel, "medium");

	const chain = await tool.execute(
		"chain",
		{
			thinkingLevel: "low",
			chain: [{ agent: "missing", task: "chain", thinkingLevel: "high" }],
		},
		signal,
		() => undefined,
		ctx,
	);
	assert.equal(chain.details?.results[0]?.thinkingLevel, "high");

	const parallel = await tool.execute(
		"parallel",
		{
			thinkingLevel: "minimal",
			tasks: [
				{ agent: "missing", task: "inherits top level" },
				{ agent: "missing", task: "local override", thinkingLevel: "off" },
			],
			aggregator: { agent: "missing", task: "aggregate", thinkingLevel: "xhigh" },
		},
		signal,
		() => undefined,
		ctx,
	);
	assert.equal(parallel.details?.results[0]?.thinkingLevel, "minimal");
	assert.equal(parallel.details?.results[1]?.thinkingLevel, "off");
	assert.equal(parallel.details?.aggregator?.thinkingLevel, "xhigh");
});
