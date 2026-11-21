import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { test } from "vitest";
import { legacyLocalConfigPath, localConfigPath, withLocalConfigFileLock } from "../src/settings/config-file.js";
import { addSyncSetup, saveNewV3Settings, updateSyncSetup } from "../src/settings/settings-management.js";
import { localConfigTemplate, updateLocalConfig } from "../src/settings/settings-store.js";
import type { SyncSetupSettings } from "../src/settings/settings-types.js";
import { v3S3Settings, withTempHome } from "./helpers.js";

const connection = { ...v3S3Settings().storageConnections.r2, type: "s3" as const };
const directorySetup: SyncSetupSettings = {
  storage: { connection: "r2", bucket: "pi-sync-test", path: "directory" },
  sync: { scope: "agent-directory", automatic: false },
};
const unsupported = /Unsupported pi-sync settings/u;

test("directory setup writers cannot relabel version 8 settings", () =>
  withTempHome(async (root) => {
    await fs.mkdir(root, { recursive: true });
    const empty = { ...localConfigTemplate(), version: 8, future: { preserve: true } };
    const firstSave = JSON.stringify(empty);
    await fs.writeFile(localConfigPath(), firstSave, { mode: 0o600 });
    await assert.rejects(
      saveNewV3Settings({ setupName: "directory", connectionName: "r2", connection, setup: directorySetup }),
      unsupported,
    );
    assert.equal(await fs.readFile(localConfigPath(), "utf8"), firstSave);

    const configured = JSON.stringify({ ...v3S3Settings(), version: 8, future: empty.future });
    await fs.writeFile(localConfigPath(), configured, { mode: 0o600 });
    await assert.rejects(addSyncSetup("directory", directorySetup), unsupported);
    await assert.rejects(
      updateSyncSetup("home", () => directorySetup),
      unsupported,
    );
    assert.equal(await fs.readFile(localConfigPath(), "utf8"), configured);
  }));

test("the writer validates the latest source after acquiring the lock, before calling update", () =>
  withTempHome(async () => {
    await updateLocalConfig(() => localConfigTemplate());
    let attempted = false;
    let rejected: Promise<void> | undefined;
    const replacement = JSON.stringify({ ...localConfigTemplate(), version: 8 });
    await withLocalConfigFileLock(async () => {
      rejected = assert.rejects(
        updateLocalConfig((settings) => {
          attempted = true;
          return { ...settings, version: 7 };
        }),
        unsupported,
      );
      await fs.writeFile(localConfigPath(), replacement);
    });
    await rejected;
    assert.equal(attempted, false);
    assert.equal(await fs.readFile(localConfigPath(), "utf8"), replacement);
  }));

test.each([
  ['{"version":3', /Invalid JSON/u],
  [JSON.stringify({ ...localConfigTemplate(), showStatus: "invalid" }), /showStatus must be boolean/u],
])("the writer does not replace malformed settings: %s", (original, error) =>
  withTempHome(async (root) => {
    await fs.mkdir(root, { recursive: true });
    await fs.writeFile(localConfigPath(), original, { mode: 0o600 });
    await assert.rejects(
      updateLocalConfig(() => localConfigTemplate()),
      error,
    );
    assert.equal(await fs.readFile(localConfigPath(), "utf8"), original);
  }),
);

test("an unsupported legacy source is not migrated to the canonical filename", () =>
  withTempHome(async (root) => {
    await fs.mkdir(root, { recursive: true });
    const original = JSON.stringify({ ...localConfigTemplate(), version: 8 });
    await fs.writeFile(legacyLocalConfigPath(), original, { mode: 0o600 });
    await assert.rejects(
      updateLocalConfig(() => localConfigTemplate()),
      unsupported,
    );
    await assert.rejects(fs.stat(localConfigPath()), { code: "ENOENT" });
    assert.equal(await fs.readFile(legacyLocalConfigPath(), "utf8"), original);
  }));

test("a supported filename migration retains the original and can promote valid settings to version 7", () =>
  withTempHome(async (root) => {
    await fs.mkdir(root, { recursive: true });
    const source = { ...localConfigTemplate(), future: { preserve: true } };
    const original = `${JSON.stringify(source)}\n`;
    await fs.writeFile(legacyLocalConfigPath(), original, { mode: 0o600 });
    await saveNewV3Settings({
      setupName: "directory",
      connectionName: "r2",
      connection,
      setup: directorySetup,
    });
    const saved = JSON.parse(await fs.readFile(localConfigPath(), "utf8"));
    assert.equal(saved.version, 7);
    assert.deepEqual(saved.future, source.future);
    assert.deepEqual(saved.syncSetups.directory, directorySetup);
    assert.equal(await fs.readFile(legacyLocalConfigPath(), "utf8"), original);
  }));
