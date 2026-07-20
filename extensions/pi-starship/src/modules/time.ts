import { defineModule } from "./types.js";

export const timeModule = defineModule({
	name: "time",
	variables: ["symbol", "time"],
	defaults: {
		format: "[$symbol $time ]($style)",
		symbol: "🕒",
		style: "fg:meter_fg bg:meter",
		disabled: false,
	},
	values: ({ runtime }) => ({ time: formatTime(runtime.now) }),
});

function formatTime(now: Date): string {
	return `${now.getHours().toString().padStart(2, "0")}:${now
		.getMinutes()
		.toString()
		.padStart(2, "0")}`;
}
