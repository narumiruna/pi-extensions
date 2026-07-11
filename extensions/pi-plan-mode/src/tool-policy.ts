import type { ToolInfo } from "@earendil-works/pi-coding-agent";

export const SAFE_BUILTIN_PLAN_TOOLS = new Set(["read", "bash", "grep", "find", "ls"]);
export type PlanModeToolPolicy = "read-only" | "limited" | "user-opt-in" | "blocked";

const BLOCKED_BUILTIN_TOOLS = new Set(["edit", "write"]);
const MUTATING_COMMANDS = new Set([
	"rm",
	"rmdir",
	"mv",
	"cp",
	"mkdir",
	"touch",
	"chmod",
	"chown",
	"chgrp",
	"ln",
	"tee",
	"truncate",
	"dd",
	"sudo",
	"su",
	"kill",
	"pkill",
	"killall",
	"reboot",
	"shutdown",
	"vim",
	"vi",
	"nano",
	"emacs",
	"code",
	"subl",
]);
const READ_ONLY_COMMANDS = new Set([
	"cat",
	"head",
	"tail",
	"grep",
	"find",
	"ls",
	"pwd",
	"echo",
	"printf",
	"wc",
	"sort",
	"uniq",
	"diff",
	"file",
	"stat",
	"du",
	"df",
	"tree",
	"which",
	"whereis",
	"type",
	"printenv",
	"uname",
	"whoami",
	"id",
	"date",
	"uptime",
	"ps",
	"jq",
	"rg",
	"fd",
	"bat",
	"eza",
]);

export function isBuiltinTool(tool: ToolInfo) {
	return tool.sourceInfo.source === "builtin";
}

export function classifyPlanModeTool(tool: ToolInfo): PlanModeToolPolicy {
	if (!isBuiltinTool(tool)) return "user-opt-in";
	if (BLOCKED_BUILTIN_TOOLS.has(tool.name)) return "blocked";
	if (tool.name === "bash") return "limited";
	return SAFE_BUILTIN_PLAN_TOOLS.has(tool.name) ? "read-only" : "blocked";
}

export function canSelectToolInPlanMode(tool: ToolInfo) {
	return classifyPlanModeTool(tool) !== "blocked";
}

export function readCommand(input: unknown) {
	const command = input as { command?: unknown } | undefined;
	return typeof command?.command === "string" ? command.command : "";
}

export function isSafeCommand(command: string) {
	const segments = splitShellSegments(command);
	return segments !== undefined && segments.length > 0 && segments.every(isSafeSegment);
}

