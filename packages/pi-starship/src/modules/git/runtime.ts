import { existsSync, readFileSync } from "node:fs";
import { basename, isAbsolute, join, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { execWorkspaceCommand } from "../../runtime/command.js";
import { MAX_COMMAND_OUTPUT_BYTES } from "../../runtime/helpers.js";
import type { WorkspaceExec } from "../../runtime/types.js";
import type {
  GitBranchSnapshot,
  GitCommitSnapshot,
  GitMetricsSnapshot,
  GitSnapshot,
  GitStateSnapshot,
  GitStatusSnapshot,
  GitWorktreeSnapshot,
} from "../types.js";

const GIT_TIMEOUT_MS = 3_000;

export interface ReadGitSnapshotOptions {
  includeMetrics: boolean;
  includeTag: boolean;
  statusIgnoreSubmodules?: boolean;
  metricsIgnoreSubmodules?: boolean;
  tagMaxCandidates?: number;
  inspectBare?: boolean;
  exec?: WorkspaceExec;
  signal?: AbortSignal;
}

export async function readGitSnapshot(
  pi: ExtensionAPI,
  cwd: string,
  options: ReadGitSnapshotOptions,
): Promise<GitSnapshot | undefined> {
  if (options.signal?.aborted) return undefined;
  const run = (args: string[]) => runGit(pi, cwd, args, options);
  const statusArgs = [
    "--no-optional-locks",
    "status",
    "--porcelain=v2",
    "--branch",
    "--show-stash",
    "--untracked-files=normal",
  ];
  // Upstream's status control ignores dirt inside submodules, not changed gitlinks.
  if (options.statusIgnoreSubmodules) statusArgs.push("--ignore-submodules=dirty");
  const statusPromise = run(statusArgs);
  const metadataPromise = run([
    "rev-parse",
    "--path-format=absolute",
    "--show-toplevel",
    "--git-common-dir",
    "--git-dir",
  ]);
  const metricsArgs = ["--no-optional-locks", "diff", "--shortstat"];
  if (options.metricsIgnoreSubmodules) metricsArgs.push("--ignore-submodules=all", "--no-ext-diff", "--no-textconv");
  metricsArgs.push("HEAD", "--");
  const metricsPromise = options.includeMetrics ? run(metricsArgs) : Promise.resolve(undefined);
  const candidates = options.tagMaxCandidates;
  const tagArgs =
    Number.isSafeInteger(candidates) && (candidates ?? 0) > 0 && (candidates ?? 0) <= 100
      ? ["describe", "--tags", "--first-parent", "--abbrev=0", `--candidates=${candidates}`, "HEAD"]
      : ["describe", "--tags", "--exact-match", "HEAD"];
  const tagPromise = options.includeTag ? run(tagArgs) : Promise.resolve(undefined);

  const [statusResult, metadataResult, metricsResult, tagResult] = await Promise.all([
    statusPromise,
    metadataPromise,
    metricsPromise,
    tagPromise,
  ]);
  if (options.signal?.aborted || statusResult.killed) return undefined;
  if (statusResult.code !== 0) {
    return options.inspectBare ? readBareSnapshot(pi, cwd, options, tagResult) : undefined;
  }

  const parsed = parseGitStatusPorcelainV2(statusResult.stdout);
  const metadata =
    metadataResult.code === 0 && !metadataResult.killed ? parseGitRepositoryMetadata(metadataResult.stdout) : undefined;
  const commit = withTag(parsed.commit, tagResult);
  const metrics =
    metricsResult && metricsResult.code === 0 && !metricsResult.killed
      ? parseGitDiffShortstat(metricsResult.stdout)
      : undefined;

  return {
    ...parsed,
    root: metadata?.root,
    commit,
    state: metadata ? parseGitState(metadata.gitDirectory) : undefined,
    metrics,
    worktree: metadata?.worktree,
  };
}

type GitCommandResult = Awaited<ReturnType<ExtensionAPI["exec"]>>;

async function runGit(
  pi: ExtensionAPI,
  cwd: string,
  args: string[],
  options: Pick<ReadGitSnapshotOptions, "signal" | "exec">,
): Promise<GitCommandResult> {
  const failed = { stdout: "", stderr: "", code: 1, killed: options.signal?.aborted ?? false };
  if (options.signal?.aborted) return failed;
  try {
    const result = options.exec
      ? await options.exec("git", args, {
          cwd,
          timeout: GIT_TIMEOUT_MS,
          maxOutputBytes: MAX_COMMAND_OUTPUT_BYTES,
          signal: options.signal,
          environment: process.env,
        })
      : await pi.exec("git", args, { cwd, signal: options.signal, timeout: GIT_TIMEOUT_MS });
    if (options.signal?.aborted) return { ...failed, killed: true };
    if (Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr) > MAX_COMMAND_OUTPUT_BYTES) {
      return { ...failed, killed: true };
    }
    return result;
  } catch {
    return failed;
  }
}

