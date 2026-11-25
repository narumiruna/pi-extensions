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
  if (value.foregroundQueueCleanup === "resume-adoption") {
    if (!("journal" in value) || typeof value.journal !== "string" || !/^[a-f0-9]{64}$/u.test(value.journal))
      throw new Error("The recorded Pull could not be verified. Use /sync daemon recover.");
    return { phase: "adoption" as const, journal: value.journal };
  }
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

export interface PendingAdoptionRecovery {
  owner: DaemonConnection;
  job: string;
  journal: string;
}

export async function runDirectionalRecovery(
  connection: DaemonConnection,
  signal: AbortSignal,
  run: (checkpoint: DirectionalCheckpoint, retryCheckpoint?: string, retryAdoptionJournal?: string) => Promise<unknown>,
  recover: (connection: DaemonConnection, job: string, signal: AbortSignal) => Promise<DaemonConnection>,
  markCleanupRequired: () => void,
  adoption?: { pending?: PendingAdoptionRecovery; retain(value: PendingAdoptionRecovery | undefined): void },
) {
  signal.throwIfAborted();
  const pending = adoption?.pending;
  if (pending && pending.owner !== connection) throw new Error("The daemon changed before Pull recovery.");
  const attempt = new DirectionalCheckpoint(connection);
  attempt.job = pending?.job;
  const result = pending ? { foregroundQueueCleanup: "resume-adoption", journal: pending.journal } : await run(attempt);
  const primary = recoveryOutcome(result);
  if (!primary) return result;
  markCleanupRequired();
  let replacement: DaemonConnection;
  const bounded = AbortSignal.any([signal, AbortSignal.timeout(45_000)]);
  try {
    bounded.throwIfAborted();
    if (
      !attempt.job ||
      (primary.phase === "unchanged" && !attempt.fingerprint) ||
      (primary.phase === "adoption" && (!adoption || (!pending && !attempt.fingerprint)))
    )
      throw new Error("The original transfer scope could not be verified.");
    if (primary.phase === "adoption")
      adoption?.retain({ owner: connection, job: attempt.job, journal: primary.journal });
    replacement = await recover(connection, attempt.job, bounded);
    if (primary.phase === "adoption") adoption?.retain(undefined);
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
    if (primary.phase === "adoption")
      throw new Error(`Pull recovery stopped. The adoption journal was kept. ${detail}`, { cause: error });
    throw new Error(`No transfer was applied, but file-queue recovery stopped. ${detail}`, { cause: error });
  }
  if (primary.phase === "completed") return primary.result;
  const retryCheckpoint = primary.phase === "unchanged" ? attempt.fingerprint : undefined;
  const retry = new DirectionalCheckpoint(replacement, retryCheckpoint);
  const retried = await run(retry, retryCheckpoint, primary.phase === "adoption" ? primary.journal : undefined);
  const remaining = recoveryOutcome(retried);
  if (!remaining) return retried;
  markCleanupRequired();
  if (remaining.phase === "completed") {
    if (signal.aborted) throw cancelledAfterCompletion(remaining.result, signal.reason);
    throw new CompletedDirectionalRecoveryError(
      `Transfer finished, but file-queue cleanup is still uncertain after one recovery attempt.${restoreMessage(remaining.result)}`,
    );
  }
  if (remaining.phase === "adoption") {
    if (retry.job && retry.fingerprint)
      adoption?.retain({ owner: replacement, job: retry.job, journal: remaining.journal });
    throw new Error("File-queue cleanup is still uncertain after one recovery attempt. The adoption journal was kept.");
  }
  throw new Error("File-queue release could not be verified after one recovery attempt. No transfer was applied.");
}
