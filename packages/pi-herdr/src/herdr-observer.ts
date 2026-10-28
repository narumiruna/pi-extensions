import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { createEditorStatusPublisher, type EditorStatusPublisher } from "@narumitw/pi-tui-kit/editor-status-publisher";
import { type HerdrRequest, type HerdrSubscription, openHerdrSubscription, requestHerdr } from "./herdr-client.js";
import {
  type HerdrPane,
  type HerdrPaneEvent,
  type HerdrWorkspace,
  herdrWidgetSubscriptions,
  parseAgentListResult,
  parseHerdrPaneEvent,
  parsePaneCurrentResult,
  parsePaneListResult,
  parseWorkspaceGetResult,
} from "./herdr-protocol.js";
import {
  createHerdrWidget,
  HERDR_WIDGET_KEY,
  HerdrWidgetModel,
  type HerdrWidgetSnapshot,
  herdrWidgetFingerprint,
} from "./herdr-widget.js";

export interface HerdrObserverEnvironment {
  paneId: string;
  socketEndpoint: string;
}

export interface HerdrObserverOptions {
  environment: HerdrObserverEnvironment;
  now?: () => number;
  random?: () => number;
  request?: (socketEndpoint: string, request: HerdrRequest, signal: AbortSignal) => Promise<unknown>;
  subscribe?: (
    socketEndpoint: string,
    request: HerdrRequest,
    signal: AbortSignal,
    onEvent: (frame: unknown) => void,
  ) => Promise<HerdrSubscription>;
  retryDelayMs?: number;
}

export interface HerdrWidgetObserver {
  start(ctx: ExtensionContext): void;
  shutdown(ctx: ExtensionContext): Promise<void>;
}

class HerdrTopologyChangedError extends Error {}
class HerdrCleanupError extends AggregateError {}

function renderHerdrWidget(snapshot: HerdrWidgetSnapshot, theme: Theme, width: number): readonly string[] {
  return createHerdrWidget(snapshot, theme).render(width);
}

function isRelevantEvent(model: HerdrWidgetModel, event: HerdrPaneEvent): boolean {
  if (event.type === "created" || event.type === "updated") {
    return model.isCurrentWorkspace(event.pane.workspaceId);
  }
  if (event.type === "moved") {
    return (
      model.isCurrentPane(event.previousPaneId) ||
      model.isCurrentWorkspace(event.previousWorkspaceId) ||
      model.isCurrentWorkspace(event.pane.workspaceId)
    );
  }
  return "workspaceId" in event && model.isCurrentWorkspace(event.workspaceId);
}

function subscriptionFingerprint(currentPane: HerdrPane, panes: readonly HerdrPane[]): string {
  const agentPaneIds = panes
    .filter((pane) => pane.agent !== undefined)
    .map((pane) => pane.paneId)
    .sort();
  return JSON.stringify([currentPane.paneId, currentPane.workspaceId, agentPaneIds]);
}

function waitForRetry(delayMs: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(signal.reason);
  if (delayMs <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, delayMs);
    timer.unref?.();
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    signal.addEventListener("abort", abort, { once: true });
  });
}

