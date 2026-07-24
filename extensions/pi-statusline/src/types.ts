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

export const PALETTE_PRESET_NAMES = [...PALETTE_NAMES, "custom"] as const;
export type PalettePreset = (typeof PALETTE_PRESET_NAMES)[number];

export const DENSITIES = ["compact", "cozy"] as const;
export type Density = (typeof DENSITIES)[number];

export const SEPARATOR_NAMES = ["none", "dot", "bar", "powerline", "round"] as const;
export type SeparatorName = (typeof SEPARATOR_NAMES)[number];

export type PowerlineBlockName = "header" | "directory" | "git" | "runtime" | "meter";

export interface SegmentTextConfig {
	prefix: string;
	suffix: string;
}

export interface SegmentPaletteColor {
	fg?: string;
	bg?: string;
}

export type SegmentPalette = Partial<Record<SegmentName, SegmentPaletteColor>>;

export interface StatuslineConfig {
	palettePreset: PalettePreset;
	palette: SegmentPalette;
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
	block: PowerlineBlockName;
	emphasis?: boolean;
}

export interface RenderLineBreak {
	name: typeof LINE_BREAK_SEGMENT_NAME;
}

export type RenderItem = RenderSegment | RenderLineBreak;
