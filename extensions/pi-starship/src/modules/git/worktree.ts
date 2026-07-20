import { defineModule } from "../types.js";

export const gitWorktreeModule = defineModule({
	name: "git_worktree",
	variables: ["symbol", "name", "path"],
	defaults: {
		format: "[ $symbol $name ]($style)",
		symbol: "🌳",
		style: "fg:git_fg bg:git",
		disabled: false,
	},
	values: ({ runtime }) =>
		runtime.gitWorktree
			? { name: runtime.gitWorktree.name, path: runtime.gitWorktree.path }
			: undefined,
});
