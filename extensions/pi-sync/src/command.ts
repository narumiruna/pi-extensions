import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { CommandArgumentCompletion, CommandOptions } from "./types.js";

const YES_FLAG_COMPLETIONS: readonly CommandArgumentCompletion[] = [
	{ value: "--yes", label: "--yes", description: "Skip confirmation prompts" },
	{ value: "-y", label: "-y", description: "Skip confirmation prompts" },
];
export const SYNC_COMMANDS = [
	{ name: "help", description: "Show command usage" },
	{ name: "init", description: "Create local config template" },
	{ name: "config", description: "Show resolved configuration" },
	{ name: "status", description: "Show sync status" },
	{ name: "diff", description: "Show local/remote diff" },
	{ name: "doctor", description: "Check config, secrets, and lock state" },
	{ name: "push", description: "Upload local settings" },
	{ name: "pull", description: "Apply remote settings" },
	{ name: "sync", description: "Push or pull as needed" },
	{ name: "history", description: "Show recent remote snapshots" },
	{ name: "rollback", description: "Apply a previous snapshot", usageSuffix: " <snapshot>" },
	{ name: "unlock", description: "Remove a stale local lock", usageSuffix: " --stale" },
] as const;

export type SyncCommandName = (typeof SYNC_COMMANDS)[number]["name"];

const SYNC_COMMAND_COMPLETIONS: readonly CommandArgumentCompletion[] = SYNC_COMMANDS.map(
	({ name, description }) => ({ value: name, label: name, description }),
);
const SYNC_FLAG_COMPLETIONS: Record<string, readonly CommandArgumentCompletion[]> = {
	push: [
		...YES_FLAG_COMPLETIONS,
		{ value: "--force", label: "--force", description: "Overwrite visible remote changes" },
	],
	pull: [
		...YES_FLAG_COMPLETIONS,
		{ value: "--force", label: "--force", description: "Overwrite local changes" },
	],
	sync: [
		...YES_FLAG_COMPLETIONS,
		{ value: "--force", label: "--force", description: "Resolve conflicts by forcing action" },
	],
	rollback: YES_FLAG_COMPLETIONS,
	unlock: [{ value: "--stale", label: "--stale", description: "Remove only a stale lock" }],
};

export function splitArgs(input: string) {
	return input.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g)?.map((arg) => arg.replace(/^['"]|['"]$/g, "")) ?? [];
}

export function parseOptions(args: string[]): CommandOptions {
	return {
		yes: args.includes("--yes") || args.includes("-y"),
		force: args.includes("--force"),
		stale: args.includes("--stale"),
		silent: false,
		reload: true,
		auto: false,
		args: args.filter((arg) => !arg.startsWith("-")),
	};
}

export function completeSyncArguments(argumentPrefix: string): CommandArgumentCompletion[] | null {
	const prefix = argumentPrefix.trimStart();
	if (prefix === "") return [...SYNC_COMMAND_COMPLETIONS];

	const trailingSpace = /\s$/.test(prefix);
	const tokens = splitArgs(prefix);
	if (tokens.length === 0) return [...SYNC_COMMAND_COMPLETIONS];

	const [command] = tokens;
	if (tokens.length === 1 && !trailingSpace) {
		const matches = SYNC_COMMAND_COMPLETIONS.filter((item) => item.value.startsWith(command));
		return matches.length > 0 ? [...matches] : null;
	}

	const flagCompletions = SYNC_FLAG_COMPLETIONS[command];
	if (!flagCompletions) return null;

	const args = tokens.slice(1);
	const completedArgs = trailingSpace ? args : args.slice(0, -1);
	const completedValues = completedArgs.filter((arg) => !arg.startsWith("-"));
	if (command === "rollback" ? completedValues.length > 1 : completedValues.length > 0) {
		return null;
	}

	const current = trailingSpace ? "" : (args.at(-1) ?? "");
	if (current && !current.startsWith("-")) return null;

	const currentRaw = trailingSpace ? "" : (prefix.match(/\S+$/)?.[0] ?? "");
	const completionPrefix = trailingSpace
		? prefix
		: prefix.slice(0, prefix.length - currentRaw.length);
	const matches = flagCompletions.filter((item) => item.value.startsWith(current));
	return matches.length > 0
		? matches.map((item) => ({ ...item, value: `${completionPrefix}${item.value}` }))
		: null;
}

export function syncMenuOptions() {
	return SYNC_COMMANDS.map(({ name, description }) => `${name} — ${description}`);
}

export function syncCommandFromMenuOption(option: string): SyncCommandName | undefined {
	return SYNC_COMMANDS.find(({ name, description }) => option === `${name} — ${description}`)?.name;
}

export async function resolveSyncCommand(input: string, ctx: ExtensionCommandContext) {
	const [subcommand, ...rest] = splitArgs(input);
	if (subcommand) return { subcommand, rest };
	if (!ctx.hasUI) {
		ctx.ui.notify(usage(), "info");
		return undefined;
	}

	const selectedOption = await ctx.ui.select("pi-sync", syncMenuOptions());
	const selected = selectedOption ? syncCommandFromMenuOption(selectedOption) : undefined;
	if (!selected) return undefined;
	if (selected !== "rollback") return { subcommand: selected, rest: [] };

	const target = (await ctx.ui.input("Rollback snapshot", "snapshot id"))?.trim();
	if (!target) {
		ctx.ui.notify("Rollback cancelled.", "info");
		return undefined;
	}
	return { subcommand: selected, rest: [target] };
}

export function usage() {
	const commands = SYNC_COMMANDS.map(
		(command) => `${command.name}${"usageSuffix" in command ? command.usageSuffix : ""}`,
	).join(", ");
	return [
		"Usage: /sync <command>",
		`Commands: ${commands}`,
		"Config: set PI_SYNC_ENDPOINT, PI_SYNC_BUCKET, PI_SYNC_ACCESS_KEY_ID, PI_SYNC_SECRET_ACCESS_KEY, optional PI_SYNC_SESSION_TOKEN, PI_SYNC_SESSIONS/syncSessions, region/profile/prefix, or edit ~/.pi/agent/pi-sync.local.json (or $PI_CODING_AGENT_DIR/pi-sync.local.json when PI_CODING_AGENT_DIR is set).",
	].join("\n");
}
