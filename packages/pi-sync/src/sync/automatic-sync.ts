import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { setSyncSetupCompletions } from "../commands/command.js";
import { piDaemonClient } from "../daemon/pi-client.js";
import { configFromSettings, loadConfigForCheck, syncCheckConfigFingerprint } from "../settings/config.js";
import { isMissingConfigError } from "../settings/config-errors.js";
import type { AnySyncConfig, PiSyncSettingsV3 } from "../settings/settings-types.js";
import { configureSyncStatus } from "../ui/sync-status.js";
import { safeTerminalText } from "../ui/terminal-text.js";
import { throwIfAborted } from "./signals.js";
import { createStartupTimings, type StartupTimingPublisher } from "./startup-timings.js";
import { errorMessage } from "./sync-errors.js";
import type { SyncLoaders } from "./sync-loaders.js";
import { syncSessionsSelected } from "./sync-policy.js";

export async function startSession(
  ctx: ExtensionContext,
  signal: AbortSignal,
  publish?: StartupTimingPublisher,
): Promise<{ debug: boolean; config?: AnySyncConfig } | undefined> {
  throwIfAborted(signal);
  const client = piDaemonClient(ctx);
  // One-off sessions only protect their files in an already existing service.
  // They never launch it or authorize observations, transfers, or model work.
  if (!ctx.hasUI || !["tui", "rpc"].includes(ctx.mode)) {
    await client.attachExisting();
    throwIfAborted(signal);
    return { debug: false };
  }
  const timings = createStartupTimings(publish);
  let showLocalTimings = false;
  let localStartupComplete = false;
  try {
    const { document, settings } = await timings.measure("settings read", () => client.readStartupSettings(signal));
    client.validate();
    throwIfAborted(signal);
    const debug = settings?.debug ?? false;
    client.setDebugPreference(debug);
    configureSyncStatus(ctx, settings?.showStatus ?? true);
    const { stateDirectoryMigrationNotice } = await import("../state/state-directory.js");
    client.validate();
    throwIfAborted(signal);
    const notice = stateDirectoryMigrationNotice();
    if (settings?.activeSyncSetup && document) {
      const ready = !notice && (await client.tryStartupBootstrap(document, debug, signal));
      client.validate();
      throwIfAborted(signal);
      if (ready) {
        setSyncSetupCompletions(Object.keys(settings.syncSetups).sort((a, b) => a.localeCompare(b)));
        showLocalTimings = debug;
        localStartupComplete = true;
        return { debug, config: configFromSettings(settings) };
      }
    } else {
      const { pendingTransactionEntries } = await import("../snapshot/snapshot-transaction-directory.js");
      const recoveryNeeded = (await pendingTransactionEntries()).length > 0;
      client.validate();
      throwIfAborted(signal);
      if (!recoveryNeeded) {
        if (notice) ctx.ui.notify(notice, "warning");
        setSyncSetupCompletions([]);
        await client.markReady(debug);
        client.validate();
        throwIfAborted(signal);
        client.recordDebug({ event: "job", operation: "initialize", outcome: "skipped" });
        showLocalTimings = debug;
        localStartupComplete = true;
        return { debug };
      }
    }
    localStartupComplete = true;
  } finally {
    timings.publish(
      ctx,
      showLocalTimings,
      signal,
      "local initialization",
      localStartupComplete ? "completed" : "stopped",
      client.debugEnabled && !signal.aborted
        ? (report) => client.recordDebug({ event: "startup-timings", report })
        : undefined,
    );
  }
  const result = (await client.run("initialize", {}, signal)) as {
    debug: boolean;
    config?: AnySyncConfig;
    settings?: PiSyncSettingsV3;
    handoverRequired: boolean;
  };
  client.validate();
  throwIfAborted(signal);
  configureSyncStatus(ctx, result.settings?.showStatus ?? true);
  setSyncSetupCompletions(Object.keys(result.settings?.syncSetups ?? {}).sort((a, b) => a.localeCompare(b)));
  await client.markReady(result.debug);
  throwIfAborted(signal);
  if (result.handoverRequired) {
    ctx.ui.notify(
      "pi-sync: close or upgrade older Pi processes, then use /sync to review daemon handover. No automatic transfer is authorized yet.",
      "warning",
    );
    return { debug: result.debug };
  }
  return { debug: result.debug, config: result.config };
}
export async function autoPushSessions(ctx: ExtensionContext, signal: AbortSignal, _loaders: SyncLoaders) {
  try {
    const client = piDaemonClient(ctx);
    const eligible = (config: AnySyncConfig) => config.automatic && syncSessionsSelected(config);
    if (!(await client.configured((settings) => eligible(configFromSettings(settings))))) {
      client.recordDebug({ event: "job", operation: "shutdown", outcome: "skipped" });
      return;
    }
    throwIfAborted(signal);
    const config = await loadConfigForCheck(undefined, signal);
    throwIfAborted(signal);
    if (!eligible(config)) {
      client.recordDebug({ event: "job", operation: "shutdown", outcome: "skipped" });
      return;
    }
    const automaticFingerprint = syncCheckConfigFingerprint(config);
    await client.run(
      "shutdown",
      { args: [], yes: true, force: false, stale: false, silent: true, reload: false, automaticFingerprint },
      signal,
    );
  } catch (error) {
    if (signal.aborted || isMissingConfigError(error)) return;
    ctx.ui.notify(`pi-sync session push skipped: ${safeTerminalText(errorMessage(error))}`, "warning");
  }
}
