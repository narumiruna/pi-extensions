import assert from "node:assert/strict";
import { type Component, type TuiMouseEvent, visibleWidth } from "@earendil-works/pi-tui";
import { HorizontalRule } from "@narumitw/pi-tui-kit";
import { test, vi } from "vitest";
import { createMockContext } from "../../../test/support.js";
import type { StartupObservation, SyncInspection } from "../src/sync/sync-inspection.js";
import {
  classifyObservation,
  createSyncAttentionController,
  observationNeedsAttention,
  observationSummary,
} from "../src/ui/sync-attention.js";
import { configureSyncStatus } from "../src/ui/sync-status.js";

const divider = (width: number, collapsed = false) =>
  new HorizontalRule({
    label: `${collapsed ? "▸" : "▾"} Sync · Needs review`,
    labelAlignment: "left",
  }).render(width)[0];

test("attention presentation is sanitized, textual, bounded, and clearable", async () => {
  const controller = createSyncAttentionController();
  const { ctx, statuses, widgets } = createMockContext({ hasUI: true, mode: "tui" });
  controller.set(
    {
      setupName: "home\u001b]8;;spoof",
      configIdentity: "identity",
      localInclude: ["settings.json", "AGENTS.md"],
      remoteInclude: ["settings.json", "models.json"],
    },
    "sync",
  );

  await controller.publish(ctx);

  assert.equal(statuses.get("sync"), "sync ⇕");
  const factory = widgets.get("sync:attention");
  assert.equal(typeof factory, "function");
  const themeCalls: string[] = [];
  const component = (
    factory as (tui: unknown, theme: { fg(color: string, text: string): string }) => { render(width: number): string[] }
  )(
    {},
    {
      fg: (color, text) => {
        themeCalls.push(color);
        return text;
      },
    },
  );
  for (const width of [0, 1, 2, 32, 60, 100, -1, Number.NaN, Number.POSITIVE_INFINITY, 0.9, 32.9]) {
    const normalized = Number.isFinite(width) ? Math.max(0, Math.floor(width)) : 0;
    const lines = component.render(width);
    assert.equal(lines[0], divider(normalized));
    assert.equal(themeCalls.includes("borderMuted"), normalized > 2);
    themeCalls.length = 0;
    assert.equal(lines.length, 4);
    assert.ok(lines.every((line) => visibleWidth(line) <= normalized));
    assert.equal(lines.join("\n").includes("\u001b]8"), false);
    if (normalized === 0) assert.deepEqual(lines, ["", "", "", ""]);
  }
  assert.deepEqual(component.render(100), [
    divider(100),
    "Setup: home?]8;;spoof",
    "Selection: 1 remote-only · 1 device-only",
    "No transfer performed · Run /sync to review",
  ]);
  assert.equal(controller.current()?.decision.setupName, "home\u001b]8;;spoof");

  controller.clear(ctx);
  assert.equal(statuses.get("sync"), undefined);
  assert.equal(widgets.get("sync:attention"), undefined);
});

function clickWidget(component: Component, event: TuiMouseEvent) {
  component.handleMouse?.({ ...event, type: "press" });
  component.handleMouse?.({ ...event, type: "release" });
  return component.handleMouse?.({ ...event, type: "click" });
}

