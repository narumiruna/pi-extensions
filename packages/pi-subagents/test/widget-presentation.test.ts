import assert from "node:assert/strict";
import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { visibleWidth } from "@earendil-works/pi-tui";
import * as collectionApi from "@narumitw/pi-tui-kit/editor-status-collection";
import * as viewApi from "@narumitw/pi-tui-kit/editor-status-view";
import { afterEach, test, vi } from "vitest";
import { createMockContext } from "../../../test/support.js";
import type { ActiveJobDisplay, SubagentRuntime } from "../src/runtime.js";
import { DEFAULT_SUBAGENT_SETTINGS } from "../src/settings.js";
import { createSubagentWidgetController, renderSubagentWidget, type SubagentCyclePhase } from "../src/widget.js";
import { subagentWidgetRowBudget } from "../src/widget-renderer.js";

const theme = { fg: (_role: string, value: string) => value } as Theme;
const job: ActiveJobDisplay = {
  jobId: "job_one",
  task: "Review tests",
  state: "running",
  thinkingLevel: "medium",
  defaultThinkingLevel: "high",
  elapsedMs: 0,
  tools: ["read"],
};
const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const dispose of cleanup.splice(0).reverse()) dispose();
  vi.restoreAllMocks();
});

function fixture(initial: ActiveJobDisplay[] = [job], idle = true, phase: SubagentCyclePhase = "idle") {
  let jobs = initial;
  let tick!: () => void;
  const callbacks: (() => void)[] = [];
  const unsubscribe = vi.fn();
  vi.spyOn(globalThis, "setInterval").mockImplementation((callback) => {
    tick = callback as () => void;
    return { unref() {} } as NodeJS.Timeout;
  });
  vi.spyOn(globalThis, "clearInterval").mockImplementation(() => {});
  const runtime = {
    activeJobsForDisplay: vi.fn(() => jobs),
    subscribeJobs: vi.fn((callback: () => void) => {
      callbacks.push(callback);
      return unsubscribe;
    }),
  };
  const context = createMockContext({ mode: "tui", isIdle: () => idle });
  const controller = createSubagentWidgetController(runtime as unknown as SubagentRuntime);
  const ctx = context.ctx as ExtensionContext;
  const requests = vi.fn();
  const terminal = { rows: 36 };
  let component: (Component & { dispose?(): void }) | undefined;
  const mounts = vi.spyOn(ctx.ui, "setWidget").mockImplementation((key, value) => {
    component?.dispose?.();
    component = undefined;
    context.widgets.set(key, value);
    if (typeof value === "function") component = value({ terminal, requestRender: requests } as unknown as TUI, theme);
  });
  controller.start(context.ctx, undefined, phase);
  cleanup.push(() => controller.shutdown(context.ctx));
  const controls = controller.controls(context.ctx);
  assert.ok(controls);
  return {
    controller,
    context,
    ctx,
    controls,
    runtime,
    unsubscribe,
    callbacks,
    terminal,
    requests,
    mounts,
    component: () => component,
    render: (width = 200) => component?.render(width) ?? [],
    replace(next: ActiveJobDisplay[]) {
      jobs = next;
      callbacks.at(-1)?.();
    },
    tick,
    setIdle(next: boolean) {
      idle = next;
    },
    cycle(outcome: string | undefined = "stop", aborted = false) {
      controller.agentStarted(context.ctx);
      controller.userMessage(context.ctx);
      if (outcome !== undefined) controller.turnEnded(context.ctx, outcome);
      controller.settled(context.ctx, aborted);
    },
  };
}

test("retains one mount for visible changes, invalidates renders, and clears only its own key", () => {
  const f = fixture();
  f.context.widgets.set("sibling", ["keep"]);
  const component = f.component();
  const before = f.render();
  f.replace([{ ...job, task: "Changed task", elapsedMs: 1_000 }]);
  const after = f.render();
  const requests = f.requests.mock.calls.length;
  f.tick();
  assert.equal(f.component(), component);
  assert.equal(f.mounts.mock.calls.length, 1);
  assert.equal(f.requests.mock.calls.length, requests, "identical refresh does not request another render");
  assert.match(before.join("\n"), /Review tests/u);
  assert.match(after.join("\n"), /Changed task.*1s/u);
  assert.doesNotMatch(before.join("\n"), /Changed task/u, "previously rendered text is independent");
  f.controls.setMode("hidden");
  assert.deepEqual(f.render(), []);
  assert.deepEqual(component?.render(200), []);
  assert.deepEqual(f.context.widgets.get("sibling"), ["keep"]);
  f.replace([{ ...job, task: "Latest hidden task" }]);
  assert.deepEqual(f.render(), []);
  f.controls.setMode("expanded");
  assert.notEqual(f.component(), component);
  assert.match(f.render().join("\n"), /Latest hidden task/u);
});

