import type { inspectSync as engineInspectSync } from "@narumitw/pi-sync-daemon/engine/sync/sync-inspection";
import { currentPiDaemonClient } from "../daemon/pi-client.js";
import { syncCheckConfigFingerprint } from "../settings/config.js";
import type { AnySyncConfig } from "../settings/settings-types.js";

export type { StartupObservation, SyncInspection } from "@narumitw/pi-sync-daemon/engine/sync/sync-inspection";
export const inspectSync: typeof engineInspectSync = async (config: AnySyncConfig, _options, signal) =>
  (await currentPiDaemonClient().run(
    "inspect",
    { setup: config.setupName, fingerprint: syncCheckConfigFingerprint(config) },
    signal,
  )) as Awaited<ReturnType<typeof engineInspectSync>>;
