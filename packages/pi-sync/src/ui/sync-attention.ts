import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import type { EditorStatusWidgetState } from "@narumitw/pi-tui-kit/editor-status-widget";
import { syncCheckConfigFingerprint, syncConfigReviewFingerprint } from "../settings/config.js";
import type { AnySyncConfig } from "../settings/settings-types.js";
import { sameSyncExclude } from "../sync/exclude-policy.js";
import type { StartupObservation } from "../sync/sync-inspection.js";
import { type RemoteSelectionDecision, sameSyncInclude } from "../sync/sync-policy.js";
import { setSyncStatus } from "./sync-status.js";
import { safeTerminalText } from "./terminal-text.js";

const WIDGET_KEY = "sync:attention";

export type SyncAttentionOrigin = "sync" | "pull" | "push";

export interface SyncAttentionState {
  decision: RemoteSelectionDecision;
  origin: SyncAttentionOrigin;
  offered: boolean;
}

export function syncAttentionMatchesConfig(attention: SyncAttentionState, config: AnySyncConfig) {
  return (
    attention.decision.setupName === config.setupName &&
    attention.decision.configIdentity === syncConfigReviewFingerprint(config) &&
    sameSyncInclude(attention.decision.localInclude, config.include) &&
    sameSyncExclude(attention.decision.localExclude, config.exclude)
  );
}

export interface SyncAttentionController {
  observe(observation: StartupObservation): void;
  observation(): StartupObservation | undefined;
  clearObservation(): void;
  notifyObservation(ctx: ExtensionContext): void;
  set(decision: RemoteSelectionDecision, origin: SyncAttentionOrigin): void;
  current(): SyncAttentionState | undefined;
  markOffered(): boolean;
  clear(ctx: ExtensionContext): void;
  reset(ctx: ExtensionContext): void;
  expand(): void;
  publish(ctx: ExtensionContext, signal?: AbortSignal): Promise<void>;
}

export function createSyncAttentionController(): SyncAttentionController {
  let state: SyncAttentionState | undefined;
  let observation: StartupObservation | undefined;
  let generation = 0;
  let widgetState: EditorStatusWidgetState = { collapsed: false };

  return {
    observe(value) {
      generation++;
      observation = value;
    },
    observation() {
      return observation;
    },
    clearObservation() {
      generation++;
      observation = undefined;
    },
    notifyObservation(ctx) {
      if (ctx.hasUI && observation && observationNeedsAttention(observation)) {
        ctx.ui.notify(observationLines(observation).join("\n"), "warning");
      }
    },
    set(decision, origin) {
      generation++;
      state = { decision, origin, offered: false };
    },
    current() {
      return state;
    },
    markOffered() {
      if (!state || state.offered) return false;
      state = { ...state, offered: true };
      return true;
    },
    clear(ctx) {
      generation++;
      state = undefined;
      clearAttentionPresentation(ctx);
    },
    reset(ctx) {
      generation++;
      state = undefined;
      observation = undefined;
      widgetState = { collapsed: false };
      clearAttentionPresentation(ctx);
    },
    expand() {
      widgetState.collapsed = false;
    },
    async publish(ctx, signal) {
      const currentGeneration = ++generation;
      if (signal?.aborted || !ctx.hasUI) return;
      const classification = observation ? classifyObservation(observation) : "none";
      if (!state && (classification === "none" || classification === "guidance")) {
        clearAttentionPresentation(ctx);
        return;
      }
      if (!state && classification === "status") {
        ctx.ui.setWidget(WIDGET_KEY, undefined);
        setSyncStatus(ctx, observation?.inspection.remoteChanged ? "sync ⇣" : "sync ⇡", {
          activity: observation?.inspection.remoteChanged ? "remote-change" : "local-change",
        });
        return;
      }
      const setupName = safeTerminalText(state?.decision.setupName ?? observation?.setupName ?? "");
      if (ctx.mode !== "tui") {
        ctx.ui.setWidget(WIDGET_KEY, undefined);
        setSyncStatus(ctx, "sync ⇕", { activity: "review" });
        return;
      }
      // Keep Kit outside the eager startup graph; module loading owns no cancellable resources.
      const { EditorStatusWidget } = await import("./attention-widget.js").catch((error) => {
        if (generation === currentGeneration && !signal?.aborted) clearAttentionPresentation(ctx);
        throw error;
      });
      if (generation !== currentGeneration || signal?.aborted) return;
      setSyncStatus(ctx, "sync ⇕", { activity: "review" });
      const presentationState = widgetState;
      ctx.ui.setWidget(
        WIDGET_KEY,
        (_tui, theme) =>
          new EditorStatusWidget({
            theme,
            name: "Sync",
            summary: "Needs review",
            state: presentationState,
            renderBody: (width) => [
              width === 0 ? "" : truncateToWidth(theme.fg("muted", `Open /sync to review · ${setupName}`), width, "…"),
            ],
          }),
      );
    },
  };
}

export function observationMatchesConfig(observation: StartupObservation, config: AnySyncConfig) {
  return observation.configIdentity === syncCheckConfigFingerprint(config);
}

export function observationSummary(observation: StartupObservation) {
  const result = observation.inspection;
  if (result.emptyInclude) return "No included content selected";
  if (result.selectionState?.kind === "different") return "Synced-content list differs; review needed";
  if (result.firstSync)
    return result.head ? "No sync baseline; review remote and local content" : "Remote empty; no sync baseline";
  if (!result.head) return "Remote snapshot missing; review needed";
  if (observation.automaticTransfer && result.selectionState?.kind === "legacy")
    return "Legacy remote has no authoritative content list; review /sync and choose an explicit direction to adopt policy";
  if (result.localChanged && result.remoteChanged) return "Local and remote changed since last sync; review needed";
  if (result.remoteChanged) return "Remote changed since last sync";
  if (result.localChanged) return "Local content changed since last sync";
  if (result.selectionState?.kind === "legacy") return "Legacy remote has no authoritative content list";
  return "No changes detected since last sync";
}

export type ObservationClassification = "none" | "guidance" | "status" | "review";

/** Presentation only: never discard an observation or authorize a transfer here. */
export function classifyObservation(observation: StartupObservation): ObservationClassification {
  const result = observation.inspection;
  // Sync now exits before reading remote content when nothing is selected.
  if (result.emptyInclude) return "guidance";
  // Ordering is part of the existing transfer policy, not merely display order.
  if (result.selectionState?.kind === "different") return "review";
  if (result.firstSync) return result.head ? "review" : "guidance";
  if (!result.head || (result.localChanged && result.remoteChanged)) return "review";
  if (observation.automaticTransfer && result.selectionState?.kind === "legacy") return "review";
  if (result.localChanged || result.remoteChanged) return "status";
  // Legacy metadata alone requires no scope confirmation in transfer operations.
  return "none";
}

export function observationNeedsAttention(observation: StartupObservation) {
  return classifyObservation(observation) === "review";
}

function observationLines(observation: StartupObservation) {
  return [
    `Pi Sync check · ${safeTerminalText(observation.setupName)}`,
    observationSummary(observation),
    "No startup transfer · Run /sync to review",
  ];
}

function clearAttentionPresentation(ctx: ExtensionContext) {
  if (!ctx.hasUI) return;
  setSyncStatus(ctx, undefined);
  ctx.ui.setWidget(WIDGET_KEY, undefined);
}
