import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import type { ExecResult, ExtensionAPI } from "@earendil-works/pi-coding-agent";

const GIT_TIMEOUT_MS = 15_000;
const GIT_MUTATION_TIMEOUT_MS = 60_000;
const LOCAL_BRANCH_PREFIX = "refs/heads/";

export interface WorktreeRecord {
	path: string;
	head?: string;
	branchRef?: string;
	branch?: string;
	isMain: boolean;
	bare: boolean;
	detached: boolean;
	lockedReason?: string;
	prunableReason?: string;
}

export interface AddArguments {
	path: string;
	branch: string;
	startOid?: string;
}

export interface AdministrativePruneCandidate {
	id: string;
	administrativePath: string;
	head?: string;
	branchRef?: string;
	indexDirty: boolean;
}

export interface GitClient {
	exec(command: string, args: string[], options?: GitExecOptions): Promise<ExecResult>;
}

interface GitExecOptions {
	cwd?: string;
	signal?: AbortSignal;
	timeout?: number;
}

export class GitWorktreeError extends Error {
	readonly args?: readonly string[];

	constructor(message: string, args?: readonly string[]) {
		super(message);
		this.name = "GitWorktreeError";
		this.args = args;
	}
}

export function parseWorktreePorcelain(output: string): WorktreeRecord[] {
	const records: WorktreeRecord[] = [];
	let current: Omit<WorktreeRecord, "isMain"> | undefined;

	const finish = () => {
		if (!current) return;
		records.push({ ...current, isMain: records.length === 0 });
		current = undefined;
	};

	for (const field of output.split("\0")) {
		if (field === "") {
			finish();
			continue;
		}
		const separator = field.indexOf(" ");
		const key = separator < 0 ? field : field.slice(0, separator);
		const value = separator < 0 ? "" : field.slice(separator + 1);

		if (key === "worktree") {
			finish();
			if (!value) throw new GitWorktreeError("Worktree porcelain record is missing path.");
			current = { path: value, bare: false, detached: false };
			continue;
		}
		if (!current) {
			throw new GitWorktreeError(
				`Worktree porcelain field ${JSON.stringify(key)} appears before worktree.`,
			);
		}

		switch (key) {
			case "HEAD":
				current.head = value;
				break;
			case "branch":
				current.branchRef = value;
				current.branch = value.startsWith(LOCAL_BRANCH_PREFIX)
					? value.slice(LOCAL_BRANCH_PREFIX.length)
					: undefined;
				break;
			case "bare":
				current.bare = true;
				break;
			case "detached":
				current.detached = true;
				break;
			case "locked":
				current.lockedReason = value;
				break;
			case "prunable":
				current.prunableReason = value;
				break;
		}
	}
	finish();
	return records;
}

export function worktreeForBranch(
	records: readonly WorktreeRecord[],
	branch: string,
): WorktreeRecord | undefined {
	const branchRef = `${LOCAL_BRANCH_PREFIX}${branch}`;
	return records.find((record) => record.branchRef === branchRef);
}

export function defaultWorktreePath(mainWorktreePath: string, branch: string): string {
	return resolve(
		dirname(mainWorktreePath),
		`${basename(mainWorktreePath)}-${branch.replaceAll("/", "-")}`,
	);
}

export function buildAddArguments(input: AddArguments): string[] {
	return input.startOid
		? ["worktree", "add", "-b", input.branch, input.path, input.startOid]
		: ["worktree", "add", input.path, input.branch];
}

export function pathIdentity(path: string): string {
	const absolute = resolve(path);
	if (!existsSync(absolute)) return absolute;
	try {
		return realpathSync.native(absolute);
	} catch {
		return absolute;
	}
}

export function pathEntryExists(path: string): boolean {
	try {
		lstatSync(path);
		return true;
	} catch (error) {
		if (isNodeError(error) && error.code === "ENOENT") return false;
		throw new GitWorktreeError(`Cannot inspect filesystem path ${path}: ${formatError(error)}`);
	}
}

