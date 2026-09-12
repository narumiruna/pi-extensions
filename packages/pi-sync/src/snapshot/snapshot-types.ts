export interface SnapshotFile {
  path: string;
  contentBase64: string;
  sha256: string;
}

export interface SnapshotSelection {
  version: 1;
  include: string[];
}

export interface Snapshot {
  version: number;
  id: string;
  createdAt: string;
  machine: string;
  /** Backend-scoped remote identity retained in the snapshot wire format. */
  profile: string;
  syncSessions?: boolean;
  /** Portable, credential-free included-content intent. Absent on legacy snapshots. */
  selection?: SnapshotSelection;
  files: SnapshotFile[];
}

export interface SnapshotOptions {
  signal?: AbortSignal;
  include?: string[];
  sessionDir?: string;
  /** Temporary internal projections while snapshot storage remains wire-compatible. */
  syncFiles?: string[];
  syncSessions?: boolean;
  extraFiles?: string[];
}

export interface SnapshotApplyPlan {
  writes: Array<{ target: string; content: Buffer }>;
  deletes: string[];
}
