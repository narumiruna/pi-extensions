import assert from "node:assert/strict";
import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { test, vi } from "vitest";
import { createMockContext as createBaseContext } from "../../../test/support.js";
import type { HerdrRequest } from "../src/herdr-client.js";
import { createHerdrWidgetObserver } from "../src/herdr-observer.js";
import { herdrSessionFingerprint } from "../src/herdr-spawn-provenance.js";
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
                  type: "workspace_list",
                  workspaces: [{ workspace_id: state.current.workspace_id, label: state.workspaceLabel }],
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

const continuousEvents = [
  {
    name: "non-agent pane updates from another workspace",
    frame: { event: "pane_updated", data: { pane: pane("w2:shell", { workspace_id: "w2", agent: undefined }) } },
  },
  { name: "agent status changes", frame: staleStatus },
  { name: "workspace renames", frame: { event: "workspace_renamed", data: { workspace_id: "w2", label: "stale" } } },
];

for (const phase of ["initialization", "refresh", "reconnect"] as const) {
  for (const { name, frame } of continuousEvents) {
    test(`continuous ${name} cannot starve publication during ${phase}`, async () => {
      const f = fixture();
      const pending = deferred<unknown>();
      let heldResult: unknown;
      let invalidatedReads = 0;
      const seen: string[] = [];
      try {
        if (phase !== "initialization") {
          f.observer.start(f.ctx);
          await f.ready();
        }
        f.state.override = (request) => {
          if (request.method !== "pane.list" || f.subscriptions.length < (phase === "reconnect" ? 2 : 1))
            return undefined;
          invalidatedReads += 1;
          if (typeof f.widgets.get(HERDR_WIDGET_KEY) === "function") seen.push(f.text());
          const result = {
            type: "pane_list",
            panes: [pane("w1:p1"), pane("w1:p2", { state_labels: { idle: `sample-${invalidatedReads}` } })],
          };
          f.emit(frame);
          if (invalidatedReads === 8) {
            heldResult = result;
            return pending.promise;
          }
          return Promise.resolve(result);
        };
        if (phase === "initialization") f.observer.start(f.ctx);
        else if (phase === "reconnect") f.subscriptions[0]?.fail();
        else f.emit(updated());
        await until(() => heldResult !== undefined);
        assert.equal(typeof f.widgets.get(HERDR_WIDGET_KEY), "function", "publish before event traffic stops");
        assert.match(f.text(), /sample-6/);
        assert.ok(
          seen.some((text) => text.includes("sample-3")),
          "publish more than once under sustained events",
        );
        assert.doesNotMatch(f.text(), /blocked|stale/);
        assert.equal(f.state.maxActiveLists, 1);
        f.state.override = undefined;
        pending.resolve(heldResult);
        await until(() => f.state.activeLists === 0 && f.text().includes("idle"));
        assert.doesNotMatch(f.text(), /sample-/);
        const reads = f.state.reads;
        await new Promise<void>((resolve) => setImmediate(resolve));
        assert.equal(f.state.reads, reads, "stop reading after the last invalidation is covered");
      } finally {
        f.state.override = undefined;
        pending.resolve(heldResult);
        await f.observer.shutdown(f.ctx);
      }
    });
  }
}

test("sustained invalidations cannot publish a snapshot with an obsolete subscription topology", async () => {
  const f = fixture();
  let invalidatedReads = 0;
  const publicationSubscriptions: number[] = [];
  const ctx = f.ctx as ExtensionContext;
  const setWidget = ctx.ui.setWidget;
  ctx.ui.setWidget = (key, content, options) => {
    if (typeof content === "function") {
      setWidget(key, content, options);
      publicationSubscriptions.push(f.subscriptions.length);
    } else {
      setWidget(key, content, options);
    }
  };
  f.state.override = (request, result) => {
    if (request.method !== "pane.list" || f.subscriptions.length !== 1) return undefined;
    invalidatedReads += 1;
    f.emit(updated());
    if (invalidatedReads === 3) {
      f.state.panes.push(pane("w1:p3"));
      return Promise.resolve({ type: "pane_list", panes: [...f.state.panes] });
    }
    return Promise.resolve(result);
  };
  f.observer.start(f.ctx);
  try {
    await until(() => f.subscriptions.length === 2 && typeof f.widgets.get(HERDR_WIDGET_KEY) === "function");
    assert.deepEqual(publicationSubscriptions, [2]);
    assert.match(f.text(), /2 sibling agents/);
    const subscription = f.subscriptions[1];
    assert.ok(subscription);
    assert.ok((subscription.types as Array<{ pane_id?: string }>).some(({ pane_id }) => pane_id === "w1:p3"));
    assert.equal(f.subscriptions[0]?.signal.aborted, true);
  } finally {
    await f.observer.shutdown(f.ctx);
  }
});

