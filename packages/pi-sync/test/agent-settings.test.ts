import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { test } from "vitest";
import { configFromSettings, loadConfig, syncCheckConfigFingerprint } from "../src/settings/config.js";
import { localConfigPath } from "../src/settings/config-file.js";
import { updateLocalConfig } from "../src/settings/settings-store.js";
import { validateSettingsDocument } from "../src/settings/settings-validation.js";
import { startupTransferEnabled } from "../src/sync/agent-policy.js";
import { v3S3Settings, withTempHome } from "./helpers.js";

for (const field of ["agentMode", "continuous"] as const) {
  for (const bad of ["true", 1, null, {}, []])
    test(`${field} rejects non-boolean ${JSON.stringify(bad)}`, () => {
      const settings = v3S3Settings();
      Object.assign(settings.syncSetups.home.sync, { [field]: bad });
      assert.throws(() => validateSettingsDocument(settings), new RegExp(`${field}.*boolean`, "u"));
    });
}

for (const automatic of [false, true])
  for (const automaticTransfer of [false, true])
    test(`retired preferences do not change check=${automatic} or startup transfer=${automaticTransfer}`, () => {
      const settings = v3S3Settings({ automatic });
      Object.assign(settings.syncSetups.home.sync, { automaticTransfer });
      const resolve = () => configFromSettings(validateSettingsDocument(settings));
      const original = resolve();
      for (const agentMode of [false, true])
        for (const continuous of [false, true]) {
          Object.assign(settings.syncSetups.home.sync, { agentMode, continuous });
          const effective = resolve();
          assert.equal(effective.automatic, automatic);
          assert.equal(effective.agentMode, false);
          assert.equal(effective.continuous, false);
          assert.equal(startupTransferEnabled(effective), automaticTransfer);
          assert.equal(syncCheckConfigFingerprint(effective), syncCheckConfigFingerprint(original));
        }
    });

for (const version of [3, 4, 5, 6, 7, 8, 9])
  test(`settings version ${version} preserves retired keys and unrelated fields`, () =>
    withTempHome(async (agentDir) => {
      await fs.mkdir(agentDir, { recursive: true });
      const settings = { ...v3S3Settings(), version, unknown: { keep: true } };
      const flags = { agentMode: true, continuous: true };
      Object.assign(settings.syncSetups.home.sync, flags);
      const bytes = `${JSON.stringify(settings, null, 2)}\n`;
      await fs.writeFile(localConfigPath(), bytes);
      const effective = await loadConfig();
      assert.equal(effective.agentMode, false);
      assert.equal(effective.continuous, false);
      assert.equal(await fs.readFile(localConfigPath(), "utf8"), bytes);
      await updateLocalConfig((current) => ({ ...current, debug: true }));
      assert.deepEqual(JSON.parse(await fs.readFile(localConfigPath(), "utf8")), { ...settings, debug: true });
    }));