test("blank-column body clicks retain collapse through attention updates and reset with the owner", async () => {
  const controller = createSyncAttentionController();
  const { ctx, widgets } = createMockContext({ mode: "tui" });
  const mount = () => {
    const factory = widgets.get("sync:attention") as (tui: unknown, theme: unknown) => Component & { dispose?(): void };
    return factory({}, { fg: (_role: string, text: string) => text });
  };
  controller.observe(observation({ localChanged: true, remoteChanged: true }));
  await controller.publish(ctx);
  const first = mount();
  const lines = first.render(100);
  const event: TuiMouseEvent = {
    type: "press",
    button: "left",
    x: 99,
    y: lines.length - 1,
    screenX: 99,
    screenY: lines.length - 1,
    width: 100,
    height: lines.length,
    shift: false,
    alt: false,
    ctrl: false,
  };
  assert.deepEqual(clickWidget(first, event), { handled: true, render: true });
  assert.deepEqual(first.render(100), [divider(100, true)]);
  first.dispose?.();
  assert.equal(clickWidget(first, { ...event, y: 0, screenY: 0, height: 1 }), undefined);
  const latest = observation({ head: undefined, localChanged: false, remoteChanged: false });
  controller.observe(latest);
  await controller.publish(ctx);
  const updated = mount();
  assert.deepEqual(updated.render(100), [divider(100, true)]);
  const collapsed = { ...event, y: 0, screenY: 0, height: updated.render(100).length };
  assert.deepEqual(clickWidget(updated, collapsed), { handled: true, render: true });
  assert.deepEqual(updated.render(100), [
    divider(100),
    "Setup: home?]8;;spoof",
    "Remote snapshot missing; review needed",
    "No transfer performed · Run /sync to review",
  ]);
  clickWidget(updated, { ...collapsed, height: updated.render(100).length });
  controller.clear(ctx);
  await controller.publish(ctx);
  assert.equal(mount().render(100).length, 1, "temporary presentation clearing keeps owner state");
  controller.expand();
  await controller.publish(ctx);
  const expanded = mount();
  assert.ok(expanded.render(100).length > 1);
  clickWidget(expanded, { ...collapsed, height: expanded.render(100).length });
  controller.reset(ctx);
  controller.observe(latest);
  await controller.publish(ctx);
  assert.ok(mount().render(100).length > 1, "owner reset starts expanded");
  controller.reset(ctx);
});

test("the existing /sync menu route expands retained attention after closing", async () => {
  const manager = await import("../src/ui/manager-ui.js");
  const show = vi.spyOn(manager, "showSyncManager").mockResolvedValue(undefined);
  const { handleCommand } = await import("../src/commands/command-handler.js");
  const controller = createSyncAttentionController();
  const { ctx, widgets } = createMockContext({ mode: "tui" });
  controller.set({ setupName: "home", configIdentity: "identity", localInclude: [], remoteInclude: [] }, "sync");
  const mount = () => {
    const factory = widgets.get("sync:attention") as (tui: unknown, theme: unknown) => Component;
    return factory({}, { fg: (_role: string, text: string) => text });
  };
  try {
    await controller.publish(ctx);
    const component = mount();
    const height = component.render(80).length;
    clickWidget(component, {
      type: "press",
      button: "left",
      x: 79,
      y: 0,
      screenX: 79,
      screenY: 0,
      width: 80,
      height,
      shift: false,
      alt: false,
      ctrl: false,
    });
    assert.equal(component.render(80).length, 1);
    await handleCommand("", ctx, new AbortController().signal, {} as never, controller);
    assert.equal(show.mock.calls.length, 1);
    assert.ok(mount().render(80).length > 1);
  } finally {
    show.mockRestore();
    controller.reset(ctx);
  }
});

test("disabled status preserves the TUI review widget", async () => {
  const controller = createSyncAttentionController();
  const { ctx, statuses, widgets } = createMockContext({ hasUI: true, mode: "tui" });
  configureSyncStatus(ctx, false);
  controller.observe(observation({ localChanged: true, remoteChanged: true }));

  await controller.publish(ctx);

  assert.equal(statuses.get("sync"), undefined);
  assert.equal(typeof widgets.get("sync:attention"), "function");
});

test("attention presentation explains an order-only difference", async () => {
  const controller = createSyncAttentionController();
  const { ctx, widgets } = createMockContext({ hasUI: true, mode: "tui" });
  controller.set(
    {
      setupName: "home",
      configIdentity: "identity",
      localInclude: ["settings.json", "AGENTS.md"],
      remoteInclude: ["AGENTS.md", "settings.json"],
    },
    "sync",
  );
  await controller.publish(ctx);
  const factory = widgets.get("sync:attention") as (
    tui: unknown,
    theme: { fg(color: string, text: string): string },
  ) => { render(width: number): string[] };
  const component = factory({}, { fg: (_color, text) => text });
  assert.deepEqual(component.render(60), [
    divider(60),
    "Setup: home",
    "Selection: only list order differs",
    "No transfer performed · Run /sync to review",
  ]);
});

