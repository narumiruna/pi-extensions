import { configuredSyncSetupNames } from "../settings/settings-store.js";
import { setSyncSetupCompletions } from "./command.js";

export async function refreshTargetCompletions() {
  setSyncSetupCompletions(await configuredSyncSetupNames());
}
