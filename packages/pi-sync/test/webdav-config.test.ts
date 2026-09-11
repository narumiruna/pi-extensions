import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { test } from "vitest";
import {
  normalizeWebDavIdentityUrl,
  normalizeWebDavPath,
  normalizeWebDavUrl,
  validateWebDavCredentials,
} from "../src/backends/webdav/webdav-config.js";
import { loadConfig } from "../src/settings/config.js";
import { localConfigPath } from "../src/settings/config-file.js";
import { statePathForConfig } from "../src/state/sync-state-store.js";
import { v3WebDavSettings, withTempHome } from "./helpers.js";

test("version 3 resolves WebDAV connection credentials and complete storage path", async () => {
  await withTempHome(async (agentDir) => {
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(localConfigPath(), JSON.stringify(v3WebDavSettings()), { mode: 0o600 });
    const config = await loadConfig();
    assert.equal(config.backend.type, "webdav");
    if (config.backend.type !== "webdav") return;
    assert.equal(config.backend.profile.username, "user");
    assert.equal(config.backend.profile.password, "pass");
    assert.equal(config.backend.destination.path, "pi-sync/home");
    assert.equal(config.storagePath, "pi-sync/home");
  });
});

test("WebDAV state identity includes authenticated user and path", async () => {
  await withTempHome(async (agentDir) => {
    mkdirSync(agentDir, { recursive: true });
    const firstSettings = v3WebDavSettings();
    writeFileSync(localConfigPath(), JSON.stringify(firstSettings), { mode: 0o600 });
    const first = await loadConfig();
    const secondSettings = v3WebDavSettings();
    secondSettings.storageConnections.dav.credentials.username = "other";
    writeFileSync(localConfigPath(), JSON.stringify(secondSettings), { mode: 0o600 });
    assert.notEqual(statePathForConfig(first), statePathForConfig(await loadConfig()));
  });
});

test("WebDAV normalization fails closed on unsafe URLs, paths, and credentials", () => {
  assert.equal(normalizeWebDavUrl("https://cloud.example.com/dav"), "https://cloud.example.com/dav/");
  assert.equal(normalizeWebDavPath("/pi-sync/home/"), "pi-sync/home");
  assert.equal(normalizeWebDavIdentityUrl("https://USER:PASS@EXAMPLE.com/dav?q=1#x"), "https://example.com/dav/");
  for (const url of [
    "http://cloud.example.com/dav",
    "https://user:pass@cloud.example.com/dav",
    "https://cloud.example.com/dav?q=1",
  ]) {
    assert.throws(() => normalizeWebDavUrl(url), /WebDAV URL/u);
  }
  for (const remotePath of ["../bad", "bad\\path", "a//b"]) {
    assert.throws(() => normalizeWebDavPath(remotePath), /WebDAV path/u);
  }
  assert.throws(() => validateWebDavCredentials("bad:user", "pass"), /credentials/u);
});