test.each(["provider", "model"] as const)("refreshes a changed %s override without remounting", (field) => {
  const f = fixture([{ ...job, [field]: "first-id" }]);
  const component = f.component();
  const handle = f.controls.item(job.jobId);
  assert.match(f.render()[2] ?? "", new RegExp(`${field}: first-id`, "u"));
  f.replace([{ ...job, [field]: "second-id" }]);
  assert.equal(f.component(), component);
  assert.equal(f.mounts.mock.calls.length, 1);
  assert.match(f.render()[2] ?? "", new RegExp(`${field}: second-id`, "u"));
  assert.equal(handle?.compact(), false, "a semantic model change invalidates the old handle");
  assert.equal(f.controls.item(job.jobId)?.compact(), true);
  assert.doesNotMatch(f.render()[2] ?? "", /provider:|model:/u);
  assert.equal(f.controls.item(job.jobId)?.expand(), true);
  f.replace([job]);
  assert.equal(f.component(), component);
  assert.doesNotMatch(f.render()[2] ?? "", /provider:|model:/u);
});

test.each([0, 1, 2, 3, 4, 10])("renderer accounts for the separator in a %s-row budget", (budget) => {
  const jobs = Array.from({ length: 8 }, (_, index) => ({
    ...job,
    jobId: `job_${index}`,
    state: index < 3 ? ("running" as const) : ("queued" as const),
  }));
  for (const width of [0, 1, 2, 40, 200]) {
    const lines = renderSubagentWidget(jobs, theme, width, DEFAULT_SUBAGENT_SETTINGS, budget);
    assert.ok(lines.length <= budget);
    assert.ok(lines.every((line) => visibleWidth(line) <= width));
    if (budget < 2) assert.deepEqual(lines, []);
    else assert.equal(lines[0], "─".repeat(width));
    if (width === 200 && budget >= 2 && budget < 10) {
      assert.match(lines[1] ?? "", /8 active · 3 running · 5 queued/u);
      assert.match(lines[1] ?? "", new RegExp(`${8 - Math.max(0, budget - 2)} not shown`, "u"));
    }
  }
});

test("height changes and compact rendering preserve truthful counts and local row reservation", () => {
  const f = fixture([job, { ...job, jobId: "job_two", state: "queued" }]);
  assert.deepEqual([0, 8, 9, 10, 11, 36].map(subagentWidgetRowBudget), [0, 0, 1, 2, 3, 10]);
  for (const rows of [0, 8, 9, 10, 11, 36]) {
    f.terminal.rows = rows;
    assert.ok(f.render().length <= subagentWidgetRowBudget(rows));
  }
  f.controls.setMode("compact");
  assert.equal(f.render().length, 2);
  assert.match(f.render()[1] ?? "", /2 active · 1 running · 1 queued · 2 not shown/u);
  assert.deepEqual(renderSubagentWidget([], theme, 80), []);
});

test("settings disable beats pin and manual show; unpin does not itself compact", () => {
  const f = fixture();
  f.controls.setPinned(true);
  f.controls.setTrigger("user-message");
  f.controller.userMessage(f.context.ctx);
  assert.equal(f.render().length, 3);
  f.controls.setPinned(false);
  assert.equal(f.render().length, 3);
  f.controller.update(f.context.ctx, { ...DEFAULT_SUBAGENT_SETTINGS, showWidget: false });
  f.controls.setPinned(true);
  f.controls.setMode("expanded");
  assert.deepEqual(f.render(), []);
  f.controller.update(f.context.ctx, DEFAULT_SUBAGENT_SETTINGS);
  assert.equal(f.render().length, 3);
  f.controls.setMode("hidden");
  f.replace([{ ...job, task: "new revision" }]);
  assert.deepEqual(f.render(), []);
});

