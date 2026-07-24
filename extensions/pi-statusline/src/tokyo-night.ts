import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { ansiFg, ansiStyle } from "./ansi.js";
import {
	LINE_BREAK_SEGMENT_NAME,
	type PaletteName,
	type RenderItem,
	type RenderSegment,
	type SeparatorName,
	type StatuslineConfig,
	type StatuslinePalette,
	type TokyoNightBlockName,
} from "./types.js";

interface TokyoNightBlock {
	baseBlock: TokyoNightBlockName;
	colors: BlockColors;
	segments: RenderSegment[];
}

interface BlockColors {
	fg: string;
	bg: string;
}

interface PowerlinePalette {
	lead: string;
	blocks: Record<TokyoNightBlockName, BlockColors>;
	extensionSeparator: string;
}

const BLOCK_NAMES: TokyoNightBlockName[] = ["header", "directory", "git", "runtime", "meter"];

const TOKYO_NIGHT_PALETTE: PowerlinePalette = {
	lead: "#a3aed2",
	blocks: {
		header: { fg: "#090c0c", bg: "#a3aed2" },
		directory: { fg: "#e3e5e5", bg: "#769ff0" },
		git: { fg: "#769ff0", bg: "#394260" },
		runtime: { fg: "#769ff0", bg: "#212736" },
		meter: { fg: "#a0a9cb", bg: "#1d2230" },
	},
	extensionSeparator: "#394260",
};

const SEMANTIC_COLORS = {
	accent: "#7aa2f7",
	muted: "#565f89",
	success: "#9ece6a",
	warning: "#e0af68",
	error: "#f7768e",
	dim: "#414868",
} as const;

type SemanticColor = keyof typeof SEMANTIC_COLORS;

const PALETTE_SEQUENCES: Record<Exclude<PaletteName, "tokyo-night">, SemanticColor[]> = {
	ocean: ["accent", "muted", "success", "warning"],
	sunset: ["warning", "accent", "success", "muted"],
	forest: ["success", "accent", "muted", "warning"],
	candy: ["accent", "warning", "success", "muted"],
	neon: ["accent", "success", "warning", "error"],
	mono: ["muted", "dim"],
};

export function renderTokyoNightStatusline(
	width: number,
	items: RenderItem[],
	config: Pick<StatuslineConfig, "palette" | "density" | "separator">,
): string {
	if (items.length === 0 || width <= 0) return "";
	return splitLines(items)
		.map((segments) =>
			segments.length === 0
				? ""
				: truncateToWidth(joinTokyoNightSegments(segments, config), width, ""),
		)
		.join("\n");
}

function splitLines(items: RenderItem[]): RenderSegment[][] {
	const lines: RenderSegment[][] = [[]];
	for (const item of items) {
		if (item.name === LINE_BREAK_SEGMENT_NAME) lines.push([]);
		else lines.at(-1)?.push(item);
	}
	return lines;
}

export function tokyoNightExtensionSeparator(
	_theme: Theme,
	palette: StatuslinePalette = "tokyo-night",
): string {
	return ansiFg(resolvePalette(palette).extensionSeparator, " • ");
}

function joinTokyoNightSegments(
	segments: RenderSegment[],
	config: Pick<StatuslineConfig, "palette" | "density" | "separator">,
): string {
	const palette = resolvePalette(config.palette);
	const blocks = contiguousBlocks(segments, palette, config.palette);
	let line = ansiFg(palette.lead, "░▒▓");

	for (const [index, block] of blocks.entries()) {
		const previous = index === 0 ? undefined : blocks[index - 1]?.colors;
		if (previous) line += ansiStyle("", { fg: previous.bg, bg: block.colors.bg });
		line += ansiStyle(formatBlockText(block, config), block.colors);
	}

	const lastBlock = blocks.at(-1);
	if (lastBlock) line += ansiFg(lastBlock.colors.bg, "");
	return line;
}

function contiguousBlocks(
	segments: RenderSegment[],
	palette: PowerlinePalette,
	configuredPalette: StatuslinePalette,
): TokyoNightBlock[] {
	const blocks: TokyoNightBlock[] = [];
	const usesConfiguredColors = typeof configuredPalette !== "string";
	for (const segment of segments) {
		const colors = usesConfiguredColors
			? configuredPalette[segment.name]
			: palette.blocks[segment.block];
		const previous = blocks.at(-1);
		const matchesPrevious =
			previous !== undefined &&
			(usesConfiguredColors
				? colorsEqual(previous.colors, colors)
				: previous.baseBlock === segment.block);
		if (matchesPrevious) previous.segments.push(segment);
		else blocks.push({ baseBlock: segment.block, colors, segments: [segment] });
	}
	return blocks;
}

function colorsEqual(left: BlockColors, right: BlockColors): boolean {
	return left.fg === right.fg && left.bg === right.bg;
}

function formatBlockText(
	block: TokyoNightBlock,
	config: Pick<StatuslineConfig, "density" | "separator">,
): string {
	const texts = block.segments.map(formatSegmentText);
	const separator = separatorText(config.separator, config.density === "cozy");
	const leading = config.density === "cozy" ? "  " : " ";
	const trailing = config.density === "cozy" ? " " : "";
	return `${leading}${texts.join(separator)}${trailing}`;
}

function formatSegmentText(segment: RenderSegment): string {
	return segment.emphasis ? `\u001b[1m${segment.text}\u001b[22m` : segment.text;
}

function separatorText(separator: SeparatorName, cozy: boolean): string {
	const padding = cozy ? "  " : " ";
	switch (separator) {
		case "dot":
			return `${padding}•${padding}`;
		case "bar":
			return `${padding}│${padding}`;
		case "powerline":
			return `${padding}${padding}`;
		case "round":
			return `${padding}❯${padding}`;
		case "none":
			return padding;
	}
}

function resolvePalette(palette: StatuslinePalette): PowerlinePalette {
	if (typeof palette !== "string" || palette === "tokyo-night") return TOKYO_NIGHT_PALETTE;
	const sequence = PALETTE_SEQUENCES[palette];
	const backgrounds = BLOCK_NAMES.map(
		(_block, index) => SEMANTIC_COLORS[sequence[index % sequence.length] ?? "muted"],
	);
	return {
		lead: backgrounds[0] ?? SEMANTIC_COLORS.accent,
		blocks: Object.fromEntries(
			BLOCK_NAMES.map((block, index) => {
				const background = backgrounds[index] ?? SEMANTIC_COLORS.muted;
				return [block, { fg: contrastColor(background), bg: background }];
			}),
		) as Record<TokyoNightBlockName, BlockColors>,
		extensionSeparator: backgrounds[2] ?? SEMANTIC_COLORS.muted,
	};
}

function contrastColor(hex: string): string {
	const normalized = hex.slice(1);
	const red = Number.parseInt(normalized.slice(0, 2), 16);
	const green = Number.parseInt(normalized.slice(2, 4), 16);
	const blue = Number.parseInt(normalized.slice(4, 6), 16);
	return red * 0.299 + green * 0.587 + blue * 0.114 > 150 ? "#090c0c" : "#f0f0f0";
}
