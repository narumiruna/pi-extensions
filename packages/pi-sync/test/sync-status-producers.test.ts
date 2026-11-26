import assert from "node:assert/strict";
import { createEventBus, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { test } from "vitest";
import { createMockContext } from "../../../test/support.js";
import { createStartupCheck } from "../src/sync/startup-check.js";
import { createSyncLoaders } from "../src/sync/sync-loaders.js";
import { pull, push } from "../src/sync/sync-mutations.js";
import { diff, status } from "../src/sync/sync-queries.js";
import { showRemoteSelectionReview } from "../src/ui/remote-selection-ui.js";
import { createSyncAttentionController } from "../src/ui/sync-attention.js";
import { createSyncStatusPublisher } from "../src/ui/sync-status.js";
import { withTempHome } from "./helpers.js";
import { createMergeFixture, mergeOptions } from "./merged-sync-fixture.js";
import { deferred } from "./startup-check-helpers.js";

function monitor(ctx: ExtensionContext, statuses: ReadonlyMap<string, string | undefined>) {
  const bus = createEventBus();
  const updates: Array<{ value: string | undefined; activity?: string; reason?: string; raw: string | undefined }> = [];
  const stop = bus.on("extension-status:v1:update", (payload) => {
    updates.push({ ...(payload as (typeof updates)[number]), raw: statuses.get("sync") });
  });
  const release = createSyncStatusPublisher(bus).bind(ctx);
  return {
    updates,
    dispose() {
      release();
      stop();
    },
    assertRawFirst() {
      for (const update of updates) {
        if (update.value !== undefined) assert.equal(update.raw, update.value);
      }
    },
  };
}

for (const operation of ["push", "pull", "status", "diff", "remote-selection"] as const) {
  test(`${operation} producer preserves its readable status and supplies its activity`, async () =>
    withTempHome(async (agentDir) => {
      const fixture = await createMergeFixture(agentDir);
      const mock = createMockContext({ mode: "rpc" });
      const observed = monitor(mock.ctx, mock.statuses);
      try {
        if (operation === "push") await push(mock.ctx, mergeOptions, undefined, () => fixture.backend);
        else if (operation === "pull") await pull(mock.ctx, mergeOptions, () => fixture.backend);
        else if (operation === "status") await status(mock.ctx, mergeOptions, () => fixture.backend);
        else if (operation === "diff") await diff(mock.ctx, mergeOptions, () => fixture.backend);
        else await showRemoteSelectionReview(mock.ctx, "home", undefined, () => fixture.backend);
        const activity = operation === "push" ? "pushing" : operation === "pull" ? "pulling" : "checking";
        const value =
          operation === "push"
            ? "pushing home"
            : operation === "pull"
              ? "pulling home"
              : operation === "remote-selection"
                ? "checking synced content for home"
                : "checking home";
        assert.ok(observed.updates.some((update) => update.value === value && update.activity === activity));
        assert.equal(mock.statuses.get("sync"), undefined);
        assert.equal(observed.updates.at(-1)?.value, undefined);
        observed.assertRawFirst();
      } finally {
        observed.dispose();
      }
    }));
}

for (const mode of ["rpc", "tui"] as const) {
  for (const [localChanged, remoteChanged, value, activity] of [
    [true, false, "sync ⇡", "local-change"],
    [false, true, "sync ⇣", "remote-change"],
    [true, true, "sync ⇕", "review"],
    [false, false, undefined, undefined],
  ] as const) {
    test(`${mode} attention local=${localChanged} remote=${remoteChanged} supplies explicit metadata`, async () => {
      const mock = createMockContext({ mode });
      const observed = monitor(mock.ctx, mock.statuses);
      const attention = createSyncAttentionController();
      try {
        attention.observe({
          setupName: "home",
          configIdentity: "identity",
          checkedAt: "2026-11-08T00:00:00.000Z",
          inspection: {
            head: {
              snapshotRef: "snapshot",
              snapshotId: "snapshot",
              revision: "revision",
              createdAt: "2026-11-08T00:00:00.000Z",
              machine: "test",
              syncSessions: false,
            },
            selectionState: { kind: "same", include: ["settings.json"] },
            localFiles: 1,
            localChanged,
            remoteChanged,
            firstSync: false,
            emptyInclude: false,
            stateIdentity: "identity",
            destination: "test",
            capability: "atomic-conditional",
          },
        });
        await attention.publish(mock.ctx);
        assert.equal(mock.statuses.get("sync"), value);
        assert.equal(observed.updates.at(-1)?.value, value);
        assert.equal(observed.updates.at(-1)?.activity, activity);
        // An explicit selection review takes precedence over an otherwise quiet observation.
        attention.set(
          {
            setupName: "home",
            configIdentity: "identity",
            localInclude: ["settings.json"],
            remoteInclude: ["AGENTS.md"],
          },
          "sync",
        );
        await attention.publish(mock.ctx);
        assert.equal(observed.updates.at(-1)?.activity, "review");
        assert.equal(mock.statuses.get("sync"), "sync ⇕");
        observed.assertRawFirst();
        attention.clear(mock.ctx);
        assert.equal(observed.updates.at(-1)?.value, undefined);
      } finally {
        attention.reset(mock.ctx);
        observed.dispose();
      }
    });
  }
}

test("startup checking supplies metadata before its inspection module loads", async () =>
  withTempHome(async (agentDir) => {
    const fixture = await createMergeFixture(agentDir);
    const mock = createMockContext({ mode: "rpc" });
    const observed = monitor(mock.ctx, mock.statuses);
    const entered = deferred();
    const service = createStartupCheck(
      createSyncLoaders({
        loadSyncInspection: async () => {
          entered.resolve();
          return {
            inspectSync: async () => {
              throw new Error("changed settings prevent inspection");
            },
          };
        },
      }),
      createSyncAttentionController(),
    );
    try {
      service.start(mock.ctx, new AbortController().signal, { ...fixture.config, automatic: true });
      await entered.promise;
      assert.ok(observed.updates.some((update) => update.value === "sync ..." && update.activity === "checking"));
      observed.assertRawFirst();
    } finally {
      await service.stop();
      observed.dispose();
    }
  }));