test.each(["stop", "length", "toolUse"])("future settled cycle compacts once after observed %s outcome", (outcome) => {
  const f = fixture();
  f.controller.agentStarted(f.context.ctx);
  f.controls.setTrigger("settled-cycle");
  f.cycle(outcome); // Repeated start, queued user and tools still belong to the excluded current cycle.
  assert.equal(f.render().length, 3);
  assert.equal(f.controls.state().trigger, "settled-cycle");
  f.controller.agentStarted(f.context.ctx);
  f.controller.userMessage(f.context.ctx);
  f.replace([{ ...job, elapsedMs: 8_000 }]);
  f.tick();
  f.controller.turnEnded(f.context.ctx, outcome);
  f.controller.settled(f.context.ctx, false);
  assert.equal(f.render().length, 2);
  assert.equal(f.controls.state().trigger, "manual");
  f.controls.setMode("expanded");
  f.cycle();
  assert.equal(f.render().length, 3);
});

test("arming while Pi is preparing a run excludes it before agent_start is emitted", () => {
  const f = fixture();
  f.setIdle(false);
  f.controller.preparing(f.context.ctx);
  f.controls.setTrigger("settled-cycle");
  f.controller.agentStarted(f.context.ctx);
  f.controller.userMessage(f.context.ctx);
  f.controller.turnEnded(f.context.ctx, "stop");
  f.controller.settled(f.context.ctx, false);
  assert.equal(f.render().length, 3);
  assert.equal(f.controls.state().trigger, "settled-cycle");
  f.setIdle(true);
  f.cycle();
  assert.equal(f.render().length, 2);
});

test("busy start excludes the pre-existing cycle even when agent_start was missed during settings load", () => {
  const f = fixture([job], false, "running");
  f.controls.setTrigger("settled-cycle");
  f.controller.userMessage(f.context.ctx);
  f.controller.turnEnded(f.context.ctx, "stop");
  f.controller.settled(f.context.ctx, false);
  assert.equal(f.render().length, 3);
  f.cycle();
  assert.equal(f.render().length, 2);
});

test("positive idle discards provisional maintenance tracking without consuming the rule", () => {
  const f = fixture([job], false);
  f.controller.maintenance(f.ctx);
  f.controls.setTrigger("settled-cycle");
  f.setIdle(true);
  f.controls.setTrigger("settled-cycle");
  f.cycle();
  assert.equal(f.render().length, 2);
  assert.equal(f.controls.state().trigger, "manual");
});

test("a live run signal seeds late attachment without treating other busy work as a run", () => {
  const f = fixture();
  Object.defineProperty(f.ctx, "signal", { value: new AbortController().signal });
  f.setIdle(false);
  f.controls.setTrigger("settled-cycle");
  f.cycle();
  assert.equal(f.render().length, 3);
  f.setIdle(true);
  f.cycle();
  assert.equal(f.render().length, 2);
});

for (const reason of ["threshold", "overflow"] as const) {
  for (const willRetry of [false, true]) {
    test(`${reason} compaction retry=${willRetry} excludes its current preparation before agent_start`, () => {
      const f = fixture();
      f.setIdle(false);
      f.controller.automaticCompaction(f.ctx);
      f.controls.setTrigger("settled-cycle");
      f.controller.preparing(f.ctx);
      f.cycle();
      assert.equal(f.render().length, 3);
      f.setIdle(true);
      f.cycle();
      assert.equal(f.render().length, 2);
    });
  }
}

for (const recovery of ["idle-arm", "next-preparation", "next-automatic-compaction"] as const) {
  test(`failed preparation without settlement recovers at ${recovery}`, () => {
    const f = fixture();
    f.setIdle(false);
    f.controller.preparing(f.ctx);
    f.controls.setTrigger("settled-cycle");
    f.setIdle(true);
    if (recovery === "idle-arm") f.controls.setTrigger("settled-cycle");
    f.setIdle(false);
    if (recovery === "next-automatic-compaction") f.controller.automaticCompaction(f.ctx);
    f.controller.preparing(f.ctx);
    f.cycle();
    assert.equal(f.render().length, 2);
    assert.equal(f.controls.state().trigger, "manual");
  });
}

