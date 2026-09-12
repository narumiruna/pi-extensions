import assert from "node:assert/strict";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { test } from "vitest";
import { createMockContext } from "../../../test/support.js";
import type { HerdrSubscription } from "../src/herdr-client.js";
import { createHerdrWidgetObserver } from "../src/herdr-observer.js";
import { HERDR_WIDGET_KEY } from "../src/herdr-widget.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function wirePane(
  paneId: string,
  status = "idle",
  agent: string | null = "pi",
  overrides: Record<string, unknown> = {},
) {
  return {
    pane_id: paneId,
    workspace_id: "w1",
    tab_id: `${paneId}:tab`,
    terminal_id: `${paneId}:term`,
    focused: false,
    revision: 1,
    agent,
    agent_status: status,
    label: paneId === "w1:p2" ? "worker" : undefined,
    ...overrides,
  };
}

function agentList(panes: ReturnType<typeof wirePane>[]) {
  return { type: "agent_list", agents: panes };
}

function workspaceInfo(workspaceId = "w1", label = "space") {
  return { type: "workspace_info", workspace: { workspace_id: workspaceId, label } };
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error("Condition did not become true");
}

function renderWidget(value: unknown): string {
  assert.equal(typeof value, "function");
  const component = (value as (tui: unknown, theme: Theme) => { render(width: number): string[] })({}, {
    bold: (text: string) => text,
    fg: (_role: string, text: string) => text,
  } as Theme);
  return component.render(80).join("\n");
}

interface SubscriptionHarness {
  subscription: HerdrSubscription;
  closeUnexpectedly(error?: Error): void;
}

function subscriptionHarness(signal: AbortSignal): SubscriptionHarness {
  const closed = deferred<void>();
  let finished = false;
  const finish = (error?: Error) => {
    if (finished) return;
    finished = true;
    if (error) closed.reject(error);
    else closed.resolve();
  };
  const abort = () => finish();
  if (signal.aborted) finish();
  else signal.addEventListener("abort", abort, { once: true });
  return {
    subscription: {
      closed: closed.promise,
      close() {
        signal.removeEventListener("abort", abort);
        finish();
      },
    },
    closeUnexpectedly(error = new Error("disconnected")) {
      finish(error);
    },
  };
}

test("publishes initial siblings and applies live status and exit events", async () => {
  const { ctx, widgets } = createMockContext({ hasUI: true, mode: "tui" });
  let onEvent: ((frame: unknown) => void) | undefined;
  let harness: SubscriptionHarness | undefined;
  const observer = createHerdrWidgetObserver({
    environment: { paneId: "w1:p1", socketEndpoint: "/tmp/herdr.sock" },
    now: () => 1,
    random: () => 0.5,
    retryDelayMs: 0,
    async subscribe(_endpoint, request, signal, nextEvent) {
      assert.equal(request.method, "events.subscribe");
      assert.deepEqual(
        (request.params.subscriptions as Record<string, unknown>[]).filter(
          (entry) => entry.type === "pane.agent_status_changed",
        ),
        [
          { type: "pane.agent_status_changed", pane_id: "w1:p1" },
          { type: "pane.agent_status_changed", pane_id: "w1:p2" },
        ],
      );
      onEvent = nextEvent;
      harness = subscriptionHarness(signal);
      return harness.subscription;
    },
    async request(_endpoint, request) {
      if (request.method === "pane.current") {
        assert.deepEqual(request.params, { caller_pane_id: "w1:p1" });
        return { type: "pane_current", pane: wirePane("w1:p1", "working") };
      }
      const panes = [wirePane("w1:p1", "working"), wirePane("w1:p2", "idle")];
      if (request.method === "agent.list") {
        return agentList([
          wirePane("w1:p1", "working", "pi", { name: "current" }),
          wirePane("w1:p2", "idle", "pi", { name: "reviewer" }),
        ]);
      }
      if (request.method === "workspace.get") return workspaceInfo();
      return { type: "pane_list", panes };
    },
  });
  observer.start(ctx);
  await waitUntil(() => typeof widgets.get(HERDR_WIDGET_KEY) === "function");
  assert.match(renderWidget(widgets.get(HERDR_WIDGET_KEY)), /idle.*reviewer.*worker\/p2.*space\/w1/u);
  const initialWidget = widgets.get(HERDR_WIDGET_KEY);
  onEvent?.({
    event: "pane.agent_status_changed",
    data: {
      pane_id: "w2:p1",
      workspace_id: "w2",
      agent: "pi",
      agent_status: "blocked",
    },
  });
  assert.equal(widgets.get(HERDR_WIDGET_KEY), initialWidget);

  onEvent?.({
    event: "pane.agent_status_changed",
    data: {
      pane_id: "w1:p2",
      workspace_id: "w1",
      agent: "pi",
      agent_status: "blocked",
      state_labels: { blocked: "waiting" },
    },
  });
  assert.match(renderWidget(widgets.get(HERDR_WIDGET_KEY)), /waiting/u);
  onEvent?.({ event: "pane_exited", data: { pane_id: "w1:p2", workspace_id: "w1" } });
  assert.equal(widgets.get(HERDR_WIDGET_KEY), undefined);

  await observer.shutdown(ctx);
  assert.ok(harness);
  assert.equal(widgets.get(HERDR_WIDGET_KEY), undefined);
});

