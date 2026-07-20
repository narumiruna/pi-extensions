import { defineModule } from "./types.js";

export const activityModule = defineModule({
	name: "activity",
	variables: ["symbol", "state", "tool", "count", "text"],
	defaults: {
		format: "[ $text ]($style)",
		symbol: "⚙",
		style: "fg:runtime_fg bg:runtime",
		disabled: false,
	},
	values: ({ runtime, symbol }) => {
		const active = [...runtime.activeTools.entries()];
		if (active.length > 0) {
			const [tool = "tool", count = 1] = active[0] ?? [];
			const suffix = count > 1 ? `×${count}` : "";
			const more = active.length > 1 ? `+${active.length - 1}` : "";
			return {
				state: "active",
				tool,
				count: `${count}`,
				text: `${symbol} ${tool}${suffix}${more}`,
			};
		}
		if (runtime.isStreaming) {
			return { state: "thinking", tool: "", count: "0", text: `${symbol} thinking` };
		}
		if (runtime.lastCompletedTool) {
			return {
				state: "completed",
				tool: runtime.lastCompletedTool,
				count: "0",
				text: `${symbol} completed ${runtime.lastCompletedTool}`,
			};
		}
		return { state: "idle", tool: "", count: "0", text: `${symbol} idle` };
	},
});