export function unresolvableSymlinkAncestor(path: string): string | undefined {
	let current = dirname(resolve(path));
	while (true) {
		try {
			const stat = lstatSync(current);
			if (!stat.isSymbolicLink()) return undefined;
			try {
				realpathSync.native(current);
				return undefined;
			} catch (error) {
				if (isNodeError(error) && (error.code === "ENOENT" || error.code === "ELOOP")) {
					return current;
				}
				throw new GitWorktreeError(
					`Cannot resolve filesystem ancestor ${current}: ${formatError(error)}`,
				);
			}
		} catch (error) {
			if (!isNodeError(error) || error.code !== "ENOENT") {
				if (error instanceof GitWorktreeError) throw error;
				throw new GitWorktreeError(
					`Cannot inspect filesystem ancestor ${current}: ${formatError(error)}`,
				);
			}
			const parent = dirname(current);
			if (parent === current) return undefined;
			current = parent;
		}
	}
}

export function pathsEqual(left: string, right: string): boolean {
	return pathIdentity(left) === pathIdentity(right);
}

export function sameWorktreeIdentity(left: WorktreeRecord, right: WorktreeRecord): boolean {
	return (
		pathsEqual(left.path, right.path) &&
		left.head === right.head &&
		left.branchRef === right.branchRef &&
		left.detached === right.detached &&
		left.isMain === right.isMain &&
		left.bare === right.bare
	);
}

export async function listWorktrees(
	pi: Pick<ExtensionAPI, "exec">,
	cwd: string,
	signal?: AbortSignal,
): Promise<WorktreeRecord[]> {
	const result = await runGit(pi, ["worktree", "list", "--porcelain", "-z"], cwd, signal);
	return parseWorktreePorcelain(result.stdout);
}

export async function currentWorktreePath(
	pi: Pick<ExtensionAPI, "exec">,
	cwd: string,
	signal?: AbortSignal,
): Promise<string> {
	const result = await runGit(pi, ["rev-parse", "--show-toplevel"], cwd, signal);
	const path = removeLineEnding(result.stdout);
	if (!path) throw new GitWorktreeError("Git did not return the current worktree path.");
	return pathIdentity(path);
}

export async function symbolicBranch(
	pi: Pick<ExtensionAPI, "exec">,
	cwd: string,
	signal?: AbortSignal,
): Promise<string | undefined> {
	const result = await runGitAllowFailure(
		pi,
		["symbolic-ref", "--quiet", "--short", "HEAD"],
		cwd,
		signal,
	);
	if (result.killed) throw killedError(["symbolic-ref", "--quiet", "--short", "HEAD"]);
	if (result.code !== 0) return undefined;
	return result.stdout.trim() || undefined;
}

export async function validateBranch(
	pi: Pick<ExtensionAPI, "exec">,
	cwd: string,
	branch: string,
	signal?: AbortSignal,
): Promise<string> {
	const result = await runGit(pi, ["check-ref-format", "--branch", branch], cwd, signal);
	const normalized = result.stdout.trim();
	if (!normalized) throw new GitWorktreeError("Git returned an empty branch name.");
	return normalized;
}

export async function localBranchExists(
	pi: Pick<ExtensionAPI, "exec">,
	cwd: string,
	branch: string,
	signal?: AbortSignal,
): Promise<boolean> {
	const result = await runGitAllowFailure(
		pi,
		["show-ref", "--verify", "--quiet", `${LOCAL_BRANCH_PREFIX}${branch}`],
		cwd,
		signal,
	);
	if (result.killed) throw killedError(["show-ref", "--verify", "--quiet"]);
	if (result.code === 0) return true;
	if (result.code === 1) return false;
	throw gitFailure(["show-ref", "--verify", "--quiet"], result);
}

export async function resolveCommit(
	pi: Pick<ExtensionAPI, "exec">,
	cwd: string,
	startPoint: string,
	signal?: AbortSignal,
): Promise<string> {
	const result = await runGit(
		pi,
		["rev-parse", "--verify", "--end-of-options", `${startPoint}^{commit}`],
		cwd,
		signal,
	);
	const oid = result.stdout.trim();
	if (!/^[0-9a-fA-F]{40,64}$/u.test(oid)) {
		throw new GitWorktreeError(`Git returned an invalid commit object for ${startPoint}.`);
	}
	return oid;
}

