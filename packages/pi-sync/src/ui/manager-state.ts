import { truncateToWidth } from "@earendil-works/pi-tui";
import { createSettingsConfigView, syncCheckConfigFingerprint } from "../settings/config.js";
import { type LocalConfigDocument, readActiveLocalConfigDocumentForRepair } from "../settings/config-file.js";
import type { AnySyncConfig } from "../settings/settings-types.js";
import { isCloudflareR2Endpoint } from "../settings/settings-validation.js";
import {
  inspectOperationAvailability,
  type OperationAvailability,
  operationBlocksChanges,
  operationCanRecover,
} from "../state/operation-availability.js";
import { readStateForConfig, syncStateFingerprint } from "../state/sync-state-store.js";
import { sameSyncExclude } from "../sync/exclude-policy.js";
import { errorMessage } from "../sync/sync-errors.js";
import type { StartupObservation } from "../sync/sync-inspection.js";
import { compareSyncInclude, syncSelectionHasContent, syncSessionsSelected } from "../sync/sync-policy.js";
import {
  observationMatchesConfig,
  observationSummary,
  type SyncAttentionState,
  syncAttentionMatchesConfig,
} from "./sync-attention.js";
import { hasAnotherSwitchableSetup } from "./sync-setups-ui.js";
import { safeTerminalText } from "./terminal-text.js";

export const MAIN_MENU_ACTIONS = [
  "Sync now",
  "Pull from remote",
  "Push to remote",
  "View differences",
  "Check remote status",
  "Settings",
  "History",
  "Diagnostics",
] as const;

