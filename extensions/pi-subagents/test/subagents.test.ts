import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createMockPi } from "../../../test/support.js";
import { discoverAgents, formatAgentList } from "../src/agents.js";
import subagents, {
	formatTokens,
	formatUsageStats,
	normalizeSubagentSettings,
	parsePositiveInteger,
	sameToolSet,
	uniqueToolNames,
} from "../src/subagents.js";

test("subagents registers delegation tool and configuration command", () => {
	const mock = createMockPi();
	subagents(mock.pi);

	assert.equal(mock.tools[0]?.name, "subagent");
	assert.ok(mock.commands.has("subagents:config"));
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
			"---",
			"Project scout prompt.",
		].join("\n"),
	);

	const result = discoverAgents(cwd, "project", { agents: { scout: { timeoutMs: 1234 } } });
	const scout = result.agents.find((agent) => agent.name === "scout");

	assert.equal(result.projectAgentsDir, agentsDir);
	assert.equal(scout?.source, "project");
	assert.deepEqual(scout?.tools, ["read", "bash"]);
	assert.equal(scout?.model, "gpt-test");
	assert.equal(scout?.timeoutMs, 1234);
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
				scout: { tools: ["read"], model: null, timeoutMs: 1 },
				bad: { tools: [1] },
			},
		}),
		{ agents: { scout: { tools: ["read"], model: null, timeoutMs: 1 } } },
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
	assert.deepEqual(uniqueToolNames(["read", "read", "bash"]), ["read", "bash"]);
	assert.equal(sameToolSet(["read", "bash"], ["bash", "read"]), true);
});