export async function addWorktree(
	pi: Pick<ExtensionAPI, "exec">,
	cwd: string,
	input: AddArguments,
	signal?: AbortSignal,
): Promise<void> {
	await runGit(pi, buildAddArguments(input), cwd, signal, GIT_MUTATION_TIMEOUT_MS);
}

export async function removeWorktree(
	pi: Pick<ExtensionAPI, "exec">,
	cwd: string,
	path: string,
	signal?: AbortSignal,
): Promise<void> {
	await runGit(pi, ["worktree", "remove", path], cwd, signal, GIT_MUTATION_TIMEOUT_MS);
}

export async function worktreeInventory(
	pi: Pick<ExtensionAPI, "exec">,
	path: string,
	signal?: AbortSignal,
): Promise<string[]> {
	const statusArgs = [
		"status",
		"--porcelain=v1",
		"--untracked-files=all",
		"--ignored=matching",
		"--ignore-submodules=none",
	];
	const status = await runGit(pi, statusArgs, path, signal);
	const indexFlags = await runGit(pi, ["ls-files", "-v", "-z"], path, signal);
	const submoduleStatus = await runGit(pi, ["submodule", "status", "--recursive"], path, signal);
	const initializedSubmodules = nonEmptyLines(submoduleStatus.stdout)
		.filter((line) => !line.startsWith("-"))
		.map((line) => `initialized submodule: ${line.slice(1).trimStart()}`);
	const submodules = await runGit(
		pi,
		[
			"submodule",
			"foreach",
			"--recursive",
			"--quiet",
			"git status --porcelain=v1 --untracked-files=all --ignored=matching --ignore-submodules=none",
		],
		path,
		signal,
	);
	return [
		...nonEmptyLines(status.stdout),
		...indexFlagInventory(indexFlags.stdout),
		...initializedSubmodules,
		...nonEmptyLines(submodules.stdout),
	];
}

export async function worktreeAdministrativeDirectory(
	pi: Pick<ExtensionAPI, "exec">,
	cwd: string,
	signal?: AbortSignal,
): Promise<string> {
	const result = await runGit(
		pi,
		["rev-parse", "--path-format=absolute", "--git-dir"],
		cwd,
		signal,
	);
	const value = removeLineEnding(result.stdout);
	if (!value) throw new GitWorktreeError("Git did not return its worktree administrative path.");
	return resolve(cwd, value);
}

export async function administrativeHistoryOids(
	pi: Pick<ExtensionAPI, "exec">,
	cwd: string,
	administrativePath: string,
	signal?: AbortSignal,
): Promise<string[]> {
	const gitDirArgument = `--git-dir=${administrativePath}`;
	const values = readAdministrativeReflogOids(resolve(administrativePath, "logs"));

	const refs = await runGit(
		pi,
		[gitDirArgument, "for-each-ref", "--format=%(objectname)", "refs/worktree", "refs/bisect"],
		cwd,
		signal,
	);
	values.push(...splitAdministrativeOids(refs.stdout, "per-worktree refs"));

	for (const name of [
		"ORIG_HEAD",
		"MERGE_HEAD",
		"REBASE_HEAD",
		"CHERRY_PICK_HEAD",
		"REVERT_HEAD",
		"BISECT_HEAD",
	]) {
		const contents = readAdministrativeFile(administrativePath, name);
		if (contents === undefined) continue;
		values.push(...splitAdministrativeOids(contents, name));
	}
	const fetchHead = readAdministrativeFile(administrativePath, "FETCH_HEAD");
	if (fetchHead !== undefined) {
		values.push(...splitFetchHeadOids(fetchHead));
	}
	return [...new Set(values)];
}

