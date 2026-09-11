import { existsSync } from "node:fs";
import type { ExecResult, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { pathsEqual, stripTerminalControls, type WorktreeRecord } from "./git.js";

const GIT_STATUS_TIMEOUT_MS = 15_000;
const DEFAULT_STATUS_CONCURRENCY = 4;
const OID_PATTERN = /^[0-9a-fA-F]{40,64}$/u;
const STATUS_XY_PATTERN = /^[.MADRCUT]{2}$/u;

export interface WorktreeStatusSnapshot {
  headOid?: string;
  branch?: string;
  detached: boolean;
  upstream?: string;
  ahead?: number;
  behind?: number;
  staged: number;
  unstaged: number;
  untracked: number;
  conflicts: number;
}

export interface LastCommitSummary {
  committedAt: string;
  subject: string;
}

export type WorktreeStatusResult =
  | {
      kind: "available";
      snapshot: WorktreeStatusSnapshot;
      lastCommit?: LastCommitSummary;
    }
  | { kind: "unavailable"; reason: string };

export interface WorktreeStatusCard {
  id: string;
  label: string;
  description: string;
  statusText: string;
  searchText: string;
  details: string[];
}

interface LoadStatusOptions {
  concurrency?: number;
}

export function parseWorktreeStatusPorcelain(output: string): WorktreeStatusSnapshot {
  if (output && !output.endsWith("\0")) {
    throw new Error("Git status porcelain output is not NUL-terminated.");
  }
  const entries = output ? output.slice(0, -1).split("\0") : [];
  const snapshot: WorktreeStatusSnapshot = {
    detached: false,
    staged: 0,
    unstaged: 0,
    untracked: 0,
    conflicts: 0,
  };

  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index] ?? "";
    if (entry.startsWith("# ")) {
      parseBranchHeader(snapshot, entry);
      continue;
    }
    if (entry.startsWith("1 ")) {
      assertFieldCount(entry, 9, "ordinary");
      countTrackedState(snapshot, statusCode(entry));
      continue;
    }
    if (entry.startsWith("2 ")) {
      assertFieldCount(entry, 10, "renamed");
      countTrackedState(snapshot, statusCode(entry));
      const originalPath = entries[index + 1];
      if (!originalPath) throw new Error("Git status returned a malformed renamed record.");
      index += 1;
      continue;
    }
    if (entry.startsWith("u ")) {
      assertFieldCount(entry, 11, "unmerged");
      statusCode(entry);
      snapshot.conflicts += 1;
      continue;
    }
    if (entry.startsWith("? ")) {
      if (entry.length === 2) throw new Error("Git status returned a malformed untracked record.");
      snapshot.untracked += 1;
      continue;
    }
    if (entry.startsWith("! ")) continue;
    throw new Error("Git status returned an unknown porcelain-v2 record.");
  }
  return snapshot;
}

