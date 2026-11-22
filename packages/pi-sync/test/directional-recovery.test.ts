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
  const run = vi.fn(async (checkpoint: DirectionalCheckpoint, retry?: string) => {
    assert.equal(checkpoint.connection, retry ? replacement : original);
    capture(checkpoint);
    if (retry) assert.equal(retry, scope);
    return noWrite;
  });
  await assert.rejects(
    runDirectionalRecovery(original, new AbortController().signal, run, recover, required),
    /one recovery attempt\. No transfer was applied/u,
  );
  assert.equal(run.mock.calls.length, 2);
  assert.equal(recover.mock.calls.length, 1);
  assert.equal(required.mock.calls.length, 2);
});

test("a missing checkpoint or an already cancelled action cannot restart or replay", async () => {
  const cancel = new AbortController();
  const recover = vi.fn(async () => replacement);
  const run = vi.fn(async (checkpoint: DirectionalCheckpoint) => {
    checkpoint.job = "job";
    return noWrite;
  });
  await assert.rejects(
    runDirectionalRecovery(original, cancel.signal, run, recover, () => {}),
    /No transfer was applied.*scope could not be verified/u,
  );
  cancel.abort();
  await assert.rejects(
    runDirectionalRecovery(original, cancel.signal, run, recover, () => {}),
    { name: "AbortError" },
  );
  assert.equal(recover.mock.calls.length, 0);
});

test("a verified transfer is never replayed and retains restore instructions if reattachment fails", async () => {
  const run = vi.fn(async (checkpoint: DirectionalCheckpoint) => {
    checkpoint.job = "job";
    return completed;
  });
  assert.equal(
    await runDirectionalRecovery(
      original,
      new AbortController().signal,
      run,
      async () => replacement,
      () => {},
    ),
    verified,
  );
  await assert.rejects(
    runDirectionalRecovery(
      original,
      new AbortController().signal,
      run,
      async () => {
        throw new Error("Another live Pi session still uses this daemon.");
      },
      () => {},
    ),
    /transfer finished.*Another live Pi session.*Local backup/u,
  );
  assert.equal(run.mock.calls.length, 2);
});
