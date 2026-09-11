import {
  type BackendDiagnostic,
  type ExpectedRemoteHead,
  type PublishSnapshotOptions,
  type PublishSnapshotResult,
  type RemoteHead,
  type RemoteHistoryEntry,
  type SyncBackend,
  SyncBackendConflictError,
  SyncBackendPublicationOutcomeUnknownError,
} from "../src/backends/sync-backend.js";
import type { Snapshot } from "../src/snapshot/snapshot-types.js";

export class MemorySyncBackend implements SyncBackend {
  readonly identity: string;
  readonly destination: string;
  readonly capability = "atomic-conditional" as const;
  private snapshots = new Map<string, Snapshot>();
  private head: RemoteHead | undefined;
  private history: RemoteHistoryEntry[] = [];
  private revision = 0;
  failNextPublicationAfterCommit = false;

  constructor(identity = "memory:test", destination = "memory · test") {
    this.identity = identity;
    this.destination = destination;
  }

  sameRevision(left: string, right: string) {
    return left === right;
  }

  async readHead(signal?: AbortSignal) {
    throwIfAborted(signal);
    return this.head ? structuredClone(this.head) : undefined;
  }

  async readSnapshot(reference: string, signal?: AbortSignal) {
    throwIfAborted(signal);
    const snapshot = this.snapshots.get(reference);
    if (!snapshot) throw new Error(`Snapshot not found: ${reference}`);
    return structuredClone(snapshot);
  }

  async publishSnapshot(
    snapshot: Snapshot,
    expected: ExpectedRemoteHead,
    options: PublishSnapshotOptions = {},
  ): Promise<PublishSnapshotResult> {
    throwIfAborted(options.signal);
    if (!matchesExpected(this.head, expected)) {
      throw new SyncBackendConflictError("Remote changed while publishing.");
    }
    this.snapshots.set(snapshot.id, structuredClone(snapshot));
    throwIfAborted(options.signal);
    options.onCommit?.();
    this.revision += 1;
    this.head = {
      snapshotRef: snapshot.id,
      snapshotId: snapshot.id,
      revision: `memory:${this.revision}`,
      createdAt: snapshot.createdAt,
      machine: snapshot.machine,
      syncSessions: snapshot.syncSessions === true,
      ...(snapshot.selection === undefined ? {} : { selection: structuredClone(snapshot.selection) }),
    };
    this.history = [
      ...this.history.filter((entry) => entry.snapshotRef !== snapshot.id),
      {
        snapshotRef: this.head.snapshotRef,
        snapshotId: this.head.snapshotId,
        createdAt: this.head.createdAt,
        machine: this.head.machine,
        syncSessions: this.head.syncSessions,
      },
    ].slice(-100);
    if (this.failNextPublicationAfterCommit) {
      this.failNextPublicationAfterCommit = false;
      throw new SyncBackendPublicationOutcomeUnknownError("Memory publication committed, but verification failed.");
    }
    return { head: structuredClone(this.head), warnings: [] };
  }

  async listHistory(signal?: AbortSignal) {
    throwIfAborted(signal);
    return this.history.map((entry) => ({ ...entry }));
  }

  async diagnose(signal?: AbortSignal): Promise<BackendDiagnostic[]> {
    throwIfAborted(signal);
    return [
      {
        key: "memory",
        level: "info",
        message: "memory backend: ok",
      },
    ];
  }
}

function matchesExpected(head: RemoteHead | undefined, expected: ExpectedRemoteHead) {
  if (expected.kind === "missing") return head === undefined;
  return head?.revision === expected.revision;
}

function throwIfAborted(signal?: AbortSignal) {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error ? signal.reason : new DOMException("The operation was aborted", "AbortError");
}
