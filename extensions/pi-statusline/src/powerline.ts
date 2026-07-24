import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { ansiStyle } from "./ansi.js";
import { resolvePreset } from "./presets/index.js";
import type { BlockColors, PowerlinePreset } from "./presets/types.js";
import {
	LINE_BREAK_SEGMENT_NAME,
	type PalettePreset,
	type PowerlineBlockName,
	type RenderItem,
	type RenderSegment,
	type SegmentPalette,
	type SeparatorName,
	type StatuslineConfig,
} from "./types.js";

interface PowerlineBlock {
	baseBlock: PowerlineBlockName;
	colors: BlockColors;
	segments: RenderSegment[];
}

export function renderPowerlineStatusline(
	width: number,
	items: RenderItem[],
	config: Pick<StatuslineConfig, "palettePreset" | "palette" | "density" | "separator">,
): string {
	if (items.length === 0 || width <= 0) return "";
	return splitLines(items)
		.map((segments) => fitPowerlineSegments(segments, width, config))
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

const SEGMENT_RETENTION_PRIORITY: Readonly<Record<RenderSegment["name"], number>> = {
	context: 120,
	model: 110,
	branch: 100,
	tools: 90,
	cwd: 80,
	thinking: 70,
	cost: 60,
	provider: 50,
	tokens: 40,
	time: 30,
	turn: 20,
	brand: 10,
};

function fitPowerlineSegments(
	segments: readonly RenderSegment[],
	width: number,
	config: Pick<StatuslineConfig, "palettePreset" | "palette" | "density" | "separator">,
): string {
	if (segments.length === 0) return "";
	const fitted = [...segments];
	while (fitted.length > 1) {
		const rendered = joinPowerlineSegments(fitted, config);
		if (visibleWidth(rendered) <= width) return rendered;
		let removalIndex = 0;
		for (let index = 1; index < fitted.length; index += 1) {
			const candidate = fitted[index];
			const current = fitted[removalIndex];
			if (
				candidate &&
				current &&
				SEGMENT_RETENTION_PRIORITY[candidate.name] < SEGMENT_RETENTION_PRIORITY[current.name]
			) {
				removalIndex = index;
			}
		}
		fitted.splice(removalIndex, 1);
	}
	return truncateToWidth(joinPowerlineSegments(fitted, config), width, "");
}

export function powerlineExtensionSeparator(
	_theme: Theme,
	palettePreset: PalettePreset = "tokyo-night",
): string {
	return ansiStyle(" • ", { fg: resolvePreset(palettePreset).extensionSeparator });
}

function joinPowerlineSegments(
	segments: RenderSegment[],
	config: Pick<StatuslineConfig, "palettePreset" | "palette" | "density" | "separator">,
): string {
	const preset = resolvePreset(config.palettePreset);
	const blocks = contiguousBlocks(segments, preset, config.palettePreset, config.palette);
	let line = ansiStyle("░▒▓", { fg: preset.lead });

	for (const [index, block] of blocks.entries()) {
		const previous = index === 0 ? undefined : blocks[index - 1]?.colors;
		if (previous) line += ansiStyle("", { fg: previous.bg, bg: block.colors.bg });
		line += ansiStyle(formatBlockText(block, config), block.colors);
	}

	const lastBlock = blocks.at(-1);
	if (lastBlock) line += ansiStyle("", { fg: lastBlock.colors.bg });
	return line;
}

function contiguousBlocks(
	segments: RenderSegment[],
	preset: PowerlinePreset,
	palettePreset: PalettePreset,
	configuredPalette: SegmentPalette,
): PowerlineBlock[] {
	const blocks: PowerlineBlock[] = [];
	const usesConfiguredColors = palettePreset === "custom";
	for (const segment of segments) {
		const colors = usesConfiguredColors
			? (configuredPalette[segment.name] ?? {})
			: preset.blocks[segment.block];
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
	block: PowerlineBlock,
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
