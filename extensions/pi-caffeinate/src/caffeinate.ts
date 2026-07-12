import type { ChildProcess } from "node:child_process";
import process from "node:process";
import { startInhibitorProcess, stopInhibitorProcess } from "./inhibitor-process.js";
import {
	formatMode,
	getInhibitorCommand,
	type InhibitorCommand,
	splitCommand,
	windowsInhibitorScript,
} from "./inhibitors.js";
import {
	type CaffeinateMode,
	loadSettings,
	normalizeCaffeinateSettings,
	saveSettings,
	settingsFilePath,
} from "./settings.js";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";

const STATUS_KEY = "caffeinate";
const DISABLED_VALUES = new Set(["1", "true", "yes", "on"]);
const DEFAULT_MODE = "display" satisfies CaffeinateMode;
const COMMAND_COMPLETIONS = [
	{ value: "display", label: "display", description: "Keep system and display awake" },
	{ value: "sleep", label: "sleep", description: "Keep system awake; allow display sleep" },
	{ value: "status", label: "status", description: "Show current status" },
	{ value: "mode", label: "mode", description: "Choose keep-awake mode" },
	{ value: "stop", label: "stop", description: "Release inhibitor for now" },
	{ value: "help", label: "help", description: "Show command help" },
];
const MENU_OPTIONS = {
	display: "Keep system and display awake",
	sleep: "Keep system awake; allow display sleep",
	status: "Show current status",
	stop: "Release inhibitor for now",
	help: "Show command help",
} as const;
const MODE_OPTIONS = {
	display: "Keep system and display awake",
	sleep: "Keep system awake; allow display sleep",
} as const;

type CommandAction = "menu" | "help" | "status" | "mode" | "sleep" | "display" | "stop";
type CommandContext = ExtensionCommandContext;

interface CaffeinateState {
	process?: ChildProcess;
	startedAt?: number;
	command?: InhibitorCommand;
	lastError?: string;
	activeTurns: number;
	available: boolean;
	disabled: boolean;
	mode: CaffeinateMode;
	quiet: boolean;
	settingsLoaded: boolean;
	settingsError?: string;
	settingsNotice?: string;
	iconWarningShown: boolean;
}

const state: CaffeinateState = {
	activeTurns: 0,
	available: true,
	disabled: isDisabled(),
	mode: DEFAULT_MODE,
	quiet: false,
	settingsLoaded: false,
	iconWarningShown: false,
};

export default function caffeinate(pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => {
		state.iconWarningShown = false;
		state.settingsNotice = undefined;
		warnDeprecatedIcon(ctx);
		await loadSettingsIntoState(ctx);
		updateStatus(ctx);
	});

	pi.on("agent_start", async (_event, ctx) => {
		await ensureSettingsLoaded(ctx);
		state.activeTurns += 1;
		startInhibitor(ctx, { notify: !state.quiet });
	});

	pi.on("agent_end", (_event, ctx) => {
		state.activeTurns = Math.max(0, state.activeTurns - 1);
		if (state.activeTurns === 0) {
			stopInhibitor(ctx, "agent finished", { notify: !state.quiet });
		}
		updateStatus(ctx);
	});

	pi.on("session_shutdown", (_event, ctx) => {
		state.activeTurns = 0;
		stopInhibitor(ctx, "session shutdown", { notify: false });
		ctx.ui.setStatus(STATUS_KEY, undefined);
	});

	pi.registerCommand("caffeinate", {
		description: "Open pi-caffeinate keep-awake controls",
		getArgumentCompletions: (prefix) => commandCompletions(prefix),
		handler: async (args, ctx) => {
			await ensureSettingsLoaded(ctx);
			await handleCaffeinateCommand(args, ctx);
		},
	});

}

async function handleCaffeinateCommand(args: string, ctx: CommandContext) {
	const command = parseCommand(args);
	switch (command) {
		case "menu":
			await showMenu(ctx);
			return;
		case "help":
			ctx.ui.notify(buildCommandGuide(), "info");
			return;
		case "status":
			showStatus(ctx);
			return;
		case "mode":
			await showModeSelector(ctx);
			return;
		case "sleep":
			await setMode(ctx, "sleep");
			return;
		case "display":
			await setMode(ctx, "display");
			return;
		case "stop":
			stopCaffeinate(ctx, "manual stop");
			return;
	}

	ctx.ui.notify(`Unknown /caffeinate command: ${args.trim()}\n\n${buildCommandGuide()}`, "warning");
}

async function showMenu(ctx: CommandContext) {
	if (!ctx.hasUI) {
		ctx.ui.notify(`${buildCommandGuide()}\n\n${describeState()}`, statusLevel());
		updateStatus(ctx);
		return;
	}

	const choice = await ctx.ui.select("pi-caffeinate controls", Object.values(MENU_OPTIONS));
	switch (choice) {
		case MENU_OPTIONS.status:
			showStatus(ctx);
			return;
		case MENU_OPTIONS.sleep:
			await setMode(ctx, "sleep");
			return;
		case MENU_OPTIONS.display:
			await setMode(ctx, "display");
			return;
		case MENU_OPTIONS.stop:
			stopCaffeinate(ctx, "manual stop");
			return;
		case MENU_OPTIONS.help:
			ctx.ui.notify(buildCommandGuide(), "info");
			return;
	}
}

