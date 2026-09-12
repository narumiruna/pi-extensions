import { syncConfigReviewIdentity } from "../settings/config.js";
import type { AnySyncConfig } from "../settings/settings-types.js";
import type { Snapshot } from "../snapshot/snapshot-types.js";
import type { SyncState } from "../state/state-types.js";
import { formatDiff, formatSnapshotOnlyDiff } from "../ui/sync-format.js";
import { safeTerminalText } from "../ui/terminal-text.js";
import { SyncDecisionRequiredError } from "./sync-errors.js";
import { includeFromSelectionConfig } from "./sync-policy.js";
import { syncPolicyChanged } from "./sync-state.js";

export type SyncDecisionKind =
  | "remote-or-policy-changed"
  | "both-changed"
  | "first-sync-settings-diverged"
  | "first-sync-sessions-diverged"
  | "remote-empty";

export type SyncResolutionDirection = "push" | "pull";

export interface SyncDecision {
  kind: SyncDecisionKind;
  setupName: string;
  configIdentity: string;
  causes: {
    localChanged: boolean;
    remoteChanged: boolean;
    policyChanged: boolean;
  };
  previousInclude?: readonly string[];
  currentInclude: readonly string[];
  review: string;
  directions: readonly SyncResolutionDirection[];
  directMessage: string;
}

export {
  isSyncDecisionRequiredError,
  SyncDecisionRequiredError,
} from "./sync-errors.js";

interface CreateSyncDecisionOptions {
  kind: SyncDecisionKind;
  config: AnySyncConfig;
  state: SyncState;
  local: Snapshot;
  remote?: Snapshot;
  localChanged: boolean;
  remoteChanged: boolean;
  directMessage: string;
}

export function createSyncDecision(options: CreateSyncDecisionOptions) {
  const { config, state, local, remote, kind } = options;
  const policyChanged = Boolean(state.lastAppliedSnapshot) && syncPolicyChanged(state, config);
  const previousInclude = includeFromSelectionConfig(state);
  const currentInclude = [...config.include];
  const causes = {
    localChanged: options.localChanged,
    remoteChanged: options.remoteChanged,
    policyChanged,
  };
  const causeLines =
    kind === "first-sync-settings-diverged"
      ? ["This machine and the remote have different Pi settings on first sync."]
      : kind === "first-sync-sessions-diverged"
        ? ["Pi settings match, but local and remote sessions differ on first sync."]
        : kind === "remote-empty"
          ? ["The remote storage location is empty."]
          : [
              ...(causes.localChanged ? ["Local content changed since the last sync."] : []),
              ...(causes.remoteChanged ? ["Remote content changed since the last sync."] : []),
              ...(causes.policyChanged ? ["Included content changed since the last sync."] : []),
            ];
  const comparison = remote
    ? formatDiff(local, remote)
    : formatSnapshotOnlyDiff("Remote is empty. Local push would upload", local);
  const review = [
    `Sync setup: ${safeTerminalText(config.setupName)}`,
    "",
    "Why a decision is required:",
    ...causeLines,
    ...(policyChanged
      ? ["", `Previously included: ${safeList(previousInclude)}`, `Currently included: ${safeList(currentInclude)}`]
      : []),
    "",
    "Observed differences:",
    ...comparison.split("\n").map(safeTerminalText),
  ].join("\n");
  return new SyncDecisionRequiredError({
    kind,
    setupName: config.setupName,
    configIdentity: syncConfigReviewIdentity(config),
    causes,
    ...(policyChanged ? { previousInclude: [...previousInclude] } : {}),
    currentInclude,
    review,
    directions: kind === "remote-empty" ? ["push"] : ["push", "pull"],
    directMessage: options.directMessage,
  });
}

function safeList(values: readonly string[]) {
  return values.length > 0 ? values.map(safeTerminalText).join(", ") : "none";
}
