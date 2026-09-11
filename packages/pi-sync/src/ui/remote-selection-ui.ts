import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { defineMenu, runMenu } from "@narumitw/pi-tui-kit";
import { createSyncBackend, type SyncBackendFactory } from "../backends/backend-factory.js";
import type { RemoteHead, SyncBackend } from "../backends/sync-backend.js";
import {
  loadConfig,
  loadPartialConfig,
  type SyncSetupStorageReview,
  syncConfigReviewFingerprint,
} from "../settings/config.js";
import { SyncSetupReviewChangedError, updateSyncSetup } from "../settings/settings-management.js";
import type { AnySyncConfig, PartialConfig } from "../settings/settings-types.js";
import { readSnapshotForHead } from "../sync/remote-snapshot.js";
import { errorMessage } from "../sync/sync-errors.js";
import {
  compareSyncInclude,
  inspectRemoteSelection,
  type RemoteSelectionDecision,
  type RemoteSelectionState,
  sameSyncInclude,
} from "../sync/sync-policy.js";
import { type RunRoute, type RunRouteResult, runCancellableOperation } from "./cancellable-operation.js";
import { safeTerminalText } from "./terminal-text.js";

const STATUS_KEY = "sync";

export type RemoteSelectionOrigin = "settings" | "sync" | "pull" | "push";

export interface RemoteSelectionReviewOptions {
  decision?: RemoteSelectionDecision;
  origin?: RemoteSelectionOrigin;
  runRoute?: RunRoute;
  cancelLabel?: string;
  /** The explicit mismatch is resolved or superseded; this does not imply file equality. */
  onSelectionResolved?: () => void;
  withStateAccess?: <T>(task: () => Promise<T>) => Promise<T>;
}

export type RemoteSelectionReviewResult =
  | { kind: "back" }
  | { kind: "closed" }
  | { kind: "done" }
  | { kind: "stale" }
  | { kind: "route-result"; result: RunRouteResult; route: "sync" | "pull" | "push" };

export async function showRemoteSelectionReview(
  ctx: ExtensionContext,
  setupName?: string,
  signal?: AbortSignal,
  factory: SyncBackendFactory = createSyncBackend,
  options: RemoteSelectionReviewOptions = {},
): Promise<RemoteSelectionReviewResult> {
  try {
    let decision = options.decision;
    if (!decision) {
      const inspected = await inspectConfiguredRemoteSelection(ctx, setupName, signal, factory);
      if (!inspected || signal?.aborted) return { kind: "stale" };
      // A successful fresh read can supersede an old explicit mismatch without
      // changing local settings. This is not user cancellation or proof of file equality.
      if (inspected.kind === "empty" || inspected.state.kind !== "different") {
        options.onSelectionResolved?.();
      }
      if (inspected.kind === "empty") {
        ctx.ui.notify("Remote storage has no snapshot or synced-content list yet.", "info");
        return { kind: "back" };
      }
      if (inspected.state.kind === "same") {
        ctx.ui.notify("Remote synced content already matches this sync setup.", "info");
        return { kind: "back" };
      }
      if (inspected.state.kind === "legacy") {
        if (ctx.mode !== "tui") {
          ctx.ui.notify(formatLegacySummary(inspected.config, inspected.state.discovered), "info");
          return { kind: "back" };
        }
        await showLegacyDiscovery(ctx, inspected.config, inspected.state.discovered, signal);
        return signal?.aborted ? { kind: "stale" } : { kind: "back" };
      }
      decision = decisionFromState(inspected.config, inspected.state);
    }

    if (ctx.mode !== "tui") {
      ctx.ui.notify(formatRemoteSelectionSummary(decision), "warning");
      return { kind: "back" };
    }

    let currentDecision = decision;
    for (;;) {
      if (signal?.aborted) return { kind: "stale" };
      const result = await showSelectionDifference(
        ctx,
        currentDecision,
        options.origin ?? "settings",
        options.runRoute,
        signal,
        factory,
        options,
      );
      if (result.kind !== "refresh") return result;
      const refreshed = await runWithOptionalStateAccess(options, () =>
        inspectConfiguredRemoteSelection(ctx, currentDecision.setupName, signal, factory),
      );
      if (!refreshed || signal?.aborted) return { kind: "stale" };
      if (refreshed.kind === "empty") {
        options.onSelectionResolved?.();
        ctx.ui.notify("Remote storage no longer has a snapshot or synced-content list.", "warning");
        return { kind: "back" };
      }
      if (refreshed.state.kind !== "different") {
        ctx.ui.notify(
          refreshed.state.kind === "same"
            ? "Remote synced content now matches this sync setup."
            : "The refreshed legacy snapshot has no authoritative synced-content list.",
          "info",
        );
        options.onSelectionResolved?.();
        return { kind: "done" };
      }
      currentDecision = decisionFromState(refreshed.config, refreshed.state);
    }
  } catch (error) {
    if (signal?.aborted) return { kind: "stale" };
    ctx.ui.notify(`Could not review synced content: ${errorMessage(error)}`, "error");
    return { kind: "back" };
  } finally {
    ctx.ui.setStatus(STATUS_KEY, undefined);
  }
}

