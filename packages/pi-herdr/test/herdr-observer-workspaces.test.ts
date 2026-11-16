import assert from "node:assert/strict";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { test } from "vitest";
import { createMockContext } from "../../../test/support.js";
import type { HerdrRequest } from "../src/herdr-client.js";
import { createHerdrWidgetObserver } from "../src/herdr-observer.js";
import { HERDR_WIDGET_KEY } from "../src/herdr-widget.js";

function context() {
  return createMockContext({
    mode: "tui",
    hasUI: true,
    theme: { bold: (text: string) => text, fg: (_role: string, text: string) => text },
  });
}

function pane(paneId: string, workspaceId: string, overrides: Record<string, unknown> = {}) {
  return {
    pane_id: paneId,
    workspace_id: workspaceId,
    tab_id: `${workspaceId}:t1`,
    terminal_id: `${paneId}-terminal`,
    focused: false,
    revision: 1,
    agent: "pi",
    agent_status: "idle",
    label: paneId,
    ...overrides,
  };
}

async function until(predicate: () => boolean) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error("Cross-workspace observer did not reach the expected state");
}

function render(widget: unknown): string {
  assert.equal(typeof widget, "function");
  return (widget as (tui: unknown, theme: Theme) => { render(width: number): string[] })(
    { terminal: { rows: 36 }, requestRender() {} },
    { bold: (text: string) => text, fg: (_role: string, text: string) => text } as Theme,
  )
    .render(200)
    .join("\n");
}