async function readBareSnapshot(
  pi: ExtensionAPI,
  cwd: string,
  options: ReadGitSnapshotOptions,
  tagResult: GitCommandResult | undefined,
): Promise<GitSnapshot | undefined> {
  const boundedOptions = { ...options, exec: options.exec ?? execWorkspaceCommand };
  const run = (args: string[]) => runGit(pi, cwd, args, boundedOptions);
  const bare = await run(["rev-parse", "--is-bare-repository"]);
  if (options.signal?.aborted || bare.killed || bare.code !== 0 || bare.stdout.trim() !== "true") return undefined;
  const [head, hash] = await Promise.all([
    run(["symbolic-ref", "--short", "HEAD"]),
    run(["rev-parse", "--verify", "HEAD"]),
  ]);
  if (options.signal?.aborted || head.killed || hash.killed) return undefined;
  const name = head.code === 0 ? head.stdout.trim() : "";
  const commitHash = hash.code === 0 ? hash.stdout.trim() : "";
  const validHash = /^[a-fA-F0-9]{4,64}$/u.test(commitHash);
  if (!name && !validHash) return undefined;
  const detached = name === "";
  const reference = `refs/heads/${name}`;
  const upstreamResult = name
    ? await run(["for-each-ref", "--count=1", "--format=%(refname)%00%(upstream:short)", reference])
    : undefined;
  if (options.signal?.aborted) return undefined;
  const upstreamFields =
    upstreamResult?.code === 0 && !upstreamResult.killed ? upstreamResult.stdout.trimEnd().split("\0") : [];
  const remote = upstreamFields[0] === reference ? splitUpstream(upstreamFields[1]) : {};
  return {
    branch: { name: name || "HEAD", detached, bare: true, ...remote },
    commit: validHash ? withTag({ hash: commitHash, detached }, tagResult) : undefined,
    status: emptyGitStatus(),
  };
}

export async function readGitStatus(pi: ExtensionAPI, cwd: string): Promise<GitStatusSnapshot | undefined> {
  const result = await runGit(
    pi,
    cwd,
    ["--no-optional-locks", "status", "--porcelain=v2", "--branch", "--show-stash", "--untracked-files=normal"],
    {},
  );
  if (result.code !== 0 || result.killed) return undefined;
  return parseGitStatusPorcelainV2(result.stdout).status;
}

export async function readGitWorktree(pi: ExtensionAPI, cwd: string): Promise<GitWorktreeSnapshot | undefined> {
  const result = await runGit(
    pi,
    cwd,
    ["rev-parse", "--path-format=absolute", "--show-toplevel", "--git-common-dir", "--git-dir"],
    {},
  );
  if (result.code !== 0 || result.killed) return undefined;
  return parseGitRepositoryMetadata(result.stdout)?.worktree;
}

interface ParsedGitStatus {
  branch?: GitBranchSnapshot;
  commit?: GitCommitSnapshot;
  status: GitStatusSnapshot;
}

