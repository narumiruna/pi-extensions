import { defineModule } from "../types.js";

export const gitStateModule = defineModule({
	name: "git_state",
	variables: ["symbol", "state", "progress_current", "progress_total"],
	defaults: {
		format: "[ ($state( $progress_current/$progress_total)) ]($style)",
		symbol: "",
		style: "bold yellow bg:git",
		disabled: false,
	},
	values: ({ runtime }) => {
		const state = runtime.gitState;
		if (!state) return undefined;
		return {
			state: state.state,
			progress_current: state.progressCurrent?.toString() ?? "",
			progress_total: state.progressTotal?.toString() ?? "",
		};
	},
});
