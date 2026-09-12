import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { test } from "vitest";
import { createSyncBackend as createLazySyncBackend } from "../src/backends/backend-factory.js";
import { loadConfig } from "../src/settings/config.js";
import { localConfigPath } from "../src/settings/config-file.js";
import { readStateForConfig, statePathForConfig, writeStateForConfig } from "../src/state/sync-state-store.js";
import { createSyncBackend } from "./backend-factory-eager.js";
import { v3S3Settings, withTempHome } from "./helpers.js";

function writeSettings(value: unknown) {
  writeFileSync(localConfigPath(), `${JSON.stringify(value, null, "\t")}\n`, { mode: 0o600 });
}

test("version 3 S3 config resolves the reviewed path and secret-free backend identity", async () => {
  await withTempHome(async (agentDir) => {
    mkdirSync(agentDir, { recursive: true });
    writeSettings(v3S3Settings({ path: "pi-sync/home" }));
    const config = await loadConfig();
    const backend = createSyncBackend(config);
    assert.equal(config.storagePath, "pi-sync/home");
    assert.equal(config.backend.type, "s3");
    assert.match(backend.destination, /pi-sync-test\/pi-sync\/home/u);
    assert.doesNotMatch(backend.identity, /access-key|secret-key/u);
  });
});

test("production backend factory loads the selected backend asynchronously", async () => {
  await withTempHome(async (agentDir) => {
    mkdirSync(agentDir, { recursive: true });
    writeSettings(v3S3Settings({ path: "pi-sync/lazy" }));
    const config = await loadConfig();
    const backend = await createLazySyncBackend(config);
    assert.match(backend.destination, /pi-sync-test\/pi-sync\/lazy/u);
  });
});

test("state identity follows normalized remote coordinates and survives a setup rename", async () => {
  await withTempHome(async (agentDir) => {
    mkdirSync(agentDir, { recursive: true });
    const settings = v3S3Settings();
    writeSettings(settings);
    const before = await loadConfig();
    await writeStateForConfig(before, {
      version: 2,
      profile: before.snapshotIdentity,
      lastFileHashes: { "settings.json": "hash" },
      include: ["settings.json"],
    });

    (settings.syncSetups as Record<string, typeof settings.syncSetups.home>).renamed = settings.syncSetups.home;
    delete (settings.syncSetups as Record<string, unknown>).home;
    settings.activeSyncSetup = "renamed";
    writeSettings(settings);
    const after = await loadConfig();
    assert.equal(statePathForConfig(after), statePathForConfig(before));
    assert.deepEqual((await readStateForConfig(after)).lastFileHashes, {
      "settings.json": "hash",
    });
  });
});

test("changing a reviewed storage path gets independent local state", async () => {
  await withTempHome(async (agentDir) => {
    mkdirSync(agentDir, { recursive: true });
    writeSettings(v3S3Settings({ path: "pi-sync/home" }));
    const first = await loadConfig();
    writeSettings(v3S3Settings({ path: "pi-sync/work" }));
    const second = await loadConfig();
    assert.notEqual(statePathForConfig(first), statePathForConfig(second));
  });
});
