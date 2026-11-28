import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { CommandOptions } from "../commands/command-types.js";
import { remoteOperation } from "../daemon/pi-client.js";
import type { SetupPullOutcome } from "./setup-switch.js";

function transferResult(result: unknown): SetupPullOutcome | undefined {
  if (result === undefined || result === "applied" || result === "cancelled") return result;
  throw new Error("Invalid transfer result from pi-sync-daemon.");
}
export const push = async (ctx: ExtensionContext, options: CommandOptions) =>
  transferResult(await remoteOperation(ctx, "push", options));
export const pull = async (ctx: ExtensionContext, options: CommandOptions) =>
  transferResult(await remoteOperation(ctx, "pull", options));
export async function syncBoth(ctx: ExtensionContext, options: CommandOptions) {
  const result = await remoteOperation(ctx, options.auto ? "startup-transfer" : "sync", options);
  if (
    result === "archived" &&
    !options.auto &&
    !options.agentRetryRefusal &&
    !options.yes &&
    ctx.hasUI &&
    (ctx.mode === "tui" || ctx.mode === "rpc")
  )
    return result;
  return transferResult(result);
}
export async function rollback(ctx: ExtensionContext, options: CommandOptions) {
  await remoteOperation(ctx, "rollback", options);
}
export function diff(ctx: ExtensionContext, options: CommandOptions) {
  if (ctx.mode !== "tui" || !ctx.hasUI) return remoteOperation(ctx, "diff", options).then(() => {});
  return Promise.all([import("../daemon/diff-review.js"), import("../ui/diff-review.js")]).then(
    ([{ openDiffReview }, { showSyncDiffReview }]) => {
      options.signal?.throwIfAborted();
      return showSyncDiffReview(
        ctx,
        (signal) => openDiffReview(ctx, options.setup, options.diffReviewFingerprint, signal),
        options.signal,
      );
    },
  );
}
export async function history(ctx: ExtensionContext, options: CommandOptions) {
  await remoteOperation(ctx, "history", options);
}
