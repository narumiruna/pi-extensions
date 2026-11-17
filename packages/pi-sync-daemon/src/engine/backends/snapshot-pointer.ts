import type { Snapshot } from "../snapshot/snapshot-types.js";
import type { LatestPointer } from "./backend-types.js";
import type { RemoteHistoryEntry } from "./sync-backend.js";

/** Shared latest/history metadata for the S3 and WebDAV object-store format. */
export function createLatestPointer(namespace: string, snapshot: Snapshot, checksum: string): LatestPointer {
  return {
    version: 1,
    profile: namespace,
    snapshot: snapshot.id,
    sha256: checksum,
    createdAt: snapshot.createdAt,
    machine: snapshot.machine,
    syncSessions: snapshot.syncSessions === true || snapshot.files.some((file) => file.path.startsWith("sessions/")),
    ...(snapshot.selection === undefined ? {} : { selection: snapshot.selection }),
  };
}

export function remoteHistoryEntry(pointer: LatestPointer): RemoteHistoryEntry {
  return {
    snapshotRef: pointer.snapshot,
    snapshotId: pointer.snapshot,
    createdAt: pointer.createdAt,
    machine: pointer.machine,
    syncSessions: pointer.syncSessions === true,
  };
}
