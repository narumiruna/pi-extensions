import { defineModule } from "../types.js";

export const gitBranchModule = defineModule({
	name: "git_branch",
	variables: ["symbol", "branch", "remote_name", "remote_branch", "pr"],
	defaults: {
		format: "[ $symbol $branch( $pr) ]($style)",
		symbol: "🌿",
		style: "fg:git_fg bg:git",
		disabled: false,
	},
	values: ({ runtime }) => {
		const branch = runtime.gitBranchDetails;
		const name = branch?.name ?? runtime.gitBranch;
		if (!name) return undefined;
		return {
			branch: name,
			remote_name: branch?.remoteName ?? "",
			remote_branch: branch?.remoteBranch ?? "",
			pr: prContextFromStatuses(runtime.extensionStatuses) ?? "",
		};
	},
});

export function prContextFromStatuses(statuses: ReadonlyMap<string, string>): string | undefined {
	const value = statuses.get("github-pr");
	if (!value) return undefined;
	const link = prLink(value);
	if (!link) return undefined;
	const state = compactPrState(value.replace(link, ""));
	return state ? `${link} · ${state}` : undefined;
}

function prLink(value: string): string | undefined {
	const open = value.indexOf("\x1b]8;;");
	if (open === -1) return undefined;
	const closeMarker = "\x1b]8;;\x07";
	const close = value.indexOf(closeMarker, open + 1);
	return close === -1 ? undefined : value.slice(open, close + closeMarker.length);
}

function compactPrState(value: string): string | undefined {
	if (/:\s*merged\s*$/u.test(value)) return "merged";
	if (/:\s*closed\s*$/u.test(value)) return "closed";
	if (/\bdraft\b/u.test(value)) return "draft";
	const failing = /\bchecks failing \((\d+)\)/u.exec(value);
	if (failing?.[1]) return `${failing[1]} failing`;
	if (/\bchanges requested\b/u.test(value)) return "changes requested";
	const pending = /\bchecks pending \((\d+)\)/u.exec(value);
	if (pending?.[1]) return `${pending[1]} pending`;
	if (/\bapproved\b/u.test(value)) return "approved";
	if (/\breview required\b/u.test(value)) return "review required";
	if (/\bchecks passing\b/u.test(value)) return "checks passing";
	if (/\bno checks\b/u.test(value)) return "no checks";
	return undefined;
}