type DifferenceFlowResult = RemoteSelectionReviewResult | { kind: "refresh" };

async function showSelectionDifference(
  ctx: ExtensionContext,
  initialDecision: RemoteSelectionDecision,
  origin: RemoteSelectionOrigin,
  runRoute: RunRoute | undefined,
  sessionSignal: AbortSignal | undefined,
  factory: SyncBackendFactory,
  options: Pick<RemoteSelectionReviewOptions, "cancelLabel" | "onSelectionResolved" | "withStateAccess">,
): Promise<DifferenceFlowResult> {
  type Screen = "choice" | "review" | "saved";
  type Action = "adopt" | "keep" | "cancel" | "continue" | "done";
  interface FlowState {
    decision: RemoteSelectionDecision;
    saved: boolean;
  }
  let flowState: FlowState = { decision: initialDecision, saved: false };
  let continuationReview: PartialConfig | undefined;
  let nextResult: RemoteSelectionReviewResult | undefined;
  let refreshRequested = false;
  const route = origin === "settings" ? "sync" : origin;
  const menu = defineMenu<FlowState, Screen, Action, ExtensionContext>({
    start: "choice",
    screens: {
      choice: ({ state }) => ({
        kind: "actions",
        title: "Synced content differs",
        lines: selectionSummaryLines(state.decision),
        items: [
          {
            id: "review",
            label: "Review all paths (recommended)",
            description: "Compare exact remote-only, device-only, and ordered lists.",
            to: "review",
          },
          {
            id: "adopt",
            label: "Use remote content list",
            description: "Save the reviewed list on this device without pulling files.",
            action: "adopt",
          },
          {
            id: "keep",
            label: "Keep this device's content list and update remote…",
            description: "Open the existing exact force-push preview without skipping confirmation.",
            action: "keep",
          },
          { id: "cancel", label: options.cancelLabel ?? "Cancel", action: "cancel" },
        ],
        hint: "back",
      }),
      review: ({ state }) => ({
        kind: "review",
        title: `Review synced content · ${safeTerminalText(state.decision.setupName)}`,
        content: formatSelectionDifference(state.decision),
        format: { kind: "text" },
        viewportSize: "adaptive",
        hint: "back",
      }),
      saved: ({ state }) => ({
        kind: "actions",
        title: "Remote content list saved",
        lines: [
          `Sync setup: ${safeTerminalText(state.decision.setupName)}`,
          "Only the included-content setting was saved.",
          "No files were pulled and sync state was not changed.",
        ],
        items: [
          ...(runRoute
            ? [
                {
                  id: "continue",
                  label: continueLabel(origin),
                  description: "Start a fresh check and exact preview for this sync setup.",
                  action: "continue" as const,
                },
              ]
            : []),
          { id: "done", label: "Done", action: "done" },
        ],
        hint: "close",
      }),
    },
    actions: {
      adopt: async ({ state, signal: actionSignal }) => {
        const signal = combineSignals(sessionSignal, actionSignal);
        try {
          const currentConfig = await loadConfig(state.decision.setupName);
          if (signal.aborted) return { kind: "close" as const };
          assertLocalSelectionCurrent(currentConfig, state.decision);
          if (!currentConfig.include.includes("sessions") && state.decision.remoteInclude.includes("sessions")) {
            const acknowledged = await ctx.ui.confirm(
              "Use a content list that includes session conversations?",
              "Session JSONL may contain prompts, tool output, file paths, images, and secrets. This saves the list only; it does not pull files.",
              { signal },
            );
            if (signal.aborted) return { kind: "close" as const };
            if (!acknowledged) return { kind: "stay" as const };
          }
          const review = await runWithOptionalStateAccess(options, async () => {
            const loaded = await loadAdoptionReview(state.decision, signal, factory);
            if (signal.aborted) throw signal.reason;
            await revalidateAndAdopt(loaded, state.decision, signal);
            return loaded;
          });
          if (signal.aborted) return { kind: "close" as const };
          options.onSelectionResolved?.();
          continuationReview = {
            ...review.storageReview,
            setupName: state.decision.setupName,
            include: [...state.decision.remoteInclude],
            automatic: review.config.automatic,
            onSwitch: review.config.onSwitch,
          };
          flowState = { decision: state.decision, saved: true };
          return { kind: "to" as const, screen: "saved" as const };
        } catch (error) {
          if (signal.aborted) return { kind: "close" as const };
          if (isStaleReviewError(error)) {
            ctx.ui.notify(`${errorMessage(error)} Refreshing the comparison.`, "warning");
            refreshRequested = true;
            return { kind: "close" as const };
          }
          ctx.ui.notify(`Could not save the remote content list: ${errorMessage(error)}`, "error");
          return { kind: "stay" as const };
        }
      },
      keep: async ({ state, signal: actionSignal }) => {
        if (!runRoute) {
          ctx.ui.notify("The reviewed update-remote route is unavailable.", "error");
          return { kind: "stay" as const };
        }
        const signal = combineSignals(sessionSignal, actionSignal);
        try {
          const latest = await loadConfig(state.decision.setupName);
          if (signal.aborted) return { kind: "close" as const };
          assertLocalSelectionCurrent(latest, state.decision);
          const result = await runCancellableOperation(
            ctx,
            "Preparing this device's push preview…",
            "push --force",
            runRoute,
            {
              commitAware: true,
              cancelledMessage: "Push preparation cancelled; no remote files were changed.",
              target: state.decision.setupName,
              signal,
            },
          );
          return handleNestedRouteResult(result, "push");
        } catch (error) {
          if (signal.aborted) return { kind: "close" as const };
          if (isStaleReviewError(error)) {
            ctx.ui.notify(`${errorMessage(error)} Refreshing the comparison.`, "warning");
            refreshRequested = true;
            return { kind: "close" as const };
          }
          ctx.ui.notify(`Could not prepare the remote update: ${errorMessage(error)}`, "error");
          return { kind: "stay" as const };
        }
      },
      continue: async ({ state, signal: actionSignal }) => {
        if (!runRoute || !continuationReview) return { kind: "stay" as const };
        const signal = combineSignals(sessionSignal, actionSignal);
        try {
          const latest = await loadPartialConfig(state.decision.setupName);
          if (signal.aborted) return { kind: "close" as const };
          if (!sameContinuationReview(latest, continuationReview)) {
            throw new StaleRemoteSelectionReviewError(
              `Sync setup “${safeTerminalText(state.decision.setupName)}” changed after the remote content list was saved.`,
            );
          }
          const result = await runCancellableOperation(ctx, continueBusyLabel(origin), route, runRoute, {
            commitAware: true,
            cancelledMessage: continuationCancelledMessage(route),
            target: state.decision.setupName,
            signal,
          });
          return handleNestedRouteResult(result, route);
        } catch (error) {
          if (signal.aborted) return { kind: "close" as const };
          ctx.ui.notify(`Could not continue: ${errorMessage(error)}`, "error");
          return { kind: "stay" as const };
        }
      },
      cancel: async () => ({ kind: "back" }),
      done: async () => {
        nextResult = { kind: "done" };
        return { kind: "close" };
      },
    },
  });

  function handleNestedRouteResult(
    result: Awaited<ReturnType<typeof runCancellableOperation>>,
    nestedRoute: "sync" | "pull" | "push",
  ) {
    if (result.kind === "completed" && result.outcome === "applied") {
      options.onSelectionResolved?.();
    }
    if (result.kind === "closed") {
      nextResult = { kind: "closed" };
      return { kind: "close" as const };
    }
    if (
      result.kind === "cancelled" ||
      (result.kind === "completed" && result.outcome === "cancelled") ||
      result.kind === "failed"
    ) {
      return { kind: "stay" as const };
    }
    nextResult = { kind: "route-result", result, route: nestedRoute };
    return { kind: "close" as const };
  }

  const menuResult = await runMenu(ctx, menu, {
    getState: () => flowState,
    signal: sessionSignal,
    isCurrent: () => !sessionSignal?.aborted,
    onError: (_menuCtx, error) => ctx.ui.notify(errorMessage(error), "error"),
  });
  if (sessionSignal?.aborted || menuResult.kind === "stale") return { kind: "stale" };
  if (refreshRequested) return { kind: "refresh" };
  if (nextResult) return nextResult;
  if (menuResult.kind === "closed") {
    return menuResult.reason === "back" ? { kind: "back" } : { kind: "closed" };
  }
  return { kind: "closed" };
}

