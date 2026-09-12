type SetupSwitchModule = Pick<typeof import("./setup-switch.js"), "useSyncSetup">;
type SnapshotModule = Pick<typeof import("../snapshot/snapshot.js"), "createSnapshot">;
type SyncStateModule = Pick<typeof import("./sync-state.js"), "hasLocalChanges">;
type SyncOperations = typeof import("./sync-operations.js");

type SyncInspectionModule = Pick<typeof import("./sync-inspection.js"), "inspectSync">;

export interface SyncDependencies {
  loadSyncInspection(): Promise<SyncInspectionModule>;
  loadSetupSwitch(): Promise<SetupSwitchModule>;
  loadSnapshot(): Promise<SnapshotModule>;
  loadSyncState(): Promise<SyncStateModule>;
  loadSyncOperations(): Promise<SyncOperations>;
}

export interface SyncLoaders {
  inspection(): Promise<SyncInspectionModule>;
  setupSwitch(): Promise<SetupSwitchModule>;
  snapshot(): Promise<SnapshotModule>;
  syncState(): Promise<SyncStateModule>;
  operations(): Promise<SyncOperations>;
}

export function createSyncLoaders(dependencies: Partial<SyncDependencies>): SyncLoaders {
  const loaders: SyncLoaders = {
    inspection: cachedModuleLoader(dependencies.loadSyncInspection ?? (() => import("./sync-inspection.js"))),
    setupSwitch: cachedModuleLoader(dependencies.loadSetupSwitch ?? (() => import("./setup-switch.js"))),
    snapshot: cachedModuleLoader(dependencies.loadSnapshot ?? (() => import("../snapshot/snapshot.js"))),
    syncState: cachedModuleLoader(dependencies.loadSyncState ?? (() => import("./sync-state.js"))),
    operations: cachedModuleLoader(dependencies.loadSyncOperations ?? (() => import("./sync-operations.js"))),
  };
  return loaders;
}

function cachedModuleLoader<Module>(load: () => Promise<Module>): () => Promise<Module> {
  let pending: Promise<Module> | undefined;
  return () => {
    if (!pending) {
      pending = load().catch((error) => {
        pending = undefined;
        throw error;
      });
    }
    return pending;
  };
}
