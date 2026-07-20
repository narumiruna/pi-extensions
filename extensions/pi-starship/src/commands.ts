import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import { atomicSaveConfigDocument, BUILT_IN_EXAMPLE, type LoadedStarshipConfig } from "./config.js";

const SUBCOMMANDS: AutocompleteItem[] = [
	{ value: "settings", label: "settings", description: "Edit pi-starship.toml" },
	{ value: "status", label: "status", description: "Show the effective settings source" },
	{ value: "help", label: "help", description: "Show configuration help" },
];

export interface StarshipCommandOptions {
	getLoaded(): LoadedStarshipConfig;
	apply(loaded: LoadedStarshipConfig, ctx: ExtensionCommandContext): void;
	settingsPath: string;
	save?: (settingsPath: string, rawDocument: string) => LoadedStarshipConfig;
}

export function registerStarshipCommand(pi: ExtensionAPI, options: StarshipCommandOptions) {
	pi.registerCommand("starship", {
		description: "Edit or inspect the native Starship-style footer settings",
		getArgumentCompletions(prefix: string): AutocompleteItem[] | null {
			const normalized = prefix.trim().toLowerCase();
			const matches = SUBCOMMANDS.filter((item) => item.value.startsWith(normalized));
			return matches.length > 0 ? matches : null;
		},
		handler: async (args, ctx) => {
			const subcommand = args.trim().split(/\s+/u)[0]?.toLowerCase() || "help";
			switch (subcommand) {
				case "settings":
					await editSettings(ctx, options);
					return;
				case "status":
					showStatus(ctx, options);
					return;
				case "help":
					showHelp(ctx, options.settingsPath);
					return;
				default:
					if (canNotify(ctx)) {
						ctx.ui.notify(`Unknown /starship subcommand: ${subcommand}`, "warning");
					}
			}
		},
	});
}

async function editSettings(ctx: ExtensionCommandContext, options: StarshipCommandOptions) {
	if (ctx.mode !== "tui") {
		if (ctx.hasUI) ctx.ui.notify(`Edit settings manually: ${options.settingsPath}`, "info");
		return;
	}
	const current = options.getLoaded();
	const edited = await ctx.ui.editor(
		"pi-starship.toml — save and close to apply",
		current.rawDocument ?? BUILT_IN_EXAMPLE,
	);
	if (edited === undefined) return;
	try {
		const loaded = (options.save ?? atomicSaveConfigDocument)(options.settingsPath, edited);
		options.apply(loaded, ctx);
		const warningSuffix =
			loaded.diagnostics.length > 0
				? ` (${loaded.diagnostics.length} warning${loaded.diagnostics.length === 1 ? "" : "s"})`
				: "";
		ctx.ui.notify(`pi-starship settings saved and applied${warningSuffix}.`, "info");
	} catch (error) {
		ctx.ui.notify(`pi-starship settings were not saved: ${formatError(error)}`, "error");
	}
}

function showStatus(ctx: ExtensionCommandContext, options: StarshipCommandOptions) {
	if (!canNotify(ctx)) return;
	const loaded = options.getLoaded();
	const diagnostics = loaded.diagnostics
		.slice(0, 5)
		.map((item) => `${item.path || "root"}: ${item.message}`)
		.join("; ");
	ctx.ui.notify(
		[
			`pi-starship source: ${loaded.source}`,
			`path: ${options.settingsPath}`,
			diagnostics ? `warnings: ${diagnostics}` : "warnings: none",
		].join("\n"),
		loaded.diagnostics.length > 0 ? "warning" : "info",
	);
}

function showHelp(ctx: ExtensionCommandContext, settingsPath: string) {
	if (!canNotify(ctx)) return;
	ctx.ui.notify(
		[
			"/starship settings — edit and apply TOML",
			"/starship status — show source, path, and warnings",
			"/starship help — show this help",
			`Settings: ${settingsPath}`,
			"Format/module docs: https://github.com/narumiruna/pi-extensions/tree/main/extensions/pi-starship",
		].join("\n"),
		"info",
	);
}

function canNotify(ctx: ExtensionCommandContext): boolean {
	return ctx.mode === "tui" || ctx.hasUI;
}

function formatError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
