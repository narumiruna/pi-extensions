import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { defineMenu, runMenu } from "@narumitw/pi-tui-kit";
import { loadConfig, syncConfigReviewIdentity } from "../settings/config.js";
import type { SyncDecision, SyncResolutionDirection } from "../sync/sync-decision.js";
import { errorMessage } from "../sync/sync-errors.js";
import { type RunRoute, type RunRouteResult, runCancellableOperation } from "./cancellable-operation.js";
import { safeTerminalText } from "./terminal-text.js";

export type SyncResolutionResult =
  | { kind: "resolved"; direction: SyncResolutionDirection }
  | {
      kind: "route-result";
      result: RunRouteResult;
      route: SyncResolutionDirection;
    }
  | { kind: "back" }
  | { kind: "closed" }
  | { kind: "stale" };

export async function showSyncResolution(
  ctx: ExtensionContext,
  initialDecision: SyncDecision,
  runRoute: RunRoute,
  sessionSignal?: AbortSignal,
): Promise<SyncResolutionResult> {
  type Screen = "resolve" | "review";
  type Action = "push" | "pull" | "back";
  let currentDecision = initialDecision;
  let resolvedDirection: SyncResolutionDirection | undefined;
  let chainedResult: { result: RunRouteResult; route: SyncResolutionDirection } | undefined;
  const menu = defineMenu<SyncDecision, Screen, Action, ExtensionContext>({
    start: "resolve",
    screens: {
      resolve: ({ state }) => ({
        kind: "actions",
        title: resolutionTitle(state),
        lines: resolutionLines(state),
        items: [
          { id: "review", label: "Review differences (recommended)", to: "review" },
          ...(state.directions.includes("push")
            ? [
                {
                  id: "push",
                  label: pushLabel(state),
                  description: "Review an exact push before replacing the remote version.",
                  action: "push" as const,
                },
              ]
            : []),
          ...(state.directions.includes("pull")
            ? [
                {
                  id: "pull",
                  label: pullLabel(state),
                  description: "Review exact local changes and create a backup before applying.",
                  action: "pull" as const,
                },
              ]
            : []),
          { id: "back", label: "Back", action: "back" },
        ],
        hint: "back",
      }),
      review: ({ state }) => ({
        kind: "review",
        title: `Review differences · ${safeTerminalText(state.setupName)}`,
        content: state.review,
        format: { kind: "text" },
        viewportSize: "adaptive",
        hint: "back",
      }),
    },
    actions: {
      push: ({ state, signal }) => resolveDirection("push", state, signal),
      pull: ({ state, signal }) => resolveDirection("pull", state, signal),
      back: async () => ({ kind: "back" }),
    },
  });

  async function resolveDirection(
    direction: SyncResolutionDirection,
    decision: SyncDecision,
    actionSignal: AbortSignal,
  ) {
    const signal = sessionSignal ? AbortSignal.any([sessionSignal, actionSignal]) : actionSignal;
    const config = await loadConfig(decision.setupName);
    if (signal.aborted) return { kind: "close" as const };
    if (syncConfigReviewIdentity(config) !== decision.configIdentity) {
      throw new Error(
        `Sync setup “${safeTerminalText(decision.setupName)}” changed while conflict resolution was open; return to the sync manager and retry.`,
      );
    }
    const result = await runCancellableOperation(
      ctx,
      direction === "push" ? "Preparing local-wins push preview…" : "Preparing remote-wins pull preview…",
      `${direction} --force`,
      runRoute,
      {
        commitAware: true,
        cancelledMessage:
          direction === "push"
            ? "Push preparation cancelled; no remote files were changed."
            : "Pull check cancelled; no local files were changed.",
        target: decision.setupName,
        signal,
      },
    );
    if (result.kind === "decision-required") {
      currentDecision = result.decision;
      return { kind: "stay" as const };
    }
    if (result.kind === "remote-selection-required") {
      chainedResult = { result, route: direction };
      return { kind: "close" as const };
    }
    if (result.kind === "completed") {
      if (result.outcome === "cancelled") return { kind: "stay" as const };
      resolvedDirection = direction;
      return { kind: "close" as const };
    }
    return result.kind === "closed" ? { kind: "close" as const } : { kind: "stay" as const };
  }

  const result = await runMenu(ctx, menu, {
    getState: () => currentDecision,
    signal: sessionSignal,
    isCurrent: () => !sessionSignal?.aborted,
    onError: (_menuCtx, error) => ctx.ui.notify(errorMessage(error), "error"),
  });
  if (sessionSignal?.aborted || result.kind === "stale") return { kind: "stale" };
  if (chainedResult) return { kind: "route-result", ...chainedResult };
  if (resolvedDirection) return { kind: "resolved", direction: resolvedDirection };
  if (result.kind === "closed") {
    return result.reason === "back" ? { kind: "back" } : { kind: "closed" };
  }
  return { kind: "closed" };
}

function resolutionTitle(decision: SyncDecision) {
  return decision.kind === "remote-empty" ? "Remote is empty" : "Resolve sync conflict";
}

function resolutionLines(decision: SyncDecision) {
  return [
    `Sync setup: ${safeTerminalText(decision.setupName)}`,
    ...causeSummary(decision),
    "No files have been changed by this failed operation.",
  ];
}

function causeSummary(decision: SyncDecision) {
  if (decision.kind === "first-sync-settings-diverged") {
    return ["This machine and the remote have different Pi settings on first sync."];
  }
  if (decision.kind === "first-sync-sessions-diverged") {
    return ["Pi settings match, but local and remote sessions differ on first sync."];
  }
  if (decision.kind === "remote-empty") return ["The remote storage location has no snapshot."];
  return [
    ...(decision.causes.localChanged ? ["Local content changed since the last sync."] : []),
    ...(decision.causes.remoteChanged ? ["Remote content changed since the last sync."] : []),
    ...(decision.causes.policyChanged ? ["Included content changed since the last sync."] : []),
  ];
}

function pushLabel(decision: SyncDecision) {
  if (decision.kind === "remote-empty") return "Push local content…";
  if (decision.kind.startsWith("first-sync-")) return "Use local as initial source…";
  return "Keep local content and replace remote…";
}

function pullLabel(decision: SyncDecision) {
  return decision.kind.startsWith("first-sync-")
    ? "Use remote as initial source…"
    : "Use remote content and replace local…";
}
