import { isAbsolute, normalize } from "node:path";
import type { ToolInfo } from "@earendil-works/pi-coding-agent";

export const BUILTIN_SAFE_GIT_SUBCOMMANDS = [
	"status",
	"log",
	"diff",
	"show",
	"branch",
	"remote",
	"ls-files",
	"grep",
] as const;
export const CONFIGURABLE_SAFE_GIT_SUBCOMMANDS = [
	"rev-parse",
	"blame",
	"describe",
	"merge-base",
	"ls-tree",
	"cat-file",
] as const;
export const SAFE_GIT_SUBCOMMANDS = [
	...BUILTIN_SAFE_GIT_SUBCOMMANDS,
	...CONFIGURABLE_SAFE_GIT_SUBCOMMANDS,
] as const;
export const SAFE_GH_SUBCOMMAND_PATHS = ["pr view", "pr list", "issue view", "issue list"] as const;

export type BuiltinSafeGitSubcommand = (typeof BUILTIN_SAFE_GIT_SUBCOMMANDS)[number];
export type ConfigurableSafeGitSubcommand = (typeof CONFIGURABLE_SAFE_GIT_SUBCOMMANDS)[number];
export type SafeGitSubcommand = (typeof SAFE_GIT_SUBCOMMANDS)[number];
export type SafeGhSubcommandPath = (typeof SAFE_GH_SUBCOMMAND_PATHS)[number];
export interface SafeSubcommands {
	git?: SafeGitSubcommand[];
	gh?: SafeGhSubcommandPath[];
}

