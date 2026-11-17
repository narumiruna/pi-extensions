import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { CommandOptions } from "../commands/command-types.js";
import { remoteOperation } from "../daemon/pi-client.js";
import type { SetupPullOutcome } from "./setup-switch.js";

async function transfer(
  ctx: ExtensionContext,
  operation: string,
  options: CommandOptions,
): Promise<SetupPullOutcome | undefined> {
  const result = await remoteOperation(ctx, operation, options);
  if (result === undefined || result === "applied" || result === "cancelled") return result;
  throw new Error("Invalid transfer result from pi-sync-daemon.");
}
export const push = (ctx: ExtensionContext, options: CommandOptions) => transfer(ctx, "push", options);
export const pull = (ctx: ExtensionContext, options: CommandOptions) => transfer(ctx, "pull", options);
export const syncBoth = (ctx: ExtensionContext, options: CommandOptions) =>
  transfer(ctx, options.auto ? "startup-transfer" : "sync", options);
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
