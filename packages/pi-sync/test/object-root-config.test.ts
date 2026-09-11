import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { test } from "vitest";
import { normalizeWebDavPath } from "../src/backends/webdav/webdav-config.js";
import { loadConfig } from "../src/settings/config.js";
import { localConfigPath } from "../src/settings/config-file.js";
import { addSyncSetup } from "../src/settings/settings-management.js";
import { statePathForConfig } from "../src/state/sync-state-store.js";
import { createSyncBackend } from "./backend-factory-eager.js";
import { v3S3Settings, v3WebDavSettings, withTempHome } from "./helpers.js";

const fixtures = [
  { kind: "WebDAV", settings: () => v3WebDavSettings() },
  { kind: "R2", settings: () => v3S3Settings() },
  {
    kind: "S3",
    settings: () => {
      const settings = v3S3Settings();
      settings.storageConnections.r2.endpoint = "https://s3.example.com";
      settings.storageConnections.r2.region = "us-east-1";
      return settings;
    },
  },
];

for (const fixture of fixtures) {
  test.each([".", "./", " ./ "])(
    `${fixture.kind} root %j has canonical coordinates and survives renaming`,
    async (storagePath) => {
      await withTempHome(async (agentDir) => {
        mkdirSync(agentDir, { recursive: true });
        const settings = fixture.settings();
        settings.syncSetups.home.storage.path = storagePath;
        const before = JSON.stringify(settings);
        writeFileSync(localConfigPath(), before, { mode: 0o600 });
        const config = await loadConfig();
        assert.equal(config.storagePath, "./");
        assert.equal(config.snapshotIdentity, "root");
        assert.equal(config.backend.destination.namespace, "root");
        assert.equal(readFileSync(localConfigPath(), "utf8"), before);
        const backend = createSyncBackend(config);
        const renamed = {
          ...settings,
          activeSyncSetup: "renamed",
          syncSetups: {
            renamed: {
              ...settings.syncSetups.home,
              storage: { ...settings.syncSetups.home.storage, path: "./" },
            },
          },
        };
        writeFileSync(localConfigPath(), JSON.stringify(renamed), { mode: 0o600 });
        const after = await loadConfig();
        assert.equal(statePathForConfig(after), statePathForConfig(config));
        assert.equal(createSyncBackend(after).identity, backend.identity);
      });
    },
  );

  test(`${fixture.kind} duplicate root aliases fail without changing settings`, async () => {
    await withTempHome(async (agentDir) => {
      mkdirSync(agentDir, { recursive: true });
      const settings = fixture.settings();
      settings.syncSetups.home.storage.path = "./";
      const before = JSON.stringify(settings);
      writeFileSync(localConfigPath(), before, { mode: 0o600 });
      await assert.rejects(
        addSyncSetup("other", {
          ...settings.syncSetups.home,
          storage: { ...settings.syncSetups.home.storage, path: "." },
        }),
        /duplicates the storage location/u,
      );
      assert.equal(readFileSync(localConfigPath(), "utf8"), before);
    });
  });

  test.each(["", "/", "/./", ".//", "./nested", "nested/./bad", "nested/../bad", "../bad", "bad\\path"])(
    `${fixture.kind} root support still rejects unsafe path %j`,
    async (storagePath) => {
      await withTempHome(async (agentDir) => {
        mkdirSync(agentDir, { recursive: true });
        const settings = fixture.settings();
        settings.syncSetups.home.storage.path = storagePath;
        writeFileSync(localConfigPath(), JSON.stringify(settings), { mode: 0o600 });
        await assert.rejects(loadConfig(), /storage[. ]path/u);
      });
    },
  );

  test(`${fixture.kind} existing nested paths and settings bytes remain unchanged`, async () => {
    await withTempHome(async (agentDir) => {
      mkdirSync(agentDir, { recursive: true });
      const settings = fixture.settings();
      settings.syncSetups.home.storage.path = "archives/home";
      const before = JSON.stringify(settings);
      writeFileSync(localConfigPath(), before, { mode: 0o600 });
      const config = await loadConfig();
      assert.equal(config.storagePath, "archives/home");
      assert.equal(config.snapshotIdentity, "home");
      assert.equal(readFileSync(localConfigPath(), "utf8"), before);
      settings.syncSetups.home.storage.path = "./";
      writeFileSync(localConfigPath(), JSON.stringify(settings), { mode: 0o600 });
      assert.notEqual(statePathForConfig(await loadConfig()), statePathForConfig(config));
    });
  });
}

test("WebDAV path normalization accepts only explicit root aliases", () => {
  for (const value of [".", "./", " ./ "]) assert.equal(normalizeWebDavPath(value), "./");
  for (const value of ["/", "/./", ".//", "./nested", "nested/./bad", "nested/../bad"]) {
    assert.throws(() => normalizeWebDavPath(value), /WebDAV path/u);
  }
});