function splitShellSegments(command: string): string[] | undefined {
	const trimmed = command.trim();
	if (!trimmed || /[\n\r`]/.test(trimmed)) return undefined;

	const segments: string[] = [];
	let quote: "'" | '"' | undefined;
	let escaped = false;
	let start = 0;
	for (let index = 0; index < trimmed.length; index += 1) {
		const character = trimmed[index];
		if (escaped) {
			escaped = false;
			continue;
		}
		if (character === "\\" && quote !== "'") {
			escaped = true;
			continue;
		}
		if (quote) {
			if (character === quote) quote = undefined;
			continue;
		}
		if (character === "'" || character === '"') {
			quote = character;
			continue;
		}
		if (character === ">" || character === "<" || character === "(" || character === ")") {
			return undefined;
		}
		const next = trimmed[index + 1];
		if (character === "&" && next !== "&") return undefined;
		const separatorLength =
			character === ";" || character === "|"
				? next === character
					? 2
					: 1
				: character === "&" && next === "&"
					? 2
					: 0;
		if (separatorLength === 0) continue;
		const segment = trimmed.slice(start, index).trim();
		if (!segment) return undefined;
		segments.push(segment);
		index += separatorLength - 1;
		start = index + 1;
	}
	if (quote || escaped) return undefined;
	const finalSegment = trimmed.slice(start).trim();
	if (!finalSegment) return undefined;
	segments.push(finalSegment);
	return segments;
}

function isSafeSegment(segment: string) {
	if (/\$\(|\$\{|(^|\s)[A-Za-z_][A-Za-z0-9_]*=/.test(segment)) return false;
	const tokens = shellWords(segment);
	if (!tokens || tokens.length === 0) return false;
	const command = tokens[0]?.toLowerCase();
	if (!command || MUTATING_COMMANDS.has(command)) return false;
	const args = tokens.slice(1);
	if (!hasSafeArguments(command, args)) return false;
	if (READ_ONLY_COMMANDS.has(command)) return true;
	return isSafeStructuredCommand(command, args);
}

function shellWords(segment: string): string[] | undefined {
	const words: string[] = [];
	let word = "";
	let quote: "'" | '"' | undefined;
	let escaped = false;
	for (const character of segment) {
		if (escaped) {
			word += character;
			escaped = false;
			continue;
		}
		if (character === "\\" && quote !== "'") {
			escaped = true;
			continue;
		}
		if (quote) {
			if (character === quote) quote = undefined;
			else word += character;
			continue;
		}
		if (character === "'" || character === '"') quote = character;
		else if (/\s/.test(character)) {
			if (word) words.push(word);
			word = "";
		} else word += character;
	}
	if (quote || escaped) return undefined;
	if (word) words.push(word);
	return words;
}

function hasSafeArguments(command: string, args: string[]) {
	const forbidden = new Set(["-i", "--in-place", "--fix", "--write", "-delete", "--delete"]);
	if (args.some((argument) => forbidden.has(argument))) return false;
	if (
		command === "find" &&
		args.some((argument) =>
			["-exec", "-execdir", "-ok", "-okdir", "-fprint", "-fprintf", "-fls"].includes(
				argument,
			),
		)
	) {
		return false;
	}
	if (command === "date" && args.some((argument) => argument === "-s" || argument.startsWith("--set"))) {
		return false;
	}
	if (
		(command === "sort" || command === "tree") &&
		args.some((argument) => argument === "-o" || argument.startsWith("--output"))
	) {
		return false;
	}
	return true;
}

function isSafeStructuredCommand(command: string, args: string[]) {
	const subcommandIndex = args.findIndex((argument) => !argument.startsWith("-"));
	const subcommand = args[subcommandIndex]?.toLowerCase();
	const subcommandArgs = subcommandIndex >= 0 ? args.slice(subcommandIndex + 1) : [];
	if (command === "sed") return args.includes("-n") || args.some((argument) => argument.startsWith("-n"));
	if (command === "git") {
		if (!subcommand || !["status", "log", "diff", "show", "branch", "remote", "ls-files", "grep"].includes(subcommand)) return false;
		if (subcommand === "branch" && subcommandArgs.some((argument) => !argument.startsWith("-"))) return false;
		if (
			subcommand === "branch" &&
			subcommandArgs.some((argument) =>
				["-d", "-D", "-m", "-M", "-c", "-C", "--delete", "--move", "--copy", "--edit-description"].includes(
					argument,
				),
			)
		)
			return false;
		if (
			subcommand === "remote" &&
			subcommandArgs.some((argument) =>
				["add", "remove", "rename", "set-url", "prune", "update"].includes(argument),
			)
		)
			return false;
		if (args.some((argument) => argument === "--output" || argument.startsWith("--output="))) return false;
		return true;
	}
	if (["node", "python", "python3", "tsc", "biome", "ruff", "ty"].includes(command)) {
		return args.includes("--version") || (command === "tsc" && args.includes("--noEmit"));
	}
	if (command === "npm") {
		if (["list", "ls", "view", "info", "search", "outdated", "audit", "test"].includes(subcommand ?? "")) {
			return true;
		}
		return subcommand === "run" && ["test", "check", "typecheck", "lint", "build"].includes(args[1] ?? "");
	}
	if (["cargo", "go", "pytest", "vitest", "jest"].includes(command)) {
		return ["test", "check", "build"].includes(subcommand ?? "") || ["pytest", "vitest", "jest"].includes(command);
	}
	return false;
}
