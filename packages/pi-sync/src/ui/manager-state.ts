import { truncateToWidth } from "@earendil-works/pi-tui";
import { loadConfig } from "../settings/config.js";
import { activeLocalConfigPath } from "../settings/config-file.js";
import { readLocalConfigObject } from "../settings/settings-store.js";
import type { AnySyncConfig } from "../settings/settings-types.js";
import { isCloudflareR2Endpoint, ownRecord } from "../settings/settings-validation.js";
import {
  inspectOperationAvailability,
  type OperationAvailability,
  operationBlocksChanges,
  operationCanRecover,
} from "../state/operation-availability.js";
import { readStateForConfig, syncStateFingerprint } from "../state/sync-state-store.js";
import { errorMessage } from "../sync/sync-errors.js";
import type { StartupObservation } from "../sync/sync-inspection.js";
import { compareSyncInclude, syncIncludeSelection } from "../sync/sync-policy.js";
import { automaticSyncSummary } from "./automatic-sync-summary.js";
import {
  observationMatchesConfig,
  observationSummary,
  type SyncAttentionState,
  syncAttentionMatchesConfig,
} from "./sync-attention.js";
import { countValidSyncSetups } from "./sync-setups-ui.js";
import { safeTerminalText } from "./terminal-text.js";

export const MAIN_MENU_ACTIONS = [
  "Sync now (recommended)",
  "Switch sync setup",
  "Status & changes",
  "Settings",
  "More…",
] as const;

export interface ManagerDescription {
  title: string;
  actions: string[];
  operation?: OperationAvailability;
  attention?: SyncAttentionState;
  observation?: StartupObservation;
  attentionBlocksSync?: boolean;
  attentionReviewDisabled?: boolean;
}

export async function describeManagerState(
  signal?: AbortSignal,
  attention?: SyncAttentionState,
  inspectOperation: () => Promise<OperationAvailability> = inspectOperationAvailability,
  observation?: StartupObservation,
): Promise<ManagerDescription> {
  let raw: Record<string, unknown> | undefined;
  try {
    raw = await readLocalConfigObject();
  } catch (error) {
    return {
      title: [
        "Manage sync",
        "",
        "Settings file needs repair. Automatic sync and settings writes are paused.",
        `Error: ${safeTerminalText(errorMessage(error))}`,
        `File: ${safeTerminalText(await activeLocalConfigPath())}`,
        "",
        "Repair the JSON file, then reopen /sync.",
      ].join("\n"),
      actions: ["Help"],
    };
  }
  if (!raw) {
    return {
      title: ["Manage sync", "", "Not set up.", "", "What do you want to do?"].join("\n"),
      actions: ["Set up sync", "Help"],
    };
  }
  const configuredTargets = ownRecord(raw.syncSetups);
  if (raw.version === 3 && configuredTargets && Object.keys(configuredTargets).length === 0) {
    return {
      title: [
        "Manage sync",
        "",
        "No sync setups are configured.",
        "Add a sync setup using an existing storage connection.",
        "",
        "What do you want to do?",
      ].join("\n"),
      actions: ["Sync setups…", "Storage connections…", "Help"],
    };
  }
  try {
    const config = await loadConfig();
    const operation = await inspectOperation();
    const changesBlocked = operationBlocksChanges(operation);
    const selection = syncIncludeSelection(config.include);
    let currentAttention: SyncAttentionState | undefined;
    if (attention) {
      try {
        const attentionConfig =
          attention.decision.setupName === config.setupName ? config : await loadConfig(attention.decision.setupName);
        if (syncAttentionMatchesConfig(attention, attentionConfig)) currentAttention = attention;
      } catch {
        currentAttention = undefined;
      }
      if (signal?.aborted) throw signal.reason;
    }
    const attentionComparison = currentAttention
      ? compareSyncInclude(currentAttention.decision.localInclude, currentAttention.decision.remoteInclude)
      : undefined;
    const noSyncedContent = config.include.length === 0;
    const syncState = changesBlocked ? undefined : await readStateForConfig(config).catch(() => undefined);
    const currentObservation =
      observation &&
      observationMatchesConfig(observation, config) &&
      syncState &&
      syncStateFingerprint(syncState) === observation.inspection.stateIdentity
        ? observation
        : undefined;
    const lastAppliedSnapshot = changesBlocked
      ? "Unavailable while operations are locked"
      : syncState?.lastAppliedSnapshot
        ? safeTerminalText(syncState.lastAppliedSnapshot)
        : syncState
          ? "Never synced"
          : "Unavailable";
    const canSwitch = (await countValidSyncSetups(configuredTargets, signal)) > 1;
    const mainActions = MAIN_MENU_ACTIONS.filter((action) => action !== "Switch sync setup" || canSwitch);
    const ordinaryTitle = [
      "Manage sync",
      "",
      `Current sync setup: ${safeTerminalText(config.setupName)}`,
      `Storage: ${backendStorageDescription(config)}`,
      `Included: ${selection.builtIns.length} built-in group${selection.builtIns.length === 1 ? "" : "s"} · ${selection.custom.length} extra path${selection.custom.length === 1 ? "" : "s"} · Sessions ${selection.sessions ? "on" : "off"}`,
      `Automatic sync: ${automaticSyncSummary(config.automatic)}`,
      `Last applied: ${lastAppliedSnapshot}`,
      ...(currentAttention
        ? [
            currentAttention.decision.setupName === config.setupName
              ? "Sync status: Review needed"
              : `Sync status: Review needed for setup ${safeTerminalText(currentAttention.decision.setupName)}`,
            attentionComparison?.remoteOnly.length === 0 && attentionComparison.localOnly.length === 0
              ? "Only the synced-content order differs."
              : `Remote-only paths: ${attentionComparison?.remoteOnly.length ?? 0} · Device-only paths: ${attentionComparison?.localOnly.length ?? 0}`,
            "Nothing has been changed.",
          ]
        : currentObservation
          ? [
              `Startup check (${safeTerminalText(currentObservation.checkedAt)}): ${observationSummary(currentObservation)}`,
              "Check-time observation only; synchronization rechecks current content.",
            ]
          : ["Remote status: Not checked"]),
      ...(noSyncedContent
        ? ["", "No included content is selected. Choose included content in Settings before syncing."]
        : []),
      "",
      "What do you want to do?",
    ];
    return {
      title: (changesBlocked ? ["Manage sync", ...operationStatusLines(operation)] : ordinaryTitle).join("\n"),
      actions: operationActions(operation, noSyncedContent, canSwitch, mainActions),
      operation,
      ...(currentObservation ? { observation: currentObservation } : {}),
      ...(currentAttention
        ? {
            attention: currentAttention,
            attentionBlocksSync: currentAttention.decision.setupName === config.setupName,
            attentionReviewDisabled: changesBlocked,
          }
        : {}),
    };
  } catch (error) {
    if (signal?.aborted) throw error;
    return {
      title: [
        "Manage sync",
        "",
        "Settings need attention. Automatic sync is paused.",
        `Current sync setup: ${safeTerminalText(typeof raw.activeSyncSetup === "string" ? raw.activeSyncSetup : "none")}`,
        `Error: ${safeTerminalText(errorMessage(error))}`,
        `File: ${safeTerminalText(await activeLocalConfigPath())}`,
        "",
        "What do you want to do?",
      ].join("\n"),
      actions: ["Sync setups…", "Storage connections…", "History & recovery…", "Help"],
    };
  }
}

