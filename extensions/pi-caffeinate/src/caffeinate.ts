import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import pathModule from "node:path";
import process from "node:process";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

const STATUS_KEY = "caffeinate";
const DISABLED_VALUES = new Set(["1", "true", "yes", "on"]);

interface InhibitorCommand {
	command: string;
	args: string[];
	description: string;
	releaseOnStdinClose?: boolean;
}

interface CaffeinateState {
	process?: ChildProcess;
	startedAt?: number;
	command?: InhibitorCommand;
	lastError?: string;
	activeTurns: number;
	available: boolean;
	disabled: boolean;
}

const state: CaffeinateState = {
	activeTurns: 0,
	available: true,
	disabled: isDisabled(),
};

export default function caffeinate(pi: ExtensionAPI) {
	pi.on("session_start", (_event, ctx) => {
		updateStatus(ctx);
	});

	pi.on("agent_start", (_event, ctx) => {
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

	pi.registerCommand("caffeinate-status", {
		description: "Show whether pi-caffeinate is currently keeping the computer awake",
		handler: async (_args, ctx) => {
			ctx.ui.notify(describeState(), state.process ? "info" : state.available ? "info" : "warning");
			updateStatus(ctx);
		},
	});

	pi.registerCommand("caffeinate-stop", {
		description: "Release the active pi-caffeinate sleep inhibitor",
		handler: async (_args, ctx) => {
			state.activeTurns = 0;
			stopInhibitor(ctx, "manual stop");
			updateStatus(ctx);
		},
	});
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

	const command = getInhibitorCommand();
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

function getInhibitorCommand(): InhibitorCommand | undefined {
	const customCommand = process.env.PI_CAFFEINATE_COMMAND?.trim();
	if (customCommand) {
		const [command, ...args] = splitCommand(customCommand);
		if (command) return { command, args, description: command };
	}

	if (process.platform === "darwin") {
		return parentBoundUnixCommand("caffeinate", ["-dimsu"], "caffeinate");
	}

	if (process.platform === "linux") {
		if (isWsl() && commandExists("powershell.exe")) {
			return windowsPowerInhibitorCommand("powershell.exe");
		}

		if (commandExists("systemd-inhibit")) {
			return parentBoundUnixCommand(
				"systemd-inhibit",
				[
					"--what=idle:sleep",
					"--who=pi-caffeinate",
					"--why=Pi agent is running",
					"--mode=block",
					"sleep",
					"infinity",
				],
				"systemd-inhibit",
			);
		}

		if (commandExists("caffeinate")) {
			return parentBoundUnixCommand("caffeinate", ["-dimsu"], "caffeinate");
		}
	}

	if (process.platform === "win32") {
		return windowsPowerInhibitorCommand("powershell.exe");
	}

	return undefined;
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

function windowsPowerInhibitorCommand(command: string): InhibitorCommand {
	return {
		command,
		args: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", windowsInhibitorScript()],
		description: "PowerShell SetThreadExecutionState",
		releaseOnStdinClose: true,
	};
}

function windowsInhibitorScript() {
	return `$ErrorActionPreference = 'Stop'; Add-Type -Namespace Native -Name Power -MemberDefinition '[DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint esFlags);'; $flags = [uint32]'0x80000003'; $release = [uint32]'0x80000000'; $stdin = [Console]::OpenStandardInput(); $buffer = New-Object byte[] 1; $readTask = $stdin.ReadAsync($buffer, 0, 1); try { while ($true) { [Native.Power]::SetThreadExecutionState($flags) | Out-Null; if ($readTask.Wait(30000)) { break } } } finally { [Native.Power]::SetThreadExecutionState($release) | Out-Null }`;
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
		ctx.ui.setStatus(STATUS_KEY, `${getIcon()} awake`);
		return;
	}

	if (!state.available) {
		ctx.ui.setStatus(STATUS_KEY, `${getIcon()} unavailable`);
		return;
	}

	ctx.ui.setStatus(STATUS_KEY, undefined);
}

function describeState() {
	if (state.disabled) return "pi-caffeinate is disabled by PI_CAFFEINATE_DISABLED.";
	if (state.process) {
		const seconds = state.startedAt ? Math.round((Date.now() - state.startedAt) / 1000) : 0;
		return `pi-caffeinate is active using ${state.command?.description ?? "an inhibitor"} for ${seconds}s.`;
	}
	if (!state.available)
		return `pi-caffeinate is unavailable: ${state.lastError ?? "unknown reason"}`;
	return "pi-caffeinate is idle and will keep the computer awake during the next agent run.";
}

function formatExit(code: number | null, signal: NodeJS.Signals | null) {
	if (signal) return `signal ${signal}`;
	return `code ${code ?? "unknown"}`;
}

function isDisabled() {
	const value = process.env.PI_CAFFEINATE_DISABLED?.trim().toLowerCase();
	return value ? DISABLED_VALUES.has(value) : false;
}

function getIcon() {
	return process.env.PI_CAFFEINATE_ICON?.trim() ?? "💊";
}