async function showModeSelector(ctx: CommandContext) {
	if (!ctx.hasUI) {
		ctx.ui.notify(
			`Mode selection needs an interactive UI. Run /caffeinate sleep or /caffeinate display.\n\n${describeState()}`,
			statusLevel(),
		);
		updateStatus(ctx);
		return;
	}

	const choice = await ctx.ui.select(
		`pi-caffeinate mode (current: ${formatMode(state.mode)})`,
		Object.values(MODE_OPTIONS),
	);
	if (choice === MODE_OPTIONS.sleep) {
		await setMode(ctx, "sleep");
		return;
	}
	if (choice === MODE_OPTIONS.display) {
		await setMode(ctx, "display");
	}
}

async function setMode(ctx: ExtensionContext, mode: CaffeinateMode) {
	const previousMode = state.mode;
	state.mode = mode;
	state.settingsError = undefined;

	let saved = true;
	try {
		await saveSettings({ mode, quiet: state.quiet, updatedAt: Date.now() });
	} catch (error) {
		saved = false;
		state.settingsError = `settings save failed: ${formatError(error)}`;
		ctx.ui.notify(`pi-caffeinate settings save failed: ${formatError(error)}`, "warning");
	}

	if (state.process && previousMode !== mode && !state.command?.custom) {
		stopInhibitor(ctx, "mode changed", { notify: false });
		startInhibitor(ctx, { notify: !state.quiet });
	}

	ctx.ui.notify(
		saved
			? `pi-caffeinate mode set to ${formatMode(mode)} and saved.`
			: `pi-caffeinate mode set to ${formatMode(mode)} for this session, but settings were not saved.`,
		saved ? "info" : "warning",
	);
	updateStatus(ctx);
}

function showStatus(ctx: ExtensionContext) {
	ctx.ui.notify(describeState(), statusLevel());
	updateStatus(ctx);
}

function stopCaffeinate(ctx: ExtensionContext, reason: string) {
	state.activeTurns = 0;
	stopInhibitor(ctx, reason);
	updateStatus(ctx);
}

export function parseCommand(args: string): CommandAction | "unknown" {
	const command = args.trim().toLowerCase();
	if (!command) return "menu";
	if (command === "help") return "help";
	if (command === "status") return "status";
	if (command === "mode" || command === "config" || command === "settings") return "mode";
	if (command === "sleep" || command === "system") return "sleep";
	if (command === "display" || command === "screen") return "display";
	if (command === "stop" || command === "off") return "stop";
	return "unknown";
}

export function commandCompletions(prefix: string) {
	const normalized = prefix.trimStart().toLowerCase();
	if (/\s/.test(normalized)) return null;

	const matches = COMMAND_COMPLETIONS.filter((completion) =>
		completion.value.startsWith(normalized),
	);
	return matches.length > 0 ? matches : null;
}

function buildCommandGuide() {
	return [
		"pi-caffeinate commands:",
		"/caffeinate — open keep-awake controls",
		"/caffeinate display — keep the system and display awake",
		"/caffeinate sleep — keep the system awake while allowing display sleep",
		"/caffeinate status — show current mode, settings, and inhibitor state",
		"/caffeinate mode — choose a keep-awake mode",
		"/caffeinate stop — release the active inhibitor until the next agent run",
	].join("\n");
}

function startInhibitor(ctx: ExtensionContext, options: { notify?: boolean } = {}) {
	if (state.disabled || state.process) {
		updateStatus(ctx);
		return;
	}

	const command = getInhibitorCommand(state.mode);
	if (!command) {
		state.available = false;
		state.lastError = `No supported sleep inhibitor found for ${process.platform}.`;
		ctx.ui.notify(state.lastError, "warning");
		updateStatus(ctx);
		return;
	}

	try {
		const child = startInhibitorProcess(
			command,
			(error) => {
				if (state.process === child) {
					state.process = undefined;
					state.startedAt = undefined;
				}
				state.available = false;
				state.lastError = `${command.description} failed: ${error.message}`;
				ctx.ui.notify(state.lastError, "warning");
				updateStatus(ctx);
			},
			(exit) => {
				if (state.process !== child) return;
				state.process = undefined;
				state.startedAt = undefined;
				state.available = false;
				state.lastError = `${command.description} exited unexpectedly (${exit}).`;
				ctx.ui.notify(state.lastError, "warning");
				updateStatus(ctx);
			},
		);
		state.process = child;
		state.startedAt = Date.now();
		state.command = command;
		state.available = true;
		state.lastError = undefined;
		if (options.notify !== false) {
			ctx.ui.notify(`Keeping computer awake (${statusModeLabel()}).`, "info");
		}
		updateStatus(ctx);
	} catch (error) {
		state.process = undefined;
		state.startedAt = undefined;
		state.available = false;
		state.lastError = error instanceof Error ? error.message : String(error);
		ctx.ui.notify(`Unable to start pi-caffeinate: ${state.lastError}`, "warning");
		updateStatus(ctx);
	}
}

