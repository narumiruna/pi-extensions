import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { shutdownManagedBrowser } from "./browser-manager.js";
import { loadSettings } from "./settings.js";
import { state } from "./runtime.js";
import {
	allChromeDevtoolsTools,
	applyChromeDevtoolsTools,
	buildCommandGuide,
	buildQuickstartMessage,
	buildToolStatusMessage,
	setSelectedChromeDevtoolsTools,
	showToolSelector,
	updateChromeDevtoolsTools,
} from "./tool-selector.js";
import {
	evaluateTool,
	listPagesTool,
	navigateTool,
	screenshotTool,
	selectPageTool,
} from "./tools.js";

type CommandAction = "menu" | "help" | "quickstart" | "status" | "tools" | "enable" | "disable";
type CommandContext = ExtensionCommandContext;
const STATUS_KEY = "chrome-devtools";
const COMMAND_COMPLETIONS = [
	{ value: "help", label: "help", description: "Show command usage" },
	{ value: "quickstart", label: "quickstart", description: "Show endpoint and launch help" },
	{ value: "status", label: "status", description: "Show tool and settings status" },
	{ value: "tools", label: "tools", description: "Select Chrome DevTools tools" },
	{ value: "toggle", label: "toggle", description: "Select Chrome DevTools tools" },
	{ value: "enable", label: "enable", description: "Enable all Chrome DevTools tools" },
	{ value: "disable", label: "disable", description: "Disable all Chrome DevTools tools" },
];
const MENU_OPTIONS = {
	quickstart: "Quick start / endpoint help",
	help: "Command usage guide",
	status: "Show tool status",
	tools: "Select Chrome DevTools tools",
	enable: "Enable all Chrome DevTools tools",
	disable: "Disable all Chrome DevTools tools",
} as const;

export default function chromeDevtools(pi: ExtensionAPI) {
	pi.registerTool(listPagesTool);
	pi.registerTool(selectPageTool);
	pi.registerTool(navigateTool);
	pi.registerTool(evaluateTool);
	pi.registerTool(screenshotTool);

	pi.registerCommand("chrome-devtools", {
		description: "Open Chrome DevTools help and tool controls",
		getArgumentCompletions: (prefix) => commandCompletions(prefix),
		handler: async (args, ctx) => {
			await handleChromeDevtoolsCommand(pi, args, ctx);
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		state.shuttingDown = false;
		state.settingsNotice = undefined;
		ctx.ui.setStatus(STATUS_KEY, undefined);
		const settings = await loadSettings();
		state.settingsNotice = settings.notice;
		if (settings.notice) ctx.ui.notify(settings.notice, "warning");
		if (settings.kind === "loaded") {
			applyChromeDevtoolsTools(pi, settings.settings.tools);
			return;
		}
		if (settings.kind === "invalid") {
			ctx.ui.notify(`Chrome DevTools settings ignored: ${settings.reason}`, "warning");
		}
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		ctx.ui.setStatus(STATUS_KEY, undefined);
		await shutdownManagedBrowser(undefined, { cancelLaunch: true });
	});
}

async function handleChromeDevtoolsCommand(pi: ExtensionAPI, args: string, ctx: CommandContext) {
	const command = parseCommand(args);
	switch (command) {
		case "menu":
			await showMenu(pi, ctx);
			return;
		case "help":
			ctx.ui.notify(buildCommandGuide(), "info");
			return;
		case "quickstart":
			ctx.ui.notify(buildQuickstartMessage(), "info");
			return;
		case "status":
			ctx.ui.notify(await buildToolStatusMessage(pi), "info");
			return;
		case "tools":
			await showToolSelector(pi, ctx);
			return;
		case "enable":
			await updateChromeDevtoolsTools(pi, ctx, allChromeDevtoolsTools(), "enabled all");
			return;
		case "disable":
			await updateChromeDevtoolsTools(pi, ctx, [], "disabled all");
			return;
	}

	ctx.ui.notify(`Unknown /chrome-devtools command: ${args.trim()}

${buildCommandGuide()}`, "warning");
}

async function showMenu(pi: ExtensionAPI, ctx: CommandContext) {
	if (!ctx.hasUI) {
		ctx.ui.notify(`${buildCommandGuide()}

${await buildToolStatusMessage(pi)}`, "info");
		return;
	}

	const choice = await ctx.ui.select("Chrome DevTools", Object.values(MENU_OPTIONS));
	switch (choice) {
		case MENU_OPTIONS.quickstart:
			ctx.ui.notify(buildQuickstartMessage(), "info");
			return;
		case MENU_OPTIONS.help:
			ctx.ui.notify(buildCommandGuide(), "info");
			return;
		case MENU_OPTIONS.status:
			ctx.ui.notify(await buildToolStatusMessage(pi), "info");
			return;
		case MENU_OPTIONS.tools:
			await showToolSelector(pi, ctx);
			return;
		case MENU_OPTIONS.enable:
			await updateChromeDevtoolsTools(pi, ctx, allChromeDevtoolsTools(), "enabled all");
			return;
		case MENU_OPTIONS.disable:
			await updateChromeDevtoolsTools(pi, ctx, [], "disabled all");
			return;
	}
}

export function parseCommand(args: string): CommandAction | "unknown" {
	const command = args.trim().toLowerCase();
	if (!command) return "menu";
	if (command === "help") return "help";
	if (command === "quickstart") return "quickstart";
	if (command === "status") return "status";
	if (command === "tools" || command === "select" || command === "toggle") return "tools";
	if (command === "enable" || command === "on") return "enable";
	if (command === "disable" || command === "off") return "disable";
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

export {
	formatHostForUrl,
	isLocalDevToolsHost,
	quoteCommandPart,
} from "./browser-manager.js";
export { parseConfiguredPort } from "./runtime.js";
export {
	hasParentPathSegment,
	isPathInsideRoot,
	resolveScreenshotPath,
	selectAllowedRoot,
} from "./screenshot.js";
export { installSettingsFileExclusively, normalizeChromeDevtoolsSettings } from "./settings.js";
export { orderedChromeDevtoolsTools } from "./tool-selector.js";
