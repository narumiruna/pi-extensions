import type { Snapshot, SnapshotSelection } from "../snapshot/snapshot-types.js";

import { sameSnapshotSelection } from "../sync/sync-policy.js";

export const HISTORY_PREVIEW_LIMIT = 20;

export type PublicationCapability =
  | "read-check-write-verify"
  | "conditional-required"
  | "atomic-conditional"
  | "lease-protected";

export interface RemoteHead {
  /** Backend-owned reference used only to retrieve this immutable snapshot. */
  snapshotRef: string;
  /** Backend-neutral snapshot content identity retained in local sync state. */
  snapshotId: string;
  revision: string;
  createdAt: string;
  machine: string;
  syncSessions: boolean;
  /** Validated lightweight projection; revalidate it against the immutable snapshot before adoption. */
  selection?: SnapshotSelection;
}

export interface RemoteHistoryEntry {
  snapshotRef: string;
  snapshotId: string;
  createdAt: string;
  machine: string;
  syncSessions: boolean;
}

export type ExpectedRemoteHead = { kind: "missing" } | { kind: "revision"; revision: string };

export interface PublishSnapshotOptions {
  signal?: AbortSignal;
  validatePublication?: () => Promise<void>;
  preservePreviousHead?: boolean;
  /** Called at the backend's active-head commit boundary. */
  onCommit?: () => void;
}

export interface PublishSnapshotResult {
  head: RemoteHead;
  warnings: string[];
}

export interface HistoryRepairOptions {
  signal?: AbortSignal;
  validateOwner(): void;
  validateSettings(): Promise<void>;
  onCommit?: () => void;
}

export interface BackendDiagnostic {
  key: string;
  level: "info" | "warning" | "error";
  message: string;
}

export interface SyncBackend {
  readonly identity: string;
  readonly destination: string;
  readonly capability: PublicationCapability;
  /** Compare opaque revisions produced by this backend identity. */
  sameRevision(left: string, right: string): boolean;
  /** Recovery-only equivalence for retiring an inactive candidate; never authorizes publication or apply. */
  matchesUncommittedRecoveryHead?(current: RemoteHead, recorded: RemoteHead): boolean;
  readHead(signal?: AbortSignal): Promise<RemoteHead | undefined>;
  readHeadAndSnapshot?(
    signal?: AbortSignal,
    maxBytes?: number,
  ): Promise<{ head: RemoteHead; snapshot: Snapshot } | undefined>;
  readSnapshot(reference: string, signal?: AbortSignal, maxBytes?: number): Promise<Snapshot>;
  publishSnapshot(
    snapshot: Snapshot,
    expected: ExpectedRemoteHead,
    options?: PublishSnapshotOptions,
  ): Promise<PublishSnapshotResult>;
  listHistory(signal?: AbortSignal): Promise<RemoteHistoryEntry[]>;
  repairActiveHistory?(expected: RemoteHead, options: HistoryRepairOptions): Promise<boolean>;
  diagnose(signal?: AbortSignal): Promise<BackendDiagnostic[]>;
}

export class SyncBackendConflictError extends Error {
  readonly code = "SYNC_BACKEND_CONFLICT";
  readonly phase: "before-commit" | "after-commit";
  readonly currentHead?: RemoteHead;
  readonly candidateMayHaveBeenActive: boolean;

  constructor(
    message: string,
    options: ErrorOptions & {
      phase?: "before-commit" | "after-commit";
      currentHead?: RemoteHead;
      candidateMayHaveBeenActive?: boolean;
    } = {},
  ) {
    super(message, options);
    this.name = "SyncBackendConflictError";
    this.phase = options.phase ?? "before-commit";
    this.currentHead = options.currentHead;
    this.candidateMayHaveBeenActive = options.candidateMayHaveBeenActive ?? false;
  }
}

export class SyncBackendPublicationOutcomeUnknownError extends Error {
  readonly code = "SYNC_BACKEND_PUBLICATION_OUTCOME_UNKNOWN";

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "SyncBackendPublicationOutcomeUnknownError";
  }
}

export async function verifyPreviousHeadInHistory(backend: SyncBackend, head: RemoteHead, signal?: AbortSignal) {
  const entries = await backend.listHistory(signal);
  if (
    !entries
      .slice(-(HISTORY_PREVIEW_LIMIT - 1))
      .some(
        (entry) =>
          entry.snapshotRef === head.snapshotRef &&
          entry.snapshotId === head.snapshotId &&
          entry.createdAt === head.createdAt &&
          entry.machine === head.machine &&
          entry.syncSessions === head.syncSessions,
      )
  )
    throw new Error(`Cannot replace remote snapshot ${head.snapshotId}: it is not available in History.`);
  const snapshot = await backend.readSnapshot(head.snapshotRef, signal);
  if (snapshot.id !== head.snapshotId || (head.selection && !sameSnapshotSelection(head.selection, snapshot.selection)))
    throw new Error(`Cannot replace remote snapshot ${head.snapshotId}: History resolved to a different snapshot.`);
}

export function expectedRemoteHead(head: RemoteHead | undefined): ExpectedRemoteHead {
  return head ? { kind: "revision", revision: head.revision } : { kind: "missing" };
}
