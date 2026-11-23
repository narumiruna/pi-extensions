import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "vitest";
import { configureEngineHost } from "../src/engine/host.js";
import { loadConfigForCheck, loadSettingsConfig, syncCheckConfigFingerprint } from "../src/engine/settings/config.js";
import { withConfigPublicationReadyHookForTest } from "../src/engine/settings/config-file.js";
import {
  addSyncSetup,
  SyncSetupReviewChangedError,
  saveNewV3Settings,
  updateSyncSetup,
} from "../src/engine/settings/settings-management.js";
import { readLocalConfigObject, updateLocalConfig } from "../src/engine/settings/settings-store.js";
import type { PiSyncSettingsV3, SyncSetupSettings } from "../src/engine/settings/settings-types.js";
import { validateSettingsDocument } from "../src/engine/settings/settings-validation.js";

const fields = ["maxFileSizeMiB", "maxDirectorySizeMiB"] as const;
const connection = { type: "git", remote: "https://example.invalid/sync.git" } as const;
const originalSetup: SyncSetupSettings = {
  storage: { connection: "origin", path: "home", branch: "sync" },
  sync: { include: ["settings.json"], automatic: true, futurePolicy: { preserve: true } },
};

function settings(version: PiSyncSettingsV3["version"]): PiSyncSettingsV3 {
  return {
    version,
    onSwitch: "switch-only",
    activeSyncSetup: "home",
    storageConnections: { origin: connection },
    syncSetups: { home: structuredClone(originalSetup) },
    future: { preserve: true },
  };
}

