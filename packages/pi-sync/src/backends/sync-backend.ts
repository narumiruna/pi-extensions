import type { Snapshot, SnapshotSelection } from "../snapshot/snapshot-types.js";

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
  /** Called at the backend's active-head commit boundary. */
  onCommit?: () => void;
}

export interface PublishSnapshotResult {
  head: RemoteHead;
  warnings: string[];
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
  readHead(signal?: AbortSignal): Promise<RemoteHead | undefined>;
  readSnapshot(reference: string, signal?: AbortSignal): Promise<Snapshot>;
  publishSnapshot(
    snapshot: Snapshot,
    expected: ExpectedRemoteHead,
    options?: PublishSnapshotOptions,
  ): Promise<PublishSnapshotResult>;
  listHistory(signal?: AbortSignal): Promise<RemoteHistoryEntry[]>;
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

export function expectedRemoteHead(head: RemoteHead | undefined): ExpectedRemoteHead {
  return head ? { kind: "revision", revision: head.revision } : { kind: "missing" };
}
