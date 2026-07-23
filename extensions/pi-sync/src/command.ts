import type { CommandArgumentCompletion, CommandOptions } from "./types.js";

const YES_FLAG_COMPLETIONS: readonly CommandArgumentCompletion[] = [
	{ value: "--yes", label: "--yes", description: "Skip confirmation prompts" },
	{ value: "-y", label: "-y", description: "Skip confirmation prompts" },
];
const SYNC_COMMAND_COMPLETIONS: readonly CommandArgumentCompletion[] = [
	{ value: "help", label: "help", description: "Show command usage" },
	{ value: "init", label: "init", description: "Create local config template" },
	{ value: "config", label: "config", description: "Show resolved configuration" },
	{ value: "status", label: "status", description: "Show sync status" },
	{ value: "diff", label: "diff", description: "Show local/remote diff" },
	{ value: "doctor", label: "doctor", description: "Check config, secrets, and lock state" },
	{ value: "push", label: "push", description: "Upload local settings" },
	{ value: "pull", label: "pull", description: "Apply remote settings" },
	{ value: "sync", label: "sync", description: "Push or pull as needed" },
	{ value: "history", label: "history", description: "Show recent remote snapshots" },
	{ value: "rollback", label: "rollback", description: "Apply a previous snapshot" },
	{ value: "unlock", label: "unlock", description: "Remove a stale local lock" },
];
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

export function usage() {
	return [
		"Usage: /sync <command>",
		"Commands: init, config, status, diff, doctor, push, pull, sync, history, rollback <snapshot>, unlock --stale",
		"Config: set PI_SYNC_ENDPOINT, PI_SYNC_BUCKET, PI_SYNC_ACCESS_KEY_ID, PI_SYNC_SECRET_ACCESS_KEY, optional PI_SYNC_SESSION_TOKEN, PI_SYNC_SESSIONS/syncSessions, region/profile/prefix, or edit ~/.pi/agent/pi-sync.local.json (or $PI_CODING_AGENT_DIR/pi-sync.local.json when PI_CODING_AGENT_DIR is set).",
	].join("\n");
}
