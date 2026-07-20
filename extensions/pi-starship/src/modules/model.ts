import { defineModule } from "./types.js";

export const modelModule = defineModule({
	name: "model",
	variables: ["symbol", "model"],
	defaults: {
		format: "[$symbol $model ]($style)",
		symbol: "🤖",
		style: "fg:header_fg bg:header",
		disabled: false,
	},
	values: ({ runtime }) => (runtime.model ? { model: shortenModel(runtime.model.id) } : undefined),
});

export function shortenModel(model: string): string {
	return model
		.replace(/^claude-/u, "")
		.replace(/^gpt-/u, "gpt ")
		.replace(/-20\d{6}$/u, "")
		.replace(/-latest$/u, "");
}
