import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { runConfirmation } from "@narumitw/pi-tui-kit";
import { inspectOperationAvailability, operationCanRecover } from "../state/operation-availability.js";
import { errorMessage } from "../sync/sync-errors.js";
import type { RunRoute } from "./cancellable-operation.js";
import type { ManagerDescription } from "./manager-state.js";
import { safeTerminalText } from "./terminal-text.js";

export type RecoveryDisposition = "restored" | "stay" | "close";

export async function recoverSyncAccess(
  ctx: ExtensionCommandContext,
  manager: ManagerDescription,
  runRoute: RunRoute,
  sessionSignal: AbortSignal | undefined,
  actionSignal: AbortSignal,
): Promise<RecoveryDisposition> {
  const operation = manager.operation;
  if (!operation || !operationCanRecover(operation)) {
    ctx.ui.notify("Operation status changed. Refresh the manager before retrying recovery.", "warning");
    return "stay";
  }
  const signal = sessionSignal ? AbortSignal.any([sessionSignal, actionSignal]) : actionSignal;
  if (signal.aborted) return "close";
  const unreadable = operation.kind === "recoverable-unreadable";
  const details = unreadable
    ? "Pi-sync cannot verify who owns the unreadable lock. Close other Pi sessions that may be syncing before continuing."
    : `The recorded ${safeTerminalText(operation.lock.command)} operation (pid ${operation.lock.pid}) appears to have stopped. Close other Pi sessions that may still be syncing before continuing.`;
  const confirmation = await runConfirmation(ctx, {
    title: "Restore sync access?",
    message: [
      details,
      "",
      "This removes only the local operation lock.",
      "It does not change settings, local files, sync state, or remote data.",
    ].join("\n"),
    confirmLabel: "Remove local lock and continue",
    cancelLabel: "Cancel",
    signal,
    isCurrent: () => !signal.aborted,
    onError: (_currentCtx, error) => {
      ctx.ui.notify(`Recovery confirmation failed: ${safeTerminalText(errorMessage(error))}`, "error");
    },
  });
  if (confirmation.kind === "stale") return "close";
  if (confirmation.kind === "closed") {
    if (confirmation.reason === "close") return "close";
    if (!signal.aborted) {
      ctx.ui.notify("Recovery cancelled; the local operation lock was not changed.", "info");
    }
    return "stay";
  }
  if (confirmation.kind !== "confirmed") return "stay";
  if (signal.aborted) return "close";
  await runRoute(unreadable ? "unlock --stale" : "unlock", signal);
  if (signal.aborted) return "close";
  const latest = await inspectOperationAvailability();
  if (signal.aborted) return "close";
  return latest.kind === "free" ? "restored" : "stay";
}