test("reconciles replayed topology without entering a resubscribe loop", async () => {
  const { ctx, widgets } = createMockContext({ hasUI: true, mode: "tui" });
  let requests = 0;
  let subscriptions = 0;
  const observer = createHerdrWidgetObserver({
    environment: { paneId: "w1:p1", socketEndpoint: "/tmp/herdr.sock" },
    retryDelayMs: 0,
    async subscribe(_endpoint, _request, signal, nextEvent) {
      subscriptions += 1;
      nextEvent({
        event: "pane_created",
        data: { pane: wirePane("w1:old", "unknown", null) },
      });
      return subscriptionHarness(signal).subscription;
    },
    async request(_endpoint, request) {
      requests += 1;
      const panes = [wirePane("w1:p1"), wirePane("w1:p2", "idle")];
      if (request.method === "pane.current") {
        return { type: "pane_current", pane: wirePane("w1:p1") };
      }
      if (request.method === "agent.list") return agentList(panes);
      if (request.method === "workspace.get") return workspaceInfo();
      return { type: "pane_list", panes };
    },
  });
  observer.start(ctx);
  await waitUntil(() => typeof widgets.get(HERDR_WIDGET_KEY) === "function" && requests >= 12);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(subscriptions, 1);
  assert.match(renderWidget(widgets.get(HERDR_WIDGET_KEY)), /worker\/p2.*space\/w1/u);
  await observer.shutdown(ctx);
});

