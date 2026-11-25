import assert from "node:assert/strict";
import type { DaemonConnection } from "@narumitw/pi-sync-daemon";
import { test, vi } from "vitest";
import {
  CompletedDirectionalRecoveryError,
  type DirectionalCheckpoint,
  type PendingAdoptionRecovery,
  runDirectionalRecovery,
} from "../src/daemon/directional-recovery.js";

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

test("a blocked adoption can be retried from the same owner without replaying the original request", async () => {
  const journal = "f".repeat(64);
  let pending: PendingAdoptionRecovery | undefined;
  const retain = (result: PendingAdoptionRecovery | undefined) => {
    pending = result;
  };
  const controller = new AbortController();
  const run = vi.fn(async (checkpoint: DirectionalCheckpoint, retry?: string, resume?: string) => {
    if (resume === undefined) {
      capture(checkpoint);
      return { foregroundQueueCleanup: "resume-adoption", journal };
    }
    assert.equal(retry, undefined);
    assert.equal(resume, journal);
    assert.equal(checkpoint.connection, replacement);
    return verified;
  });
  await assert.rejects(
    runDirectionalRecovery(
      original,
      controller.signal,
      run,
      async () => {
        throw new Error("Another live Pi session uses this daemon.");
      },
      () => {},
      { retain },
    ),
    /Pull recovery stopped.*journal was kept.*Another live Pi session/u,
  );
  assert.deepEqual(pending, { owner: original, job: "job", journal });
  assert.equal(run.mock.calls.length, 1);
  await assert.rejects(
    runDirectionalRecovery(
      replacement,
      controller.signal,
      run,
      async () => replacement,
      () => {},
      { pending, retain },
    ),
    /daemon changed/u,
  );
  const recover = vi.fn(async () => replacement);
  assert.equal(
    await runDirectionalRecovery(original, controller.signal, run, recover, () => {}, { pending, retain }),
    verified,
  );
  assert.deepEqual(recover.mock.calls[0]?.slice(0, 2), [original, "job"]);
  assert.equal(run.mock.calls.length, 2);
  assert.equal(pending, undefined);
});

test("cancelling after owner exit does not submit the adoption again", async () => {
  const controller = new AbortController();
  const pending = { owner: original, job: "job", journal: "f".repeat(64) };
  const retain = vi.fn();
  const run = vi.fn(async () => verified);
  await assert.rejects(
    runDirectionalRecovery(
      original,
      controller.signal,
      run,
      async () => {
        controller.abort();
        return replacement;
      },
      () => {},
      { pending, retain },
    ),
    { name: "AbortError" },
  );
  assert.equal(run.mock.calls.length, 0);
  assert.deepEqual(retain.mock.calls, [[pending], [undefined]]);
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

test.each(["before recovery", "during recovery", "at reattachment", "on retry"] as const)(
  "cancellation %s reports a verified transfer and retains the abort cause",
  async (phase) => {
    const cancel = new AbortController();
    const reason = new Error("Stopped by test");
    const run = vi.fn(async (checkpoint: DirectionalCheckpoint, retry?: string) => {
      capture(checkpoint);
      if (phase === "on retry" && !retry) return noWrite;
      if (phase === "before recovery" || phase === "on retry") cancel.abort(reason);
      return completed;
    });
    const recover = vi.fn(async () => {
      if (phase === "during recovery" || phase === "at reattachment") cancel.abort(reason);
      if (phase === "during recovery") throw new Error("Interrupted recovery RPC");
      return replacement;
    });
    const required = vi.fn();
    await assert.rejects(runDirectionalRecovery(original, cancel.signal, run, recover, required), (error) => {
      assert.ok(error instanceof CompletedDirectionalRecoveryError);
      assert.equal(error.name, "AbortError");
      assert.equal(error.cause, reason);
      assert.match(error.message, /transfer finished.*recovery was cancelled.*Local backup: \/test\/restore\.json/u);
      return true;
    });
    assert.equal(recover.mock.calls.length, phase === "before recovery" ? 0 : 1);
    assert.equal(run.mock.calls.length, phase === "on retry" ? 2 : 1);
    assert.equal(required.mock.calls.length, run.mock.calls.length);
  },
);

test("cancelling recovery before any write preserves the original abort without retrying", async () => {
  const cancel = new AbortController();
  const reason = new DOMException("Stopped by test", "AbortError");
  const run = vi.fn(async (checkpoint: DirectionalCheckpoint) => {
    capture(checkpoint);
    return noWrite;
  });
  const recover = async () => {
    cancel.abort(reason);
    return replacement;
  };
  await assert.rejects(
    runDirectionalRecovery(original, cancel.signal, run, recover, () => {}),
    (error) => error === reason,
  );
  assert.equal(run.mock.calls.length, 1);
});
