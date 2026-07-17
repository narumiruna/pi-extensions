import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
	DEFAULT_API_URL,
	DEFAULT_MODEL,
	DEFAULT_TIMEOUT_MS,
	GOOGLE_GENAI_TOOL_NAMES,
	type GoogleGenaiConfig,
	type GoogleGenaiToolName,
	googleGenaiConfigPath,
	isGoogleGenaiToolName,
	isUnsupportedConfigApiKey,
	type LoadedGoogleGenaiConfig,
	loadGoogleGenaiConfig,
	saveToolSelection,
	writeGoogleGenaiConfig,
} from "./config.js";
import { cleanupRawResponseDirectory } from "./response-format.js";
import { googleMapsTool, googleSearchTool, googleUrlContextTool } from "./tools.js";

const STATUS_KEY = "google-genai";
const COMMAND_COMPLETIONS = [
	{ value: "init", label: "init", description: "Create or update Google GenAI config" },
	{ value: "status", label: "status", description: "Show Google GenAI config status" },
	{ value: "config", label: "config", description: "Show Google GenAI config status" },
	{ value: "help", label: "help", description: "Show Google GenAI command usage" },
	{ value: "tools", label: "tools", description: "Select Google GenAI tools" },
	{ value: "enable", label: "enable", description: "Enable all Google GenAI tools" },
	{ value: "disable", label: "disable", description: "Disable all Google GenAI tools" },
];
type CommandAction = "status" | "init" | "help" | "tools" | "enable" | "disable" | "unknown";
type ToolSelectorAction = "enableAll" | "disableAll" | "done";
type ToolSelectorRow =
	| { kind: "tool"; toolName: GoogleGenaiToolName }
	| { kind: "action"; action: ToolSelectorAction; label: string };

