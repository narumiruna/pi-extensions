import type { SegmentPalette } from "../types.js";
import type { PowerlinePreset } from "./types.js";

export const TOKYO_NIGHT_PRESET: PowerlinePreset = {
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
