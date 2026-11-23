import { getEngineRoot } from "../host.js";
import { readIgnoreSource } from "../ignore/ignore-source.js";
import { selectSnapshotIgnoreRules } from "../ignore/snapshot-ignore-rules.js";
import type { AnySyncConfig } from "../settings/settings-types.js";
import { regenerateSnapshotIdentity } from "../snapshot/snapshot.js";
import { RULES_SNAPSHOT_VERSION, type Snapshot } from "../snapshot/snapshot-types.js";
import { safeTerminalText } from "../ui/terminal-text.js";

export async function withPublishedIgnoreRules(
  snapshot: Snapshot,
  config: AnySyncConfig,
  signal?: AbortSignal,
): Promise<Snapshot> {
  const policy = config.ignorePolicy;
  if (!policy) return snapshot;
  const source = await readIgnoreSource(getEngineRoot(), policy.filename, signal);
  if (!source.present || source.identity !== config.ignoreSourceIdentity)
    throw new Error("Ignore file was replaced before publication; reopen the review.");
  const ignoreRules = selectSnapshotIgnoreRules(source, policy);
  return regenerateSnapshotIdentity({ ...snapshot, version: RULES_SNAPSHOT_VERSION, ignoreRules });
}

export function ignorePublicationNotice(snapshot: Snapshot) {
  if (snapshot.ignoreRules === null) return "The active rule file excludes itself; this snapshot omits its text.";
  if (!snapshot.ignoreRules) return undefined;
  return `This snapshot includes ${safeTerminalText(snapshot.ignoreRules.filename)}. Its rules and comments will be retained in remote history. Peers must support snapshot version ${RULES_SNAPSHOT_VERSION}.`;
}
