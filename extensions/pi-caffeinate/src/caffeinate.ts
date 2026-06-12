import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import pathModule from "node:path";
import process from "node:process";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "@mariozechner/pi-coding-agent";

const STATUS_KEY = "caffeinate";
const DISABLED_VALUES = new Set(["1", "true", "yes", "on"]);
const DEFAULT_MODE = "display" satisfies CaffeinateMode;
const SETTINGS_FILE = join(
	process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"),
	"pi-caffeinate-settings.json",
);
const COMMAND_COMPLETIONS = [
	{ value: "help", label: "Show command usage" },
	{ value: "status", label: "Show current caffeinate status" },
	{ value: "mode", label: "Select keep-awake mode" },
	{ value: "sleep", label: "Sleep only — let screen turn off" },
	{ value: "display", label: "Keep screen awake" },
	{ value: "stop", label: "Stop keeping awake" },
];
const MENU_OPTIONS = {
	status: "Status",
	sleep: "Sleep only — let screen turn off",
	display: "Keep screen awake",
	stop: "Stop keeping awake",
	help: "Help",
} as const;
const MODE_OPTIONS = {
	sleep: "Sleep only — let screen turn off",
	display: "Keep screen awake",
} as const;

type CaffeinateMode = "sleep" | "display";
type CommandAction = "menu" | "help" | "status" | "mode" | "sleep" | "display" | "stop";
type CommandContext = ExtensionCommandContext;

interface InhibitorCommand {
	command: string;
	args: string[];
	description: string;
	releaseOnStdinClose?: boolean;
	custom?: boolean;
}

interface CaffeinateState {
	process?: ChildProcess;
	startedAt?: number;
	command?: InhibitorCommand;
	lastError?: string;
	activeTurns: number;
	available: boolean;
	disabled: boolean;
	mode: CaffeinateMode;
	settingsLoaded: boolean;
	settingsError?: string;
}

interface CaffeinateSettings {
	mode: CaffeinateMode;
	updatedAt: number;
}

const state: CaffeinateState = {
	activeTurns: 0,
	available: true,
	disabled: isDisabled(),
	mode: DEFAULT_MODE,
	settingsLoaded: false,
};

