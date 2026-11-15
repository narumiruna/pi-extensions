import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { test, vi } from "vitest";
import { createMockContext } from "../../../test/support.js";
import { loadConfig } from "../src/settings/config.js";
import { localConfigPath } from "../src/settings/config-file.js";
import { addSyncSetup, saveNewV3Settings } from "../src/settings/settings-management.js";
import type { PiSyncSettingsV3, SyncSetupSettings } from "../src/settings/settings-types.js";
import { readSyncIgnoreFile } from "../src/settings/sync-ignore-file.js";
import { saveSyncIgnore } from "../src/settings/sync-ignore-settings.js";
import { chooseSetupContent } from "../src/ui/setup/setup-prompts.js";
import { v3S3Settings, withTempHome } from "./helpers.js";

async function seed(root: string) {
  await fs.mkdir(root, { recursive: true });
  const settings = v3S3Settings() as unknown as PiSyncSettingsV3;
  settings.version = 6;
  delete settings.syncSetups.home?.sync.include;
  await fs.writeFile(localConfigPath(), JSON.stringify(settings));
  return settings;
}

for (const invalid of ["duplicate", "invalid-policy", "invalid-storage"] as const)
  test(`rejected setup ${invalid} leaves the existing missing ignore file unchanged`, async () =>
    withTempHome(async (root) => {
      const settings = await seed(root);
      const bytes = await fs.readFile(localConfigPath());
      const setup: SyncSetupSettings = {
        storage: { connection: "r2", bucket: "other-bucket", path: "./" },
        sync: { automatic: false },
      };
      if (invalid === "duplicate") setup.storage = structuredClone(settings.syncSetups.home?.storage ?? setup.storage);
      if (invalid === "invalid-policy") setup.sync.include = ["settings.json"];
      if (invalid === "invalid-storage") setup.storage.bucket = "";
      await assert.rejects(addSyncSetup("work", setup));
      assert.equal(await readSyncIgnoreFile(), undefined);
      assert.equal((await loadConfig()).syncIgnore, "");
      assert.deepEqual(await fs.readFile(localConfigPath()), bytes);
    }));

test("first setup validates the complete document before publishing default rules", async () =>
  withTempHome(async () => {
    await assert.rejects(
      saveNewV3Settings({
        setupName: "home",
        connectionName: "git",
        connection: { type: "git", remote: "git@example.com:user/private.git" },
        setup: {
          storage: { connection: "git", branch: "main", path: "./" },
          sync: { automatic: "false" as unknown as boolean },
        },
      }),
      /automatic must be boolean/,
    );
    assert.equal(await readSyncIgnoreFile(), undefined);
    await assert.rejects(fs.stat(localConfigPath()), { code: "ENOENT" });
  }));

test("a successful additional setup preserves empty effective rules when the policy file is absent", async () =>
  withTempHome(async (root) => {
    await seed(root);
    const { ctx } = createMockContext({ mode: "tui" });
    const content = await chooseSetupContent(ctx);
    assert.equal(content?.syncIgnore, "");
    await addSyncSetup(
      "work",
      { storage: { connection: "r2", bucket: "work-bucket", path: "./" }, sync: { automatic: false } },
      undefined,
      undefined,
      "",
    );
    assert.equal(await readSyncIgnoreFile(), undefined);
    assert.equal((await loadConfig("work")).syncIgnore, "");
  }));

for (const previous of [undefined, "/sessions/\n"])
  test(`two directory-sync failures retain recovery evidence for ${previous === undefined ? "absence" : "old rules"}`, async () =>
    withTempHome(async (root) => {
      await seed(root);
      if (previous !== undefined) await fs.writeFile(path.join(root, ".syncignore"), previous);
      let failures = 0;
      const original = fs.open;
      const spy = vi.spyOn(fs, "open").mockImplementation((...args) => {
        if (String(args[0]) === root && args[1] === "r" && failures < 2) {
          failures++;
          return Promise.reject(Object.assign(new Error("directory sync failed"), { code: "EIO" }));
        }
        return original(...args);
      });
      try {
        await assert.rejects(saveSyncIgnore("new/\n", previous), /could not be safely restored/);
      } finally {
        spy.mockRestore();
      }
      assert.equal(failures, 2);
      const evidence = (await fs.readdir(root)).filter((name) => name.endsWith(".previous"));
      assert.equal(evidence.length, 1);
      assert.equal(await fs.readFile(path.join(root, evidence[0] ?? ""), "utf8"), previous ?? "");
      await assert.rejects(readSyncIgnoreFile(), /recovery evidence/);
      await assert.rejects(loadConfig(), /recovery evidence/);
      if (previous !== undefined) assert.equal(await fs.readFile(path.join(root, ".syncignore"), "utf8"), previous);
      else await assert.rejects(fs.stat(path.join(root, ".syncignore")), { code: "ENOENT" });
    }));
