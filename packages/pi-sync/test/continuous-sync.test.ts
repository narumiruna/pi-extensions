import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { test, vi } from "vitest";
import { loadConfig } from "../src/settings/config.js";
import { updateLocalConfig } from "../src/settings/settings-store.js";
import { readStateForConfig } from "../src/state/sync-state-store.js";
import { readContinuousRecord } from "../src/sync/continuous-record.js";
import { continuousBinding } from "../src/sync/continuous-storage.js";
import { type ContinuousClock, createContinuousSync } from "../src/sync/continuous-sync.js";
import { inspectSync } from "../src/sync/sync-inspection.js";
import { agentContext, agentTestModel, selectRemote } from "./agent-test-helpers.js";
import {
  advanceContinuous,
  continuousLoaders,
  enableContinuous,
  fakeContinuousTime,
  requiredHome,
  waitStatus,
} from "./continuous-test-helpers.js";
import { withTempHome } from "./helpers.js";
import { createMergeFixture } from "./merged-sync-fixture.js";

test("local and remote-only changes sync without a command; apply events do not loop", async () =>
  withTempHome(async (agentDir) => {
    const f = await createMergeFixture(agentDir);
    const config = await enableContinuous();
    // Advance only between completed cycles. Fake timers can expire a cycle's
    // deadline while its real filesystem operations are still running on CI.
    let now = Date.now();
    const tasks = new Set<{ at: number; run(): void }>();
    const clock: ContinuousClock = {
      now: () => now,
      random: () => 0,
      schedule: (ms, run) => {
        const task = { at: now + ms, run };
        tasks.add(task);
        return () => {
          tasks.delete(task);
        };
      },
    };
    const mock = agentContext(selectRemote);
    const service = createContinuousSync(continuousLoaders(f.backend), clock);
    async function poll() {
      mock.statuses.clear();
      now += 67_000;
      for (const task of [...tasks]) {
        if (task.at > now) continue;
        tasks.delete(task);
        task.run();
      }
      await waitStatus(mock.statuses, /waiting for changes/);
    }
    const publish = vi.spyOn(f.backend, "publishSnapshot");
    try {
      service.start(mock.ctx, new AbortController().signal);
      await waitStatus(mock.statuses, /waiting for changes/);
      await fs.writeFile(path.join(agentDir, "AGENTS.md"), "local only\n");
      await poll();
      await vi.waitFor(async () => {
        const head = await f.backend.readHead();
        assert.ok(head);
        const remote = await f.backend.readSnapshot(head.snapshotRef);
        assert.ok(
          remote.files.some(
            (file) =>
              file.path === "AGENTS.md" && Buffer.from(file.contentBase64, "base64").toString() === "local only\n",
          ),
        );
      });
      await waitStatus(mock.statuses, /waiting for changes/);
      const first = publish.mock.calls.length;
      assert.equal(first, 1);
      await f.remoteEdit("AGENTS.md", "remote only\n");
      await poll();
      await vi.waitFor(async () =>
        assert.equal(await fs.readFile(path.join(agentDir, "AGENTS.md"), "utf8"), "remote only\n"),
      );
      await poll();
      assert.equal(
        publish.mock.calls.length,
        first + 1,
        "remote edit alone published; apply did not publish itself again",
      );
      assert.equal(mock.requests.length, 0);
      const record = await readContinuousRecord(await continuousBinding(config));
      assert.ok(record.checked);
      assert.ok(record.transferred);
    } finally {
      await service.stop();
      assert.equal(tasks.size, 0, "stop releases every scheduled callback");
    }
  }));

