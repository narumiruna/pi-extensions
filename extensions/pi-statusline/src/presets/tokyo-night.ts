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
