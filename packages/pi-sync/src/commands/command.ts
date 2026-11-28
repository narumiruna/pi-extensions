import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { AUTOMATIC_SYNC_DESCRIPTION, STARTUP_TRANSFER_DESCRIPTION } from "../ui/sync-behavior.js";
import type { CommandArgumentCompletion, CommandOptions } from "./command-types.js";

const YES_FLAG_COMPLETIONS: readonly CommandArgumentCompletion[] = [
  { value: "--yes", label: "--yes", description: "Skip confirmation prompts" },
  { value: "-y", label: "-y", description: "Skip confirmation prompts" },
];
export const SYNC_COMMANDS = [
  { name: "help", description: "Show command usage" },
  { name: "use", description: "Switch the current sync setup", usageSuffix: " <setup>" },
  { name: "init", description: "Create local config template" },
  { name: "files", description: "Choose included content" },
  { name: "diff", description: "Show local/remote diff" },
  { name: "conflicts", description: "Review private unresolved conflict groups" },
  {
    name: "daemon",
    description: "Review service handover and unattended permission",
    usageSuffix: " [status|recover|handover|allow-after-exit|revoke-after-exit]",
  },
  { name: "push", description: "Upload local settings" },
  { name: "pull", description: "Apply remote settings" },
  { name: "sync", description: "Push or pull as needed" },
  { name: "history", description: "Show recent remote snapshots" },
  { name: "rollback", description: "Apply a previous snapshot", usageSuffix: " <snapshot>" },
  { name: "migrate-state", description: "Move legacy state into pi-sync/" },
  { name: "unlock", description: "Remove a stale local lock", usageSuffix: " --stale" },
] as const;

export type SyncCommandName = (typeof SYNC_COMMANDS)[number]["name"];

const SYNC_COMMAND_COMPLETIONS: readonly CommandArgumentCompletion[] = SYNC_COMMANDS.map(({ name, description }) => ({
  value: name,
  label: name,
  description,
}));
let setupCompletionNames: string[] = [];

export function setSyncSetupCompletions(names: readonly string[]) {
  setupCompletionNames = [...new Set(names)].sort((left, right) => left.localeCompare(right));
}
const SETUP_FLAG_COMPLETION = {
  value: "--setup",
  label: "--setup",
  description: "Address a sync setup without switching",
} as const;
const SYNC_FLAG_COMPLETIONS: Record<string, readonly CommandArgumentCompletion[]> = {
  files: [SETUP_FLAG_COMPLETION],
  diff: [SETUP_FLAG_COMPLETION],
  conflicts: [SETUP_FLAG_COMPLETION],
  push: [
    ...YES_FLAG_COMPLETIONS,
    { value: "--force", label: "--force", description: "Overwrite visible remote changes" },
    SETUP_FLAG_COMPLETION,
  ],
  pull: [
    ...YES_FLAG_COMPLETIONS,
    { value: "--force", label: "--force", description: "Overwrite local changes" },
    SETUP_FLAG_COMPLETION,
  ],
  sync: [
    ...YES_FLAG_COMPLETIONS,
    { value: "--force", label: "--force", description: "Resolve conflicts by forcing action" },
    SETUP_FLAG_COMPLETION,
  ],
  history: [SETUP_FLAG_COMPLETION],
  rollback: [...YES_FLAG_COMPLETIONS, SETUP_FLAG_COMPLETION],
  "migrate-state": YES_FLAG_COMPLETIONS,
  unlock: [{ value: "--stale", label: "--stale", description: "Remove only a stale lock" }],
};

function syncFlagCompletions(command: string) {
  return Object.hasOwn(SYNC_FLAG_COMPLETIONS, command) ? SYNC_FLAG_COMPLETIONS[command] : undefined;
}