function fixture() {
  const host = context();
  const current = pane("w1:p1", "w1");
  const remote = pane("w2:p1", "w2", { label: "remote-worker" });
  const state = {
    current,
    panes: [current, remote],
    workspaces: [
      { workspace_id: "w1", label: "local-space" },
      { workspace_id: "w2", label: "remote-space" },
    ],
    name: "reviewer",
    extraAgents: [] as ReturnType<typeof pane>[],
    requests: [] as HerdrRequest[],
    override: undefined as
      | ((request: HerdrRequest, result: unknown, signal: AbortSignal) => Promise<unknown> | undefined)
      | undefined,
  };
  const subscriptions: Array<{
    emit(frame: unknown): void;
    signal: AbortSignal;
    statuses: string[];
  }> = [];
  const observer = createHerdrWidgetObserver({
    environment: { paneId: current.pane_id, socketEndpoint: "/unused" },
    retryDelayMs: 0,
    async request(_endpoint, request, signal) {
      state.requests.push(request);
      let result: unknown;
      switch (request.method) {
        case "pane.current":
          assert.deepEqual(request.params, { caller_pane_id: "w1:p1" });
          result = { type: "pane_current", pane: state.current };
          break;
        case "pane.list":
          assert.deepEqual(request.params, {}, "pane discovery must not be workspace-scoped");
          result = { type: "pane_list", panes: [...state.panes] };
          break;
        case "agent.list":
          assert.deepEqual(request.params, {});
          result = {
            type: "agent_list",
            agents: [...state.panes.map((entry) => ({ ...entry, name: state.name })), ...state.extraAgents],
          };
          break;
        case "workspace.list":
          assert.deepEqual(request.params, {});
          result = { type: "workspace_list", workspaces: [...state.workspaces] };
          break;
        default:
          throw new Error(`Unexpected Herdr read: ${request.method}`);
      }
      return state.override?.(request, result, signal) ?? result;
    },
    async subscribe(_endpoint, request, signal, emit) {
      let finish!: () => void;
      const closed = new Promise<void>((resolve) => {
        finish = resolve;
      });
      signal.addEventListener("abort", finish, { once: true });
      subscriptions.push({
        emit,
        signal,
        statuses: (request.params.subscriptions as Array<{ type: string; pane_id?: string }>)
          .filter((entry) => entry.type === "pane.agent_status_changed")
          .map((entry) => entry.pane_id as string),
      });
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
    ...host,
    observer,
    state,
    remote,
    subscriptions,
    emit(frame: unknown) {
      subscriptions.at(-1)?.emit(frame);
    },
    text() {
      return render(host.widgets.get(HERDR_WIDGET_KEY));
    },
    async ready() {
      await until(() => typeof host.widgets.get(HERDR_WIDGET_KEY) === "function");
    },
  };
}

test("discovers remote siblings without local siblings and joins names only to matching panes", async () => {
  const f = fixture();
  f.state.panes.push(pane("w3:shell", "w3", { agent: null }));
  f.state.extraAgents = [
    pane("w2:p1", "wrong-workspace", { name: "wrong-name" }),
    pane("w4:absent", "w4", { name: "absent-agent" }),
  ];
  f.observer.start(f.ctx);
  try {
    await f.ready();
    assert.match(f.text(), /1 sibling agent/);
    assert.match(f.text(), /reviewer.*remote-worker\/p1.*remote-space\/w2/);
    assert.doesNotMatch(f.text(), /local-space|shell|absent-agent|wrong-name/);
    assert.deepEqual(f.subscriptions[0]?.statuses, ["w1:p1", "w2:p1"]);
    const reads = f.state.requests.length;
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(f.state.requests.length, reads, "discovery must remain event-driven");
  } finally {
    await f.observer.shutdown(f.ctx);
  }
});

test("remote status, names, and workspace labels refresh from authoritative reads", async () => {
  const f = fixture();
  f.observer.start(f.ctx);
  try {
    await f.ready();
    f.state.panes = [f.state.current, { ...f.remote, agent_status: "blocked" }];
    f.emit({ event: "pane.agent_status_changed", data: { ...f.remote, agent_status: "idle" } });
    await until(() => f.text().includes("blocked"));
    f.state.name = "renamed-reviewer";
    f.emit({ event: "pane_updated", data: { pane: f.remote } });
    await until(() => f.text().includes("renamed-reviewer"));
    f.state.workspaces = [
      { workspace_id: "w1", label: "local-space" },
      { workspace_id: "w2", label: "renamed\u001b[31m-space" },
    ];
    f.emit({ event: "workspace_renamed", data: { workspace_id: "w2", label: "stale-label" } });
    await until(() => f.text().includes("renamed-space/w2"));
    assert.doesNotMatch(f.text(), /stale-label/);
    assert.equal(f.text().includes("\u001b"), false);
    assert.equal(f.subscriptions.length, 1, "presentation updates do not rebuild subscriptions");
  } finally {
    await f.observer.shutdown(f.ctx);
  }
});

for (const event of ["pane_created", "pane_agent_detected", "workspace_created"]) {
  test(`${event} discovers agents in another workspace and rebuilds status subscriptions`, async () => {
    const f = fixture();
    f.observer.start(f.ctx);
    try {
      await f.ready();
      const added = pane("w3:p1", "w3", { label: "new-worker", agent: "codex" });
      f.state.panes.push(added);
      const workspace = { workspace_id: "w3", label: "new-space" };
      f.state.workspaces.push(workspace);
      f.emit({
        event,
        data: event === "workspace_created" ? { workspace } : event === "pane_created" ? { pane: added } : added,
      });
      await until(
        () =>
          f.subscriptions.length === 2 &&
          typeof f.widgets.get(HERDR_WIDGET_KEY) === "function" &&
          f.text().includes("new-space/w3"),
      );
      assert.match(f.text(), /2 sibling agents/);
      assert.ok(f.subscriptions[1]?.statuses.includes("w3:p1"));
      assert.equal(f.subscriptions[0]?.signal.aborted, true);
    } finally {
      await f.observer.shutdown(f.ctx);
    }
  });
}

for (const event of ["pane_closed", "pane_exited", "pane_agent_detected", "workspace_closed"]) {
  test(`${event} removes remote agents and their owned status subscriptions`, async () => {
    const f = fixture();
    f.observer.start(f.ctx);
    try {
      await f.ready();
      f.state.panes =
        event === "pane_agent_detected" ? [f.state.current, pane("w2:p1", "w2", { agent: null })] : [f.state.current];
      f.state.workspaces = [{ workspace_id: "w1", label: "local-space" }];
      f.emit({ event, data: { ...f.remote, released: true } });
      await until(() => f.subscriptions.length === 2 && f.widgets.get(HERDR_WIDGET_KEY) === undefined);
      assert.deepEqual(f.subscriptions[1]?.statuses, ["w1:p1"]);
      assert.equal(f.subscriptions[0]?.signal.aborted, true);
    } finally {
      await f.observer.shutdown(f.ctx);
    }
  });
}

test("moving a remote agent between workspaces replaces its pane identity and label", async () => {
  const f = fixture();
  f.observer.start(f.ctx);
  try {
    await f.ready();
    const moved = pane("w3:p9", "w3", { label: "moved-worker" });
    f.state.panes = [f.state.current, moved];
    f.state.workspaces.push({ workspace_id: "w3", label: "destination" });
    f.emit({
      event: "pane_moved",
      data: { pane: moved, previous_pane_id: f.remote.pane_id, previous_workspace_id: "w2" },
    });
    await until(
      () =>
        f.subscriptions.length === 2 &&
        typeof f.widgets.get(HERDR_WIDGET_KEY) === "function" &&
        f.text().includes("moved-worker/p9"),
    );
    assert.match(f.text(), /destination\/w3/);
    assert.doesNotMatch(f.text(), /remote-worker|remote-space/);
    assert.deepEqual(f.subscriptions[1]?.statuses, ["w1:p1", "w3:p9"]);
  } finally {
    await f.observer.shutdown(f.ctx);
  }
});

for (const boundary of ["shutdown", "replacement"]) {
  test(`${boundary} aborts delayed cross-workspace reads and prevents stale publication`, async () => {
    const f = fixture();
    f.observer.start(f.ctx);
    let active = f.ctx;
    let resolve!: (value: unknown) => void;
    const pending = new Promise<unknown>((done) => {
      resolve = done;
    });
    try {
      await f.ready();
      let held: { result: unknown; signal: AbortSignal } | undefined;
      f.state.override = (request, result, signal) => {
        if (request.method !== "workspace.list" || held) return undefined;
        held = { result, signal };
        return pending;
      };
      f.emit({ event: "workspace_renamed", data: { workspace_id: "w2", label: "ignored" } });
      await until(() => held !== undefined);
      assert.ok(held);
      if (boundary === "shutdown") {
        const stopping = f.observer.shutdown(f.ctx);
        assert.equal(held.signal.aborted, true);
        resolve(held.result);
        await stopping;
        assert.equal(f.widgets.get(HERDR_WIDGET_KEY), undefined);
      } else {
        const replacement = context();
        active = replacement.ctx;
        f.state.workspaces = [{ workspace_id: "w2", label: "replacement-space" }];
        f.observer.start(active);
        assert.equal(held.signal.aborted, true);
        await until(() => typeof replacement.widgets.get(HERDR_WIDGET_KEY) === "function");
        resolve(held.result);
        await new Promise<void>((done) => setImmediate(done));
        assert.match(render(replacement.widgets.get(HERDR_WIDGET_KEY)), /replacement-space\/w2/);
        assert.equal(f.widgets.get(HERDR_WIDGET_KEY), undefined);
      }
      assert.equal(f.subscriptions[0]?.signal.aborted, true);
    } finally {
      resolve(undefined);
      await f.observer.shutdown(active);
    }
  });
}
