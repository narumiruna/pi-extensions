import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { test, vi } from "vitest";
import { readStateForConfig } from "../src/state/sync-state-store.js";
import { readContinuousRecord } from "../src/sync/continuous-record.js";
import { continuousBinding } from "../src/sync/continuous-storage.js";
import { createContinuousSync } from "../src/sync/continuous-sync.js";
import { inspectSync } from "../src/sync/sync-inspection.js";
import { agentContext, selectRemote } from "./agent-test-helpers.js";
import { continuousLoaders } from "./continuous-test-helpers.js";
import { RecoveryClock as Clock, recoveryFixture, waitRecoveryStatus as waitStatus } from "./recovery-test-helpers.js";

vi.mock("../src/sync/continuous-watch.js", () => ({ watchContinuous: async () => () => {} }));

const fixture = recoveryFixture();

for (const failure of ["upload-secret", "unsupported", "refused"] as const) {
  for (const repair of ["poll", "restart"] as const) {
    test(`${failure} recovers after changed evidence on ${repair}, not unchanged polls or owner restart`, async () => {
      const { agentDir, f, config } = fixture();
      const file = path.join(agentDir, "AGENTS.md");
      await fs.writeFile(file, failure === "upload-secret" ? "sk-ant-abcdefghijklmnopqrstuvwxyz\n" : "local\n");
      if (failure !== "upload-secret")
        await f.remoteEdit("AGENTS.md", failure === "unsupported" ? undefined : "remote\n");
      const before = await readStateForConfig(config);
      const head = await f.backend.readHead();
      const clock = new Clock();
      let checks = 0;
      let repaired = false;
      const mock = agentContext((units) =>
        repaired
          ? selectRemote(units)
          : JSON.stringify({ version: 1, results: units.map((unit) => ({ id: unit.id, refuse: true })) }),
      );
      const loaders = continuousLoaders(f.backend, {
        loadSyncInspection: async () => ({
          inspectSync: (current, options, signal) => {
            checks++;
            return inspectSync(current, options, signal, () => f.backend);
          },
        }),
      });
      let service = createContinuousSync(loaders, clock);
      async function poll(expected: RegExp) {
        mock.statuses.clear();
        clock.advance(67000);
        await waitStatus(mock.statuses, expected);
      }
      async function restart(expected: RegExp) {
        await service.stop();
        assert.equal(clock.tasks.size, 0);
        mock.statuses.clear();
        service = createContinuousSync(loaders, clock);
        service.start(mock.ctx, new AbortController().signal);
        await waitStatus(mock.statuses, expected);
      }
      try {
        service.start(mock.ctx, new AbortController().signal);
        await waitStatus(mock.statuses, /blocked: unsafe/);
        assert.deepEqual(await readStateForConfig(config), before);
        assert.deepEqual(await f.backend.readHead(), head);
        const requests = failure === "refused" ? 1 : 0;
        assert.equal(mock.requests.length, requests);
        const notices = mock.notifications.filter((item) => item.message.startsWith("Continuous sync blocked")).length;
        const calls = (await readContinuousRecord(await continuousBinding(config))).calls;
        await poll(/blocked: unsafe/);
        await restart(/blocked: unsafe/);
        assert.ok(checks >= 3, "known safety blocks are inspected again, not opaque-block short-circuited");
        assert.equal(mock.requests.length, requests, "unchanged evidence never repeats inference");
        assert.deepEqual((await readContinuousRecord(await continuousBinding(config))).calls, calls);
        assert.equal(
          mock.notifications.filter((item) => item.message.startsWith("Continuous sync blocked")).length,
          notices,
        );
        repaired = true;
        await fs.writeFile(file, "safe changed evidence\n");
        if (failure === "unsupported") await f.remoteEdit("AGENTS.md", "remote repaired\n");
        if (repair === "poll") await poll(/waiting for changes/);
        else await restart(/waiting for changes/);
        assert.ok(checks >= 4);
        assert.equal(mock.requests.length, failure === "upload-secret" ? 0 : requests + 1);
        const record = await readContinuousRecord(await continuousBinding(config));
        assert.equal(record.phase, "waiting");
        assert.equal(record.calls.length, mock.requests.length, "recovery preserves durable request accounting");
        for (const call of calls)
          assert.ok(record.calls.some((current) => current.key === call.key && current.at === call.at));
        const currentHead = await f.backend.readHead();
        assert.ok(currentHead);
        const remote = await f.backend.readSnapshot(currentHead.snapshotRef);
        const remoteFile = remote.files.find((item) => item.path === "AGENTS.md");
        assert.ok(remoteFile);
        assert.equal(Buffer.from(remoteFile.contentBase64, "base64").toString(), await fs.readFile(file, "utf8"));
        assert.equal((await readStateForConfig(config)).lastRemoteRevision, currentHead.revision);
      } finally {
        await service.stop();
        assert.equal(clock.tasks.size, 0);
      }
    });
  }
}

test("opaque failures remain blocked without inspection after content changes or owner restart", async () => {
  const { agentDir, f, config } = fixture();
  await fs.writeFile(path.join(agentDir, "AGENTS.md"), "pending local\n");
  let checks = 0;
  let transfers = 0;
  const clock = new Clock();
  const mock = agentContext(selectRemote);
  const before = await readStateForConfig(config);
  const head = await f.backend.readHead();
  const loaders = continuousLoaders(f.backend, {
    loadSyncInspection: async () => ({
      inspectSync: (current, options, signal) => {
        checks++;
        return inspectSync(current, options, signal, () => f.backend);
      },
    }),
    loadSyncOperations: async () => ({
      ...(await import("../src/sync/sync-operations.js")),
      syncBoth: async () => {
        transfers++;
        throw new Error("opaque failure");
      },
    }),
  });
  let service = createContinuousSync(loaders, clock);
  try {
    service.start(mock.ctx, new AbortController().signal);
    await waitStatus(mock.statuses, /blocked: unknown/);
    await fs.writeFile(path.join(agentDir, "AGENTS.md"), "changed local\n");
    mock.statuses.clear();
    clock.advance(67000);
    await waitStatus(mock.statuses, /blocked: unknown/);
    await service.stop();
    mock.statuses.clear();
    service = createContinuousSync(loaders, clock);
    service.start(mock.ctx, new AbortController().signal);
    await waitStatus(mock.statuses, /blocked: unknown/);
    assert.equal(checks, 1);
    assert.equal(transfers, 1);
    assert.equal(mock.requests.length, 0);
    assert.deepEqual(await readStateForConfig(config), before);
    assert.deepEqual(await f.backend.readHead(), head);
  } finally {
    await service.stop();
    assert.equal(clock.tasks.size, 0);
  }
});