interface AdoptionReview {
  config: AnySyncConfig;
  storageReview: SyncSetupStorageReview;
  backend: SyncBackend;
  reviewedHead: RemoteHead;
}

async function loadAdoptionReview(
  decision: RemoteSelectionDecision,
  signal: AbortSignal,
  factory: SyncBackendFactory,
): Promise<AdoptionReview> {
  const config = await loadConfig(decision.setupName);
  throwIfAborted(signal);
  assertLocalSelectionCurrent(config, decision);
  const partial = await loadPartialConfig(decision.setupName);
  throwIfAborted(signal);
  if (!sameSyncInclude(partial.include, decision.localInclude)) {
    throw new StaleRemoteSelectionReviewError(
      `Sync setup “${safeTerminalText(decision.setupName)}” changed while the comparison was open.`,
    );
  }
  const backend = await factory(config);
  throwIfAborted(signal);
  const reviewedHead = await backend.readHead(signal);
  throwIfAborted(signal);
  if (!reviewedHead) {
    throw new StaleRemoteSelectionReviewError("Remote storage changed while the comparison was open.");
  }
  const snapshot = await readSnapshotForHead(backend, reviewedHead, signal);
  throwIfAborted(signal);
  const state = inspectRemoteSelection(config.include, snapshot);
  if (state.kind !== "different" || !sameSyncInclude(state.include, decision.remoteInclude)) {
    throw new StaleRemoteSelectionReviewError("Remote synced content changed while the comparison was open.");
  }
  return { config, storageReview: partial, backend, reviewedHead };
}