for (const boundary of ["shutdown", "replacement"] as const) {
  test(`${boundary} cancels a pending bounded-publication read`, async () => {
    const f = fixture();
    const pending = deferred<unknown>();
    let held: { result: unknown; signal: AbortSignal } | undefined;
    let invalidatedReads = 0;
    let active = f.ctx;
    f.state.override = (request, result, signal) => {
      if (request.method !== "pane.list" || f.subscriptions.length !== 1) return undefined;
      invalidatedReads += 1;
      f.emit(updated());
      if (invalidatedReads === 3) {
        held = { result, signal };
        return pending.promise;
      }
      return Promise.resolve(result);
    };
    f.observer.start(f.ctx);
    try {
      await until(() => held !== undefined);
      assert.ok(held);
      f.state.override = undefined;
      if (boundary === "shutdown") {
        const stopping = f.observer.shutdown(f.ctx);
        assert.equal(held.signal.aborted, true);
        pending.resolve(held.result);
        await stopping;
      } else {
        const replacement = createMockContext({ mode: "tui", hasUI: true });
        active = replacement.ctx;
        f.state.name = "replacement";
        f.observer.start(active);
        assert.equal(held.signal.aborted, true);
        pending.resolve(held.result);
        await until(() => typeof replacement.widgets.get(HERDR_WIDGET_KEY) === "function");
        assert.match(render(replacement.widgets.get(HERDR_WIDGET_KEY)), /replacement/);
      }
      assert.equal(f.widgets.get(HERDR_WIDGET_KEY), undefined);
      assert.equal(f.subscriptions[0]?.signal.aborted, true);
    } finally {
      pending.resolve(held?.result);
      await f.observer.shutdown(active);
    }
  });
}