export default function googleGenai(pi: ExtensionAPI) {
	pi.registerTool(googleSearchTool);
	pi.registerTool(googleMapsTool);
	pi.registerTool(googleUrlContextTool);

	pi.registerCommand("google-genai", {
		description: "Configure Google GenAI grounding tools",
		getArgumentCompletions: commandCompletions,
		handler: async (args, ctx) => {
			await handleCommand(args, ctx, pi);
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		ctx.ui.setStatus(STATUS_KEY, undefined);
		const loaded = await loadGoogleGenaiConfig();
		if (loaded.configLoaded) applyGoogleToolSelection(pi, loaded.config.tools);
		if (loaded.warnings.length > 0) ctx.ui.notify(loaded.warnings.join("\n"), "warning");
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		ctx.ui.setStatus(STATUS_KEY, undefined);
		await cleanupRawResponseDirectory();
	});
}

export function parseCommand(rawArgs: string): CommandAction {
	const [command = ""] = splitArgs(rawArgs);
	switch (command) {
		case "":
		case "status":
		case "config":
			return "status";
		case "init":
			return "init";
		case "help":
			return "help";
		case "tools":
		case "toggle":
		case "select":
			return "tools";
		case "enable":
		case "on":
			return "enable";
		case "disable":
		case "off":
			return "disable";
		default:
			return "unknown";
	}
}

export function commandCompletions(prefix: string) {
	if (/\s/.test(prefix.trimStart())) return null;
	const token = prefix.trimStart();
	const matches = COMMAND_COMPLETIONS.filter((item) => item.value.startsWith(token));
	return matches.length > 0 ? matches : null;
}

export function buildStatusMessage(loaded: LoadedGoogleGenaiConfig, authSource: string) {
	const { config, path, warnings } = loaded;
	return [
		"Google GenAI config:",
		`path: ${path}`,
		`model: ${config.model}`,
		`apiUrl: ${config.apiUrl}`,
		`timeoutMs: ${config.timeoutMs}`,
		`auth: ${authSource}`,
		`configLoaded: ${loaded.configLoaded ? "yes" : "no"}`,
		`persisted tools: ${loaded.configLoaded ? formatPersistedTools(config.tools) : "none"}`,
		...(warnings.length > 0 ? ["warnings:", ...warnings.map((warning) => `- ${warning}`)] : []),
	].join("\n");
}

async function handleCommand(rawArgs: string, ctx: ExtensionCommandContext, pi: ExtensionAPI) {
	const action = parseCommand(rawArgs);
	switch (action) {
		case "status":
			await showStatus(ctx);
			return;
		case "init":
			await initConfig(ctx, pi);
			return;
		case "help":
			ctx.ui.notify(helpText(), "info");
			return;
		case "tools":
			await selectTools(ctx, pi);
			return;
		case "enable":
			await saveToolSelection([...GOOGLE_GENAI_TOOL_NAMES]);
			applyGoogleToolSelection(pi, [...GOOGLE_GENAI_TOOL_NAMES]);
			ctx.ui.notify("Enabled all Google GenAI tools.", "info");
			return;
		case "disable":
			await saveToolSelection([]);
			applyGoogleToolSelection(pi, []);
			ctx.ui.notify(
				"Disabled all Google GenAI tools. Use /google-genai enable to restore them.",
				"info",
			);
			return;
		case "unknown":
			ctx.ui.notify(helpText(), "warning");
			return;
	}
}

async function initConfig(ctx: ExtensionCommandContext, pi: ExtensionAPI) {
	if (!ctx.hasUI) {
		ctx.ui.notify(
			"/google-genai init requires interactive UI. Edit pi-google-genai.json manually or use /login google.",
			"warning",
		);
		return;
	}
	const loaded = await loadGoogleGenaiConfig();
	const apiKey = await ctx.ui.input(
		"Google GenAI API key (leave blank to keep existing/use /login google/GEMINI_API_KEY):",
	);
	if (apiKey === undefined) {
		ctx.ui.notify("Cancelled", "info");
		return;
	}
	const model = await ctx.ui.input("Google GenAI model:", loaded.config.model);
	if (model === undefined) {
		ctx.ui.notify("Cancelled", "info");
		return;
	}

	const next: GoogleGenaiConfig = {
		...loaded.config,
		apiKey: apiKey.trim() || loaded.config.apiKey,
		model: model.trim() || loaded.config.model || DEFAULT_MODEL,
		apiUrl: loaded.config.apiUrl || DEFAULT_API_URL,
		timeoutMs: loaded.config.timeoutMs || DEFAULT_TIMEOUT_MS,
		tools: loaded.config.tools ?? [...GOOGLE_GENAI_TOOL_NAMES],
	};
	await writeGoogleGenaiConfig(next);
	applyGoogleToolSelection(pi, next.tools);
	ctx.ui.notify(`Saved Google GenAI config to ${googleGenaiConfigPath()}.`, "info");
}

async function showStatus(ctx: ExtensionCommandContext) {
	const loaded = await loadGoogleGenaiConfig();
	ctx.ui.notify(buildStatusMessage(loaded, await authSource(loaded.config, ctx)), "info");
}

async function selectTools(ctx: ExtensionCommandContext, pi: ExtensionAPI) {
	if (!ctx.hasUI) {
		ctx.ui.notify("/google-genai tools requires interactive UI.", "warning");
		return;
	}

	let selectedTools = new Set(currentGoogleTools(pi));
	let persistQueue = Promise.resolve();
	const commitSelectedTools = () => {
		const nextTools = orderedGoogleTools(selectedTools);
		applyGoogleToolSelection(pi, nextTools);
		persistQueue = persistQueue
			.then(() => saveToolSelection(nextTools))
			.catch((error) => {
				const message = error instanceof Error ? error.message : String(error);
				ctx.ui.notify(`Google GenAI tool selection save failed: ${message}`, "warning");
			});
	};
	const customResult = await ctx.ui.custom<"closed" | undefined>(
		(tui, theme, keybindings, done) => {
			const rows = googleToolSelectorRows();
			let selectedIndex = 0;
			const moveSelection = (delta: number) => {
				selectedIndex = (selectedIndex + delta + rows.length) % rows.length;
			};
			const activateSelectedRow = () => {
				const row = rows[selectedIndex];
				if (!row) return;
				if (row.kind === "tool") {
					if (selectedTools.has(row.toolName)) selectedTools.delete(row.toolName);
					else selectedTools.add(row.toolName);
					commitSelectedTools();
					return;
				}
				if (row.action === "enableAll") {
					selectedTools = new Set(GOOGLE_GENAI_TOOL_NAMES);
					commitSelectedTools();
					return;
				}
				if (row.action === "disableAll") {
					selectedTools = new Set();
					commitSelectedTools();
					return;
				}
				done("closed");
			};

			return {
				invalidate() {},
				render(width: number) {
					return [
						theme.fg("accent", theme.bold(clipLine(googleToolSelectorTitle(selectedTools), width))),
						"",
						...rows.map((row, index) => {
							const prefix = index === selectedIndex ? "› " : "  ";
							const line = clipLine(
								`${prefix}${formatGoogleToolSelectorRow(row, selectedTools)}`,
								width,
							);
							return index === selectedIndex ? theme.fg("accent", line) : line;
						}),
						"",
						theme.fg("dim", clipLine("↑↓ navigate • Enter/Space toggle • Esc close", width)),
					];
				},
				handleInput(data: string) {
					if (keybindings.matches(data, "tui.select.up")) {
						moveSelection(-1);
						tui.requestRender();
						return;
					}
					if (keybindings.matches(data, "tui.select.down")) {
						moveSelection(1);
						tui.requestRender();
						return;
					}
					if (keybindings.matches(data, "tui.select.pageUp")) {
						selectedIndex = 0;
						tui.requestRender();
						return;
					}
					if (keybindings.matches(data, "tui.select.pageDown")) {
						selectedIndex = rows.length - 1;
						tui.requestRender();
						return;
					}
					if (keybindings.matches(data, "tui.select.confirm") || data === " ") {
						activateSelectedRow();
						tui.requestRender();
						return;
					}
					if (keybindings.matches(data, "tui.select.cancel")) done("closed");
				},
			};
		},
	);

	if (customResult !== "closed") {
		await showDialogToolSelector(ctx, pi);
		return;
	}
	await persistQueue;
}

async function showDialogToolSelector(ctx: ExtensionCommandContext, pi: ExtensionAPI) {
	let selectedTools = new Set(currentGoogleTools(pi));
	while (true) {
		const rows = googleToolSelectorRows();
		const choices = rows.map((row) => formatGoogleToolSelectorRow(row, selectedTools));
		const choice = await ctx.ui.select(googleToolSelectorTitle(selectedTools), choices);
		if (!choice) return;
		const row = rows[choices.indexOf(choice)];
		if (!row || (row.kind === "action" && row.action === "done")) return;
		if (row.kind === "tool") {
			if (selectedTools.has(row.toolName)) selectedTools.delete(row.toolName);
			else selectedTools.add(row.toolName);
		} else if (row.action === "enableAll") {
			selectedTools = new Set(GOOGLE_GENAI_TOOL_NAMES);
		} else if (row.action === "disableAll") {
			selectedTools = new Set();
		}
		const ordered = orderedGoogleTools(selectedTools);
		applyGoogleToolSelection(pi, ordered);
		await saveToolSelection(ordered);
	}
}

function googleToolSelectorRows(): ToolSelectorRow[] {
	return [
		...GOOGLE_GENAI_TOOL_NAMES.map((toolName) => ({ kind: "tool" as const, toolName })),
		{
			kind: "action",
			action: "enableAll",
			label: "Enable all Google GenAI tools",
		},
		{
			kind: "action",
			action: "disableAll",
			label: "Disable all Google GenAI tools",
		},
		{ kind: "action", action: "done", label: "Done" },
	];
}

function formatGoogleToolSelectorRow(
	row: ToolSelectorRow,
	selectedTools: ReadonlySet<GoogleGenaiToolName>,
) {
	if (row.kind === "action") return row.label;
	return `${selectedTools.has(row.toolName) ? "[x]" : "[ ]"} ${row.toolName}`;
}

function googleToolSelectorTitle(selectedTools: ReadonlySet<GoogleGenaiToolName>) {
	return `Google GenAI tools (${selectedTools.size}/${GOOGLE_GENAI_TOOL_NAMES.length})`;
}

function clipLine(value: string, width: number) {
	return Array.from(value).slice(0, Math.max(0, width)).join("");
}

function authSource(config: GoogleGenaiConfig, ctx: ExtensionCommandContext) {
	if (config.apiKey) {
		return isUnsupportedConfigApiKey(config.apiKey)
			? "invalid config apiKey (interpolation unsupported)"
			: "config apiKey";
	}
	const status = ctx.modelRegistry.getProviderAuthStatus("google");
	if (status.configured || status.source) {
		return status.label ? `Pi auth/google (${status.label})` : "Pi auth/google";
	}
	return "missing";
}

function applyGoogleToolSelection(pi: ExtensionAPI, selectedTools: readonly GoogleGenaiToolName[]) {
	const active = pi.getActiveTools();
	const nonGoogle = active.filter((toolName) => !isGoogleGenaiToolName(toolName));
	pi.setActiveTools([...nonGoogle, ...selectedTools]);
}

function currentGoogleTools(pi: ExtensionAPI) {
	const active = new Set(pi.getActiveTools());
	return GOOGLE_GENAI_TOOL_NAMES.filter((toolName) => active.has(toolName));
}

function orderedGoogleTools(tools: Set<GoogleGenaiToolName>) {
	return GOOGLE_GENAI_TOOL_NAMES.filter((toolName) => tools.has(toolName));
}

function splitArgs(rawArgs: string) {
	return rawArgs.trim().split(/\s+/).filter(Boolean);
}

function formatPersistedTools(tools: readonly GoogleGenaiToolName[]) {
	if (tools.length === GOOGLE_GENAI_TOOL_NAMES.length) return "all enabled";
	if (tools.length === 0) return "all disabled";
	return `${tools.length}/${GOOGLE_GENAI_TOOL_NAMES.length} selected: ${tools.join(", ")}`;
}

function helpText() {
	return [
		"Google GenAI commands:",
		"/google-genai init - create or update config",
		"/google-genai status|config - show config and auth status",
		"/google-genai tools - select enabled Google GenAI tools",
		"/google-genai enable - enable all Google GenAI tools",
		"/google-genai disable - disable all Google GenAI tools",
		"Auth: config apiKey, /login google, or GEMINI_API_KEY.",
	].join("\n");
}

export type { GoogleGenaiConfig, LoadedGoogleGenaiConfig } from "./config.js";
export {
	DEFAULT_API_URL,
	DEFAULT_MODEL,
	DEFAULT_TIMEOUT_MS,
	GOOGLE_GENAI_TOOL_NAMES,
	googleGenaiConfigPath,
	loadGoogleGenaiConfig,
	MAX_TIMEOUT_MS,
	normalizeGoogleGenaiSettings,
	resolveGoogleGenaiAuth,
} from "./config.js";
export { formatToolResult } from "./response-format.js";
export {
	validateMapsLocation,
	validateSearchTypes,
	validateTimeoutMs,
	validateUrls,
} from "./tools.js";
