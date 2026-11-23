import type { DaemonConnection } from "@narumitw/pi-sync-daemon";
import { errorMessage } from "../sync/sync-errors.js";

export function isForegroundDirection(operation: string) {
  return operation === "push.foreground" || operation === "pull.foreground";
}

export class DirectionalCheckpoint {
  job?: string;
  fingerprint?: string;

  constructor(
    readonly connection: DaemonConnection,
    private readonly expected?: string,
  ) {}

  accept(connection: DaemonConnection, job: string, fingerprint: unknown) {
    if (
      connection !== this.connection ||
      this.job !== job ||
      typeof fingerprint !== "string" ||
      !/^[a-f0-9]{64}$/u.test(fingerprint) ||
      (this.expected !== undefined && fingerprint !== this.expected) ||
      (this.fingerprint !== undefined && fingerprint !== this.fingerprint)
    )
      return false;
    this.fingerprint = fingerprint;
    return true;
  }
}

function recoveryOutcome(value: unknown) {
  if (!value || typeof value !== "object" || !("foregroundQueueCleanup" in value)) return;
  if (value.foregroundQueueCleanup === "before-mutation") return { phase: "unchanged" as const };
  if (value.foregroundQueueCleanup === "verified-result" && "result" in value)
    return { phase: "completed" as const, result: value.result };
}

function restoreMessage(value: unknown): string {
  return value && typeof value === "object" && "message" in value && typeof value.message === "string"
    ? ` ${value.message}`
    : "";
}

export class CompletedDirectionalRecoveryError extends Error {}

function cancelledAfterCompletion(result: unknown, cause: unknown) {
  const error = new CompletedDirectionalRecoveryError(
    `The transfer finished, but file-queue recovery was cancelled.${restoreMessage(result)}`,
    { cause },
  );
  error.name = "AbortError";
  return error;
}

export async function runDirectionalRecovery(
  connection: DaemonConnection,
  signal: AbortSignal,
  run: (checkpoint: DirectionalCheckpoint, retryCheckpoint?: string) => Promise<unknown>,
  recover: (connection: DaemonConnection, job: string, signal: AbortSignal) => Promise<DaemonConnection>,
  markCleanupRequired: () => void,
) {
  signal.throwIfAborted();
  const attempt = new DirectionalCheckpoint(connection);
  const result = await run(attempt);
  const primary = recoveryOutcome(result);
  if (!primary) return result;
  markCleanupRequired();
  let replacement: DaemonConnection;
  const bounded = AbortSignal.any([signal, AbortSignal.timeout(45_000)]);
  try {
    bounded.throwIfAborted();
    if (!attempt.job || (primary.phase === "unchanged" && !attempt.fingerprint))
      throw new Error("The original transfer scope could not be verified.");
    replacement = await recover(connection, attempt.job, bounded);
    bounded.throwIfAborted();
  } catch (error) {
    if (signal.aborted) {
      if (primary.phase === "completed") throw cancelledAfterCompletion(primary.result, signal.reason);
      throw signal.reason;
    }
    const detail = bounded.aborted ? "The daemon did not recover in time." : errorMessage(error);
    if (primary.phase === "completed")
      throw new CompletedDirectionalRecoveryError(
        `The transfer finished, but file-queue recovery stopped. ${detail}${restoreMessage(primary.result)}`,
        { cause: error },
      );
    throw new Error(`No transfer was applied, but file-queue recovery stopped. ${detail}`, { cause: error });
  }
  if (primary.phase === "completed") return primary.result;
  const retry = new DirectionalCheckpoint(replacement, attempt.fingerprint);
  const retried = await run(retry, attempt.fingerprint);
  const remaining = recoveryOutcome(retried);
  if (!remaining) return retried;
  markCleanupRequired();
  if (remaining.phase === "completed") {
    if (signal.aborted) throw cancelledAfterCompletion(remaining.result, signal.reason);
    throw new CompletedDirectionalRecoveryError(
      `Transfer finished, but file-queue cleanup is still uncertain after one recovery attempt.${restoreMessage(remaining.result)}`,
    );
  }
  throw new Error("File-queue release could not be verified after one recovery attempt. No transfer was applied.");
}