export function createHerdrWidgetObserver(options: HerdrObserverOptions): HerdrWidgetObserver {
  const now = options.now ?? Date.now;
  const random = options.random ?? Math.random;
  const request = options.request ?? requestHerdr;
  const subscribe = options.subscribe ?? openHerdrSubscription;
  const retryDelayMs = options.retryDelayMs ?? 200;
  let generation = 0;
  let publisher: EditorStatusPublisher<HerdrWidgetSnapshot> | undefined;
  let activeSession: ExtensionContext["sessionManager"] | undefined;
  let controller: AbortController | undefined;
  const ownedTasks = new Set<Promise<void>>();
  const taskErrors = new Set<unknown>();
  let publishedFingerprint: string | undefined;
  let hasPublished = false;

  const owns = (ctx: ExtensionContext, expectedGeneration = generation) =>
    expectedGeneration === generation && ctx.sessionManager === activeSession;

  const requestId = (kind: string) => `herdr:pi:widget:${kind}:${now()}:${random().toString(36).slice(2)}`;

  const clearWidget = () => {
    publisher?.publish(undefined);
    publishedFingerprint = undefined;
    hasPublished = false;
  };

  const publish = (ctx: ExtensionContext, model: HerdrWidgetModel, expectedGeneration: number) => {
    if (!owns(ctx, expectedGeneration) || ctx.mode !== "tui") return;
    const snapshot = model.snapshot();
    const fingerprint = herdrWidgetFingerprint(snapshot);
    if (hasPublished && fingerprint === publishedFingerprint) return;
    publisher?.publish(snapshot);
    publishedFingerprint = fingerprint;
    hasPublished = true;
  };

  const loadPaneSet = async (
    ctx: ExtensionContext,
    expectedGeneration: number,
    signal: AbortSignal,
  ): Promise<{ currentPane: HerdrPane; panes: HerdrPane[]; workspace: HerdrWorkspace } | undefined> => {
    const currentResult = await request(
      options.environment.socketEndpoint,
      {
        id: requestId("current"),
        method: "pane.current",
        params: { caller_pane_id: options.environment.paneId },
      },
      signal,
    );
    if (!owns(ctx, expectedGeneration) || signal.aborted) return undefined;
    const currentPane = parsePaneCurrentResult(currentResult);
    const [listResult, agentResult, workspaceResult] = await Promise.all([
      request(
        options.environment.socketEndpoint,
        {
          id: requestId("list"),
          method: "pane.list",
          params: { workspace_id: currentPane.workspaceId },
        },
        signal,
      ),
      request(
        options.environment.socketEndpoint,
        { id: requestId("agents"), method: "agent.list", params: {} },
        signal,
      ),
      request(
        options.environment.socketEndpoint,
        {
          id: requestId("workspace"),
          method: "workspace.get",
          params: { workspace_id: currentPane.workspaceId },
        },
        signal,
      ),
    ]);
    if (!owns(ctx, expectedGeneration) || signal.aborted) return undefined;
    const panes = parsePaneListResult(listResult);
    const paneIds = new Set(panes.map((pane) => pane.paneId));
    const namesByPane = new Map(
      parseAgentListResult(agentResult)
        .filter((pane) => pane.workspaceId === currentPane.workspaceId && paneIds.has(pane.paneId))
        .map((pane) => [pane.paneId, pane.agentName]),
    );
    const withAgentName = (pane: HerdrPane): HerdrPane => ({
      ...pane,
      agentName: namesByPane.get(pane.paneId) ?? pane.agentName,
    });
    const workspace = parseWorkspaceGetResult(workspaceResult);
    if (workspace.workspaceId !== currentPane.workspaceId) {
      throw new Error("Herdr returned a mismatched workspace");
    }
    return {
      currentPane: withAgentName(currentPane),
      panes: panes.map(withAgentName),
      workspace,
    };
  };

  const runAttempt = async (
    ctx: ExtensionContext,
    expectedGeneration: number,
    sessionSignal: AbortSignal,
  ): Promise<void> => {
    const attemptController = new AbortController();
    const abortAttempt = () => attemptController.abort(sessionSignal.reason);
    if (sessionSignal.aborted) abortAttempt();
    else sessionSignal.addEventListener("abort", abortAttempt, { once: true });
    const signal = attemptController.signal;
    let attemptActive = true;
    let subscription: HerdrSubscription | undefined;
    let failure: Error | undefined;
    let attemptError: { error: unknown } | undefined;
    let cleanupFailure: { error: unknown } | undefined;
    let wake: (() => void) | undefined;
    const wakeRefresh = () => {
      const resolve = wake;
      wake = undefined;
      resolve?.();
    };
    signal.addEventListener("abort", wakeRefresh);
    const failAttempt = (error: Error) => {
      if (!attemptActive || signal.aborted) return;
      failure = error;
      try {
        if (owns(ctx, expectedGeneration)) clearWidget();
      } catch (cleanupError) {
        failure = new AggregateError([error, cleanupError], "Herdr subscription and widget cleanup failed");
      } finally {
        // Never leave the refresh wait alive because UI cleanup failed.
        attemptController.abort(failure);
      }
    };
    try {
      await (async () => {
        const discovered = await loadPaneSet(ctx, expectedGeneration, signal);
        if (!discovered) return;
        const subscribedFingerprint = subscriptionFingerprint(discovered.currentPane, discovered.panes);
        const model = new HerdrWidgetModel();
        model.reset(discovered.currentPane, discovered.panes, discovered.workspace);
        let dirty = true;

        subscription = await subscribe(
          options.environment.socketEndpoint,
          {
            id: requestId("subscribe"),
            method: "events.subscribe",
            params: { subscriptions: herdrWidgetSubscriptions(discovered.panes) },
          },
          signal,
          (frame) => {
            if (!attemptActive || !owns(ctx, expectedGeneration) || signal.aborted) return;
            const event = parseHerdrPaneEvent(frame);
            if (!event || !isRelevantEvent(model, event)) return;
            dirty = true;
            wakeRefresh();
          },
        ).catch(async (error: unknown) => {
          if (!owns(ctx, expectedGeneration) || signal.aborted) throw error;
          // A pane can disappear between discovery and subscription acceptance.
          // Verify a changed target set before exempting this from outage retries.
          const latest = await loadPaneSet(ctx, expectedGeneration, signal);
          if (latest && subscriptionFingerprint(latest.currentPane, latest.panes) !== subscribedFingerprint) {
            throw new HerdrTopologyChangedError();
          }
          throw error;
        });
        void subscription.closed.then(
          () => failAttempt(new Error("Herdr subscription ended")),
          (error) => failAttempt(error instanceof Error ? error : new Error(String(error))),
        );

        while (owns(ctx, expectedGeneration) && !signal.aborted) {
          dirty = false;
          const refreshed = await loadPaneSet(ctx, expectedGeneration, signal);
          if (!refreshed || signal.aborted) break;
          // Events and reads have no common sequence boundary. Never replay event
          // payloads over a read, or publish a read invalidated while in flight.
          if (dirty) continue;
          if (subscriptionFingerprint(refreshed.currentPane, refreshed.panes) !== subscribedFingerprint) {
            throw new HerdrTopologyChangedError();
          }
          model.reset(refreshed.currentPane, refreshed.panes, refreshed.workspace);
          publish(ctx, model, expectedGeneration);
          await new Promise<void>((resolve) => {
            wake = resolve;
            if (dirty || signal.aborted) wakeRefresh();
          });
        }
        if (failure) throw failure;
      })();
    } catch (error) {
      attemptError = { error };
    } finally {
      attemptActive = false;
      attemptController.abort(new DOMException("Herdr widget attempt ended", "AbortError"));
      signal.removeEventListener("abort", wakeRefresh);
      sessionSignal.removeEventListener("abort", abortAttempt);
      try {
        subscription?.close();
      } catch (cleanupError) {
        cleanupFailure = { error: cleanupError };
      }
    }
    if (cleanupFailure) {
      throw new HerdrCleanupError(
        attemptError ? [attemptError.error, cleanupFailure.error] : [cleanupFailure.error],
        "Herdr subscription cleanup failed",
      );
    }
    if (attemptError) throw attemptError.error;
  };

  const run = async (ctx: ExtensionContext, expectedGeneration: number, signal: AbortSignal): Promise<void> => {
    let failures = 0;
    while (owns(ctx, expectedGeneration) && !signal.aborted) {
      try {
        await runAttempt(ctx, expectedGeneration, signal);
        return;
      } catch (error) {
        if (error instanceof HerdrCleanupError) throw error;
        if (!owns(ctx, expectedGeneration) || signal.aborted) return;
        try {
          clearWidget();
        } catch (cleanupError) {
          throw new AggregateError([error, cleanupError], "Herdr observation and widget cleanup failed");
        }
        if (error instanceof HerdrTopologyChangedError) continue;
        failures += 1;
        if (failures >= 2) return;
        try {
          await waitForRetry(retryDelayMs, signal);
        } catch {
          return;
        }
        if (!owns(ctx, expectedGeneration) || signal.aborted) return;
      }
    }
  };

  return {
    start(ctx) {
      controller?.abort(new DOMException("Herdr widget session replaced", "AbortError"));
      try {
        publisher?.dispose();
      } finally {
        // Invalidate old reads even if clearing the old widget throws.
        publisher = undefined;
        generation += 1;
        activeSession = undefined;
        controller = undefined;
        publishedFingerprint = undefined;
        hasPublished = false;
      }
      if (ctx.mode !== "tui") return;

      activeSession = ctx.sessionManager;
      controller = new AbortController();
      const expectedGeneration = generation;
      publisher = createEditorStatusPublisher({
        key: HERDR_WIDGET_KEY,
        context: ctx,
        isCurrent: () => expectedGeneration === generation,
        render: renderHerdrWidget,
      });
      const task = run(ctx, expectedGeneration, controller.signal);
      ownedTasks.add(task);
      // Observe every background rejection immediately; shutdown reports failures
      // after joining source cleanup instead of leaking an unhandled rejection.
      void task.then(
        () => ownedTasks.delete(task),
        (error) => {
          taskErrors.add(error);
          ownedTasks.delete(task);
        },
      );
    },
    async shutdown(ctx) {
      if (activeSession !== undefined && !owns(ctx)) return;
      controller?.abort(new DOMException("Herdr widget session shut down", "AbortError"));
      const errors: unknown[] = [];
      try {
        publisher?.dispose();
      } catch (error) {
        errors.push(error);
      } finally {
        publisher = undefined;
        generation += 1;
        publishedFingerprint = undefined;
        hasPublished = false;
      }
      const shutdownGeneration = generation;
      await Promise.allSettled([...ownedTasks]);
      errors.push(...taskErrors);
      taskErrors.clear();
      if (generation === shutdownGeneration) {
        activeSession = undefined;
        controller = undefined;
      }
      if (errors.length === 1) throw errors[0];
      if (errors.length > 1) throw new AggregateError(errors, "Herdr widget cleanup failed");
    },
  };
}
