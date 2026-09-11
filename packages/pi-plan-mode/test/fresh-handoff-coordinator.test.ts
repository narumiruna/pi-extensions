import assert from "node:assert/strict";
import { test } from "vitest";
import {
  createDeferredFreshHandoffCoordinator,
  type DeferredFreshHandoffDependencies,
} from "../src/fresh-handoff-coordinator.js";

function failOnError(error: unknown): never {
  throw error;
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function createControlledScheduler() {
  const callbacks = new Map<number, () => void>();
  const cancelled: number[] = [];
  let nextHandle = 0;
  const dependencies: DeferredFreshHandoffDependencies = {
    schedule(callback) {
      const handle = ++nextHandle;
      callbacks.set(handle, callback);
      return handle;
    },
    cancel(handle) {
      const numericHandle = handle as number;
      cancelled.push(numericHandle);
      callbacks.delete(numericHandle);
    },
  };
  return {
    dependencies,
    cancelled,
    flush(handle = nextHandle) {
      const callback = callbacks.get(handle);
      callbacks.delete(handle);
      callback?.();
    },
  };
}

test("deferred fresh handoff runs only after its scheduled boundary", async () => {
  const scheduler = createControlledScheduler();
  const coordinator = createDeferredFreshHandoffCoordinator(scheduler.dependencies);
  const completed = deferred<void>();
  let runs = 0;
  coordinator.schedule(async (isCurrent) => {
    runs += 1;
    assert.equal(isCurrent(), true);
    completed.resolve();
  }, failOnError);

  assert.equal(runs, 0);
  scheduler.flush();
  await completed.promise;
  assert.equal(runs, 1);
});

test("new and repeated cancellation release pending fresh handoffs", () => {
  const scheduler = createControlledScheduler();
  const coordinator = createDeferredFreshHandoffCoordinator(scheduler.dependencies);
  let firstRuns = 0;
  let secondRuns = 0;
  coordinator.schedule(async () => {
    firstRuns += 1;
  }, failOnError);
  coordinator.schedule(async () => {
    secondRuns += 1;
  }, failOnError);
  coordinator.cancel();
  coordinator.cancel();

  scheduler.flush(1);
  scheduler.flush(2);
  assert.equal(firstRuns, 0);
  assert.equal(secondRuns, 0);
  assert.deepEqual(scheduler.cancelled, [1, 2]);
});

test("cancellation invalidates running work without awaiting it", async () => {
  const scheduler = createControlledScheduler();
  const coordinator = createDeferredFreshHandoffCoordinator(scheduler.dependencies);
  const started = deferred<() => boolean>();
  const release = deferred<void>();
  const completed = deferred<void>();
  coordinator.schedule(async (isCurrent) => {
    started.resolve(isCurrent);
    await release.promise;
    completed.resolve();
  }, failOnError);
  scheduler.flush();
  const isCurrent = await started.promise;
  assert.equal(isCurrent(), true);

  coordinator.cancel();
  assert.equal(isCurrent(), false);
  release.resolve();
  await completed.promise;
});

test("detached reporter failures do not become unhandled rejections", async () => {
  const scheduler = createControlledScheduler();
  const coordinator = createDeferredFreshHandoffCoordinator(scheduler.dependencies);
  const reported = deferred<void>();
  coordinator.schedule(
    async () => {
      throw new Error("task failure");
    },
    () => {
      reported.resolve();
      throw new Error("reporter failure");
    },
  );
  scheduler.flush();
  await reported.promise;
  await Promise.resolve();
});

test("detached failures are reported only while their handoff is current", async () => {
  for (const cancelled of [false, true]) {
    const scheduler = createControlledScheduler();
    const coordinator = createDeferredFreshHandoffCoordinator(scheduler.dependencies);
    const started = deferred<void>();
    const release = deferred<void>();
    const reported = deferred<unknown>();
    let reports = 0;
    coordinator.schedule(
      async () => {
        started.resolve();
        await release.promise;
        throw new Error("deferred failure");
      },
      (error) => {
        reports += 1;
        reported.resolve(error);
      },
    );
    scheduler.flush();
    await started.promise;
    if (cancelled) coordinator.cancel();
    release.resolve();
    await Promise.resolve();
    await Promise.resolve();
    if (cancelled) {
      assert.equal(reports, 0);
    } else {
      assert.match(String(await reported.promise), /deferred failure/u);
      assert.equal(reports, 1);
    }
  }
});
