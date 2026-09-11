import type { ExecResult } from "@earendil-works/pi-coding-agent";

export const oid = "0123456789abcdef0123456789abcdef01234567";

export function result(stdout = "", code = 0, stderr = ""): ExecResult {
  return { stdout, stderr, code, killed: false };
}

export function porcelain(
  records: Array<{
    path: string;
    branch?: string;
    detached?: boolean;
    head?: string;
    lockedReason?: string;
    prunableReason?: string;
  }>,
): string {
  return records
    .flatMap((record) => [
      `worktree ${record.path}`,
      `HEAD ${record.head ?? oid}`,
      record.detached ? "detached" : `branch refs/heads/${record.branch}`,
      ...(record.lockedReason !== undefined ? [`locked ${record.lockedReason}`] : []),
      ...(record.prunableReason !== undefined ? [`prunable ${record.prunableReason}`] : []),
      "",
    ])
    .join("\0");
}

export type ExecFunction = (
  command: string,
  args: string[],
  options?: { cwd?: string; signal?: AbortSignal; timeout?: number },
) => Promise<ExecResult>;
