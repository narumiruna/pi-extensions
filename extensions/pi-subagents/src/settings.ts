import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import {
	type AgentConfig,
	isThinkingLevel,
	type SubagentAgentConfig,
	type SubagentSettings,
	type SubagentThinkingLevel,
} from "./agents.js";

export function hasOwn(obj: object, key: PropertyKey): boolean {
	return Object.hasOwn(obj, key);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isPositiveNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 1;
}

export function normalizeAgentSettings(value: unknown): SubagentAgentConfig | undefined {
	if (!isPlainObject(value)) return undefined;

	const config: SubagentAgentConfig = {};
	let hasKnownField = false;

	if (hasOwn(value, "tools")) {
		if (!isStringArray(value.tools)) return undefined;
		config.tools = value.tools;
		hasKnownField = true;
	}

	if (hasOwn(value, "model")) {
		if (value.model !== null && typeof value.model !== "string") return undefined;
		config.model = value.model;
		hasKnownField = true;
	}

	if (hasOwn(value, "thinkingLevel")) {
		if (value.thinkingLevel !== null && !isThinkingLevel(value.thinkingLevel)) return undefined;
		config.thinkingLevel = value.thinkingLevel;
		hasKnownField = true;
	}

	if (hasOwn(value, "timeoutMs")) {
		if (value.timeoutMs !== null && !isPositiveNumber(value.timeoutMs)) return undefined;
		config.timeoutMs = value.timeoutMs;
		hasKnownField = true;
	}

	return hasKnownField ? config : undefined;
}

export function normalizeSubagentSettings(value: unknown): SubagentSettings | undefined {
	if (!isPlainObject(value)) return undefined;
	const settings: SubagentSettings = {};
	if (hasOwn(value, "agents")) {
		if (!isPlainObject(value.agents)) return undefined;
		const agents: Record<string, SubagentAgentConfig> = {};
		for (const [name, rawConfig] of Object.entries(value.agents)) {
			const config = normalizeAgentSettings(rawConfig);
			if (config) agents[name] = config;
		}
		if (Object.keys(agents).length > 0) settings.agents = agents;
	}
	if (hasOwn(value, "stateful")) {
		if (!isPlainObject(value.stateful)) return undefined;
		const runtime: NonNullable<SubagentSettings["stateful"]> = {};
		for (const key of ["maxAgents", "maxActiveTurns", "idleTtlMs", "retentionDays", "maxStoredAgents"] as const) {
			if (hasOwn(value.stateful, key)) {
				if (!isPositiveNumber(value.stateful[key])) return undefined;
				runtime[key] = value.stateful[key];
			}
		}
		if (hasOwn(value.stateful, "enabled")) {
			if (typeof value.stateful.enabled !== "boolean") return undefined;
			runtime.enabled = value.stateful.enabled;
		}
		settings.stateful = runtime;
	}
	return settings;
}

export function readSubagentSettings(): SubagentSettings | undefined {
	const configPath = path.join(getAgentDir(), "pi-subagents-config.json");
	if (!fs.existsSync(configPath)) return undefined;
	try {
		return normalizeSubagentSettings(JSON.parse(fs.readFileSync(configPath, "utf-8")));
	} catch {
		return undefined;
	}
}

export function saveSubagentConfig(settings: SubagentSettings): void {
	const agentDir = getAgentDir();
	fs.mkdirSync(agentDir, { recursive: true });

	const configPath = path.join(agentDir, "pi-subagents-config.json");
	fs.writeFileSync(configPath, `${JSON.stringify(settings, null, "\t")}\n`, "utf-8");
}

export function uniqueToolNames(tools: string[]): string[] {
	return [...new Set(tools)];
}

export function sameToolSet(left: string[], right: string[]): boolean {
	const leftSet = new Set(left);
	const rightSet = new Set(right);
	if (leftSet.size !== rightSet.size) return false;
	return [...leftSet].every((tool) => rightSet.has(tool));
}

export function resolveSubagentThinkingLevel(
	agents: readonly Pick<AgentConfig, "name" | "thinkingLevel">[],
	agentName: string,
	topLevelThinkingLevel?: SubagentThinkingLevel,
	localThinkingLevel?: SubagentThinkingLevel,
): SubagentThinkingLevel | undefined {
	return localThinkingLevel ?? topLevelThinkingLevel ?? agents.find((agent) => agent.name === agentName)?.thinkingLevel;
}

export function hasAnyAgentOverride(config: SubagentAgentConfig): boolean {
	return (
		hasOwn(config, "tools") ||
		hasOwn(config, "model") ||
		hasOwn(config, "thinkingLevel") ||
		hasOwn(config, "timeoutMs")
	);
}
