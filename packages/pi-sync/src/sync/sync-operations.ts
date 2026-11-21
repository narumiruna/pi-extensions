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
export async function status(ctx: ExtensionContext, options: CommandOptions) {
  await remoteOperation(ctx, "status", options);
}
export async function diff(ctx: ExtensionContext, options: CommandOptions) {
  await remoteOperation(ctx, "diff", options);
}
export async function doctor(ctx: ExtensionContext, options: CommandOptions) {
  await remoteOperation(ctx, "doctor", options);
}
export async function history(ctx: ExtensionContext, options: CommandOptions) {
  await remoteOperation(ctx, "history", options);
}
