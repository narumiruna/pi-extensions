import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { test, vi } from "vitest";
import { readStateForConfig, writeStateForConfig } from "../src/state/sync-state-store.js";
import { readContinuousRecord } from "../src/sync/continuous-record.js";
import { continuousBinding } from "../src/sync/continuous-storage.js";
import { createContinuousSync } from "../src/sync/continuous-sync.js";
import { readMergeJournal } from "../src/sync/merge-journal.js";
import { createStartupTimings } from "../src/sync/startup-timings.js";
import { syncBoth } from "../src/sync/sync-mutations.js";
import { agentContext, selectRemote } from "./agent-test-helpers.js";
import { continuousLoaders } from "./continuous-test-helpers.js";
import { RecoveryClock as Clock, recoveryFixture, waitRecoveryStatus as waitStatus } from "./recovery-test-helpers.js";

// Tests drive periodic polls, not host filesystem watcher timing.
vi.mock("../src/sync/continuous-watch.js", () => ({ watchContinuous: async () => () => {} }));

const fixture = recoveryFixture();

type Stage = Parameters<ReturnType<typeof createStartupTimings>["measure"]>[0];

for (const phase of ["review", "journal", "baseline"] as const) {
  for (const mutation of ["local", "state", "remote"] as const) {
    // Remote publication conflicts after staging a journal have their own backend retry policy.
    if (phase === "journal" && mutation === "remote") continue;
    test(`continuous retries real ${mutation} race at ${phase} without stale publication or apply`, async () => {
      const { agentDir, f, config } = fixture();
      const file = path.join(agentDir, "AGENTS.md");
      await fs.writeFile(file, "observed local\n");
      if (phase === "baseline") await f.remoteEdit("AGENTS.md", "observed local\n");
      else await f.remoteEdit("settings.json", '{"theme":"remote"}\n');
      let rejectedState = await readStateForConfig(config);
      let rejectedHead = await f.backend.readHead();
      let injected = false;
      let cycles = 0;
      const clock = new Clock();
      const mock = agentContext(selectRemote);
      const publish = vi.spyOn(f.backend, "publishSnapshot");
      const service = createContinuousSync(
        continuousLoaders(f.backend, {
          loadSyncOperations: async () => ({
            ...(await import("../src/sync/sync-operations.js")),
            syncBoth: async (ctx, options) => {
              cycles++;
              const timings = createStartupTimings();
              const measure = timings.measure;
              timings.measure = async (stage, run) => {
                const result = await measure(stage, run);
                const target: Stage =
                  phase === "review"
                    ? "transfer preflight"
                    : phase === "journal"
                      ? "transfer journal write"
                      : "transfer content merge";
                if (!injected && stage === target) {
                  injected = true;
                  if (mutation === "local") await fs.writeFile(file, "latest local\n");
                  if (mutation === "state") {
                    rejectedState = { ...rejectedState, lastRemoteRevision: "externally-accepted-revision" };
                    await writeStateForConfig(config, rejectedState);
                  }
                  if (mutation === "remote") {
                    await f.remoteEdit(
                      "AGENTS.md",
                      phase === "baseline" ? "observed local\n" : "original instructions\n",
                    );
                    rejectedHead = await f.backend.readHead();
                  }
                }
                return result;
              };
              return syncBoth(ctx, { ...options, startupTimings: timings }, () => f.backend);
            },
          }),
        }),
        clock,
      );
      try {
        service.start(mock.ctx, new AbortController().signal);
        await waitStatus(mock.statuses, /retry scheduled: stale/);
        assert.equal(injected, true);
        assert.equal(cycles, 1);
        assert.equal(publish.mock.calls.length, mutation === "remote" ? 1 : 0, "only the external writer may publish");
        assert.deepEqual(await f.backend.readHead(), rejectedHead);
        assert.deepEqual(await readStateForConfig(config), rejectedState);
        assert.equal(await fs.readFile(file, "utf8"), mutation === "local" ? "latest local\n" : "observed local\n");
        assert.equal(await fs.readFile(path.join(agentDir, "settings.json"), "utf8"), '{"theme":"original"}\n');
        assert.equal(await readMergeJournal(config), undefined, "unpublished staged journal is safely retired");
        const record = await readContinuousRecord(await continuousBinding(config));
        assert.equal(record.failures, 1);
        assert.ok(record.next > clock.now() && record.next <= clock.now() + 6000);
        assert.equal(mock.requests.length, 0);
        mock.statuses.clear();
        clock.advance(record.next - clock.now());
        await waitStatus(mock.statuses, /waiting for changes/);
        const newConflict = phase === "baseline" && mutation === "local";
        assert.equal(
          cycles,
          newConflict ? 3 : 2,
          "a fresh cycle may reenter syncBoth once after resolving a new conflict",
        );
        assert.equal(mock.requests.length, newConflict ? 1 : 0);
        const head = await f.backend.readHead();
        assert.ok(head);
        const remote = await f.backend.readSnapshot(head.snapshotRef);
        const remoteFile = remote.files.find((item) => item.path === "AGENTS.md");
        assert.ok(remoteFile);
        assert.equal(Buffer.from(remoteFile.contentBase64, "base64").toString(), await fs.readFile(file, "utf8"));
        assert.equal((await readStateForConfig(config)).lastRemoteRevision, head.revision);
        assert.equal((await readContinuousRecord(await continuousBinding(config))).failures, 0);
        assert.equal(await readMergeJournal(config), undefined);
      } finally {
        await service.stop();
        assert.equal(clock.tasks.size, 0);
      }
    });
  }
}

