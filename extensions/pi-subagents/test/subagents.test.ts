import assert from "node:assert/strict";
import {
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { createMockContext, createMockPi, driveCustomSelector } from "../../../test/support.js";
import { discoverAgents, formatAgentList } from "../src/agents.js";
import {
	registerSubagentConfigCommand,
	type SubagentSettingsRuntime,
	ToolToggleList,
} from "../src/config-ui.js";
import type { ManagedAgent } from "../src/registry.js";
import { consumeSubagentSettingsNotice } from "../src/settings.js";
import subagents, {
	buildPiArgs,
	formatTokens,
	formatUsageStats,
	inspectCompletionDeliverySettings,
	normalizeSubagentSettings,
	parsePositiveInteger,
	readSubagentSettings,
	resolveSubagentThinkingLevel,
	sameToolSet,
	saveSubagentConfig,
	uniqueToolNames,
	updateAgentToolsSetting,
	updateCompletionDeliverySetting,
} from "../src/subagents.js";

initTheme("dark", false);

type SchemaObject = {
	properties?: Record<string, SchemaObject>;
	items?: SchemaObject;
	enum?: string[];
	description?: string;
};

type SubagentTool = {
	execute: (...args: unknown[]) => Promise<{
		content?: Array<{ type: string; text: string }>;
		details?: {
			results: Array<{ thinkingLevel?: string }>;
			aggregator?: { thinkingLevel?: string };
		};
		isError?: boolean;
	}>;
};

test("subagents registers consistent blocking guidance and configuration command", () => {
	const mock = createMockPi();
	subagents(mock.pi);

	const tool = mock.tools[0];
	assert.equal(tool?.name, "subagent");
	assert.equal(tool?.label, "Blocking Subagent");
	assert.match(String(tool?.description), /blocks the main agent/i);
	assert.match(String(tool?.description), /queued steering/i);
	assert.doesNotMatch(String(tool?.description), /subagent_spawn/i);
	assert.match(String(tool?.promptSnippet), /blocking isolated subagents/i);

	const promptGuidelines = tool?.promptGuidelines;
	assert.ok(Array.isArray(promptGuidelines));
	const guidanceText = promptGuidelines.join("\n");
	assert.match(guidanceText, /decide how many subagents to spawn/i);
	assert.match(guidanceText, /no subagent/i);
	assert.match(guidanceText, /blocking subagent.*outputs.*required.*before/i);
	assert.match(guidanceText, /critical-path work.*main agent can perform directly/i);
	assert.doesNotMatch(guidanceText, /critical-path work needed for.*next action/i);
	assert.doesNotMatch(guidanceText, /subagent_spawn/i);
	assert.doesNotMatch(guidanceText, /use subagent parallel mode with 2-4/i);
	assert.match(guidanceText, /hard max 8/i);

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
	assert.deepEqual(
		parameters?.properties?.chain?.items?.properties?.thinkingLevel?.enum,
		thinkingLevels,
	);
	assert.deepEqual(
		parameters?.properties?.aggregator?.properties?.thinkingLevel?.enum,
		thinkingLevels,
	);
	assert.ok(mock.commands.has("subagents"));
	assert.ok(mock.commands.has("subagents:config"));
	assert.deepEqual(mock.commands.get("subagents")?.getArgumentCompletions?.("s"), [
		{ value: "settings", label: "settings", description: "Configure completion delivery" },
		{ value: "status", label: "status", description: "Show effective subagent settings" },
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

test("bare subagents opens a current-session manager and keeps direct routes predictable", async () => {
	const directory = mkdtempSync(path.join(os.tmpdir(), "pi-subagents-manager-"));
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = directory;
	try {
		const mock = createMockPi();
		subagents(mock.pi);
		const command = mock.commands.get("subagents");
		assert.ok(command);

		const managerRenders: string[][] = [];
		const managerContext = createMockContext({
			mode: "tui",
			hasUI: true,
			custom: async (factory: unknown) => {
				const driven = driveCustomSelector(factory, ["\u001b"], 52);
				managerRenders.push(...driven.renders);
				return driven.result;
			},
		});
		for (const handler of mock.events.get("session_start") ?? []) {
			await handler({}, managerContext.ctx);
		}
		await command.handler("", managerContext.ctx);
		assert.equal(managerRenders.length, 1);
		assert.ok(managerRenders.flat().every((line) => visibleWidth(line) <= 52));
		const managerText = managerRenders.flat().join("\n");
		assert.match(managerText, /Subagents/);
		assert.match(managerText, /Current session/);
		assert.match(managerText, /Lifecycle: enabled/);
		assert.match(managerText, /Transport: subprocess/);
		assert.match(managerText, /Completion delivery: next-turn/);
		assert.match(managerText, /Agents: 0 active.*0 retained/);
		assert.match(managerText, /User settings/);
		assert.match(managerText.replace(/\s+/gu, ""), /pi-subagents\.json/);
		assert.match(managerText, /Completion settings/);
		assert.match(managerText, /Agent tool settings/);
		assert.match(managerText, /Current-session agents/);
		assert.equal(managerContext.notifications.length, 0);

		let nestedCall = 0;
		const nestedRenders: string[][] = [];
		const nestedContext = createMockContext({
			mode: "tui",
			hasUI: true,
			custom: async (factory: unknown) => {
				const inputs = nestedCall === 0 ? ["\r"] : ["\u001b"];
				const driven = driveCustomSelector(factory, inputs, 60);
				nestedRenders[nestedCall++] = driven.renders.flat();
				return driven.result;
			},
		});
		await command.handler("", nestedContext.ctx);
		assert.equal(nestedCall, 3, "settings closes back to a fresh manager before final Escape");
		assert.match(nestedRenders[0]?.join("\n") ?? "", /Current session/);
		assert.match(nestedRenders[1]?.join("\n") ?? "", /Subagent User Settings/);
		assert.match(nestedRenders[2]?.join("\n") ?? "", /Current session/);

		let agentRouteCall = 0;
		const agentRouteRenders: string[][] = [];
		const agentRouteContext = createMockContext({
			mode: "tui",
			hasUI: true,
			custom: async (factory: unknown) => {
				const inputs = agentRouteCall === 0 ? ["\u001b[B", "\u001b[B", "\r"] : ["\u001b"];
				const driven = driveCustomSelector(factory, inputs, 60);
				agentRouteRenders[agentRouteCall++] = driven.renders.flat();
				return driven.result;
			},
		});
		await command.handler("", agentRouteContext.ctx);
		assert.equal(agentRouteCall, 3);
		assert.match(agentRouteRenders[1]?.join("\n") ?? "", /Current-session Subagents/);
		assert.match(agentRouteRenders[1]?.join("\n") ?? "", /No current-session subagents/);

		let directCalls = 0;
		const directRenders: string[][] = [];
		const directContext = createMockContext({
			mode: "tui",
			hasUI: true,
			custom: async (factory: unknown) => {
				directCalls++;
				const driven = driveCustomSelector(factory, ["\u001b"], 60);
				directRenders.push(...driven.renders);
				return driven.result;
			},
		});
		await command.handler("settings", directContext.ctx);
		assert.equal(directCalls, 1);
		assert.match(directRenders.flat().join("\n"), /Subagent User Settings/);
		assert.doesNotMatch(directRenders.flat().join("\n"), /Current session/);

		const rpcContext = createMockContext({
			mode: "rpc",
			hasUI: true,
			custom: async () => {
				throw new Error("RPC must not open custom TUI");
			},
		});
		await command.handler("", rpcContext.ctx);
		assert.match(rpcContext.notifications[0]?.message ?? "", /Current session/);
		assert.match(rpcContext.notifications[0]?.message ?? "", /User settings/);

		for (const mode of ["json", "print"]) {
			const headlessContext = createMockContext({
				mode,
				hasUI: false,
				custom: async () => {
					throw new Error(`${mode} mode must not open custom TUI`);
				},
			});
			await command.handler("", headlessContext.ctx);
			assert.deepEqual(headlessContext.notifications, []);
		}

		await command.handler("status", managerContext.ctx);
		assert.match(managerContext.notifications.at(-1)?.message ?? "", /Current session/);
		assert.match(managerContext.notifications.at(-1)?.message ?? "", /User settings/);
		await command.handler("help", managerContext.ctx);
		assert.match(managerContext.notifications.at(-1)?.message ?? "", /compatibility route/);
		await command.handler("unknown", managerContext.ctx);
		assert.match(
			managerContext.notifications.at(-1)?.message ?? "",
			/Unknown \/subagents subcommand: unknown/,
		);
		await command.handler("settings extra", managerContext.ctx);
		assert.match(
			managerContext.notifications.at(-1)?.message ?? "",
			/Unknown \/subagents subcommand: settings extra/,
		);
		const agentsCommand = mock.commands.get("subagents:agents");
		assert.ok(agentsCommand);
		await agentsCommand.handler("list", managerContext.ctx);
		assert.match(
			managerContext.notifications.at(-1)?.message ?? "",
			/No current-session subagents/,
		);
		await agentsCommand.handler("unknown", managerContext.ctx);
		assert.match(
			managerContext.notifications.at(-1)?.message ?? "",
			/Unknown \/subagents:agents subcommand: unknown/,
		);
		for (const handler of mock.events.get("session_shutdown") ?? []) {
			await handler({}, managerContext.ctx);
		}
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		rmSync(directory, { recursive: true, force: true });
	}
});

test("current-session manager excludes already closed agent records", async () => {
	const directory = mkdtempSync(path.join(os.tmpdir(), "pi-subagents-closed-manager-"));
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = directory;
	try {
		const mock = createMockPi();
		const closedAgent: ManagedAgent = {
			id: "sa_closed",
			agent: "scout",
			rootId: "sa_closed",
			depth: 0,
			children: [],
			state: "closed",
			createdAt: 1,
			updatedAt: 1,
			cwd: process.cwd(),
			history: [],
			mailbox: [],
		};
		const includeClosedArguments: boolean[] = [];
		const runtime: SubagentSettingsRuntime = {
			getCompletionDelivery: () => "next-turn",
			setCompletionDelivery: () => undefined,
			getRuntimeStatus: () => ({
				enabled: true,
				initialized: true,
				transport: "subprocess",
				completionDelivery: "next-turn",
				activeAgents: 0,
				retainedAgents: 0,
			}),
			listAgents(includeClosed = false) {
				includeClosedArguments.push(includeClosed);
				return includeClosed ? [closedAgent] : [];
			},
			clearAgents: async () => 0,
		};
		registerSubagentConfigCommand(mock.pi, runtime);
		const command = mock.commands.get("subagents");
		assert.ok(command);
		let call = 0;
		const renders: string[][] = [];
		const context = createMockContext({
			mode: "tui",
			hasUI: true,
			custom: async (factory: unknown) => {
				const inputs =
					call === 0 ? ["\u001b[B", "\u001b[B", "\r"] : call === 1 ? ["\r"] : ["\u001b"];
				const driven = driveCustomSelector(factory, inputs, 60);
				renders[call++] = driven.renders.flat();
				return driven.result;
			},
		});
		await command.handler("", context.ctx);
		assert.equal(call, 3);
		assert.deepEqual(includeClosedArguments, [false]);
		assert.match(renders[1]?.join("\n") ?? "", /No current-session subagents/);
		assert.doesNotMatch(renders[1]?.join("\n") ?? "", /sa_closed/);
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		rmSync(directory, { recursive: true, force: true });
	}
});

test("disabled stateful settings do not advertise unavailable lifecycle tools", async () => {
	const directory = mkdtempSync(path.join(os.tmpdir(), "pi-subagents-disabled-guidance-"));
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = directory;
	try {
		writeFileSync(
			path.join(directory, "pi-subagents.json"),
			JSON.stringify({ stateful: { enabled: false } }),
		);
		const mock = createMockPi();
		subagents(mock.pi);
		assert.deepEqual(
			mock.tools.map((tool) => tool.name),
			["subagent"],
		);
		const blockingTool = mock.tools[0];
		assert.doesNotMatch(String(blockingTool?.description), /subagent_spawn/i);
		assert.doesNotMatch(
			Array.isArray(blockingTool?.promptGuidelines) ? blockingTool.promptGuidelines.join("\n") : "",
			/subagent_spawn/i,
		);
		assert.equal(mock.commands.has("subagents:agents"), false);
		const command = mock.commands.get("subagents");
		assert.ok(command);
		const renders: string[][] = [];
		const context = createMockContext({
			mode: "tui",
			hasUI: true,
			custom: async (factory: unknown) => {
				const driven = driveCustomSelector(factory, ["\u001b"], 60);
				renders.push(...driven.renders);
				return driven.result;
			},
		});
		await command.handler("", context.ctx);
		assert.match(renders.flat().join("\n"), /Lifecycle: disabled/);
		await command.handler("help", context.ctx);
		assert.match(context.notifications.at(-1)?.message ?? "", /unavailable.*disabled/);
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		rmSync(directory, { recursive: true, force: true });
	}
});

test("subagent settings UI preserves unknown JSON and applies completion delivery immediately", async () => {
	const directory = mkdtempSync(path.join(os.tmpdir(), "pi-subagents-settings-ui-"));
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = directory;
	try {
		const settingsPath = path.join(directory, "pi-subagents.json");
		writeFileSync(
			settingsPath,
			JSON.stringify({ futureOption: true, stateful: { futureStatefulOption: "keep" } }),
		);
		const mock = createMockPi();
		subagents(mock.pi);
		const command = mock.commands.get("subagents");
		assert.ok(command);
		const initialSpawnGuidance = mock.tools.find(
			(tool) => tool.name === "subagent_spawn",
		)?.promptGuidelines;
		assert.ok(Array.isArray(initialSpawnGuidance));
		assert.match(initialSpawnGuidance.join("\n"), /next-turn.*default/i);
		assert.doesNotMatch(initialSpawnGuidance.join("\n"), /even when.*final answer.*depends/i);
		let customCalls = 0;
		const context = createMockContext({
			mode: "tui",
			hasUI: true,
			custom: async (factory: unknown) => {
				customCalls++;
				return driveCustomSelector(factory, ["\r", "\u001b"]).result;
			},
		});
		await command.handler("settings", context.ctx);
		assert.equal(customCalls, 1);
		const updatedSpawnGuidance = mock.tools
			.filter((tool) => tool.name === "subagent_spawn")
			.at(-1)?.promptGuidelines;
		assert.ok(Array.isArray(updatedSpawnGuidance));
		assert.match(updatedSpawnGuidance.join("\n"), /auto-resume/i);
		assert.match(updatedSpawnGuidance.join("\n"), /even when.*final answer.*depends/i);
		assert.doesNotMatch(updatedSpawnGuidance.join("\n"), /next-turn.*default/i);
		assert.deepEqual(JSON.parse(readFileSync(settingsPath, "utf8")), {
			futureOption: true,
			stateful: {
				futureStatefulOption: "keep",
				completionDelivery: "auto-resume",
			},
		});
		updateAgentToolsSetting("scout", ["read"]);
		assert.deepEqual(JSON.parse(readFileSync(settingsPath, "utf8")), {
			futureOption: true,
			stateful: {
				futureStatefulOption: "keep",
				completionDelivery: "auto-resume",
			},
			agents: { scout: { tools: ["read"] } },
		});
		await command.handler("status", context.ctx);
		assert.match(context.notifications.at(-1)?.message ?? "", /Completion delivery: auto-resume/);
		assert.match(context.notifications.at(-1)?.message ?? "", /User settings/);

		const nonTui = createMockContext({
			mode: "json",
			hasUI: true,
			custom: async () => {
				throw new Error("custom UI must not open");
			},
		});
		await command.handler("settings", nonTui.ctx);
		assert.match(nonTui.notifications[0]?.message ?? "", /Edit settings manually/);
		await mock.commands.get("subagents:config")?.handler("", nonTui.ctx);
		assert.match(nonTui.notifications.at(-1)?.message ?? "", /requires TUI mode/);
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		rmSync(directory, { recursive: true, force: true });
	}
});

test("subagent settings UI rolls back after an atomic save failure", async () => {
	const directory = mkdtempSync(path.join(os.tmpdir(), "pi-subagents-settings-rollback-"));
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = directory;
	try {
		const settingsPath = path.join(directory, "pi-subagents.json");
		writeFileSync(settingsPath, "{}\n");
		const mock = createMockPi();
		subagents(mock.pi);
		const command = mock.commands.get("subagents");
		assert.ok(command);
		let renders: string[][] = [];
		const context = createMockContext({
			mode: "tui",
			hasUI: true,
			custom: async (factory: unknown) => {
				rmSync(settingsPath);
				mkdirSync(settingsPath);
				const driven = driveCustomSelector(factory, ["\r", "\u001b"]);
				renders = driven.renders;
				return driven.result;
			},
		});
		await command.handler("settings", context.ctx);
		assert.match(context.notifications.at(-1)?.message ?? "", /were not saved/i);
		assert.ok(renders[0]?.some((line) => line.includes("next-turn")));
		await command.handler("status", context.ctx);
		assert.match(context.notifications.at(-1)?.message ?? "", /Completion delivery: next-turn/);
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		rmSync(directory, { recursive: true, force: true });
	}
});

test("subagent tool selection keeps the cursor on the toggled row", () => {
	const list = new ToolToggleList(["first", "second", "third"], new Set());
	list.handleInput("\u001b[B");
	list.handleInput("\r");
	assert.ok(list.render(100).some((line) => line.includes("> ✓ second")));
});

test("subagent tool selection escapes display controls without changing saved names", () => {
	const names = ["read\u001b]8;;https://example.com\u0007linked", "line\nbreak"];
	const list = new ToolToggleList(names, new Set(names));
	for (const renderedLine of list.render(100)) {
		// biome-ignore lint/suspicious/noControlCharactersInRegex: Verify terminal-control escaping.
		assert.doesNotMatch(renderedLine, /[\u0000-\u001f\u007f-\u009f]/u);
	}
	let saved: string[] | undefined;
	list.onDone = (tools) => {
		saved = tools;
	};
	list.handleInput("s");
	assert.deepEqual(saved, names);
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

test("built-in reviewer inspects evidence without running verification commands", () => {
	const cwd = mkdtempSync(path.join(os.tmpdir(), "pi-subagents-reviewer-test-"));
	try {
		const reviewer = discoverAgents(cwd, "project").agents.find(
			(agent) => agent.name === "reviewer",
		);

		assert.ok(reviewer);
		assert.match(
			reviewer.systemPrompt,
			/do not edit files or run tests, builds, benchmarks, formatters/i,
		);
		assert.match(reviewer.systemPrompt, /recommend.*commands for the main agent to run/i);
		assert.doesNotMatch(reviewer.systemPrompt, /run safe inspection or test commands/i);
		assert.ok(reviewer.tools?.includes("bash"));
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
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

test("subagent settings migrate and save to the canonical package filename", () => {
	const directory = mkdtempSync(path.join(os.tmpdir(), "pi-subagents-migration-"));
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = directory;
	try {
		const legacyPath = path.join(directory, "pi-subagents-config.json");
		const canonicalPath = path.join(directory, "pi-subagents.json");
		writeFileSync(
			legacyPath,
			JSON.stringify({ agents: { scout: { tools: ["read"] } }, futureOption: true }),
		);
		const migrationMock = createMockPi();
		subagents(migrationMock.pi);
		assert.deepEqual(JSON.parse(readFileSync(canonicalPath, "utf8")), {
			agents: { scout: { tools: ["read"] } },
			futureOption: true,
		});
		assert.equal(existsSync(legacyPath), false);
		const migrationContext = createMockContext();
		migrationMock.events.get("session_start")?.[0]?.({}, migrationContext.ctx);
		assert.match(migrationContext.notifications[0]?.message ?? "", /migrated/i);

		writeFileSync(legacyPath, JSON.stringify({ agents: { scout: { tools: ["bash"] } } }));
		writeFileSync(canonicalPath, JSON.stringify({ agents: { scout: { tools: ["read"] } } }));
		assert.deepEqual(readSubagentSettings(), { agents: { scout: { tools: ["read"] } } });
		assert.equal(existsSync(legacyPath), true);

		writeFileSync(canonicalPath, "invalid");
		assert.equal(readSubagentSettings(), undefined);
		assert.equal(readFileSync(legacyPath, "utf8").includes("bash"), true);
		unlinkSync(legacyPath);
		writeFileSync(canonicalPath, JSON.stringify({ agents: { scout: { tools: ["read"] } } }));
		assert.deepEqual(readSubagentSettings(), { agents: { scout: { tools: ["read"] } } });
		assert.equal(consumeSubagentSettingsNotice(), undefined);
		unlinkSync(canonicalPath);
		writeFileSync(legacyPath, "invalid");
		assert.equal(readSubagentSettings(), undefined);
		assert.equal(existsSync(canonicalPath), false);

		writeFileSync(legacyPath, JSON.stringify({ agents: { scout: { tools: ["read"] } } }));
		symlinkSync("missing-target", canonicalPath);
		assert.deepEqual(readSubagentSettings(), { agents: { scout: { tools: ["read"] } } });
		assert.equal(existsSync(legacyPath), true);

		saveSubagentConfig({ stateful: { enabled: false } });
		assert.equal(lstatSync(canonicalPath).isSymbolicLink(), false);
		assert.equal(existsSync(path.join(directory, "missing-target")), false);
		assert.deepEqual(JSON.parse(readFileSync(canonicalPath, "utf8")), {
			stateful: { enabled: false },
		});
		const ignoredMock = createMockPi();
		subagents(ignoredMock.pi);
		const ignoredContext = createMockContext();
		ignoredMock.events.get("session_start")?.[0]?.({}, ignoredContext.ctx);
		assert.match(ignoredContext.notifications[0]?.message ?? "", /ignored/i);
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		rmSync(directory, { recursive: true, force: true });
	}
});

test("completion delivery inspection rejects malformed settings without overwriting them", () => {
	const directory = mkdtempSync(path.join(os.tmpdir(), "pi-subagents-completion-settings-"));
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = directory;
	try {
		assert.deepEqual(inspectCompletionDeliverySettings(), {
			path: path.join(directory, "pi-subagents.json"),
			value: "next-turn",
			source: "default",
		});
		const settingsPath = path.join(directory, "pi-subagents.json");
		writeFileSync(settingsPath, "{ malformed");
		assert.match(inspectCompletionDeliverySettings().error ?? "", /JSON|position|property/i);
		assert.throws(() => updateCompletionDeliverySetting("auto-resume"), /Cannot update malformed/);
		assert.equal(readFileSync(settingsPath, "utf8"), "{ malformed");
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		rmSync(directory, { recursive: true, force: true });
	}
});

test("agent tool patches preserve prototype-like names as data", () => {
	const directory = mkdtempSync(path.join(os.tmpdir(), "pi-subagents-agent-tools-"));
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = directory;
	try {
		updateAgentToolsSetting("__proto__", ["read"]);
		const raw = JSON.parse(readFileSync(path.join(directory, "pi-subagents.json"), "utf8"));
		assert.equal(Object.hasOwn(raw.agents, "__proto__"), true);
		assert.deepEqual(Object.getOwnPropertyDescriptor(raw.agents, "__proto__")?.value, {
			tools: ["read"],
		});
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		rmSync(directory, { recursive: true, force: true });
	}
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
		"2 turns ↑1.5k ↓20 $0.0123 gpt requested-thinking:high",
	);
	assert.equal(
		formatUsageStats(
			{ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
			"requested-alias",
			"high",
			"actual-provider",
			"actual-model",
		),
		"actual-provider/actual-model requested-thinking:high",
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

test("parallel updates keep failed fan-out pending while fan-in starts", async () => {
	const mock = createMockPi();
	subagents(mock.pi);
	const tool = mock.tools[0] as SubagentTool;
	const { ctx } = createMockContext();
	const signal = new AbortController().signal;
	const dir = mkdtempSync(path.join(os.tmpdir(), "pi-subagents-pending-fan-in-"));
	const fakePi = path.join(dir, "fake-pi.mjs");
	writeFileSync(
		fakePi,
		[
			"const task=process.argv.at(-1) ?? '';",
			"const failed=task.includes('RUN_FANOUT_FAILURE')&&!task.includes('RUN_AGGREGATOR');",
			"const message=failed",
			"? {role:'assistant',content:[{type:'text',text:'FANOUT_PARTIAL'}],stopReason:'error',errorMessage:'FANOUT_FAILED',timestamp:Date.now()}",
			": {role:'assistant',content:[{type:'text',text:'FAN_IN_COMPLETE'}],stopReason:'stop',timestamp:Date.now()};",
			"process.stdout.write(JSON.stringify({type:'message_end',message})+'\\n');",
		].join(""),
	);
	const updates: Array<{
		details?: {
			results: Array<{ stopReason?: string }>;
			aggregator?: { exitCode: number };
		};
	}> = [];
	const originalScript = process.argv[1];
	process.argv[1] = fakePi;
	try {
		const result = await tool.execute(
			"pending-fan-in",
			{
				tasks: [{ agent: "scout", task: "RUN_FANOUT_FAILURE" }],
				aggregator: { agent: "scout", task: "RUN_AGGREGATOR" },
			},
			signal,
			(update: unknown) => updates.push(update as (typeof updates)[number]),
			ctx,
		);
		assert.match(result.content?.[0]?.text ?? "", /FAN_IN_COMPLETE/);
		assert.ok(
			updates.some(
				(update) =>
					update.details?.results[0]?.stopReason === "error" &&
					update.details.aggregator?.exitCode === -1,
			),
			"expected a failed fan-out update with a pending fan-in result",
		);
	} finally {
		process.argv[1] = originalScript;
		rmSync(dir, { recursive: true, force: true });
	}
});

test("parallel summaries classify provider errors and retain partial output", async () => {
	const mock = createMockPi();
	subagents(mock.pi);
	const tool = mock.tools[0] as SubagentTool;
	const { ctx } = createMockContext();
	const signal = new AbortController().signal;
	const dir = mkdtempSync(path.join(os.tmpdir(), "pi-subagents-parallel-error-"));
	const fakePi = path.join(dir, "fake-pi.mjs");
	writeFileSync(
		fakePi,
		[
			"const task=process.argv.at(-1) ?? '';",
			"const failed=task.includes('provider failure');",
			"const message=failed",
			"? {role:'assistant',content:[{type:'text',text:'PARTIAL'}],stopReason:'error',errorMessage:'PROVIDER_FAILED',timestamp:Date.now()}",
			": {role:'assistant',content:[{type:'text',text:'DONE'}],stopReason:'stop',timestamp:Date.now()};",
			"process.stdout.write(JSON.stringify({type:'message_end',message})+'\\n');",
		].join(""),
	);
	const originalScript = process.argv[1];
	process.argv[1] = fakePi;
	try {
		const result = await tool.execute(
			"parallel-errors",
			{
				tasks: [
					{ agent: "scout", task: "provider failure" },
					{ agent: "scout", task: "success" },
				],
			},
			signal,
			() => undefined,
			ctx,
		);
		const text = result.content?.[0]?.text ?? "";
		assert.match(text, /Parallel: 1\/2 succeeded/);
		assert.match(text, /\[scout\] failed: PROVIDER_FAILED/);
		assert.match(text, /Partial output:\nPARTIAL/);
		assert.match(text, /\[scout\] completed: DONE/);
	} finally {
		process.argv[1] = originalScript;
		rmSync(dir, { recursive: true, force: true });
	}
});
