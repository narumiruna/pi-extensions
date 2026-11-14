export interface SnapshotFile {
  path: string;
  contentBase64: string;
  sha256: string;
}

export type SnapshotSelection =
  | { version: 1; include: string[]; ignore?: never }
  | { version: 2; ignore: string; include?: never };

export interface Snapshot {
  version: number;
  id: string;
  createdAt: string;
  machine: string;
  /** Backend-scoped remote identity retained in the snapshot wire format. */
  profile: string;
  syncSessions?: boolean;
  /** Portable, credential-free file-selection intent. Absent on legacy snapshots. */
  selection?: SnapshotSelection;
  localFields?: string[];
  files: SnapshotFile[];
}

export interface SnapshotOptions {
  signal?: AbortSignal;
  /** Caller-owned session/generation guard, rechecked at file-mutation boundaries. */
  validateMutation?: () => void;
  /** Reviewed regular-file preimages; null means the path was absent. Checked under mutation queues. */
  expectedFileHashes?: Readonly<Record<string, string | null>>;
  include?: string[];
  /** Defined only for agent-root .syncignore mode; empty text means no user exclusions. */
  syncIgnore?: string;
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
