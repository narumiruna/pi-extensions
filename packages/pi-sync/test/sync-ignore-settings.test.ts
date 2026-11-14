import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { test } from "vitest";
import { createMockContext } from "../../../test/support.js";
import { loadConfig, syncConfigReviewFingerprint, syncConfigReviewIdentity } from "../src/settings/config.js";
import { localConfigPath, withConfigFilePublicationForTest } from "../src/settings/config-file.js";
import { saveNewV3Settings } from "../src/settings/settings-management.js";
import { readLocalConfigObject } from "../src/settings/settings-store.js";
import type { PiSyncSettingsV3 } from "../src/settings/settings-types.js";
import { validateSettingsDocument } from "../src/settings/settings-validation.js";
import { readSyncIgnoreFile, withSyncIgnorePublicationHookForTest } from "../src/settings/sync-ignore-file.js";
import { migrateToSyncIgnore, migrationSyncIgnore, saveSyncIgnore } from "../src/settings/sync-ignore-settings.js";
import { useSyncSetup } from "../src/sync/setup-switch.js";
import { DEFAULT_SYNC_IGNORE, syncIgnoreAllows } from "../src/sync/sync-ignore.js";
import { v3S3Settings, withTempHome } from "./helpers.js";

test("missing policy reads create no agent directory, settings, or locks", async () =>
  withTempHome(async (root) => {
    assert.equal(await readSyncIgnoreFile(), undefined);
    assert.equal(await readLocalConfigObject(), undefined);
    await assert.rejects(fs.stat(root), { code: "ENOENT" });
  }));

test("new setup uses version 6 with no JSON content selection and safe initial ignore rules", async () =>
  withTempHome(async (root) => {
    await saveNewV3Settings({
      setupName: "home",
      connectionName: "git",
      connection: { type: "git", remote: "git@example.com:user/private.git" },
      setup: { storage: { connection: "git", path: "./", branch: "main" }, sync: { automatic: false } },
      expectedSyncIgnore: DEFAULT_SYNC_IGNORE,
    });
    const settings = await readLocalConfigObject();
    assert.equal(settings?.version, 6);
    assert.equal(Object.hasOwn(settings?.syncSetups.home?.sync ?? {}, "include"), false);
    assert.equal(await readSyncIgnoreFile(), DEFAULT_SYNC_IGNORE);
    assert.equal((await loadConfig()).include.includes("sessions"), false);
    assert.equal((await fs.stat(path.join(root, ".syncignore"))).mode & 0o777, 0o600);
  }));

test("legacy migration is explicit, shared, conservative and preserves unknown data and a private backup", async () =>
  withTempHome(async (root) => {
    await fs.mkdir(root, { recursive: true });
    const legacy = validateSettingsDocument(v3S3Settings({ include: ["settings.json", "AGENTS.md", "skills"] }));
    legacy.extraFuture = { keep: true };
    legacy.syncSetups.work = {
      storage: { connection: "r2", bucket: "pi-sync-work", path: "./" },
      sync: { include: ["settings.json", "prompts"], automatic: false, future: 7 },
    };
    await fs.writeFile(localConfigPath(), JSON.stringify(legacy));
    assert.equal((await loadConfig()).syncIgnore, undefined);
    assert.equal(await readSyncIgnoreFile(), undefined);
    await migrateToSyncIgnore(legacy, undefined);
    const settings = await readLocalConfigObject();
    assert.equal(settings?.version, 6);
    assert.deepEqual(settings?.extraFuture, { keep: true });
    assert.equal(settings?.syncSetups.work?.sync.future, 7);
    assert.equal(settings?.syncSetups.work?.sync.include, undefined);
    const rules = (await loadConfig()).syncIgnore;
    assert.equal((await loadConfig("work")).syncIgnore, rules);
    assert.ok(rules);
    assert.ok(syncIgnoreAllows(rules, "settings.json"));
    for (const file of ["AGENTS.md", "new.toml", "skills/new/SKILL.md", "sessions/project/s.jsonl"])
      assert.equal(syncIgnoreAllows(rules, file), false);
    const backups = (await fs.readdir(root)).filter((name) => name.endsWith(".before-syncignore"));
    assert.equal(backups.length, 1);
    assert.equal((await fs.stat(path.join(root, backups[0] ?? ""))).mode & 0o777, 0o600);
  }));