test.each(["rpc", "print", "json"] as const)("keeps explicit review publication unchanged in %s", async (mode) => {
  const controller = createSyncAttentionController();
  const { ctx, widgets, statuses, notifications } = createMockContext({ mode });
  controller.set(
    {
      setupName: "home",
      configIdentity: "identity",
      localInclude: ["settings.json"],
      remoteInclude: ["AGENTS.md"],
    },
    "sync",
  );
  await controller.publish(ctx);
  assert.equal(widgets.get("sync:attention"), undefined);
  assert.equal(statuses.get("sync"), mode === "rpc" ? "sync ⇕" : undefined);
  assert.deepEqual(notifications, []);
  controller.reset(ctx);
});

for (const action of ["clear", "reset", "abort"] as const) {
  test(`pending widget publication cannot survive ${action}`, async () => {
    const controller = createSyncAttentionController();
    const { ctx, widgets } = createMockContext({ hasUI: true, mode: "tui" });
    const abort = new AbortController();
    controller.set(
      {
        setupName: "home",
        configIdentity: "identity",
        localInclude: ["settings.json"],
        remoteInclude: ["AGENTS.md"],
      },
      "sync",
    );
    const pending = controller.publish(ctx, abort.signal);
    if (action === "abort") abort.abort();
    else controller[action](ctx);
    await pending;
    assert.equal(widgets.get("sync:attention"), undefined);
  });
}

function observation(overrides: Partial<SyncInspection> = {}): StartupObservation {
  return {
    setupName: "home\u001b]8;;spoof",
    configIdentity: "identity",
    checkedAt: "2026-09-08T00:00:00.000Z",
    inspection: {
      head: {
        snapshotRef: "snapshot",
        snapshotId: "snapshot",
        revision: "revision",
        createdAt: "2026-09-08T00:00:00.000Z",
        machine: "test",
        syncSessions: false,
      },
      selectionState: { kind: "same", include: ["settings.json"] },
      localFiles: 1,
      localChanged: false,
      remoteChanged: false,
      firstSync: false,
      emptyInclude: false,
      stateIdentity: "baseline",
      destination: "test",
      capability: "lease-protected",
      ...overrides,
    },
  };
}

const observationPresentations: Array<{
  inspection: Partial<SyncInspection>;
  automaticTransfer?: boolean;
  reason: string;
  widgetReason?: string;
}> = [
  {
    inspection: { localChanged: true, remoteChanged: true },
    reason: "Local and remote changed since last sync; review needed",
  },
  {
    inspection: { head: undefined },
    reason: "Remote snapshot missing; review needed",
  },
  {
    inspection: { firstSync: true },
    reason: "No sync baseline; review remote and local content",
  },
  {
    inspection: { selectionState: { kind: "legacy", discovered: [] } },
    automaticTransfer: true,
    reason:
      "Legacy remote has no authoritative content list; review /sync and choose an explicit direction to adopt policy",
  },
  {
    inspection: {
      selectionState: {
        kind: "different",
        include: ["AGENTS.md"],
        remoteOnly: ["AGENTS.md"],
        localOnly: ["settings.json"],
      },
    },
    reason: "Synced-content list differs; review needed",
    widgetReason: "Selection: 1 remote-only · 1 device-only",
  },
  {
    inspection: {
      selectionState: {
        kind: "different",
        include: ["AGENTS.md", "settings.json"],
        remoteOnly: [],
        localOnly: [],
      },
    },
    reason: "Synced-content list differs; review needed",
    widgetReason: "Selection: only list order differs",
  },
];

test.each(observationPresentations)("separates named review from unchanged notifications: $reason", async (entry) => {
  for (const mode of ["tui", "rpc"] as const) {
    const controller = createSyncAttentionController();
    const { ctx, widgets, notifications, statuses } = createMockContext({ mode });
    const value = observation(entry.inspection);
    value.setupName = "home";
    value.automaticTransfer = entry.automaticTransfer;
    const before = structuredClone(value);
    controller.observe(value);
    await controller.publish(ctx);
    controller.notifyObservation(ctx);
    assert.equal(statuses.get("sync"), "sync ⇕");
    assert.deepEqual(notifications, [
      { message: `Pi Sync check · home\n${entry.reason}\nNo startup transfer · Run /sync to review`, level: "warning" },
    ]);
    const factory = widgets.get("sync:attention");
    if (mode === "tui") {
      const component = (factory as (tui: unknown, theme: unknown) => Component & { dispose?(): void })(
        {},
        { fg: (_role: string, text: string) => text },
      );
      const lines = [
        divider(160),
        "Setup: home",
        entry.widgetReason ?? entry.reason,
        "No transfer performed · Run /sync to review",
      ];
      assert.deepEqual(component.render(160), lines);
      component.invalidate();
      assert.deepEqual(component.render(160), lines);
      component.dispose?.();
    } else {
      assert.equal(factory, undefined);
    }
    assert.deepEqual(value, before);
    controller.reset(ctx);
  }
});