export interface ManagerDescription {
  title: string;
  actions: string[];
  configReview?: { setupName: string; fingerprint: string };
  recoveryPull?: true;
  settingsReview?: { setupName: string; fingerprint: string };
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
  canUseIgnoreSettings?: () => Promise<boolean>,
): Promise<ManagerDescription> {
  signal?.throwIfAborted();
  let document: LocalConfigDocument | undefined;
  let view: ReturnType<typeof createSettingsConfigView> | undefined;
  try {
    document = await readActiveLocalConfigDocumentForRepair();
    signal?.throwIfAborted();
    if (document) view = createSettingsConfigView(document);
  } catch (error) {
    signal?.throwIfAborted();
    return {
      title: [
        "Manage sync",
        "",
        "Settings file needs repair. Automatic sync and settings writes are paused.",
        `Error: ${safeTerminalText(errorMessage(error))}`,
        ...(document ? [`File: ${safeTerminalText(document.path)}`] : []),
        "",
        "Repair the JSON file, then reopen /sync.",
      ].join("\n"),
      actions: ["Help"],
    };
  }
  if (!view || !document) {
    return {
      title: ["Manage sync", "", "Not set up.", "", "What do you want to do?"].join("\n"),
      actions: ["Set up sync", "Help"],
    };
  }
  if (view.setupNames.length === 0) {
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
  let settingsConfig: AnySyncConfig | undefined;
  try {
    settingsConfig = view.metadata();
    if (settingsConfig.reservedIgnoreNames && canUseIgnoreSettings && !(await canUseIgnoreSettings())) {
      throw new Error("the connected daemon does not support ignore-file setups");
    }
    signal?.throwIfAborted();
    const config = await view.observe(undefined, signal);
    signal?.throwIfAborted();
    const operation = await inspectOperation();
    signal?.throwIfAborted();
    const changesBlocked = operationBlocksChanges(operation);
    let currentAttention: SyncAttentionState | undefined;
    let alternateUsable = false;
    if (attention) {
      try {
        const attentionConfig =
          attention.decision.setupName === config.setupName
            ? config
            : await view.observe(attention.decision.setupName, signal);
        alternateUsable = attentionConfig.setupName !== config.setupName;
        if (syncAttentionMatchesConfig(attention, attentionConfig)) currentAttention = attention;
      } catch {
        currentAttention = undefined;
      }
      signal?.throwIfAborted();
    }
    const attentionComparison = currentAttention
      ? compareSyncInclude(currentAttention.decision.localInclude, currentAttention.decision.remoteInclude)
      : undefined;
    const attentionExclusionsDiffer = currentAttention
      ? !sameSyncExclude(currentAttention.decision.localExclude, currentAttention.decision.remoteExclude)
      : false;
    const attentionDirectoryPolicy =
      currentAttention?.decision.localDirectory || currentAttention?.decision.remoteDirectory;
    const noSyncedContent = !syncSelectionHasContent(config);
    const syncState = changesBlocked ? undefined : await readStateForConfig(config).catch(() => undefined);
    signal?.throwIfAborted();
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
        ? `${truncateToWidth(safeTerminalText(syncState.lastAppliedSnapshot), 12, "…")} · application time unavailable`
        : syncState
          ? "Never synced"
          : "Unavailable";
    const canSwitch = !changesBlocked && (alternateUsable || (await hasAnotherSwitchableSetup(view, signal)));
    signal?.throwIfAborted();
    const mainActions: string[] = [...MAIN_MENU_ACTIONS];
    if (config.agentMode && !noSyncedContent) mainActions.splice(1, 0, "Retry refused model result…");
    if (canSwitch) mainActions.push("Switch sync setup");
    if (syncState?.unresolved?.length) mainActions.unshift("Review unresolved conflicts");
    const background = changesBlocked ? [] : await backgroundSummary(config);
    signal?.throwIfAborted();
    const ordinaryTitle = [
      "Manage sync",
      `Current sync setup: ${safeTerminalText(config.setupName)}`,
      `Storage: ${backendStorageDescription(config)}`,
      ...(config.pathPolicy === "ignore-file"
        ? [
            `Sync scope: Pi agent directory · ignore file: ${safeTerminalText(config.ignoreFile ?? ".syncignore")}`,
            ...(config.ignorePolicy?.matches(config.ignorePolicy.filename) === false
              ? ["New snapshots include this rule file and its comments in remote history."]
              : []),
          ]
        : config.scope
          ? ["Sync scope: Pi agent directory, with exclusions"]
          : []),
      ...(syncState?.unresolved?.length
        ? [`Unresolved: ${syncState.unresolved.length} dependency groups · review needed`]
        : []),
      ...(currentAttention
        ? [
            currentAttention.decision.setupName === config.setupName
              ? "Sync status: Review needed"
              : `Sync status: Review needed for setup ${safeTerminalText(currentAttention.decision.setupName)}`,
            currentAttention.decision.ignorePolicyComparison
              ? "Ignore-file policies differ."
              : attentionDirectoryPolicy
                ? "Sync scopes or directory rules differ."
                : attentionComparison?.remoteOnly.length === 0 && attentionComparison.localOnly.length === 0
                  ? attentionExclusionsDiffer
                    ? "Synced-content exclusion rules differ."
                    : "Only the synced-content order differs."
                  : `Remote-only paths: ${attentionComparison?.remoteOnly.length ?? 0} · Device-only paths: ${attentionComparison?.localOnly.length ?? 0}${attentionExclusionsDiffer ? " · Exclusion rules differ." : ""}`,
          ]
        : currentObservation
          ? [`Observed ${safeTerminalText(currentObservation.checkedAt)}: ${observationSummary(currentObservation)}`]
          : ["Remote status: Not checked"]),
      `Last applied: ${lastAppliedSnapshot}`,
      ...(config.agentMode
        ? ["Auto-apply: On · AI requests may incur costs"]
        : config.automaticTransfer || (config.automatic && syncSessionsSelected(config))
          ? ["Automatic transfer permission: On · see Settings"]
          : []),
      ...background,
      ...(noSyncedContent
        ? ["", "No included content is selected. Choose included content in Settings before syncing."]
        : []),
    ];
    return {
      title: (changesBlocked ? ["Manage sync", ...operationStatusLines(operation)] : ordinaryTitle).join("\n"),
      actions: operationActions(operation, noSyncedContent, canSwitch, mainActions),
      configReview: { setupName: config.setupName, fingerprint: syncCheckConfigFingerprint(config) },
      settingsReview: { setupName: settingsConfig.setupName, fingerprint: syncCheckConfigFingerprint(settingsConfig) },
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
    signal?.throwIfAborted();
    if (settingsConfig?.reservedIgnoreNames !== undefined) {
      return {
        title: [
          "Manage sync",
          `Current sync setup: ${safeTerminalText(settingsConfig.setupName)}`,
          `Transfers are unavailable: ${safeTerminalText(errorMessage(error))}`,
        ].join("\n"),
        actions: ["Settings", "Sync setups…", "Storage connections…", "Help"],
        settingsReview: {
          setupName: settingsConfig.setupName,
          fingerprint: syncCheckConfigFingerprint(settingsConfig),
        },
      };
    }
    return {
      title: [
        "Manage sync",
        "",
        "Settings need attention. Automatic sync is paused.",
        `Current sync setup: ${safeTerminalText(view.activeSetupName ?? "none")}`,
        `Error: ${safeTerminalText(errorMessage(error))}`,
        `File: ${safeTerminalText(document.path)}`,
        "",
        "What do you want to do?",
      ].join("\n"),
      actions: ["Sync setups…", "Storage connections…", "History", "Help"],
    };
  }
}

async function backgroundSummary(config: AnySyncConfig): Promise<string[]> {
  if (!config.continuous) return [];
  if (!config.agentMode) return ["Background sync: Paused · enable Autonomous sync"];
  try {
    const { continuousBinding, readContinuousPrivateDocument } = await import("../sync/continuous-storage.js");
    const recordApi: typeof import("../sync/continuous-record.js") = await import("../sync/continuous-record.js");
    const binding = await continuousBinding(config);
    const document = await readContinuousPrivateDocument(`${binding}.json`);
    if (!document) return ["Background sync: Enabled · not yet observed"];
    recordApi.validateContinuousRecord(document.value, binding);
    const record = document.value;
    const phases = { waiting: "Waiting", syncing: "Syncing", retry: "Retry", blocked: "Blocked" };
    return [
      `Background sync (recorded): ${phases[record.phase]}${record.error ? ` · ${record.error}` : ""}`,
      ...(record.transferred === undefined
        ? []
        : [`Last background transfer: Success · ${new Date(record.transferred).toISOString()}`]),
    ];
  } catch {
    return ["Background sync: Unknown · open Diagnostics"];
  }
}

function operationActions(
  operation: OperationAvailability,
  noSyncedContent: boolean,
  canSwitch: boolean,
  mainActions: string[],
) {
  if (operationCanRecover(operation)) {
    return ["Restore sync access… (recommended)", "History", "Help"];
  }
  if (operation.kind !== "free") {
    return ["Refresh operation status", "History", "Help"];
  }
  return noSyncedContent
    ? [
        ...(mainActions.includes("Review unresolved conflicts") ? ["Review unresolved conflicts"] : []),
        "Settings",
        ...(canSwitch ? ["Switch sync setup"] : []),
        "History",
        "Diagnostics",
      ]
    : mainActions;
}

function operationStatusLines(operation: OperationAvailability): string[] {
  switch (operation.kind) {
    case "free":
      return [];
    case "live": {
      const command = truncateToWidth(safeTerminalText(operation.lock.command), 16, "…");
      return [
        `Running: ${command} (pid ${operation.lock.pid}). Wait, then refresh; Transfer actions and Settings return.`,
      ];
    }
    case "busy":
      return [
        "Pi-sync may be starting or finishing. Wait, then refresh; Transfer actions and Settings remain unavailable.",
      ];
    case "recoverable-stale":
      return [
        "Sync paused: old lock remains. Close other Pi sessions then restore; Transfer actions and Settings return.",
      ];
    case "recoverable-unreadable":
      return [
        "Sync paused: owner unknown. Close other Pi sessions then restore; Transfer actions and Settings return.",
      ];
    case "inspection-error":
      return ["Lock check failed. Fix path access, then refresh; Transfer actions and Settings remain unavailable."];
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
      const { bucket, prefix } = config.backend.destination;
      return `${type} · ${connection} · ${safeTerminalText(bucket)} · ${safeTerminalText(prefix)}`;
    }
    case "webdav":
      return `WebDAV · ${connection} · ${safeTerminalText(config.backend.destination.path)}`;
    case "git": {
      const { branch, directory } = config.backend.destination;
      return `Git · ${connection} · ${safeTerminalText(branch)} · ${safeTerminalText(directory)}`;
    }
  }
}
