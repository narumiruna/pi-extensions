import { defineModule } from "./types.js";

export const fillModule = defineModule({
	name: "fill",
	variables: ["symbol"],
	defaults: {
		format: "[$symbol]($style)",
		symbol: " ",
		style: "none",
		disabled: false,
	},
	layout: "fill",
	values: () => ({}),
});