async function revalidateAndAdopt(review: AdoptionReview, decision: RemoteSelectionDecision, signal: AbortSignal) {
  const currentHead = await review.backend.readHead(signal);
  throwIfAborted(signal);
  if (!currentHead || !review.backend.sameRevision(review.reviewedHead.revision, currentHead.revision)) {
    throw new StaleRemoteSelectionReviewError("Remote storage changed while the comparison was open.");
  }
  const currentSnapshot = await readSnapshotForHead(review.backend, currentHead, signal);
  throwIfAborted(signal);
  const currentState = inspectRemoteSelection(review.config.include, currentSnapshot);
  if (currentState.kind !== "different" || !sameSyncInclude(currentState.include, decision.remoteInclude)) {
    throw new StaleRemoteSelectionReviewError("Remote synced content changed while the comparison was open.");
  }
  await updateSyncSetup(
    decision.setupName,
    (setup) => ({
      ...setup,
      sync: { ...setup.sync, include: [...decision.remoteInclude] },
    }),
    {
      expectedStorage: review.storageReview,
      expectedInclude: decision.localInclude,
      signal,
    },
  );
}

async function inspectConfiguredRemoteSelection(
  ctx: ExtensionContext,
  setupName: string | undefined,
  signal: AbortSignal | undefined,
  factory: SyncBackendFactory,
): Promise<
  | { kind: "empty"; config: AnySyncConfig }
  | { kind: "selection"; config: AnySyncConfig; state: RemoteSelectionState }
  | undefined
