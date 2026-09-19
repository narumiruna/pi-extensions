import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { GitMetadata } from "./tracing.js";

const GIT_LOOKUP_TIMEOUT_MS = 1_000;
const MAX_GIT_BRANCH_LENGTH = 256;

type GitExecutor = ExtensionAPI["exec"];

export async function resolveGitMetadata(exec: GitExecutor, cwd: string): Promise<GitMetadata | undefined> {
  const [branchResult, commit] = await Promise.all([resolveGitBranch(exec, cwd), resolveGitCommit(exec, cwd)]);
  if (!branchResult.resolved) return undefined;
  if (branchResult.branch) {
    return {
      branch: branchResult.branch,
      ...(commit ? { commit } : {}),
      detached: false,
    };
  }
  return commit ? { commit, detached: true } : undefined;
}

async function resolveGitBranch(exec: GitExecutor, cwd: string): Promise<{ resolved: boolean; branch?: string }> {
  try {
    const result = await exec("git", ["symbolic-ref", "--quiet", "--short", "HEAD"], {
      cwd,
      timeout: GIT_LOOKUP_TIMEOUT_MS,
    });
    if (result.killed) return { resolved: false };
    if (result.code === 1) return { resolved: true };
    if (result.code !== 0) return { resolved: false };
    const branch = normalizeGitBranch(result.stdout);
    return branch ? { resolved: true, branch } : { resolved: false };
  } catch {
    return { resolved: false };
  }
}

async function resolveGitCommit(exec: GitExecutor, cwd: string): Promise<string | undefined> {
  try {
    const result = await exec("git", ["rev-parse", "--verify", "--short=12", "HEAD"], {
      cwd,
      timeout: GIT_LOOKUP_TIMEOUT_MS,
    });
    if (result.code !== 0 || result.killed) return undefined;
    const commit = result.stdout.trim();
    return /^[0-9a-f]{4,64}$/iu.test(commit) ? commit.toLowerCase() : undefined;
  } catch {
    return undefined;
  }
}

function normalizeGitBranch(value: string): string | undefined {
  const branch = value.trim();
  if (!branch || branch.length > MAX_GIT_BRANCH_LENGTH) return undefined;
  for (const character of branch) {
    const code = character.codePointAt(0) ?? 0;
    if (code <= 31 || code === 127) return undefined;
  }
  return branch;
}