test("temporary outage recovers automatically and saved backoff survives service restart", async () =>
  withTempHome(async (agentDir) => {
    const f = await createMergeFixture(agentDir);
    const config = await enableContinuous();
    let offline = true;
    let checks = 0;
    const loaders = continuousLoaders(f.backend, {
      loadSyncInspection: async () => ({
        inspectSync: async (current, options, signal) => {
          checks++;
          if (offline) throw Object.assign(new Error("private network failure"), { code: "ECONNREFUSED" });
          return inspectSync(current, options, signal, () => f.backend);
        },
      }),
    });
    fakeContinuousTime();
    const mock = agentContext(selectRemote);
    let service = createContinuousSync(loaders);
    try {
      service.start(mock.ctx, new AbortController().signal);
      await waitStatus(mock.statuses, /retry scheduled: transient/);
      const due = (await readContinuousRecord(await continuousBinding(config))).next;
      assert.ok(due >= Date.now() && due <= Date.now() + 6000);
      await service.stop();
      service = createContinuousSync(loaders);
      service.start(mock.ctx, new AbortController().signal);
      await waitStatus(mock.statuses, /retry scheduled/);
      assert.equal(checks, 1);
      offline = false;
      await advanceContinuous(7000);
      await waitStatus(mock.statuses, /waiting for changes/);
      assert.equal(checks, 2);
      assert.equal((await readContinuousRecord(await continuousBinding(config))).failures, 0);
      assert.equal(mock.requests.length, 0);
    } finally {
      await service.stop();
      vi.useRealTimers();
    }
  }));

test("uncertain committed publication recovers from its journal without republishing", async () =>
  withTempHome(async (agentDir) => {
    const f = await createMergeFixture(agentDir);
    await enableContinuous();
    await fs.writeFile(path.join(agentDir, "AGENTS.md"), "new local\n");
    f.backend.failNextPublicationAfterCommit = true;
    const publish = vi.spyOn(f.backend, "publishSnapshot");
    const mock = agentContext(selectRemote);
    const service = createContinuousSync(continuousLoaders(f.backend));
    fakeContinuousTime();
    try {
      service.start(mock.ctx, new AbortController().signal);
      await waitStatus(mock.statuses, /blocked/);
      const { readMergeJournal } = await import("../src/sync/merge-journal.js");
      assert.ok(await readMergeJournal(await loadConfig()));
      const head = await f.backend.readHead();
      await advanceContinuous(67_000);
      await waitStatus(mock.statuses, /waiting for changes/);
      assert.equal(await readMergeJournal(await loadConfig()), undefined);
      assert.deepEqual(await f.backend.readHead(), head);
      assert.equal(publish.mock.calls.length, 1);
      assert.equal(mock.requests.length, 0);
    } finally {
      await service.stop();
      vi.useRealTimers();
    }
  }));

for (const response of ["refuse", "invalid"] as const)
  test(`unchanged ${response} stays blocked across polls and takeover without extra model requests`, async () =>
    withTempHome(async (agentDir) => {
      const f = await createMergeFixture(agentDir);
      const config = await enableContinuous();
      await fs.writeFile(path.join(agentDir, "AGENTS.md"), "local\n");
      await f.remoteEdit("AGENTS.md", "remote\n");
      const mock = agentContext((units) =>
        response === "invalid"
          ? "not JSON"
          : JSON.stringify({ version: 1, results: units.map((unit) => ({ id: unit.id, refuse: true })) }),
      );
      fakeContinuousTime();
      let service = createContinuousSync(continuousLoaders(f.backend));
      try {
        service.start(mock.ctx, new AbortController().signal);
        await waitStatus(mock.statuses, /blocked/);
        assert.equal(mock.requests.length, 1);
        const notifications = mock.notifications.filter((item) =>
          item.message.startsWith("Continuous sync blocked"),
        ).length;
        await advanceContinuous(67_000);
        await waitStatus(mock.statuses, /blocked/);
        await service.stop();
        service = createContinuousSync(continuousLoaders(f.backend));
        service.start(mock.ctx, new AbortController().signal);
        await waitStatus(mock.statuses, /blocked/);
        assert.equal(mock.requests.length, 1);
        assert.equal(
          mock.notifications.filter((item) => item.message.startsWith("Continuous sync blocked")).length,
          notifications,
        );
        assert.equal((await readContinuousRecord(await continuousBinding(config))).calls.length, 1);
        assert.equal(await fs.readFile(path.join(agentDir, "AGENTS.md"), "utf8"), "local\n");
      } finally {
        await service.stop();
        vi.useRealTimers();
      }
    }));

