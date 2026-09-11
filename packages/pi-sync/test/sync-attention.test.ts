import assert from "node:assert/strict";
import { visibleWidth } from "@earendil-works/pi-tui";
import { test, vi } from "vitest";
import { createMockContext } from "../../../test/support.js";
import type { StartupObservation, SyncInspection } from "../src/sync/sync-inspection.js";
import {
  classifyObservation,
  createSyncAttentionController,
  observationNeedsAttention,
  observationSummary,
} from "../src/ui/sync-attention.js";

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

  assert.equal(statuses.get("sync"), "review needed");
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
  for (const width of [0, 1, 2, 32, 60, 100]) {
    const lines = component.render(width);
    assert.equal(lines[0], "─".repeat(width));
    assert.equal(themeCalls.includes("borderMuted"), width > 0);
    themeCalls.length = 0;
    assert.equal(lines.length, 4);
    assert.ok(lines.every((line) => visibleWidth(line) <= width));
    assert.equal(lines.join("\n").includes("\u001b]8"), false);
    if (width >= 32) {
      assert.match(lines.join("\n"), /Remote 1 · Device 1/u);
      assert.match(lines.join("\n"), /No changes/u);
    }
  }

  controller.clear(ctx);
  assert.equal(statuses.get("sync"), undefined);
  assert.equal(widgets.get("sync:attention"), undefined);
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
  assert.match(component.render(60).join("\n"), /Only list order differs/u);
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
                ? "changes to review"
                : expected === "status"
                  ? remoteChanged
                    ? "remote changes pending"
                    : "local changes pending"
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
    assert.equal(statuses.get("sync"), "review needed");
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
            ? "changes to review"
            : changes.remoteChanged
              ? "remote changes pending"
              : changes.localChanged
                ? "local changes pending"
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
    assert.equal(statuses.get("sync"), next === "status" ? "local changes pending" : undefined);
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
      assert.equal(statuses.get("sync"), stale ? "local changes pending" : undefined);
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
