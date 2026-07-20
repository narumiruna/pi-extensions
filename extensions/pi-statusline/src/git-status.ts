import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const GIT_STATUS_TIMEOUT_MS = 3_000;

export interface GitStatusSummary {
	ahead: number;
	behind: number;
	staged: number;
	modified: number;
	untracked: number;
	conflicts: number;
}

export async function readGitStatus(
	pi: ExtensionAPI,
	cwd: string,
): Promise<GitStatusSummary | undefined> {
	const result = await pi.exec(
		"git",
		["--no-optional-locks", "status", "--porcelain=v1", "--branch", "--untracked-files=normal"],
		{ cwd, timeout: GIT_STATUS_TIMEOUT_MS },
	);
	if (result.code !== 0 || result.killed) return undefined;
	return parseGitStatusPorcelain(result.stdout);
}

export function parseGitStatusPorcelain(output: string): GitStatusSummary {
	const summary: GitStatusSummary = {
		ahead: 0,
		behind: 0,
		staged: 0,
		modified: 0,
		untracked: 0,
		conflicts: 0,
	};
	for (const line of output.split(/\r?\n/)) {
		if (!line) continue;
		if (line.startsWith("## ")) {
			const ahead = line.match(/\bahead (\d+)/u);
			const behind = line.match(/\bbehind (\d+)/u);
			summary.ahead = ahead ? Number(ahead[1]) : 0;
			summary.behind = behind ? Number(behind[1]) : 0;
			continue;
		}
		const indexStatus = line[0] ?? " ";
		const worktreeStatus = line[1] ?? " ";
		if (indexStatus === "?" && worktreeStatus === "?") {
			summary.untracked += 1;
			continue;
		}
		if (isConflictStatus(indexStatus, worktreeStatus)) {
			summary.conflicts += 1;
			continue;
		}
		if (isChangedStatus(indexStatus)) summary.staged += 1;
		if (isChangedStatus(worktreeStatus)) summary.modified += 1;
	}
	return summary;
}

function isConflictStatus(indexStatus: string, worktreeStatus: string): boolean {
	return (
		(indexStatus === "D" && worktreeStatus === "D") ||
		(indexStatus === "A" && worktreeStatus === "A") ||
		indexStatus === "U" ||
		worktreeStatus === "U"
	);
}

function isChangedStatus(status: string): boolean {
	return status !== " " && status !== "?" && status !== "!";
}

export function formatGitStatusSummary(summary: GitStatusSummary | undefined): string {
	if (!summary) return "";
	const tokens = [
		["⇡", summary.ahead],
		["⇣", summary.behind],
		["+", summary.staged],
		["~", summary.modified],
		["?", summary.untracked],
		["!", summary.conflicts],
	] as const;
	return tokens
		.filter(([, count]) => count > 0)
		.map(([prefix, count]) => `${prefix}${formatCount(count)}`)
		.join(" ");
}

export function formatGitBranchValue(
	branch: string | null,
	status: GitStatusSummary | undefined,
	pr?: string,
): string {
	if (!branch) return "no-git";
	const suffixes = [formatGitStatusSummary(status), pr ? `(${pr})` : ""].filter(Boolean);
	return suffixes.length > 0 ? `${branch} ${suffixes.join(" ")}` : branch;
}

export function formatGitBranchText(
	branch: string | null,
	status: GitStatusSummary | undefined,
	pr?: string,
): string {
	return `🌿 ${formatGitBranchValue(branch, status, pr)}`;
}

export function gitStatusSummaryEqual(
	left: GitStatusSummary | undefined,
	right: GitStatusSummary | undefined,
): boolean {
	if (!left || !right) return left === right;
	return (
		left.ahead === right.ahead &&
		left.behind === right.behind &&
		left.staged === right.staged &&
		left.modified === right.modified &&
		left.untracked === right.untracked &&
		left.conflicts === right.conflicts
	);
}

function formatCount(value: number): string {
	return Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(value);
}