test("no-transfer acceptance rejects a late remote revision after checking local bytes and baseline", async () => {
  const { agentDir, f, config } = fixture();
  await fs.writeFile(path.join(agentDir, "AGENTS.md"), "same new bytes\n");
  await f.remoteEdit("AGENTS.md", "same new bytes\n");
  const before = await readStateForConfig(config);
  const clock = new Clock();
  const mock = agentContext(selectRemote);
  let injected = false;
  const service = createContinuousSync(
    continuousLoaders(f.backend, {
      loadSyncOperations: async () => ({
        ...(await import("../src/sync/sync-operations.js")),
        syncBoth: (ctx, options) => {
          let reads = 0;
          const timings = createStartupTimings();
          const measure = timings.measure;
          timings.measure = async (stage, run) => {
            const result = await measure(stage, run);
            if (stage === "transfer state read" && ++reads === 2 && !injected) {
              injected = true;
              await f.remoteEdit("AGENTS.md", "same new bytes\n");
            }
            return result;
          };
          return syncBoth(ctx, { ...options, startupTimings: timings }, () => f.backend);
        },
      }),
    }),
    clock,
  );
  const publish = vi.spyOn(f.backend, "publishSnapshot");
  try {
    service.start(mock.ctx, new AbortController().signal);
    await waitStatus(mock.statuses, /retry scheduled: stale/);
    assert.deepEqual(await readStateForConfig(config), before);
    assert.equal(publish.mock.calls.length, 1, "only the racing external publication occurred");
    mock.statuses.clear();
    clock.advance(7000);
    await waitStatus(mock.statuses, /waiting for changes/);
    assert.equal(publish.mock.calls.length, 1, "fresh baseline acceptance needs no transfer");
    assert.equal((await readStateForConfig(config)).lastRemoteRevision, (await f.backend.readHead())?.revision);
    assert.equal(mock.requests.length, 0);
  } finally {
    await service.stop();
    assert.equal(clock.tasks.size, 0);
  }
});

test("apply-only remote race safely retires journal and the next poll applies only the latest revision", async () => {
  const { agentDir, f, config } = fixture();
  await f.remoteEdit("AGENTS.md", "stale remote\n");
  const before = await readStateForConfig(config);
  const clock = new Clock();
  const mock = agentContext(selectRemote);
  let injected = false;
  const service = createContinuousSync(
    continuousLoaders(f.backend, {
      loadSyncOperations: async () => ({
        ...(await import("../src/sync/sync-operations.js")),
        syncBoth: (ctx, options) => {
          const timings = createStartupTimings();
          const measure = timings.measure;
          timings.measure = async (stage, run) => {
            const result = await measure(stage, run);
            if (!injected && stage === "transfer journal write") {
              injected = true;
              assert.equal((await readMergeJournal(config))?.applyOnly, true);
              await f.remoteEdit("AGENTS.md", "latest remote\n");
            }
            return result;
          };
          return syncBoth(ctx, { ...options, startupTimings: timings }, () => f.backend);
        },
      }),
    }),
    clock,
  );
  const publish = vi.spyOn(f.backend, "publishSnapshot");
  try {
    service.start(mock.ctx, new AbortController().signal);
    await waitStatus(mock.statuses, /waiting for changes/);
    assert.equal(injected, true);
    assert.equal(await fs.readFile(path.join(agentDir, "AGENTS.md"), "utf8"), "original instructions\n");
    assert.deepEqual(await readStateForConfig(config), before);
    assert.equal(await readMergeJournal(config), undefined);
    mock.statuses.clear();
    clock.advance(67000);
    await waitStatus(mock.statuses, /waiting for changes/);
    assert.equal(await fs.readFile(path.join(agentDir, "AGENTS.md"), "utf8"), "latest remote\n");
    assert.equal(publish.mock.calls.length, 1, "no merge publication, only external writer");
    assert.equal(mock.requests.length, 0);
  } finally {
    await service.stop();
    assert.equal(clock.tasks.size, 0);
  }
});
