import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { test } from "vitest";
import { loadConfig, syncConfigReviewFingerprint } from "../src/settings/config.js";
import { localConfigPath } from "../src/settings/config-file.js";
import { updateLocalConfig } from "../src/settings/settings-store.js";
import { validateSettingsDocument } from "../src/settings/settings-validation.js";
import { startupTransferEnabled } from "../src/sync/agent-policy.js";
import { v3S3Settings, withTempHome } from "./helpers.js";

for (const version of [3, 4, 5])
  test(`Agent mode is additive in settings version ${version}`, async () =>
    withTempHome(async (agentDir) => {
      await fs.mkdir(agentDir, { recursive: true });
      const settings = { ...v3S3Settings(), version, unknown: { keep: true } };
      await fs.writeFile(localConfigPath(), JSON.stringify(settings));
      const off = await loadConfig();
      assert.equal(off.agentMode, false);
      await updateLocalConfig((current) => {
        assert.ok(current.syncSetups.home);
        return {
          ...current,
          syncSetups: {
            ...current.syncSetups,
            home: { ...current.syncSetups.home, sync: { ...current.syncSetups.home.sync, agentMode: true } },
          },
        };
      });
      const on = await loadConfig();
      assert.equal(on.agentMode, true);
      assert.notEqual(syncConfigReviewFingerprint(off), syncConfigReviewFingerprint(on));
      const persisted = JSON.parse(await fs.readFile(localConfigPath(), "utf8"));
      assert.equal(persisted.version, version);
      assert.deepEqual(persisted.unknown, { keep: true });
    }));

for (const bad of ["true", 1, null, {}, []])
  test(`Agent mode rejects non-boolean ${JSON.stringify(bad)}`, () => {
    const settings = v3S3Settings();
    Object.assign(settings.syncSetups.home.sync, { agentMode: bad });
    assert.throws(() => validateSettingsDocument(settings), /agentMode.*boolean/);
  });

for (const automatic of [false, true])
  for (const automaticTransfer of [false, true])
    for (const agentMode of [false, true])
      test(`startup authorization ${automatic}/${automaticTransfer}/${agentMode}`, () => {
        assert.equal(startupTransferEnabled({ automaticTransfer, agentMode }), automaticTransfer || agentMode);
      });