> {
  const config = await loadConfig(setupName);
  if (signal?.aborted) return undefined;
  ctx.ui.setStatus(STATUS_KEY, `checking synced content for ${safeTerminalText(config.setupName)}`);
  const backend = await factory(config);
  if (signal?.aborted) return undefined;
  const head = await backend.readHead(signal);
  if (signal?.aborted) return undefined;
  if (!head) return { kind: "empty", config };
  const snapshot = await readSnapshotForHead(backend, head, signal);
  if (signal?.aborted) return undefined;
  return {
    kind: "selection",
    config,
    state: inspectRemoteSelection(config.include, snapshot),
  };
}

async function showLegacyDiscovery(
  ctx: ExtensionContext,
  config: AnySyncConfig,
  discovered: string[],
  signal?: AbortSignal,
) {
  const menu = defineMenu<undefined, "choice" | "review", "back", ExtensionContext>({
    start: "choice",
    screens: {
      choice: () => ({
        kind: "actions",
        title: `Compare synced content · ${safeTerminalText(config.setupName)}`,
        lines: [
          "This legacy snapshot has no portable synced-content list.",
          "Discovered paths are partial and read-only; preserved files may not have been selected.",
        ],
        items: [
          { id: "review", label: "Review discovered paths", to: "review" },
          { id: "back", label: "Back", action: "back" },
        ],
        hint: "close",
      }),
      review: () => ({
        kind: "review",
        title: "Partial discovery from legacy snapshot",
        content: [
          "Partial discovery only — not an authoritative selection.",
          "",
          ...(discovered.length > 0
            ? discovered.map((item) => `Discovered: ${safeTerminalText(item)}`)
            : ["No safe paths were discovered."]),
          "",
          "Use Add custom path… in the local Included Content editor if needed.",
        ].join("\n"),
        format: { kind: "text" },
        viewportSize: "adaptive",
        hint: "back",
      }),
    },
    actions: { back: async () => ({ kind: "close" }) },
  });
  await runMenu(ctx, menu, {
    getState: () => undefined,
    signal,
    isCurrent: () => !signal?.aborted,
  });
}

function selectionSummaryLines(decision: RemoteSelectionDecision) {
  const comparison = compareSyncInclude(decision.localInclude, decision.remoteInclude);
  return [
    `Sync setup: ${safeTerminalText(decision.setupName)}`,
    "Nothing changed. Review both lists before choosing what happens next.",
    ...(comparison.remoteOnly.length === 0 && comparison.localOnly.length === 0
      ? ["Only the ordering differs; membership is the same."]
      : [`Remote-only paths: ${comparison.remoteOnly.length} · Device-only paths: ${comparison.localOnly.length}`]),
  ];
}

function formatSelectionDifference(decision: RemoteSelectionDecision) {
  const comparison = compareSyncInclude(decision.localInclude, decision.remoteInclude);
  return [
    ...(comparison.remoteOnly.length === 0 && comparison.localOnly.length === 0
      ? ["Only ordering differs; both lists contain the same paths.", ""]
      : []),
    "Remote-only paths:",
    ...(comparison.remoteOnly.length > 0
      ? comparison.remoteOnly.map((item) => `+ ${safeTerminalText(item)}`)
      : ["(none)"]),
    "",
    "Device-only paths:",
    ...(comparison.localOnly.length > 0
      ? comparison.localOnly.map((item) => `- ${safeTerminalText(item)}`)
      : ["(none)"]),
    "",
    "Remote ordered list:",
    ...(decision.remoteInclude.length > 0
      ? decision.remoteInclude.map((item, index) => `${index + 1}. ${safeTerminalText(item)}`)
      : ["(none)"]),
    "",
    "This device's ordered list:",
    ...(decision.localInclude.length > 0
      ? decision.localInclude.map((item, index) => `${index + 1}. ${safeTerminalText(item)}`)
      : ["(none)"]),
    "",
    "Using the remote list saves settings only and does not pull files.",
  ].join("\n");
}

