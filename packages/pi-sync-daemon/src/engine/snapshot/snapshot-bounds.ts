import { assertAgentDirectoryPathLayout } from "../sync/sync-policy.js";
import { snapshotBase64Size } from "./snapshot-payload.js";
import type { SnapshotFile } from "./snapshot-types.js";

export const MAX_AGENT_DIRECTORY_BYTES = 64 * 1024 * 1024;
const MAX_AGENT_DIRECTORY_SETTINGS_BYTES = 1024 * 1024;

export function assertAgentDirectorySettingsSize(bytes: number) {
  if (bytes > MAX_AGENT_DIRECTORY_SETTINGS_BYTES)
    throw new Error("Pi settings.json exceeds the 1 MiB session metadata byte bound.");
}

export function assertAgentDirectorySnapshotBound(files: readonly SnapshotFile[]) {
  assertAgentDirectoryPathLayout(files.map((file) => file.path));
  let bytes = 0;
  for (const file of files) {
    const size = snapshotBase64Size(file.contentBase64, file.path);
    if (file.path.toLowerCase() === "settings.json") assertAgentDirectorySettingsSize(size);
    bytes += size;
    if (bytes > MAX_AGENT_DIRECTORY_BYTES)
      throw new Error("Projected agent directory exceeds the 64 MiB scan byte bound.");
  }
}
