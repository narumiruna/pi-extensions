import type { Theme } from "@mariozechner/pi-coding-agent";
import { truncateToWidth } from "@mariozechner/pi-tui";
import { ansiFg, ansiStyle } from "./ansi.js";
import type { RenderSegment, TokyoNightBlockName } from "./types.js";

interface TokyoNightBlock {
	name: TokyoNightBlockName;
	segments: RenderSegment[];
}

interface BlockColors {
	fg: string;
	bg: string;
}

const TOKYO_NIGHT_COLORS = {
	lead: "#a3aed2",
	header: { fg: "#090c0c", bg: "#a3aed2" },
	directory: { fg: "#e3e5e5", bg: "#769ff0" },
	git: { fg: "#769ff0", bg: "#394260" },
	runtime: { fg: "#769ff0", bg: "#212736" },
	meter: { fg: "#a0a9cb", bg: "#1d2230" },
	extensionSeparator: "#394260",
} as const satisfies Record<string, string | BlockColors>;

const TOKYO_NIGHT_BLOCK_ORDER: TokyoNightBlockName[] = [
	"header",
	"directory",
	"git",
	"runtime",
	"meter",
];

export function renderTokyoNightStatusline(width: number, segments: RenderSegment[]): string {
	return truncateToWidth(joinTokyoNightSegments(segments), width, "");
}

export function tokyoNightExtensionSeparator(_theme: Theme): string {
	return ansiFg(TOKYO_NIGHT_COLORS.extensionSeparator, "  ");
}

function joinTokyoNightSegments(segments: RenderSegment[]): string {
	const blocks = groupTokyoNightBlocks(segments);
	let line = ansiFg(TOKYO_NIGHT_COLORS.lead, "░▒▓");

	for (const [index, block] of blocks.entries()) {
		const colors = getTokyoNightBlockColors(block.name);
		const previous =
			index === 0 ? undefined : getTokyoNightBlockColors(blocks[index - 1]?.name ?? "header");
		if (previous) line += ansiStyle("", { fg: previous.bg, bg: colors.bg });
		line += ansiStyle(formatTokyoNightBlockText(block), colors);
	}

	const lastBlock = blocks.at(-1);
	if (lastBlock) line += ansiFg(getTokyoNightBlockColors(lastBlock.name).bg, "");

	return line;
}

function groupTokyoNightBlocks(segments: RenderSegment[]): TokyoNightBlock[] {
	const blocksByName = new Map<TokyoNightBlockName, RenderSegment[]>();
	for (const segment of segments) {
		const blockSegments = blocksByName.get(segment.block) ?? [];
		blockSegments.push(segment);
		blocksByName.set(segment.block, blockSegments);
	}

	return TOKYO_NIGHT_BLOCK_ORDER.flatMap((name) => {
		const blockSegments = blocksByName.get(name);
		return blockSegments ? [{ name, segments: blockSegments }] : [];
	});
}

function formatTokyoNightBlockText(block: TokyoNightBlock): string {
	return ` ${block.segments.map(formatTokyoNightSegmentText).join(" ")}`;
}

function formatTokyoNightSegmentText(segment: RenderSegment): string {
	return segment.emphasis ? `\u001b[1m${segment.text}\u001b[22m` : segment.text;
}

function getTokyoNightBlockColors(block: TokyoNightBlockName): BlockColors {
	return TOKYO_NIGHT_COLORS[block];
}
