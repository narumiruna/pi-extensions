import assert from "node:assert/strict";
import { visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, test, vi } from "vitest";
import { createProgressPresentation, progressDisplayItems } from "../src/progress-presentation.js";
import { renderProgressWidget } from "../src/progress-renderer.js";
import { MAX_PROGRESS_STEPS, MAX_PROGRESS_TEXT_LENGTH, type ProgressStep } from "../src/progress-state.js";
import { DEFAULT_PROGRESS_SETTINGS, type ProgressSettingsLoadResult } from "../src/settings.js";
import { createContext, createHarness, identityTheme, setProgress } from "./progress-harness.js";

const pending: ProgressStep[] = [{ text: "work", status: "pending" }];
const complete: ProgressStep[] = [{ text: "work", status: "completed" }];

function setup(mode: "tui" | "rpc" | "print" | "json" = "tui") {
  const current = createContext({ mode });
  let owned = true;
  const presentation = createProgressPresentation({
    context: current.ctx,
    isCurrent: () => owned,
    settings: DEFAULT_PROGRESS_SETTINGS,
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
  });
  presentation.reset(pending);
  return {
    current,
    presentation,
    replace: () => {
      owned = false;
    },
  };
}

afterEach(() => vi.useRealTimers());

test("ordinary and completion updates retain the mounted instance and sibling position", async () => {
  vi.useFakeTimers();
  const harness = createHarness();
  const current = createContext();
  const order = new Map<string, unknown>([["before", {}]]);
  const setWidget = current.ctx.ui.setWidget.bind(current.ctx.ui);
  current.ctx.ui.setWidget = (key, content, options) => {
    order.delete(key);
    if (content !== undefined) order.set(key, content);
    if (Array.isArray(content)) setWidget(key, content, options);
    else setWidget(key, content, options);
  };
  await harness.emit("session_start", current.ctx);
  await setProgress(harness, current.ctx, pending);
  const mounted = current.component;
  order.set("after", {});
  const mounts = current.widgets.length;
  await setProgress(harness, current.ctx, [{ text: "changed", status: "in_progress" }]);
  assert.match(current.renderWidget().join("\n"), /▶ changed/u);
  await setProgress(harness, current.ctx, [{ text: "changed", status: "completed" }]);
  assert.match(current.renderWidget().join("\n"), /✓ 1\/1 steps completed/u);
  assert.equal(current.component, mounted);
  assert.equal(current.widgets.length, mounts);
  assert.deepEqual([...order.keys()], ["before", "progress", "after"]);
  await vi.advanceTimersByTimeAsync(3_000);
  assert.deepEqual([...order.keys()], ["before", "after"]);
  await setProgress(harness, current.ctx, pending);
  assert.deepEqual([...order.keys()], ["before", "after", "progress"]);
  await harness.emit("session_shutdown", current.ctx);
});

for (const mode of ["tui", "rpc"] as const) {
  test(`${mode}: identical updates, render, resize, and refresh do not renew retention or publish no-ops`, async () => {
    vi.useFakeTimers();
    const { current, presentation } = setup(mode);
    presentation.update(complete, DEFAULT_PROGRESS_SETTINGS, true);
    const publications = current.widgets.length;
    const renders = current.renderRequests;
    await vi.advanceTimersByTimeAsync(2_000);
    presentation.update(structuredClone(complete), DEFAULT_PROGRESS_SETTINGS);
    presentation.refresh();
    current.setRows(12);
    current.component?.invalidate();
    current.renderWidget(20);
    assert.equal(current.widgets.length, publications);
    assert.equal(current.renderRequests, renders);
    assert.equal(vi.getTimerCount(), 1);
    await vi.advanceTimersByTimeAsync(999);
    assert.ok(current.renderWidget().length > 0);
    await vi.advanceTimersByTimeAsync(1);
    assert.deepEqual(current.renderWidget(), []);
    presentation.dispose();
    assert.equal(vi.getTimerCount(), 0);
  });
}

test("pin pauses retention; unpin restarts a full dwell for the latest completion revision", async () => {
  vi.useFakeTimers();
  const { current, presentation } = setup();
  presentation.update(complete, DEFAULT_PROGRESS_SETTINGS, true);
  await vi.advanceTimersByTimeAsync(2_999);
  presentation.view.setPinned(true);
  assert.equal(vi.getTimerCount(), 0);
  presentation.update([{ text: "new completed result", status: "completed" }], DEFAULT_PROGRESS_SETTINGS);
  await vi.advanceTimersByTimeAsync(10_000);
  assert.ok(current.renderWidget().length > 0);
  presentation.view.setPinned(false);
  await vi.advanceTimersByTimeAsync(2_999);
  assert.ok(current.renderWidget().length > 0);
  await vi.advanceTimersByTimeAsync(1);
  assert.deepEqual(current.renderWidget(), []);
  presentation.dispose();
});

