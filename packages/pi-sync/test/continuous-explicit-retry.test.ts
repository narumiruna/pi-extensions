import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { inspectSync } from "@narumitw/pi-sync-daemon/engine/sync/sync-inspection";
import { test, vi } from "vitest";
import { acquireContinuousLease } from "../src/sync/continuous-lease.js";
import { readContinuousRecord, reserveContinuousRequest } from "../src/sync/continuous-record.js";
import { continuousBinding, prepareContinuousRoot } from "../src/sync/continuous-storage.js";
import { createContinuousSync } from "../src/sync/continuous-sync.js";
import { syncBoth } from "../src/sync/sync-mutations.js";
import { agentContext, selectRemote } from "./agent-test-helpers.js";
import { continuousLoaders } from "./continuous-test-helpers.js";
import { RecoveryClock, recoveryFixture, waitRecoveryStatus } from "./recovery-test-helpers.js";

vi.mock("@narumitw/pi-sync-daemon/engine/sync/continuous-watch", () => ({ watchContinuous: async () => () => {} }));

const fixture = recoveryFixture();

for (const [kind, failure] of [
  ["authentication", () => Object.assign(new Error("fixture denied"), { status: 403 })],
  ["storage", () => Object.assign(new Error("fixture disk full"), { code: "ENOSPC" })],
  ["unknown", () => new Error("fixture opaque failure")],
] as const)
  test(`explicit retry resumes repaired ${kind} without clearing persisted calls or attempts`, async () => {
    const { agentDir, f, config } = fixture();
    await fs.writeFile(path.join(agentDir, "AGENTS.md"), "pending local\n");
    const clock = new RecoveryClock();
    await prepareContinuousRoot();
    const binding = await continuousBinding(config);
    const lease = await acquireContinuousLease(binding);
    assert.ok(lease);
    try {
      await reserveContinuousRequest(binding, lease, "a".repeat(64), clock.now);
    } finally {
      await lease.release();
    }
    const accounting = await readContinuousRecord(binding);
    assert.equal(accounting.calls.length, 1);
    assert.equal(accounting.attempts["a".repeat(64)], 1);
    let repaired = false;
    let checks = 0;
    let transfers = 0;
    const mock = agentContext(selectRemote);
    const service = createContinuousSync(
      continuousLoaders(f.backend, {
        loadSyncInspection: async () => ({
          inspectSync: (current, options, signal) => {
            checks++;
            return inspectSync(current, options, signal, () => f.backend);
          },
        }),
        loadSyncOperations: async () => ({
          ...(await import("@narumitw/pi-sync-daemon/engine/sync/sync-operations")),
          syncBoth: async (ctx, options) => {
            transfers++;
            if (!repaired) throw failure();
            return syncBoth(ctx, options, () => f.backend);
          },
        }),
      }),
      clock,
    );
    const signal = new AbortController().signal;
    try {
      service.start(mock.ctx, signal);
      await waitRecoveryStatus(mock.statuses, new RegExp(`blocked: ${kind}`));
      repaired = true;
      await service.stop();
      mock.statuses.clear();
      service.start(mock.ctx, signal);
      await waitRecoveryStatus(mock.statuses, new RegExp(`blocked: ${kind}`));
      assert.equal(checks, 1);
      assert.equal(transfers, 1);
      await service.stop();
      mock.statuses.clear();
      service.start(mock.ctx, signal, "other");
      await waitRecoveryStatus(mock.statuses, new RegExp(`blocked: ${kind}`));
      assert.equal(checks, 1, "another setup cannot force this binding");
      assert.equal(transfers, 1);
      await service.stop();
      mock.statuses.clear();
      service.start(mock.ctx, signal, config.setupName);
      await waitRecoveryStatus(mock.statuses, /waiting for changes/u);
      assert.equal(checks, 2);
      assert.equal(transfers, 2);
      const after = await readContinuousRecord(binding);
      assert.equal(after.phase, "waiting");
      assert.equal(after.error, undefined);
      assert.deepEqual(after.calls, accounting.calls);
      assert.deepEqual(after.attempts, accounting.attempts);
      assert.equal(mock.requests.length, 0);
    } finally {
      await service.stop();
      assert.equal(clock.tasks.size, 0);
    }
  });
