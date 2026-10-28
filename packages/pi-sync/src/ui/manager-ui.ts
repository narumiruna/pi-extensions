import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { type ActionMenuItem, defineMenu, runMenu } from "@narumitw/pi-tui-kit";
import { loadConfig, syncCheckConfigFingerprint } from "../settings/config.js";
import { operationBlocksChanges } from "../state/operation-availability.js";
import { captureMutationOwner } from "../sync/sync-local.js";
import { type RunRoute, runCancellableOperation } from "./cancellable-operation.js";
import {
  attentionMainMenuItems,
  blockedSyncMenuItem,
  type SyncManagerAttentionOptions,
  showManagerAttention,
} from "./manager-attention.js";
import { recoverSyncAccess } from "./manager-recovery.js";
import { dispatchManagerResult } from "./manager-result-dispatcher.js";
import { backendStorageDescription, describeManagerState } from "./manager-state.js";
import { showSyncSettings } from "./settings-ui.js";
import { showSyncSetupManager } from "./setup/setup-actions.js";
import { showSetupSwitcher } from "./setup/setup-switcher.js";
import { showStorageConnections } from "./storage-connections-ui.js";
import { observationMatchesConfig } from "./sync-attention.js";
import { safeTerminalText } from "./terminal-text.js";

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
  type Screen = "main";
  type Action =
    | "review-attention"
    | "retry-refusal"
    | "sync"
    | "switch"
    | "settings"
    | "pull"
    | "push"
    | "diff"
    | "status"
    | "setups"
    | "connections"
    | "history"
    | "conflicts"
    | "doctor"
    | "recover"
    | "refresh"
    | "help"
    | "init";
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
          // Frequent transfers stay visible; status is advisory and Help remains a direct route.
          lines: [
            ...state.manager.title.split("\n").slice(1),
            "Help: /sync help · Fresh status: /sync status · Differences: /sync diff",
          ],
          items: operationFirst ? [...managerItems, ...attentionItems] : [...attentionItems, ...managerItems],
          hint: "close",
        };
      },
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
      "retry-refusal": async ({ signal: actionSignal }) => {
        const signal = sessionSignal ? AbortSignal.any([sessionSignal, actionSignal]) : actionSignal;
        const validate = captureMutationOwner(ctx, signal);
        validate();
        const retryRoute: RunRoute = (route, operationSignal, onCommit, target, onDialog) =>
          runRoute(route, operationSignal, onCommit, target, onDialog, true);
        const result = await runCancellableOperation(ctx, "Checking cached refusal…", "sync", retryRoute, {
          commitAware: true,
          cancelAcrossDialogs: true,
          signal,
          cancelledMessage: "Model retry cancelled. Submitted requests and committed writes cannot be undone.",
        });
        if (signal.aborted) return { kind: "close" };
        validate();
        if (result.kind === "decision-required" || result.kind === "remote-selection-required")
          ctx.ui.notify(
            "Model retry needs an established source and matching synced content. Use Sync now to review changed selection or recovery before retrying.",
            "warning",
          );
        return { kind: result.kind === "closed" ? "close" : "stay" };
      },
      switch: async () => {
        const result = await showSetupSwitcher(ctx, runRoute, undefined, sessionSignal);
        return result === "pull-attempted" || result === "closed" ? { kind: "close" } : { kind: "stay" };
      },
      settings: async () => {
        const result = await showSyncSettings(ctx, runRoute, sessionSignal);
        return { kind: result === "exit" ? "close" : "stay" };
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
        const result = await runCancellableOperation(ctx, "Loading sync history…", "history", runRoute, {
          signal: sessionSignal,
          commitAware: true,
          cancelAcrossDialogs: true,
          cancelledMessage: "History review cancelled; no files were changed.",
        });
        return { kind: result.kind === "closed" ? "close" : "stay" };
      },
      diff: async () => {
        const result = await runCancellableOperation(ctx, "Comparing local and remote…", "diff", runRoute, {
          signal: sessionSignal,
        });
        return { kind: result.kind === "closed" ? "close" : "stay" };
      },
      status: async () => {
        const result = await runCancellableOperation(ctx, "Checking remote status…", "status", runRoute, {
          signal: sessionSignal,
        });
        return { kind: result.kind === "closed" ? "close" : "stay" };
      },
      doctor: async ({ signal: actionSignal }) => {
        const signal = sessionSignal ? AbortSignal.any([sessionSignal, actionSignal]) : actionSignal;
        const validate = captureMutationOwner(ctx, signal);
        const config = await loadConfig();
        validate();
        const confirmed = await ctx.ui.confirm(
          "Run diagnostics?",
          `Setup: ${safeTerminalText(config.setupName)}\nStorage: ${backendStorageDescription(config)}\nS3/R2 reads the latest pointer without writing. Git reads remote snapshots and checks its cache. WebDAV probes conditional writes and cleanup, and can repair a missing history entry. Possible-secret checks still run. This is not the read-only Check remote status action.`,
          { signal },
        );
        if (signal.aborted) return { kind: "close" };
        validate();
        if (!confirmed) return { kind: "stay" };
        const latest = await loadConfig();
        validate();
        if (syncCheckConfigFingerprint(config) !== syncCheckConfigFingerprint(latest)) {
          ctx.ui.notify("Setup changed during diagnostics review; reopen Diagnostics.", "warning");
          return { kind: "stay" };
        }
        const result = await runCancellableOperation(ctx, "Checking setup access…", "doctor", runRoute, {
          signal,
          target: config.setupName,
        });
        return { kind: result.kind === "closed" ? "close" : "stay" };
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
      conflicts: async () => {
        const result = await runCancellableOperation(ctx, "Reviewing private conflicts…", "conflicts", runRoute, {
          commitAware: true,
          signal: sessionSignal,
        });
        const disposition = await dispatchManagerResult(ctx, result, "sync", runRoute, sessionSignal);
        return disposition.kind === "close" ? { kind: "close" } : { kind: "stay" };
      },
    },
  });
  const menuContext: ExtensionCommandContext = {
    ...ctx,
    ui: {
      ...ctx.ui,
      custom: (factory, customOptions) =>
        ctx.ui.custom((...args) => {
          const bound = (component: Component & { dispose?(): void }) => {
            const render = component.render.bind(component);
            // Kit menus use a one-cell layout floor; suppress it at a zero-column display boundary.
            component.render = (width) => (width <= 0 ? [] : render(width));
            return component;
          };
          const component = factory(...args);
          // Keep synchronous factories synchronous, including adapters that inspect their returned component.
          return component instanceof Promise ? component.then(bound) : bound(component);
        }, customOptions),
    },
  };
  await runMenu(menuContext, menu, {
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
  "main",
  | "sync"
  | "retry-refusal"
  | "pull"
  | "push"
  | "diff"
  | "status"
  | "switch"
  | "settings"
  | "setups"
  | "connections"
  | "history"
  | "conflicts"
  | "doctor"
  | "recover"
  | "refresh"
  | "help"
  | "init"
> {
  const actions = {
    "Sync now": "sync",
    "Retry refused model result…": "retry-refusal",
    "Pull from remote…": "pull",
    "Push to remote…": "push",
    "View differences": "diff",
    "Check remote status": "status",
    "Switch sync setup": "switch",
    Settings: "settings",
    History: "history",
    Diagnostics: "doctor",
    "Review unresolved conflicts": "conflicts",
    "Restore sync access… (recommended)": "recover",
    "Refresh operation status": "refresh",
    "Sync setups…": "setups",
    "Storage connections…": "connections",
    Help: "help",
    "Set up sync": "init",
    "Use existing settings": "init",
  } as const;
  const action = actions[label as keyof typeof actions];
  if (!action) throw new Error(`Unknown sync manager action: ${label}`);
  return {
    id: action,
    label,
    action,
    description:
      action === "retry-refusal"
        ? "Transfer: confirm one fresh model request for a current cached refusal; may incur costs."
        : action === "doctor"
          ? "Manage: review backend checks before running."
          : action === "settings" || action === "history" || action === "switch"
            ? "Manage"
            : action === "sync"
              ? "Transfer: choose a safe direction or review conflicts."
              : action === "pull"
                ? "Transfer: remote → local; review writes and removals."
                : action === "push"
                  ? "Transfer: local → remote active snapshot; review publication."
                  : action === "status" || action === "diff"
                    ? "Inspect: read current local and remote state without transferring files."
                    : undefined,
  };
}
