import type { PowerlineBlockName } from "../types.js";
import type { PowerlinePreset } from "./types.js";

const BLOCK_NAMES: PowerlineBlockName[] = ["header", "directory", "git", "runtime", "meter"];

type PaletteRamp = readonly [string, string, string, string, string];

export function createRampPreset(backgrounds: PaletteRamp): PowerlinePreset {
	return {
		lead: backgrounds[0],
		blocks: Object.fromEntries(
			BLOCK_NAMES.map((block, index) => {
				const background = backgrounds[index];
				return [block, { fg: contrastColor(background), bg: background }];
			}),
		) as Record<PowerlineBlockName, { fg: string; bg: string }>,
		extensionSeparator: backgrounds[2],
	};
}

function contrastColor(hex: string): string {
	const background = relativeLuminance(hex);
	const dark = relativeLuminance("#090c0c");
	const light = relativeLuminance("#f0f0f0");
	return contrastRatio(background, dark) >= contrastRatio(background, light)
		? "#090c0c"
		: "#f0f0f0";
}

function contrastRatio(left: number, right: number): number {
	return (Math.max(left, right) + 0.05) / (Math.min(left, right) + 0.05);
}

function relativeLuminance(hex: string): number {
	const normalized = hex.slice(1);
	const channels = [0, 2, 4].map((offset) => {
		const value = Number.parseInt(normalized.slice(offset, offset + 2), 16) / 255;
		return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
	});
	return 0.2126 * (channels[0] ?? 0) + 0.7152 * (channels[1] ?? 0) + 0.0722 * (channels[2] ?? 0);
}
