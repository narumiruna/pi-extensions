import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
	type AutocompleteItem,
	type SelectItem,
	SelectList,
	truncateToWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import {
	atomicRestoreConfigDocument,
	atomicSaveConfigDocument,
	BUILT_IN_EXAMPLE,
	type LoadedStarshipConfig,
	validateConfigDocument,
} from "./config.js";

const SUBCOMMANDS: AutocompleteItem[] = [
	{ value: "settings", label: "settings", description: "Customize the footer TOML" },
	{ value: "status", label: "status", description: "Show configuration health and source" },
	{ value: "help", label: "help", description: "Show configuration help" },
];

const MAIN_ACTIONS = {
	customize: "customize",
	diagnostics: "diagnostics",
	help: "help",
	advanced: "advanced",
} as const;

const ADVANCED_ACTIONS = {
	details: "details",
	restore: "restore",
	back: "back",
} as const;

const PREVIEW_ACTIONS = {
	continue: "continue",
	edit: "edit",
	cancel: "cancel",
} as const;

export interface StarshipCommandOptions {
	getLoaded(): LoadedStarshipConfig;
	apply(loaded: LoadedStarshipConfig, ctx: ExtensionCommandContext): void;
	settingsPath: string;
	renderPreview?(
		loaded: LoadedStarshipConfig,
		width: number,
		ctx: ExtensionCommandContext,
	): string[];
	save?: (settingsPath: string, rawDocument: string) => LoadedStarshipConfig;
	restore?: (settingsPath: string, rawDocument: string) => void;
	validate?: (settingsPath: string, rawDocument: string) => LoadedStarshipConfig;
}

interface MenuItem extends SelectItem {
	value: string;
}

