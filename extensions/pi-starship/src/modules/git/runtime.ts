import { basename, isAbsolute, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { GitStatusSnapshot, GitWorktreeSnapshot } from "../types.js";

const GIT_TIMEOUT_MS = 3_000;

export async function readGitStatus(
	pi: ExtensionAPI,
	cwd: string,
): Promise<GitStatusSnapshot | undefined> {
	const result = await pi.exec(
		"git",
		["--no-optional-locks", "status", "--porcelain=v1", "--branch", "--untracked-files=normal"],
		{ cwd, timeout: GIT_TIMEOUT_MS },
	);
	if (result.code !== 0 || result.killed) return undefined;
	return parseGitStatusPorcelain(result.stdout);
}

export async function readGitWorktree(
	pi: ExtensionAPI,
	cwd: string,
): Promise<GitWorktreeSnapshot | undefined> {
	const result = await pi.exec(
		"git",
		["rev-parse", "--path-format=absolute", "--show-toplevel", "--git-common-dir", "--git-dir"],
		{ cwd, timeout: GIT_TIMEOUT_MS },
	);
	if (result.code !== 0 || result.killed) return undefined;
	return parseGitWorktree(result.stdout);
}

export function parseGitWorktree(output: string): GitWorktreeSnapshot | undefined {
	const lines = output.trimEnd().split(/\r?\n/u);
	if (lines.length !== 3) return undefined;
	const [path, commonDir, gitDir] = lines;
	if (!path || !commonDir || !gitDir) return undefined;
	if (![path, commonDir, gitDir].every(isAbsolute)) return undefined;
	if (samePath(commonDir, gitDir)) return undefined;
	return { name: basename(path) || path, path };
}

export function parseGitStatusPorcelain(output: string): GitStatusSnapshot {
	const summary: GitStatusSnapshot = {
		ahead: 0,
		behind: 0,
		staged: 0,
		modified: 0,
		untracked: 0,
		conflicted: 0,
	};
	for (const line of output.split(/\r?\n/u)) {
		if (!line) continue;
		if (line.startsWith("## ")) {
			const ahead = /\bahead (\d+)/u.exec(line);
			const behind = /\bbehind (\d+)/u.exec(line);
			summary.ahead = ahead?.[1] ? Number(ahead[1]) : 0;
			summary.behind = behind?.[1] ? Number(behind[1]) : 0;
			continue;
		}
		const indexStatus = line[0] ?? " ";
		const worktreeStatus = line[1] ?? " ";
		if (indexStatus === "?" && worktreeStatus === "?") {
			summary.untracked += 1;
			continue;
		}
		if (isConflict(indexStatus, worktreeStatus)) {
			summary.conflicted += 1;
			continue;
		}
		if (isChanged(indexStatus)) summary.staged += 1;
		if (isChanged(worktreeStatus)) summary.modified += 1;
	}
	return summary;
}

function samePath(left: string, right: string): boolean {
	const normalizedLeft = resolve(left);
	const normalizedRight = resolve(right);
	return process.platform === "win32"
		? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
		: normalizedLeft === normalizedRight;
}

function isConflict(indexStatus: string, worktreeStatus: string): boolean {
	return (
		(indexStatus === "D" && worktreeStatus === "D") ||
		(indexStatus === "A" && worktreeStatus === "A") ||
		indexStatus === "U" ||
		worktreeStatus === "U"
	);
}

function isChanged(status: string): boolean {
	return status !== " " && status !== "?" && status !== "!";
}

export function gitStatusEqual(
	left: GitStatusSnapshot | undefined,
	right: GitStatusSnapshot | undefined,
): boolean {
	if (!left || !right) return left === right;
	return (
		left.ahead === right.ahead &&
		left.behind === right.behind &&
		left.staged === right.staged &&
		left.modified === right.modified &&
		left.untracked === right.untracked &&
		left.conflicted === right.conflicted
	);
}
