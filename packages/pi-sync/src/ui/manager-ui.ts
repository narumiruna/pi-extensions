import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { type ActionMenuItem, defineMenu, runMenu } from "@narumitw/pi-tui-kit";
import { loadConfig } from "../settings/config.js";
import { operationBlocksChanges, operationCanRecover } from "../state/operation-availability.js";
import { type RunRoute, runCancellableOperation } from "./cancellable-operation.js";
import {
  attentionMainMenuItems,
  blockedSyncMenuItem,
  type SyncManagerAttentionOptions,
  showManagerAttention,
} from "./manager-attention.js";
import { recoverSyncAccess } from "./manager-recovery.js";
import { dispatchManagerResult } from "./manager-result-dispatcher.js";
import { describeManagerState } from "./manager-state.js";
import { showSyncSettings } from "./settings-ui.js";
import { showSyncSetupManager } from "./setup/setup-actions.js";
import { showSetupSwitcher } from "./setup/setup-switcher.js";
import { showStorageConnections } from "./storage-connections-ui.js";
import { observationMatchesConfig } from "./sync-attention.js";

export async function showSyncManager(
  ctx: ExtensionCommandContext,
  runRoute: RunRoute,
  sessionSignal?: AbortSignal,
  options: SyncManagerAttentionOptions = {},
): Promise<void> {
  if (!ctx.hasUI) {
    await runRoute("help");
    return;
  }
  type Screen = "main" | "more" | "recovery";
  type Action =
    | "review-attention"
    | "sync"
    | "switch"
    | "diff"
    | "settings"
    | "pull"
    | "push"
    | "setups"
    | "connections"
    | "history"
    | "doctor"
    | "unlock"
    | "recover"
    | "refresh"
    | "help"
    | "init"
    | "back";
  interface State {
    manager: Awaited<ReturnType<typeof describeManagerState>>;
  }
  const menu = defineMenu<State, Screen, Action, ExtensionCommandContext>({
    start: "main",
    screens: {
      main: ({ state }) => {
        const attentionItems = attentionMainMenuItems(state.manager);
        const managerItems = state.manager.actions.map(
          (label) => blockedSyncMenuItem(label, state.manager) ?? syncMainMenuItem(label),
        );
        const operationFirst = state.manager.operation !== undefined && state.manager.operation.kind !== "free";
        return {
          kind: "actions",
          title: "Manage sync",
          lines: state.manager.title.split("\n").slice(1),
          items: operationFirst ? [...managerItems, ...attentionItems] : [...attentionItems, ...managerItems],
          hint: "close",
        };
      },
      more: () => ({
        kind: "actions",
        title: "More options",
        items: [
          { id: "pull", label: "Pull from remote…", action: "pull" },
          { id: "push", label: "Push to remote…", action: "push" },
          { id: "setups", label: "Sync setups…", action: "setups" },
          {
            id: "connections",
            label: "Storage connections…",
            action: "connections",
          },
          {
            id: "doctor",
            label: "Check setup",
            description: "Check current setup access. WebDAV also probes writes and repairs history.",
            action: "doctor",
          },
          { id: "recovery", label: "History & recovery…", to: "recovery" },
          { id: "help", label: "Help", action: "help" },
          { id: "back", label: "Back", action: "back" },
        ],
        hint: "back",
      }),
      recovery: ({ state }) => ({
        kind: "actions",
        title: "History & recovery",
        items: [
          { id: "history", label: "Browse history", action: "history" },
          {
            id: "doctor",
            label: "Check setup",
            description: "WebDAV also probes writes and repairs history.",
            action: "doctor",
          },
          ...(state.manager.operation && operationCanRecover(state.manager.operation)
            ? [{ id: "unlock", label: "Recover stale operation", action: "unlock" as const }]
            : []),
          { id: "back", label: "Back", action: "back" },
        ],
        hint: "back",
      }),
    },
    actions: {
      "review-attention": async () => {
        const attention = options.getAttention?.();
        if (!attention) {
          const observation = options.getObservation?.();
          if (!observation) return { kind: "stay" };
          // A head-only observation is not an authoritative decision. Load a fresh
          // snapshot only after the user activates the existing review flow.
          const { showRemoteSelectionReview } = await import("./remote-selection-ui.js");
          if (sessionSignal?.aborted) return { kind: "close" };
          const config = await loadConfig();
          if (sessionSignal?.aborted) return { kind: "close" };
          if (options.getObservation?.() !== observation || !observationMatchesConfig(observation, config)) {
            options.onObservationInvalidated?.();
            return { kind: "stay" };
          }
          // Keep the check-time hint on cancellation or failure. Route commits and
          // the manager's config/baseline reconciliation own invalidation.
          const result = await showRemoteSelectionReview(ctx, observation.setupName, sessionSignal, undefined, {
            origin: "sync",
            runRoute,
            onSelectionResolved: () => {
              if (!sessionSignal?.aborted && options.getObservation?.() === observation)
                options.onObservationInvalidated?.();
            },
          });
          if (sessionSignal?.aborted) return { kind: "close" };
          if (result.kind === "route-result") {
            return dispatchManagerResult(ctx, result.result, result.route, runRoute, sessionSignal);
          }
          return { kind: result.kind === "closed" || result.kind === "stale" ? "close" : "stay" };
        }
        const disposition = await showManagerAttention(ctx, attention, runRoute, sessionSignal, () =>
          options.onSelectionResolved?.(attention),
        );
        return { kind: disposition };
      },
      sync: async () => {
        const pendingAttention = options.getAttention?.();
        if (pendingAttention) {
          const activeConfig = await loadConfig();
          if (sessionSignal?.aborted) return { kind: "close" };
          if (pendingAttention.decision.setupName === activeConfig.setupName) {
            ctx.ui.notify("Review synced content before starting Sync now.", "warning");
            return { kind: "stay" };
          }
        }
        const result = await runCancellableOperation(ctx, "Checking current sync setup…", "sync", runRoute, {
          commitAware: true,
          signal: sessionSignal,
        });
        const disposition = await dispatchManagerResult(ctx, result, "sync", runRoute, sessionSignal);
        return disposition.kind === "close" ? { kind: "close" } : { kind: "stay" };
      },
      switch: async () => {
        const result = await showSetupSwitcher(ctx, runRoute, undefined, sessionSignal);
        return result === "pull-attempted" || result === "closed" ? { kind: "close" } : { kind: "stay" };
      },
      diff: async () => {
        const result = await runCancellableOperation(ctx, "Checking current sync setup…", "diff", runRoute, {
          signal: sessionSignal,
        });
        return result.kind === "closed" ? { kind: "close" } : { kind: "stay" };
      },
      settings: async () => {
        await showSyncSettings(ctx, runRoute, sessionSignal);
        return { kind: "stay" };
      },
      pull: async () => {
        const result = await runCancellableOperation(ctx, "Checking remote changes…", "pull", runRoute, {
          commitAware: true,
          cancelledMessage: "Pull check cancelled; no local files were changed.",
          signal: sessionSignal,
        });
        const disposition = await dispatchManagerResult(ctx, result, "pull", runRoute, sessionSignal);
        return disposition.kind === "close" ? { kind: "close" } : { kind: "stay" };
      },
      push: async () => {
        const result = await runCancellableOperation(ctx, "Preparing push preview…", "push", runRoute, {
          commitAware: true,
          cancelledMessage: "Push preparation cancelled; no remote files were changed.",
          signal: sessionSignal,
        });
        const disposition = await dispatchManagerResult(ctx, result, "push", runRoute, sessionSignal);
        return disposition.kind === "close" ? { kind: "close" } : { kind: "stay" };
      },
      setups: async () => {
        const result = await showSyncSetupManager(ctx, runRoute, sessionSignal);
        return result === "exit" ? { kind: "close" } : { kind: "stay" };
      },
      connections: async () => {
        await showStorageConnections(ctx, sessionSignal);
        return { kind: "stay" };
      },
      history: async () => {
        await runRoute("history");
        return { kind: "stay" };
      },
      doctor: async () => {
        const result = await runCancellableOperation(ctx, "Checking setup access…", "doctor", runRoute, {
          signal: sessionSignal,
        });
        return { kind: result.kind === "closed" ? "close" : "stay" };
      },
      unlock: async ({ state, signal: actionSignal }) => {
        const result = await recoverSyncAccess(ctx, state.manager, runRoute, sessionSignal, actionSignal);
        if (result === "close") return { kind: "close" };
        return result === "restored" ? { kind: "to", screen: "main" } : { kind: "stay" };
      },
      recover: async ({ state, signal: actionSignal }) => {
        const result = await recoverSyncAccess(ctx, state.manager, runRoute, sessionSignal, actionSignal);
        return { kind: result === "close" ? "close" : "stay" };
      },
      refresh: async () => ({ kind: "stay" }),
      help: async () => {
        await runRoute("help");
        return { kind: "close" };
      },
      init: async () => {
        await runRoute("init");
        return { kind: "stay" };
      },
      back: async () => ({ kind: "back" }),
    },
  });
  await runMenu(ctx, menu, {
    getState: async () => {
      const pendingAttention = options.getAttention?.();
      const observation = options.getObservation?.();
      const manager = await describeManagerState(sessionSignal, pendingAttention, undefined, observation);
      if (sessionSignal?.aborted) return { manager };
      // A busy operation suppresses baseline reads, not the stored check-time hint.
      if (
        observation &&
        options.getObservation?.() === observation &&
        !manager.observation &&
        !(manager.operation && operationBlocksChanges(manager.operation))
      ) {
        options.onObservationInvalidated?.();
      }
      if (pendingAttention && options.getAttention?.() === pendingAttention && !manager.attention) {
        options.onSelectionResolved?.(pendingAttention);
      }
      return { manager };
    },
    signal: sessionSignal,
    isCurrent: () => !sessionSignal?.aborted,
  });
}

function syncMainMenuItem(
  label: string,
): ActionMenuItem<
  "main" | "more" | "recovery",
  "sync" | "switch" | "diff" | "settings" | "setups" | "connections" | "recover" | "refresh" | "help" | "init"
> {
  if (label === "More…") return { id: "more", label, to: "more" };
  if (label === "History & recovery…") return { id: "recovery", label, to: "recovery" };
  const actions = new Map<
    string,
    "sync" | "switch" | "diff" | "settings" | "setups" | "connections" | "recover" | "refresh" | "help" | "init"
  >([
    ["Sync now (recommended)", "sync"],
    ["Switch sync setup", "switch"],
    ["Status & changes", "diff"],
    ["Settings", "settings"],
    ["Restore sync access… (recommended)", "recover"],
    ["Refresh operation status", "refresh"],
    ["Sync setups…", "setups"],
    ["Storage connections…", "connections"],
    ["Help", "help"],
    ["Set up sync", "init"],
    ["Use existing settings", "init"],
  ]);
  return { id: actions.get(label) ?? "help", label, action: actions.get(label) ?? "help" };
}