test("queues events during initialization and rejects stale delayed publication", async () => {
  const current = deferred<unknown>();
  const { ctx, widgets } = createMockContext({ hasUI: true, mode: "tui" });
  let currentRequests = 0;
  let onEvent: ((frame: unknown) => void) | undefined;
  const observer = createHerdrWidgetObserver({
    environment: { paneId: "w1:p1", socketEndpoint: "/tmp/herdr.sock" },
    retryDelayMs: 0,
    async subscribe(_endpoint, _request, signal, nextEvent) {
      onEvent = nextEvent;
      return subscriptionHarness(signal).subscription;
    },
    async request(_endpoint, request) {
      if (request.method === "pane.current") {
        currentRequests += 1;
        return currentRequests === 2 ? current.promise : { type: "pane_current", pane: wirePane("w1:p1", "working") };
      }
      const panes = [wirePane("w1:p1", "working"), wirePane("w1:p2", "idle")];
      if (request.method === "agent.list") return agentList(panes);
      if (request.method === "workspace.get") return workspaceInfo();
      return { type: "pane_list", panes };
    },
  });
  observer.start(ctx);
  await waitUntil(() => onEvent !== undefined);
  onEvent?.({
    event: "pane.agent_status_changed",
    data: {
      pane_id: "w1:p2",
      workspace_id: "w1",
      agent: "pi",
      agent_status: "blocked",
    },
  });
  current.resolve({ type: "pane_current", pane: wirePane("w1:p1", "working") });
  await waitUntil(() => typeof widgets.get(HERDR_WIDGET_KEY) === "function");
  assert.match(renderWidget(widgets.get(HERDR_WIDGET_KEY)), /blocked/u);

  const staleCurrent = deferred<unknown>();
  let requestCount = 0;
  const replacement = createHerdrWidgetObserver({
    environment: { paneId: "w1:p1", socketEndpoint: "/tmp/herdr.sock" },
    retryDelayMs: 0,
    async subscribe(_endpoint, _request, signal) {
      return subscriptionHarness(signal).subscription;
    },
    async request() {
      requestCount += 1;
      return staleCurrent.promise;
    },
  });
  replacement.start(ctx);
  await waitUntil(() => requestCount === 1);
  const shuttingDown = replacement.shutdown(ctx);
  staleCurrent.resolve({ type: "pane_current", pane: wirePane("w1:p1") });
  await shuttingDown;
  assert.equal(widgets.get(HERDR_WIDGET_KEY), undefined);
  await observer.shutdown(ctx);
});

test("clears stale state before one reconnect and stops after exhaustion", async () => {
  const { ctx, widgets } = createMockContext({ hasUI: true, mode: "tui" });
  const harnesses: SubscriptionHarness[] = [];
  const secondCurrent = deferred<unknown>();
  let subscriptions = 0;
  let secondCurrentRequested = false;
  const observer = createHerdrWidgetObserver({
    environment: { paneId: "w1:p1", socketEndpoint: "/tmp/herdr.sock" },
    retryDelayMs: 0,
    async subscribe(_endpoint, _request, signal) {
      subscriptions += 1;
      const harness = subscriptionHarness(signal);
      harnesses.push(harness);
      return harness.subscription;
    },
    async request(_endpoint, request) {
      if (request.method === "pane.current") {
        if (subscriptions === 2) {
          secondCurrentRequested = true;
          return secondCurrent.promise;
        }
        return { type: "pane_current", pane: wirePane("w1:p1") };
      }
      const panes = [wirePane("w1:p1"), wirePane("w1:p2", "working")];
      if (request.method === "agent.list") return agentList(panes);
      if (request.method === "workspace.get") return workspaceInfo();
      return { type: "pane_list", panes };
    },
  });
  observer.start(ctx);
  await waitUntil(() => subscriptions === 1 && typeof widgets.get(HERDR_WIDGET_KEY) === "function");
  harnesses[0]?.closeUnexpectedly();
  await waitUntil(() => subscriptions === 2 && secondCurrentRequested);
  assert.equal(widgets.get(HERDR_WIDGET_KEY), undefined);
  secondCurrent.resolve({ type: "pane_current", pane: wirePane("w1:p1") });
  await waitUntil(() => typeof widgets.get(HERDR_WIDGET_KEY) === "function");
  harnesses[1]?.closeUnexpectedly();
  await waitUntil(() => widgets.get(HERDR_WIDGET_KEY) === undefined);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(subscriptions, 2);
  await observer.shutdown(ctx);
});