export function splitArgs(input: string) {
  return input.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g)?.map((arg) => arg.replace(/^['"]|['"]$/g, "")) ?? [];
}

export function parseOptions(args: string[]): CommandOptions {
  const values: string[] = [];
  let yes = false;
  let force = false;
  let stale = false;
  let setup: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--yes" || arg === "-y") yes = true;
    else if (arg === "--force") force = true;
    else if (arg === "--stale") stale = true;
    else if (arg === "--setup") {
      const name = args[index + 1];
      if (!name || name.startsWith("-")) throw new Error("--setup requires a sync setup name.");
      if (setup !== undefined) throw new Error("--setup may be provided only once.");
      setup = name;
      index += 1;
    } else if (arg.startsWith("-")) {
      throw new Error(`Unknown sync option: ${arg}`);
    } else values.push(arg);
  }
  return {
    yes,
    force,
    stale,
    silent: false,
    reload: true,
    auto: false,
    ...(setup === undefined ? {} : { setup }),
    args: values,
  };
}

export function retiredSyncCommandGuidance(command: string | undefined): string | undefined {
  if (command === "status") {
    return "/sync status was retired. Use /sync diff to view file differences, or ask Pi to recheck the current setup in Debug mode.";
  }
  if (command === "doctor") {
    return "/sync doctor was retired. Open /sync → Settings to review the setup, use /sync diff to check file differences, or open /sync → History for WebDAV history recovery.";
  }
  if (command === "config") {
    return "/sync config was retired. Open /sync → Settings to review sync setups and storage connections.";
  }
  return undefined;
}

export function validateCommandOptions(command: string, options: CommandOptions) {
  if (options.setup && !syncFlagCompletions(command)?.includes(SETUP_FLAG_COMPLETION)) {
    throw new Error(`--setup is not supported by /sync ${command}.`);
  }
  if (options.yes && !["push", "pull", "sync", "rollback", "migrate-state"].includes(command)) {
    throw new Error(`Confirmation/force options are not supported by /sync ${command}.`);
  }
  if (options.force && !["push", "pull", "sync", "rollback"].includes(command)) {
    throw new Error(`Confirmation/force options are not supported by /sync ${command}.`);
  }
  if (options.stale && command !== "unlock") {
    throw new Error(`--stale is not supported by /sync ${command}.`);
  }
  if (command === "daemon" && options.args.length <= 1) {
    const action = options.args[0];
    if (action !== undefined && !DAEMON_ACTIONS.some((value) => value === action))
      throw new Error(`Unknown daemon action: ${action}`);
    return;
  }
  const expectedValues = command === "rollback" || command === "use" ? 1 : 0;
  if (options.args.length !== expectedValues) {
    if (command === "rollback") throw new Error("Usage: /sync rollback <snapshot-id> [--yes] [--setup <name>]");
    if (command === "use") throw new Error("Usage: /sync use <setup>");
    throw new Error(`Unexpected argument for /sync ${command}: ${options.args.join(" ")}`);
  }
}

const DAEMON_ACTIONS = ["status", "recover", "handover", "allow-after-exit", "revoke-after-exit"] as const;

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

  const args = tokens.slice(1);
  if (command === "use") {
    if (args.length > 1 || (trailingSpace && args.length > 0)) return null;
    return completeSetupValue(prefix, trailingSpace ? "" : (args[0] ?? ""));
  }
  if (command === "daemon") {
    if (args.length > 1 || (trailingSpace && args.length > 0)) return null;
    const current = trailingSpace ? "" : (args[0] ?? "");
    const base = trailingSpace ? prefix : prefix.slice(0, prefix.length - current.length);
    const matches = DAEMON_ACTIONS.filter((action) => action.startsWith(current));
    return matches.length
      ? matches.map((action) => ({ value: `${base}${action}`, label: action, description: "Daemon control" }))
      : null;
  }
  const flagCompletions = syncFlagCompletions(command);
  if (!flagCompletions) return null;
  const setupFlagIndex = args.lastIndexOf("--setup");
  if (
    flagCompletions.includes(SETUP_FLAG_COMPLETION) &&
    setupFlagIndex >= 0 &&
    setupFlagIndex === args.length - (trailingSpace ? 1 : 2)
  ) {
    const currentSetup = trailingSpace ? "" : (args.at(-1) ?? "");
    if (!currentSetup.startsWith("-")) return completeSetupValue(prefix, currentSetup);
  }

  const completedArgs = trailingSpace ? args : args.slice(0, -1);
  const completedValues = completedArgs.filter((arg) => !arg.startsWith("-"));
  if (command === "rollback" ? completedValues.length > 1 : completedValues.length > 0) {
    return null;
  }

  const current = trailingSpace ? "" : (args.at(-1) ?? "");
  if (current && !current.startsWith("-")) return null;

  const currentRaw = trailingSpace ? "" : (prefix.match(/\S+$/)?.[0] ?? "");
  const completionPrefix = trailingSpace ? prefix : prefix.slice(0, prefix.length - currentRaw.length);
  const matches = flagCompletions.filter((item) => item.value.startsWith(current));
  return matches.length > 0 ? matches.map((item) => ({ ...item, value: `${completionPrefix}${item.value}` })) : null;
}

function completeSetupValue(prefix: string, current: string) {
  const currentRaw = current ? (prefix.match(/\S+$/u)?.[0] ?? "") : "";
  const completionPrefix = currentRaw ? prefix.slice(0, prefix.length - currentRaw.length) : prefix;
  const matches = setupCompletionNames.filter((name) => name.startsWith(current));
  return matches.length > 0
    ? matches.map((name) => ({
        value: `${completionPrefix}${name}`,
        label: name,
        description: "Sync setup",
      }))
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
    "In the /sync manager, Push to remote and Pull from remote use the chosen source and preserve a restore point without a second confirmation. Direct commands retain their existing review and flags.",
    "To review file differences without transferring files, use /sync diff. For check summaries or a confirmed recheck, start or /reload Pi with Debug mode enabled and ask Pi to use pi_sync_debug.",
    "Daemon diagnostics: /sync daemon status shows service status. /sync daemon recover reviews and stops the existing daemon without starting a replacement or retrying a transfer.",
    `Automatic sync: ${AUTOMATIC_SYNC_DESCRIPTION}`,
    `Startup transfer: ${STARTUP_TRANSFER_DESCRIPTION}`,
    "Automatic transfer at startup is a separate opt-in: one conflict-free established-baseline transfer at idle in TUI/RPC, with conditional/lease publication and no resource reload.",
    "Autonomous sync and Continuous sync are retired. Saved flags no longer transfer files or call a model. Use Sync now to review a transfer or enable Startup transfer for one eligible startup sync.",
    "New after-exit grants are not supported. Use /sync daemon revoke-after-exit to clear a retained grant.",
    "Settings: open /sync → Settings to review sync setups and storage connections. Use /sync init or edit pi-sync.json in the Pi agent directory for manual setup. Version 1 and version 2 settings are unsupported and are never rewritten.",
  ].join("\n");
}
