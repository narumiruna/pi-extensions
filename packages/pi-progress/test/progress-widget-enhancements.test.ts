import assert from "node:assert/strict";
import type { ContextEvent } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { test, vi } from "vitest";
import {
  COMPLETION_SUMMARY_MS,
  PROGRESS_DETAILS_VERSION,
  type ProgressStep,
  renderProgressWidget,
  WIDGET_KEY,
} from "../src/progress-widget.js";
import { DEFAULT_PROGRESS_SETTINGS, type ProgressSettingsLoadResult } from "../src/settings.js";
import {
  createContext,
  createHarness,
  identityTheme,
  loadedSettings,
  setProgress,
  toolResultEntry,
} from "./progress-harness.js";

function customText(message: ContextEvent["messages"][number] | undefined): string {
  return message?.role === "custom" && typeof message.content === "string" ? message.content : "";
}

test("adapts widget rows, prioritizes active work, and honors display settings", async () => {
  const { theme } = identityTheme();
  const steps: ProgressStep[] = [
    { text: "finished", status: "completed" },
    { text: "current", status: "in_progress" },
    { text: "next", status: "pending" },
    { text: "later", status: "pending" },
  ];
  assert.deepEqual(renderProgressWidget(steps, theme, 40, { terminalRows: 12 }), [
    "─".repeat(40),
    "Progress · 1/4 complete",
    "▶ current",
    "✓ 1 completed · … 2 more",
  ]);
  assert.deepEqual(
    renderProgressWidget(steps, theme, 40, {
      terminalRows: 12,
      settings: {
        enabled: true,
        displayMode: "expanded",
        showCompleted: false,
        maxVisibleItems: 2,
        showProgress: false,
      },
    }),
    ["─".repeat(40), "Progress", "▶ current", "○ next", "… 1 more"],
  );

  const long: ProgressStep[] = [
    { text: "alpha beta gamma delta epsilon", status: "in_progress" },
    { text: "later", status: "pending" },
  ];
  const lines = renderProgressWidget(long, theme, 10, { terminalRows: 12 });
  assert.equal(lines.length, 4);
  assert.match(lines[2] ?? "", /^▶ .*…/u);
  assert.match(lines[3] ?? "", /^… 1 more/u);
  for (const line of lines) assert.ok(visibleWidth(line) <= 10);
});

test("shows a transient completion summary while retaining Progress state", async () => {
  vi.useFakeTimers();
  try {
    const harness = createHarness();
    const current = createContext();
    await harness.emit("session_start", current.ctx);
    await setProgress(harness, current.ctx, [{ text: "finish", status: "in_progress" }]);
    const result = await setProgress(harness, current.ctx, [{ text: "finish", status: "completed" }]);
    assert.deepEqual(result.details.steps, [{ text: "finish", status: "completed" }]);
    const { theme } = identityTheme();
    assert.deepEqual(current.widgets.at(-1)?.content?.(current.tui, theme).render(40), [
      "─".repeat(40),
      "✓ 1/1 steps completed",
    ]);

    await vi.advanceTimersByTimeAsync(COMPLETION_SUMMARY_MS - 1);
    assert.equal(typeof current.widgets.at(-1)?.content, "function");
    await vi.advanceTimersByTimeAsync(1);
    assert.deepEqual(current.widgets.at(-1), { key: WIDGET_KEY, content: undefined, options: undefined });

    const restored = await harness.context(
      [{ role: "compactionSummary", summary: "Earlier work", tokensBefore: 10, timestamp: 0 }],
      current.ctx,
    );
    assert.match(customText(restored[1]), /"status":"completed"/u);
    assert.match(customText(restored[1]), /"text":"finish"/u);
  } finally {
    vi.useRealTimers();
  }
});

test("cancels completion timers on updates, clears, tree changes, replacement, and shutdown", async () => {
  vi.useFakeTimers();
  try {
    const harness = createHarness();
    const previous = createContext();
    await harness.emit("session_start", previous.ctx);
    await setProgress(harness, previous.ctx, [{ text: "old", status: "in_progress" }]);
    await setProgress(harness, previous.ctx, [{ text: "old", status: "completed" }]);
    await setProgress(harness, previous.ctx, [{ text: "replacement", status: "pending" }]);
    await vi.advanceTimersByTimeAsync(COMPLETION_SUMMARY_MS);
    assert.equal(typeof previous.widgets.at(-1)?.content, "function");

    await setProgress(harness, previous.ctx, [{ text: "replacement", status: "completed" }]);
    await setProgress(harness, previous.ctx, []);
    await vi.advanceTimersByTimeAsync(COMPLETION_SUMMARY_MS);
    assert.equal(previous.widgets.at(-1)?.content, undefined);

    previous.branch.push(
      toolResultEntry({ version: PROGRESS_DETAILS_VERSION, steps: [{ text: "tree", status: "completed" }] }),
    );
    await setProgress(harness, previous.ctx, [{ text: "tree", status: "in_progress" }]);
    await setProgress(harness, previous.ctx, [{ text: "tree", status: "completed" }]);
    await harness.emit("session_tree", previous.ctx);
    const countAfterTree = previous.widgets.length;
    await vi.advanceTimersByTimeAsync(COMPLETION_SUMMARY_MS);
    assert.equal(previous.widgets.length, countAfterTree);

    await setProgress(harness, previous.ctx, [{ text: "session", status: "in_progress" }]);
    await setProgress(harness, previous.ctx, [{ text: "session", status: "completed" }]);
    const current = createContext();
    await harness.emit("session_start", current.ctx);
    const previousCount = previous.widgets.length;
    await vi.advanceTimersByTimeAsync(COMPLETION_SUMMARY_MS);
    assert.equal(previous.widgets.length, previousCount);

    await setProgress(harness, current.ctx, [{ text: "shutdown", status: "in_progress" }]);
    await setProgress(harness, current.ctx, [{ text: "shutdown", status: "completed" }]);
    await harness.emit("session_shutdown", current.ctx);
    const currentCount = current.widgets.length;
    await vi.advanceTimersByTimeAsync(COMPLETION_SUMMARY_MS);
    assert.equal(current.widgets.length, currentCount);
  } finally {
    vi.useRealTimers();
  }
});

