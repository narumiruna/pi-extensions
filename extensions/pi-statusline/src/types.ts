import type { ThemeColor } from "@earendil-works/pi-coding-agent";

export const SEGMENT_NAMES = [
	"brand",
	"provider",
	"model",
	"thinking",
	"cwd",
	"branch",
	"tools",
	"context",
	"tokens",
	"cost",
	"time",
	"turn",
] as const;
export type SegmentName = (typeof SEGMENT_NAMES)[number];

export const LINE_BREAK_SEGMENT_NAME = "line_break" as const;
export type ConfigSegmentName = SegmentName | typeof LINE_BREAK_SEGMENT_NAME;

export const PALETTE_NAMES = [
	"tokyo-night",
	"ocean",
	"sunset",
	"forest",
	"candy",
	"neon",
	"mono",
] as const;
export type PaletteName = (typeof PALETTE_NAMES)[number];

export const DENSITIES = ["compact", "cozy"] as const;
export type Density = (typeof DENSITIES)[number];

export const SEPARATOR_NAMES = ["none", "dot", "bar", "powerline", "round"] as const;
export type SeparatorName = (typeof SEPARATOR_NAMES)[number];

export type TokyoNightBlockName = "header" | "directory" | "git" | "runtime" | "meter";

export interface SegmentTextConfig {
	prefix: string;
	suffix: string;
}

export interface SegmentPaletteColor {
	fg: string;
	bg: string;
}

export type SegmentPalette = Record<SegmentName, SegmentPaletteColor>;
export type StatuslinePalette = PaletteName | SegmentPalette;

export const TOKYO_NIGHT_SEGMENT_PALETTE: SegmentPalette = {
	brand: { fg: "#090c0c", bg: "#a3aed2" },
	provider: { fg: "#090c0c", bg: "#a3aed2" },
	model: { fg: "#090c0c", bg: "#a3aed2" },
	thinking: { fg: "#090c0c", bg: "#a3aed2" },
	cwd: { fg: "#e3e5e5", bg: "#769ff0" },
	branch: { fg: "#769ff0", bg: "#394260" },
	tools: { fg: "#769ff0", bg: "#212736" },
	context: { fg: "#769ff0", bg: "#212736" },
	tokens: { fg: "#769ff0", bg: "#212736" },
	cost: { fg: "#a0a9cb", bg: "#1d2230" },
	time: { fg: "#a0a9cb", bg: "#1d2230" },
	turn: { fg: "#a0a9cb", bg: "#1d2230" },
};

export interface StatuslineConfig {
	palette: StatuslinePalette;
	density: Density;
	separator: SeparatorName;
	segments: ConfigSegmentName[];
	segmentText: Record<SegmentName, SegmentTextConfig>;
	extensionStatusIcons: Record<string, string>;
}

export interface RenderSegment {
	name: SegmentName;
	text: string;
	color: ThemeColor;
	block: TokyoNightBlockName;
	emphasis?: boolean;
}

export interface RenderLineBreak {
	name: typeof LINE_BREAK_SEGMENT_NAME;
}

export type RenderItem = RenderSegment | RenderLineBreak;
