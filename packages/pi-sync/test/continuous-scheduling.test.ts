import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { inspectSync } from "@narumitw/pi-sync-daemon/engine/sync/sync-inspection";
import { test, vi } from "vitest";
import { updateLocalConfig } from "../src/settings/settings-store.js";
import type { ContinuousClock } from "../src/sync/continuous-sync.js";
import { createContinuousSync } from "../src/sync/continuous-sync.js";
import { agentContext, selectRemote } from "./agent-test-helpers.js";
import { continuousLoaders, enableContinuous, requiredHome, waitStatus } from "./continuous-test-helpers.js";
import { withTempHome } from "./helpers.js";
import { createMergeFixture } from "./merged-sync-fixture.js";
import { deferred } from "./startup-check-helpers.js";

const watch = vi.hoisted(() => ({
  changed: undefined as ((settings: boolean) => void) | undefined,
  open: 0,
  closed: 0,
}));
vi.mock("@narumitw/pi-sync-daemon/engine/sync/continuous-watch", () => ({
  watchContinuous: async (_config: unknown, changed: (settings: boolean) => void) => {
    watch.changed = changed;
    watch.open++;
    let closed = false;
    return () => {
      if (!closed) {
        closed = true;
        watch.closed++;
      }
    };
  },
}));

class Clock implements ContinuousClock {
  value = Date.now();
  tasks = new Set<{ at: number; run(): void }>();
  now = () => this.value;
  random = () => 0;
  schedule = (ms: number, run: () => void) => {
    const task = { at: this.value + ms, run };
    this.tasks.add(task);
    return () => {
      this.tasks.delete(task);
    };
  };
  async advance(ms: number) {
    this.value += ms;
    for (const task of [...this.tasks])
      if (task.at <= this.value) {
        this.tasks.delete(task);
        task.run();
      }
    for (let pass = 0; pass < 8; pass++) await fs.stat(path.dirname(getAgentDir()));
  }
}

test("hints debounce for one quiet second, coalesce active work and never overlap cycles", async () =>
  withTempHome(async (agentDir) => {
    const f = await createMergeFixture(agentDir);
    await enableContinuous();
    const clock = new Clock();
    const mock = agentContext(selectRemote);
    let checks = 0;
    let active = 0;
    let maxActive = 0;
    const entered = deferred();
    const release = deferred();
    const service = createContinuousSync(
      continuousLoaders(f.backend, {
        loadSyncInspection: async () => ({
          inspectSync: async (config, options, signal) => {
            checks++;
            active++;
            maxActive = Math.max(maxActive, active);
            try {
              if (checks === 2) {
                entered.resolve();
                await release.promise;
              }
              return await inspectSync(config, options, signal, () => f.backend);
            } finally {
              active--;
            }
          },
        }),
      }),
      clock,
    );
    const open = watch.open;
    const closed = watch.closed;
    try {
      service.start(mock.ctx, new AbortController().signal);
      await waitStatus(mock.statuses, /waiting for changes/);
      await fs.writeFile(path.join(agentDir, "AGENTS.md"), "local edit\n");
      watch.changed?.(false);
      await clock.advance(500);
      watch.changed?.(false);
      await clock.advance(999);
      assert.equal(checks, 1);
      await clock.advance(1);
      await vi.waitFor(async () => {
        if (checks < 2) await clock.advance(1);
        assert.equal(checks, 2);
      });
      await entered.promise;
      watch.changed?.(false);
      watch.changed?.(false);
      watch.changed?.(false);
      release.resolve();
      await waitStatus(mock.statuses, /waiting for changes/);
      await clock.advance(1000);
      await vi.waitFor(() => assert.equal(checks, 3));
      await waitStatus(mock.statuses, /waiting for changes/);
      assert.equal(maxActive, 1);
      assert.equal(mock.requests.length, 0);
    } finally {
      release.resolve();
      await service.stop();
      assert.equal(clock.tasks.size, 0);
      assert.equal(watch.open - open, watch.closed - closed);
    }
  }));

test("authorization checks cancel an active provider even when watching supplies no hints", async () =>
  withTempHome(async (agentDir) => {
    const f = await createMergeFixture(agentDir);
    await enableContinuous();
    await fs.writeFile(path.join(agentDir, "AGENTS.md"), "local\n");
    await f.remoteEdit("AGENTS.md", "remote\n");
    const ready = deferred();
    const mock = agentContext(async () => {
      ready.resolve();
      return new Promise<string>(() => {});
    });
    const clock = new Clock();
    const service = createContinuousSync(continuousLoaders(f.backend), clock);
    try {
      service.start(mock.ctx, new AbortController().signal);
      await ready.promise;
      await updateLocalConfig((current) => ({
        ...current,
        syncSetups: {
          ...current.syncSetups,
          home: { ...requiredHome(current), sync: { ...requiredHome(current).sync, continuous: false } },
        },
      }));
      // The watcher mock emits nothing. Only the owned authorization task can abort this request.
      await clock.advance(5000);
      await vi.waitFor(() => assert.equal((mock.requestOptions[0] as { signal: AbortSignal }).signal.aborted, true));
      await service.stop();
      assert.equal(mock.requests.length, 1);
      assert.equal(await fs.readFile(path.join(agentDir, "AGENTS.md"), "utf8"), "local\n");
      await assert.rejects(fs.stat(path.join(agentDir, "pi-sync/agent-resolver/claim.json")), /ENOENT/);
      assert.equal(clock.tasks.size, 0);
    } finally {
      await service.stop();
    }
  }));

test("periodic fallback checks without watcher events and a cycle deadline drains work", async () =>
  withTempHome(async (agentDir) => {
    const f = await createMergeFixture(agentDir);
    await enableContinuous();
    const clock = new Clock();
    const mock = agentContext(selectRemote);
    let checks = 0;
    let aborted = false;
    const entered = deferred();
    const service = createContinuousSync(
      continuousLoaders(f.backend, {
        loadSyncInspection: async () => ({
          inspectSync: async (config, options, signal) => {
            checks++;
            if (checks === 1) return inspectSync(config, options, signal, () => f.backend);
            entered.resolve();
            await new Promise<void>((_resolve, reject) =>
              signal?.addEventListener(
                "abort",
                () => {
                  aborted = true;
                  reject(signal.reason);
                },
                { once: true },
              ),
            );
            throw new Error("unreachable");
          },
        }),
      }),
      clock,
    );
    try {
      service.start(mock.ctx, new AbortController().signal);
      await waitStatus(mock.statuses, /waiting for changes/);
      await clock.advance(60000);
      await entered.promise;
      await clock.advance(30000);
      await waitStatus(mock.statuses, /retry scheduled: transient/);
      assert.equal(aborted, true);
      assert.equal(checks, 2);
    } finally {
      await service.stop();
      assert.equal(clock.tasks.size, 0);
    }
  }));