function stopInhibitor(ctx: ExtensionContext, reason: string, options: { notify?: boolean } = {}) {
	const child = state.process;
	if (!child) return;
	state.process = undefined;
	state.startedAt = undefined;
	stopInhibitorProcess(child, state.command);
	state.command = undefined;
	if (options.notify !== false) ctx.ui.notify(`Released pi-caffeinate (${reason}).`, "info");
}

function updateStatus(ctx: ExtensionContext) {
	if (state.disabled) {
		ctx.ui.setStatus(STATUS_KEY, undefined);
		return;
	}

	if (state.process) {
		ctx.ui.setStatus(STATUS_KEY, withDeprecatedIcon(statusModeLabel()));
		return;
	}

	if (!state.available) {
		ctx.ui.setStatus(STATUS_KEY, withDeprecatedIcon("unavailable"));
		return;
	}

	ctx.ui.setStatus(STATUS_KEY, undefined);
}

function describeState() {
	const customCommand = hasCustomCommand();
	const lines = [
		`Mode: ${formatMode(state.mode)}${customCommand ? " (overridden by custom command)" : ""}`,
		`Quiet mode: ${state.quiet ? "enabled" : "disabled"}`,
		`Settings: ${settingsFilePath()}`,
	];

	if (customCommand) lines.push("Custom command: PI_CAFFEINATE_COMMAND overrides the saved mode.");
	if (state.settingsNotice) lines.push(`Settings note: ${state.settingsNotice}`);
	if (state.settingsError) lines.push(`Settings warning: ${state.settingsError}`);
	if (state.disabled) {
		lines.unshift("pi-caffeinate is disabled by PI_CAFFEINATE_DISABLED.");
		return lines.join("\n");
	}

	if (state.process) {
		const seconds = state.startedAt ? Math.round((Date.now() - state.startedAt) / 1000) : 0;
		lines.unshift(
			`pi-caffeinate is active using ${state.command?.description ?? "an inhibitor"} for ${seconds}s.`,
		);
		return lines.join("\n");
	}

	if (!state.available) {
		lines.unshift(`pi-caffeinate is unavailable: ${state.lastError ?? "unknown reason"}`);
		return lines.join("\n");
	}

	lines.unshift("pi-caffeinate is idle and will keep the computer awake during the next agent run.");
	return lines.join("\n");
}

function statusLevel() {
	return state.available && !state.settingsError ? "info" : "warning";
}

function statusModeLabel() {
	if (state.command?.custom) return "custom";
	return formatMode(state.mode);
}

async function ensureSettingsLoaded(ctx: ExtensionContext) {
	if (state.disabled || state.settingsLoaded) return;
	await loadSettingsIntoState(ctx);
}

async function loadSettingsIntoState(ctx: ExtensionContext) {
	if (state.disabled) {
		state.settingsLoaded = true;
		state.settingsError = undefined;
		state.quiet = false;
		return;
	}

	const settings = await loadSettings();
	state.settingsLoaded = true;
	state.settingsError = undefined;
	if (settings.notice) {
		state.settingsNotice = settings.notice;
		ctx.ui.notify(settings.notice, "warning");
	}

	if (settings.kind === "loaded") {
		state.mode = settings.settings.mode;
		state.quiet = settings.settings.quiet;
		return;
	}

	state.mode = DEFAULT_MODE;
	state.quiet = false;
	if (settings.kind === "invalid") {
		state.settingsError = settings.reason;
		ctx.ui.notify(
			`pi-caffeinate settings ignored: ${settings.reason}; using ${formatMode(DEFAULT_MODE)} mode.`,
			"warning",
		);
	}
}

function formatError(error: unknown) {
	return error instanceof Error ? error.message : String(error);
}

function isDisabled() {
	const value = process.env.PI_CAFFEINATE_DISABLED?.trim().toLowerCase();
	return value ? DISABLED_VALUES.has(value) : false;
}

function hasCustomCommand() {
	return Boolean(process.env.PI_CAFFEINATE_COMMAND?.trim());
}

function withDeprecatedIcon(text: string) {
	const icon = process.env.PI_CAFFEINATE_ICON?.trim();
	return icon ? `${icon} ${text}` : text;
}

function warnDeprecatedIcon(ctx: ExtensionContext) {
	if (state.iconWarningShown || !process.env.PI_CAFFEINATE_ICON?.trim()) return;
	state.iconWarningShown = true;
	ctx.ui.notify(
		"PI_CAFFEINATE_ICON is deprecated but still works for now. If you use @narumitw/pi-statusline, move it to pi-statusline-settings.json (extensionStatusIcons.caffeinate).",
		"warning",
	);
}

export { formatMode, splitCommand, windowsInhibitorScript } from "./inhibitors.js";
export { normalizeCaffeinateSettings } from "./settings.js";
