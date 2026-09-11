export interface SyncState {
  version: number;
  profile: string;
  lastAppliedSnapshot?: string;
  lastRemoteRevision?: string;
  lastRemoteEtag?: string;
  lastFileHashes: Record<string, string>;
  include?: string[];
  /** Legacy state fields are read only so v3 can detect and replace stale policy state. */
  syncFiles?: string[];
  syncSessions?: boolean;
  extraFiles?: string[];
}

export interface LockFile {
  id: string;
  pid: number;
  command: string;
  startedAt: string;
}
