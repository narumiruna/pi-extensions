import type { RemoteHead, SyncBackend } from "../backends/sync-backend.js";
import type { CommandOptions } from "../commands/command-types.js";
import type { EngineContext } from "../host.js";
import type { AnySyncConfig } from "../settings/settings-types.js";
import { snapshotIncludesSessions } from "../snapshot/snapshot.js";
import type { Snapshot } from "../snapshot/snapshot-types.js";
import { countPreservedRemoteFiles, formatPushSummary, formatTransferReview } from "../ui/sync-format.js";
import { setSyncStatus } from "../ui/sync-status.js";
import { confirmTransferReview } from "../ui/transfer-review.js";
import { throwIfAborted } from "./signals.js";

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
  const confirmed = await confirmTransferReview(
    ctx,
    title,
    formatTransferReview(summary),
    options.signal,
    validateMutation,
  );
  throwIfAborted(options.signal);
  if (confirmed) return true;
  setSyncStatus(ctx, undefined);
  ctx.ui.notify("Push cancelled.", "info");
  return false;
}