export async function administrativePruneCandidates(
	pi: Pick<ExtensionAPI, "exec">,
	cwd: string,
	signal?: AbortSignal,
): Promise<AdministrativePruneCandidate[]> {
	const commonResult = await runGit(
		pi,
		["rev-parse", "--path-format=absolute", "--git-common-dir"],
		cwd,
		signal,
	);
	const commonValue = removeLineEnding(commonResult.stdout);
	if (!commonValue) throw new GitWorktreeError("Git did not return its common directory.");
	const commonDirectory = resolve(cwd, commonValue);
	const administrativeRoot = resolve(commonDirectory, "worktrees");
	if (!existsSync(administrativeRoot)) return [];

	const candidates: AdministrativePruneCandidate[] = [];
	for (const entry of readdirSync(administrativeRoot, { withFileTypes: true })) {
		const administrativePath = resolve(administrativeRoot, entry.name);
		if (!entry.isDirectory() || entry.isSymbolicLink()) {
			throw new GitWorktreeError(
				`Unexpected Git worktree administrative entry: ${administrativePath}.`,
			);
		}
		if (existsSync(resolve(administrativePath, "locked"))) continue;

		const gitdirPath = resolve(administrativePath, "gitdir");
		let registeredGitFile: string | undefined;
		try {
			registeredGitFile = removeLineEnding(readFileSync(gitdirPath, "utf8"));
		} catch (error) {
			if (!isNodeError(error) || error.code !== "ENOENT") throw error;
		}
		if (registeredGitFile) {
			const targetGitFile = resolve(administrativePath, registeredGitFile);
			if (existsSync(targetGitFile)) continue;
		}

		const headPath = resolve(administrativePath, "HEAD");
		let headValue: string;
		try {
			if (!lstatSync(headPath).isFile()) {
				throw new GitWorktreeError(`Git worktree administrative HEAD is not a file: ${headPath}.`);
			}
			headValue = removeLineEnding(readFileSync(headPath, "utf8"));
		} catch (error) {
			if (error instanceof GitWorktreeError) throw error;
			throw new GitWorktreeError(
				`Cannot inspect Git worktree administrative HEAD ${headPath}: ${formatError(error)}`,
			);
		}
		const indexDirty = await administrativeIndexIsDirty(pi, cwd, administrativePath, signal);
		if (headValue.startsWith("ref: ")) {
			const branchRef = headValue.slice("ref: ".length);
			if (!branchRef) {
				throw new GitWorktreeError(
					`Git worktree administrative HEAD has an empty ref: ${headPath}.`,
				);
			}
			candidates.push({
				id: entry.name,
				administrativePath,
				branchRef,
				indexDirty,
			});
			continue;
		}
		if (!/^[0-9a-fA-F]{40,64}$/u.test(headValue)) {
			throw new GitWorktreeError(`Git worktree administrative HEAD is malformed: ${headPath}.`);
		}
		candidates.push({
			id: entry.name,
			administrativePath,
			head: headValue,
			indexDirty,
		});
	}
	return candidates;
}

async function administrativeIndexIsDirty(
	pi: Pick<ExtensionAPI, "exec">,
	cwd: string,
	administrativePath: string,
	signal?: AbortSignal,
): Promise<boolean> {
	const args = [
		`--git-dir=${administrativePath}`,
		"diff",
		"--cached",
		"--quiet",
		"--no-ext-diff",
		"--no-textconv",
		"--ignore-submodules=none",
		"--",
	];
	const result = await runGitAllowFailure(pi, args, cwd, signal);
	if (result.killed) throw killedError(args);
	if (result.code === 0) return false;
	if (result.code === 1) return true;
	throw gitFailure(args, result);
}

export async function durableRefExists(
	pi: Pick<ExtensionAPI, "exec">,
	cwd: string,
	ref: string,
	signal?: AbortSignal,
): Promise<boolean> {
	if (!ref.startsWith("refs/") || ref.includes("\0")) {
		throw new GitWorktreeError("Git worktree administrative HEAD contains an invalid ref.");
	}
	const result = await runGitAllowFailure(
		pi,
		["show-ref", "--verify", "--quiet", ref],
		cwd,
		signal,
	);
	if (result.killed) throw killedError(["show-ref", "--verify", "--quiet"]);
	if (result.code === 0) return true;
	if (result.code === 1) return false;
	throw gitFailure(["show-ref", "--verify", "--quiet"], result);
}

export async function durableRefsContaining(
	pi: Pick<ExtensionAPI, "exec">,
	cwd: string,
	head: string,
	signal?: AbortSignal,
): Promise<string[]> {
	if (!/^[0-9a-fA-F]{40,64}$/u.test(head)) {
		throw new GitWorktreeError("Detached worktree has an invalid HEAD object.");
	}
	const result = await runGit(
		pi,
		[
			"for-each-ref",
			"--format=%(refname)",
			`--contains=${head}`,
			"refs/heads",
			"refs/tags",
			"refs/remotes",
		],
		cwd,
		signal,
	);
	return nonEmptyLines(result.stdout);
}

