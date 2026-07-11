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
		command === "sed" &&
		args.some(
			(argument) =>
				argument.startsWith("--in-place=") ||
				(/^-[^-]+/.test(argument) && argument.slice(1).includes("i")),
		)
	) {
		return false;
	}
	if (
		command === "find" &&
		args.some((argument) =>
			["-exec", "-execdir", "-ok", "-okdir", "-fprint", "-fprint0", "-fprintf", "-fls"].includes(
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
		args.some(
			(argument) =>
				argument === "-o" ||
				(argument.startsWith("-o") && !argument.startsWith("--")) ||
				argument.startsWith("--output"),
		)
	) {
		return false;
	}
	if (
		command === "sort" &&
		args.some(
			(argument) =>
				argument === "-T" ||
				(argument.startsWith("-T") && argument.length > 2) ||
				argument.startsWith("--temporary-directory") ||
				argument.startsWith("--compress-program"),
		)
	) {
		return false;
	}
	if (
		command === "diff" &&
		args.some((argument) => argument === "--output" || argument.startsWith("--output="))
	) {
		return false;
	}
	if (command === "uniq" && args.filter((argument) => !argument.startsWith("-")).length > 1) {
		return false;
	}
	if (
		command === "fd" &&
		args.some((argument) =>
			["-x", "-X", "--exec", "--exec-batch"].some(
				(flag) => argument === flag || argument.startsWith(`${flag}=`),
			),
		)
	) {
		return false;
	}
	if (
		command === "rg" &&
		args.some((argument) => argument === "--pre" || argument.startsWith("--pre="))
	) {
		return false;
	}
	if (
		command === "bat" &&
		args.some((argument) => argument === "--pager" || argument.startsWith("--pager="))
	) {
		return false;
	}
	return true;
}

function isSafeStructuredCommand(command: string, args: string[]) {
	const subcommandIndex = args.findIndex((argument) => !argument.startsWith("-"));
	const subcommand = args[subcommandIndex]?.toLowerCase();
	const subcommandArgs = subcommandIndex >= 0 ? args.slice(subcommandIndex + 1) : [];
	if (command === "sed") {
		const script = args.find((argument) => !argument.startsWith("-"));
		return (
			Boolean(script) &&
			(args.includes("-n") || args.some((argument) => /^-[^-]*n[^-]*$/.test(argument))) &&
			/^\d+(,\d+)?p$/.test(script ?? "")
		);
	}
	if (command === "git") {
		if (!subcommand || !["status", "log", "diff", "show", "branch", "remote", "ls-files", "grep"].includes(subcommand)) return false;
		if (subcommand === "branch" && subcommandArgs.some((argument) => !argument.startsWith("-"))) return false;
		if (
			subcommand === "branch" &&
			subcommandArgs.some(
				(argument) =>
					[
						"-d",
						"-D",
						"-m",
						"-M",
						"-c",
						"-C",
						"--delete",
						"--move",
						"--copy",
						"--edit-description",
						"--unset-upstream",
					].includes(argument) || argument.startsWith("--set-upstream-to"),
			)
		)
			return false;
		if (subcommand === "remote") {
			const action = subcommandArgs.find((argument) => !argument.startsWith("-"));
			if (action && action !== "show" && action !== "get-url") return false;
		}
		if (
			args.some(
				(argument) =>
					argument === "--output" ||
					argument.startsWith("--output=") ||
					argument === "--ext-diff" ||
					argument === "--textconv" ||
					argument === "--open-files-in-pager" ||
					argument.startsWith("--open-files-in-pager=") ||
					(subcommand === "grep" && (argument === "-O" || argument.startsWith("-O"))),
			)
		)
			return false;
		return true;
	}
	if (["node", "python", "python3", "tsc", "biome", "ruff", "ty"].includes(command)) {
		if (args.includes("--version")) return true;
		return (
			command === "tsc" &&
			args.includes("--noEmit") &&
			!args.some(
				(argument) =>
					argument === "--incremental" ||
					argument.startsWith("--incremental=") ||
					argument === "--tsBuildInfoFile" ||
					argument.startsWith("--tsBuildInfoFile=") ||
					argument === "--generateTrace" ||
					argument.startsWith("--generateTrace="),
			)
		);
	}
	if (command === "npm") {
		if (subcommand === "audit" && subcommandArgs.includes("fix")) return false;
		if (["list", "ls", "view", "info", "search", "outdated", "audit", "test"].includes(subcommand ?? "")) {
			return true;
		}
		return subcommand === "run" && ["test", "check", "typecheck", "lint"].includes(args[1] ?? "");
	}
	if (["cargo", "go", "pytest", "vitest", "jest"].includes(command)) {
		return ["test", "check"].includes(subcommand ?? "") || ["pytest", "vitest", "jest"].includes(command);
	}
	return false;
}
