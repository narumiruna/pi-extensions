import { isDeepStrictEqual } from "node:util";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { requireSettings, updateLocalConfig } from "../settings/settings-store.js";
import { captureMutationOwner } from "../sync/sync-local.js";
import { confirmMergeReview } from "./merge-review.js";
import { safeTerminalText } from "./terminal-text.js";

export const AGENT_MODE_DESCRIPTION =
  "This setup: sync eligible changes at session startup and on Sync now without transfer confirmation. Use the selected Pi model to resolve supported text and settings conflicts. Eligible conflict content may be sent to its provider and incur costs. Selected local and remote content can be replaced or deleted. Unresolved conflicts pause unless partial sync permits independent progress. Continuous sync is a separate opt-in. No automatic reload.";

export const CONTINUOUS_DESCRIPTION =
  "This setup: recurring sync while Pi is open. Requires Autonomous sync. Watches selected files, checks the remote every 60–66 seconds, and retries temporary failures. Local changes and retries can cause extra requests between polls. May disclose conflict text and incur model/storage costs. No automatic reload.";

export function saveContinuousMode(
  ctx: ExtensionCommandContext,
  setupName: string,
  enabled: boolean,
  signal?: AbortSignal,
) {
  return saveAgentMode(ctx, setupName, enabled, signal, "continuous");
}

export async function saveAgentMode(
  ctx: ExtensionCommandContext,
  setupName: string,
  enabled: boolean,
  signal?: AbortSignal,
  preference: "agentMode" | "continuous" = "agentMode",
) {
  const validate = captureMutationOwner(ctx, signal);
  const settings = await requireSettings();
  validate();
  const setup = settings.syncSetups[setupName];
  if (!setup || settings.activeSyncSetup !== setupName) throw new Error("Current sync setup changed; reopen Settings.");
  const continuous = preference === "continuous";
  const label = continuous ? "Continuous sync" : "Autonomous sync";
  if (enabled && continuous && !setup.sync.agentMode) throw new Error("Enable Autonomous sync before Continuous sync.");
  if (Boolean(setup.sync[preference]) === enabled) return true;
  if (enabled) {
    const summary = [
      `Setup: ${safeTerminalText(setupName)}`,
      `Storage connection: ${safeTerminalText(setup.storage.connection)}`,
      `Storage path: ${safeTerminalText(setup.storage.path)}`,
      ...(setup.storage.bucket ? [`Bucket: ${safeTerminalText(String(setup.storage.bucket))}`] : []),
      ...(setup.storage.branch ? [`Branch: ${safeTerminalText(String(setup.storage.branch))}`] : []),
      `Included paths: ${setup.sync.include.map(safeTerminalText).join(", ")}`,
      continuous ? CONTINUOUS_DESCRIPTION : AGENT_MODE_DESCRIPTION,
      ...(continuous
        ? [
            "Upgrade all Pi processes sharing this agent directory before enabling Continuous sync. Monitoring starts after the /sync command or manager closes. An elected idle local session uses its selected Pi model; another session can use a different provider/model. Each computer is a separate replica.",
            "Automatic requests are limited to two per candidate and two per replica binding in a rolling 15-minute window, across restarts. Network/storage checks and requests may incur costs. Retries start at five seconds and grow to five minutes. These are request bounds, not a currency cap.",
          ]
        : setup.sync.continuous
          ? ["The saved Continuous sync preference will resume monitoring after the /sync command or manager closes."]
          : []),
      "Only bounded Markdown/plain-text conflicts and atomic global settings choices are eligible. Model errors can change intended behavior. Session histories, code, deletion conflicts and path collisions are not model-resolved.",
      "The existing baseline, selection, secret-scan and publication checks remain. Pi Sync cannot exclude arbitrary concurrent local writers. Disabling does not undo completed transfers or provider charges. No transfer starts from Settings.",
    ].join("\n\n");
    if (
      !(await confirmMergeReview(
        ctx,
        `Enable ${label}?`,
        summary,
        signal,
        () => !signal?.aborted,
        `Enable ${label}`,
        summary.split("\n"),
      ))
    )
      return false;
    validate();
  }
  await updateLocalConfig((current) => {
    validate();
    if (
      current.activeSyncSetup !== setupName ||
      !isDeepStrictEqual(current.syncSetups[setupName], setup) ||
      !isDeepStrictEqual(
        current.storageConnections[setup.storage.connection],
        settings.storageConnections[setup.storage.connection],
      )
    )
      throw new Error("Sync setup or connection changed during Autonomous sync review; reopen Settings.");
    return {
      ...current,
      syncSetups: { ...current.syncSetups, [setupName]: { ...setup, sync: { ...setup.sync, [preference]: enabled } } },
    };
  }, signal);
  // The atomic writer has committed. Later cancellation cannot undo this save.
  return true;
}