export function formatWorktreeStatusCard(
  record: WorktreeRecord,
  currentPath: string,
  result: WorktreeStatusResult,
): WorktreeStatusCard {
  const path = safeDisplay(record.path);
  const identity = [
    pathsEqual(record.path, currentPath) ? "current" : undefined,
    record.isMain ? "main" : undefined,
    record.bare ? "bare" : undefined,
    record.detached ? "detached" : undefined,
  ].filter((value): value is string => value !== undefined);
  const label = safeDisplay(
    record.branch ??
      (record.detached
        ? `Detached ${record.head?.slice(0, 8) ?? "HEAD"}`
        : record.bare
          ? "Bare worktree"
          : "Unknown worktree"),
  );
  const statePrefix = identity.length > 0 ? `${identity.join(" · ")} · ` : "";
  const baseDetails = [
    `Path: ${path}`,
    `Identity: ${identity.join(" · ") || "linked"}`,
    `Registered HEAD: ${safeDisplay(record.head ?? "unavailable")}`,
  ];
  if (record.lockedReason !== undefined) {
    baseDetails.push(
      record.lockedReason ? `Locked: ${safeDisplay(record.lockedReason)}` : "Locked: no reason provided",
    );
  }
  if (record.prunableReason !== undefined) {
    baseDetails.push(
      record.prunableReason ? `Prunable: ${safeDisplay(record.prunableReason)}` : "Prunable: no reason provided",
    );
  }

  if (result.kind === "unavailable") {
    const reason = safeDisplay(result.reason);
    return {
      id: record.path,
      label,
      description: path,
      statusText: `${statePrefix}unavailable`,
      searchText: `${label} ${path} ${identity.join(" ")} unavailable ${reason}`,
      details: [...baseDetails, `Status: ${reason}`, "Snapshot: local Git state; no fetch performed."],
    };
  }

  const { snapshot, lastCommit } = result;
  const workingState = formatWorkingState(snapshot);
  const upstream = snapshot.upstream
    ? snapshot.ahead !== undefined && snapshot.behind !== undefined
      ? `${safeDisplay(snapshot.upstream)} · ahead ${snapshot.ahead} · behind ${snapshot.behind}`
      : `${safeDisplay(snapshot.upstream)} · ahead/behind unavailable`
    : "not configured; ahead/behind unavailable";
  const details = [
    ...baseDetails,
    `Snapshot HEAD: ${safeDisplay(snapshot.headOid ?? "unborn")}`,
    `Working tree: ${workingState}`,
    `Upstream: ${upstream}`,
    lastCommit
      ? `Last commit: ${safeDisplay(lastCommit.committedAt)} · ${safeDisplay(lastCommit.subject || "(no subject)")}`
      : "Last commit: unavailable",
    "Snapshot: local Git state; no fetch performed; removal uses stricter checks.",
  ];
  return {
    id: record.path,
    label,
    description: path,
    statusText: `${statePrefix}${workingState}`,
    searchText: `${label} ${path} ${identity.join(" ")} ${workingState} ${safeDisplay(snapshot.upstream ?? "")}`,
    details,
  };
}

export async function loadWorktreeStatusCards(
  pi: Pick<ExtensionAPI, "exec">,
  records: readonly WorktreeRecord[],
  currentPath: string,
  signal?: AbortSignal,
  options: LoadStatusOptions = {},
): Promise<WorktreeStatusCard[]> {
  const concurrency = Math.max(1, Math.min(options.concurrency ?? DEFAULT_STATUS_CONCURRENCY, records.length || 1));
  const cards = new Array<WorktreeStatusCard>(records.length);
  let nextIndex = 0;

  const worker = async () => {
    while (true) {
      throwIfAborted(signal);
      const index = nextIndex;
      if (index >= records.length) return;
      nextIndex += 1;
      const record = records[index];
      if (!record) return;
      const unavailable = unavailableReason(record);
      if (unavailable) {
        cards[index] = formatWorktreeStatusCard(record, currentPath, {
          kind: "unavailable",
          reason: unavailable,
        });
        continue;
      }
      try {
        const status = await runGit(
          pi,
          ["status", "--porcelain=v2", "--branch", "-z", "--untracked-files=all", "--ignore-submodules=none"],
          record.path,
          signal,
        );
        const snapshot = parseWorktreeStatusPorcelain(status.stdout);
        const lastCommit = snapshot.headOid
          ? parseLastCommit(
              (
                await runGit(
                  pi,
                  ["show", "-s", "--format=%aI%x00%s", "--end-of-options", snapshot.headOid],
                  record.path,
                  signal,
                )
              ).stdout,
            )
          : undefined;
        cards[index] = formatWorktreeStatusCard(record, currentPath, {
          kind: "available",
          snapshot,
          lastCommit,
        });
      } catch (error) {
        throwIfAborted(signal);
        cards[index] = formatWorktreeStatusCard(record, currentPath, {
          kind: "unavailable",
          reason: `Status failed: ${formatError(error)}`,
        });
      }
    }
  };

  await Promise.all(Array.from({ length: concurrency }, worker));
  throwIfAborted(signal);
  return cards;
}