test("changed completion restarts retention; blocked replacement cancels it", async () => {
  vi.useFakeTimers();
  const { current, presentation } = setup();
  presentation.update(complete, DEFAULT_PROGRESS_SETTINGS, true);
  await vi.advanceTimersByTimeAsync(2_999);
  presentation.update([...complete, { text: "also done", status: "completed" }], DEFAULT_PROGRESS_SETTINGS);
  await vi.advanceTimersByTimeAsync(2_999);
  assert.match(current.renderWidget().join("\n"), /2\/2 steps completed/u);
  presentation.update([{ text: "approval needed", status: "blocked" }], DEFAULT_PROGRESS_SETTINGS);
  assert.equal(vi.getTimerCount(), 0);
  await vi.advanceTimersByTimeAsync(3_000);
  assert.match(current.renderWidget().join("\n"), /approval needed/u);
  presentation.dispose();
});

test("manual hidden is sticky; clear reappears even on an identical tool update", async () => {
  const { current, presentation } = setup();
  presentation.show("hidden");
  presentation.showOnUpdate();
  presentation.update(pending, DEFAULT_PROGRESS_SETTINGS);
  presentation.update([{ text: "new", status: "pending" }], DEFAULT_PROGRESS_SETTINGS);
  assert.deepEqual(current.renderWidget(), []);
  presentation.show("expanded");
  assert.match(current.renderWidget().join("\n"), /○ new/u);
  presentation.clear();
  presentation.showOnUpdate();
  presentation.update([{ text: "new", status: "pending" }], DEFAULT_PROGRESS_SETTINGS);
  assert.match(current.renderWidget().join("\n"), /○ new/u);
  presentation.show("compact");
  assert.equal(current.renderWidget().length, 2);
  assert.doesNotMatch(current.renderWidget().join("\n"), /○ new/u);
  presentation.update(pending, { ...DEFAULT_PROGRESS_SETTINGS, enabled: false });
  presentation.show("expanded");
  presentation.view.setPinned(true);
  assert.deepEqual(current.renderWidget(), []);
  presentation.dispose();
});

test("raw text and duplicate occurrence identities preserve independent item choices", () => {
  const { current, presentation } = setup();
  const steps: ProgressStep[] = [
    { text: "same", status: "pending" },
    { text: "same", status: "blocked" },
    { text: "same\u001b[0m", status: "pending" },
  ];
  presentation.update(steps, DEFAULT_PROGRESS_SETTINGS);
  const before = structuredClone(steps);
  const [one, two, raw] = presentation.items();
  assert.ok(one && two && raw);
  assert.equal(new Set([one.id, two.id, raw.id]).size, 3);
  assert.deepEqual(
    progressDisplayItems(steps).map(({ id }) => JSON.parse(id)),
    [
      ["same", 0],
      ["same", 1],
      ["same\u001b[0m", 0],
    ],
  );
  const handle = presentation.item(one.id);
  assert.equal(handle?.compact(), true);
  assert.equal(presentation.item(two.id)?.remove(), true);
  presentation.refresh();
  assert.equal(presentation.items()[0]?.mode, "compact");
  assert.equal(presentation.items().length, 2);
  assert.match(current.renderWidget().join("\n"), /1 blocked.*1 hidden/u);
  // Status changes preserve view choices, but invalidate a revision-bound handle.
  presentation.update([{ text: "same", status: "completed" }, ...steps.slice(1)], DEFAULT_PROGRESS_SETTINGS);
  assert.equal(handle?.remove(), false);
  assert.equal(presentation.items()[0]?.mode, "compact");
  assert.equal(presentation.items().length, 2);
  presentation.update([], DEFAULT_PROGRESS_SETTINGS);
  assert.deepEqual(current.renderWidget(), []);
  presentation.update(steps, DEFAULT_PROGRESS_SETTINGS);
  assert.equal(presentation.items().length, 3, "absence permits reintroduction");
  assert.equal(handle?.compact(), false, "old incarnation cannot affect reused ID");
  const resetHandle = presentation.item(one.id);
  presentation.show("hidden");
  presentation.view.setPinned(true);
  presentation.view.setTrigger("user-message");
  presentation.reset(steps);
  assert.equal(resetHandle?.remove(), false);
  assert.equal(presentation.view.mode, "default");
  assert.equal(presentation.view.pinned, false);
  assert.equal(presentation.view.trigger, "manual");
  assert.deepEqual(steps, before);
  presentation.dispose();
});

