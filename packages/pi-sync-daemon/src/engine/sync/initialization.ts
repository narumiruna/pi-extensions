import type { EngineContext } from "../host.js";
import { loadConfig } from "../settings/config.js";
import { isMissingConfigError } from "../settings/config-errors.js";
import { consumeLocalConfigMigrationNotice } from "../settings/config-file.js";
import { readLocalConfigObject } from "../settings/settings-store.js";
import { sessionDirFromContext } from "../snapshot/session-paths.js";
import { pendingTransactionEntries } from "../snapshot/snapshot-transaction-directory.js";
import { stateDirectoryMigrationNotice, withStateDirectoryAccess } from "../state/state-directory.js";
import { captureMutationOwner } from "./mutation-owner.js";
import { createStartupTimings, type StartupTimingPublisher } from "./startup-timings.js";
import { errorMessage } from "./sync-errors.js";

/** Shared engine initialization; the caller establishes process handover before recovery. */
export async function initializeSync(ctx: EngineContext, signal: AbortSignal, publish?: StartupTimingPublisher) {
  return withStateDirectoryAccess(async () => {
    const timings = createStartupTimings(publish);
    let debug = false;
    let outcome: "completed" | "stopped" = "stopped";
    try {
      const validate = captureMutationOwner(ctx, signal);
      validate();
      const stateNotice = stateDirectoryMigrationNotice();
      if (stateNotice && ctx.hasUI) ctx.ui.notify(stateNotice, "warning");
      await timings.measure("transaction recovery", async () => {
        const pending = await pendingTransactionEntries();
        validate();
        if (!pending.some((entry) => entry.isDirectory())) return;
        const { recoverSnapshotTransactionsOnStartup } = await import("../snapshot/snapshot-transaction.js");
        validate();
        const settings = await readLocalConfigObject();
        validate();
        const setup = settings?.activeSyncSetup;
        const current = ctx.sessionManager.getSessionFile?.();
        await recoverSnapshotTransactionsOnStartup({
          exclude: setup ? settings.syncSetups[setup]?.sync.exclude : undefined,
          signal,
          sessionDir: sessionDirFromContext(ctx),
          protectedTargets: [...(ctx.protectedSessionFiles ?? []), ...(current ? [current] : [])],
          validateMutation: validate,
        });
      });
      validate();
      let settings: Awaited<ReturnType<typeof readLocalConfigObject>>;
      try {
        settings = await timings.measure("settings read", () => readLocalConfigObject());
        validate();
        debug = settings?.debug ?? false;
      } catch {
        validate();
      }
      const notice = consumeLocalConfigMigrationNotice();
      if (notice && ctx.hasUI) ctx.ui.notify(notice, "warning");
      validate();
      if (!ctx.hasUI) return { debug, settings };
      try {
        const config = await timings.measure("config resolution", () => loadConfig());
        validate();
        outcome = "completed";
        return { debug, settings, config };
      } catch (error) {
        validate();
        if (!isMissingConfigError(error))
          ctx.ui.notify(`pi-sync startup check skipped: ${errorMessage(error)}`, "warning");
      }
      return { debug, settings };
    } finally {
      timings.publish(ctx, debug, signal, "local initialization", outcome);
    }
  });
}