test("failed settings migration keeps legacy scope active and permits a safe explicit retry", async () =>
  withTempHome(async (root) => {
    await fs.mkdir(root, { recursive: true });
    const legacy = validateSettingsDocument(v3S3Settings());
    const bytes = JSON.stringify(legacy);
    await fs.writeFile(localConfigPath(), bytes);
    await withConfigFilePublicationForTest(
      async () => {
        throw new Error("disk full");
      },
      async () => {
        await assert.rejects(migrateToSyncIgnore(legacy, undefined), /disk full/);
      },
    );
    assert.equal(await fs.readFile(localConfigPath(), "utf8"), bytes);
    assert.equal((await loadConfig()).syncIgnore, undefined);
    assert.equal(await readSyncIgnoreFile(), migrationSyncIgnore(legacy));
    await migrateToSyncIgnore(legacy, await readSyncIgnoreFile());
    assert.equal((await loadConfig()).syncIgnore, migrationSyncIgnore(legacy));
  }));

test("stale migration and an existing unrelated ignore file do not overwrite user data", async () =>
  withTempHome(async (root) => {
    await fs.mkdir(root, { recursive: true });
    const legacy = validateSettingsDocument(v3S3Settings());
    await fs.writeFile(localConfigPath(), JSON.stringify(legacy));
    await fs.writeFile(path.join(root, ".syncignore"), "private/\n");
    await assert.rejects(migrateToSyncIgnore(legacy, "private/\n"), /existing .syncignore differs/i);
    await assert.rejects(migrateToSyncIgnore({ ...legacy, debug: true }, "private/\n"), /changed/);
    assert.equal(await readSyncIgnoreFile(), "private/\n");
    assert.equal((await readLocalConfigObject())?.version, 3);
  }));

test("version 6 setup switching revalidates the shared ignore policy under the settings lock", async () =>
  withTempHome(async (root) => {
    await fs.mkdir(root, { recursive: true });
    const settings = v3S3Settings() as unknown as PiSyncSettingsV3;
    settings.version = 6;
    settings.onSwitch = "switch-only";
    delete settings.syncSetups.home?.sync.include;
    settings.syncSetups.work = {
      storage: { connection: "r2", bucket: "work-bucket", path: "./" },
      sync: { automatic: false },
    };
    await fs.writeFile(localConfigPath(), JSON.stringify(settings));
    await fs.writeFile(path.join(root, ".syncignore"), "/sessions/\n");
    const reviewedHome = syncConfigReviewIdentity(await loadConfig("home"));
    const reviewedWork = syncConfigReviewIdentity(await loadConfig("work"));
    const { ctx } = createMockContext({ mode: "tui" });
    await useSyncSetup(ctx, "work", undefined, "switch-only", undefined, reviewedWork);
    assert.equal((await loadConfig()).setupName, "work");
    await fs.writeFile(path.join(root, ".syncignore"), "/sessions/\n*.log\n");
    await assert.rejects(
      useSyncSetup(ctx, "home", undefined, "switch-only", undefined, reviewedHome),
      /changed while the switch preview/,
    );
    assert.equal((await loadConfig()).setupName, "work");
  }));

test("version 6 rejects JSON include rules and preserves malformed settings during ignore saves", async () =>
  withTempHome(async (root) => {
    await fs.mkdir(root, { recursive: true });
    const legacy = v3S3Settings();
    assert.throws(() => validateSettingsDocument({ ...legacy, version: 6 }), /sync.include/);
    await fs.writeFile(localConfigPath(), "{invalid");
    await assert.rejects(saveSyncIgnore("", undefined));
    assert.equal(await readSyncIgnoreFile(), undefined);
    assert.equal(await fs.readFile(localConfigPath(), "utf8"), "{invalid");
  }));

