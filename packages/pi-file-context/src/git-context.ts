import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const GIT_TIMEOUT_MS = 5_000;
const GIT_MAX_BUFFER = 1_100_000;
const MAX_HISTORY_ENTRIES = 20;

export interface GitProjectInfo {
  repositoryRoot: string;
  projectPrefix: string;
  branch: string;
  head: string;
  dirty: boolean;
}

export interface GitFileStatus {
  code: string;
  label: string;
  staged: boolean;
  unstaged: boolean;
  untracked: boolean;
  ignored: boolean;
  conflicted: boolean;
}

export interface GitDiffHunk {
  header: string;
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  lines: string[];
  changedLines: number[];
}

export interface GitFileContext {
  status: GitFileStatus | undefined;
  blob: string | undefined;
  hunks: GitDiffHunk[];
}

export interface GitBlameInfo {
  commit: string;
  author: string;
  authorTime: number | undefined;
  summary: string;
  committed: boolean;
}

export interface GitHistoryEntry {
  commit: string;
  author: string;
  authorTime: number;
  summary: string;
  path: string;
}

export interface GitRevisionFile {
  path: string;
  lines: string[];
  revision: string;
  commit: string;
  blob: string | undefined;
}

export class GitContext {
  private readonly statusMap: Map<string, GitFileStatus>;

  constructor(
    readonly projectRoot: string,
    readonly project: GitProjectInfo,
    statuses: ReadonlyMap<string, GitFileStatus>,
  ) {
    this.statusMap = new Map(statuses);
  }

  get statuses(): ReadonlyMap<string, GitFileStatus> {
    return this.statusMap;
  }

  async getFileContext(projectPath: string, signal?: AbortSignal): Promise<GitFileContext> {
    this.assertProjectPath(projectPath);
    const [blobResult, diffResult] = await Promise.all([
      this.run(["rev-parse", "--verify", `HEAD:${this.repositoryPath(projectPath)}`], true, signal),
      this.run(["diff", "--no-ext-diff", "--no-textconv", "--unified=3", "HEAD", "--", projectPath], true, signal),
    ]);
    signal?.throwIfAborted();
    return {
      status: this.statusMap.get(projectPath),
      blob: blobResult.ok ? blobResult.stdout.trim() || undefined : undefined,
      hunks: diffResult.ok ? parseUnifiedDiff(diffResult.stdout) : [],
    };
  }

  async refreshFileContext(projectPath: string, signal?: AbortSignal): Promise<GitFileContext> {
    const [fileContext, statusResult] = await Promise.all([
      this.getFileContext(projectPath, signal),
      this.run(
        [
          "-c",
          "status.relativePaths=true",
          "status",
          "--porcelain=v1",
          "-z",
          "--untracked-files=all",
          "--ignored=traditional",
          "--",
          ".",
        ],
        true,
        signal,
      ),
    ]);
    signal?.throwIfAborted();
    if (!statusResult.ok) return fileContext;
    const statuses = parseStatuses(statusResult.stdout, this.project.projectPrefix);
    this.statusMap.clear();
    for (const [path, status] of statuses) this.statusMap.set(path, status);
    this.project.dirty = [...statuses.values()].some((status) => !status.ignored);
    return { ...fileContext, status: this.statusMap.get(projectPath) };
  }

  async getBlame(
    projectPath: string,
    line: number,
    revision?: string,
    signal?: AbortSignal,
  ): Promise<GitBlameInfo | undefined> {
    this.assertProjectPath(projectPath);
    if (!Number.isSafeInteger(line) || line < 1) throw new Error("Blame line must be positive");
    if (revision && !/^[0-9a-f]{40}$/i.test(revision)) throw new Error("Invalid blame revision");
    const result = await this.run(
      [
        "blame",
        "--no-textconv",
        "--line-porcelain",
        "-L",
        `${line},${line}`,
        ...(revision ? [revision] : []),
        "--",
        projectPath,
      ],
      true,
      signal,
    );
    signal?.throwIfAborted();
    if (!result.ok) return undefined;
    return parseBlame(result.stdout);
  }

  async getHistory(projectPath: string, signal?: AbortSignal): Promise<GitHistoryEntry[]> {
    this.assertProjectPath(projectPath);
    const result = await this.run(
      [
        "log",
        `--max-count=${MAX_HISTORY_ENTRIES}`,
        "--format=%x1e%H%x1f%an%x1f%at%x1f%s",
        "--name-only",
        "-z",
        "--follow",
        "--",
        projectPath,
      ],
      true,
      signal,
    );
    signal?.throwIfAborted();
    return result.ok ? parseHistory(result.stdout) : [];
  }

