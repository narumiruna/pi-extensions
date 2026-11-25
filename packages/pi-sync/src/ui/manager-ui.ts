import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { type ActionMenuItem, defineMenu, type MenuDefinition, runDocumentReview, runMenu } from "@narumitw/pi-tui-kit";
import { loadConfig, loadSettingsConfig, syncCheckConfigFingerprint } from "../settings/config.js";
import { operationBlocksChanges } from "../state/operation-availability.js";
import { captureMutationOwner } from "../sync/sync-local.js";
import { type RunRoute, runCancellableOperation } from "./cancellable-operation.js";
import { ignoreFileSettingsAvailable } from "./ignore-file-ui.js";
import { showIgnoreMigrationPrompt } from "./ignore-migration-prompt.js";
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
  options: SyncManagerAttentionOptions & {
    needsDaemonRecovery?: () => boolean;
    getPendingPullReview?: () => { setupName: string; fingerprint: string } | undefined;
  } = {},
): Promise<void> {
  if (!ctx.hasUI) {
    await runRoute("help");
    return;
  }
  const validateOwner = captureMutationOwner(ctx, sessionSignal);
  const isCurrent = () => {
    try {
      validateOwner();
      return true;
    } catch {
      return false;
    }
  };
  type Screen = "main";
  type Action =
    | "activate"
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
    | "daemon-recovery"
    | "refresh"
    | "help"
    | "init";
  interface State {
    manager: Awaited<ReturnType<typeof describeManagerState>>;
  }
  const directionalAction = async (direction: "push" | "pull", state: State, signal: AbortSignal) => {
    const review = state.manager.configReview;
    if (!review) return { kind: "stay" as const };
    const result = await runCancellableOperation(
      ctx,
      direction === "push" ? "Pushing to remote…" : "Pulling from remote…",
      direction,
      runRoute,
      {
        commitAware: true,
        cancelledMessage: direction === "push" ? "Push cancellation requested." : "Pull cancellation requested.",
        target: review.setupName,
        directionalFingerprint: review.fingerprint,
        requirePendingAdoption: state.manager.recoveryPull,
        signal,
        isCurrent,
      },
    );
    const done =
      result.kind === "closed" ||
      (result.kind === "completed" && result.outcome === "applied") ||
      (result.kind === "failed" && options.needsDaemonRecovery?.());
    return done ? { kind: "close" as const } : { kind: "stay" as const };
  };
  const menuItems = (manager: State["manager"]) => {
    const attentionItems = attentionMainMenuItems(manager);
    const managerItems = manager.actions.map((label) => blockedSyncMenuItem(label, manager) ?? syncMainMenuItem(label));
    const operationFirst = manager.operation !== undefined && manager.operation.kind !== "free";
    return operationFirst ? [...managerItems, ...attentionItems] : [...attentionItems, ...managerItems];
  };
  const menu: MenuDefinition<State, Screen, Action, ExtensionCommandContext> = defineMenu<
    State,
    Screen,
    Action,
    ExtensionCommandContext
  >({
    start: "main",
    screens: {
      main: ({ state: { manager } }) => {
        const [title = "Manage sync", ...lines] = manager.title.split("\n");
        const setupName = ctx.mode === "tui" ? manager.configReview?.setupName : undefined;
        const setup = setupName === undefined ? undefined : safeTerminalText(setupName);
        const setupInHeading = setup !== undefined && lines[0] === `Current sync setup: ${setup}`;
        return {
          kind: "choice",
          title: setupInHeading ? `${title} · ${setup}` : title,
          lines: setupInHeading ? lines.slice(1) : lines,
          items: menuItems(manager).map((item) => ({
            id: item.id,
            label: ctx.mode === "tui" && item.id === "sync" ? "Sync…" : item.label,
            details: [item.description ?? "Review synced content."],
            searchText: `${item.label} ${item.description ?? ""}`,
            disabled: item.disabled,
            disabledReason: item.disabledReason,
          })),
          action: "activate",
          enableSearch: true,
          viewportSize: 5,
          hint: "close",
        };
      },
    },
    actions: {
      activate: async (invocation) => {
        const item = menuItems(invocation.state.manager).find((candidate) => candidate.id === invocation.itemId);
        if (!item || item.disabled || !("action" in item) || !item.action) return { kind: "stay" };
        // Forward through the handlers below after their setup-ownership guards are installed.
        return menu.actions[item.action](invocation);
      },
      "review-attention": async ({ state }) => {
        const attention = state.manager.attention;
        if (attention && options.getAttention?.() !== attention) return { kind: "stay" };
        if (!attention) {
          const observation = state.manager.observation;
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
      sync: async ({ state }) => {
        const pendingAttention = options.getAttention?.();
        if (pendingAttention?.decision.setupName === state.manager.configReview?.setupName) {
          ctx.ui.notify("Review synced content before starting Sync now.", "warning");
          return { kind: "stay" };
        }
        const result = await runCancellableOperation(ctx, "Checking current sync setup…", "sync", runRoute, {
          commitAware: true,
          signal: sessionSignal,
          target: state.manager.configReview?.setupName,
        });
        const disposition = await dispatchManagerResult(ctx, result, "sync", runRoute, sessionSignal);
        return disposition.kind === "close" ? { kind: "close" } : { kind: "stay" };
      },
      "retry-refusal": async ({ state, signal: actionSignal }) => {
        const signal = sessionSignal ? AbortSignal.any([sessionSignal, actionSignal]) : actionSignal;
        const validate = captureMutationOwner(ctx, signal);
        validate();
        const retryRoute: RunRoute = (route, operationSignal, onCommit, target, onDialog) =>
          runRoute(route, operationSignal, onCommit, target, onDialog, true);
        const result = await runCancellableOperation(ctx, "Checking cached refusal…", "sync", retryRoute, {
          commitAware: true,
          cancelAcrossDialogs: true,
          signal,
          target: state.manager.configReview?.setupName,
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
      settings: async ({ state, signal: actionSignal }) => {
        const signal = sessionSignal ? AbortSignal.any([sessionSignal, actionSignal]) : actionSignal;
        const review = state.manager.settingsReview ?? state.manager.configReview;
        const result = await showSyncSettings(ctx, runRoute, signal, review?.setupName);
        return { kind: result === "exit" ? "close" : "stay" };
      },
      pull: ({ state, signal }) => directionalAction("pull", state, signal),
      push: ({ state, signal }) => directionalAction("push", state, signal),
      setups: async () => {
        const result = await showSyncSetupManager(ctx, runRoute, sessionSignal);
        return result === "exit" ? { kind: "close" } : { kind: "stay" };
      },
      connections: async () => {
        await showStorageConnections(ctx, sessionSignal);
        return { kind: "stay" };
      },
      history: async ({ state }) => {
        const result = await runCancellableOperation(ctx, "Loading sync history…", "history", runRoute, {
          signal: sessionSignal,
          commitAware: true,
          cancelAcrossDialogs: true,
          target: state.manager.configReview?.setupName,
          cancelledMessage: "History review cancelled; no files were changed.",
        });
        return { kind: result.kind === "closed" ? "close" : "stay" };
      },
      diff: async ({ state }) => {
        const result = await runCancellableOperation(ctx, "Comparing local and remote…", "diff", runRoute, {
          target: state.manager.configReview?.setupName,
          signal: sessionSignal,
        });
        return { kind: result.kind === "closed" ? "close" : "stay" };
      },
      status: async ({ state }) => {
        const result = await runCancellableOperation(ctx, "Checking remote status…", "status", runRoute, {
          target: state.manager.configReview?.setupName,
          signal: sessionSignal,
        });
        return { kind: result.kind === "closed" ? "close" : "stay" };
      },
      doctor: async ({ state, signal: actionSignal }) => {
        const signal = sessionSignal ? AbortSignal.any([sessionSignal, actionSignal]) : actionSignal;
        const validate = captureMutationOwner(ctx, signal);
        const config = await loadConfig(state.manager.configReview?.setupName);
        validate();
        if (config.continuous) {
          const { continuousStatusLines } = await import("../sync/continuous-record.js");
          validate();
          const lines = await continuousStatusLines(config);
          validate();
          const review = await runDocumentReview(ctx, {
            title: "Sync diagnostics",
            lines: [`Setup: ${safeTerminalText(config.setupName)} · local observations only`],
            content: lines.join("\n"),
            confirmation: { label: "Continue to backend checks…" },
            hint: "back",
            signal,
            isCurrent,
          });
          validate();
          if (review.kind === "cancelled") return { kind: review.reason === "close" ? "close" : "stay" };
          if (review.kind !== "confirmed") return { kind: "stay" };
          const current = await loadConfig();
          validate();
          if (syncCheckConfigFingerprint(config) !== syncCheckConfigFingerprint(current)) {
            ctx.ui.notify("Setup changed during diagnostics review; reopen Diagnostics.", "warning");
            return { kind: "stay" };
          }
        }
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
      "daemon-recovery": async ({ signal }) => {
        await runRoute("daemon recover", signal);
        return { kind: "stay" };
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
        await runRoute("init", sessionSignal);
        return { kind: "stay" };
      },
      conflicts: async ({ state }) => {
        const result = await runCancellableOperation(ctx, "Reviewing private conflicts…", "conflicts", runRoute, {
          target: state.manager.configReview?.setupName,
          commitAware: true,
          signal: sessionSignal,
        });
        const disposition = await dispatchManagerResult(ctx, result, "sync", runRoute, sessionSignal);
        return disposition.kind === "close" ? { kind: "close" } : { kind: "stay" };
      },
    },
  });
  // Setup-specific actions must use the configuration shown by this screen, not
  // an active setup selected by another process while the menu was open.
  for (const action of [
    "review-attention",
    "sync",
    "retry-refusal",
    "settings",
    "pull",
    "push",
    "history",
    "diff",
    "status",
    "doctor",
    "conflicts",
  ] as const) {
    const activate = menu.actions[action];
    menu.actions[action] = async (invocation) => {
      validateOwner();
      const { configReview, settingsReview, recoveryPull } = invocation.state.manager;
      if (action === "pull" && recoveryPull) {
        if (options.getPendingPullReview?.() !== configReview) {
          ctx.ui.notify("The original Pull is no longer available for automatic recovery.", "warning");
          return { kind: "stay" };
        }
        return activate(invocation);
      }
      const review = action === "settings" ? (settingsReview ?? configReview) : configReview;
      let current = false;
      try {
        const config = await (action === "settings" ? loadSettingsConfig() : loadConfig());
        validateOwner();
        invocation.signal.throwIfAborted();
        current = review?.fingerprint === syncCheckConfigFingerprint(config);
      } catch {
        if (!isCurrent() || invocation.signal.aborted) return { kind: "close" };
      }
      if (!current) {
        ctx.ui.notify(
          "Sync setup changed while the manager was open. Review the refreshed setup before continuing.",
          "warning",
        );
        return { kind: "stay" };
      }
      return activate(invocation);
    };
  }
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
  let firstOpen = true;
  const recovery: State["manager"] = {
    title:
      "Pi Sync recovery required\nDaemon cleanup could not be confirmed. Stop the daemon before retrying a transfer.",
    actions: ["Stop daemon for recovery…", "Help"],
  };
  const describeRecovery = (): State["manager"] => {
    const configReview = options.getPendingPullReview?.();
    if (!configReview) return recovery;
    return {
      title: "Pi Sync recovery required\nPull can try to recover the daemon and review the pending transfer.",
      actions: ["Pull from remote", ...recovery.actions],
      configReview,
      recoveryPull: true,
    };
  };
  const describe = async (signal: AbortSignal) => {
    if (options.needsDaemonRecovery?.()) return describeRecovery();
    const pendingAttention = options.getAttention?.();
    const observation = options.getObservation?.();
    const manager = await describeManagerState(signal, pendingAttention, undefined, observation, () =>
      ignoreFileSettingsAvailable(ctx, signal),
    );
    if (signal.aborted || !isCurrent()) return manager;
    if (options.needsDaemonRecovery?.()) return describeRecovery();
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
    return manager;
  };
  await runMenu(menuContext, menu, {
    getState: async ({ signal }) => {
      const offerOnOpen = firstOpen;
      firstOpen = false;
      let manager = await describe(signal);
      if (
        offerOnOpen &&
        manager.operation?.kind === "free" &&
        manager.configReview &&
        (await showIgnoreMigrationPrompt(ctx, manager.configReview.setupName, signal, isCurrent))
      ) {
        if (!signal.aborted && isCurrent()) manager = await describe(signal);
      }
      return { manager };
    },
    signal: sessionSignal,
    isCurrent,
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
  | "daemon-recovery"
  | "refresh"
  | "help"
  | "init"
> {
  const actions = {
    "Sync now": "sync",
    "Retry refused model result…": "retry-refusal",
    "Pull from remote": "pull",
    "Push to remote": "push",
    "View differences": "diff",
    "Check remote status": "status",
    "Switch sync setup": "switch",
    Settings: "settings",
    History: "history",
    Diagnostics: "doctor",
    "Review unresolved conflicts": "conflicts",
    "Restore sync access… (recommended)": "recover",
    "Stop daemon for recovery…": "daemon-recovery",
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
    description: {
      sync: "Merge changes on both sides.",
      "retry-refusal": "Retry model; may incur costs.",
      pull: "Remote → this device; replaces conflicting local files.",
      push: "This device → remote; replaces conflicting remote files.",
      diff: "Inspect changes; no transfer.",
      status: "Check remote; no transfer.",
      settings: "Edit settings, setups, and storage connections.",
      history: "Review snapshots and rollback.",
      doctor: "Review backend diagnostics.",
      switch: "Choose another sync setup.",
      conflicts: "Review unresolved file groups.",
      recover: "Review local lock recovery.",
      "daemon-recovery": "Review and stop the current daemon without starting another.",
      refresh: "Recheck the operation lock.",
      setups: "Manage sync setups.",
      connections: "Manage storage connections.",
      help: "Read sync commands and safety.",
      init: "Configure a sync setup.",
    }[action],
  };
}
