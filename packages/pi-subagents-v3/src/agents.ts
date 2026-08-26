import * as fs from "node:fs";
import * as path from "node:path";
import { CONFIG_DIR_NAME, getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";
import type { AgentDefinition, AgentDiscovery, ThinkingLevel } from "./types.js";

const MAX_FILES_PER_SCOPE = 128;
const MAX_FILE_BYTES = 64 * 1024;
const MAX_TOTAL_BYTES_PER_SCOPE = 2 * 1024 * 1024;
const MAX_NAME_BYTES = 128;
const MAX_DESCRIPTION_BYTES = 1024;
const THINKING_LEVELS = new Set<ThinkingLevel>([
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
]);

const BUILT_IN_AGENTS: AgentDefinition[] = [
	{
		name: "explorer",
		description: "Read-only codebase exploration with concise file and evidence references.",
		source: "built-in",
		filePath: "built-in:explorer",
		tools: ["read", "grep", "find", "ls"],
		thinkingLevel: "low",
		systemPrompt: [
			"You are a focused explorer subagent.",
			"Inspect only the bounded question and return concise findings with exact paths and evidence.",
			"Do not edit files or claim changes.",
		].join("\n"),
	},
	{
		name: "worker",
		description: "Bounded implementation and command execution with explicit ownership.",
		source: "built-in",
		filePath: "built-in:worker",
		systemPrompt: [
			"You are a focused worker subagent running in an isolated Pi child context.",
			"Complete only the delegated slice and respect its file or responsibility ownership.",
			"Keep scope tight and report changed files, checks, and remaining risks.",
		].join("\n"),
	},
];

interface LoadedScope {
	agents: AgentDefinition[];
	omitted: number;
}

export function discoverAgents(cwd: string, projectTrusted: boolean): AgentDiscovery {
	const user = loadDirectory(path.join(getAgentDir(), "agents"), "user");
	const projectDirectory = projectTrusted ? findProjectAgentsDirectory(cwd) : undefined;
	const project = projectDirectory
		? loadDirectory(projectDirectory, "project")
		: { agents: [], omitted: 0 };
	const effective = new Map(BUILT_IN_AGENTS.map((agent) => [agent.name, structuredClone(agent)]));
	for (const agent of user.agents) effective.set(agent.name, agent);
	for (const agent of project.agents) effective.set(agent.name, agent);
	return {
		agents: [...effective.values()],
		omitted: user.omitted + project.omitted,
	};
}

function loadDirectory(directory: string, source: "user" | "project"): LoadedScope {
	let entries: fs.Dirent[];
	try {
		entries = fs
			.readdirSync(directory, { withFileTypes: true })
			.filter((entry) => entry.name.endsWith(".md"))
			.filter((entry) => entry.isFile() || entry.isSymbolicLink())
			.sort((left, right) => left.name.localeCompare(right.name));
	} catch {
		return { agents: [], omitted: 0 };
	}

	const agents: AgentDefinition[] = [];
	let omitted = Math.max(0, entries.length - MAX_FILES_PER_SCOPE);
	let totalBytes = 0;
	for (const entry of entries.slice(0, MAX_FILES_PER_SCOPE)) {
		const filePath = path.join(directory, entry.name);
		let stat: fs.Stats;
		try {
			stat = fs.statSync(filePath);
		} catch {
			continue;
		}
		if (!stat.isFile()) continue;
		if (stat.size > MAX_FILE_BYTES || totalBytes + stat.size > MAX_TOTAL_BYTES_PER_SCOPE) {
			omitted++;
			continue;
		}
		totalBytes += stat.size;
		let sourceText: string;
		try {
			sourceText = fs.readFileSync(filePath, "utf8");
		} catch {
			continue;
		}
		const parsed = parseAgent(sourceText, source, filePath);
		if (parsed) agents.push(parsed);
	}
	return { agents, omitted };
}

function parseAgent(
	text: string,
	source: "user" | "project",
	filePath: string,
): AgentDefinition | undefined {
	const { frontmatter, body } = parseFrontmatter<Record<string, unknown>>(text);
	const name = boundedString(frontmatter.name, MAX_NAME_BYTES);
	const description = boundedString(frontmatter.description, MAX_DESCRIPTION_BYTES);
	if (!name || !/^[A-Za-z0-9][A-Za-z0-9_-]*$/u.test(name) || !description) return undefined;

	let tools: string[] | undefined;
	if (Object.hasOwn(frontmatter, "tools")) {
		const rawTools = frontmatter.tools;
		if (rawTools === null) tools = [];
		else if (typeof rawTools === "string") tools = splitTools(rawTools);
		else if (Array.isArray(rawTools) && rawTools.every((tool) => typeof tool === "string")) {
			tools = [...new Set(rawTools.map((tool) => tool.trim()).filter(Boolean))];
		} else return undefined;
	}

	if (
		tools &&
		(tools.length > 64 || tools.some((tool) => !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.test(tool)))
	) {
		return undefined;
	}
	const model = boundedString(frontmatter.model, 256);
	if (frontmatter.model !== undefined && (!model || hasControlCharacter(model))) return undefined;
	const thinkingLevel = THINKING_LEVELS.has(frontmatter.thinkingLevel as ThinkingLevel)
		? (frontmatter.thinkingLevel as ThinkingLevel)
		: undefined;
	return {
		name,
		description,
		source,
		filePath,
		systemPrompt: body,
		...(tools !== undefined ? { tools } : {}),
		...(model ? { model } : {}),
		...(thinkingLevel ? { thinkingLevel } : {}),
	};
}

function findProjectAgentsDirectory(cwd: string): string | undefined {
	let current = path.resolve(cwd);
	while (true) {
		const candidate = path.join(current, CONFIG_DIR_NAME, "agents");
		try {
			if (fs.statSync(candidate).isDirectory()) return candidate;
		} catch {
			// Continue toward the filesystem root.
		}
		const parent = path.dirname(current);
		if (parent === current) return undefined;
		current = parent;
	}
}

function splitTools(value: string): string[] {
	return [
		...new Set(
			value
				.split(",")
				.map((tool) => tool.trim())
				.filter(Boolean),
		),
	];
}

function boundedString(value: unknown, maxBytes: number): string | undefined {
	if (typeof value !== "string") return undefined;
	const normalized = value.replace(/\s+/gu, " ").trim();
	if (!normalized || Buffer.byteLength(normalized, "utf8") > maxBytes) return undefined;
	return normalized;
}

function hasControlCharacter(value: string): boolean {
	return [...value].some((character) => {
		const codePoint = character.codePointAt(0) ?? 0;
		return codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f);
	});
}