async function fixture(run: (settingsPath: string) => Promise<void>) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "pi-sync-transfer-limit-settings-")));
  configureEngineHost({ root: () => root, mutate: async (_file, action) => action(), review: async () => false });
  try {
    await run(path.join(root, "pi-sync.json"));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

function withLimit(setup: SyncSetupSettings, field: (typeof fields)[number], limit: number): SyncSetupSettings {
  return { ...setup, sync: { ...setup.sync, [field]: limit } };
}

test.each(fields)("%s independently requires version 9 and a positive whole MiB with a safe byte count", (field) => {
  for (const version of [3, 4, 5, 6, 7, 8] as const) {
    const document = settings(version);
    document.syncSetups.home = withLimit(document.syncSetups.home, field, 1);
    assert.throws(() => validateSettingsDocument(document), /requires explicit settings version 9/u);
  }
  const document = settings(9);
  const largest = Math.floor(Number.MAX_SAFE_INTEGER / 1_048_576);
  for (const invalid of [0, -1, 0.5, 1.5, null, true, "1", [], {}, Number.NaN, Infinity, largest + 1]) {
    assert.throws(
      () =>
        validateSettingsDocument({
          ...document,
          syncSetups: { home: { ...originalSetup, sync: { ...originalSetup.sync, [field]: invalid } } },
        }),
      /must be a positive whole number of MiB with a safe byte count/u,
    );
  }
  for (const valid of [1, largest]) {
    document.syncSetups.home = withLimit(document.syncSetups.home, field, valid);
    assert.equal(validateSettingsDocument(document).syncSetups.home.sync[field], valid);
  }
});

test("limits advance an old document only when first enabled; clearing them never downgrades it", () =>
  fixture(async (file) => {
    assert.equal(await readLocalConfigObject(), undefined);
    await assert.rejects(loadSettingsConfig(), /Missing pi-sync settings/u);
    assert.deepEqual(await fs.readdir(path.dirname(file)), []);
    const original = settings(3);
    const bytes = `${JSON.stringify(original)}\n`;
    await fs.writeFile(file, bytes, { mode: 0o600 });
    const off = await loadSettingsConfig();
    assert.equal(off.settingsVersion, 3);
    for (const field of fields) assert.equal(Object.hasOwn(off, field), false);
    assert.equal(await fs.readFile(file, "utf8"), bytes);
    const offFingerprint = syncCheckConfigFingerprint(off);
    assert.equal(offFingerprint, syncCheckConfigFingerprint(await loadConfigForCheck()));
    await updateSyncSetup("home", (current) => current);
    assert.equal(await fs.readFile(file, "utf8"), bytes);

    await updateSyncSetup("home", (setup) => withLimit(setup, "maxFileSizeMiB", 3), {
      expectedActiveSetup: true,
      expectedConfigFingerprint: offFingerprint,
    });
    const fileLimit = await loadSettingsConfig();
    assert.equal(fileLimit.settingsVersion, 9);
    assert.equal(fileLimit.maxFileSizeMiB, 3);
    assert.equal(Object.hasOwn(fileLimit, "maxDirectorySizeMiB"), false);
    assert.notEqual(syncCheckConfigFingerprint(fileLimit), offFingerprint);
    await updateSyncSetup("home", (setup) => withLimit(setup, "maxDirectorySizeMiB", 7));
    const both = await loadConfigForCheck();
    assert.equal(both.maxFileSizeMiB, 3);
    assert.equal(both.maxDirectorySizeMiB, 7);
    assert.notEqual(syncCheckConfigFingerprint(both), syncCheckConfigFingerprint(fileLimit));
    await updateSyncSetup("home", (setup) => {
      const { maxFileSizeMiB: _fileLimit, maxDirectorySizeMiB: _directoryLimit, ...sync } = setup.sync;
      return { ...setup, sync };
    });
    const cleared = await loadSettingsConfig();
    assert.equal(cleared.settingsVersion, 9);
    assert.equal(syncCheckConfigFingerprint(cleared), offFingerprint);
    assert.deepEqual(await readLocalConfigObject(), { ...original, version: 9 });
    const finalBytes = await fs.readFile(file, "utf8");
    await assert.rejects(
      updateLocalConfig((current) => ({ ...current, version: 8 })),
      /cannot be downgraded/u,
    );
    assert.equal(await fs.readFile(file, "utf8"), finalBytes);
    if (process.platform !== "win32") assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
  }));

test("creating a setup can opt in or preserve version 9 across ignore-file setup edits", () =>
  fixture(async () => {
    const limited = withLimit(originalSetup, "maxDirectorySizeMiB", 10);
    const saved = await saveNewV3Settings({ setupName: "home", connectionName: "origin", connection, setup: limited });
    assert.equal(saved.version, 9);
    const rulesSetup: SyncSetupSettings = {
      storage: { ...originalSetup.storage, path: "work" },
      sync: { scope: "agent-directory", pathPolicy: "ignore-file", automatic: false },
    };
    await addSyncSetup("work", rulesSetup);
    await updateSyncSetup("work", (setup) => {
      assert.equal(setup.sync.pathPolicy, "ignore-file");
      return { ...setup, sync: { ...setup.sync, sessions: true } };
    });
    const persisted = await readLocalConfigObject();
    assert.ok(persisted);
    assert.equal(persisted.version, 9);
    assert.deepEqual(persisted.syncSetups.home, limited);
    assert.equal(persisted.syncSetups.work.sync.sessions, true);
  }));

test("ordered settings writer rejects an inactive setup or a stale policy review before applying a limit", () =>
  fixture(async (file) => {
    await fs.writeFile(file, JSON.stringify(settings(8)), { mode: 0o600 });
    await addSyncSetup("work", { ...originalSetup, storage: { ...originalSetup.storage, path: "work" } });
    const reviewed = await loadSettingsConfig();
    const options = { expectedActiveSetup: true, expectedConfigFingerprint: syncCheckConfigFingerprint(reviewed) };
    const edit = () => updateSyncSetup("home", () => assert.fail("Stale settings review reached the updater"), options);
    const switchToWork = updateLocalConfig((current) => ({ ...current, activeSyncSetup: "work" }));
    await Promise.all([switchToWork, assert.rejects(edit(), SyncSetupReviewChangedError)]);
    assert.equal((await loadSettingsConfig("home")).maxFileSizeMiB, undefined);
    await updateLocalConfig((current) => ({ ...current, activeSyncSetup: "home" }));
    await updateSyncSetup("home", (setup) => withLimit(setup, "maxDirectorySizeMiB", 5));
    await assert.rejects(edit(), SyncSetupReviewChangedError);
    assert.equal((await loadSettingsConfig("home")).maxDirectorySizeMiB, 5);
  }));

test.each(["publication failure", "source edit"] as const)("failed opt-in (%s) leaves the queue usable", (cause) =>
  fixture(async (file) => {
    const original = JSON.stringify(settings(8));
    const changed = `${original}\n\n`;
    await fs.writeFile(file, original, { mode: 0o600 });
    const edit = () => updateSyncSetup("home", (setup) => withLimit(setup, "maxFileSizeMiB", 1));
    await assert.rejects(
      withConfigPublicationReadyHookForTest(async () => {
        if (cause === "source edit") await fs.writeFile(file, changed);
        else throw new Error("injected write failure");
      }, edit),
      cause === "source edit" ? /settings changed/iu : /injected write failure/u,
    );
    assert.equal(await fs.readFile(file, "utf8"), cause === "source edit" ? changed : original);
    assert.equal((await loadSettingsConfig()).settingsVersion, 8);
    await edit();
    assert.equal((await loadSettingsConfig()).settingsVersion, 9);
    assert.equal((await loadSettingsConfig()).maxFileSizeMiB, 1);
  }),
);
