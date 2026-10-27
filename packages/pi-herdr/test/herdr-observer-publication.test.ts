import assert from "node:assert/strict";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { test } from "vitest";
import { createMockContext } from "../../../test/support.js";
import { createHerdrWidgetObserver } from "../src/herdr-observer.js";
import { HERDR_WIDGET_KEY } from "../src/herdr-widget.js";

type Widget = Component & { dispose?(): void };

async function until(predicate: () => boolean) {
  for (let i = 0; i < 100; i += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error("Observer did not reach the expected state");
}

function fixture() {
  const context = createMockContext({
    mode: "tui",
    hasUI: true,
    theme: { bold: (text: string) => text, fg: (_role: string, text: string) => text },
  });
  const ctx = context.ctx as ExtensionContext;
  const mounted = new Map<string, Widget>();
  let mounts = 0;
  let disposals = 0;
  let repaints = 0;
  let failMount = false;
  let failClear = false;
  let failClose = false;
  let failRead = false;
  let finishSubscription: () => void = () => {};
  let heldRead: { entered(): void; wait: Promise<void> } | undefined;
  const calls: string[] = [];
  ctx.ui.setWidget = ((key, content) => {
    calls.push(key);
    if (content === undefined && failClear) throw new Error("cleanup failed");
    mounted.get(key)?.dispose?.();
    mounted.delete(key);
    if (content === undefined) return;
    assert.equal(typeof content, "function");
    const component = (content as (tui: TUI, theme: ExtensionContext["ui"]["theme"]) => Widget)(
      {
        terminal: { rows: 36 },
        requestRender() {
          repaints += 1;
        },
      } as TUI,
      ctx.ui.theme,
    );
    mounts += 1;
    const dispose = component.dispose?.bind(component);
    component.dispose = () => {
      disposals += 1;
      dispose?.();
    };
    mounted.set(key, component);
    if (failMount) throw new Error("partial host initialization failed");
  }) as ExtensionContext["ui"]["setWidget"];
  const state = { status: "idle", siblings: true, reads: 0, subscriptions: 0 };
  const signals: AbortSignal[] = [];
  let emit: (frame: unknown) => void = () => {};
  const pane = (id: string) => ({
    pane_id: id,
    workspace_id: "w1",
    tab_id: `${id}:tab`,
    terminal_id: `${id}:term`,
    focused: false,
    revision: 1,
    agent: "pi",
    agent_status: state.status,
  });
  const observer = createHerdrWidgetObserver({
    environment: { paneId: "w1:p1", socketEndpoint: "/unused" },
    retryDelayMs: 0,
    async request(_endpoint, request) {
      state.reads += 1;
      if (request.method === "pane.current") {
        if (failRead) {
          failRead = false;
          throw new Error("refresh failed");
        }
        const pending = heldRead;
        heldRead = undefined;
        if (pending) {
          pending.entered();
          await pending.wait;
        }
      }
      const panes = [pane("w1:p1"), ...(state.siblings ? [pane("w1:p2")] : [])];
      if (request.method === "pane.current") return { type: "pane_current", pane: panes[0] };
      if (request.method === "pane.list") return { type: "pane_list", panes };
      if (request.method === "agent.list") return { type: "agent_list", agents: panes };
      return { type: "workspace_info", workspace: { workspace_id: "w1" } };
    },
    async subscribe(_endpoint, _request, signal, onEvent) {
      state.subscriptions += 1;
      signals.push(signal);
      emit = onEvent;
      let finish!: () => void;
      const closed = new Promise<void>((resolve) => {
        finish = resolve;
      });
      finishSubscription = finish;
      signal.addEventListener("abort", finish, { once: true });
      return {
        closed,
        close() {
          signal.removeEventListener("abort", finish);
          finish();
          if (failClose) throw new Error("subscription close failed");
        },
      };
    },
  });
  return {
    ctx,
    observer,
    mounted,
    state,
    signals,
    calls,
    get mounts() {
      return mounts;
    },
    get disposals() {
      return disposals;
    },
    get repaints() {
      return repaints;
    },
    fail(value: boolean) {
      failMount = value;
    },
    failClear(value: boolean) {
      failClear = value;
    },
    failClose(value: boolean) {
      failClose = value;
    },
    failRead() {
      failRead = true;
    },
    endSubscription() {
      finishSubscription();
    },
    holdNextRead() {
      let entered!: () => void;
      let release!: () => void;
      const ready = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const wait = new Promise<void>((resolve) => {
        release = resolve;
      });
      heldRead = { entered, wait };
      return { ready, release };
    },
    invalidate() {
      emit({ event: "pane_updated", data: { pane: pane("w1:p2") } });
    },
    text() {
      return mounted.get(HERDR_WIDGET_KEY)?.render(80).join("\n") ?? "";
    },
  };
}

test("authoritative Herdr updates retain one mounted widget and sibling order", async () => {
  const f = fixture();
  f.mounted.set("before", { render: () => ["before"], invalidate() {} });
  f.observer.start(f.ctx);
  try {
    await until(() => f.text().includes("idle"));
    f.mounted.set("after", { render: () => ["after"], invalidate() {} });
    const component = f.mounted.get(HERDR_WIDGET_KEY);
    for (const status of ["working", "blocked", "done"]) {
      f.state.status = status;
      f.invalidate();
      await until(() => f.text().includes(status));
      assert.equal(f.mounted.get(HERDR_WIDGET_KEY), component);
    }
    assert.equal(f.mounts, 1);
    assert.equal(f.disposals, 0);
    assert.equal(f.repaints, 3);
    assert.deepEqual([...f.mounted.keys()], ["before", HERDR_WIDGET_KEY, "after"]);
    const reads = f.state.reads;
    f.invalidate();
    await until(() => f.state.reads >= reads + 4);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(f.repaints, 3, "identical authoritative fingerprints do not republish");
    assert.deepEqual(f.calls, [HERDR_WIDGET_KEY]);
    f.state.siblings = false;
    f.invalidate();
    await until(() => !f.mounted.has(HERDR_WIDGET_KEY));
    assert.equal(f.disposals, 1);
    assert.deepEqual([...f.mounted.keys()], ["before", "after"]);
    f.state.siblings = true;
    f.invalidate();
    await until(() => f.mounted.has(HERDR_WIDGET_KEY));
    assert.equal(f.mounts, 2);
    assert.deepEqual([...f.mounted.keys()], ["before", "after", HERDR_WIDGET_KEY]);
  } finally {
    await f.observer.shutdown(f.ctx);
    await f.observer.shutdown(f.ctx);
  }
  assert.equal(f.disposals, 2);
  assert.deepEqual([...f.mounted.keys()], ["before", "after"]);
  assert.ok(f.signals.every((signal) => signal.aborted));
});

test("same-manager restart disposes before replacement and ignores old component disposal", async () => {
  const f = fixture();
  f.observer.start(f.ctx);
  try {
    await until(() => f.mounted.has(HERDR_WIDGET_KEY));
    const old = f.mounted.get(HERDR_WIDGET_KEY);
    f.observer.start(f.ctx);
    assert.equal(f.disposals, 1);
    assert.equal(f.mounted.has(HERDR_WIDGET_KEY), false);
    await until(() => f.mounts === 2);
    const current = f.mounted.get(HERDR_WIDGET_KEY);
    old?.dispose?.();
    f.state.status = "blocked";
    f.invalidate();
    await until(() => f.text().includes("blocked"));
    assert.equal(f.mounted.get(HERDR_WIDGET_KEY), current);
    assert.equal(f.mounts, 2);
    assert.deepEqual(old?.render(80), []);
  } finally {
    await f.observer.shutdown(f.ctx);
  }
});

test("shutdown aborts source work even when widget cleanup fails", async () => {
  const f = fixture();
  f.observer.start(f.ctx);
  await until(() => f.mounted.has(HERDR_WIDGET_KEY));
  const component = f.mounted.get(HERDR_WIDGET_KEY);
  const original = f.ctx.ui.setWidget.bind(f.ctx.ui);
  f.ctx.ui.setWidget = ((key, content) => {
    if (content === undefined) throw new Error("cleanup failed");
    if (Array.isArray(content)) original(key, content);
    else original(key, content);
  }) as ExtensionContext["ui"]["setWidget"];
  await assert.rejects(f.observer.shutdown(f.ctx), /cleanup failed/);
  assert.ok(f.signals.every((signal) => signal.aborted));
  assert.deepEqual(component?.render(80), []);
  await f.observer.shutdown(f.ctx);
  await f.observer.shutdown(f.ctx);
  assert.equal(f.state.subscriptions, 1);
  component?.dispose?.();
});

test("failed widget initialization clears its partial mount and preserves bounded source retries", async () => {
  const f = fixture();
  f.fail(true);
  f.observer.start(f.ctx);
  try {
    await until(() => f.state.subscriptions === 2 && f.disposals === 2);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(f.mounts, 2);
    assert.equal(f.mounted.size, 0);
    assert.ok(f.calls.every((key) => key === HERDR_WIDGET_KEY));
    assert.ok(f.signals.every((signal) => signal.aborted));
  } finally {
    await f.observer.shutdown(f.ctx);
    await f.observer.shutdown(f.ctx);
  }
});

function messages(error: unknown): string[] {
  if (error instanceof AggregateError) return error.errors.flatMap(messages);
  return [error instanceof Error ? error.message : String(error)];
}

for (const failure of ["subscription", "refresh"] as const) {
  test(`${failure} failure still aborts when clearing the widget also fails`, async () => {
    const f = fixture();
    f.observer.start(f.ctx);
    await until(() => f.mounted.has(HERDR_WIDGET_KEY));
    f.failClear(true);
    if (failure === "subscription") f.endSubscription();
    else {
      f.failRead();
      f.invalidate();
    }
    await until(() => f.signals[0]?.aborted === true);
    f.failClear(false);
    await assert.rejects(f.observer.shutdown(f.ctx), (error: unknown) => {
      const causes = messages(error);
      assert.ok(causes.includes("cleanup failed"));
      assert.ok(causes.includes(failure === "subscription" ? "Herdr subscription ended" : "refresh failed"));
      return true;
    });
    assert.ok(f.signals.every((signal) => signal.aborted));
    await f.observer.shutdown(f.ctx);
  });
}

test("one failed shutdown invalidates context ownership before draining an uncooperative read", async () => {
  const f = fixture();
  f.observer.start(f.ctx);
  await until(() => f.mounted.has(HERDR_WIDGET_KEY));
  const held = f.holdNextRead();
  f.invalidate();
  await held.ready;
  f.failClear(true);
  const sessionManager = f.ctx.sessionManager;
  let staleReads = 0;
  const shutdown = assert.rejects(f.observer.shutdown(f.ctx), /cleanup failed/u);
  Object.defineProperty(f.ctx, "sessionManager", {
    configurable: true,
    get() {
      staleReads++;
      throw new Error("stale context");
    },
  });
  held.release();
  await shutdown;
  assert.equal(staleReads, 0);
  assert.ok(f.signals.every((signal) => signal.aborted));
  assert.deepEqual(f.mounted.get(HERDR_WIDGET_KEY)?.render(80), []);
  Object.defineProperty(f.ctx, "sessionManager", { configurable: true, value: sessionManager });
  f.failClear(false);
  await f.observer.shutdown(f.ctx);
});

test("failed replacement start invalidates old reads and leaves cleanup joinable", async () => {
  const f = fixture();
  f.observer.start(f.ctx);
  await until(() => f.mounted.has(HERDR_WIDGET_KEY));
  const held = f.holdNextRead();
  f.invalidate();
  await held.ready;
  f.failClear(true);
  assert.throws(() => f.observer.start(f.ctx), /cleanup failed/u);
  const sessionManager = f.ctx.sessionManager;
  let staleReads = 0;
  Object.defineProperty(f.ctx, "sessionManager", {
    configurable: true,
    get() {
      staleReads++;
      throw new Error("stale context");
    },
  });
  const drained = f.observer.shutdown(f.ctx);
  held.release();
  await drained;
  assert.equal(staleReads, 0);
  assert.ok(f.signals.every((signal) => signal.aborted));
  Object.defineProperty(f.ctx, "sessionManager", { configurable: true, value: sessionManager });
  f.failClear(false);
});

test("subscription-close failure remains observable after shutdown invalidates the generation", async () => {
  const f = fixture();
  f.observer.start(f.ctx);
  await until(() => f.mounted.has(HERDR_WIDGET_KEY));
  f.failClose(true);
  await assert.rejects(f.observer.shutdown(f.ctx), (error: unknown) => {
    assert.ok(messages(error).includes("subscription close failed"));
    return true;
  });
  assert.ok(f.signals.every((signal) => signal.aborted));
  f.failClose(false);
  await f.observer.shutdown(f.ctx);
});