export async function prunePreview(
	pi: Pick<ExtensionAPI, "exec">,
	cwd: string,
	signal?: AbortSignal,
): Promise<string> {
	const result = await runGit(pi, ["worktree", "prune", "--dry-run", "--verbose"], cwd, signal);
	return combineOutput(result);
}

export async function pruneWorktrees(
	pi: Pick<ExtensionAPI, "exec">,
	cwd: string,
	signal?: AbortSignal,
): Promise<string> {
	const result = await runGit(
		pi,
		["worktree", "prune", "--verbose"],
		cwd,
		signal,
		GIT_MUTATION_TIMEOUT_MS,
	);
	return combineOutput(result);
}

export function formatWorktree(record: WorktreeRecord, currentPath?: string): string {
	const labels = [
		currentPath && pathsEqual(record.path, currentPath) ? "current" : undefined,
		record.isMain ? "main" : undefined,
		record.bare ? "bare" : undefined,
		record.detached ? "detached" : record.branch,
		record.lockedReason !== undefined
			? `locked${record.lockedReason ? `: ${record.lockedReason}` : ""}`
			: undefined,
		record.prunableReason !== undefined
			? `prunable${record.prunableReason ? `: ${record.prunableReason}` : ""}`
			: undefined,
	].filter((label): label is string => Boolean(label));
	const head = record.head ? record.head.slice(0, 8) : "no HEAD";
	return stripTerminalControls(`${record.path}  [${labels.join(", ") || "unknown"}]  ${head}`);
}

export function stripTerminalControls(value: string): string {
	return [...value]
		.filter((character) => {
			const code = character.codePointAt(0) ?? 0;
			return code > 0x1f && (code < 0x7f || code > 0x9f);
		})
		.join("");
}

async function runGit(
	pi: Pick<ExtensionAPI, "exec">,
	args: string[],
	cwd: string,
	signal?: AbortSignal,
	timeout = GIT_TIMEOUT_MS,
): Promise<ExecResult> {
	const result = await runGitAllowFailure(pi, args, cwd, signal, timeout);
	if (result.killed) throw killedError(args);
	if (result.code !== 0) throw gitFailure(args, result);
	return result;
}

async function runGitAllowFailure(
	pi: Pick<ExtensionAPI, "exec">,
	args: string[],
	cwd: string,
	signal?: AbortSignal,
	timeout = GIT_TIMEOUT_MS,
): Promise<ExecResult> {
	try {
		return await pi.exec("git", args, { cwd, signal, timeout });
	} catch (error) {
		const message = formatError(error);
		if (/\bENOENT\b|not found/i.test(message)) {
			throw new GitWorktreeError("Git executable was not found. Install Git and retry.", args);
		}
		throw new GitWorktreeError(
			`Could not start git ${args.slice(0, 2).join(" ")}: ${message}`,
			args,
		);
	}
}

function gitFailure(args: string[], result: ExecResult): GitWorktreeError {
	const detail = stripTerminalControls(
		[result.stderr.trim(), result.stdout.trim()].filter(Boolean).join("\n"),
	);
	const hint = /not a git repository/i.test(detail)
		? "The current Pi workspace is not inside a Git repository."
		: detail || `Git exited with code ${result.code}.`;
	return new GitWorktreeError(`git ${args.slice(0, 2).join(" ")} failed: ${hint}`, args);
}

function killedError(args: string[]): GitWorktreeError {
	return new GitWorktreeError(
		`git ${args.slice(0, 2).join(" ")} timed out or was cancelled.`,
		args,
	);
}

function nonEmptyLines(value: string): string[] {
	return value.split(/\r?\n/u).filter((line) => line.length > 0);
}

function indexFlagInventory(value: string): string[] {
	const inventory: string[] = [];
	for (const entry of value.split("\0")) {
		if (!entry) continue;
		if (entry.length < 3 || entry[1] !== " ") {
			throw new GitWorktreeError("Git returned malformed ls-files index-flag output.");
		}
		const tag = entry[0] ?? "";
		const flags = [
			tag.toUpperCase() === "S" ? "skip-worktree" : undefined,
			/[a-z]/u.test(tag) ? "assume-unchanged" : undefined,
		].filter((flag): flag is string => flag !== undefined);
		if (flags.length > 0) inventory.push(`index flag ${flags.join("+")}: ${entry.slice(2)}`);
	}
	return inventory;
}