test.each([
  { outcome: "error", aborted: false },
  { outcome: "aborted", aborted: false },
  { outcome: "stop", aborted: true },
  { outcome: undefined, aborted: false },
])("ineligible settled cycle stays armed: %j", ({ outcome, aborted }) => {
  const f = fixture();
  f.controls.setTrigger("settled-cycle");
  f.controller.agentStarted(f.context.ctx);
  f.controller.userMessage(f.context.ctx);
  if (outcome) f.controller.turnEnded(f.context.ctx, outcome);
  f.controller.settled(f.context.ctx, aborted);
  assert.equal(f.render().length, 3);
  assert.equal(f.controls.state().trigger, "settled-cycle");
  f.cycle();
  assert.equal(f.render().length, 2);
});

test("a future custom-only cycle cannot reuse post-arm user consumption from the excluded cycle", () => {
  const f = fixture();
  f.controller.agentStarted(f.context.ctx);
  f.controls.setTrigger("settled-cycle");
  f.controller.userMessage(f.context.ctx);
  f.controller.turnEnded(f.context.ctx, "stop");
  f.controller.settled(f.context.ctx, false);
  f.controller.agentStarted(f.context.ctx);
  f.controller.turnEnded(f.context.ctx, "stop");
  f.controller.settled(f.context.ctx, false);
  assert.equal(f.render().length, 3);
  f.cycle();
  assert.equal(f.render().length, 2);
});

test("semantic changes rearm against the active cycle; elapsed refreshes do not", () => {
  const f = fixture();
  f.controls.setTrigger("settled-cycle");
  f.controller.agentStarted(f.context.ctx);
  f.controller.userMessage(f.context.ctx);
  f.replace([{ ...job, task: "New work" }]);
  f.controller.turnEnded(f.context.ctx, "stop");
  f.controller.settled(f.context.ctx, false);
  assert.equal(f.render().length, 3);
  f.cycle();
  assert.equal(f.render().length, 2);
});

test("raw IDs isolate item views, preserve removal across snapshots, and invalidate stale handles", () => {
  const rawId = "job_\u001b[31mone\u001b[0m";
  const f = fixture([{ ...job, jobId: rawId }, job]);
  const raw = f.controls.item(rawId);
  assert.ok(raw);
  assert.equal(raw.compact(), true);
  const compact = f.render();
  assert.doesNotMatch(compact[2] ?? "", /thinking:/u);
  assert.match(compact[3] ?? "", /thinking:/u);
  f.replace([{ ...job, jobId: rawId, elapsedMs: 3_000 }, job]);
  assert.equal(raw.expand(), true, "cosmetic updates preserve handle identity");
  const stale = f.controls.item(rawId);
  f.replace([{ ...job, jobId: rawId, task: "Semantic replacement" }, job]);
  assert.equal(stale?.remove(), false);
  assert.equal(f.controls.item(rawId)?.remove(), true);
  assert.match(f.render()[1] ?? "", /1 not shown \(1 removed\)/u);
  f.tick();
  assert.equal(f.controls.item(rawId), undefined);
  assert.equal(f.controls.item(job.jobId)?.remove(), true);
  assert.deepEqual(f.render(), [], "all removed items leave no orphan separator");
  assert.equal(f.runtime.activeJobsForDisplay().length, 2);
  f.controls.resetItems();
  assert.equal(f.render().length, 4);
  assert.equal(raw.remove(), false, "reset invalidates old collection handles");
  const removed = f.controls.item(rawId);
  assert.equal(removed?.remove(), true);
  f.replace([job]);
  f.replace([{ ...job, jobId: rawId }, job]);
  assert.equal(removed?.remove(), false, "reused IDs get a fresh incarnation");
  assert.ok(f.controls.item(rawId));
});

