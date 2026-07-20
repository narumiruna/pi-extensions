import { defineModule } from "./types.js";

export const turnModule = defineModule({
	name: "turn",
	variables: ["symbol", "count"],
	defaults: {
		format: "[$symbol #$count ]($style)",
		symbol: "🔁",
		style: "fg:meter_fg bg:meter",
		disabled: false,
	},
	values: ({ runtime }) => ({ count: `${runtime.turnCount}` }),
});