export default function caffeinate(pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => {
		await loadSettingsIntoState(ctx);
		updateStatus(ctx);
	});

	pi.on("agent_start", async (_event, ctx) => {
		await ensureSettingsLoaded(ctx);
		state.activeTurns += 1;
		startInhibitor(ctx);
	});

	pi.on("agent_end", (_event, ctx) => {
		state.activeTurns = Math.max(0, state.activeTurns - 1);
		if (state.activeTurns === 0) stopInhibitor(ctx, "agent finished");
		updateStatus(ctx);
	});

	pi.on("session_shutdown", (_event, ctx) => {
		state.activeTurns = 0;
		stopInhibitor(ctx, "session shutdown", { notify: false });
		ctx.ui.setStatus(STATUS_KEY, undefined);
	});

	pi.registerCommand("caffeinate", {
		description: "Open pi-caffeinate mode and status controls",
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

	const choice = await ctx.ui.select("pi-caffeinate", Object.values(MENU_OPTIONS));
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
		await saveSettings({ mode, updatedAt: Date.now() });
	} catch (error) {
		saved = false;
		state.settingsError = `settings save failed: ${formatError(error)}`;
		ctx.ui.notify(`pi-caffeinate settings save failed: ${formatError(error)}`, "warning");
	}

	if (state.process && previousMode !== mode && !state.command?.custom) {
		stopInhibitor(ctx, "mode changed", { notify: false });
		startInhibitor(ctx);
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

function parseCommand(args: string): CommandAction | "unknown" {
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

function commandCompletions(prefix: string) {
	const normalized = prefix.trim().toLowerCase();
	if (normalized.includes(" ")) return null;

	const matches = COMMAND_COMPLETIONS.filter((completion) =>
		completion.value.startsWith(normalized),
	);
	return matches.length > 0 ? matches : null;
}

function buildCommandGuide() {
	return [
		"pi-caffeinate commands:",
		"/caffeinate — open mode and status controls",
		"/caffeinate status — show current mode, settings, and inhibitor state",
		"/caffeinate mode — choose sleep-only or display-awake mode",
		"/caffeinate sleep — prevent system sleep only and allow the display to turn off",
		"/caffeinate display — prevent system sleep and keep the screen awake",
		"/caffeinate stop — release the active inhibitor until the next agent run",
	].join("\n");
}

function startInhibitor(ctx: ExtensionContext) {
	if (state.disabled) {
		updateStatus(ctx);
		return;
	}

	if (state.process) {
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
		const child = spawn(command.command, command.args, {
			detached: false,
			stdio: [command.releaseOnStdinClose ? "pipe" : "ignore", "pipe", "pipe"],
		});

		state.process = child;
		state.startedAt = Date.now();
		state.command = command;
		state.available = true;
		state.lastError = undefined;

		child.once("error", (error) => {
			if (state.process === child) {
				state.process = undefined;
				state.startedAt = undefined;
			}
			state.available = false;
			state.lastError = `${command.description} failed: ${error.message}`;
			ctx.ui.notify(state.lastError, "warning");
			updateStatus(ctx);
		});

		child.once("exit", (code, signal) => {
			if (state.process !== child) return;
			state.process = undefined;
			state.startedAt = undefined;
			state.lastError = `${command.description} exited unexpectedly (${formatExit(code, signal)}).`;
			ctx.ui.notify(state.lastError, "warning");
			updateStatus(ctx);
		});

		ctx.ui.notify(`Keeping computer awake with ${command.description}.`, "info");
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

	child.removeAllListeners("exit");
	child.removeAllListeners("error");

	if (!child.killed) {
		if (state.command?.releaseOnStdinClose && child.stdin && !child.stdin.destroyed) {
			child.stdin.end();
			if (child.exitCode === null && child.signalCode === null) {
				const killTimer = setTimeout(() => {
					if (child.exitCode === null && child.signalCode === null && !child.killed) child.kill();
				}, 2000);
				killTimer.unref();
				child.once("exit", () => clearTimeout(killTimer));
			}
		} else if (process.platform === "win32") {
			child.kill();
		} else {
			child.kill("SIGTERM");
		}
	}

	state.command = undefined;

	if (options.notify !== false) {
		ctx.ui.notify(`Released pi-caffeinate (${reason}).`, "info");
	}
}

function getInhibitorCommand(mode: CaffeinateMode): InhibitorCommand | undefined {
	const customCommand = process.env.PI_CAFFEINATE_COMMAND?.trim();
	if (customCommand) {
		const [command, ...args] = splitCommand(customCommand);
		if (command) return { command, args, description: `custom command (${command})`, custom: true };
	}

	if (process.platform === "darwin") {
		return parentBoundUnixCommand("caffeinate", macCaffeinateArgs(mode), caffeinateDescription(mode));
	}

	if (process.platform === "linux") {
		if (isWsl() && commandExists("powershell.exe")) {
			return windowsPowerInhibitorCommand("powershell.exe", mode);
		}

		if (commandExists("systemd-inhibit")) {
			const what = mode === "sleep" ? "sleep" : "idle:sleep";
			return parentBoundUnixCommand(
				"systemd-inhibit",
				[
					`--what=${what}`,
					"--who=pi-caffeinate",
					"--why=Pi agent is running",
					"--mode=block",
					"sleep",
					"infinity",
				],
				`systemd-inhibit (${formatMode(mode)})`,
			);
		}

		if (commandExists("caffeinate")) {
			return parentBoundUnixCommand(
				"caffeinate",
				macCaffeinateArgs(mode),
				caffeinateDescription(mode),
			);
		}
	}

	if (process.platform === "win32") {
		return windowsPowerInhibitorCommand("powershell.exe", mode);
	}

	return undefined;
}

function macCaffeinateArgs(mode: CaffeinateMode) {
	return mode === "sleep" ? ["-ims"] : ["-dimsu"];
}

function caffeinateDescription(mode: CaffeinateMode) {
	return `caffeinate (${formatMode(mode)})`;
}

function parentBoundUnixCommand(
	command: string,
	args: string[],
	description: string,
): InhibitorCommand {
	return {
		command: "sh",
		args: [
			"-c",
			unixParentBoundScript(),
			"pi-caffeinate-watch",
			String(process.pid),
			command,
			...args,
		],
		description,
	};
}

function unixParentBoundScript() {
	return `parent=$1; shift; "$@" & child=$!; ( while kill -0 "$parent" 2>/dev/null; do sleep 5; done; kill "$child" 2>/dev/null ) & watcher=$!; cleanup() { kill "$watcher" 2>/dev/null; kill "$child" 2>/dev/null; wait "$child" 2>/dev/null; }; trap 'cleanup; exit 0' INT TERM HUP EXIT; wait "$child"; status=$?; kill "$watcher" 2>/dev/null; trap - EXIT; exit "$status"`;
}

function commandExists(command: string) {
	const path = process.env.PATH ?? "";
	const extensions = process.platform === "win32" ? ["", ".exe", ".cmd", ".bat"] : [""];

	for (const directory of path.split(process.platform === "win32" ? ";" : ":")) {
		if (!directory) continue;
		for (const extension of extensions) {
			const candidate = pathModule.join(directory, `${command}${extension}`);
			if (existsSync(candidate)) return true;
		}
	}

	return false;
}

function splitCommand(input: string) {
	const parts: string[] = [];
	let current = "";
	let quote: '"' | "'" | undefined;
	let escaping = false;

	for (const char of input) {
		if (escaping) {
			current += char;
			escaping = false;
			continue;
		}

		if (char === "\\") {
			escaping = true;
			continue;
		}

		if ((char === '"' || char === "'") && !quote) {
			quote = char;
			continue;
		}

		if (char === quote) {
			quote = undefined;
			continue;
		}

		if (/\s/.test(char) && !quote) {
			if (current) {
				parts.push(current);
				current = "";
			}
			continue;
		}

		current += char;
	}

	if (current) parts.push(current);
	return parts;
}

function windowsPowerInhibitorCommand(command: string, mode: CaffeinateMode): InhibitorCommand {
	return {
		command,
		args: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", windowsInhibitorScript(mode)],
		description: `PowerShell SetThreadExecutionState (${formatMode(mode)})`,
		releaseOnStdinClose: true,
	};
}

function windowsInhibitorScript(mode: CaffeinateMode) {
	const flags = mode === "sleep" ? "0x80000001" : "0x80000003";
	return `$ErrorActionPreference = 'Stop'; Add-Type -Namespace Native -Name Power -MemberDefinition '[DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint esFlags);'; $flags = [uint32]'${flags}'; $release = [uint32]'0x80000000'; $stdin = [Console]::OpenStandardInput(); $buffer = New-Object byte[] 1; $readTask = $stdin.ReadAsync($buffer, 0, 1); try { while ($true) { [Native.Power]::SetThreadExecutionState($flags) | Out-Null; if ($readTask.Wait(30000)) { break } } } finally { [Native.Power]::SetThreadExecutionState($release) | Out-Null }`;
}

function isWsl() {
	try {
		return existsSync("/proc/sys/fs/binfmt_misc/WSLInterop");
	} catch {
		return false;
	}
}

function updateStatus(ctx: ExtensionContext) {
	if (state.disabled) {
		ctx.ui.setStatus(STATUS_KEY, undefined);
		return;
	}

	if (state.process) {
		ctx.ui.setStatus(STATUS_KEY, `${getIcon()} ${statusModeLabel()}`);
		return;
	}

	if (!state.available) {
		ctx.ui.setStatus(STATUS_KEY, `${getIcon()} unavailable`);
		return;
	}

	ctx.ui.setStatus(STATUS_KEY, undefined);
}

function describeState() {
	const customCommand = hasCustomCommand();
	const lines = [
		`Mode: ${formatMode(state.mode)}${customCommand ? " (overridden by custom command)" : ""}`,
		`Settings: ${SETTINGS_FILE}`,
	];

	if (customCommand) lines.push("Custom command: PI_CAFFEINATE_COMMAND overrides the saved mode.");
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
	return state.mode === "sleep" ? "sleep" : "display";
}

function formatMode(mode: CaffeinateMode) {
	return mode === "sleep" ? "sleep-only" : "display-awake";
}

async function ensureSettingsLoaded(ctx: ExtensionContext) {
	if (state.disabled || state.settingsLoaded) return;
	await loadSettingsIntoState(ctx);
}

async function loadSettingsIntoState(ctx: ExtensionContext) {
	if (state.disabled) {
		state.settingsLoaded = true;
		state.settingsError = undefined;
		return;
	}

	const settings = await loadSettings();
	state.settingsLoaded = true;
	state.settingsError = undefined;

	if (settings.kind === "loaded") {
		state.mode = settings.settings.mode;
		return;
	}

	state.mode = DEFAULT_MODE;
	if (settings.kind === "invalid") {
		state.settingsError = settings.reason;
		ctx.ui.notify(
			`pi-caffeinate settings ignored: ${settings.reason}; using ${formatMode(DEFAULT_MODE)} mode.`,
			"warning",
		);
	}
}

async function loadSettings(): Promise<
	| { kind: "missing" }
	| { kind: "invalid"; reason: string }
	| { kind: "loaded"; settings: CaffeinateSettings }
> {
	let text: string;
	try {
		text = await readFile(SETTINGS_FILE, "utf8");
	} catch (error) {
		if (isNodeError(error) && error.code === "ENOENT") return { kind: "missing" };
		return { kind: "invalid", reason: formatError(error) };
	}

	try {
		const parsed = JSON.parse(text) as unknown;
		const settings = normalizeCaffeinateSettings(parsed);
		if (settings) return { kind: "loaded", settings };
		return { kind: "invalid", reason: 'expected { "mode": "sleep" | "display" }' };
	} catch (error) {
		return { kind: "invalid", reason: formatError(error) };
	}
}

function normalizeCaffeinateSettings(value: unknown): CaffeinateSettings | undefined {
	if (!value || typeof value !== "object") return undefined;
	const settings = value as { mode?: unknown; updatedAt?: unknown };
	if (!isCaffeinateMode(settings.mode)) return undefined;
	if (settings.updatedAt !== undefined && typeof settings.updatedAt !== "number") return undefined;
	return { mode: settings.mode, updatedAt: settings.updatedAt ?? 0 };
}

function isCaffeinateMode(value: unknown): value is CaffeinateMode {
	return value === "sleep" || value === "display";
}

async function saveSettings(settings: CaffeinateSettings) {
	await mkdir(dirname(SETTINGS_FILE), { recursive: true });
	const tempFile = `${SETTINGS_FILE}.${process.pid}.${Date.now()}.tmp`;
	try {
		await writeFile(tempFile, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
		await rename(tempFile, SETTINGS_FILE);
	} catch (error) {
		await rm(tempFile, { force: true }).catch(() => undefined);
		throw error;
	}
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
	return error instanceof Error && "code" in error;
}

function formatError(error: unknown) {
	return error instanceof Error ? error.message : String(error);
}

function formatExit(code: number | null, signal: NodeJS.Signals | null) {
	if (signal) return `signal ${signal}`;
	return `code ${code ?? "unknown"}`;
}

function isDisabled() {
	const value = process.env.PI_CAFFEINATE_DISABLED?.trim().toLowerCase();
	return value ? DISABLED_VALUES.has(value) : false;
}

function hasCustomCommand() {
	return Boolean(process.env.PI_CAFFEINATE_COMMAND?.trim());
}

function getIcon() {
	return process.env.PI_CAFFEINATE_ICON?.trim() ?? "💊";
}
