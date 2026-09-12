import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { CancellableOperationResult, RunRoute, RunRouteResult } from "./cancellable-operation.js";
import { type RemoteSelectionOrigin, showRemoteSelectionReview } from "./remote-selection-ui.js";
import { showSyncResolution } from "./sync-resolution-ui.js";

const MAX_DECISION_TRANSITIONS = 32;

export interface ManagerResultDisposition {
  kind: "close" | "stay";
  appliedRoute?: "sync" | "pull" | "push";
}

export interface ManagerResultOptions {
  cancelLabel?: string;
  onSelectionResolved?: () => void;
  withStateAccess?: <T>(task: () => Promise<T>) => Promise<T>;
}

export async function dispatchManagerResult(
  ctx: ExtensionContext,
  initialResult: CancellableOperationResult,
  origin: Exclude<RemoteSelectionOrigin, "settings">,
  runRoute: RunRoute,
  signal?: AbortSignal,
  options: ManagerResultOptions = {},
): Promise<ManagerResultDisposition> {
  let result: CancellableOperationResult | RunRouteResult = initialResult;
  let currentRoute: "sync" | "pull" | "push" = origin;
  let resolving = false;

  for (let transition = 0; transition < MAX_DECISION_TRANSITIONS; transition += 1) {
    if (signal?.aborted) return { kind: "close" };
    if (result.kind === "remote-selection-required") {
      resolving = true;
      const resolution = await showRemoteSelectionReview(ctx, result.decision.setupName, signal, undefined, {
        decision: result.decision,
        origin: currentRoute,
        runRoute,
        cancelLabel: options.cancelLabel,
        onSelectionResolved: options.onSelectionResolved,
        withStateAccess: options.withStateAccess,
      });
      if (resolution.kind === "route-result") {
        result = resolution.result;
        currentRoute = resolution.route;
        continue;
      }
      return resolution.kind === "closed" || resolution.kind === "stale" ? { kind: "close" } : { kind: "stay" };
    }
    if (result.kind === "decision-required") {
      resolving = true;
      const resolution = await showSyncResolution(ctx, result.decision, runRoute, signal);
      if (resolution.kind === "route-result") {
        result = resolution.result;
        currentRoute = resolution.route;
        continue;
      }
      if (resolution.kind === "resolved") {
        return { kind: "close", appliedRoute: resolution.direction };
      }
      return resolution.kind === "closed" || resolution.kind === "stale" ? { kind: "close" } : { kind: "stay" };
    }
    if (result.kind === "closed") return { kind: "close" };
    if (result.kind === "completed") {
      const appliedRoute = result.outcome === "applied" ? currentRoute : undefined;
      if (resolving || (origin === "pull" && result.outcome === "applied")) {
        return { kind: "close", ...(appliedRoute ? { appliedRoute } : {}) };
      }
      return { kind: "stay", ...(appliedRoute ? { appliedRoute } : {}) };
    }
    return { kind: "stay" };
  }

  ctx.ui.notify(
    "Sync resolution stopped after too many state changes. Start /sync again to review fresh state.",
    "warning",
  );
  return { kind: "stay" };
}