export function parseGitStatusPorcelainV2(output: string): ParsedGitStatus {
  const status = emptyGitStatus();
  let branchName: string | undefined;
  let commitHash: string | undefined;
  let upstream: string | undefined;

  for (const line of output.split(/\r?\n/u)) {
    if (!line) continue;
    if (line.startsWith("# branch.oid ")) {
      const value = line.slice("# branch.oid ".length).trim();
      if (value && value !== "(initial)") commitHash = value;
      continue;
    }
    if (line.startsWith("# branch.head ")) {
      branchName = line.slice("# branch.head ".length).trim();
      continue;
    }
    if (line.startsWith("# branch.upstream ")) {
      upstream = line.slice("# branch.upstream ".length).trim();
      continue;
    }
    if (line.startsWith("# branch.ab ")) {
      const match = /^# branch\.ab \+(\d+) -(\d+)$/u.exec(line);
      const ahead = Number(match?.[1]);
      const behind = Number(match?.[2]);
      const valid = Number.isSafeInteger(ahead) && Number.isSafeInteger(behind);
      status.ahead = valid ? ahead : 0;
      status.behind = valid ? behind : 0;
      if (valid && ahead === 0 && behind === 0) status.upToDate = true;
      else delete status.upToDate;
      continue;
    }
    if (line.startsWith("# stash ")) {
      const count = Number(line.slice("# stash ".length));
      status.stashed = Number.isSafeInteger(count) && count > 0 ? count : 0;
      continue;
    }
    addPorcelainV2Status(status, line);
  }
  finalizeStatus(status);

  const detached = branchName === "(detached)";
  const remote = splitUpstream(upstream);
  const branch = branchName
    ? {
        name: detached ? "HEAD" : branchName,
        ...remote,
        detached,
      }
    : undefined;
  const commit = commitHash ? { hash: commitHash, detached } : undefined;
  return { branch, commit, status };
}

export function parseGitStatusPorcelain(output: string): GitStatusSnapshot {
  const status = emptyGitStatus();
  for (const line of output.split(/\r?\n/u)) {
    if (!line) continue;
    if (line.startsWith("## ")) {
      const ahead = /\bahead (\d+)/u.exec(line);
      const behind = /\bbehind (\d+)/u.exec(line);
      status.ahead = ahead?.[1] ? Number(ahead[1]) : 0;
      status.behind = behind?.[1] ? Number(behind[1]) : 0;
      continue;
    }
    const indexStatus = line[0] ?? " ";
    const worktreeStatus = line[1] ?? " ";
    if (indexStatus === "?" && worktreeStatus === "?") {
      status.untracked += 1;
      continue;
    }
    if (isConflict(indexStatus, worktreeStatus)) {
      status.conflicted += 1;
      continue;
    }
    addNormalStatus(status, indexStatus, worktreeStatus);
    if (indexStatus === "R" || indexStatus === "C") status.renamed += 1;
  }
  finalizeStatus(status);
  return status;
}

export function parseGitDiffShortstat(output: string): GitMetricsSnapshot {
  return {
    added: parseShortstatMetric(output, "insertion(+)", "insertions(+)") ?? 0,
    deleted: parseShortstatMetric(output, "deletion(-)", "deletions(-)") ?? 0,
  };
}

function parseShortstatMetric(output: string, singularLabel: string, pluralLabel: string): number | undefined {
  for (const field of output.split(",")) {
    const trimmed = field.trim();
    const separator = trimmed.indexOf(" ");
    if (separator <= 0) continue;
    const label = trimmed.slice(separator + 1).trimStart();
    if (label !== singularLabel && label !== pluralLabel) continue;
    const countText = trimmed.slice(0, separator);
    for (const character of countText) {
      if (character < "0" || character > "9") return undefined;
    }
    const count = Number(countText);
    return Number.isSafeInteger(count) ? count : undefined;
  }
  return undefined;
}

export function parseGitState(gitDirectory: string): GitStateSnapshot | undefined {
  const rebaseMerge = join(gitDirectory, "rebase-merge");
  if (existsSync(rebaseMerge)) return operationWithProgress("REBASING", rebaseMerge, "msgnum", "end");

  const rebaseApply = join(gitDirectory, "rebase-apply");
  if (existsSync(rebaseApply)) {
    const state = existsSync(join(rebaseApply, "applying"))
      ? "AM"
      : existsSync(join(rebaseApply, "rebasing"))
        ? "REBASING"
        : "AM/REBASE";
    return operationWithProgress(state, rebaseApply, "next", "last");
  }
  if (existsSync(join(gitDirectory, "MERGE_HEAD"))) return { state: "MERGING" };
  if (existsSync(join(gitDirectory, "REVERT_HEAD"))) return { state: "REVERTING" };
  if (existsSync(join(gitDirectory, "CHERRY_PICK_HEAD"))) return { state: "CHERRY-PICKING" };
  if (existsSync(join(gitDirectory, "BISECT_LOG"))) return { state: "BISECTING" };
  return undefined;
}

interface GitRepositoryMetadata {
  root: string;
  gitDirectory: string;
  worktree?: GitWorktreeSnapshot;
}

