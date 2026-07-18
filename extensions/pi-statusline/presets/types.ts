import type { ThemeColor } from "@earendil-works/pi-coding-agent";

export type SegmentName =
	| "brand"
	| "provider"
	| "model"
	| "thinking"
	| "cwd"
	| "branch"
	| "tools"
	| "context"
	| "tokens"
	| "cost"
	| "time"
	| "turn";

export type StatuslinePresetName = "classic" | "tokyo-night";
export type TokyoNightBlockName = "header" | "directory" | "git" | "runtime" | "meter";
export type PaletteName = "ocean" | "sunset" | "forest" | "candy" | "neon" | "mono";
export type Density = "compact" | "cozy";
export type SeparatorName = "dot" | "bar" | "powerline" | "round" | "none";

export interface StatuslineConfig {
	preset: StatuslinePresetName;
	palette: PaletteName;
	density: Density;
	separator: SeparatorName;
	showLabels: boolean;
	segments: SegmentName[];
	extensionStatusIcons: Record<string, string>;
}

export interface RenderSegment {
	name: SegmentName;
	text: string;
	color: ThemeColor;
	block: TokyoNightBlockName;
	emphasis?: boolean;
}
