import { defineModule } from "../types.js";

export const gitMetricsModule = defineModule({
	name: "git_metrics",
	variables: ["symbol", "added", "deleted"],
	defaults: {
		format: "[(+$added)( -$deleted) ]($style)",
		symbol: "",
		style: "fg:git_fg bg:git",
		disabled: true,
	},
	values: ({ runtime }) => {
		const metrics = runtime.gitMetrics;
		if (!metrics || (metrics.added === 0 && metrics.deleted === 0)) return undefined;
		return {
			added: metrics.added > 0 ? metrics.added.toString() : "",
			deleted: metrics.deleted > 0 ? metrics.deleted.toString() : "",
		};
	},
});