test("reconnects and reloads the workspace after the current pane moves", async () => {
  const { ctx, widgets } = createMockContext({ hasUI: true, mode: "tui" });
  let subscriptions = 0;
  let moved = false;
  let onEvent: ((frame: unknown) => void) | undefined;
  const observer = createHerdrWidgetObserver({
    environment: { paneId: "w1:p1", socketEndpoint: "/tmp/herdr.sock" },
    retryDelayMs: 0,
    async subscribe(_endpoint, _request, signal, nextEvent) {
      subscriptions += 1;
      const harness = subscriptionHarness(signal);
      onEvent = (frame) => {
        try {
          nextEvent(frame);
        } catch (error) {
          harness.closeUnexpectedly(error instanceof Error ? error : new Error(String(error)));
        }
      };
      return harness.subscription;
    },
    async request(_endpoint, request) {
      const panes = moved
        ? [
            wirePane("w2:p9", "idle", "pi", { workspace_id: "w2" }),
            wirePane("w2:p2", "done", "pi", {
              workspace_id: "w2",
              label: "destination",
            }),
          ]
        : [wirePane("w1:p1"), wirePane("w1:p2", "working")];
      if (request.method === "pane.current") {
        return { type: "pane_current", pane: panes[0] };
      }
      if (request.method === "agent.list") return agentList(panes);
      if (request.method === "workspace.get") {
        return workspaceInfo(moved ? "w2" : "w1", moved ? "destination-space" : "space");
      }
      return { type: "pane_list", panes };
    },
  });
  observer.start(ctx);
  await waitUntil(() => subscriptions === 1 && typeof widgets.get(HERDR_WIDGET_KEY) === "function");
  moved = true;
  onEvent?.({
    event: "pane_moved",
    data: {
      previous_pane_id: "w1:p1",
      previous_workspace_id: "w1",
      pane: {
        ...wirePane("w2:p9", "idle"),
        workspace_id: "w2",
      },
    },
  });
  await waitUntil(() => subscriptions === 2);
  await waitUntil(() => typeof widgets.get(HERDR_WIDGET_KEY) === "function");
  assert.match(renderWidget(widgets.get(HERDR_WIDGET_KEY)), /done.*pi.*destination\/p2.*destination-space\/w2/u);
  await observer.shutdown(ctx);
});

test("an older delayed shutdown cannot clear a replacement session", async () => {
  const oldContext = createMockContext({ hasUI: true, mode: "tui" });
  const replacement = createMockContext({ hasUI: true, mode: "tui" });
  const oldCurrent = deferred<unknown>();
  let requests = 0;
  const observer = createHerdrWidgetObserver({
    environment: { paneId: "w1:p1", socketEndpoint: "/tmp/herdr.sock" },
    retryDelayMs: 0,
    async subscribe(_endpoint, _request, signal) {
      return subscriptionHarness(signal).subscription;
    },
    async request(_endpoint, request) {
      requests += 1;
      if (requests === 1) return oldCurrent.promise;
      const panes = [wirePane("w1:p1"), wirePane("w1:p2", "working")];
      if (request.method === "pane.current") {
        return { type: "pane_current", pane: wirePane("w1:p1") };
      }
      if (request.method === "agent.list") return agentList(panes);
      if (request.method === "workspace.get") return workspaceInfo();
      return { type: "pane_list", panes };
    },
  });
  observer.start(oldContext.ctx);
  await waitUntil(() => requests === 1);
  const stoppingOld = observer.shutdown(oldContext.ctx);
  observer.start(replacement.ctx);
  oldCurrent.resolve({ type: "pane_current", pane: wirePane("w1:p1") });
  await stoppingOld;
  await waitUntil(() => typeof replacement.widgets.get(HERDR_WIDGET_KEY) === "function");
  assert.match(renderWidget(replacement.widgets.get(HERDR_WIDGET_KEY)), /worker\/p2.*space\/w1/u);
  await observer.shutdown(replacement.ctx);
});

test("opens no resources outside TUI mode and tolerates repeated shutdown", async () => {
  const { ctx, widgets } = createMockContext({ hasUI: true, mode: "rpc" });
  let calls = 0;
  const observer = createHerdrWidgetObserver({
    environment: { paneId: "w1:p1", socketEndpoint: "/tmp/herdr.sock" },
    async subscribe() {
      calls += 1;
      throw new Error("not expected");
    },
    async request() {
      calls += 1;
      return undefined;
    },
  });
  observer.start(ctx);
  await observer.shutdown(ctx);
  await observer.shutdown(ctx);
  assert.equal(calls, 0);
  assert.equal(widgets.size, 0);
});
