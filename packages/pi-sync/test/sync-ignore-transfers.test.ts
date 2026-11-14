import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { test } from "vitest";
import { createMockContext } from "../../../test/support.js";
import { expectedRemoteHead } from "../src/backends/sync-backend.js";
import { loadConfig } from "../src/settings/config.js";
import { localConfigPath } from "../src/settings/config-file.js";
import type { PiSyncSettingsV3 } from "../src/settings/settings-types.js";
import { regenerateSnapshotIdentity } from "../src/snapshot/snapshot.js";
import type { Snapshot } from "../src/snapshot/snapshot-types.js";
import { readStateForConfig } from "../src/state/sync-state-store.js";
import { pull, push, syncBoth } from "../src/sync/sync-mutations.js";
import { RemoteSelectionMismatchError } from "../src/sync/sync-policy.js";
import { snapshot, v3S3Settings, withTempHome } from "./helpers.js";
import { MemorySyncBackend } from "./memory-sync-backend.js";
import { mergeOptions } from "./merge-options.js";

async function fixture(root: string, rules = "/sessions/\n/ignored/\n") {
  await fs.mkdir(root, { recursive: true });
  const settings = v3S3Settings() as unknown as PiSyncSettingsV3;
  settings.version = 6;
  delete settings.syncSetups.home?.sync.include;
  await fs.writeFile(localConfigPath(), JSON.stringify(settings));
  await fs.writeFile(path.join(root, ".syncignore"), rules);
  await fs.writeFile(path.join(root, "settings.json"), "{}\n");
  const backend = new MemorySyncBackend();
  const context = createMockContext({ hasUI: true, mode: "tui" });
  await push(context.ctx, mergeOptions, undefined, () => backend);
  return { backend, ...context, config: await loadConfig(), rules };
}

async function editRemote(backend: MemorySyncBackend, filePath: string, content: string) {
  const head = await backend.readHead();
  assert.ok(head);
  const current = await backend.readSnapshot(head.snapshotRef);
  const changed = snapshot([{ path: filePath, content: Buffer.from(content) }]).files;
  const next = regenerateSnapshotIdentity({
    ...current,
    files: [...current.files.filter((file) => file.path !== filePath), ...changed],
  });
  await backend.publishSnapshot(next, expectedRemoteHead(head));
}

test("ignore-mode push publishes arbitrary files and never credentials or ignored content", async () =>
  withTempHome(async (root) => {
    const { backend, ctx, rules } = await fixture(root);
    await fs.mkdir(path.join(root, "ignored"));
    await fs.writeFile(path.join(root, "ignored/local.txt"), "private");
    await fs.writeFile(path.join(root, "auth.json"), "credential");
    await fs.writeFile(path.join(root, "future.toml"), "new = true\n");
    await push(ctx, mergeOptions, undefined, () => backend);
    const head = await backend.readHead();
    assert.ok(head);
    const current = await backend.readSnapshot(head.snapshotRef);
    assert.deepEqual(current.selection, { version: 2, ignore: rules });
    assert.equal(current.version, 4);
    assert.deepEqual(current.files.map((file) => file.path).sort(), [".syncignore", "future.toml", "settings.json"]);
  }));

test("pull preserves ignored local files while applying remote-only arbitrary paths", async () =>
  withTempHome(async (root) => {
    const { backend, ctx } = await fixture(root);
    await fs.mkdir(path.join(root, "ignored"));
    await fs.writeFile(path.join(root, "ignored/local.txt"), "keep local");
    await editRemote(backend, "remote-only.toml", "new = true\n");
    await editRemote(backend, "ignored/local.txt", "remote old history");
    await pull(ctx, { ...mergeOptions, force: true }, () => backend);
    assert.equal(await fs.readFile(path.join(root, "ignored/local.txt"), "utf8"), "keep local");
    assert.equal(await fs.readFile(path.join(root, "remote-only.toml"), "utf8"), "new = true\n");
  }));

test("merged sync accepts independent arbitrary file additions and preserves version 4", async () =>
  withTempHome(async (root) => {
    const { backend, ctx, config, rules } = await fixture(root);
    await fs.writeFile(path.join(root, "local-new.toml"), "local = true\n");
    await editRemote(backend, "remote-new.toml", "remote = true\n");
    await syncBoth(ctx, mergeOptions, () => backend);
    assert.equal(await fs.readFile(path.join(root, "remote-new.toml"), "utf8"), "remote = true\n");
    const head = await backend.readHead();
    assert.ok(head);
    const published = await backend.readSnapshot(head.snapshotRef);
    assert.equal(published.version, 4);
    assert.deepEqual(published.files.map((file) => file.path).sort(), [
      ".syncignore",
      "local-new.toml",
      "remote-new.toml",
      "settings.json",
    ]);
    assert.equal((await readStateForConfig(config)).syncIgnore, rules);
  }));

test("a remote rule mismatch blocks automatic sync, ordinary push, and even forced pull without mutation", async () =>
  withTempHome(async (root) => {
    const { backend, ctx, config } = await fixture(root);
    const head = await backend.readHead();
    assert.ok(head);
    const current = await backend.readSnapshot(head.snapshotRef);
    const rules = "/sessions/\n/other-private/\n";
    const policyFile = snapshot([{ path: ".syncignore", content: Buffer.from(rules) }]).files;
    const changed: Snapshot = regenerateSnapshotIdentity({
      ...current,
      selection: { version: 2, ignore: rules },
      files: [...current.files.filter((file) => file.path !== ".syncignore"), ...policyFile],
    });
    await backend.publishSnapshot(changed, expectedRemoteHead(head));
    const baseline = await readStateForConfig(config);
    const bytes = await fs.readFile(path.join(root, ".syncignore"));
    for (const operation of [
      () => syncBoth(ctx, { ...mergeOptions, auto: true }, () => backend),
      () => push(ctx, mergeOptions, undefined, () => backend),
      () => pull(ctx, { ...mergeOptions, force: true }, () => backend),
    ])
      await assert.rejects(operation(), RemoteSelectionMismatchError);
    assert.deepEqual(await fs.readFile(path.join(root, ".syncignore")), bytes);
    assert.deepEqual(await readStateForConfig(config), baseline);
    assert.equal((await backend.readHead())?.snapshotId, changed.id);
  }));

test("reviewed force push replaces differing rules without deleting preserved ignored remote files", async () =>
  withTempHome(async (root) => {
    const { backend, ctx, rules } = await fixture(root);
    await editRemote(backend, "ignored/remote.txt", "retained");
    await fs.writeFile(path.join(root, ".syncignore"), `${rules}*.log\n`);
    await push(ctx, { ...mergeOptions, force: true }, undefined, () => backend);
    const head = await backend.readHead();
    assert.ok(head);
    const published = await backend.readSnapshot(head.snapshotRef);
    assert.deepEqual(published.selection, { version: 2, ignore: `${rules}*.log\n` });
    assert.ok(published.files.some((file) => file.path === "ignored/remote.txt"));
  }));
