import type { RemoteHead } from "../backends/sync-backend.js";
import type { SyncDecision } from "./sync-decision.js";

export class PublicationStatePersistenceError extends Error {
  readonly head: RemoteHead;
  readonly backupPath?: string;

  constructor(head: RemoteHead, cause: unknown, backupPath?: string) {
    super(
      `Remote publication ${head.snapshotId} is active, but local sync state could not be saved${backupPath ? `; local backup: ${backupPath}` : ""}: ${errorMessage(cause)}`,
      { cause },
    );
    this.name = "PublicationStatePersistenceError";
    this.head = head;
    this.backupPath = backupPath;
  }
}

export class RollbackPublicationError extends Error {
  readonly backupPath: string;

  constructor(backupPath: string, cause: unknown) {
    super(`Rollback applied locally with backup ${backupPath}, but remote publication failed: ${errorMessage(cause)}`, {
      cause,
    });
    this.name = "RollbackPublicationError";
    this.backupPath = backupPath;
  }
}

export class SetupPullRequiresUiError extends Error {}

export class SyncDecisionRequiredError extends Error {
  readonly decision: SyncDecision;

  constructor(decision: SyncDecision) {
    super(decision.directMessage);
    this.name = "SyncDecisionRequiredError";
    this.decision = decision;
  }
}

export function isSyncDecisionRequiredError(error: unknown): error is SyncDecisionRequiredError {
  return error instanceof SyncDecisionRequiredError;
}

export function errorMessage(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  // biome-ignore lint/suspicious/noControlCharactersInRegex: Escape untrusted terminal controls.
  return message.replace(/[\u0000-\u001f\u007f-\u009f]/gu, "?");
}