function parseGitRepositoryMetadata(output: string): GitRepositoryMetadata | undefined {
  const lines = output.trimEnd().split(/\r?\n/u);
  if (lines.length !== 3) return undefined;
  const [path, commonDir, gitDirectory] = lines;
  if (!path || !commonDir || !gitDirectory) return undefined;
  if (![path, commonDir, gitDirectory].every(isAbsolute)) return undefined;
  return {
    root: path,
    gitDirectory,
    worktree: samePath(commonDir, gitDirectory) ? undefined : { name: basename(path) || path, path },
  };
}

export function parseGitWorktree(output: string): GitWorktreeSnapshot | undefined {
  return parseGitRepositoryMetadata(output)?.worktree;
}

function addPorcelainV2Status(status: GitStatusSnapshot, line: string) {
  const kind = line[0];
  if (kind === "?") {
    status.untracked += 1;
    return;
  }
  if (kind === "u") {
    status.conflicted += 1;
    return;
  }
  if (kind !== "1" && kind !== "2") return;
  const indexStatus = line[2] ?? ".";
  const worktreeStatus = line[3] ?? ".";
  addNormalStatus(status, indexStatus, worktreeStatus);
  if (kind === "2") status.renamed += 1;
}

function addNormalStatus(status: GitStatusSnapshot, indexStatus: string, worktreeStatus: string) {
  if (indexStatus === "A") status.indexAdded += 1;
  if (indexStatus === "D") status.indexDeleted += 1;
  if (indexStatus === "M") status.indexModified += 1;
  if (indexStatus === "T") status.indexTypechanged += 1;
  if (worktreeStatus === "A") status.worktreeAdded += 1;
  if (worktreeStatus === "D") status.worktreeDeleted += 1;
  if (worktreeStatus === "M") status.worktreeModified += 1;
  if (worktreeStatus === "T") status.worktreeTypechanged += 1;
}

function finalizeStatus(status: GitStatusSnapshot) {
  status.deleted = status.worktreeDeleted + status.indexDeleted;
  status.modified = status.worktreeModified + status.worktreeAdded;
  status.staged = status.indexModified + status.indexAdded + status.indexTypechanged;
  status.typechanged = status.worktreeTypechanged;
}

function emptyGitStatus(): GitStatusSnapshot {
  return {
    ahead: 0,
    behind: 0,
    stashed: 0,
    conflicted: 0,
    deleted: 0,
    renamed: 0,
    modified: 0,
    staged: 0,
    typechanged: 0,
    untracked: 0,
    worktreeAdded: 0,
    worktreeDeleted: 0,
    worktreeModified: 0,
    worktreeTypechanged: 0,
    indexAdded: 0,
    indexDeleted: 0,
    indexModified: 0,
    indexTypechanged: 0,
  };
}

function splitUpstream(upstream: string | undefined): {
  remoteName?: string;
  remoteBranch?: string;
} {
  if (!upstream) return {};
  const separator = upstream.indexOf("/");
  if (separator <= 0 || separator === upstream.length - 1) return { remoteBranch: upstream };
  return {
    remoteName: upstream.slice(0, separator),
    remoteBranch: upstream.slice(separator + 1),
  };
}

function withTag(
  commit: GitCommitSnapshot | undefined,
  result:
    | {
        stdout: string;
        code: number;
        killed: boolean;
      }
    | undefined,
): GitCommitSnapshot | undefined {
  if (!commit || !result || result.code !== 0 || result.killed) return commit;
  const tag = result.stdout.trim();
  return tag ? { ...commit, tag: tag.split(/\r?\n/u)[0] } : commit;
}

function operationWithProgress(
  state: string,
  directory: string,
  currentName: string,
  totalName: string,
): GitStateSnapshot {
  const progressCurrent = readPositiveInteger(join(directory, currentName));
  const progressTotal = readPositiveInteger(join(directory, totalName));
  return progressCurrent !== undefined && progressTotal !== undefined
    ? { state, progressCurrent, progressTotal }
    : { state };
}

function readPositiveInteger(path: string): number | undefined {
  try {
    const value = Number(readFileSync(path, "utf8").trim());
    return Number.isSafeInteger(value) && value > 0 ? value : undefined;
  } catch {
    return undefined;
  }
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

export function gitStatusEqual(left: GitStatusSnapshot | undefined, right: GitStatusSnapshot | undefined): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function gitSnapshotEqual(left: GitSnapshot | undefined, right: GitSnapshot | undefined): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
