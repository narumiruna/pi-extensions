import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import { setImmediate } from "node:timers/promises";
import { test, vi } from "vitest";
import { loadConfig, loadConfigForCheck } from "../src/settings/config.js";
import {
  activeLocalConfigPath,
  createLocalConfigDocument,
  localConfigPath,
  readActiveLocalConfigDocumentForRepair,
  readMigratingLocalConfigDocument,
  withConfigPublicationReadyHookForTest,
} from "../src/settings/config-file.js";
import { readLocalConfigDocument, readLocalConfigObject, updateLocalConfig } from "../src/settings/settings-store.js";
import type { PiSyncSettingsV3 } from "../src/settings/settings-types.js";
import { validateSettingsDocument } from "../src/settings/settings-validation.js";
import { v3S3Settings, withTempHome } from "./helpers.js";

function deferred() {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function pauseSettingsLockStart(agentDir: string, failure?: Error) {
  const entered = deferred();
  const release = deferred();
  const original = fs.mkdir.bind(fs);
  let paused = false;
  const spy = vi.spyOn(fs, "mkdir").mockImplementation(async (...args) => {
    if (!paused && args[0] === agentDir) {
      paused = true;
      entered.resolve();
      await release.promise;
      if (failure) throw failure;
    }
    return original(...args);
  });
  return { entered: entered.promise, release: release.resolve, restore: () => spy.mockRestore() };
}

const readers: Array<{ name: string; read: () => Promise<unknown>; expected: () => unknown }> = [
  { name: "settings object", read: async () => (await readLocalConfigObject())?.debug, expected: () => true },
  {
    name: "settings document",
    read: async () => (await readLocalConfigDocument())?.parsed.debug,
    expected: () => true,
  },
  {
    name: "repair document",
    read: async () => (await readActiveLocalConfigDocumentForRepair())?.parsed.debug,
    expected: () => true,
  },
  {
    name: "migrating document",
    read: async () => (await readMigratingLocalConfigDocument(validateSettingsDocument))?.parsed.debug,
    expected: () => true,
  },
  { name: "resolved config", read: async () => (await loadConfig()).debug, expected: () => true },
  { name: "background config check", read: async () => (await loadConfigForCheck()).debug, expected: () => true },
  { name: "active path", read: activeLocalConfigPath, expected: localConfigPath },
];

for (const existing of [false, true]) {
  for (const reader of readers) {
    test(`${reader.name} waits for a prior save before lock acquisition (existing file: ${existing})`, async () => {
      await withTempHome(async (agentDir) => {
        if (existing) {
          await fs.mkdir(agentDir, { recursive: true });
          await fs.writeFile(localConfigPath(), JSON.stringify({ ...v3S3Settings(), debug: false }));
        }
        const paused = pauseSettingsLockStart(agentDir);
        const save = updateLocalConfig(() => ({ ...v3S3Settings(), debug: true }) as PiSyncSettingsV3);
        let read: Promise<unknown> | undefined;
        let lstat: ReturnType<typeof vi.spyOn> | undefined;
        try {
          await paused.entered;
          lstat = vi.spyOn(fs, "lstat");
          read = reader.read();
          await setImmediate();
          const readsBeforeSaveReleased = lstat.mock.calls.length;
          paused.release();
          await save;
          const result = await read;
          assert.equal(readsBeforeSaveReleased, 0, "the reader entered storage ahead of the earlier save");
          assert.equal(result, reader.expected());
        } finally {
          paused.release();
          paused.restore();
          lstat?.mockRestore();
          await Promise.allSettled([save, ...(read ? [read] : [])]);
        }
      });
    });
  }
}

for (const failureBoundary of ["lock-start", "publication"] as const) {
  test(`reads wait for a failed ${failureBoundary} save and later operations remain ordered`, async () => {
    await withTempHome(async (agentDir) => {
      await fs.mkdir(agentDir, { recursive: true });
      const before = Buffer.from(`${JSON.stringify({ ...v3S3Settings(), debug: false })}\n`);
      await fs.writeFile(localConfigPath(), before, { mode: 0o600 });
      const failure = new Error("injected ordered settings failure");
      const entered = deferred();
      const release = deferred();
      const paused = failureBoundary === "lock-start" ? pauseSettingsLockStart(agentDir, failure) : undefined;
      const run = async () => {
        const save = updateLocalConfig((settings) => ({ ...settings, debug: true }));
        const rejected = assert.rejects(save, /injected ordered settings failure/u);
        let read: ReturnType<typeof readLocalConfigObject> | undefined;
        let laterSave: ReturnType<typeof updateLocalConfig> | undefined;
        let check: ReturnType<typeof loadConfigForCheck> | undefined;
        let lstat: ReturnType<typeof vi.spyOn> | undefined;
        try {
          await (paused?.entered ?? entered.promise);
          lstat = vi.spyOn(fs, "lstat");
          read = readLocalConfigObject();
          laterSave = updateLocalConfig((settings) => ({ ...settings, showStatus: false }));
          check = loadConfigForCheck();
          await setImmediate();
          const readsBeforeFailureReleased = lstat.mock.calls.length;
          paused?.release();
          release.resolve();
          await rejected;
          assert.equal((await read)?.debug, false);
          await laterSave;
          assert.equal((await check).showStatus, false);
          assert.equal((await check).debug, false);
          assert.equal(readsBeforeFailureReleased, 0);
        } finally {
          paused?.release();
          release.resolve();
          lstat?.mockRestore();
          await Promise.allSettled([
            save,
            ...(read ? [read] : []),
            ...(laterSave ? [laterSave] : []),
            ...(check ? [check] : []),
          ]);
        }
      };
      try {
        if (failureBoundary === "publication") {
          let first = true;
          await withConfigPublicationReadyHookForTest(async () => {
            if (!first) return;
            first = false;
            entered.resolve();
            await release.promise;
            throw failure;
          }, run);
        } else {
          await run();
        }
        assert.equal((await readLocalConfigObject())?.debug, false);
        assert.equal((await readLocalConfigObject())?.showStatus, false);
      } finally {
        paused?.release();
        paused?.restore();
      }
    });
  });
}

test("first creation and subsequent mutation share request order with reads", async () => {
  await withTempHome(async (agentDir) => {
    const paused = pauseSettingsLockStart(agentDir);
    const create = createLocalConfigDocument({ ...v3S3Settings(), debug: false });
    let update: ReturnType<typeof updateLocalConfig> | undefined;
    let read: ReturnType<typeof readLocalConfigObject> | undefined;
    try {
      await paused.entered;
      update = updateLocalConfig((settings) => ({ ...settings, debug: true, unknown: { keep: true } }));
      read = readLocalConfigObject();
      paused.release();
      await create;
      await update;
      assert.equal((await read)?.debug, true);
      assert.deepEqual((await read)?.unknown, { keep: true });
    } finally {
      paused.release();
      paused.restore();
      await Promise.allSettled([create, ...(update ? [update] : []), ...(read ? [read] : [])]);
    }
  });
});

test("a failed queued read does not poison a later mutation or read", async () => {
  await withTempHome(async (agentDir) => {
    await fs.mkdir(agentDir, { recursive: true });
    await fs.writeFile(localConfigPath(), "{broken");
    await assert.rejects(readLocalConfigObject(), /Invalid JSON/u);
    await fs.writeFile(localConfigPath(), JSON.stringify(v3S3Settings()));
    const save = updateLocalConfig((settings) => ({ ...settings, debug: true }));
    const read = loadConfigForCheck();
    await save;
    assert.equal((await read).debug, true);
  });
});

test("queued missing-file reads remain side-effect free after an aborted creation", async () => {
  await withTempHome(async (agentDir) => {
    const controller = new AbortController();
    controller.abort();
    const create = createLocalConfigDocument(v3S3Settings(), controller.signal);
    const rejected = assert.rejects(create, { name: "AbortError" });
    const reads = [
      readLocalConfigObject(),
      readActiveLocalConfigDocumentForRepair(),
      readMigratingLocalConfigDocument(validateSettingsDocument),
      activeLocalConfigPath(),
    ];
    await rejected;
    assert.deepEqual(await Promise.all(reads), [undefined, undefined, undefined, localConfigPath()]);
    assert.equal(existsSync(agentDir), false);
  });
});
