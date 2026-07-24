import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import {
	DEFAULT_STATUSLINE_DOCUMENT,
	type LoadedStatuslineSettings,
	saveStatuslineSettingsDocument,
} from "./settings.js";

const SUBCOMMANDS: AutocompleteItem[] = [
	{ value: "settings", label: "settings", description: "Edit pi-statusline.json" },
	{ value: "status", label: "status", description: "Show effective statusline settings" },
	{ value: "help", label: "help", description: "Show configuration help" },
];

export interface StatuslineCommandOptions {
	settingsPath: string;
	getLoaded(): LoadedStatuslineSettings;
	apply(loaded: LoadedStatuslineSettings, ctx: ExtensionCommandContext): void;
	save?: (settingsPath: string, rawDocument: string) => LoadedStatuslineSettings;
}

export function registerStatuslineCommand(pi: ExtensionAPI, options: StatuslineCommandOptions) {
	pi.registerCommand("statusline", {
		description: "Edit or inspect the Tokyo Night footer settings",
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
						ctx.ui.notify(`Unknown /statusline subcommand: ${subcommand}`, "warning");
					}
			}
		},
	});
}

async function editSettings(ctx: ExtensionCommandContext, options: StatuslineCommandOptions) {
	if (ctx.mode !== "tui") {
		if (ctx.hasUI) ctx.ui.notify(`Edit settings manually: ${options.settingsPath}`, "info");
		return;
	}
	const current = options.getLoaded();
	const edited = await ctx.ui.editor(
		"pi-statusline.json — save and close to apply",
		current.rawDocument ?? DEFAULT_STATUSLINE_DOCUMENT,
	);
	if (edited === undefined) return;
	try {
		const loaded = (options.save ?? saveStatuslineSettingsDocument)(options.settingsPath, edited);
		options.apply(loaded, ctx);
		const suffix =
			loaded.diagnostics.length > 0
				? ` (${loaded.diagnostics.length} warning${loaded.diagnostics.length === 1 ? "" : "s"})`
				: "";
		ctx.ui.notify(`pi-statusline settings saved and applied${suffix}.`, "info");
	} catch (error) {
		ctx.ui.notify(`pi-statusline settings were not saved: ${formatError(error)}`, "error");
	}
}

function showStatus(ctx: ExtensionCommandContext, options: StatuslineCommandOptions) {
	if (!canNotify(ctx)) return;
	const loaded = options.getLoaded();
	const palette = typeof loaded.config.palette === "string" ? loaded.config.palette : "configured";
	const diagnostics = loaded.diagnostics
		.slice(0, 5)
		.map((item) => `${item.path || "root"}: ${item.message}`)
		.join("; ");
	ctx.ui.notify(
		[
			`pi-statusline source: ${loaded.source}`,
			`path: ${options.settingsPath}`,
			`palette: ${palette}`,
			`density: ${loaded.config.density}`,
			`separator: ${loaded.config.separator}`,
			`segments: ${loaded.config.segments.join(", ") || "none"}`,
			diagnostics ? `warnings: ${diagnostics}` : "warnings: none",
		].join("\n"),
		loaded.diagnostics.length > 0 ? "warning" : "info",
	);
}

function showHelp(ctx: ExtensionCommandContext, settingsPath: string) {
	if (!canNotify(ctx)) return;
	ctx.ui.notify(
		[
			"/statusline settings — edit and apply JSON",
			"/statusline status — show source, path, and warnings",
			"/statusline help — show this help",
			`Settings: ${settingsPath}`,
			"Fields: palette, density, separator, segments, segmentText, extensionStatusIcons",
			"palette maps segment names to fg/bg full #RRGGBB colors.",
			"Use line_break between segments for another footer row; repeats must not be consecutive.",
			"The segmentText entries support prefix and suffix strings around Pi-owned dynamic values.",
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
