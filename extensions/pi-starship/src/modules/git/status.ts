import { formatCount } from "../helpers.js";
import { defineModule } from "../types.js";

export const gitStatusModule = defineModule({
	name: "git_status",
	variables: [
		"symbol",
		"all_status",
		"ahead_behind",
		"ahead",
		"behind",
		"up_to_date",
		"diverged",
		"conflicted",
		"stashed",
		"deleted",
		"renamed",
		"modified",
		"typechanged",
		"staged",
		"untracked",
		"worktree_added",
		"worktree_deleted",
		"worktree_modified",
		"worktree_typechanged",
		"index_added",
		"index_deleted",
		"index_modified",
		"index_typechanged",
	],
	defaults: {
		format: "[$all_status( $ahead_behind) ]($style)",
		symbol: "",
		style: "fg:git_fg bg:git",
		disabled: false,
	},
	values: ({ runtime }) => {
		if (!runtime.gitBranch || !runtime.gitStatus) return undefined;
		const status = runtime.gitStatus;
		const ahead = count("⇡", status.ahead);
		const behind = count("⇣", status.behind);
		const diverged =
			status.ahead > 0 && status.behind > 0
				? `⇕⇡${formatCount(status.ahead)}⇣${formatCount(status.behind)}`
				: "";
		const values = {
			ahead,
			behind,
			up_to_date: "",
			diverged,
			ahead_behind: diverged || ahead || behind,
			conflicted: count("=", status.conflicted),
			stashed: count("$", status.stashed),
			deleted: count("✘", status.deleted),
			renamed: count("»", status.renamed),
			modified: count("!", status.modified),
			typechanged: count("T", status.typechanged),
			staged: count("+", status.staged),
			untracked: count("?", status.untracked),
			worktree_added: count("A", status.worktreeAdded),
			worktree_deleted: count("D", status.worktreeDeleted),
			worktree_modified: count("M", status.worktreeModified),
			worktree_typechanged: count("T", status.worktreeTypechanged),
			index_added: count("A", status.indexAdded),
			index_deleted: count("D", status.indexDeleted),
			index_modified: count("M", status.indexModified),
			index_typechanged: count("T", status.indexTypechanged),
		};
		const allStatus = [
			values.conflicted,
			values.stashed,
			values.deleted,
			values.renamed,
			values.modified,
			values.typechanged,
			values.staged,
			values.untracked,
		]
			.filter(Boolean)
			.join(" ");
		return allStatus || values.ahead_behind ? { ...values, all_status: allStatus } : undefined;
	},
});

function count(symbol: string, value: number): string {
	return value > 0 ? `${symbol}${formatCount(value)}` : "";
}
