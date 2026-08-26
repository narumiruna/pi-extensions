import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { shutdownManagedBrowser } from "./browser-manager.js";
import {
	availableChromeDevtoolsTools,
	configureChromeDevtoolsToolExposure,
	createChromeDevtoolsLoadTool,
	initializeAvailableChromeDevtoolsTools,
	requireEagerChromeDevtoolsToolExposure,
	supportsNativeDeferredToolLoading,
} from "./lazy-tools.js";
import { applyRuntimeBrowserSettings, state } from "./runtime.js";
import { loadSettings, waitForSettingsWrites } from "./settings.js";
import {
	allChromeDevtoolsTools,
	buildCommandGuide,
	buildQuickstartMessage,
	buildToolStatusMessage,
	sanitizeChromeDevtoolsDisplay,
	updateChromeDevtoolsTools,
	waitForChromeDevtoolsSettings,
} from "./tool-selector.js";
import {
	evaluateTool,
	listPagesTool,
	navigateTool,
	screenshotTool,
	selectPageTool,
} from "./tools.js";

type CommandAction =
	| "menu"
	| "help"
	| "quickstart"
	| "status"
	| "settings"
	| "tools"
	| "enable"
	| "disable";
type CommandContext = ExtensionCommandContext;
const STATUS_KEY = "chrome-devtools";
const COMMAND_COMPLETIONS = [
	{ value: "help", label: "help", description: "Show command usage" },
	{ value: "quickstart", label: "quickstart", description: "Show endpoint and launch help" },
	{ value: "status", label: "status", description: "Show tool and settings status" },
	{ value: "settings", label: "settings", description: "Edit browser connection settings" },
	{ value: "tools", label: "tools", description: "Choose available Chrome DevTools tools" },
	{ value: "toggle", label: "toggle", description: "Alias for tools" },
	{ value: "select", label: "select", description: "Compatibility alias for tools" },
	{ value: "enable", label: "enable", description: "Make all Chrome DevTools tools available" },
	{ value: "on", label: "on", description: "Compatibility alias for enable" },
	{ value: "disable", label: "disable", description: "Make all Chrome DevTools tools unavailable" },
	{ value: "off", label: "off", description: "Compatibility alias for disable" },
];
export default function chromeDevtools(pi: ExtensionAPI) {
	pi.registerTool(listPagesTool);
	pi.registerTool(selectPageTool);
	pi.registerTool(navigateTool);
	pi.registerTool(evaluateTool);
	pi.registerTool(screenshotTool);
	pi.registerTool(createChromeDevtoolsLoadTool(pi));

	pi.registerCommand("chrome-devtools", {
		description: "Open Chrome DevTools help and tool controls",
		getArgumentCompletions: (prefix) => commandCompletions(prefix),
		handler: async (args, ctx) => {
			initializeAvailableChromeDevtoolsTools(pi);
			const generation = state.sessionGeneration;
			await handleChromeDevtoolsCommand(pi, args, ctx, generation);
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		const generation = ++state.sessionGeneration;
		initializeAvailableChromeDevtoolsTools(pi);
		replaceSessionController("Chrome DevTools session replaced");
		state.shuttingDown = false;
		state.settingsNotice = undefined;
		ctx.ui.setStatus(STATUS_KEY, undefined);
		await shutdownManagedBrowser();
		if (generation !== state.sessionGeneration) return;
		state.activePageId = undefined;
		state.lastLaunchAttempt = undefined;
		const projectTrusted = ctx.isProjectTrusted();
		const settings = await loadSettings({ cwd: ctx.cwd, projectTrusted });
		if (generation !== state.sessionGeneration) return;
		applyRuntimeBrowserSettings(settings.effectiveBrowser, settings.paths, projectTrusted);
		state.settingsNotice = settings.notice;
		for (const warning of settings.warnings) {
			ctx.ui.notify(sanitizeChromeDevtoolsDisplay(warning), "warning");
		}
		const availableTools =
			settings.kind === "loaded" && settings.settings.tools
				? settings.settings.tools
				: availableChromeDevtoolsTools(pi);
		configureChromeDevtoolsToolExposure(pi, availableTools, ctx.model);
	});

	pi.on("model_select", (event) => {
		if (!supportsNativeDeferredToolLoading(event.model)) {
			requireEagerChromeDevtoolsToolExposure(pi);
		}
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		state.sessionGeneration += 1;
		replaceSessionController("Chrome DevTools session shut down");
		ctx.ui.setStatus(STATUS_KEY, undefined);
		const browserShutdown = shutdownManagedBrowser(undefined, { cancelLaunch: true });
		await waitForChromeDevtoolsSettings();
		await waitForSettingsWrites();
		await browserShutdown;
	});
}

async function handleChromeDevtoolsCommand(
	pi: ExtensionAPI,
	args: string,
	ctx: CommandContext,
	generation: number,
) {
	const command = parseCommand(args);
	switch (command) {
		case "menu":
			await showMenu(pi, ctx, generation);
			return;
		case "help":
			requireObservableUi(ctx, "help");
			ctx.ui.notify(buildCommandGuide(), "info");
			return;
		case "quickstart":
			requireObservableUi(ctx, "quickstart");
			ctx.ui.notify(buildQuickstartMessage(), "info");
			return;
		case "status": {
			requireObservableUi(ctx, "status");
			const status = await buildToolStatusMessage(pi);
			if (generation !== state.sessionGeneration) return;
			ctx.ui.notify(status, "info");
			return;
		}
		case "settings": {
			if (!ctx.hasUI || (ctx.mode !== "tui" && ctx.mode !== "rpc")) {
				throw new Error("/chrome-devtools settings requires TUI or RPC mode");
			}
			const { showChromeDevtoolsBrowserSettings } = await import("./browser-settings-menu.js");
			if (generation !== state.sessionGeneration) return;
			await showChromeDevtoolsBrowserSettings(ctx, generation);
			return;
		}
		case "tools": {
			if (!ctx.hasUI || (ctx.mode !== "tui" && ctx.mode !== "rpc")) {
				throw new Error("/chrome-devtools tools requires TUI or RPC mode");
			}
			const { showChromeDevtoolsToolWorkflow } = await import("./menu.js");
			if (generation !== state.sessionGeneration) return;
			await showChromeDevtoolsToolWorkflow(pi, ctx, generation);
			return;
		}
		case "enable":
			await updateChromeDevtoolsTools(pi, ctx, allChromeDevtoolsTools(), "made all available");
			return;
		case "disable":
			await updateChromeDevtoolsTools(pi, ctx, [], "made all unavailable");
			return;
	}

	if (!ctx.hasUI || (ctx.mode !== "tui" && ctx.mode !== "rpc")) {
		throw new Error(`Unknown /chrome-devtools command: ${args.trim()}`);
	}
	ctx.ui.notify(
		`Unknown /chrome-devtools command: ${args.trim()}

${buildCommandGuide()}`,
		"warning",
	);
}

function requireObservableUi(ctx: CommandContext, route: string) {
	if (!ctx.hasUI || (ctx.mode !== "tui" && ctx.mode !== "rpc")) {
		throw new Error(`/chrome-devtools ${route} requires TUI or RPC mode`);
	}
}

async function showMenu(pi: ExtensionAPI, ctx: CommandContext, generation: number) {
	if (!ctx.hasUI || (ctx.mode !== "tui" && ctx.mode !== "rpc")) {
		throw new Error("/chrome-devtools menu requires TUI or RPC mode; use a direct subcommand");
	}
	const { showChromeDevtoolsMenu } = await import("./menu.js");
	if (generation !== state.sessionGeneration) return;
	await showChromeDevtoolsMenu(pi, ctx, generation);
}

function replaceSessionController(reason: string) {
	state.sessionController.abort(new DOMException(reason, "AbortError"));
	state.sessionController = new AbortController();
}

export function parseCommand(args: string): CommandAction | "unknown" {
	const command = args.trim().toLowerCase();
	if (!command) return "menu";
	if (command === "help") return "help";
	if (command === "quickstart") return "quickstart";
	if (command === "status") return "status";
	if (command === "settings") return "settings";
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
export { CHROME_DEVTOOLS_LOAD_TOOL_NAME } from "./lazy-tools.js";
export { parseConfiguredPort } from "./runtime.js";
export {
	hasParentPathSegment,
	isPathInsideRoot,
	resolveScreenshotPath,
	selectAllowedRoot,
} from "./screenshot.js";
export { normalizeChromeDevtoolsSettings } from "./settings.js";
export {
	orderedChromeDevtoolsTools,
	sanitizeChromeDevtoolsDisplay,
} from "./tool-selector.js";
