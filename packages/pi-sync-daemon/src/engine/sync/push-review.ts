import type { RemoteHead, SyncBackend } from "../backends/sync-backend.js";
import type { CommandOptions } from "../commands/command-types.js";
import type { EngineContext } from "../host.js";
import type { AnySyncConfig } from "../settings/settings-types.js";
import { snapshotIncludesSessions } from "../snapshot/snapshot.js";
import type { Snapshot } from "../snapshot/snapshot-types.js";
import { formatRuleChanges } from "../ui/ignore-rule-preview.js";
import { countPreservedRemoteFiles, formatPushSummary, formatTransferReview } from "../ui/sync-format.js";
import { setSyncStatus } from "../ui/sync-status.js";
import { confirmTransferReview } from "../ui/transfer-review.js";
import { ignorePublicationNotice } from "./ignore-publication.js";
import { throwIfAborted } from "./signals.js";
import { formatIgnorePolicyComparison, inspectRemoteSelection } from "./sync-policy.js";

export async function confirmPush(
  ctx: EngineContext,
  options: CommandOptions,
  config: AnySyncConfig,
  backend: SyncBackend,
  local: Snapshot,
  upload: Snapshot,
  head: RemoteHead | undefined,
  remote: Snapshot | undefined,
  validateMutation: () => void,
  title = snapshotIncludesSessions(upload) ? "Push pi settings and sessions?" : "Push pi settings?",
) {
  validateMutation();
  if (options.yes) return true;
  const summary = formatPushSummary(
    config,
    backend.destination,
    upload,
    head,
    countPreservedRemoteFiles(local, upload),
    remote,
  );
  const comparison =
    config.ignorePolicy && remote
      ? inspectRemoteSelection(config.include, remote, config.exclude, config).ignorePolicyComparison
      : undefined;
  const notice = ignorePublicationNotice(upload);
  const overwrite = comparison !== undefined && comparison !== "match";
  const confirmed = await confirmTransferReview(
    ctx,
    overwrite ? "Overwrite remote policy and push?" : title,
    formatTransferReview(
      ...(overwrite
        ? [
            formatIgnorePolicyComparison(comparison),
            "This replaces the remote policy with this device's rules. Remote rules are not adopted on this device.",
            `Sessions opt-in: ${remote?.selection?.version === 4 ? (remote.selection.sessions ? "on" : "off") : "legacy"} → ${config.ignorePolicy?.sessions ? "on" : "off"}.`,
            formatRuleChanges(remote?.ignoreRules?.text, upload.ignoreRules?.text),
          ]
        : []),
      ...(notice ? [notice, ""] : []),
      summary,
    ),
    options.signal,
    validateMutation,
  );
  throwIfAborted(options.signal);
  if (confirmed) return true;
  setSyncStatus(ctx, undefined);
  ctx.ui.notify("Push cancelled.", "info");
  return false;
}