function parseBranchHeader(snapshot: WorktreeStatusSnapshot, entry: string): void {
  if (entry.startsWith("# branch.oid ")) {
    const oid = entry.slice("# branch.oid ".length);
    if (oid === "(initial)") {
      snapshot.headOid = undefined;
      return;
    }
    if (!OID_PATTERN.test(oid)) throw new Error("Git status returned a malformed branch OID.");
    snapshot.headOid = oid;
    return;
  }
  if (entry.startsWith("# branch.head ")) {
    const branch = entry.slice("# branch.head ".length);
    if (!branch) throw new Error("Git status returned a malformed branch head.");
    snapshot.detached = branch === "(detached)";
    snapshot.branch = snapshot.detached || branch === "(unknown)" ? undefined : branch;
    return;
  }
  if (entry.startsWith("# branch.upstream ")) {
    const upstream = entry.slice("# branch.upstream ".length);
    if (!upstream) throw new Error("Git status returned a malformed upstream.");
    snapshot.upstream = upstream;
    return;
  }
  if (entry.startsWith("# branch.ab ")) {
    const match = /^# branch\.ab \+(\d+) -(\d+)$/u.exec(entry);
    if (!match?.[1] || !match[2]) {
      throw new Error("Git status returned malformed ahead/behind counts.");
    }
    snapshot.ahead = Number.parseInt(match[1], 10);
    snapshot.behind = Number.parseInt(match[2], 10);
  }
}

function statusCode(entry: string): string {
  const code = entry.slice(2, 4);
  if (!STATUS_XY_PATTERN.test(code)) {
    throw new Error("Git status returned a malformed tracked status code.");
  }
  return code;
}

function countTrackedState(snapshot: WorktreeStatusSnapshot, code: string): void {
  if (code[0] !== ".") snapshot.staged += 1;
  if (code[1] !== ".") snapshot.unstaged += 1;
}

function assertFieldCount(entry: string, minimum: number, kind: string): void {
  if (entry.split(" ").length < minimum) {
    throw new Error(`Git status returned a malformed ${kind} record.`);
  }
}

function formatWorkingState(snapshot: WorktreeStatusSnapshot): string {
  const values = [
    snapshot.conflicts > 0 ? `${snapshot.conflicts} conflict${snapshot.conflicts === 1 ? "" : "s"}` : undefined,
    snapshot.staged > 0 ? `${snapshot.staged} staged` : undefined,
    snapshot.unstaged > 0 ? `${snapshot.unstaged} unstaged` : undefined,
    snapshot.untracked > 0 ? `${snapshot.untracked} untracked` : undefined,
  ].filter((value): value is string => value !== undefined);
  return values.join(" · ") || "clean";
}

function unavailableReason(record: WorktreeRecord): string | undefined {
  if (record.bare) return "Bare worktree cannot be inspected";
  if (record.prunableReason !== undefined) {
    return record.prunableReason ? `Prunable: ${record.prunableReason}` : "Prunable worktree metadata";
  }
  if (!existsSync(record.path)) return "Worktree path is missing";
  return undefined;
}

async function runGit(
  pi: Pick<ExtensionAPI, "exec">,
  args: string[],
  cwd: string,
  signal?: AbortSignal,
): Promise<ExecResult> {
  throwIfAborted(signal);
  const result = await pi.exec("git", args, { cwd, signal, timeout: GIT_STATUS_TIMEOUT_MS });
  if (result.killed) {
    throwIfAborted(signal);
    throw new Error(`git ${args.slice(0, 2).join(" ")} timed out.`);
  }
  if (result.code !== 0) {
    const detail = [result.stderr.trim(), result.stdout.trim()].filter(Boolean).join(" ");
    throw new Error(detail || `git ${args.slice(0, 2).join(" ")} exited with code ${result.code}.`);
  }
  return result;
}

function parseLastCommit(output: string): LastCommitSummary {
  const separator = output.indexOf("\0");
  if (separator <= 0 || output.indexOf("\0", separator + 1) >= 0) {
    throw new Error("Git returned malformed last-commit details.");
  }
  const committedAt = output.slice(0, separator);
  const subject = removeLineEnding(output.slice(separator + 1));
  if (!committedAt) throw new Error("Git returned an empty last-commit timestamp.");
  return { committedAt, subject };
}

function safeDisplay(value: string): string {
  return stripTerminalControls(value);
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new DOMException("Worktree status loading was aborted.", "AbortError");
  }
}

function removeLineEnding(value: string): string {
  if (value.endsWith("\r\n")) return value.slice(0, -2);
  if (value.endsWith("\n")) return value.slice(0, -1);
  return value;
}

function formatError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return safeDisplay(message).slice(0, 500);
}
