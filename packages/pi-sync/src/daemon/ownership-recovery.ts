import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { inspectDaemonRecovery, stopDaemonForRecovery } from "@narumitw/pi-sync-daemon";
import { errorMessage } from "../sync/sync-errors.js";
import { safeTerminalText } from "../ui/terminal-text.js";
import type { PiDaemonClient } from "./pi-client.js";

export async function recoverDaemonOwnership(
  ctx: ExtensionContext,
  client: Pick<PiDaemonClient, "root" | "validate" | "confirmRecoveryExit">,
  signal: AbortSignal | undefined,
) {
  function current() {
    signal?.throwIfAborted();
    client.validate();
  }
  try {
    current();
    if (!ctx.hasUI || !["tui", "rpc"].includes(ctx.mode)) throw new Error("Daemon recovery requires TUI or RPC mode.");
    const owner = await inspectDaemonRecovery(client.root, signal);
    current();
    if (!owner) {
      ctx.ui.notify("No daemon is running for this agent directory. Use /reload before syncing.", "info");
      return;
    }
    const approved = await ctx.ui.confirm(
      "Stop Pi Sync daemon for recovery?",
      `Agent directory: ${safeTerminalText(owner.root)}\nPID: ${owner.pid}\n\nStop sync work for all Pi sessions using this daemon. This does not start a replacement, remove sync evidence, or retry a transfer.`,
      { signal },
    );
    current();
    if (!approved) return;
    await stopDaemonForRecovery(owner, signal);
    current();
    client.confirmRecoveryExit(owner);
    ctx.ui.notify(
      "Pi Sync daemon exited. Use /reload, then open /sync. If a stale lock remains, choose Restore sync access. Check the sync state before retrying any transfer.",
      "info",
    );
  } catch (error) {
    try {
      current();
    } catch {
      return;
    }
    ctx.ui.notify(
      `Pi Sync daemon recovery could not finish: ${safeTerminalText(errorMessage(error))}\nKeep recovery files. Use /sync daemon recover to review the owner again, or follow the daemon CLI recovery guide.`,
      "error",
    );
  }
}