function operationActions(
  operation: OperationAvailability,
  noSyncedContent: boolean,
  canSwitch: boolean,
  mainActions: string[],
) {
  if (operationCanRecover(operation)) {
    return ["Restore sync access… (recommended)", "Status & changes", "History & recovery…", "Help"];
  }
  if (operation.kind !== "free") {
    return ["Refresh operation status", "Status & changes", "History & recovery…", "Help"];
  }
  return noSyncedContent
    ? ["Settings", ...(canSwitch ? ["Switch sync setup"] : []), "Status & changes", "More…"]
    : mainActions;
}

function operationStatusLines(operation: OperationAvailability): string[] {
  switch (operation.kind) {
    case "free":
      return [];
    case "live": {
      const command = truncateToWidth(safeTerminalText(operation.lock.command), 16, "…");
      return [`Running: ${command} (pid ${operation.lock.pid}). Wait, then refresh; Settings and More return.`];
    }
    case "busy":
      return ["Pi-sync may be starting or finishing. Wait, then refresh; Settings and More remain unavailable."];
    case "recoverable-stale":
      return ["Sync paused: old lock remains. Close other Pi sessions then restore; Settings and More return."];
    case "recoverable-unreadable":
      return ["Sync paused: owner unknown. Close other Pi sessions then restore; Settings and More return."];
    case "inspection-error":
      return ["Lock check failed. Fix path access, then refresh; Settings and More remain unavailable."];
  }
}

export function backendStorageDescription(config: AnySyncConfig) {
  const connection = safeTerminalText(config.connectionName);
  switch (config.backend.type) {
    case "s3": {
      const type =
        config.backend.profile.kind === "r2" || isCloudflareR2Endpoint(config.backend.profile.endpoint)
          ? "Cloudflare R2"
          : "S3-compatible";
      return `${type} · ${connection} · ${safeTerminalText(config.backend.destination.bucket)}`;
    }
    case "webdav":
      return `WebDAV · ${connection} · ${safeTerminalText(config.backend.destination.path)}`;
    case "git":
      return `Git · ${connection} · ${safeTerminalText(config.backend.destination.branch)}`;
  }
}
