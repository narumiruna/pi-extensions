import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { inspectDaemonStatus } from "@narumitw/pi-sync-daemon";
import { errorMessage } from "../sync/sync-errors.js";
import { safeTerminalText } from "../ui/terminal-text.js";
import type { PiDaemonClient } from "./pi-client.js";

export async function showDaemonStatus(ctx: ExtensionContext, client: PiDaemonClient, signal?: AbortSignal) {
  let attachedInstance: string | undefined;
  let connectionError: string | undefined;
  try {
    attachedInstance = (await client.verifyConnection(signal)).identity.instance;
  } catch (error) {
    connectionError = safeTerminalText(errorMessage(error).slice(0, 1200));
  }
  signal?.throwIfAborted();
  client.validate();
  const status = await inspectDaemonStatus(client.root, signal);
  signal?.throwIfAborted();
  client.validate();
  if (!ctx.hasUI) return;
  const connected = status.running === true && status.instance === attachedInstance;
  const recovery = client.ownershipCleanupRequired || status.pendingUpgradePid !== undefined;
  const state = connected
    ? "connected"
    : status.running
      ? "running; not connected"
      : status.running === null
        ? "owner could not be verified"
        : "not running";
  const lines = [`pi-sync-daemon: ${state}${recovery ? "; recovery required" : ""}`];
  if (status.running) {
    lines.push(`PID: ${status.pid}`, `Instance: ${status.instance}`);
    lines.push(`Running build: ${formatBuild(status.buildVersion, status.buildId)}`);
  }
  lines.push(`Expected build: ${formatBuild(status.expectedBuildVersion, status.expectedBuildId)}`);
  if (status.pendingUpgradePid !== undefined) lines.push(`Pending replacement PID: ${status.pendingUpgradePid}`);
  const blocked = status.running ? client.blockedUpgradeReason(status.instance) : undefined;
  if (blocked) lines.push(`Upgrade blocked: ${blocked.slice(0, 1200)}`);
  else if (connectionError) lines.push(`Connection: ${connectionError}`);
  if (client.ownershipCleanupRequired) lines.push("Use /sync daemon recover to review and stop the daemon.");
  else if (recovery || status.running === null)
    lines.push("Check daemon CLI status and follow daemon recovery. Do not force a restart.");
  else if (status.running && (status.buildComparison === "older" || status.buildComparison === "unversioned"))
    lines.push("Daemon upgrade is required. Follow any blocker above, then use /reload.");
  else if (status.running && status.buildComparison === "different")
    lines.push("Same version, different build. Use the intended build's daemon CLI restart, then /reload.");
  else if (status.running && status.buildComparison === "unverified")
    lines.push(
      "Build match is unverified. Use the intended build's daemon CLI to inspect or explicitly restart, then /reload.",
    );
  else if (status.running && status.buildComparison === "newer")
    lines.push("The running daemon is newer than the loaded build. It was left unchanged.");
  else lines.push("Use pi-sync-daemon status/stop/restart --root <agent-directory> for explicit lifecycle control.");
  ctx.ui.notify(lines.join("\n"), connected && !recovery ? "info" : "warning");
}

function formatBuild(version?: string, id?: string) {
  return `${version ?? "unknown version"} (${id?.slice(0, 12) ?? "unknown build ID"})`;
}
