import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { CommandOptions } from "../commands/command-types.js";
import { remoteOperation } from "../daemon/pi-client.js";
export async function showConflicts(ctx: ExtensionContext, options: CommandOptions) {
  await remoteOperation(ctx, "conflicts", options);
}
