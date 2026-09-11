import assert from "node:assert/strict";
import { test } from "vitest";
import { createSyncLoaders, type SyncDependencies } from "../src/sync/sync-loaders.js";

const loaderCases = [
  ["setupSwitch", "loadSetupSwitch"],
  ["snapshot", "loadSnapshot"],
  ["syncState", "loadSyncState"],
  ["operations", "loadSyncOperations"],
] as const;

for (const [method, dependency] of loaderCases) {
  test(`${method} shares pending loads, retries failure, and caches only its own instance`, async () => {
    let attempts = 0;
    let rejectLoad: ((error: Error) => void) | undefined;
    const module = {};
    const failure = new Error("injected module load failure");
    const dependencies: Partial<SyncDependencies> = {
      [dependency]: () => {
        attempts += 1;
        if (attempts === 1) {
          return new Promise<never>((_resolve, reject) => {
            rejectLoad = reject;
          });
        }
        return Promise.resolve(module as never);
      },
    };
    const loaders = createSyncLoaders(dependencies);
    assert.equal(attempts, 0, "constructing loaders must not load implementations");
    const first = loaders[method]();
    const concurrent = loaders[method]();
    assert.equal(first, concurrent);
    assert.equal(attempts, 1);
    const failed = assert.rejects(first, (error) => error === failure);
    assert.ok(rejectLoad);
    rejectLoad(failure);
    await failed;
    assert.equal(await loaders[method](), module);
    assert.equal(await loaders[method](), module);
    assert.equal(attempts, 2);
    const replacement = createSyncLoaders(dependencies);
    assert.equal(await replacement[method](), module);
    assert.equal(attempts, 3, "a new extension instance must own its own module cache");
  });
}