test("accepts eight maximum-size UTF-8 runtime jobs and rejects invalid snapshots atomically", () => {
  const task = "界".repeat(Math.floor((50 * 1024) / 3));
  const tools = Array.from({ length: 64 }, (_, index) => `${index}${"界".repeat(126)}`);
  const model = "界".repeat(Math.floor((16 * 1024 - 1024) / 3));
  const jobs = Array.from({ length: 8 }, (_, index) => ({
    ...job,
    jobId: `job_${index}`,
    task,
    tools,
    provider: "fixture-provider",
    model,
  }));
  const f = fixture(jobs);
  assert.equal(f.render().length, 10);
  const original = f.render();
  for (const invalid of [
    [...jobs, { ...job, jobId: "overflow" }],
    [{ ...job, task: "界".repeat(128 * 1024) }],
    [{ ...job, provider: "界".repeat(128 * 1024) }],
    [{ ...job, model: "界".repeat(128 * 1024) }],
    [job, job],
  ]) {
    assert.throws(() => f.replace(invalid), RangeError);
    assert.deepEqual(f.render(), original);
  }
  f.replace([job]);
  assert.equal(f.render().length, 3);
});

test("same-manager reset clears the old UI first and rejects stale callbacks before context access", () => {
  const f = fixture();
  const oldComponent = f.component();
  const oldCallback = f.callbacks[0];
  const oldTick = f.tick;
  const oldHandle = f.controls.item(job.jobId);
  const oldContext = f.context.ctx as ExtensionContext;
  f.controls.setMode("compact");
  f.controls.setPinned(true);
  f.controls.setTrigger("user-message");
  f.controller.start(oldContext);
  assert.equal(f.mounts.mock.calls.length, 3);
  assert.equal(f.mounts.mock.calls[1]?.[1], undefined, "old key is cleared before the replacement mounts");
  assert.equal(typeof f.mounts.mock.calls[2]?.[1], "function");
  assert.deepEqual(f.controller.controls(oldContext)?.state(), { mode: "default", pinned: false, trigger: "manual" });
  assert.equal(f.unsubscribe.mock.calls.length, 1);
  assert.deepEqual(oldComponent?.render(200), []);
  const currentComponent = f.component();
  oldComponent?.dispose?.();
  assert.equal(f.component(), currentComponent);
  // Replaced-session contexts can throw even on property access.
  const replacement = createMockContext({ mode: "tui" });
  f.controller.start(replacement.ctx);
  cleanup.push(() => f.controller.shutdown(replacement.ctx));
  Object.defineProperty(oldContext, "sessionManager", {
    get() {
      throw new Error("stale context accessed");
    },
  });
  oldCallback?.();
  oldTick();
  f.controls.setMode("compact");
  assert.equal(oldHandle?.remove(), false);
  assert.deepEqual(oldComponent?.render(200), []);
  // The shutdown cleanup registered by fixture must not read this poisoned object.
  Object.defineProperty(oldContext, "sessionManager", { value: (replacement.ctx as ExtensionContext).sessionManager });
});

test.each(["shutdown", "replacement"] as const)(
  "failed %s clears ownership and rejects captured controls before stale context reads",
  (operation) => {
    const f = fixture();
    const component = f.component();
    const handle = f.controls.item(job.jobId);
    const manager = f.ctx.sessionManager;
    const failure = new Error("clear failed");
    f.mounts.mockImplementationOnce(() => {
      throw failure;
    });
    assert.throws(
      () => (operation === "shutdown" ? f.controller.shutdown(f.ctx) : f.controller.start(f.ctx)),
      (error) => error === failure,
    );
    assert.equal(f.unsubscribe.mock.calls.length, 1);
    assert.equal(vi.mocked(clearInterval).mock.calls.length, 1);
    assert.equal(f.controller.controls(f.ctx), undefined);
    assert.equal(f.mounts.mock.calls.length, 2, "a failed clear must not mount a replacement");
    f.runtime.activeJobsForDisplay.mockClear();
    for (const key of ["sessionManager", "isIdle", "mode", "ui"] as const) {
      const descriptor = Object.getOwnPropertyDescriptor(f.ctx, key);
      Object.defineProperty(f.ctx, key, {
        configurable: true,
        get() {
          throw new Error(`stale ${key} getter`);
        },
      });
      cleanup.push(() => Object.defineProperty(f.ctx, key, descriptor as PropertyDescriptor));
    }
    f.callbacks[0]?.();
    f.tick();
    f.controls.state();
    f.controls.setMode("hidden");
    f.controls.setPinned(true);
    f.controls.setTrigger("settled-cycle");
    f.controls.resetItems();
    assert.equal(f.controls.item(job.jobId), undefined);
    assert.equal(handle?.compact(), false);
    assert.equal(handle?.expand(), false);
    assert.equal(handle?.remove(), false);
    assert.deepEqual(component?.render(200), []);
    f.controller.shutdown(f.ctx);
    assert.equal(f.runtime.activeJobsForDisplay.mock.calls.length, 0);
    assert.equal(f.mounts.mock.calls.length, 2);
    const replacement = createMockContext({ mode: "tui", sessionManager: manager });
    f.controller.start(replacement.ctx);
    cleanup.push(() => f.controller.shutdown(replacement.ctx));
    assert.ok(f.controller.controls(replacement.ctx));
  },
);