test("settings disablement cancels monitoring and leaves content and baseline intact", async () =>
  withTempHome(async (agentDir) => {
    const f = await createMergeFixture(agentDir);
    await enableContinuous();
    const before = await readStateForConfig(await loadConfig());
    fakeContinuousTime();
    const mock = agentContext(selectRemote);
    const service = createContinuousSync(continuousLoaders(f.backend));
    const read = vi.spyOn(f.backend, "readHead");
    try {
      service.start(mock.ctx, new AbortController().signal);
      await waitStatus(mock.statuses, /waiting for changes/);
      await updateLocalConfig((current) => ({
        ...current,
        syncSetups: {
          ...current.syncSetups,
          home: { ...requiredHome(current), sync: { ...requiredHome(current).sync, agentMode: false } },
        },
      }));
      await advanceContinuous(6000);
      await vi.waitFor(() => assert.equal(mock.statuses.get("sync"), undefined));
      const count = read.mock.calls.length;
      await fs.writeFile(path.join(agentDir, "AGENTS.md"), "new local edits\n");
      await advanceContinuous(67_000);
      assert.equal(read.mock.calls.length, count);
      assert.equal(mock.requests.length, 0);
      assert.deepEqual(await readStateForConfig(await loadConfig()), before);
      await assert.rejects(fs.stat(path.join(agentDir, "pi-sync/continuous/scheduler.lock")), /ENOENT/);
    } finally {
      await service.stop();
      vi.useRealTimers();
    }
  }));

test("partial progress settles into one stable unresolved block across owner restarts", async () =>
  withTempHome(async (agentDir) => {
    const f = await createMergeFixture(agentDir);
    await enableContinuous();
    await updateLocalConfig((current) => ({
      ...current,
      version: 5,
      syncSetups: {
        ...current.syncSetups,
        home: { ...requiredHome(current), sync: { ...requiredHome(current).sync, partialSync: true } },
      },
    }));
    await fs.writeFile(path.join(agentDir, "AGENTS.md"), "local\n");
    await f.remoteEdit("AGENTS.md", "remote\n");
    await f.remoteEdit("settings.json", '{"theme":"remote"}');
    const mock = agentContext((units) =>
      JSON.stringify({ version: 1, results: units.map((unit) => ({ id: unit.id, refuse: true })) }),
    );
    const service = createContinuousSync(continuousLoaders(f.backend));
    fakeContinuousTime();
    try {
      for (let round = 0; round < 2; round++) {
        service.start(mock.ctx, new AbortController().signal);
        await waitStatus(mock.statuses, /blocked: unsafe/);
        await service.stop();
      }
      assert.deepEqual(JSON.parse(await fs.readFile(path.join(agentDir, "settings.json"), "utf8")), {
        theme: "remote",
      });
      assert.equal(await fs.readFile(path.join(agentDir, "AGENTS.md"), "utf8"), "local\n");
      const config = await loadConfig();
      const before = JSON.stringify(await readStateForConfig(config));
      assert.ok((await readStateForConfig(config)).unresolved?.length);
      const requests = mock.requests.length;
      assert.ok(requests >= 1 && requests <= 2);
      const notices = mock.notifications.filter((item) => item.message.includes("retained unresolved groups")).length;
      service.start(mock.ctx, new AbortController().signal);
      await waitStatus(mock.statuses, /blocked: unsafe/);
      await service.stop();
      assert.equal(mock.requests.length, requests);
      assert.equal(JSON.stringify(await readStateForConfig(config)), before);
      assert.equal(
        mock.notifications.filter((item) => item.message.includes("retained unresolved groups")).length,
        notices,
      );
    } finally {
      await service.stop();
      vi.useRealTimers();
    }
  }));

test("selecting an available model resumes a previously blocked conflict", async () =>
  withTempHome(async (agentDir) => {
    const f = await createMergeFixture(agentDir);
    await enableContinuous();
    await fs.writeFile(path.join(agentDir, "AGENTS.md"), "local\n");
    await f.remoteEdit("AGENTS.md", "remote\n");
    const mock = agentContext(selectRemote, { model: undefined });
    const service = createContinuousSync(continuousLoaders(f.backend));
    fakeContinuousTime();
    try {
      service.start(mock.ctx, new AbortController().signal);
      await waitStatus(mock.statuses, /blocked: model/);
      assert.equal(mock.requests.length, 0);
      mock.ctx.model = { ...agentTestModel };
      await advanceContinuous(6000);
      await waitStatus(mock.statuses, /waiting for changes/);
      assert.equal(mock.requests.length, 1);
      assert.equal(await fs.readFile(path.join(agentDir, "AGENTS.md"), "utf8"), "remote\n");
    } finally {
      await service.stop();
      vi.useRealTimers();
    }
  }));