  async loadRevision(
    projectPath: string,
    revision: string,
    historicalPath?: string,
    signal?: AbortSignal,
  ): Promise<GitRevisionFile> {
    this.assertProjectPath(projectPath);
    const normalizedRevision = revision.trim();
    if (!normalizedRevision || /[\0\r\n]/.test(normalizedRevision)) {
      throw new Error("Revision is required");
    }
    const resolved = await this.run(
      ["rev-parse", "--verify", "--end-of-options", `${normalizedRevision}^{commit}`],
      true,
      signal,
    );
    if (!resolved.ok || !/^[0-9a-f]{40}$/i.test(resolved.stdout.trim())) {
      throw new Error(`Unknown Git revision: ${normalizedRevision}`);
    }
    signal?.throwIfAborted();
    const commit = resolved.stdout.trim().toLowerCase();
    const repositoryPath = historicalPath
      ? this.assertRepositoryPath(historicalPath)
      : this.repositoryPath(projectPath);
    const [contentsResult, blobResult] = await Promise.all([
      this.run(["show", `${commit}:${repositoryPath}`], true, signal),
      this.run(["rev-parse", "--verify", `${commit}:${repositoryPath}`], true, signal),
    ]);
    signal?.throwIfAborted();
    if (!contentsResult.ok) {
      throw new Error(`${projectPath} does not exist at ${normalizedRevision}`);
    }
    if (Buffer.byteLength(contentsResult.stdout, "utf8") > 1_000_000) {
      throw new Error(`${projectPath} exceeds 1000000 bytes at ${normalizedRevision}`);
    }
    if (contentsResult.stdout.includes("\0")) {
      throw new Error(`${projectPath} appears to be binary at ${normalizedRevision}`);
    }
    return {
      path: historicalPath ?? projectPath,
      lines: normalizeLines(contentsResult.stdout),
      revision: normalizedRevision,
      commit,
      blob: blobResult.ok ? blobResult.stdout.trim() || undefined : undefined,
    };
  }

  private async run(args: string[], allowFailure = false, signal?: AbortSignal): Promise<GitResult> {
    return runGit(this.projectRoot, args, allowFailure, signal);
  }

  private repositoryPath(projectPath: string): string {
    return `${this.project.projectPrefix}${projectPath}`.replaceAll("\\", "/");
  }

  private assertRepositoryPath(repositoryPath: string): string {
    const normalized = repositoryPath.replaceAll("\\", "/");
    if (!normalized || isAbsolute(normalized) || normalized.includes("\0")) {
      throw new Error("Invalid historical Git path");
    }
    const candidate = resolve(this.project.repositoryRoot, normalized);
    const result = relative(this.project.repositoryRoot, candidate);
    if (result === ".." || result.startsWith(`..${sep}`)) {
      throw new Error("Historical Git path is outside the repository");
    }
    return normalized;
  }

  private assertProjectPath(projectPath: string): void {
    if (!projectPath || isAbsolute(projectPath) || projectPath.includes("\0")) {
      throw new Error("Invalid project path");
    }
    const candidate = resolve(this.projectRoot, projectPath);
    const result = relative(this.projectRoot, candidate);
    if (result === ".." || result.startsWith(`..${sep}`)) {
      throw new Error("Git path is outside the project");
    }
  }
}

export async function createGitContext(root: string, signal?: AbortSignal): Promise<GitContext | undefined> {
  signal?.throwIfAborted();
  const projectRoot = await realpath(root);
  signal?.throwIfAborted();
  const repositoryResult = await runGit(projectRoot, ["rev-parse", "--show-toplevel"], true, signal);
  if (!repositoryResult.ok) return undefined;
  const repositoryRoot = stripLineEnding(repositoryResult.stdout);
  if (!repositoryRoot) return undefined;
  const [prefixResult, headResult, branchResult, statusResult] = await Promise.all([
    runGit(projectRoot, ["rev-parse", "--show-prefix"], true, signal),
    runGit(projectRoot, ["rev-parse", "--verify", "HEAD"], true, signal),
    runGit(projectRoot, ["symbolic-ref", "--quiet", "--short", "HEAD"], true, signal),
    runGit(
      projectRoot,
      [
        "-c",
        "status.relativePaths=true",
        "status",
        "--porcelain=v1",
        "-z",
        "--untracked-files=all",
        "--ignored=traditional",
        "--",
        ".",
      ],
      true,
      signal,
    ),
  ]);
  signal?.throwIfAborted();
  const head = headResult.ok ? headResult.stdout.trim().toLowerCase() : "unborn";
  const branch = branchResult.ok ? branchResult.stdout.trim() : head === "unborn" ? "unborn" : head.slice(0, 12);
  const projectPrefix = prefixResult.ok ? stripLineEnding(prefixResult.stdout) : "";
  const statuses = statusResult.ok ? parseStatuses(statusResult.stdout, projectPrefix) : new Map();
  return new GitContext(
    projectRoot,
    {
      repositoryRoot,
      projectPrefix,
      branch,
      head,
      dirty: [...statuses.values()].some((status) => !status.ignored),
    },
    statuses,
  );
}

interface GitResult {
  ok: boolean;
  stdout: string;
}