test("coalesces burst invalidations and discards the superseded read", async () => {
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
    await until(() => f.state.reads > reads && f.state.activeLists === 0);
    assert.doesNotMatch(f.text(), /other/);
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

test.each([
  ["A to B", "A", "B"],
  ["B to A", "B", "A"],
  ["native to non-native", "A", "custom"],
  ["non-native to native", "custom", "B"],
])("later list alone determines caller relations: %s", async (_label, earlier, later) => {
  const f = fixture();
  const nativeSession = (value: string) => ({ source: "herdr:pi", agent: "pi", kind: "id", value });
  const parent = pane("w1:p0", { agent_session: nativeSession("parent") });
  const spawn = (
    origin: ReturnType<typeof pane> & { agent_session?: unknown },
    target: ReturnType<typeof pane> & { agent_session?: unknown },
  ) => ({
    ...target,
    tokens: {
      pi_spawn_v: "1",
      pi_spawn_origin: origin.terminal_id,
      pi_spawn_from: herdrSessionFingerprint(origin.terminal_id, origin.agent_session),
      pi_spawn_to: herdrSessionFingerprint(target.terminal_id, target.agent_session),
      pi_spawn_label: "captured",
    },
  });
  const caller = (identity: string) =>
    spawn(
      parent,
      pane("w1:p1", {
        agent_session: { ...nativeSession(identity), source: identity === "custom" ? "custom" : "herdr:pi" },
      }),
    );
  const childA = spawn(caller("A"), pane("w1:p2", { agent_session: nativeSession("child-A") }));
  const childB = spawn(caller("B"), pane("w1:p3", { agent_session: nativeSession("child-B") }));
  const peer = pane("w1:p4", { agent_session: nativeSession("peer") });
  const peerChild = spawn(peer, pane("w1:p5", { agent_session: nativeSession("peer-child") }));
  const peers = [parent, childA, childB, peer, peerChild];
  f.state.current = caller(earlier);
  f.state.panes = [f.state.current, ...peers];
  const pending = deferred<unknown>();
  let held: unknown;
  f.observer.start(f.ctx);
  try {
    await f.ready();
    f.state.panes = [caller(later), ...peers];
    f.state.override = (request, result) => {
      if (request.method !== "pane.list" || held !== undefined) return undefined;
      held = result;
      return pending.promise;
    };
    const reads = f.state.listReads;
    f.emit(updated());
    await until(() => held !== undefined);
    pending.resolve(held);
    await until(() => f.state.activeLists === 0);
    const row = (id: string) =>
      f
        .text()
        .split("\n")
        .find((line) => line.includes(`· ${id} ·`)) ?? "";
    assert.match(row("p2"), later === "A" ? /spawned by you/ : /spawned by captured \(unavailable\)/);
    assert.match(row("p3"), later === "B" ? /spawned by you/ : /spawned by captured \(unavailable\)/);
    if (later === "custom") assert.doesNotMatch(row("p0"), /spawned you/);
    else assert.match(row("p0"), /spawned you/);
    assert.match(row("p5"), /spawned by reviewer\/p4/);
    assert.equal(f.state.listReads, reads + 1, "no extra invalidation hides the mixed-read result");
    assert.equal(f.subscriptions.length, 1);
  } finally {
    pending.resolve(held);
    await f.observer.shutdown(f.ctx);
  }
});

test.each(["absent", "reused"])(
  "caller moves with %s old pane ID; rediscover without spending outage retries",
  async (oldId) => {
    const f = fixture();
    let pending: ReturnType<typeof deferred<unknown>> | undefined;
    let held: unknown;
    f.observer.start(f.ctx);
    try {
      await f.ready();
      for (const id of ["w1:p9", "w1:p1"]) {
        pending = deferred<unknown>();
        held = undefined;
        let moved = false;
        f.state.override = (request, result) => {
          if (request.method === "pane.list" && !moved) {
            moved = true;
            const previousId = f.state.current.pane_id;
            f.state.current = { ...f.state.current, pane_id: id };
            f.state.panes = [f.state.current, pane("w1:p2")];
            if (oldId === "reused") f.state.panes.push(pane(previousId, { terminal_id: "other-terminal" }));
            return Promise.resolve({ type: "pane_list", panes: [...f.state.panes] });
          }
          if (request.method === "pane.current" && moved && held === undefined) {
            held = result;
            return pending?.promise;
          }
          return undefined;
        };
        const subscriptions = f.subscriptions.length;
        f.emit(updated());
        await until(() => held !== undefined);
        assert.equal(f.widgets.get(HERDR_WIDGET_KEY), undefined);
        assert.equal(f.subscriptions.at(-1)?.signal.aborted, true);
        pending.resolve(held);
        await until(() => f.subscriptions.length === subscriptions + 1);
        await f.ready();
        assert.doesNotMatch(f.text(), new RegExp(`${id.split(":")[1]} ·`, "u"));
        f.state.override = undefined;
      }
      const subscriptions = f.subscriptions.length;
      f.subscriptions.at(-1)?.fail();
      await until(() => f.subscriptions.length === subscriptions + 1);
      await f.ready();
      f.subscriptions.at(-1)?.fail();
      await until(() => f.widgets.get(HERDR_WIDGET_KEY) === undefined);
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(f.subscriptions.length, subscriptions + 1);
    } finally {
      f.state.override = undefined;
      pending?.resolve(held);
      await f.observer.shutdown(f.ctx);
    }
    assert.equal(f.state.activeLists, 0);
  },
);

test("metadata invalidations re-read spawn identities and cannot replay stale relationships", async () => {
  const f = fixture();
  const originSession = { source: "herdr:pi", agent: "pi", kind: "id", value: "origin" };
  const targetSession = { ...originSession, value: "target" };
  f.state.current = pane("w1:p1", { agent_session: originSession });
  const target = pane("w1:p2", { agent_session: targetSession });
  const tokens = {
    pi_spawn_v: "1",
    pi_spawn_origin: f.state.current.terminal_id,
    pi_spawn_from: herdrSessionFingerprint(f.state.current.terminal_id, originSession),
    pi_spawn_to: herdrSessionFingerprint(target.terminal_id, targetSession),
    pi_spawn_label: "initiator",
  };
  const recordedTarget = pane("w1:p2", { agent_session: targetSession, tokens });
  f.state.panes = [f.state.current, target];
  f.observer.start(f.ctx);
  try {
    await f.ready();
    assert.doesNotMatch(f.text(), /spawned/);
    const initialReads = f.state.listReads;
    f.state.panes = [f.state.current, recordedTarget];
    f.emit({ event: "pane_updated", data: { pane: target } });
    await until(() => f.state.listReads > initialReads && f.text().includes("spawned by you"));
    const reads = f.state.listReads;
    f.state.panes = [
      f.state.current,
      pane("w1:p2", { agent_session: { ...targetSession, value: "replacement" }, tokens }),
    ];
    f.emit({ event: "pane_updated", data: { pane: recordedTarget } });
    await until(() => f.state.listReads > reads && !f.text().includes("spawned"));
    assert.equal(f.state.maxActiveLists, 1);
    const afterReplacement = f.state.listReads;
    f.state.current = pane("w1:p1", { agent_session: { ...originSession, value: "new-origin" } });
    f.state.panes = [f.state.current, recordedTarget];
    f.emit({ event: "pane_updated", data: { pane: recordedTarget } });
    await until(() => f.state.listReads > afterReplacement && f.text().includes("unavailable"));
    assert.doesNotMatch(f.text(), /spawned by you/);
    f.subscriptions.at(-1)?.fail();
    await until(() => f.state.subscribeAttempts === 2);
    await f.ready();
    assert.match(f.text(), /unavailable/);
  } finally {
    await f.observer.shutdown(f.ctx);
  }
  assert.equal(f.widgets.get(HERDR_WIDGET_KEY), undefined);
  assert.equal(f.state.activeLists, 0);
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