test("cleanup attempts every owned release and preserves simultaneous failures", () => {
  const releases: string[] = [];
  const failures = [
    new Error("unsubscribe failed"),
    new Error("view failed"),
    new Error("collection failed"),
    new Error("clear failed"),
  ];
  const makeView = viewApi.createEditorStatusView;
  vi.spyOn(viewApi, "createEditorStatusView").mockImplementation((options) => {
    const view = makeView(options);
    return {
      ...view,
      dispose() {
        releases.push("view");
        view.dispose();
        throw failures[1];
      },
    };
  });
  const makeCollection = collectionApi.createEditorStatusCollection;
  vi.spyOn(collectionApi, "createEditorStatusCollection").mockImplementation((options) => {
    const collection = makeCollection(options);
    return {
      ...collection,
      dispose() {
        releases.push("collection");
        collection.dispose();
        throw failures[2];
      },
    };
  });
  const f = fixture();
  f.unsubscribe.mockImplementationOnce(() => {
    releases.push("unsubscribe");
    throw failures[0];
  });
  f.mounts.mockImplementationOnce(() => {
    releases.push("publisher");
    throw failures[3];
  });
  assert.throws(
    () => f.controller.shutdown(f.ctx),
    (error) => {
      assert.ok(error instanceof AggregateError);
      assert.deepEqual(error.errors, failures);
      return true;
    },
  );
  assert.deepEqual(releases, ["unsubscribe", "view", "collection", "publisher"]);
  assert.equal(vi.mocked(clearInterval).mock.calls.length, 1);
  assert.equal(f.controller.controls(f.ctx), undefined);
  f.controller.shutdown(f.ctx);
  assert.equal(releases.length, 4, "failed cleanup must not retain owned references");
});

test("mount and cleanup failures preserve both causes and release refresh work", () => {
  const f = fixture();
  f.controller.shutdown(f.ctx);
  const mount = f.mounts.getMockImplementation();
  const mountFailure = new Error("mount failed");
  const clearFailure = new Error("clear failed");
  f.mounts.mockImplementation((...args) => {
    if (args[1] === undefined) throw clearFailure;
    mount?.(...args);
    throw mountFailure;
  });
  assert.throws(
    () => f.controller.start(f.ctx),
    (error) => {
      assert.ok(error instanceof AggregateError);
      const causes = error.errors.flatMap((cause) => (cause instanceof AggregateError ? cause.errors : [cause]));
      assert.ok(causes.includes(mountFailure));
      assert.ok(causes.includes(clearFailure));
      return true;
    },
  );
  assert.equal(f.unsubscribe.mock.calls.length, 2);
  assert.equal(vi.mocked(clearInterval).mock.calls.length, 2);
  assert.equal(f.controller.controls(f.ctx), undefined);
  assert.deepEqual(f.component()?.render(200), []);
});

test("failed mount releases timers and subscription and permits a fresh owner", () => {
  const f = fixture();
  f.controller.shutdown(f.context.ctx);
  const setWidget = f.ctx.ui.setWidget;
  f.ctx.ui.setWidget = () => {
    throw new Error("mount failed");
  };
  assert.throws(
    () => f.controller.start(f.context.ctx),
    (error) => {
      assert.ok(error instanceof AggregateError);
      assert.ok(error.errors.some((cause) => cause instanceof Error && cause.message === "mount failed"));
      return true;
    },
  );
  assert.equal(f.unsubscribe.mock.calls.length, 2);
  f.ctx.ui.setWidget = setWidget;
  f.controller.start(f.context.ctx);
  assert.equal(f.render().length, 3);
});
