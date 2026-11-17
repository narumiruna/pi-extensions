import { createEngineLoaders, type SyncLoaders } from "@narumitw/pi-sync-daemon/engine/sync/sync-loaders";

export interface EngineTestDependencies {
  loadSyncInspection: SyncLoaders["inspection"];
  loadSyncOperations: SyncLoaders["operations"];
  loadSnapshot: SyncLoaders["snapshot"];
  loadSyncState: SyncLoaders["syncState"];
}
/** Inject domain fixtures into the authoritative engine, not its IPC adapter. */
export function createEngineTestLoaders(dependencies: Partial<EngineTestDependencies> = {}): SyncLoaders {
  const defaults = createEngineLoaders();
  return {
    inspection: dependencies.loadSyncInspection ?? defaults.inspection,
    operations: dependencies.loadSyncOperations ?? defaults.operations,
    snapshot: dependencies.loadSnapshot ?? defaults.snapshot,
    syncState: dependencies.loadSyncState ?? defaults.syncState,
  };
}