export const SAFE_BUILTIN_PLAN_TOOLS = new Set([
	"read",
	"bash",
	"powershell",
	"grep",
	"find",
	"ls",
]);
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
const READ_ONLY_POWERSHELL_COMMANDS = new Set([
	"cd",
	"format-list",
	"format-table",
	"get-childitem",
	"get-content",
	"get-item",
	"get-location",
	"get-process",
	"get-service",
	"measure-object",
	"out-string",
	"resolve-path",
	"select-string",
	"sort-object",
	"test-path",
	"write-output",
]);
const READ_ONLY_COMMANDS = new Set([
	"cat",
	"cd",
	"head",
	"hostname",
	"ipconfig",
	"netstat",
	"tasklist",
	"where",
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
const WMIC_BLOCKED_VERBS = new Set(["call", "create", "delete", "set"]);

export function isBuiltinTool(tool: ToolInfo) {
	return tool.sourceInfo.source === "builtin";
}

export function classifyPlanModeTool(tool: ToolInfo): PlanModeToolPolicy {
	if (!isBuiltinTool(tool)) return "user-opt-in";
	if (BLOCKED_BUILTIN_TOOLS.has(tool.name)) return "blocked";
	if (tool.name === "bash" || tool.name === "powershell") return "limited";
	return SAFE_BUILTIN_PLAN_TOOLS.has(tool.name) ? "read-only" : "blocked";
}

export function canSelectToolInPlanMode(tool: ToolInfo) {
	return classifyPlanModeTool(tool) !== "blocked";
}

export function readCommand(input: unknown) {
	const command = input as { command?: unknown } | undefined;
	return typeof command?.command === "string" ? command.command : "";
}

export function findBlockedCommandSegment(
	command: string,
	safeSubcommands: SafeSubcommands = {},
	workingDirectory?: string,
): string | undefined {
	const segments = splitShellSegments(command);
	if (!segments || segments.length === 0) return command.trim() || "(empty command)";
	return segments.find((segment) => !isSafeSegment(segment, safeSubcommands, workingDirectory));
}

export function isSafeCommand(
	command: string,
	safeSubcommands: SafeSubcommands = {},
	workingDirectory?: string,
) {
	return findBlockedCommandSegment(command, safeSubcommands, workingDirectory) === undefined;
}

export function findBlockedPowerShellCommandSegment(
	command: string,
	safeSubcommands: SafeSubcommands = {},
	workingDirectory?: string,
): string | undefined {
	const segments = splitPowerShellSegments(command);
	if (!segments || segments.length === 0) return command.trim() || "(empty command)";
	return segments.find(
		(segment) => !isSafePowerShellSegment(segment, safeSubcommands, workingDirectory),
	);
}

export function isSafePowerShellCommand(
	command: string,
	safeSubcommands: SafeSubcommands = {},
	workingDirectory?: string,
) {
	return (
		findBlockedPowerShellCommandSegment(command, safeSubcommands, workingDirectory) === undefined
	);
}

function splitPowerShellSegments(command: string): string[] | undefined {
	const trimmed = command.trim();
	if (!trimmed || /[\n\r`\u2018-\u201e]/.test(trimmed)) return undefined;

	const segments: string[] = [];
	let quote: "'" | '"' | undefined;
	let start = 0;
	for (let index = 0; index < trimmed.length; index += 1) {
		const character = trimmed[index];
		if (quote === "'") {
			if (character !== "'") continue;
			if (trimmed[index + 1] === "'") {
				index += 1;
				continue;
			}
			quote = undefined;
			continue;
		}
		if (quote === '"') {
			if (character === "$" || character === "`") return undefined;
			if (character === '"') quote = undefined;
			continue;
		}
		if (character === "'" || character === '"') {
			quote = character;
			continue;
		}
		if (["$", "@", "#", "!", "?", "{", "}", "(", ")", "[", "]", ">", "<"].includes(character)) {
			return undefined;
		}
		const next = trimmed[index + 1];
		if (character === "&" || (character === "|" && next === "|")) return undefined;
		const separatorLength = character === ";" || character === "|" ? 1 : 0;
		if (separatorLength === 0) continue;
		const segment = trimmed.slice(start, index).trim();
		if (!segment) return undefined;
		segments.push(segment);
		index += separatorLength - 1;
		start = index + 1;
	}
	if (quote) return undefined;
	const finalSegment = trimmed.slice(start).trim();
	if (!finalSegment) return undefined;
	segments.push(finalSegment);
	return segments;
}

function isSafePowerShellSegment(
	segment: string,
	safeSubcommands: SafeSubcommands,
	workingDirectory?: string,
) {
	const tokens = powerShellWords(segment);
	if (!tokens || tokens.length === 0 || tokens.includes("--%")) return false;
	const command = tokens[0]?.toLowerCase();
	if (!command) return false;
	const args = tokens.slice(1);
	if (READ_ONLY_POWERSHELL_COMMANDS.has(command)) return true;
	if (command !== "git" && command !== "gh") return false;
	return isSafeStructuredCommand(command, args, safeSubcommands, workingDirectory);
}

function powerShellWords(segment: string): string[] | undefined {
	const words: string[] = [];
	let word = "";
	let hasWord = false;
	let quote: "'" | '"' | undefined;
	for (let index = 0; index < segment.length; index += 1) {
		const character = segment[index];
		if (quote === "'") {
			if (character !== "'") {
				word += character;
				continue;
			}
			if (segment[index + 1] === "'") {
				word += "'";
				index += 1;
				continue;
			}
			quote = undefined;
			continue;
		}
		if (quote === '"') {
			if (character === '"') quote = undefined;
			else word += character;
			continue;
		}
		if (character === "'" || character === '"') {
			quote = character;
			hasWord = true;
		} else if (/\s/.test(character)) {
			if (hasWord) words.push(word);
			word = "";
			hasWord = false;
		} else {
			word += character;
			hasWord = true;
		}
	}
	if (quote) return undefined;
	if (hasWord) words.push(word);
	return words;
}

function splitShellSegments(command: string): string[] | undefined {
	const trimmed = command.trim();
	if (!trimmed || /[\n\r`]/.test(trimmed)) return undefined;
	// Tolerate pure stderr sinks so habitual `2>/dev/null` / `2>&1` suffixes don't trip the `<`/`>`/`&` guards below.
	const scanned = trimmed
		.replace(/2>&1(?!\d)/g, " ")
		.replace(/2>>?\s*(?:\/dev\/null|\$null|\$\{null\})(?![\w/])/g, " ");

	const segments: string[] = [];
	let quote: "'" | '"' | undefined;
	let escaped = false;
	let start = 0;
	for (let index = 0; index < scanned.length; index += 1) {
		const character = scanned[index];
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
		const next = scanned[index + 1];
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
		const segment = scanned.slice(start, index).trim();
		if (!segment) return undefined;
		segments.push(segment);
		index += separatorLength - 1;
		start = index + 1;
	}
	if (quote || escaped) return undefined;
	const finalSegment = scanned.slice(start).trim();
	if (!finalSegment) return undefined;
	segments.push(finalSegment);
	return segments;
}

function isSafeSegment(
	segment: string,
	safeSubcommands: SafeSubcommands,
	workingDirectory?: string,
) {
	if (hasShellExpansion(segment)) {
		return false;
	}
	const tokens = shellWords(segment);
	if (!tokens || tokens.length === 0) return false;
	// Leading `VAR=value` prefixes only scope environment within the (already vetted) command.
	let commandIndex = 0;
	while (commandIndex < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[commandIndex])) {
		commandIndex += 1;
	}
	const command = tokens[commandIndex]?.toLowerCase();
	if (!command) return true;
	if (MUTATING_COMMANDS.has(command)) return false;
	const args = tokens.slice(commandIndex + 1);
	if (!hasSafeArguments(command, args)) return false;
	if (READ_ONLY_COMMANDS.has(command)) return true;
	return isSafeStructuredCommand(command, args, safeSubcommands, workingDirectory);
}

function hasShellExpansion(segment: string) {
	let quote: "'" | '"' | undefined;
	let escaped = false;
	for (let index = 0; index < segment.length; index += 1) {
		const character = segment[index];
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
			// "$VAR" / "${VAR}" inside double quotes is harmless; keep blocking command substitution.
			else if (quote === '"' && character === "$" && segment[index + 1] === "(") return true;
			continue;
		}
		if (character === "'" || character === '"') {
			quote = character;
			continue;
		}
		// Bare * ? [ ] globbing is read-only; keep blocking $ and { } (brace expansion can forge flags).
		if (["$", "{", "}"].includes(character)) return true;
	}
	return false;
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
	if (
		command === "date" &&
		args.some((argument) => argument === "-s" || argument.startsWith("--set"))
	) {
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

type ArgumentValidator = (args: string[]) => boolean;
const allowReadOnlyArguments: ArgumentValidator = () => true;
const BUILTIN_GIT_VALIDATORS: Record<BuiltinSafeGitSubcommand, ArgumentValidator> = {
	status: allowReadOnlyArguments,
	log: allowReadOnlyArguments,
	diff: allowReadOnlyArguments,
	show: allowReadOnlyArguments,
	branch: isSafeGitBranchArguments,
	remote: isSafeGitRemoteArguments,
	"ls-files": allowReadOnlyArguments,
	grep: isSafeGitGrepArguments,
};
const CONFIGURABLE_GIT_VALIDATORS: Record<ConfigurableSafeGitSubcommand, ArgumentValidator> = {
	"rev-parse": allowReadOnlyArguments,
	blame: allowReadOnlyArguments,
	describe: allowReadOnlyArguments,
	"merge-base": allowReadOnlyArguments,
	"ls-tree": allowReadOnlyArguments,
	"cat-file": isSafeGitCatFileArguments,
};
const GH_VALIDATORS: Record<SafeGhSubcommandPath, ArgumentValidator> = {
	"pr view": isSafeGhReadArguments,
	"pr list": isSafeGhReadArguments,
	"issue view": isSafeGhReadArguments,
	"issue list": isSafeGhReadArguments,
};

function isSafeStructuredCommand(
	command: string,
	args: string[],
	safeSubcommands: SafeSubcommands,
	workingDirectory?: string,
) {
	if (command === "git") return isSafeGitCommand(args, safeSubcommands, workingDirectory);
	if (command === "gh") return isSafeGhCommand(args, safeSubcommands);

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
		if (
			["list", "ls", "view", "info", "search", "outdated", "audit", "test"].includes(
				subcommand ?? "",
			)
		) {
			return true;
		}
		return subcommand === "run" && ["test", "check", "typecheck", "lint"].includes(args[1] ?? "");
	}
	if (command === "wmic") {
		return !args.some((argument) => WMIC_BLOCKED_VERBS.has(argument.toLowerCase()));
	}
	if (["cargo", "go", "pytest", "vitest", "jest"].includes(command)) {
		return (
			["test", "check"].includes(subcommand ?? "") || ["pytest", "vitest", "jest"].includes(command)
		);
	}
	return false;
}

function isSafeGitCommand(
	args: string[],
	safeSubcommands: SafeSubcommands,
	workingDirectory?: string,
) {
	const subcommandIndex = parseGitGlobalOptions(args, workingDirectory);
	if (subcommandIndex === undefined) return false;
	const subcommand = args[subcommandIndex]?.toLowerCase();
	if (!subcommand || subcommand.startsWith("-")) return false;
	const subcommandArgs = args.slice(subcommandIndex + 1);
	const builtinValidator = (BUILTIN_GIT_VALIDATORS as Record<string, ArgumentValidator>)[
		subcommand
	];
	const configuredValidator = (CONFIGURABLE_GIT_VALIDATORS as Record<string, ArgumentValidator>)[
		subcommand
	];
	const configured = safeSubcommands.git?.includes(subcommand as SafeGitSubcommand) === true;
	const validator = builtinValidator ?? (configured ? configuredValidator : undefined);
	return (
		validator !== undefined &&
		hasSafeGitArguments(subcommand, subcommandArgs) &&
		validator(subcommandArgs)
	);
}

function parseGitGlobalOptions(args: string[], workingDirectory?: string) {
	let index = 0;
	while (index < args.length) {
		const argument = args[index];
		if (argument === "--no-pager") {
			index += 1;
			continue;
		}
		if (argument !== "-C") break;
		const directory = args[index + 1];
		if (!directory || !isCurrentWorkingDirectory(directory, workingDirectory)) return undefined;
		index += 2;
	}
	return index;
}

function isCurrentWorkingDirectory(directory: string, workingDirectory?: string) {
	if (!workingDirectory || directory.split(/[\\/]+/u).includes("..")) return false;
	if (normalize(directory) === ".") return true;
	return isAbsolute(directory) && normalize(directory) === normalize(workingDirectory);
}

function hasSafeGitArguments(subcommand: string, args: string[]) {
	return !args.some(
		(argument) =>
			argument === "--help" ||
			argument === "--show-signature" ||
			argument.startsWith("--show-signature=") ||
			argument.includes("%G") ||
			argument === "--output" ||
			argument.startsWith("--output=") ||
			argument === "--ext-diff" ||
			argument.startsWith("--ext-diff=") ||
			argument === "--textconv" ||
			argument.startsWith("--textconv=") ||
			argument === "--paginate" ||
			argument === "--open-files-in-pager" ||
			argument.startsWith("--open-files-in-pager=") ||
			(subcommand === "grep" && (argument === "-O" || argument.startsWith("-O"))),
	);
}

function isSafeGitCatFileArguments(args: string[]) {
	return !args.some(
		(argument) =>
			matchesLongOptionPrefix(argument, "--filters", "--fi") ||
			matchesLongOptionPrefix(argument, "--textconv", "--t"),
	);
}

function isSafeGitGrepArguments(args: string[]) {
	return !args.some(
		(argument) =>
			matchesLongOptionPrefix(argument, "--textconv", "--textc") ||
			matchesLongOptionPrefix(argument, "--open-files-in-pager", "--op") ||
			matchesLongOptionPrefix(argument, "--ext-grep", "--ext"),
	);
}

function matchesLongOptionPrefix(argument: string, option: string, shortest: string) {
	const optionName = argument.split("=", 1)[0] ?? "";
	return optionName.length >= shortest.length && option.startsWith(optionName);
}

function isSafeGitBranchArguments(args: string[]) {
	if (args.some((argument) => !argument.startsWith("-"))) return false;
	return !args.some(
		(argument) =>
			/^-[^-]*[dDmMcCu]/.test(argument) ||
			matchesLongOptionPrefix(argument, "--delete", "--del") ||
			matchesLongOptionPrefix(argument, "--move", "--mov") ||
			matchesLongOptionPrefix(argument, "--copy", "--cop") ||
			matchesLongOptionPrefix(argument, "--edit-description", "--e") ||
			matchesLongOptionPrefix(argument, "--unset-upstream", "--u") ||
			matchesLongOptionPrefix(argument, "--set-upstream-to", "--set-u") ||
			matchesLongOptionPrefix(argument, "--create-reflog", "--creat"),
	);
}

function isSafeGitRemoteArguments(args: string[]) {
	const actionIndex = args.findIndex((argument) => !argument.startsWith("-"));
	if (actionIndex < 0) return true;
	const action = args[actionIndex];
	if (action === "get-url") return true;
	if (action !== "show") return false;

	const showArgs = args.slice(actionIndex + 1);
	if (showArgs.includes("--")) return false;
	const remotes = showArgs.filter((argument) => !argument.startsWith("-"));
	return remotes.length === 0 || (remotes.length === 1 && showArgs.includes("-n"));
}

function isSafeGhCommand(args: string[], safeSubcommands: SafeSubcommands) {
	const group = args[0]?.toLowerCase();
	const action = args[1]?.toLowerCase();
	if (!group || !action || group.startsWith("-") || action.startsWith("-")) return false;
	const path = `${group} ${action}` as SafeGhSubcommandPath;
	if (!safeSubcommands.gh?.includes(path)) return false;
	const validator = (GH_VALIDATORS as Record<string, ArgumentValidator>)[path];
	return validator?.(args.slice(2)) ?? false;
}

function isSafeGhReadArguments(args: string[]) {
	return !args.some(isUnsafeGhReadArgument) && hasGhJsonOutput(args);
}

function isUnsafeGhReadArgument(argument: string) {
	return (
		argument.startsWith("-w") ||
		argument === "--web" ||
		argument.startsWith("--web=") ||
		argument === "--browser" ||
		argument.startsWith("--browser=") ||
		argument === "--paginate" ||
		argument === "--pager" ||
		argument.startsWith("--pager=") ||
		argument === "--output" ||
		argument.startsWith("--output=")
	);
}

function hasGhJsonOutput(args: string[]) {
	let hasJson = false;
	for (let index = 0; index < args.length; index += 1) {
		const argument = args[index];
		if (argument === "--json") {
			const value = args[index + 1];
			if (!value || value.startsWith("-")) return false;
			hasJson = true;
			index += 1;
		} else if (argument.startsWith("--json=")) {
			if (argument === "--json=") return false;
			hasJson = true;
		}
	}
	return hasJson;
}
