import { defineModule } from "./types.js";

export const costModule = defineModule({
	name: "cost",
	variables: ["symbol", "cost"],
	defaults: {
		format: "[ $symbol \\$$cost ]($style)",
		symbol: "💸",
		style: "fg:meter_fg bg:meter",
		disabled: false,
	},
	values: ({ runtime }) => ({ cost: formatCost(runtime.tokenTotals.cost) }),
});

function formatCost(value: number): string {
	return value.toFixed(value >= 1 ? 2 : 3);
}