test("collection rejection is atomic and uses exactly the existing grapheme bounds", () => {
  const { presentation, current } = setup();
  const longCluster = `e${"\u0301".repeat(2_000)}`;
  const accepted: ProgressStep[] = [{ text: longCluster.repeat(MAX_PROGRESS_TEXT_LENGTH), status: "pending" }];
  presentation.update(accepted, DEFAULT_PROGRESS_SETTINGS);
  const previous = presentation.items();
  assert.throws(
    () =>
      presentation.update(
        Array.from({ length: MAX_PROGRESS_STEPS + 1 }, () => ({ text: "work", status: "pending" as const })),
        { ...DEFAULT_PROGRESS_SETTINGS, enabled: false },
      ),
    /maxItems/u,
  );
  assert.deepEqual(presentation.items(), previous);
  presentation.refresh();
  assert.ok(current.renderWidget().length > 0, "rejected replacement cannot change effective settings");
  assert.throws(
    () =>
      presentation.update(
        [{ text: "a".repeat(MAX_PROGRESS_TEXT_LENGTH + 1), status: "pending" }],
        DEFAULT_PROGRESS_SETTINGS,
      ),
    /limit/u,
  );
  assert.deepEqual(presentation.items(), previous);
  assert.ok(current.renderWidget().length > 0);
  presentation.dispose();
});

test("old timers, host disposals, and handles cannot change a newer same-manager generation", () => {
  const current = createContext();
  const callbacks: Array<() => void> = [];
  let generation = 0;
  const make = () => {
    const own = ++generation;
    return createProgressPresentation({
      context: current.ctx,
      isCurrent: () => generation === own,
      settings: DEFAULT_PROGRESS_SETTINGS,
      setTimeout: ((callback: () => void) => {
        callbacks.push(callback);
        return callbacks.length;
      }) as unknown as typeof setTimeout,
      clearTimeout: (() => {}) as typeof clearTimeout,
    });
  };
  const old = make();
  old.reset(pending);
  const oldComponent = current.component;
  const oldItem = old.items()[0];
  assert.ok(oldItem);
  const oldHandle = old.item(oldItem.id);
  old.update(complete, DEFAULT_PROGRESS_SETTINGS, true);
  old.dispose();
  const next = make();
  next.reset(pending);
  const count = current.widgets.length;
  for (const callback of callbacks) callback();
  oldComponent?.dispose?.();
  old.refresh();
  old.dispose();
  assert.equal(oldHandle?.remove(), false);
  assert.equal(current.widgets.length, count);
  assert.match(current.renderWidget().join("\n"), /○ work/u);
  next.dispose();
});

test("host disposal remounts only on the next publication; callback theme remains current", () => {
  const { current, presentation } = setup();
  const original = current.component;
  const calls: string[] = [];
  const nextTheme = identityTheme().theme;
  nextTheme.fg = (role, value) => {
    calls.push(role);
    return value;
  };
  current.setTheme(nextTheme);
  original?.invalidate();
  current.renderWidget();
  assert.ok(calls.includes("borderMuted"));
  original?.dispose?.();
  assert.deepEqual(original?.render(80), []);
  const count = current.widgets.length;
  presentation.refresh();
  assert.equal(current.widgets.length, count + 1);
  original?.dispose?.();
  assert.match(current.renderWidget().join("\n"), /work/u);
  presentation.dispose();
});

for (const mode of ["print", "json"] as const) {
  test(`${mode} acquires no UI resources or completion timers`, () => {
    vi.useFakeTimers();
    const { current, presentation } = setup(mode);
    presentation.update(complete, DEFAULT_PROGRESS_SETTINGS, true);
    presentation.view.setPinned(true);
    presentation.view.setPinned(false);
    presentation.dispose();
    assert.deepEqual(current.widgets, []);
    assert.equal(vi.getTimerCount(), 0);
  });
}

test("an obsolete canceled timer cannot expire an updated or unpinned result", () => {
  const current = createContext();
  const callbacks: Array<() => void> = [];
  const presentation = createProgressPresentation({
    context: current.ctx,
    isCurrent: () => true,
    settings: DEFAULT_PROGRESS_SETTINGS,
    setTimeout: ((callback: () => void) => {
      callbacks.push(callback);
      return callbacks.length;
    }) as unknown as typeof setTimeout,
    clearTimeout: (() => {}) as typeof clearTimeout,
  });
  presentation.reset(pending);
  presentation.update(complete, DEFAULT_PROGRESS_SETTINGS, true);
  presentation.update([...complete, { text: "also done", status: "completed" }], DEFAULT_PROGRESS_SETTINGS);
  presentation.view.setPinned(true);
  presentation.view.setPinned(false);
  assert.equal(callbacks.length, 3);
  callbacks[0]?.();
  callbacks[1]?.();
  assert.match(current.renderWidget().join("\n"), /2\/2 steps completed/u);
  callbacks[2]?.();
  assert.deepEqual(current.renderWidget(), []);
  presentation.dispose();
});