test("ignore saves are ordered, reject stale reviews, and keep the queue usable after failure", async () =>
  withTempHome(async (root) => {
    await fs.mkdir(root, { recursive: true });
    const settings = v3S3Settings() as unknown as PiSyncSettingsV3;
    settings.version = 6;
    delete settings.syncSetups.home?.sync.include;
    await fs.writeFile(localConfigPath(), JSON.stringify(settings));
    const before = syncConfigReviewFingerprint(await loadConfig());
    const first = saveSyncIgnore("first/\n", undefined);
    const stale = saveSyncIgnore("stale/\n", undefined);
    const third = saveSyncIgnore("third/\n", "first/\n");
    const results = await Promise.allSettled([first, stale, third]);
    assert.deepEqual(
      results.map((result) => result.status),
      ["fulfilled", "rejected", "fulfilled"],
    );
    assert.equal(await readSyncIgnoreFile(), "third/\n");
    assert.notEqual(syncConfigReviewFingerprint(await loadConfig()), before);
  }));

for (const original of [undefined, "/sessions/\n"])
  test(`failed post-rename ignore publication restores ${original === undefined ? "absence" : "previous rules"}`, async () =>
    withTempHome(async (root) => {
      await fs.mkdir(root, { recursive: true });
      const settings = v3S3Settings() as unknown as PiSyncSettingsV3;
      settings.version = 6;
      delete settings.syncSetups.home?.sync.include;
      await fs.writeFile(localConfigPath(), JSON.stringify(settings));
      if (original !== undefined) await fs.writeFile(path.join(root, ".syncignore"), original);
      await withSyncIgnorePublicationHookForTest(
        async () => {
          throw new Error("directory flush failed");
        },
        async () => {
          await assert.rejects(saveSyncIgnore("new/\n", original), /directory flush failed/);
        },
      );
      assert.equal(await readSyncIgnoreFile(), original);
      assert.equal(
        (await fs.readdir(root)).some((name) => name.startsWith(".syncignore.tmp-")),
        false,
      );
    }));

test("failed publication preserves newer external rules and blocks reads on retained recovery evidence", async () =>
  withTempHome(async (root) => {
    await fs.mkdir(root, { recursive: true });
    const settings = v3S3Settings() as unknown as PiSyncSettingsV3;
    settings.version = 6;
    delete settings.syncSetups.home?.sync.include;
    await fs.writeFile(localConfigPath(), JSON.stringify(settings));
    await fs.writeFile(path.join(root, ".syncignore"), "/sessions/\n");
    await withSyncIgnorePublicationHookForTest(
      async () => {
        await fs.writeFile(path.join(root, ".syncignore"), "external/\n");
        throw new Error("directory flush failed");
      },
      async () => {
        await assert.rejects(saveSyncIgnore("new/\n", "/sessions/\n"), /could not be safely restored/);
      },
    );
    assert.equal(await fs.readFile(path.join(root, ".syncignore"), "utf8"), "external/\n");
    await assert.rejects(readSyncIgnoreFile(), /recovery evidence/);
    await assert.rejects(loadConfig(), /recovery evidence/);
    const retained = (await fs.readdir(root)).filter((name) => name.endsWith(".previous"));
    assert.equal(retained.length, 1);
    assert.equal(await fs.readFile(path.join(root, retained[0] ?? ""), "utf8"), "/sessions/\n");
  }));

test("symlinks, invalid UTF-8 and cancelled writes fail closed", async () =>
  withTempHome(async (root) => {
    await fs.mkdir(root, { recursive: true });
    const policyPath = path.join(root, ".syncignore");
    const outside = path.join(root, "outside");
    await fs.writeFile(outside, "private\n");
    await fs.symlink(outside, policyPath);
    await assert.rejects(readSyncIgnoreFile());
    await fs.unlink(policyPath);
    await fs.writeFile(policyPath, Buffer.from([0xff]));
    await assert.rejects(readSyncIgnoreFile());
    await fs.unlink(policyPath);
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(saveSyncIgnore("", undefined, controller.signal));
    assert.equal(await readSyncIgnoreFile(), undefined);
  }));