// Every head/selection class, crossed with baseline and change flags, proves precedence
// even for defensive combinations that today's inspector does not produce.
for (const selection of ["absent", "same", "legacy", "order", "scope"] as const) {
  for (const firstSync of [false, true]) {
    for (const emptyInclude of [false, true]) {
      for (const localChanged of [false, true]) {
        for (const remoteChanged of [false, true]) {
          test(`classification ${selection} first=${firstSync} empty=${emptyInclude} local=${localChanged} remote=${remoteChanged}`, async () => {
            const value = observation({ firstSync, emptyInclude, localChanged, remoteChanged });
            if (selection === "absent") {
              value.inspection.head = undefined;
              value.inspection.selectionState = undefined;
            } else if (selection === "legacy") {
              value.inspection.selectionState = { kind: "legacy", discovered: [] };
            } else if (selection === "order" || selection === "scope") {
              value.inspection.selectionState = {
                kind: "different",
                include: ["AGENTS.md", "settings.json"],
                remoteOnly: selection === "scope" ? ["AGENTS.md"] : [],
                localOnly: [],
              };
            }
            const expected = emptyInclude
              ? "guidance"
              : selection === "order" || selection === "scope"
                ? "review"
                : firstSync
                  ? selection === "absent"
                    ? "guidance"
                    : "review"
                  : selection === "absent" || (localChanged && remoteChanged)
                    ? "review"
                    : localChanged || remoteChanged
                      ? "status"
                      : "none";
            assert.equal(classifyObservation(value), expected);
            assert.equal(observationNeedsAttention(value), expected === "review");
            const before = structuredClone(value);
            const controller = createSyncAttentionController();
            const { ctx, statuses, widgets, notifications } = createMockContext({ mode: "tui" });
            controller.observe(value);
            await controller.publish(ctx);
            controller.notifyObservation(ctx);
            assert.equal(typeof widgets.get("sync:attention"), expected === "review" ? "function" : "undefined");
            assert.equal(
              statuses.get("sync"),
              expected === "review"
                ? "sync ⇕"
                : expected === "status"
                  ? remoteChanged
                    ? "sync ⇣"
                    : "sync ⇡"
                  : undefined,
            );
            assert.equal(notifications.length, expected === "review" ? 1 : 0);
            assert.equal(controller.observation(), value);
            assert.deepEqual(value, before);
          });
        }
      }
    }
  }
}

for (const inspection of [
  {},
  { emptyInclude: true },
  { firstSync: true, head: undefined, selectionState: undefined },
  { localChanged: true },
  { localChanged: true, remoteChanged: true },
]) {
  test(`explicit selection decision overrides observation ${JSON.stringify(inspection)}`, async () => {
    const controller = createSyncAttentionController();
    const { ctx, statuses, widgets } = createMockContext({ mode: "tui" });
    const value = observation(inspection);
    controller.observe(value);
    controller.set(
      {
        setupName: "home",
        configIdentity: "test",
        localInclude: ["settings.json"],
        remoteInclude: ["AGENTS.md"],
      },
      "sync",
    );
    await controller.publish(ctx);
    assert.equal(statuses.get("sync"), "sync ⇕");
    assert.equal(typeof widgets.get("sync:attention"), "function");
    assert.equal(controller.markOffered(), true);
    assert.equal(controller.markOffered(), false);
    controller.clear(ctx);
    assert.equal(controller.observation(), value);
    await controller.publish(ctx);
    assert.equal(
      typeof widgets.get("sync:attention"),
      classifyObservation(value) === "review" ? "function" : "undefined",
    );
  });
}

