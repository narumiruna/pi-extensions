import { formatCount } from "../helpers.js";
import { defineModule } from "../types.js";

export const gitStatusModule = defineModule({
	name: "git_status",
	variables: [
		"symbol",
		"all_status",
		"ahead",
		"behind",
		"staged",
		"modified",
		"untracked",
		"conflicted",
	],
	defaults: {
		format: "[$all_status ]($style)",
		symbol: "",
		style: "fg:git_fg bg:git",
		disabled: false,
	},
	values: ({ runtime }) => {
		if (!runtime.gitBranch || !runtime.gitStatus) return undefined;
		const status = runtime.gitStatus;
		const values = {
			ahead: status.ahead > 0 ? `⇡${formatCount(status.ahead)}` : "",
			behind: status.behind > 0 ? `⇣${formatCount(status.behind)}` : "",
			staged: status.staged > 0 ? `+${formatCount(status.staged)}` : "",
			modified: status.modified > 0 ? `~${formatCount(status.modified)}` : "",
			untracked: status.untracked > 0 ? `?${formatCount(status.untracked)}` : "",
			conflicted: status.conflicted > 0 ? `!${formatCount(status.conflicted)}` : "",
		};
		const allStatus = Object.values(values).filter(Boolean).join(" ");
		return allStatus ? { ...values, all_status: allStatus } : undefined;
	},
});
