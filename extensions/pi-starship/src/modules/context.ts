import { formatCount } from "./helpers.js";
import { defineModule } from "./types.js";

export const contextModule = defineModule({
	name: "context",
	variables: ["symbol", "percentage", "tokens", "window"],
	defaults: {
		format: "[$symbol ctx $percentage ]($style)",
		symbol: "🪟",
		style: "fg:runtime_fg bg:runtime",
		disabled: false,
	},
	values: ({ runtime }) => {
		const percent = runtime.contextUsage?.percent;
		return {
			percentage: percent === null || percent === undefined ? "?" : `${percent.toFixed(0)}%`,
			tokens: formatCount(runtime.contextUsage?.tokens ?? 0),
			window: formatCount(runtime.contextUsage?.contextWindow ?? 0),
		};
	},
});
