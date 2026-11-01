import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { vi } from "vitest";
import { loadConfig } from "../src/settings/config.js";
import { localConfigPath } from "../src/settings/config-file.js";
import type { PiSyncSettingsV3 } from "../src/settings/settings-types.js";
import { createSnapshot } from "../src/snapshot/snapshot.js";
import { stageMergeBaseline } from "../src/state/merge-baseline-store.js";
import { readStateForConfig } from "../src/state/sync-state-store.js";
import { inspectSync } from "../src/sync/sync-inspection.js";
import { createSyncLoaders, type SyncDependencies } from "../src/sync/sync-loaders.js";
import { syncBoth } from "../src/sync/sync-mutations.js";
import type { MemorySyncBackend } from "./memory-sync-backend.js";

export function requiredHome(settings: PiSyncSettingsV3) {
  const setup = settings.syncSetups.home;
  assert.ok(setup);
  return setup;
}

export async function enableContinuous() {
  const settings = JSON.parse(await fs.readFile(localConfigPath(), "utf8"));
  Object.assign(settings.syncSetups.home.sync, { continuous: true, agentMode: true });
  await fs.writeFile(localConfigPath(), JSON.stringify(settings));
  const config = await loadConfig();
  await stageMergeBaseline(
    config,
    await createSnapshot(config.snapshotIdentity, { include: config.include }),
    await readStateForConfig(config),
  );
  return config;
}
export function continuousDependencies(
  backend: MemorySyncBackend,
  overrides: Partial<SyncDependencies> = {},
): Partial<SyncDependencies> {
  return {
    loadSyncInspection: async () => ({
      inspectSync: (config, options, signal, _factory, timings) =>
        inspectSync(config, options, signal, () => backend, timings),
    }),
    loadSyncOperations: async () => ({
      ...(await import("../src/sync/sync-operations.js")),
      syncBoth: (ctx, options) => syncBoth(ctx, options, () => backend),
    }),
    ...overrides,
  };
}
export function continuousLoaders(backend: MemorySyncBackend, overrides: Partial<SyncDependencies> = {}) {
  return createSyncLoaders(continuousDependencies(backend, overrides));
}
export async function waitStatus(statuses: ReadonlyMap<string, string | undefined>, expected: RegExp) {
  await vi.waitFor(() => assert.match(statuses.get("sync") ?? "", expected), { timeout: 1500, interval: 5 });
}
/** Advance time in bounded steps and let real filesystem callbacks drain between heartbeats. */
export async function advanceContinuous(ms: number) {
  for (let elapsed = 0; elapsed < ms; elapsed += 1000) {
    await vi.advanceTimersByTimeAsync(Math.min(1000, ms - elapsed));
    for (let pass = 0; pass < 3; pass++) await fs.stat(localConfigPath());
  }
}
export function fakeContinuousTime() {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
}
