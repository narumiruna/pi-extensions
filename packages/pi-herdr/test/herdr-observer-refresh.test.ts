import assert from "node:assert/strict";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { test, vi } from "vitest";
import { createMockContext as createBaseContext } from "../../../test/support.js";
import type { HerdrRequest } from "../src/herdr-client.js";
import { createHerdrWidgetObserver } from "../src/herdr-observer.js";
import { HERDR_WIDGET_KEY } from "../src/herdr-widget.js";

function createMockContext(overrides: Parameters<typeof createBaseContext>[0]) {
  return createBaseContext({
    theme: { bold: (text: string) => text, fg: (_role: string, text: string) => text },
    ...overrides,
  });
}

function pane(id: string, overrides: Record<string, unknown> = {}) {
  return {
    pane_id: id,
    workspace_id: "w1",
    tab_id: "w1:t1",
    terminal_id: `${id}-terminal`,
    focused: false,
    revision: 1,
    agent: "pi",
    agent_status: "idle",
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function until(predicate: () => boolean) {
  for (let i = 0; i < 100; i += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error("Observer did not reach the expected state");
}

function render(widget: unknown): string {
  assert.equal(typeof widget, "function");
  return (widget as (tui: unknown, theme: Theme) => { render(width: number): string[] })(
    { terminal: { rows: 36 }, requestRender() {} },
    {
      bold: (text: string) => text,
      fg: (_role: string, text: string) => text,
    } as Theme,
  )
    .render(120)
    .join("\n");
}

function fixture(retryDelayMs = 0) {
  const context = createMockContext({ mode: "tui", hasUI: true });
  const state = {
    current: pane("w1:p1"),
    panes: [pane("w1:p1"), pane("w1:p2")],
    name: "reviewer",
    workspaceLabel: "space",
    reads: 0,
    listReads: 0,
    subscribeAttempts: 0,
    rejectSubscribe: undefined as (() => Error | undefined) | undefined,
    activeLists: 0,
    maxActiveLists: 0,
    override: undefined as
      | ((request: HerdrRequest, result: unknown, signal: AbortSignal) => Promise<unknown> | undefined)
      | undefined,
    onSubscribe: undefined as ((emit: (frame: unknown) => void) => void) | undefined,
  };
  const subscriptions: Array<{ emit(frame: unknown): void; fail(): void; signal: AbortSignal; types: unknown }> = [];
  const observer = createHerdrWidgetObserver({
    environment: { paneId: "w1:p1", socketEndpoint: "/unused" },
    retryDelayMs,
    async request(_endpoint, request, signal) {
      state.reads += 1;
      const isList = request.method === "pane.list";
      if (isList) {
        state.listReads += 1;
        state.activeLists += 1;
        state.maxActiveLists = Math.max(state.maxActiveLists, state.activeLists);
      }
      const result =
        request.method === "pane.current"
          ? { type: "pane_current", pane: state.current }
          : request.method === "pane.list"
            ? { type: "pane_list", panes: [...state.panes] }
            : request.method === "agent.list"
              ? { type: "agent_list", agents: state.panes.map((entry) => ({ ...entry, name: state.name })) }
              : {
                  type: "workspace_info",
                  workspace: { workspace_id: state.current.workspace_id, label: state.workspaceLabel },
                };
      try {
        return await (state.override?.(request, result, signal) ?? result);
      } finally {
        if (isList) state.activeLists -= 1;
      }
    },
    async subscribe(_endpoint, request, signal, emit) {
      state.subscribeAttempts += 1;
      const error = state.rejectSubscribe?.();
      if (error) throw error;
      let finish!: () => void;
      let fail!: (error: Error) => void;
      const closed = new Promise<void>((resolve, reject) => {
        finish = resolve;
        fail = reject;
      });
      signal.addEventListener("abort", finish, { once: true });
      subscriptions.push({
        emit,
        signal,
        types: request.params.subscriptions,
        fail: () => fail(new Error("events_lost")),
      });
      state.onSubscribe?.(emit);
      return {
        closed,
        close() {
          signal.removeEventListener("abort", finish);
          finish();
        },
      };
    },
  });
  return {
    ...context,
    state,
    observer,
    subscriptions,
    emit(frame: unknown) {
      subscriptions.at(-1)?.emit(frame);
    },
    text() {
      return render(context.widgets.get(HERDR_WIDGET_KEY));
    },
    async ready() {
      await until(() => typeof context.widgets.get(HERDR_WIDGET_KEY) === "function");
    },
  };
}

const staleStatus = { event: "pane.agent_status_changed", data: pane("w1:p2", { agent_status: "blocked" }) };
const updated = () => ({ event: "pane_updated", data: { pane: pane("w1:p2") } });

for (const phase of ["initialization", "refresh", "reconnect"] as const) {
  test(`old status payload cannot override authoritative state during ${phase}`, async () => {
    const f = fixture();
    try {
      if (phase !== "initialization") {
        f.observer.start(f.ctx);
        await f.ready();
      }
      const pending = deferred<unknown>();
      let readStarted = false;
      let captured: unknown;
      f.state.override = (request, result) => {
        if (request.method !== "pane.list" || readStarted || f.subscriptions.length < (phase === "reconnect" ? 2 : 1))
          return undefined;
        readStarted = true;
        captured = result;
        return pending.promise;
      };
      f.state.onSubscribe = (emit) => emit(staleStatus);
      if (phase === "initialization") f.observer.start(f.ctx);
      else if (phase === "reconnect") f.subscriptions[0]?.fail();
      else f.emit(updated());
      await until(() => readStarted);
      const reads = f.state.listReads;
      f.emit(staleStatus);
      pending.resolve(captured);
      await f.ready();
      await until(() => f.state.listReads > reads && f.state.activeLists === 0);
      assert.match(f.text(), /idle/);
      assert.doesNotMatch(f.text(), /blocked/);
      assert.equal(f.state.maxActiveLists, 1);
    } finally {
      await f.observer.shutdown(f.ctx);
    }
  });
}

test("coalesces burst invalidations and never publishes an invalidated read", async () => {
  const f = fixture();
  f.observer.start(f.ctx);
  try {
    await f.ready();
    const initialWidget = f.widgets.get(HERDR_WIDGET_KEY);
    const pending = deferred<unknown>();
    let started = false;
    f.state.override = (request, result) => {
      if (request.method !== "pane.list" || started) return undefined;
      started = true;
      return pending.promise.then(() => result);
    };
    f.state.panes = [pane("w1:p1"), pane("w1:p2", { agent_status: "blocked" })];
    f.emit(updated());
    await until(() => started);
    f.state.panes = [pane("w1:p1"), pane("w1:p2", { agent_status: "working" })];
    const reads = f.state.listReads;
    for (let i = 0; i < 2000; i += 1) f.emit(staleStatus);
    assert.equal(f.widgets.get(HERDR_WIDGET_KEY), initialWidget);
    assert.equal(f.state.listReads, reads);
    pending.resolve(undefined);
    await until(() => f.text().includes("working"));
    assert.equal(f.widgets.get(HERDR_WIDGET_KEY), initialWidget);
    assert.match(f.text(), /working/);
    assert.doesNotMatch(f.text(), /blocked/);
    assert.equal(f.state.listReads, reads + 1);
    assert.equal(f.state.maxActiveLists, 1);
    const settledReads = f.state.reads;
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(f.state.reads, settledReads, "no steady-state polling");
  } finally {
    await f.observer.shutdown(f.ctx);
  }
});

test("pane and workspace invalidations refresh names and clear null or omitted presentation", async () => {
  const f = fixture();
  f.observer.start(f.ctx);
  try {
    await f.ready();
    f.state.name = "renamed";
    f.state.panes = [
      pane("w1:p1"),
      pane("w1:p2", {
        display_agent: "display",
        title: "title",
        state_labels: { idle: "ready" },
      }),
    ];
    f.emit(updated());
    await until(() => f.text().includes("renamed"));
    assert.match(f.text(), /ready.*renamed.*title\/p2/);
    f.state.workspaceLabel = "renamed-space";
    f.emit({ event: "workspace_renamed", data: { workspace_id: "w1", label: "ignored-old-payload" } });
    await until(() => f.text().includes("renamed-space"));
    for (const clear of [null, undefined]) {
      const oldWidget = f.widgets.get(HERDR_WIDGET_KEY);
      f.state.name = "";
      f.state.panes = [
        pane("w1:p1"),
        pane("w1:p2", {
          display_agent: clear,
          title: clear,
          state_labels: clear,
        }),
      ];
      f.emit(updated());
      await until(() => f.state.activeLists === 0 && f.text().includes("idle") && !f.text().includes("title/p2"));
      assert.equal(f.widgets.get(HERDR_WIDGET_KEY), oldWidget);
      assert.match(f.text(), /idle.*pi.*p2/);
      assert.doesNotMatch(f.text(), /ready|renamed ·|title\/p2|display/);
      // Set a different value before the next clear so fingerprint suppression cannot hide the regression.
      f.state.name = "set-again";
      f.state.panes = [pane("w1:p1"), pane("w1:p2", { title: "title", state_labels: { idle: "ready" } })];
      f.emit(updated());
      await until(() => f.text().includes("set-again"));
    }
    const reads = f.state.reads;
    f.emit({ event: "pane_updated", data: { pane: pane("w2:p1", { workspace_id: "w2" }) } });
    f.emit({ event: "workspace_renamed", data: { workspace_id: "w2", label: "other" } });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(f.state.reads, reads);
  } finally {
    await f.observer.shutdown(f.ctx);
  }
});

test("topology rebuilds do not consume the bounded failure retry", async () => {
  const f = fixture();
  f.observer.start(f.ctx);
  try {
    await f.ready();
    for (const [index, agent] of [undefined, "codex", undefined, "pi"].entries()) {
      f.state.panes = [pane("w1:p1"), pane("w1:p2", { agent })];
      f.emit({ event: "pane_agent_detected", data: { ...pane("w1:p2"), agent, released: agent === undefined } });
      await until(() => f.subscriptions.length === index + 2);
    }
    await f.ready();
    assert.ok(f.subscriptions.slice(0, -1).every(({ signal }) => signal.aborted));
    const previousCount = f.subscriptions.length;
    f.subscriptions.at(-1)?.fail();
    await until(() => f.subscriptions.length === previousCount + 1);
    await f.ready();
    f.subscriptions.at(-1)?.fail();
    await until(() => f.widgets.get(HERDR_WIDGET_KEY) === undefined);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(f.subscriptions.length, previousCount + 1);
  } finally {
    await f.observer.shutdown(f.ctx);
  }
});

test("history loss clears the widget and aborts an in-flight refresh before reconnect", async () => {
  const f = fixture();
  f.observer.start(f.ctx);
  try {
    await f.ready();
    let readSignal: AbortSignal | undefined;
    let readAborted = false;
    const reconnect = deferred<unknown>();
    let reconnectResult: unknown;
    f.state.override = (request, result, signal) => {
      if (request.method === "pane.current" && readAborted && f.subscriptions.length === 1) {
        reconnectResult = result;
        return reconnect.promise;
      }
      if (request.method !== "pane.list" || readSignal) return undefined;
      readSignal = signal;
      return new Promise((_resolve, reject) => {
        signal.addEventListener(
          "abort",
          () => {
            readAborted = true;
            reject(signal.reason);
          },
          { once: true },
        );
      });
    };
    f.emit(updated());
    await until(() => readSignal !== undefined);
    const old = f.subscriptions[0];
    old?.fail();
    await until(() => readAborted && reconnectResult !== undefined);
    assert.equal(f.widgets.get(HERDR_WIDGET_KEY), undefined);
    reconnect.resolve(reconnectResult);
    await until(() => f.subscriptions.length === 2);
    await f.ready();
    const reads = f.state.reads;
    old?.emit(staleStatus);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(f.state.reads, reads);
    assert.match(f.text(), /idle/);
  } finally {
    await f.observer.shutdown(f.ctx);
  }
});

test("omitted false release fields still detect a formerly unrecognized agent", async () => {
  const f = fixture();
  f.state.panes = [pane("w1:p1"), pane("w1:p2", { agent: undefined })];
  f.observer.start(f.ctx);
  try {
    await until(() => f.state.listReads === 2 && f.state.activeLists === 0);
    assert.equal(f.widgets.get(HERDR_WIDGET_KEY), undefined);
    f.state.panes = [pane("w1:p1"), pane("w1:p2", { agent: "codex" })];
    f.emit({
      event: "pane_agent_detected",
      data: { pane_id: "w1:p2", workspace_id: "w1", agent: "codex", final_status: "idle" },
    });
    await f.ready();
    assert.equal(f.subscriptions.length, 2);
    const latestSubscription = f.subscriptions.at(-1);
    assert.ok(latestSubscription);
    assert.ok((latestSubscription.types as Array<{ pane_id?: string }>).some(({ pane_id }) => pane_id === "w1:p2"));
    assert.match(f.text(), /reviewer/);
  } finally {
    await f.observer.shutdown(f.ctx);
  }
});

test("rejected stale subscriptions reconcile without consuming the outage retry", async () => {
  const f = fixture();
  f.state.rejectSubscribe = () => {
    if (f.state.subscribeAttempts > 2) return undefined;
    f.state.panes = [pane("w1:p1"), pane(`w1:p${f.state.subscribeAttempts + 2}`)];
    return Object.assign(new Error("pane disappeared"), { code: "pane_not_found" });
  };
  f.observer.start(f.ctx);
  try {
    await f.ready();
    assert.equal(f.state.subscribeAttempts, 3);
    assert.match(f.text(), /p4/);
    f.subscriptions.at(-1)?.fail();
    await until(() => f.state.subscribeAttempts === 4);
    await f.ready();
    assert.match(f.text(), /p4/);
  } finally {
    await f.observer.shutdown(f.ctx);
  }
});

test("subscription rejection without a topology change remains bounded", async () => {
  const f = fixture();
  f.state.rejectSubscribe = () => new Error("unsupported subscription");
  f.observer.start(f.ctx);
  try {
    await until(() => f.state.subscribeAttempts === 2);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(f.state.subscribeAttempts, 2);
    assert.equal(f.widgets.get(HERDR_WIDGET_KEY), undefined);
    assert.equal(f.subscriptions.length, 0);
  } finally {
    await f.observer.shutdown(f.ctx);
  }
});

test("shutdown cancels reconnect backoff and repeated cleanup leaves no resources", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const f = fixture(10000);
  f.observer.start(f.ctx);
  try {
    await f.ready();
    f.subscriptions[0]?.fail();
    await until(() => vi.getTimerCount() === 1);
    await Promise.all([f.observer.shutdown(f.ctx), f.observer.shutdown(f.ctx)]);
    assert.equal(vi.getTimerCount(), 0);
    assert.equal(f.widgets.get(HERDR_WIDGET_KEY), undefined);
    assert.equal(f.subscriptions.length, 1);
    assert.equal(f.state.activeLists, 0);
  } finally {
    await f.observer.shutdown(f.ctx);
    vi.useRealTimers();
  }
});