function formatRemoteSelectionSummary(decision: RemoteSelectionDecision) {
  const comparison = compareSyncInclude(decision.localInclude, decision.remoteInclude);
  return [
    `Synced content for “${safeTerminalText(decision.setupName)}” differs from this device.`,
    `Remote-only: ${safeList(comparison.remoteOnly)}`,
    `Device-only: ${safeList(comparison.localOnly)}`,
    ...(comparison.remoteOnly.length === 0 && comparison.localOnly.length === 0
      ? [
          "Only ordering differs.",
          `Remote order: ${safeList(decision.remoteInclude)}`,
          `Device order: ${safeList(decision.localInclude)}`,
        ]
      : []),
    "Run /sync in TUI to choose a content list; RPC review is read-only.",
  ].join("\n");
}

function formatLegacySummary(config: AnySyncConfig, discovered: readonly string[]) {
  return `Remote snapshot for “${safeTerminalText(config.setupName)}” has no portable synced-content list; ${discovered.length} safe path${discovered.length === 1 ? " was" : "s were"} discovered, but the result is partial and read-only.`;
}

function decisionFromState(
  config: AnySyncConfig,
  state: Extract<RemoteSelectionState, { kind: "different" }>,
): RemoteSelectionDecision {
  return {
    setupName: config.setupName,
    configIdentity: syncConfigReviewFingerprint(config),
    localInclude: [...config.include],
    remoteInclude: [...state.include],
  };
}

function assertLocalSelectionCurrent(config: AnySyncConfig, decision: RemoteSelectionDecision) {
  if (
    syncConfigReviewFingerprint(config) === decision.configIdentity &&
    sameSyncInclude(config.include, decision.localInclude)
  ) {
    return;
  }
  throw new StaleRemoteSelectionReviewError(
    `Sync setup “${safeTerminalText(config.setupName)}” changed while the comparison was open.`,
  );
}

function sameContinuationReview(left: PartialConfig, right: PartialConfig) {
  return (
    left.setupName === right.setupName &&
    left.connectionName === right.connectionName &&
    left.storageKind === right.storageKind &&
    left.storagePath === right.storagePath &&
    left.bucket === right.bucket &&
    left.branch === right.branch &&
    sameSyncInclude(left.include, right.include)
  );
}

function continueLabel(origin: RemoteSelectionOrigin) {
  if (origin === "pull") return "Continue Pull now…";
  if (origin === "push") return "Continue Push now…";
  return "Continue Sync now…";
}

function continueBusyLabel(origin: RemoteSelectionOrigin) {
  if (origin === "pull") return "Checking remote changes…";
  if (origin === "push") return "Preparing push preview…";
  return "Checking current sync setup…";
}

function continuationCancelledMessage(route: "sync" | "pull" | "push") {
  if (route === "pull") return "Pull check cancelled; no local files were changed.";
  if (route === "push") return "Push preparation cancelled; no remote files were changed.";
  return "Sync check cancelled; no settings or files were changed.";
}

function safeList(values: readonly string[]) {
  return values.length > 0 ? values.map(safeTerminalText).join(", ") : "none";
}

class StaleRemoteSelectionReviewError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StaleRemoteSelectionReviewError";
  }
}

function isStaleReviewError(error: unknown) {
  return error instanceof StaleRemoteSelectionReviewError || error instanceof SyncSetupReviewChangedError;
}

function runWithOptionalStateAccess<T>(
  options: Pick<RemoteSelectionReviewOptions, "withStateAccess">,
  task: () => Promise<T>,
) {
  return options.withStateAccess ? options.withStateAccess(task) : task();
}

function combineSignals(sessionSignal: AbortSignal | undefined, actionSignal: AbortSignal) {
  return sessionSignal ? AbortSignal.any([sessionSignal, actionSignal]) : actionSignal;
}

function throwIfAborted(signal: AbortSignal) {
  if (!signal.aborted) return;
  throw signal.reason instanceof Error ? signal.reason : new DOMException("The operation was aborted", "AbortError");
}
