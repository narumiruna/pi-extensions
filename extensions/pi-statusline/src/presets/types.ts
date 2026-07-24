import type { PowerlineBlockName } from "../types.js";

export interface BlockColors {
	fg?: string;
	bg?: string;
}

export interface PowerlinePreset {
	lead?: string;
	blocks: Record<PowerlineBlockName, BlockColors>;
	extensionSeparator?: string;
}
