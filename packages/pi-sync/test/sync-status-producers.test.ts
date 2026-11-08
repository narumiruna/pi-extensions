import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { createEventBus, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { test } from "vitest";
import { createMockContext } from "../../../test/support.js";
import { ContinuousError } from "../src/sync/continuous-errors.js";
import { acquireContinuousLease } from "../src/sync/continuous-lease.js";
import { readContinuousRecord } from "../src/sync/continuous-record.js";
import { continuousBinding, continuousRoot } from "../src/sync/continuous-storage.js";
import { createContinuousSync } from "../src/sync/continuous-sync.js";
import { createStartupCheck } from "../src/sync/startup-check.js";
import { createSyncLoaders } from "../src/sync/sync-loaders.js";
import { pull, push } from "../src/sync/sync-mutations.js";
import { diff, status } from "../src/sync/sync-queries.js";
import { showRemoteSelectionReview } from "../src/ui/remote-selection-ui.js";
import { createSyncAttentionController } from "../src/ui/sync-attention.js";
import { createSyncStatusPublisher } from "../src/ui/sync-status.js";
import { agentContext, selectRemote } from "./agent-test-helpers.js";
import { ContinuousTestClock, continuousLoaders, enableContinuous, waitStatus } from "./continuous-test-helpers.js";
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

for (const [kind, activity, reason] of [
  ["transient", "retry", "temp"],
  ["contention", "retry", "busy"],
  ["stale", "retry", "stale"],
  ["authentication", "blocked", "auth"],
  ["storage", "blocked", "storage"],
  ["unsafe", "blocked", "review"],
  ["model", "blocked", "model"],
  ["budget", "retry", "limit"],
  ["unknown", "blocked", "unknown"],
] as const) {
  test(`continuous ${kind} branch publishes ${activity}/${reason} without changing its durable category`, async () =>
    withTempHome(async (agentDir) => {
      const fixture = await createMergeFixture(agentDir);
      const config = await enableContinuous();
      const mock = agentContext(selectRemote);
      const observed = monitor(mock.ctx, mock.statuses);
      const service = createContinuousSync(
        continuousLoaders(fixture.backend, {
          loadSyncInspection: async () => ({
            inspectSync: async () => {
              throw new ContinuousError(kind, "private provider detail");
            },
          }),
        }),
        new ContinuousTestClock(),
      );
      try {
        service.start(mock.ctx, new AbortController().signal);
        await waitStatus(
          mock.statuses,
          new RegExp(activity === "retry" ? `retry scheduled: ${kind}` : `blocked: ${kind}`),
        );
        const latest = observed.updates.at(-1);
        assert.equal(latest?.activity, activity);
        assert.equal(latest?.reason, reason);
        assert.equal(latest?.value, mock.statuses.get("sync"));
        const durable = await readContinuousRecord(await continuousBinding(config));
        assert.equal(durable.phase, activity);
        assert.equal(durable.error, kind);
        assert.equal(mock.requests.length, 0);
        assert.equal(JSON.stringify(observed.updates).includes("private provider detail"), false);
        observed.assertRawFirst();
      } finally {
        await service.stop();
        assert.equal(observed.updates.at(-1)?.value, undefined);
        observed.dispose();
      }
    }));
}

test("continuous checking, work, model resolution and normal standby use explicit activities", async () =>
  withTempHome(async (agentDir) => {
    const fixture = await createMergeFixture(agentDir);
    await enableContinuous();
    await fs.writeFile(path.join(agentDir, "AGENTS.md"), "local\n");
    await fixture.remoteEdit("AGENTS.md", "remote\n");
    const mock = agentContext(selectRemote);
    const observed = monitor(mock.ctx, mock.statuses);
    const service = createContinuousSync(continuousLoaders(fixture.backend), new ContinuousTestClock());
    try {
      service.start(mock.ctx, new AbortController().signal);
      await waitStatus(mock.statuses, /waiting for changes/u);
      for (const [value, activity] of [
        ["sync checking", "checking"],
        ["sync syncing", "working"],
        ["sync resolving", "resolving"],
        ["sync waiting for changes", "idle"],
      ])
        assert.ok(observed.updates.some((update) => update.value === value && update.activity === activity));
      assert.equal(mock.requests.length, 1);
      observed.assertRawFirst();
    } finally {
      await service.stop();
      observed.dispose();
    }
  }));

test("another owner's lease publishes idle without changing the election predicate", async () =>
  withTempHome(async (agentDir) => {
    const fixture = await createMergeFixture(agentDir);
    const config = await enableContinuous();
    const lease = await acquireContinuousLease(await continuousBinding(config));
    assert.ok(lease);
    const mock = agentContext(selectRemote);
    const observed = monitor(mock.ctx, mock.statuses);
    const service = createContinuousSync(continuousLoaders(fixture.backend), new ContinuousTestClock());
    try {
      service.start(mock.ctx, new AbortController().signal);
      await waitStatus(mock.statuses, /waiting: another local owner/u);
      assert.equal(observed.updates.at(-1)?.activity, "idle");
      assert.equal(observed.updates.at(-1)?.value, "sync waiting: another local owner");
      assert.equal(mock.requests.length, 0);
      lease.assert();
    } finally {
      await service.stop();
      await lease.release();
      observed.dispose();
    }
  }));

test("private-state repair publishes blocked/repair without replacing invalid evidence", async () =>
  withTempHome(async (agentDir) => {
    const fixture = await createMergeFixture(agentDir);
    const config = await enableContinuous();
    const binding = await continuousBinding(config);
    await fs.mkdir(continuousRoot(), { recursive: true, mode: 0o700 });
    const file = path.join(continuousRoot(), `${binding}.json`);
    await fs.writeFile(file, "{broken-private-evidence", { mode: 0o600 });
    const mock = agentContext(selectRemote);
    const observed = monitor(mock.ctx, mock.statuses);
    const service = createContinuousSync(continuousLoaders(fixture.backend), new ContinuousTestClock());
    try {
      service.start(mock.ctx, new AbortController().signal);
      await waitStatus(mock.statuses, /blocked: private state or settings need repair/u);
      assert.equal(observed.updates.at(-1)?.activity, "blocked");
      assert.equal(observed.updates.at(-1)?.reason, "repair");
      assert.equal(await fs.readFile(file, "utf8"), "{broken-private-evidence");
      assert.equal(mock.requests.length, 0);
    } finally {
      await service.stop();
      observed.dispose();
    }
  }));

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
