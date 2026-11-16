import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { setSyncSetupCompletions } from "../commands/command.js";
import { piDaemonClient } from "../daemon/pi-client.js";
import { isMissingConfigError } from "../settings/config-errors.js";
import type { AnySyncConfig, PiSyncSettingsV3 } from "../settings/settings-types.js";
import { configureSyncStatus } from "../ui/sync-status.js";
import { safeTerminalText } from "../ui/terminal-text.js";
import { throwIfAborted } from "./signals.js";
import { createStartupTimings, type StartupTimingPublisher } from "./startup-timings.js";
import { errorMessage } from "./sync-errors.js";
import type { SyncLoaders } from "./sync-loaders.js";

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
  const document = await timings.measure("settings read", () => client.readSettings());
  throwIfAborted(signal);
  configureSyncStatus(ctx, (document?.parsed.showStatus as boolean | undefined) ?? true);
  const { stateDirectoryMigrationNotice } = await import("../state/state-directory.js");
  const notice = stateDirectoryMigrationNotice();
  const { pendingTransactionEntries } = await import("../snapshot/snapshot-transaction-directory.js");
  const recoveryNeeded = (await pendingTransactionEntries()).some((entry) => entry.isDirectory());
  throwIfAborted(signal);
  if (!(await client.configured()) && !recoveryNeeded) {
    if (notice) ctx.ui.notify(notice, "warning");
    setSyncSetupCompletions([]);
    const debug = document?.parsed.debug === true;
    await client.markReady(debug);
    timings.publish(ctx, debug, signal, "local initialization", "completed");
    return { debug };
  }
  throwIfAborted(signal);
  const result = (await client.run("initialize", {}, signal)) as {
    debug: boolean;
    config?: AnySyncConfig;
    settings?: PiSyncSettingsV3;
    handoverRequired: boolean;
  };
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
    if (!(await client.configured())) return;
    throwIfAborted(signal);
    await client.run(
      "shutdown",
      { args: [], yes: true, force: false, stale: false, silent: true, reload: false },
      signal,
    );
  } catch (error) {
    if (signal.aborted || isMissingConfigError(error)) return;
    ctx.ui.notify(`pi-sync session push skipped: ${safeTerminalText(errorMessage(error))}`, "warning");
  }
}
