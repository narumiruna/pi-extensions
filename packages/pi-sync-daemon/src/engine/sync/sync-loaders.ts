export interface SyncLoaders {
  inspection(): Promise<Pick<typeof import("./sync-inspection.js"), "inspectSync">>;
  snapshot(): Promise<Pick<typeof import("../snapshot/snapshot.js"), "createSnapshot">>;
  syncState(): Promise<Pick<typeof import("./sync-state.js"), "hasLocalChanges">>;
  operations(): Promise<typeof import("./sync-operations.js")>;
}
export function createEngineLoaders(): SyncLoaders {
  return {
    inspection: () => import("./sync-inspection.js"),
    snapshot: () => import("../snapshot/snapshot.js"),
    syncState: () => import("./sync-state.js"),
    operations: () => import("./sync-operations.js"),
  };
}