function combineOutput(result: ExecResult): string {
	return [result.stdout.trimEnd(), result.stderr.trimEnd()].filter(Boolean).join("\n");
}

function removeLineEnding(value: string): string {
	if (value.endsWith("\r\n")) return value.slice(0, -2);
	if (value.endsWith("\n")) return value.slice(0, -1);
	return value;
}

function splitAdministrativeOids(value: string, source: string): string[] {
	const normalized = value.endsWith("\n") ? value.slice(0, -1) : value;
	if (!normalized) return [];
	const values = normalized
		.split("\n")
		.map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line));
	if (values.some((oid) => !/^[0-9a-fA-F]{40,64}$/u.test(oid))) {
		throw new GitWorktreeError(`Git returned malformed object IDs for ${source}.`);
	}
	return values;
}

function splitFetchHeadOids(value: string): string[] {
	const normalized = value.endsWith("\n") ? value.slice(0, -1) : value;
	if (!normalized) return [];
	return normalized.split("\n").map((line) => {
		const match = /^([0-9a-fA-F]{40,64})\t/u.exec(line);
		if (!match?.[1]) {
			throw new GitWorktreeError("Git worktree administrative FETCH_HEAD is malformed.");
		}
		return match[1];
	});
}

function readAdministrativeFile(administrativePath: string, name: string): string | undefined {
	const path = resolve(administrativePath, name);
	let stat: ReturnType<typeof lstatSync>;
	try {
		stat = lstatSync(path);
	} catch (error) {
		if (isNodeError(error) && error.code === "ENOENT") return undefined;
		throw new GitWorktreeError(
			`Cannot inspect Git worktree administrative ${name}: ${formatError(error)}`,
		);
	}
	if (stat.isSymbolicLink() || !stat.isFile()) {
		throw new GitWorktreeError(
			`Git worktree administrative ${name} must be a regular file: ${path}.`,
		);
	}
	try {
		return readFileSync(path, "utf8");
	} catch (error) {
		throw new GitWorktreeError(
			`Cannot inspect Git worktree administrative ${name}: ${formatError(error)}`,
		);
	}
}

function readAdministrativeReflogOids(logPath: string): string[] {
	if (!existsSync(logPath)) return [];
	let stat: ReturnType<typeof lstatSync>;
	try {
		stat = lstatSync(logPath);
	} catch (error) {
		throw new GitWorktreeError(`Cannot inspect Git reflog path ${logPath}: ${formatError(error)}`);
	}
	if (stat.isSymbolicLink()) {
		throw new GitWorktreeError(`Git reflog path must not be a symbolic link: ${logPath}.`);
	}
	if (stat.isDirectory()) {
		const values: string[] = [];
		for (const entry of readdirSync(logPath, { withFileTypes: true })) {
			values.push(...readAdministrativeReflogOids(resolve(logPath, entry.name)));
		}
		return values;
	}
	if (!stat.isFile()) {
		throw new GitWorktreeError(`Unexpected Git reflog entry type: ${logPath}.`);
	}

	let contents: string;
	try {
		contents = readFileSync(logPath, "utf8");
	} catch (error) {
		throw new GitWorktreeError(`Cannot read Git reflog ${logPath}: ${formatError(error)}`);
	}
	const normalized = contents.endsWith("\n") ? contents.slice(0, -1) : contents;
	if (!normalized) return [];
	const values: string[] = [];
	for (const line of normalized.split("\n")) {
		const match = /^([0-9a-fA-F]{40,64}) ([0-9a-fA-F]{40,64}) /u.exec(line);
		if (!match?.[1] || !match[2] || match[1].length !== match[2].length) {
			throw new GitWorktreeError(`Git worktree reflog is malformed: ${logPath}.`);
		}
		for (const oid of [match[1], match[2]]) {
			if (!/^0+$/u.test(oid)) values.push(oid);
		}
	}
	return values;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
	return error instanceof Error && "code" in error;
}

function formatError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
