import assert from "node:assert/strict";
import type { DaemonConnection } from "@narumitw/pi-sync-daemon";
import { test, vi } from "vitest";
import { type DirectionalCheckpoint, runDirectionalRecovery } from "../src/daemon/directional-recovery.js";

const original = {} as DaemonConnection;
const replacement = {} as DaemonConnection;
const scope = "a".repeat(64);
const noWrite = { foregroundQueueCleanup: "before-mutation" };
const verified = { outcome: "applied", message: "Local backup: /test/restore.json" };
const completed = { foregroundQueueCleanup: "verified-result", result: verified };

function capture(checkpoint: DirectionalCheckpoint) {
  checkpoint.job = "job";
  assert.equal(checkpoint.accept(checkpoint.connection, "another-job", scope), false);
  assert.equal(checkpoint.accept(checkpoint.connection, "job", scope), true);
  assert.equal(checkpoint.accept(checkpoint.connection, "job", "b".repeat(64)), false);
}

test("the same foreground action verifies a checkpoint and retries only once after a proven pre-write failure", async () => {
  const recover = vi.fn(async () => replacement);
  const required = vi.fn();
  const run = vi.fn(async (checkpoint: DirectionalCheckpoint, _retry?: string) => {
    capture(checkpoint);
    return noWrite;
  });
  await assert.rejects(
    runDirectionalRecovery(original, new AbortController().signal, run, recover, required),
    /one recovery attempt\. No transfer was applied/u,
  );
  assert.equal(run.mock.calls.length, 2);
  const [first, second] = run.mock.calls;
  assert.equal(first?.[0].connection, original);
  assert.equal(first?.[1], undefined);
  assert.equal(second?.[0].connection, replacement);
  assert.equal(second?.[1], scope);
  assert.equal(recover.mock.calls.length, 1);
  assert.equal(required.mock.calls.length, 2);
});

for (const result of [noWrite, completed]) {
  test(`reviewed Force does not replay after ${result.foregroundQueueCleanup}`, async () => {
    const recover = vi.fn(async () => replacement);
    const run = vi.fn(async (checkpoint: DirectionalCheckpoint) => {
      capture(checkpoint);
      return result;
    });
    const transfer = runDirectionalRecovery(original, new AbortController().signal, run, recover, () => {}, false);
    if (result === completed) assert.deepEqual(await transfer, verified);
    else await assert.rejects(transfer, /Start a new review before forcing/u);
    assert.equal(run.mock.calls.length, 1);
    assert.equal(recover.mock.calls.length, 1);
  });
}
