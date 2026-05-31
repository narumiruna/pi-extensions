/**
 * Agent discovery and configuration
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";

export type AgentScope = "user" | "project" | "both";

export type AgentSource = "built-in" | "user" | "project";

export interface AgentConfig {
	name: string;
	description: string;
	tools?: string[];
	model?: string;
	systemPrompt: string;
	source: AgentSource;
	filePath: string;
}

export interface SubagentAgentConfig {
	tools?: string[];
	model?: string | null;
	timeoutMs?: number | null;
}

export interface SubagentSettings {
	agents?: Record<string, SubagentAgentConfig>;
}

const BUILT_IN_AGENTS: AgentConfig[] = [
	{
		name: "scout",
		description: "Read-only codebase reconnaissance; returns concise findings with paths and evidence.",
		tools: ["read", "grep", "find", "ls", "bash"],
		source: "built-in",
		filePath: "built-in:scout",
		systemPrompt: [
			"You are a scout subagent. Explore the codebase quickly and report grounded findings.",
			"Do not edit files. Prefer read, grep, find, ls, and safe bash inspection commands.",
			"Return concise bullets with exact file paths, symbols, and open questions.",
		].join("\n"),
	},
	{
		name: "planner",
		description: "Turns reconnaissance into a lean implementation or migration plan.",
		tools: ["read", "grep", "find", "ls"],
		source: "built-in",
		filePath: "built-in:planner",
		systemPrompt: [
			"You are a planner subagent. Produce executable, verifiable plans only.",
			"Do not modify files. Ground the plan in the repository's actual structure.",
			"Call out assumptions, risks, sequencing, and verification commands.",
		].join("\n"),
	},
	{
		name: "reviewer",
		description: "Independent code review and verification agent for completed changes.",
		tools: ["read", "grep", "find", "ls", "bash"],
		source: "built-in",
		filePath: "built-in:reviewer",
		systemPrompt: [
			"You are a reviewer subagent. Review changes adversarially and verify claims.",
			"Do not edit files. Run safe inspection or test commands when useful.",
			"Report PASS, FAIL, or PARTIAL with evidence, commands run, and specific follow-ups.",
		].join("\n"),
	},
	{
		name: "worker",
		description: "General-purpose implementation worker with the default Pi tool set.",
		source: "built-in",
		filePath: "built-in:worker",
		systemPrompt: workerSystemPrompt(),
	},
	{
		name: "general",
		description: "Alias for worker; kept for model-generated subagent names.",
		source: "built-in",
		filePath: "built-in:general",
		systemPrompt: workerSystemPrompt(),
	},
	{
		name: "general-purpose",
		description: "Alias for worker; compatible with common subagent naming conventions.",
		source: "built-in",
		filePath: "built-in:general-purpose",
		systemPrompt: workerSystemPrompt(),
	},
];

function workerSystemPrompt(): string {
	return [
		"You are a focused worker subagent running in an isolated Pi process.",
		"Complete the delegated task directly. Keep scope tight and avoid unrelated changes.",
		"When done, summarize files changed, commands run, and any remaining risks.",
	].join("\n");
}

export interface AgentDiscoveryResult {
	agents: AgentConfig[];
	projectAgentsDir: string | null;
}

function loadAgentsFromDir(dir: string, source: "user" | "project"): AgentConfig[] {
	const agents: AgentConfig[] = [];

	if (!fs.existsSync(dir)) {
		return agents;
	}

	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return agents;
	}

	for (const entry of entries) {
		if (!entry.name.endsWith(".md")) continue;
		if (!entry.isFile() && !entry.isSymbolicLink()) continue;

		const filePath = path.join(dir, entry.name);
		let content: string;
		try {
			content = fs.readFileSync(filePath, "utf-8");
		} catch {
			continue;
		}

		const { frontmatter, body } = parseFrontmatter<Record<string, string>>(content);

		if (!frontmatter.name || !frontmatter.description) {
			continue;
		}

		const tools = frontmatter.tools
			?.split(",")
			.map((t: string) => t.trim())
			.filter(Boolean);

		agents.push({
			name: frontmatter.name,
			description: frontmatter.description,
			tools: tools && tools.length > 0 ? tools : undefined,
			model: frontmatter.model,
			systemPrompt: body,
			source,
			filePath,
		});
	}

	return agents;
}

function isDirectory(p: string): boolean {
	try {
		return fs.statSync(p).isDirectory();
	} catch {
		return false;
	}
}

function findNearestProjectAgentsDir(cwd: string): string | null {
	let currentDir = cwd;
	while (true) {
		const candidate = path.join(currentDir, ".pi", "agents");
		if (isDirectory(candidate)) return candidate;

		const parentDir = path.dirname(currentDir);
		if (parentDir === currentDir) return null;
		currentDir = parentDir;
	}
}

export function discoverAgents(
	cwd: string,
	scope: AgentScope,
	config?: SubagentSettings,
): AgentDiscoveryResult {
	const userDir = path.join(getAgentDir(), "agents");
	const projectAgentsDir = findNearestProjectAgentsDir(cwd);

	const userAgents = scope === "project" ? [] : loadAgentsFromDir(userDir, "user");
	const projectAgents = scope === "user" || !projectAgentsDir ? [] : loadAgentsFromDir(projectAgentsDir, "project");

	const agentMap = new Map<string, AgentConfig>();

	// Lowest priority: built-ins are always available, then user agents, then
	// trusted project agents if requested. This mirrors the subagent boundary
	// pattern in ./src: stable built-ins plus overridable local definitions.
	for (const agent of BUILT_IN_AGENTS) {
		const override = config?.agents?.[agent.name];
		if (override) {
			agentMap.set(agent.name, {
				...agent,
				tools: override.tools ?? agent.tools,
				model: override.model ?? agent.model,
			});
		} else {
			agentMap.set(agent.name, agent);
		}
	}

	if (scope === "both") {
		for (const agent of userAgents) agentMap.set(agent.name, agent);
		for (const agent of projectAgents) agentMap.set(agent.name, agent);
	} else if (scope === "user") {
		for (const agent of userAgents) agentMap.set(agent.name, agent);
	} else {
		for (const agent of projectAgents) agentMap.set(agent.name, agent);
	}

	return { agents: Array.from(agentMap.values()), projectAgentsDir };
}

export function formatAgentList(agents: AgentConfig[], maxItems: number): { text: string; remaining: number } {
	if (agents.length === 0) return { text: "none", remaining: 0 };
	const listed = agents.slice(0, maxItems);
	const remaining = agents.length - listed.length;
	return {
		text: listed.map((a) => `${a.name} (${a.source}): ${a.description}`).join("; "),
		remaining,
	};
}
