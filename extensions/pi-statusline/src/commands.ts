import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import {
	createDefaultConfig,
	DEFAULT_STATUSLINE_DOCUMENT,
	type LoadedStatuslineSettings,
	saveStatuslineSettingsDocument,
} from "./settings.js";
import { PALETTE_PRESET_NAMES, type PalettePreset } from "./types.js";

const SUBCOMMANDS: AutocompleteItem[] = [
	{ value: "palette", label: "palette", description: "Choose a palette preset" },
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
		description: "Configure or inspect the statusline footer",
		getArgumentCompletions(prefix: string): AutocompleteItem[] | null {
			const normalized = prefix.trim().toLowerCase();
			const matches = SUBCOMMANDS.filter((item) => item.value.startsWith(normalized));
			return matches.length > 0 ? matches : null;
		},
		handler: async (args, ctx) => {
			const subcommand = args.trim().split(/\s+/u)[0]?.toLowerCase() ?? "";
			switch (subcommand) {
				case "":
					await showMainMenu(ctx, options);
					return;
				case "palette":
					await choosePalettePreset(ctx, options);
					return;
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

async function showMainMenu(ctx: ExtensionCommandContext, options: StatuslineCommandOptions) {
	if (ctx.mode !== "tui") {
		showHelp(ctx, options.settingsPath);
		return;
	}
	const paletteItem = `Palette preset (${options.getLoaded().config.palettePreset})`;
	const selection = await ctx.ui.select("pi-statusline", [
		paletteItem,
		"Edit JSON settings",
		"Status",
		"Help",
	]);
	if (selection === paletteItem) {
		await choosePalettePreset(ctx, options);
		return;
	}
	switch (selection) {
		case "Edit JSON settings":
			await editSettings(ctx, options);
			return;
		case "Status":
			showStatus(ctx, options);
			return;
		case "Help":
			showHelp(ctx, options.settingsPath);
	}
}

async function choosePalettePreset(
	ctx: ExtensionCommandContext,
	options: StatuslineCommandOptions,
) {
	if (ctx.mode !== "tui") {
		if (ctx.hasUI) ctx.ui.notify(`Edit palettePreset manually: ${options.settingsPath}`, "info");
		return;
	}
	const current = options.getLoaded();
	const selection = await ctx.ui.select(
		`Palette preset (current: ${current.config.palettePreset})`,
		[...PALETTE_PRESET_NAMES],
	);
	if (selection === undefined) return;

	try {
		const rawDocument = palettePresetDocument(current, selection as PalettePreset);
		const loaded = (options.save ?? saveStatuslineSettingsDocument)(
			options.settingsPath,
			rawDocument,
		);
		options.apply(loaded, ctx);
		ctx.ui.notify(`Palette preset applied: ${loaded.config.palettePreset}.`, "info");
	} catch (error) {
		ctx.ui.notify(`Palette preset was not saved: ${formatError(error)}`, "error");
	}
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

function palettePresetDocument(
	current: LoadedStatuslineSettings,
	palettePreset: PalettePreset,
): string {
	if (
		current.source !== "user" ||
		current.rawDocument === undefined ||
		current.diagnostics.some((item) => item.code !== "unknown")
	) {
		throw new Error("Fix pi-statusline.json before choosing a palette preset");
	}
	const parsed = JSON.parse(current.rawDocument) as unknown;
	if (!isRecord(parsed)) throw new Error("Settings must contain a JSON object");
	if (!isRecord(parsed.palette)) parsed.palette = createDefaultConfig().palette;
	parsed.palettePreset = palettePreset;
	return `${JSON.stringify(parsed, null, "\t")}\n`;
}

function showStatus(ctx: ExtensionCommandContext, options: StatuslineCommandOptions) {
	if (!canNotify(ctx)) return;
	const loaded = options.getLoaded();
	const diagnostics = loaded.diagnostics
		.slice(0, 5)
		.map((item) => `${item.path || "root"}: ${item.message}`)
		.join("; ");
	ctx.ui.notify(
		[
			`pi-statusline source: ${loaded.source}`,
			`path: ${options.settingsPath}`,
			`palette preset: ${loaded.config.palettePreset}`,
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
			"/statusline — open the statusline menu",
			"/statusline palette — choose a named or custom palette preset",
			"/statusline settings — edit and apply JSON",
			"/statusline status — show source, path, and warnings",
			"/statusline help — show this help",
			`Settings: ${settingsPath}`,
			"Fields: palettePreset, palette, density, separator, segments, segmentText, extensionStatusIcons",
			"Named presets ignore but preserve palette; custom uses its per-segment fg/bg colors.",
			"Use line_break between segments for another footer row; repeats must not be consecutive.",
			"The segmentText entries support prefix and suffix strings around Pi-owned dynamic values.",
		].join("\n"),
		"info",
	);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function canNotify(ctx: ExtensionCommandContext): boolean {
	return ctx.mode === "tui" || ctx.hasUI;
}

function formatError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