test("loads display settings and ignores stale asynchronous completion after replacement", async () => {
  const collapsedHarness = createHarness({
    loadSettings: async () =>
      loadedSettings({ displayMode: "collapsed", showCompleted: false, maxVisibleItems: 1, showProgress: false }),
  });
  const collapsed = createContext({ terminalRows: 60 });
  await collapsedHarness.emit("session_start", collapsed.ctx);
  await setProgress(collapsedHarness, collapsed.ctx, [
    { text: "done", status: "completed" },
    { text: "active", status: "in_progress" },
    { text: "later", status: "pending" },
  ]);
  assert.deepEqual(collapsed.widgets.at(-1)?.content?.(collapsed.tui, identityTheme().theme).render(40), [
    "─".repeat(40),
    "Progress",
    "▶ active",
    "… 1 more",
  ]);

  let resolveFirst: ((result: ProgressSettingsLoadResult) => void) | undefined;
  let firstSignal: AbortSignal | undefined;
  let loads = 0;
  const staleHarness = createHarness({
    loadSettings: async (_path, signal) => {
      loads += 1;
      if (loads === 1) {
        firstSignal = signal;
        return await new Promise<ProgressSettingsLoadResult>((resolve) => {
          resolveFirst = resolve;
        });
      }
      return loadedSettings({ showProgress: false });
    },
  });
  const previous = createContext();
  const firstStart = staleHarness.emit("session_start", previous.ctx);
  await vi.waitFor(() => assert.ok(resolveFirst));
  const current = createContext();
  await staleHarness.emit("session_start", current.ctx);
  assert.equal(firstSignal?.aborted, true);
  resolveFirst?.(loadedSettings({ showProgress: true }));
  await firstStart;
  await setProgress(staleHarness, current.ctx, [{ text: "current", status: "pending" }]);
  assert.equal(current.widgets.at(-1)?.content?.(current.tui, identityTheme().theme).render(40)[1], "Progress");
  assert.deepEqual(previous.widgets.at(-1), { key: WIDGET_KEY, content: undefined, options: undefined });
});

test("aborts a pending settings load on shutdown without stale UI", async () => {
  let resolveLoad: ((result: ProgressSettingsLoadResult) => void) | undefined;
  let signal: AbortSignal | undefined;
  const harness = createHarness({
    loadSettings: async (_path, ownerSignal) => {
      signal = ownerSignal;
      return await new Promise<ProgressSettingsLoadResult>((resolve) => {
        resolveLoad = resolve;
      });
    },
  });
  const current = createContext();
  const start = harness.emit("session_start", current.ctx);
  await vi.waitFor(() => assert.ok(resolveLoad));
  await harness.emit("session_shutdown", current.ctx);
  assert.equal(signal?.aborted, true);
  const widgetCount = current.widgets.length;
  resolveLoad?.(loadedSettings({ enabled: true }));
  await start;
  assert.equal(current.widgets.length, widgetCount);
  assert.deepEqual(current.notifications, []);
});

test("warns safely for invalid settings only in supported UI modes", async () => {
  for (const mode of ["tui", "rpc", "print", "json"] as const) {
    const harness = createHarness({
      loadSettings: async () => ({
        kind: "invalid",
        path: "/tmp/unsafe\u001b]8;;x\u0007.json",
        settings: { widget: { ...DEFAULT_PROGRESS_SETTINGS.widget } },
        issue: "bad\u202evalue",
      }),
    });
    const current = createContext({ mode });
    await harness.emit("session_start", current.ctx);
    assert.deepEqual(
      current.notifications.map(({ type }) => type),
      mode === "tui" || mode === "rpc" ? ["warning"] : [],
    );
    if (current.notifications[0]) {
      assert.match(current.notifications[0].message, /Invalid progress settings/u);
      assert.equal(current.notifications[0].message.includes(String.fromCharCode(0x1b)), false);
      assert.equal(current.notifications[0].message.includes(String.fromCodePoint(0x202e)), false);
    }
  }
});
