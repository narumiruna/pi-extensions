import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { type LoadedTelegraphConfig, loadTelegraphConfig, saveTelegraphSetup } from "./config.js";
import { cleanupTemporaryOutputs } from "./outputs.js";
import { createPageTool, editPageTool, getPageTool } from "./tools.js";

const STATUS_KEY = "telegraph";
const COMMAND_COMPLETIONS = [
	{ value: "status", label: "status", description: "Show redacted Telegraph config status" },
	{ value: "init", label: "init", description: "Set non-secret Telegraph account defaults" },
	{ value: "help", label: "help", description: "Show Telegraph usage and safety guidance" },
];

type CommandAction = "status" | "init" | "help" | "unknown";

export default function telegraph(pi: ExtensionAPI) {
	pi.registerTool(createPageTool);
	pi.registerTool(getPageTool);
	pi.registerTool(editPageTool);

	pi.registerCommand("telegraph", {
		description: "Configure and inspect Telegraph publishing tools",
		getArgumentCompletions: commandCompletions,
		handler: async (args, ctx) => {
			await handleCommand(args, ctx);
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		ctx.ui.setStatus(STATUS_KEY, undefined);
		try {
			await loadTelegraphConfig();
		} catch (error) {
			ctx.ui.notify(`Telegraph config ignored: ${formatError(error)}`, "warning");
		}
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		ctx.ui.setStatus(STATUS_KEY, undefined);
		await cleanupTemporaryOutputs();
	});
}

export function parseCommand(rawArgs: string): CommandAction {
	const command = rawArgs.trim().toLowerCase();
	if (!command || command === "status" || command === "config") return "status";
	if (command === "init" || command === "setup") return "init";
	if (command === "help") return "help";
	return "unknown";
}

export function commandCompletions(prefix: string) {
	const normalized = prefix.trimStart().toLowerCase();
	if (/\s/.test(normalized)) return null;
	const matches = COMMAND_COMPLETIONS.filter((item) => item.value.startsWith(normalized));
	return matches.length > 0 ? matches : null;
}

export function buildStatusMessage(loaded: LoadedTelegraphConfig) {
	return [
		"Telegraph config:",
		`path: ${loaded.path}`,
		`config file: ${loaded.exists ? "present" : "not created"}`,
		`account token: ${loaded.config.accessToken ? "configured" : "not configured (created lazily on first confirmed publish)"}`,
		`short name: ${loaded.config.shortName}`,
		`default author: ${loaded.config.authorName ?? "not set"}`,
		`default author URL: ${loaded.config.authorUrl ?? "not set"}`,
	].join("\n");
}

async function handleCommand(rawArgs: string, ctx: ExtensionCommandContext) {
	switch (parseCommand(rawArgs)) {
		case "status":
			await showStatus(ctx);
			return;
		case "init":
			await initializeConfig(ctx);
			return;
		case "help":
			ctx.ui.notify(helpText(), "info");
			return;
		case "unknown":
			ctx.ui.notify(helpText(), "warning");
			return;
	}
}

async function showStatus(ctx: ExtensionCommandContext) {
	try {
		ctx.ui.notify(buildStatusMessage(await loadTelegraphConfig()), "info");
	} catch (error) {
		ctx.ui.notify(`Unable to load Telegraph config: ${formatError(error)}`, "warning");
	}
}

async function initializeConfig(ctx: ExtensionCommandContext) {
	if (!ctx.hasUI) {
		ctx.ui.notify(
			"/telegraph init requires interactive UI. Create pi-telegraph.json manually using /telegraph help guidance.",
			"warning",
		);
		return;
	}
	let loaded: LoadedTelegraphConfig;
	try {
		loaded = await loadTelegraphConfig();
	} catch (error) {
		ctx.ui.notify(`Unable to load Telegraph config: ${formatError(error)}`, "error");
		return;
	}
	const shortName = await ctx.ui.input("Telegraph account short name:", loaded.config.shortName);
	if (shortName === undefined) return notifyCancelled(ctx);
	const authorName = await ctx.ui.input(
		"Default author name (blank for none):",
		loaded.config.authorName ?? "",
	);
	if (authorName === undefined) return notifyCancelled(ctx);
	const authorUrl = await ctx.ui.input(
		"Default author URL (blank for none):",
		loaded.config.authorUrl ?? "",
	);
	if (authorUrl === undefined) return notifyCancelled(ctx);

	try {
		await saveTelegraphSetup({ shortName, authorName, authorUrl });
		const saved = await loadTelegraphConfig();
		ctx.ui.notify(
			`Saved non-secret Telegraph defaults to ${saved.path}. Account token: ${saved.config.accessToken ? "preserved" : "will be created on first confirmed publish"}.`,
			"info",
		);
	} catch (error) {
		ctx.ui.notify(`Unable to save Telegraph config: ${formatError(error)}`, "error");
	}
}

function notifyCancelled(ctx: ExtensionCommandContext) {
	ctx.ui.notify("Telegraph setup cancelled.", "info");
}

function helpText() {
	return [
		"Telegraph commands:",
		"/telegraph status - show redacted config status",
		"/telegraph init - set shortName and optional author defaults without prompting for secrets",
		"/telegraph help - show this guide",
		"",
		"Tools: telegraph_create_page, telegraph_get_page, telegraph_edit_page.",
		"Create/edit publish public content and require confirmation. Telegraph has no delete API.",
		"An account is created lazily on the first confirmed publish. To import an existing account, add its literal accessToken to the private pi-telegraph.json file; no Telegraph-specific environment variables are used.",
	].join("\n");
}

function formatError(error: unknown) {
	return error instanceof Error ? error.message : String(error);
}

export { normalizeTelegraphPath } from "./tools.js";
