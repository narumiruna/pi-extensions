import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test, vi } from "vitest";
import { createMockContext } from "../../../test/support.js";
import { executeCommand } from "../src/commands/command-execution.js";
import * as configFile from "../src/settings/config-file.js";
import * as settingsStore from "../src/settings/settings-store.js";
import { createSyncLoaders } from "../src/sync/sync-loaders.js";
import { withTempHome } from "./helpers.js";

for (const existing of [false, true]) {
  test(`RPC init cancelled during the initial ${existing ? "existing" : "missing"} settings read has no effects`, async () => {
    await withTempHome(async () => {
      const started = deferred<void>();
      const release = deferred<void>();
      const owner = new AbortController();
      const context = createMockContext({ mode: "rpc" });
      const read = vi.spyOn(settingsStore, "readLocalConfigObject").mockImplementation(async () => {
        started.resolve();
        await release.promise;
        return existing ? settingsStore.localConfigTemplate() : undefined;
      });
      const create = vi.spyOn(configFile, "createLocalConfigDocument");
      const running = executeCommand("init", context.ctx, owner.signal, createSyncLoaders({}));
      try {
        await started.promise;
        owner.abort(new DOMException("Session replaced", "AbortError"));
        release.resolve();
        assert.deepEqual(await running, { kind: "failed" });
        assert.equal(create.mock.calls.length, 0);
        assert.equal(existsSync(configFile.localConfigPath()), false);
        assert.deepEqual(context.notifications, []);
      } finally {
        release.resolve();
        read.mockRestore();
        create.mockRestore();
        await running;
      }
    });
  });
}

test("RPC init forwards cancellation into its settings writer", async () => {
  await withTempHome(async () => {
    const started = deferred<void>();
    const release = deferred<void>();
    const owner = new AbortController();
    const context = createMockContext({ mode: "rpc" });
    const createDocument = configFile.createLocalConfigDocument;
    let writerSignal: AbortSignal | undefined;
    const create = vi.spyOn(configFile, "createLocalConfigDocument").mockImplementation(async (value, signal) => {
      writerSignal = signal;
      started.resolve();
      await release.promise;
      return createDocument(value, signal);
    });
    const running = executeCommand("init", context.ctx, owner.signal, createSyncLoaders({}));
    try {
      await started.promise;
      assert.equal(writerSignal, owner.signal);
      owner.abort(new DOMException("Shutdown", "AbortError"));
      release.resolve();
      assert.deepEqual(await running, { kind: "failed" });
      assert.equal(existsSync(configFile.localConfigPath()), false);
      assert.deepEqual(context.notifications, []);
    } finally {
      release.resolve();
      create.mockRestore();
      await running;
    }
  });
});

test("RPC init without cancellation still creates the default document", async () => {
  await withTempHome(async () => {
    const context = createMockContext({ mode: "rpc" });
    assert.deepEqual(await executeCommand("init", context.ctx, undefined, createSyncLoaders({})), {
      kind: "completed",
    });
    assert.deepEqual(
      JSON.parse(readFileSync(configFile.localConfigPath(), "utf8")),
      settingsStore.localConfigTemplate(),
    );
    assert.match(context.notifications.at(-1)?.message ?? "", /Created/u);
  });
});

for (const args of ["init unexpected", "init --force", "init --setup home"]) {
  test(`RPC ${args} retains exact direct-route validation`, async () => {
    await withTempHome(async () => {
      const context = createMockContext({ mode: "rpc" });
      const read = vi.spyOn(settingsStore, "readLocalConfigObject");
      try {
        assert.deepEqual(await executeCommand(args, context.ctx, undefined, createSyncLoaders({})), { kind: "failed" });
        assert.equal(read.mock.calls.length, 0);
        assert.equal(existsSync(configFile.localConfigPath()), false);
        assert.equal(context.notifications.at(-1)?.level, "error");
      } finally {
        read.mockRestore();
      }
    });
  });
}

function deferred<Value>() {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>((complete) => (resolve = complete));
  return { promise, resolve };
}
