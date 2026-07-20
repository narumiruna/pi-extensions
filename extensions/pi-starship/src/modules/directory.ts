import { basename } from "node:path";
import { defineModule } from "./types.js";

export const directoryModule = defineModule({
	name: "directory",
	variables: ["symbol", "path", "full_path"],
	defaults: {
		format: "[ $symbol $path ]($style)",
		symbol: "📁",
		style: "fg:directory_fg bg:directory",
		disabled: false,
	},
	values: ({ runtime }) => ({
		path: basename(runtime.cwd) || runtime.cwd,
		full_path: runtime.cwd,
	}),
});
