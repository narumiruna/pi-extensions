import { formatCount } from "./helpers.js";
import { defineModule } from "./types.js";

export const cacheModule = defineModule({
	name: "cache",
	variables: ["symbol", "rate", "read", "write"],
	defaults: {
		format: "[$symbol (CH$rate )]($style)",
		symbol: "📦",
		style: "fg:runtime_fg bg:runtime",
		disabled: true,
	},
	values: ({ runtime }) => {
		const { cacheRead, cacheWrite, latestCacheHitRate } = runtime.tokenTotals;
		if (cacheRead === 0 && cacheWrite === 0) return undefined;
		const rate = latestCacheHitRate === undefined ? "" : `${latestCacheHitRate.toFixed(1)}%`;
		return {
			rate,
			read: cacheRead > 0 ? formatCount(cacheRead) : "",
			write: cacheWrite > 0 ? formatCount(cacheWrite) : "",
		};
	},
});