async function runGit(cwd: string, args: string[], allowFailure: boolean, signal?: AbortSignal): Promise<GitResult> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["--no-pager", "-c", "core.pager=cat", "-c", "core.fsmonitor=false", ...args],
      {
        cwd,
        encoding: "utf8",
        timeout: GIT_TIMEOUT_MS,
        maxBuffer: GIT_MAX_BUFFER,
        signal,
        env: {
          ...process.env,
          GIT_OPTIONAL_LOCKS: "0",
          GIT_PAGER: "cat",
          PAGER: "cat",
        },
      },
    );
    return { ok: true, stdout };
  } catch (error: unknown) {
    if (signal?.aborted) throw error;
    if (allowFailure) return { ok: false, stdout: "" };
    throw error;
  }
}

function parseStatuses(output: string, projectPrefix: string): Map<string, GitFileStatus> {
  const statuses = new Map<string, GitFileStatus>();
  const records = output.split("\0");
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (!record || record.length < 4) continue;
    const code = record.slice(0, 2);
    const repositoryPath = record.slice(3).replaceAll("\\", "/");
    const projectPath = projectPrefix
      ? repositoryPath.startsWith(projectPrefix)
        ? repositoryPath.slice(projectPrefix.length)
        : undefined
      : repositoryPath;
    if (projectPath) statuses.set(projectPath, statusFromCode(code));
    if (code.includes("R") || code.includes("C")) index += 1;
  }
  return new Map([...statuses].sort(([left], [right]) => compareStrings(left, right)));
}

function statusFromCode(code: string): GitFileStatus {
  const conflicted = /^(DD|AU|UD|UA|DU|AA|UU)$/.test(code);
  const untracked = code === "??";
  const ignored = code === "!!";
  const staged = !untracked && !ignored && code[0] !== " ";
  const unstaged = !untracked && !ignored && code[1] !== " ";
  let label: string;
  if (conflicted) label = "conflicted";
  else if (untracked) label = "untracked";
  else if (ignored) label = "ignored";
  else {
    const character = unstaged ? code[1] : code[0];
    const action =
      character === "A"
        ? "added"
        : character === "D"
          ? "deleted"
          : character === "R"
            ? "renamed"
            : character === "C"
              ? "copied"
              : character === "T"
                ? "type changed"
                : "modified";
    const location = staged && unstaged ? "staged + unstaged" : staged ? "staged" : "unstaged";
    label = `${action} (${location})`;
  }
  return { code, label, staged, unstaged, untracked, ignored, conflicted };
}

function parseUnifiedDiff(output: string): GitDiffHunk[] {
  const hunks: GitDiffHunk[] = [];
  let current: GitDiffHunk | undefined;
  let newLine = 0;
  for (const line of output.replaceAll("\r\n", "\n").split("\n")) {
    const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/.exec(line);
    if (match) {
      current = {
        header: line,
        oldStart: Number(match[1]),
        oldCount: Number(match[2] ?? 1),
        newStart: Number(match[3]),
        newCount: Number(match[4] ?? 1),
        lines: [line],
        changedLines: [],
      };
      newLine = current.newStart;
      hunks.push(current);
      continue;
    }
    if (!current) continue;
    current.lines.push(line);
    if (line.startsWith("+") && !line.startsWith("+++")) {
      current.changedLines.push(newLine);
      newLine += 1;
    } else if (!line.startsWith("-") && !line.startsWith("\\")) {
      newLine += 1;
    }
  }
  for (const hunk of hunks) {
    while (hunk.lines.at(-1) === "") hunk.lines.pop();
  }
  return hunks;
}

function parseBlame(output: string): GitBlameInfo | undefined {
  const lines = output.split("\n");
  const commit = lines[0]?.split(" ")[0];
  if (!commit) return undefined;
  const field = (name: string) => lines.find((line) => line.startsWith(`${name} `))?.slice(name.length + 1);
  const authorTime = Number(field("author-time"));
  return {
    commit,
    author: field("author") ?? "Unknown",
    authorTime: Number.isFinite(authorTime) ? authorTime : undefined,
    summary: field("summary") ?? "",
    committed: !/^0+$/.test(commit),
  };
}

function parseHistory(output: string): GitHistoryEntry[] {
  return output
    .split("\x1e")
    .filter(Boolean)
    .flatMap((record) => {
      const [metadata = "", ...pathRecords] = record.split("\0");
      const [commit, author, authorTime, ...summaryParts] = metadata.replace(/^\n+/, "").split("\x1f");
      const path = pathRecords.map((value) => value.replace(/^\n+/, "")).find(Boolean);
      const time = Number(authorTime);
      return commit && author && path && Number.isFinite(time)
        ? [{ commit, author, authorTime: time, summary: summaryParts.join("\x1f"), path }]
        : [];
    });
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function stripLineEnding(value: string): string {
  return value.endsWith("\r\n") ? value.slice(0, -2) : value.endsWith("\n") ? value.slice(0, -1) : value;
}

function normalizeLines(contents: string): string[] {
  if (contents === "") return [];
  const lines = contents.replaceAll("\r\n", "\n").replaceAll("\r", "\n").split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
}