for (const mode of ["tui", "rpc", "print", "json"] as const) {
  test(`${mode} review downgrades to status then quiet without deleting observations or unrelated UI`, async () => {
    const controller = createSyncAttentionController();
    const { ctx, statuses, widgets, notifications } = createMockContext({ mode });
    statuses.set("other", "keep");
    widgets.set("other", ["keep"]);
    for (const changes of [
      { localChanged: true, remoteChanged: true },
      { localChanged: true, remoteChanged: false },
      { localChanged: false, remoteChanged: true },
      { localChanged: false, remoteChanged: false },
    ]) {
      const value = observation(changes);
      controller.observe(value);
      await controller.publish(ctx);
      controller.notifyObservation(ctx);
      const review = changes.localChanged && changes.remoteChanged;
      assert.equal(typeof widgets.get("sync:attention"), mode === "tui" && review ? "function" : "undefined");
      assert.equal(
        statuses.get("sync"),
        mode === "print" || mode === "json"
          ? undefined
          : review
            ? "sync ⇕"
            : changes.remoteChanged
              ? "sync ⇣"
              : changes.localChanged
                ? "sync ⇡"
                : undefined,
      );
      assert.equal(controller.observation(), value);
    }
    assert.equal(notifications.length, mode === "tui" || mode === "rpc" ? 1 : 0);
    assert.ok(notifications.every((n) => n.level === "warning" && !n.message.includes("\u001b")));
    controller.reset(ctx);
    controller.reset(ctx);
    assert.equal(statuses.get("other"), "keep");
    assert.deepEqual(widgets.get("other"), ["keep"]);
    assert.equal(controller.observation(), undefined);
  });
}

for (const next of ["status", "none", "guidance", "reset", "abort"] as const) {
  test(`delayed review import cannot restore obsolete UI after ${next}`, async () => {
    const controller = createSyncAttentionController();
    const { ctx, statuses, widgets } = createMockContext({ mode: "tui" });
    const signal = new AbortController();
    controller.observe(observation({ localChanged: true, remoteChanged: true }));
    const pending = controller.publish(ctx, signal.signal);
    if (next === "reset") controller.reset(ctx);
    else if (next === "abort") signal.abort();
    else {
      controller.observe(observation({ localChanged: next === "status", emptyInclude: next === "guidance" }));
      await controller.publish(ctx);
    }
    await pending;
    assert.equal(widgets.get("sync:attention"), undefined);
    assert.equal(statuses.get("sync"), next === "status" ? "sync ⇡" : undefined);
  });
}

for (const stale of [false, true]) {
  test(`failed widget import stale=${stale} clears only its current presentation`, async () => {
    let release!: () => void;
    let entered!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const loading = new Promise<void>((resolve) => {
      entered = resolve;
    });
    vi.doMock("../src/ui/attention-widget.js", async () => {
      entered();
      await pending;
      throw new Error("widget load failed");
    });
    const controller = createSyncAttentionController();
    const { ctx, statuses, widgets } = createMockContext({ mode: "tui" });
    statuses.set("sync", "old review");
    widgets.set("sync:attention", ["old review"]);
    controller.observe(observation({ localChanged: true, remoteChanged: true }));
    const publishing = controller.publish(ctx);
    const rejected = assert.rejects(publishing, (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.ok(error.cause instanceof Error);
      assert.equal(error.cause.message, "widget load failed");
      return true;
    });
    try {
      await loading;
      if (stale) {
        controller.observe(observation({ localChanged: true }));
        await controller.publish(ctx);
      }
      release();
      await rejected;
      assert.equal(widgets.get("sync:attention"), undefined);
      assert.equal(statuses.get("sync"), stale ? "sync ⇡" : undefined);
    } finally {
      release();
      await rejected;
      vi.doUnmock("../src/ui/attention-widget.js");
    }
  });
}

test("manager summaries retain quiet setup, initialization, and legacy guidance", () => {
  assert.equal(observationSummary(observation({ emptyInclude: true })), "No included content selected");
  assert.equal(
    observationSummary(observation({ firstSync: true, head: undefined, selectionState: undefined })),
    "Remote empty; no sync baseline",
  );
  assert.equal(
    observationSummary(observation({ selectionState: { kind: "legacy", discovered: [] } })),
    "Legacy remote has no authoritative content list",
  );
});
