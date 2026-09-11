import type { SnapshotSelection } from "../snapshot/snapshot-types.js";
/** Backend-only resolved S3 connection fields. */
export interface ResolvedS3StorageProfile {
  kind: "r2" | "s3-compatible";
  endpoint: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

/** Backend-only coordinates. `prefix` is the complete reviewed v3 storage path. */
export interface ResolvedS3Destination {
  bucket: string;
  prefix: string;
  /** Snapshot/wire identity; never derived from the local setup name. */
  namespace: string;
}

export interface ResolvedS3Backend {
  type: "s3";
  profile: ResolvedS3StorageProfile;
  destination: ResolvedS3Destination;
}

export interface ResolvedWebDavStorageProfile {
  kind: "webdav";
  url: string;
  username: string;
  password: string;
}

/** Backend-only coordinates. `path` is the complete reviewed v3 storage path. */
export interface ResolvedWebDavDestination {
  path: string;
  namespace: string;
}

export interface ResolvedWebDavBackend {
  type: "webdav";
  profile: ResolvedWebDavStorageProfile;
  destination: ResolvedWebDavDestination;
}

export interface ResolvedGitStorageProfile {
  kind: "git";
  remote: string;
}

/** Backend-only coordinates. `directory` is the complete reviewed v3 storage path. */
export interface ResolvedGitDestination {
  branch: string;
  directory: string;
  namespace: string;
}

export interface ResolvedGitBackend {
  type: "git";
  profile: ResolvedGitStorageProfile;
  destination: ResolvedGitDestination;
}

export type ResolvedSyncBackend = ResolvedS3Backend | ResolvedWebDavBackend | ResolvedGitBackend;

export interface LatestPointer {
  version: number;
  profile: string;
  snapshot: string;
  sha256: string;
  createdAt: string;
  machine: string;
  syncSessions?: boolean;
  /** Lightweight projection; the immutable snapshot remains authoritative. */
  selection?: SnapshotSelection;
}

export interface RemoteObject<T> {
  value?: T;
  etag?: string;
  missing: boolean;
}
