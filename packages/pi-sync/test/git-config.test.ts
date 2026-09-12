import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { test } from "vitest";
import {
  normalizeGitBranch,
  normalizeGitDirectory,
  normalizeGitRemote,
  normalizeGitRemoteIdentity,
} from "../src/backends/git/git-config.js";
import { loadConfig } from "../src/settings/config.js";
import { localConfigPath } from "../src/settings/config-file.js";
import { statePathForConfig } from "../src/state/sync-state-store.js";
import { withTempHome } from "./helpers.js";

function gitSettings(path = "pi-sync/home", branch = "pi-sync/home") {
  return {
    version: 3,
    activeSyncSetup: "home",
    onSwitch: "switch-only",
    storageConnections: {
      git: { type: "git", remote: "git@github.com:user/pi-sync.git" },
    },
    syncSetups: {
      home: {
        storage: { connection: "git", branch, path },
        sync: { include: ["settings.json"], automatic: false },
      },
    },
  };
}

test("Git v3 config is credential-free and uses the complete reviewed path", async () => {
  await withTempHome(async (agentDir) => {
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(localConfigPath(), JSON.stringify(gitSettings()), { mode: 0o600 });
    const config = await loadConfig();
    assert.equal(config.backend.type, "git");
    if (config.backend.type !== "git") return;
    assert.equal(config.backend.profile.remote, "git@github.com:user/pi-sync.git");
    assert.equal(config.backend.destination.branch, "pi-sync/home");
    assert.equal(config.backend.destination.directory, "pi-sync/home");
    assert.equal(config.storagePath, "pi-sync/home");
    assert.doesNotMatch(JSON.stringify(config.backend), /password|secretAccessKey/u);
  });
});

test.each([".", "./", " ./ "])("Git root path %j resolves canonically and preserves identity", async (rootPath) => {
  await withTempHome(async (agentDir) => {
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(localConfigPath(), JSON.stringify(gitSettings(rootPath, "main")), {
      mode: 0o600,
    });
    const config = await loadConfig();
    assert.equal(config.storagePath, "./");
    assert.equal(config.snapshotIdentity, "root");
    assert.equal(config.backend.type, "git");
    if (config.backend.type !== "git") return;
    assert.deepEqual(config.backend.destination, {
      branch: "main",
      directory: "./",
      namespace: "root",
    });
    writeFileSync(localConfigPath(), JSON.stringify(gitSettings("./", "main")), { mode: 0o600 });
    assert.equal(statePathForConfig(await loadConfig()), statePathForConfig(config));
  });
});

test("Git state identity changes by remote, branch, and path but not setup name", async () => {
  await withTempHome(async (agentDir) => {
    mkdirSync(agentDir, { recursive: true });
    const firstSettings = gitSettings();
    writeFileSync(localConfigPath(), JSON.stringify(firstSettings), { mode: 0o600 });
    const first = await loadConfig();

    const renamed = gitSettings();
    (renamed.syncSetups as Record<string, typeof renamed.syncSetups.home>).renamed = renamed.syncSetups.home;
    delete (renamed.syncSetups as Record<string, unknown>).home;
    renamed.activeSyncSetup = "renamed";
    writeFileSync(localConfigPath(), JSON.stringify(renamed), { mode: 0o600 });
    assert.equal(statePathForConfig(await loadConfig()), statePathForConfig(first));

    writeFileSync(localConfigPath(), JSON.stringify(gitSettings("other/home")), { mode: 0o600 });
    assert.notEqual(statePathForConfig(await loadConfig()), statePathForConfig(first));
  });
});

test("Git normalization rejects secret-bearing and unsafe transports, refs, and paths", () => {
  assert.equal(normalizeGitRemote("git@github.com:user/repo.git"), "git@github.com:user/repo.git");
  assert.equal(
    normalizeGitRemoteIdentity("ssh://git@EXAMPLE.com:22/user/repo.git/"),
    "ssh://git@example.com/user/repo.git",
  );
  for (const remote of ["https://user:secret@example.com/repo.git", "file:///tmp/repo.git", "ext::helper", "-danger"]) {
    assert.throws(() => normalizeGitRemote(remote), /Git remote/u);
  }
  for (const branch of ["-bad", "refs/heads/main", "bad..name", "bad lock.lock"]) {
    assert.throws(() => normalizeGitBranch(branch), /Git branch/u);
  }
  for (const directory of [
    "../bad",
    ".git/data",
    "bad\\path",
    "./nested",
    "nested/./bad",
    "nested/../bad",
    ".//",
    "/",
    "/./",
  ]) {
    assert.throws(() => normalizeGitDirectory(directory), /Git directory/u);
  }
});
