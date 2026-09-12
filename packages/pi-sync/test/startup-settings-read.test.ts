import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { test } from "vitest";
import { loadConfigForCheck, syncCheckConfigFingerprint } from "../src/settings/config.js";
import { legacyLocalConfigPath, localConfigPath } from "../src/settings/config-file.js";
import { v3S3Settings, withTempHome } from "./helpers.js";

test("background settings reads never create or migrate a settings file", async () => {
  await withTempHome(async (agentDir) => {
    await assert.rejects(loadConfigForCheck(), /Missing pi-sync settings/u);
    await assert.rejects(fs.access(agentDir), { code: "ENOENT" });
    await fs.mkdir(agentDir, { recursive: true });
    const settings = v3S3Settings({ automatic: true });
    const bytes = `${JSON.stringify({ ...settings, unknown: { retain: true } })}\n`;
    await fs.writeFile(legacyLocalConfigPath(), bytes, { mode: 0o600 });
    const first = await loadConfigForCheck();
    assert.equal(first.automatic, true);
    await assert.rejects(fs.access(localConfigPath()), { code: "ENOENT" });
    assert.equal(await fs.readFile(legacyLocalConfigPath(), "utf8"), bytes);
    await fs.writeFile(localConfigPath(), JSON.stringify(v3S3Settings({ automatic: false })), {
      mode: 0o600,
    });
    assert.equal((await loadConfigForCheck()).automatic, false);
    await fs.rm(localConfigPath());
    assert.equal(syncCheckConfigFingerprint(await loadConfigForCheck()), syncCheckConfigFingerprint(first));
    await assert.rejects(fs.access(localConfigPath()), { code: "ENOENT" });
  });
});

for (const bytes of [
  '{"secret":"do-not-display",',
  '{"version":2,"secret":"do-not-display"}',
  '{"version":3,"syncSetups":false}',
]) {
  test(`background settings reject ${bytes.includes("version") ? "invalid schema" : "malformed JSON"} without exposing content or rewriting it`, async () => {
    await withTempHome(async (agentDir) => {
      await fs.mkdir(agentDir, { recursive: true });
      await fs.writeFile(localConfigPath(), bytes, { mode: 0o600 });
      await assert.rejects(loadConfigForCheck(), (error: Error) => {
        assert.ok(!error.message.includes("do-not-display"));
        return true;
      });
      assert.equal(await fs.readFile(localConfigPath(), "utf8"), bytes);
    });
  });
}