export function registerStarshipCommand(pi: ExtensionAPI, options: StarshipCommandOptions) {
	pi.registerCommand("starship", {
		description: "Customize or inspect the native Starship-style footer",
		getArgumentCompletions(prefix: string): AutocompleteItem[] | null {
			const normalized = prefix.trim().toLowerCase();
			const matches = SUBCOMMANDS.filter((item) => item.value.startsWith(normalized));
			return matches.length > 0 ? matches : null;
		},
		handler: async (args, ctx) => {
			const normalized = args.trim();
			if (!normalized) {
				if (ctx.mode === "tui") await showMainMenu(ctx, options);
				else showHelp(ctx, options.settingsPath);
				return;
			}

			const subcommand = normalized.split(/\s+/u)[0]?.toLowerCase() ?? "";
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

async function showMainMenu(ctx: ExtensionCommandContext, options: StarshipCommandOptions) {
	while (true) {
		const loaded = options.getLoaded();
		const state = configurationState(loaded);
		const health = configurationHealth(loaded);
		const selection = await showActionMenu(ctx, "pi-starship", () => [`${state} · ${health}`], [
			{
				value: MAIN_ACTIONS.customize,
				label: "Customize footer",
				description: `${state} · preview before applying`,
			},
			{
				value: MAIN_ACTIONS.diagnostics,
				label: "Check configuration",
				description: health,
			},
			{ value: MAIN_ACTIONS.help, label: "Help", description: "Formats, modules, and commands" },
			{
				value: MAIN_ACTIONS.advanced,
				label: "Advanced",
				description: "Details and restore controls",
			},
		]);
		switch (selection) {
			case MAIN_ACTIONS.customize:
				if (await editSettings(ctx, options)) return;
				break;
			case MAIN_ACTIONS.diagnostics:
				await showDiagnosticsScreen(ctx, loaded);
				break;
			case MAIN_ACTIONS.help:
				await showHelpScreen(ctx, options.settingsPath);
				break;
			case MAIN_ACTIONS.advanced:
				if (!(await showAdvancedMenu(ctx, options))) return;
				break;
			default:
				return;
		}
	}
}

async function showAdvancedMenu(
	ctx: ExtensionCommandContext,
	options: StarshipCommandOptions,
): Promise<boolean> {
	while (true) {
		const loaded = options.getLoaded();
		const alreadyBuiltIn = loaded.rawDocument === BUILT_IN_EXAMPLE;
		const selection = await showActionMenu(ctx, "Advanced", () => [configurationState(loaded)], [
			{
				value: ADVANCED_ACTIONS.details,
				label: "Configuration details",
				description: `${configurationSource(loaded)} · ${fileName(options.settingsPath)}`,
			},
			{
				value: ADVANCED_ACTIONS.restore,
				label: "Restore built-in",
				description: alreadyBuiltIn ? "Already active" : "Preview before replacing the document",
			},
			{ value: ADVANCED_ACTIONS.back, label: "Back", description: "Return to pi-starship" },
		]);
		if (selection === ADVANCED_ACTIONS.details) {
			await showConfigurationDetails(ctx, loaded, options.settingsPath);
			continue;
		}
		if (selection === ADVANCED_ACTIONS.restore) {
			if (alreadyBuiltIn) {
				ctx.ui.notify("The built-in footer configuration is already active.", "info");
				continue;
			}
			if (await restoreBuiltIn(ctx, options)) return false;
			continue;
		}
		return selection === ADVANCED_ACTIONS.back;
	}
}

async function editSettings(
	ctx: ExtensionCommandContext,
	options: StarshipCommandOptions,
): Promise<boolean> {
	if (ctx.mode !== "tui") {
		if (ctx.hasUI) ctx.ui.notify(`Edit settings manually: ${options.settingsPath}`, "info");
		return false;
	}
	let draft = options.getLoaded().rawDocument ?? BUILT_IN_EXAMPLE;
	while (true) {
		const edited = await ctx.ui.editor("Customize footer — close to preview", draft);
		if (edited === undefined) return false;
		draft = edited;
		let validated: LoadedStarshipConfig;
		try {
			validated = (options.validate ?? validateConfigDocument)(options.settingsPath, draft);
		} catch (error) {
			ctx.ui.notify(`Footer draft is invalid: ${safeText(formatError(error))}`, "error");
			const action = await showActionMenu(
				ctx,
				"Configuration needs attention",
				() => [safeText(formatError(error)), "The current footer has not changed."],
				[
					{ value: PREVIEW_ACTIONS.edit, label: "Continue editing" },
					{ value: PREVIEW_ACTIONS.cancel, label: "Back" },
				],
			);
			if (action === PREVIEW_ACTIONS.edit) continue;
			return false;
		}

		const result = await reviewAndApply(ctx, options, validated, "Footer preview", false);
		if (result === "edit") continue;
		return result === "applied";
	}
}

async function restoreBuiltIn(
	ctx: ExtensionCommandContext,
	options: StarshipCommandOptions,
): Promise<boolean> {
	const validated = (options.validate ?? validateConfigDocument)(
		options.settingsPath,
		BUILT_IN_EXAMPLE,
	);
	return (await reviewAndApply(ctx, options, validated, "Restore preview", true)) === "applied";
}

async function reviewAndApply(
	ctx: ExtensionCommandContext,
	options: StarshipCommandOptions,
	validated: LoadedStarshipConfig,
	title: string,
	restore: boolean,
): Promise<"applied" | "edit" | "cancel"> {
	while (true) {
		const selection = await showActionMenu(
			ctx,
			title,
			(width) => previewBody(ctx, options, validated, width),
			[
				{ value: PREVIEW_ACTIONS.continue, label: "Continue to apply" },
				...(restore ? [] : [{ value: PREVIEW_ACTIONS.edit, label: "Continue editing" }]),
				{ value: PREVIEW_ACTIONS.cancel, label: "Cancel" },
			],
		);
		if (selection === PREVIEW_ACTIONS.edit) return "edit";
		if (selection !== PREVIEW_ACTIONS.continue) return "cancel";

		const confirmed = await ctx.ui.confirm(
			restore ? "Restore built-in footer?" : "Apply footer changes?",
			restore
				? `Replace ${options.settingsPath} with the built-in configuration?`
				: "Save this configuration and apply it immediately?",
		);
		if (!confirmed) continue;

		const save = options.save ?? atomicSaveConfigDocument;
		const previous = options.getLoaded();
		let saved: LoadedStarshipConfig;
		try {
			saved = save(options.settingsPath, validated.rawDocument ?? BUILT_IN_EXAMPLE);
		} catch (error) {
			ctx.ui.notify(
				`Footer settings were not saved: ${safeText(formatError(error))}. The previous footer remains active.`,
				"error",
			);
			continue;
		}

		try {
			options.apply(saved, ctx);
		} catch (error) {
			const rollbackError = restorePreviousConfiguration(ctx, options, previous);
			ctx.ui.notify(
				rollbackError
					? `Footer settings could not be applied: ${safeText(formatError(error))}. Restoring the previous configuration also failed: ${safeText(formatError(rollbackError))}.`
					: `Footer settings could not be applied: ${safeText(formatError(error))}. The previous configuration was restored.`,
				"error",
			);
			continue;
		}

		const warningSuffix =
			saved.diagnostics.length > 0
				? ` (${saved.diagnostics.length} warning${saved.diagnostics.length === 1 ? "" : "s"})`
				: "";
		ctx.ui.notify(
			restore
				? `Built-in footer restored and applied${warningSuffix}.`
				: `Footer settings saved and applied${warningSuffix}.`,
			"info",
		);
		return "applied";
	}
}

function restorePreviousConfiguration(
	ctx: ExtensionCommandContext,
	options: StarshipCommandOptions,
	previous: LoadedStarshipConfig,
): unknown {
	try {
		if (previous.rawDocument === undefined) {
			throw new Error("The previous settings document is unavailable");
		}
		(options.restore ?? atomicRestoreConfigDocument)(options.settingsPath, previous.rawDocument);
		options.apply(previous, ctx);
		return undefined;
	} catch (error) {
		return error;
	}
}

function previewBody(
	ctx: ExtensionCommandContext,
	options: StarshipCommandOptions,
	loaded: LoadedStarshipConfig,
	width: number,
): string[] {
	let lines: string[];
	try {
		lines = options.renderPreview?.(loaded, width, ctx) ?? [
			"Live preview is unavailable until the footer is ready.",
			"The draft is valid and can still be applied.",
		];
	} catch (error) {
		lines = [`Preview unavailable: ${safeText(formatError(error))}`];
	}
	const warning =
		loaded.diagnostics.length === 0
			? "Draft validation: Healthy"
			: `Draft validation: ${loaded.diagnostics.length} warning${loaded.diagnostics.length === 1 ? "" : "s"}`;
	return [...lines, "", warning];
}

async function showDiagnosticsScreen(ctx: ExtensionCommandContext, loaded: LoadedStarshipConfig) {
	await showActionMenu(ctx, "Configuration health", () => diagnosticLines(loaded, false), [
		{ value: ADVANCED_ACTIONS.back, label: "Back" },
	]);
}

async function showConfigurationDetails(
	ctx: ExtensionCommandContext,
	loaded: LoadedStarshipConfig,
	settingsPath: string,
) {
	await showActionMenu(
		ctx,
		"Configuration details",
		() => [
			`State: ${configurationState(loaded)}`,
			`Source: ${configurationSource(loaded)}`,
			`Path: ${safeText(settingsPath)}`,
			...diagnosticLines(loaded, true),
		],
		[{ value: ADVANCED_ACTIONS.back, label: "Back" }],
	);
}

async function showHelpScreen(ctx: ExtensionCommandContext, settingsPath: string) {
	await showActionMenu(
		ctx,
		"pi-starship help",
		() => [
			"Customize footer opens the TOML editor, then previews and confirms before saving.",
			"Check configuration explains warnings without changing the footer.",
			`Settings: ${safeText(settingsPath)}`,
			"Docs: https://github.com/narumiruna/pi-extensions/tree/main/extensions/pi-starship",
		],
		[{ value: ADVANCED_ACTIONS.back, label: "Back" }],
	);
}

async function showActionMenu(
	ctx: ExtensionCommandContext,
	title: string,
	body: (width: number) => readonly string[],
	items: readonly MenuItem[],
): Promise<string | null> {
	return ctx.ui.custom<string | null>((tui, theme, _keybindings, done) => {
		const list = new SelectList([...items], Math.min(items.length, 8), {
			selectedPrefix: (text) => theme.fg("accent", text),
			selectedText: (text) => theme.fg("accent", text),
			description: (text) => theme.fg("muted", text),
			scrollInfo: (text) => theme.fg("dim", text),
			noMatch: (text) => theme.fg("warning", text),
		});
		list.onSelect = (item) => done(String(item.value));
		list.onCancel = () => done(null);
		return {
			render(width: number): string[] {
				const safeWidth = Math.max(1, width);
				const content = [
					...wrapTextWithAnsi(theme.fg("accent", theme.bold(title)), safeWidth),
					...body(safeWidth).flatMap((line) => (line ? wrapTextWithAnsi(line, safeWidth) : [""])),
					"",
					...list.render(safeWidth),
					...wrapTextWithAnsi(
						theme.fg("dim", "↑↓ navigate • enter select • esc cancel"),
						safeWidth,
					),
				];
				return content.map((line) => truncateToWidth(line, safeWidth));
			},
			invalidate() {
				list.invalidate();
			},
			handleInput(data: string) {
				list.handleInput(data);
				tui.requestRender();
			},
		};
	});
}

function diagnosticLines(loaded: LoadedStarshipConfig, includeSummary: boolean): string[] {
	const diagnostics = loaded.diagnostics
		.slice(0, 8)
		.map((item) => `${safeText(item.path || "root")}: ${safeText(item.message)}`);
	const remaining = loaded.diagnostics.length - diagnostics.length;
	return [
		...(includeSummary ? [`Health: ${configurationHealth(loaded)}`] : []),
		...(diagnostics.length > 0 ? diagnostics : ["No configuration warnings."]),
		...(remaining > 0 ? [`${remaining} additional warnings not shown.`] : []),
	];
}

function configurationState(loaded: LoadedStarshipConfig): string {
	if (loaded.source === "built-in") return "Built-in fallback";
	return loaded.rawDocument === BUILT_IN_EXAMPLE ? "Built-in footer" : "Custom footer";
}

function configurationSource(loaded: LoadedStarshipConfig): string {
	return loaded.source === "user" ? "User file" : "Built-in fallback";
}

function configurationHealth(loaded: LoadedStarshipConfig): string {
	const errors = loaded.diagnostics.filter((item) => item.severity === "error").length;
	if (errors > 0) return `${errors} error${errors === 1 ? "" : "s"}`;
	const warnings = loaded.diagnostics.length;
	return warnings === 0 ? "Healthy" : `${warnings} warning${warnings === 1 ? "" : "s"}`;
}

function fileName(path: string): string {
	return path.replaceAll("\\", "/").split("/").at(-1) || path;
}

function showStatus(ctx: ExtensionCommandContext, options: StarshipCommandOptions) {
	if (!canNotify(ctx)) return;
	const loaded = options.getLoaded();
	const diagnostics = loaded.diagnostics
		.slice(0, 5)
		.map((item) => `${safeText(item.path || "root")}: ${safeText(item.message)}`)
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
			"/starship — open the interactive footer menu",
			"/starship settings — customize, preview, and apply TOML",
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

function safeText(value: string): string {
	return Array.from(value, (character) => {
		const codePoint = character.codePointAt(0) ?? 0;
		const unsafe =
			codePoint <= 0x08 ||
			(codePoint >= 0x0b && codePoint <= 0x1f) ||
			(codePoint >= 0x7f && codePoint <= 0x9f);
		return unsafe ? `\\u${codePoint.toString(16).padStart(4, "0")}` : character;
	}).join("");
}

function formatError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