test("same-manager replacement rejects an old asynchronous settings continuation", async () => {
  let resolve!: (result: ProgressSettingsLoadResult) => void;
  let loads = 0;
  const harness = createHarness({
    loadSettings: async () => {
      if (++loads === 1)
        return new Promise((done) => {
          resolve = done;
        });
      return { kind: "missing", path: "/tmp/pi-progress.json", settings: { ...DEFAULT_PROGRESS_SETTINGS } };
    },
  });
  const current = createContext();
  const previous = harness.emit("session_start", current.ctx);
  await harness.emit("session_start", current.ctx);
  await setProgress(harness, current.ctx, pending);
  const mounted = current.component;
  const publications = current.widgets.length;
  resolve({
    kind: "loaded",
    path: "/tmp/pi-progress.json",
    settings: { ...DEFAULT_PROGRESS_SETTINGS, enabled: false },
  });
  await previous;
  assert.equal(current.component, mounted);
  assert.equal(current.widgets.length, publications);
  assert.match(current.renderWidget().join("\n"), /work/u);
  await harness.emit("session_shutdown", current.ctx);
});

for (const rows of [0, 1, 2, 3, 4, 8, 12, 36, 100, Number.NaN, Number.POSITIVE_INFINITY]) {
  test(`publisher bounds all views at terminal height ${rows}`, () => {
    vi.useFakeTimers();
    const { current, presentation } = setup();
    current.setRows(rows);
    presentation.update(
      Array.from({ length: 20 }, (_, index) => ({
        text: `界 👩‍💻 ${index} long text wrapping across lines`,
        status: index === 0 ? "blocked" : "pending",
      })),
      DEFAULT_PROGRESS_SETTINGS,
    );
    for (const mode of ["default", "expanded", "compact", "hidden"] as const) {
      presentation.show(mode);
      for (const width of [0, 1, 2, 10, 80]) {
        const lines = current.renderWidget(width);
        assert.ok(lines.length <= (Number.isFinite(rows) ? rows : 12));
        if (rows < 2 || mode === "hidden") assert.deepEqual(lines, []);
        for (const line of lines) assert.ok(visibleWidth(line) <= width);
      }
    }
    presentation.show("default");
    presentation.update(complete, DEFAULT_PROGRESS_SETTINGS, true);
    assert.equal(current.renderWidget().length, rows < 2 ? 0 : 2);
    presentation.dispose();
  });
}

test("bounded detail reserves truthful overflow counts without marking whole rows as truncated", () => {
  const steps: ProgressStep[] = [
    { text: "pending one", status: "pending" },
    { text: "pending two", status: "pending" },
    { text: "approval", status: "blocked" },
    { text: "active", status: "in_progress" },
  ];
  const lines = renderProgressWidget(steps, identityTheme().theme, 80, { maxRows: 5, viewMode: "expanded" });
  assert.deepEqual(lines.slice(2), ["▶ active", "⚠ approval", "… 2 hidden or omitted"]);
  assert.match(lines[1] ?? "", /1 blocked.*2 hidden/u);
  const summary = renderProgressWidget(steps, identityTheme().theme, 80, { maxRows: 2, viewMode: "expanded" });
  assert.match(summary[1] ?? "", /1 blocked.*4 hidden/u);
});

for (const maxRows of [0, 1, 2, 3, 4, 12, Number.NaN, Number.POSITIVE_INFINITY]) {
  test(`direct non-interactive rendering bounds rows including separator: ${maxRows}`, () => {
    const steps: ProgressStep[] = [
      { text: "pending ".repeat(30), status: "pending" },
      { text: "approval", status: "blocked" },
      { text: "active", status: "in_progress" },
    ];
    const lines = renderProgressWidget(steps, identityTheme().theme, 80, { maxRows, viewMode: "expanded" });
    assert.ok(lines.length <= (Number.isFinite(maxRows) ? maxRows : 12));
    if (maxRows >= 2 || !Number.isFinite(maxRows)) assert.match(lines.join("\n"), /1 blocked|⚠ approval/u);
    for (const line of lines) assert.ok(visibleWidth(line) <= 80);
  });
}
