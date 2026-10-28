import assert from "node:assert/strict";
import { test } from "vitest";
import { createLoaderQueue } from "./loader-queue.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("aborted Jiti reload is drained before another loader or fixture cleanup", async () => {
  const queue = createLoaderQueue();
  const started = deferred();
  const reloaded = deferred();
  const controller = new AbortController();
  const events: string[] = [];
  const runtime = { invalidate: () => events.push("invalidate") };
  const first = queue.run(
    () => ({
      reload: async () => {
        events.push("first");
        started.resolve();
        await reloaded.promise;
      },
      getExtensions: () => ({ runtime }),
    }),
    controller.signal,
    () => events.push("stale inspection"),
  );
  const rejected = assert.rejects(first, { name: "AbortError" });
  await started.promise;
  controller.abort();
  const second = queue.run(
    () => ({
      reload: async () => {
        events.push("second");
      },
      getExtensions: () => ({ runtime }),
    }),
    new AbortController().signal,
    () => events.push("inspect second"),
  );
  const cleanup = queue.drain().then(() => events.push("cleanup"));
  await Promise.resolve();
  assert.deepEqual(events, ["first"]);
  reloaded.resolve();
  await Promise.all([rejected, second, cleanup]);
  assert.deepEqual(events, ["first", "invalidate", "second", "inspect second", "invalidate", "cleanup"]);
});

test("drains asynchronous lazy command inspection before invalidation and cleanup", async () => {
  const queue = createLoaderQueue();
  const inspecting = deferred();
  const inspected = deferred();
  const events: string[] = [];
  const runtime = { invalidate: () => events.push("invalidate") };
  const work = queue.run(
    () => ({
      reload: async () => {},
      getExtensions: () => ({ runtime }),
    }),
    new AbortController().signal,
    async () => {
      events.push("inspect");
      inspecting.resolve();
      await inspected.promise;
      events.push("inspected");
    },
  );
  await inspecting.promise;
  const draining = queue.drain().then(() => events.push("drained"));
  await Promise.resolve();
  assert.deepEqual(events, ["inspect"]);
  inspected.resolve();
  await Promise.all([work, draining]);
  assert.deepEqual(events, ["inspect", "inspected", "invalidate", "drained"]);
});

test("failed partial Jiti reload invalidates both runtimes and releases the queue", async () => {
  const queue = createLoaderQueue();
  const events: string[] = [];
  let runtime = { invalidate: () => events.push("original") };
  await assert.rejects(
    queue.run(
      () => ({
        reload: async () => {
          runtime = { invalidate: () => events.push("replacement") };
          throw new Error("partial reload failure");
        },
        getExtensions: () => ({ runtime }),
      }),
      new AbortController().signal,
      () => assert.fail("failed reload must not be inspected"),
    ),
    /partial reload failure/u,
  );
  await queue.drain();
  assert.deepEqual(events, ["original", "replacement"]);
});
