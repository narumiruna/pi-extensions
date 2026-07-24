import {
	DynamicBorder,
	type ExtensionAPI,
	type ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import {
	type AutocompleteItem,
	Container,
	Key,
	matchesKey,
	type SelectItem,
	SelectList,
	Text,
	truncateToWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { segmentPaletteForPreset } from "./presets/index.js";
import {
	DEFAULT_STATUSLINE_DOCUMENT,
	type LoadedStatuslineSettings,
	saveStatuslineSettingsDocument,
} from "./settings.js";
import {
	type ConfigSegmentName,
	LINE_BREAK_SEGMENT_NAME,
	PALETTE_NAMES,
	PALETTE_PRESET_NAMES,
	type PaletteName,
	type PalettePreset,
	SEGMENT_NAMES,
	type SegmentName,
} from "./types.js";

const EDIT_SETTINGS_LABEL = "Edit settings JSON (custom colors, layout, icons)";
const SEGMENT_VIEWPORT_SIZE = 6;
const NARROW_SEGMENT_VIEWPORT_SIZE = 3;
const SEGMENT_DESCRIPTIONS: Record<SegmentName, string> = {
	brand: "Pi brand mark",
	provider: "Current model provider",
	model: "Current model name",
	thinking: "Current thinking level",
	cwd: "Current working directory",
	branch: "Git branch, status, and linked pull request",
	tools: "Current tool and streaming activity",
	context: "Current context-window usage",
	tokens: "Session token totals",
	cost: "Session cost",
	time: "Current local time",
	turn: "Current session turn count",
};
const SUBCOMMANDS: AutocompleteItem[] = [
	{ value: "settings", label: "settings", description: "Edit pi-statusline.json" },
	{ value: "status", label: "status", description: "Show effective statusline settings" },
	{ value: "help", label: "help", description: "Show configuration help" },
];

export interface StatuslineCommandOptions {
	settingsPath: string;
	getLoaded(): LoadedStatuslineSettings;
	apply(loaded: LoadedStatuslineSettings, ctx: ExtensionCommandContext): void;
	preview?(palettePreset: PalettePreset | undefined, ctx: ExtensionCommandContext): void;
	save?: (settingsPath: string, rawDocument: string) => LoadedStatuslineSettings;
}

export function registerStatuslineCommand(pi: ExtensionAPI, options: StatuslineCommandOptions) {
	pi.registerCommand("statusline", {
		description: "Open or inspect the statusline settings",
		getArgumentCompletions(prefix: string): AutocompleteItem[] | null {
			const normalized = prefix.trim().toLowerCase();
			const matches = SUBCOMMANDS.filter((item) => item.value.startsWith(normalized));
			return matches.length > 0 ? matches : null;
		},
		handler: async (args, ctx) => {
			const normalized = args.trim();
			if (!normalized) {
				await showMainMenu(ctx, options);
				return;
			}

			const tokens = normalized.split(/\s+/u);
			const subcommand = tokens[0]?.toLowerCase() ?? "";
			if (tokens.length > 1) {
				if (canNotify(ctx)) {
					ctx.ui.notify(`/statusline ${subcommand} does not accept trailing arguments.`, "warning");
				}
				return;
			}

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

async function showMainMenu(ctx: ExtensionCommandContext, options: StatuslineCommandOptions) {
	if (ctx.mode !== "tui") {
		if (ctx.hasUI) ctx.ui.notify("/statusline requires an interactive Pi UI.", "error");
		return;
	}
	const config = options.getLoaded().config;
	const paletteItem = `Palette preset (${config.palettePreset})`;
	const visibleSegmentCount = config.segments.filter(
		(segment): segment is SegmentName => segment !== LINE_BREAK_SEGMENT_NAME,
	).length;
	const segmentsItem = `Segments (${visibleSegmentCount}/${SEGMENT_NAMES.length} shown)`;
	const selection = await ctx.ui.select("pi-statusline", [
		paletteItem,
		segmentsItem,
		EDIT_SETTINGS_LABEL,
		"Status",
		"Help",
	]);
	if (selection === paletteItem) {
		await choosePalettePreset(ctx, options);
		return;
	}
	switch (selection) {
		case segmentsItem:
			await chooseSegments(ctx, options);
			return;
		case EDIT_SETTINGS_LABEL:
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
	let selection: PalettePreset | undefined;
	try {
		selection = await showPalettePresetPicker(ctx, current.config.palettePreset, options);
	} finally {
		options.preview?.(undefined, ctx);
	}
	if (selection === undefined) return;

	try {
		const rawDocument = palettePresetDocument(current, selection);
		const loaded = (options.save ?? saveStatuslineSettingsDocument)(
			options.settingsPath,
			rawDocument,
		);
		options.apply(loaded, ctx);
		const message =
			loaded.config.palettePreset === "custom"
				? "Custom palette applied. Edit palette colors via /statusline → Edit settings JSON."
				: `Palette preset applied: ${loaded.config.palettePreset}.`;
		ctx.ui.notify(message, "info");
	} catch (error) {
		ctx.ui.notify(`Palette preset was not saved: ${formatError(error)}`, "error");
	}
}

async function showPalettePresetPicker(
	ctx: ExtensionCommandContext,
	current: PalettePreset,
	options: StatuslineCommandOptions,
): Promise<PalettePreset | undefined> {
	const items: SelectItem[] = PALETTE_PRESET_NAMES.map((palettePreset) => ({
		value: palettePreset,
		label: palettePreset,
		description:
			[
				palettePreset === current ? "current" : undefined,
				palettePreset === "custom" ? "per-segment colors from settings JSON" : undefined,
			]
				.filter((part): part is string => part !== undefined)
				.join(" • ") || undefined,
	}));
	const selectedIndex = PALETTE_PRESET_NAMES.indexOf(current);
	const result = await ctx.ui.custom<PalettePreset | null>((tui, theme, _keybindings, done) => {
		const container = new Container();
		container.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));
		const title = new Text("", 1, 0);
		container.addChild(title);
		const list = new SelectList(items, Math.min(items.length, 10), {
			selectedPrefix: (text) => theme.fg("accent", text),
			selectedText: (text) => theme.fg("accent", text),
			description: (text) => theme.fg("muted", text),
			scrollInfo: (text) => theme.fg("dim", text),
			noMatch: (text) => theme.fg("warning", text),
		});
		list.setSelectedIndex(selectedIndex);
		list.onSelectionChange = (item) => {
			options.preview?.(item.value as PalettePreset, ctx);
		};
		list.onSelect = (item) => done(item.value as PalettePreset);
		list.onCancel = () => done(null);
		container.addChild(list);
		const hint = new Text("", 1, 0);
		container.addChild(hint);
		container.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));
		const updateThemedText = () => {
			title.setText(theme.fg("accent", theme.bold(`Palette preset (current: ${current})`)));
			hint.setText(theme.fg("dim", "↑↓ preview • enter apply • esc cancel"));
		};
		updateThemedText();

		return {
			render: (width: number) => container.render(width),
			invalidate() {
				container.invalidate();
				updateThemedText();
			},
			handleInput(data: string) {
				list.handleInput(data);
				tui.requestRender();
			},
		};
	});
	return result ?? undefined;
}

async function chooseSegments(ctx: ExtensionCommandContext, options: StatuslineCommandOptions) {
	if (ctx.mode !== "tui") {
		if (ctx.hasUI) ctx.ui.notify(`Edit segments manually: ${options.settingsPath}`, "info");
		return;
	}
	let current = options.getLoaded();
	let names = segmentMenuOrder(current);
	let selectedIndex = 0;
	let moveMode = false;
	let feedback: string | undefined;

	await ctx.ui.custom((tui, theme, keybindings, done) => {
		const commit = (
			name: SegmentName,
			change: { nextDocument: string; previousDocument: string },
		): boolean => {
			try {
				current = applySegmentsDocumentChange(change, ctx, options);
				names = segmentMenuOrder(current);
				selectedIndex = Math.max(0, names.indexOf(name));
				feedback = undefined;
				return true;
			} catch (error) {
				ctx.ui.notify(`Statusline segments were not saved: ${formatError(error)}`, "error");
				return false;
			}
		};

		const toggleSelected = () => {
			const name = names[selectedIndex];
			if (!name) return;
			moveMode = false;
			commit(name, segmentsDocument(current, name, !current.config.segments.includes(name)));
		};

		const reorderSelected = (direction: -1 | 1) => {
			const name = names[selectedIndex];
			if (!name) return;
			const visibleNames = visibleSegmentNames(current);
			const currentIndex = visibleNames.indexOf(name);
			if (currentIndex < 0) {
				feedback = `Show ${name} before moving it.`;
				return;
			}
			const targetIndex = currentIndex + direction;
			if (targetIndex < 0 || targetIndex >= visibleNames.length) {
				feedback = `${name} is already the ${direction < 0 ? "first" : "last"} visible segment.`;
				return;
			}
			const change = reorderedSegmentsDocument(current, name, direction);
			if (change) commit(name, change);
		};

		const enterMoveMode = () => {
			const name = names[selectedIndex];
			if (!name) return;
			if (!current.config.segments.includes(name)) {
				feedback = `Show ${name} before moving it.`;
				return;
			}
			moveMode = true;
			feedback = undefined;
		};

		const moveSelection = (offset: number) => {
			selectedIndex = Math.max(0, Math.min(names.length - 1, selectedIndex + offset));
			feedback = undefined;
		};

		const renderList = (width: number): string[] => {
			const safeWidth = Math.max(1, width);
			const visibleNames = visibleSegmentNames(current);
			const visible = new Set(visibleNames);
			const placements = segmentPlacements(current.config.segments);
			const viewportSize = safeWidth < 30 ? NARROW_SEGMENT_VIEWPORT_SIZE : SEGMENT_VIEWPORT_SIZE;
			const startIndex = Math.max(
				0,
				Math.min(
					selectedIndex - Math.floor(viewportSize / 2),
					Math.max(0, names.length - viewportSize),
				),
			);
			const endIndex = Math.min(names.length, startIndex + viewportSize);
			const lines: string[] = [];
			let previousSection: "visible" | "hidden" | undefined;
			for (let index = startIndex; index < endIndex; index += 1) {
				const name = names[index];
				if (!name) continue;
				const section = visible.has(name) ? "visible" : "hidden";
				if (section !== previousSection) {
					const heading =
						section === "visible" ? "Visible — render order" : "Hidden — not rendered";
					lines.push(theme.fg("muted", theme.bold(truncateToWidth(`  ${heading}`, safeWidth))));
					previousSection = section;
				}
				const isSelected = index === selectedIndex;
				const prefix = isSelected ? "→ " : "  ";
				const placement = placements.get(name);
				const row = placement
					? `${prefix}${`${placement.order}.`.padStart(3)} row ${placement.row} · ${name.padEnd(8)} · visible`
					: `${prefix}  · ${name.padEnd(8)} · hidden`;
				const truncated = truncateToWidth(row, safeWidth);
				if (isSelected) lines.push(theme.fg("accent", truncated));
				else lines.push(section === "visible" ? truncated : theme.fg("muted", truncated));
			}
			if (startIndex > 0 || endIndex < names.length) {
				lines.push(
					theme.fg(
						"dim",
						truncateToWidth(`  (${startIndex + 1}-${endIndex}/${names.length})`, safeWidth),
					),
				);
			}

			const selected = names[selectedIndex];
			if (selected) {
				lines.push("");
				const detail = feedback ?? SEGMENT_DESCRIPTIONS[selected];
				const color = feedback ? "warning" : "muted";
				for (const line of wrapTextWithAnsi(detail, Math.max(1, safeWidth - 2))) {
					lines.push(theme.fg(color, truncateToWidth(`  ${line}`, safeWidth)));
				}
			}

			lines.push("");
			const hints = segmentControlHints(safeWidth, moveMode, selected);
			for (const hint of hints) {
				lines.push(theme.fg("dim", truncateToWidth(`  ${hint}`, safeWidth)));
			}
			return lines;
		};

		const container = new Container();
		container.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));
		const title = new Text("", 1, 0);
		container.addChild(title);
		container.addChild({ render: renderList, invalidate() {} });
		container.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));
		const updateThemedText = () => {
			title.setText(theme.fg("accent", theme.bold("Statusline segments")));
		};
		updateThemedText();

		return {
			render: (width: number) => container.render(width),
			invalidate() {
				container.invalidate();
				updateThemedText();
			},
			handleInput(data: string) {
				const moveModeKey = matchesKey(data, "m") || matchesKey(data, Key.shift("m"));
				if (matchesKey(data, Key.alt("up"))) {
					reorderSelected(-1);
				} else if (matchesKey(data, Key.alt("down"))) {
					reorderSelected(1);
				} else if (moveMode) {
					if (keybindings.matches(data, "tui.select.up")) {
						reorderSelected(-1);
					} else if (keybindings.matches(data, "tui.select.down")) {
						reorderSelected(1);
					} else if (
						moveModeKey ||
						keybindings.matches(data, "tui.select.confirm") ||
						data === " " ||
						keybindings.matches(data, "tui.select.cancel")
					) {
						moveMode = false;
						feedback = undefined;
					}
				} else if (keybindings.matches(data, "tui.select.up")) {
					selectedIndex = selectedIndex === 0 ? names.length - 1 : selectedIndex - 1;
					feedback = undefined;
				} else if (keybindings.matches(data, "tui.select.down")) {
					selectedIndex = selectedIndex === names.length - 1 ? 0 : selectedIndex + 1;
					feedback = undefined;
				} else if (keybindings.matches(data, "tui.select.pageUp")) {
					moveSelection(-SEGMENT_VIEWPORT_SIZE);
				} else if (keybindings.matches(data, "tui.select.pageDown")) {
					moveSelection(SEGMENT_VIEWPORT_SIZE);
				} else if (moveModeKey) {
					enterMoveMode();
				} else if (keybindings.matches(data, "tui.select.confirm") || data === " ") {
					toggleSelected();
				} else if (keybindings.matches(data, "tui.select.cancel")) {
					done(undefined);
				}
				tui.requestRender();
			},
		};
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

function palettePresetDocument(
	current: LoadedStatuslineSettings,
	palettePreset: PalettePreset,
): string {
	const { parsed } = editableSettings(current, "choosing a palette preset");
	if (palettePreset === "custom" && !isRecord(parsed.palette)) {
		const seedPreset = isPaletteName(current.config.palettePreset)
			? current.config.palettePreset
			: "tokyo-night";
		parsed.palette = segmentPaletteForPreset(seedPreset);
	} else if (palettePreset !== "custom" && typeof parsed.palette === "string") {
		delete parsed.palette;
	}
	parsed.palettePreset = palettePreset;
	return `${JSON.stringify(parsed, null, "\t")}\n`;
}

function visibleSegmentNames(current: LoadedStatuslineSettings): SegmentName[] {
	return current.config.segments.filter(
		(segment): segment is SegmentName => segment !== LINE_BREAK_SEGMENT_NAME,
	);
}

function segmentMenuOrder(current: LoadedStatuslineSettings): SegmentName[] {
	const visible = visibleSegmentNames(current);
	const visibleSet = new Set(visible);
	return [...visible, ...SEGMENT_NAMES.filter((name) => !visibleSet.has(name))];
}

function segmentPlacements(
	segments: readonly ConfigSegmentName[],
): Map<SegmentName, { order: number; row: number }> {
	const placements = new Map<SegmentName, { order: number; row: number }>();
	let order = 0;
	let row = 1;
	for (const segment of segments) {
		if (segment === LINE_BREAK_SEGMENT_NAME) {
			row += 1;
			continue;
		}
		placements.set(segment, { order: ++order, row });
	}
	return placements;
}

function segmentControlHints(
	width: number,
	moveMode: boolean,
	selected: SegmentName | undefined,
): string[] {
	if (moveMode) {
		return width < 30
			? [
					`Move mode: ${selected ?? "segment"}`,
					"↑↓ move segment",
					"Enter/Space finish",
					"Esc leave move mode",
				]
			: [
					`Move mode — ${selected ?? "segment"}`,
					"↑↓ move · Enter/Space finish · Esc leave move mode",
				];
	}
	return width < 30
		? ["↑↓ navigate", "Enter/Space toggle", "M move mode", "Alt+↑/↓ quick move", "Esc close"]
		: ["↑↓ navigate · Enter/Space show/hide · M move mode", "Alt+↑/↓ quick move · Esc close"];
}

function segmentsDocument(
	current: LoadedStatuslineSettings,
	name: SegmentName,
	shouldShow: boolean,
): { nextDocument: string; previousDocument: string } {
	const { parsed, rawDocument: previousDocument } = editableSettings(current, "changing segments");
	const segments = shouldShow
		? [...current.config.segments, ...(current.config.segments.includes(name) ? [] : [name])]
		: current.config.segments.filter((segment) => segment !== name);
	parsed.segments = normalizeLineBreaks(segments);
	return {
		nextDocument: `${JSON.stringify(parsed, null, "\t")}\n`,
		previousDocument,
	};
}

function reorderedSegmentsDocument(
	current: LoadedStatuslineSettings,
	name: SegmentName,
	direction: -1 | 1,
): { nextDocument: string; previousDocument: string } | undefined {
	const dataIndexes = current.config.segments.flatMap((segment, index) =>
		segment === LINE_BREAK_SEGMENT_NAME ? [] : [index],
	);
	const currentDataIndex = dataIndexes.findIndex(
		(index) => current.config.segments[index] === name,
	);
	const targetDataIndex = currentDataIndex + direction;
	if (currentDataIndex < 0 || targetDataIndex < 0 || targetDataIndex >= dataIndexes.length) {
		return undefined;
	}
	const { parsed, rawDocument: previousDocument } = editableSettings(
		current,
		"reordering segments",
	);
	const segments = [...current.config.segments];
	const currentIndex = dataIndexes[currentDataIndex];
	const targetIndex = dataIndexes[targetDataIndex];
	if (currentIndex === undefined || targetIndex === undefined) return undefined;
	[segments[currentIndex], segments[targetIndex]] = [segments[targetIndex], segments[currentIndex]];
	parsed.segments = segments;
	return {
		nextDocument: `${JSON.stringify(parsed, null, "\t")}\n`,
		previousDocument,
	};
}

function applySegmentsDocumentChange(
	change: { nextDocument: string; previousDocument: string },
	ctx: ExtensionCommandContext,
	options: StatuslineCommandOptions,
): LoadedStatuslineSettings {
	const save = options.save ?? saveStatuslineSettingsDocument;
	const next = save(options.settingsPath, change.nextDocument);
	try {
		options.apply(next, ctx);
	} catch (applyError) {
		try {
			const restored = save(options.settingsPath, change.previousDocument);
			options.apply(restored, ctx);
		} catch (rollbackError) {
			throw new Error(
				`runtime update failed: ${formatError(applyError)}; rollback failed: ${formatError(rollbackError)}`,
			);
		}
		throw applyError;
	}
	return next;
}

function normalizeLineBreaks(segments: readonly ConfigSegmentName[]): ConfigSegmentName[] {
	const normalized: ConfigSegmentName[] = [];
	for (const segment of segments) {
		if (
			segment === LINE_BREAK_SEGMENT_NAME &&
			(normalized.length === 0 || normalized.at(-1) === LINE_BREAK_SEGMENT_NAME)
		) {
			continue;
		}
		normalized.push(segment);
	}
	if (normalized.at(-1) === LINE_BREAK_SEGMENT_NAME) normalized.pop();
	return normalized;
}

function editableSettings(
	current: LoadedStatuslineSettings,
	action: string,
): { parsed: Record<string, unknown>; rawDocument: string } {
	if (
		current.source !== "user" ||
		current.rawDocument === undefined ||
		current.diagnostics.some((item) => item.code !== "unknown")
	) {
		throw new Error(`Fix pi-statusline.json before ${action}`);
	}
	const rawDocument = current.rawDocument;
	const parsed = JSON.parse(rawDocument) as unknown;
	if (!isRecord(parsed)) throw new Error("Settings must contain a JSON object");
	return { parsed, rawDocument };
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
			"/statusline — open the interactive statusline menu",
			"/statusline settings — edit and apply JSON",
			"/statusline status — show source, path, and warnings",
			"/statusline help — show this help",
			"Menu actions: Palette preset, Segments, Edit settings JSON, Status, Help",
			`Settings: ${settingsPath}`,
			"Fields: palettePreset, palette, density, separator, segments, segmentText, extensionStatusIcons",
			"Named presets ignore but preserve palette; custom uses its per-segment fg/bg colors.",
			"Use the Segments menu to show, hide, or reorder data segments; changes save and apply immediately.",
			"Rows and visible/hidden sections reflect the effective layout; unavailable moves explain why.",
			"Press M for move mode with ordinary arrows, or Alt+Up/Alt+Down for a quick move.",
			"Use line_break between segments for another footer row; repeats must not be consecutive.",
			"The segmentText entries support prefix and suffix strings around Pi-owned dynamic values.",
		].join("\n"),
		"info",
	);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPaletteName(value: PalettePreset): value is PaletteName {
	return (PALETTE_NAMES as readonly PalettePreset[]).includes(value);
}

function canNotify(ctx: ExtensionCommandContext): boolean {
	return ctx.mode === "tui" || ctx.hasUI;
}

function formatError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
