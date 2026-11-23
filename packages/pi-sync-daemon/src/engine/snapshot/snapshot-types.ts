export interface SnapshotFileHash {
  path: string;
  sha256: string;
}

export interface SnapshotFile extends SnapshotFileHash {
  contentBase64: string;
}

export interface SnapshotObservation {
  scope: DirectoryScope["scope"];
  files: Array<SnapshotFileHash & { settingsContent?: Buffer }>;
}

export interface EffectiveIgnorePolicy {
  filename: string;
  sourceDigest: string;
  fingerprint: string;
  sessions: boolean;
  reservedNames: readonly string[];
  matches(path: string, directory?: boolean): boolean;
}

export interface DirectoryScope {
  scope?: "agent-directory";
  reinclude?: readonly string[];
  ignorePolicy?: EffectiveIgnorePolicy;
  reservedIgnoreNames?: readonly string[];
}

export const IGNORE_SNAPSHOT_VERSION = 6;
export const RULES_SNAPSHOT_VERSION = 7;

export function isIgnoreSnapshotVersion(version: unknown) {
  return version === IGNORE_SNAPSHOT_VERSION || version === RULES_SNAPSHOT_VERSION;
}

export function isSupportedSnapshotVersion(version: unknown) {
  return (
    version === 1 ||
    version === 2 ||
    version === 3 ||
    version === 4 ||
    version === 5 ||
    isIgnoreSnapshotVersion(version)
  );
}

export interface IgnoreSnapshotSelection {
  version: 4;
  scope: "agent-directory";
  fingerprint: string;
  sessions: boolean;
  include?: never;
  exclude?: never;
  reinclude?: never;
}

export type SnapshotSelection =
  | { version: 1; include: string[]; exclude?: never; scope?: never; reinclude?: never }
  | { version: 2; include: string[]; exclude: string[]; scope?: never; reinclude?: never }
  | { version: 3; scope: "agent-directory"; include: string[]; exclude: string[]; reinclude: string[] }
  | IgnoreSnapshotSelection;

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
  ignoreRules?: { filename: string; text: string } | null;
  localFields?: string[];
  files: SnapshotFile[];
}

export interface AgentDirectoryInventory {
  root: string;
  sessionRoot: string;
  scanSessions: boolean;
  entries: ReadonlyMap<string, "file" | "directory" | "unreviewed">;
  fileSizes: ReadonlyMap<string, number>;
  walkedDirectories: ReadonlySet<string>;
  routingDirectories: ReadonlySet<string>;
}

export interface SnapshotOptions extends DirectoryScope {
  setupName?: string;
  recoverySetupKey?: string;
  ignoreSourceIdentity?: string;
  signal?: AbortSignal;
  /** Caller-owned session/generation guard, rechecked at file-mutation boundaries. */
  validateMutation?: () => void;
  validateIgnorePolicy?: () => Promise<void>;
  validateApplyReview?: () => Promise<void>;
  /** Reviewed regular-file preimages; null means the path was absent. Checked under mutation queues. */
  expectedFileHashes?: Readonly<Record<string, string | null>>;
  include?: string[];
  exclude?: string[];
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
