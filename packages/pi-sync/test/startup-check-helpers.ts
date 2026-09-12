import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AnySyncConfig } from "../src/settings/settings-types.js";
import { readStateForConfig, syncStateFingerprint } from "../src/state/sync-state-store.js";
import type { SyncInspection } from "../src/sync/sync-inspection.js";

export function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

export async function inspectionFixture(
  config: AnySyncConfig,
  overrides: Partial<SyncInspection> = {},
): Promise<SyncInspection> {
  return {
    head: {
      snapshotRef: "snapshot",
      snapshotId: "snapshot",
      revision: "revision",
      createdAt: "2026-09-06T00:00:00.000Z",
      machine: "test",
      syncSessions: false,
      selection: { version: 1, include: config.include },
    },
    selectionState: { kind: "same", include: config.include },
    localFiles: 0,
    localChanged: false,
    remoteChanged: false,
    firstSync: false,
    emptyInclude: config.include.length === 0,
    stateIdentity: syncStateFingerprint(await readStateForConfig(config)),
    destination: "test storage",
    capability: "read-check-write-verify",
    ...overrides,
  };
}

/** Resolve only after the controller has completed its post-query reads and cleanup. */
export function contextUi(ctx: ExtensionContext) {
  return ctx.ui;
}

export function observeCheckCompletion(ctx: ExtensionContext) {
  const ui = ctx.ui;
  const completed = deferred();
  const checking = deferred();
  let started = false;
  const setStatus = ui.setStatus.bind(ui);
  ui.setStatus = (key, value) => {
    setStatus(key, value);
    if (key !== "sync") return;
    if (value === "checking in background") {
      started = true;
      checking.resolve();
    } else if (started) completed.resolve();
  };
  return { completed: completed.promise, checking: checking.promise };
}