test("private record repair resumes without another notification or a forced transfer", async () =>
  withTempHome(async (agentDir) => {
    const f = await createMergeFixture(agentDir);
    const config = await enableContinuous();
    const mock = agentContext(selectRemote);
    const service = createContinuousSync(continuousLoaders(f.backend));
    fakeContinuousTime();
    try {
      service.start(mock.ctx, new AbortController().signal);
      await waitStatus(mock.statuses, /waiting for changes/);
      const record = path.join(agentDir, "pi-sync/continuous", `${await continuousBinding(config)}.json`);
      const valid = await fs.readFile(record, "utf8");
      await fs.writeFile(record, "{broken", { mode: 0o600 });
      await advanceContinuous(6000);
      await waitStatus(mock.statuses, /blocked: private/);
      const count = mock.notifications.filter((item) => item.message.includes("need repair")).length;
      await advanceContinuous(6000);
      assert.equal(await fs.readFile(record, "utf8"), "{broken");
      assert.equal(mock.notifications.filter((item) => item.message.includes("need repair")).length, count);
      await fs.writeFile(record, valid, { mode: 0o600 });
      await advanceContinuous(6000);
      await waitStatus(mock.statuses, /waiting for changes/);
      assert.equal(mock.requests.length, 0);
    } finally {
      await service.stop();
      vi.useRealTimers();
    }
  }));

test("a full model window does not block conflict-free progress after evidence changes", async () =>
  withTempHome(async (agentDir) => {
    const f = await createMergeFixture(agentDir);
    const config = await enableContinuous();
    await fs.writeFile(path.join(agentDir, "AGENTS.md"), "local\n");
    await f.remoteEdit("AGENTS.md", "remote\n");
    const { prepareContinuousRoot } = await import("../src/sync/continuous-storage.js");
    await prepareContinuousRoot();
    const binding = await continuousBinding(config);
    const { acquireContinuousLease } = await import("../src/sync/continuous-lease.js");
    const { reserveContinuousRequest } = await import("../src/sync/continuous-record.js");
    const lease = await acquireContinuousLease(binding);
    assert.ok(lease);
    try {
      await reserveContinuousRequest(binding, lease, "a".repeat(64));
      await reserveContinuousRequest(binding, lease, "b".repeat(64));
    } finally {
      await lease.release();
    }
    const mock = agentContext(selectRemote);
    const service = createContinuousSync(continuousLoaders(f.backend));
    fakeContinuousTime();
    try {
      service.start(mock.ctx, new AbortController().signal);
      await waitStatus(mock.statuses, /retry scheduled: budget/);
      assert.equal(mock.requests.length, 0);
      await fs.writeFile(path.join(agentDir, "AGENTS.md"), "remote\n");
      await advanceContinuous(6000);
      await waitStatus(mock.statuses, /waiting for changes/);
      assert.equal(mock.requests.length, 0);
      assert.equal((await readStateForConfig(config)).lastAppliedSnapshot, (await f.backend.readHead())?.snapshotId);
      assert.equal((await readContinuousRecord(binding)).calls.length, 2);
    } finally {
      await service.stop();
      vi.useRealTimers();
    }
  }));

for (const mode of ["print", "json"] as const)
  test(`unsupported ${mode} starts no scheduler resource`, async () =>
    withTempHome(async (agentDir) => {
      const f = await createMergeFixture(agentDir);
      await enableContinuous();
      const mock = agentContext(selectRemote, { mode, hasUI: false });
      const service = createContinuousSync(continuousLoaders(f.backend));
      service.start(mock.ctx, new AbortController().signal);
      await service.stop();
      await assert.rejects(fs.stat(path.join(agentDir, "pi-sync/continuous")), /ENOENT/);
      assert.equal(mock.requests.length, 0);
    }));
