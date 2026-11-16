import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { test } from "vitest";
import { loadConfig, syncConfigReviewFingerprint } from "../src/settings/config.js";
import { localConfigPath } from "../src/settings/config-file.js";
import { describeManagerState } from "../src/ui/manager-state.js";
import { v3S3Settings, withTempHome } from "./helpers.js";

const cases = [
  {
    name: "exclusion-only difference",
    localInclude: ["settings.json", "AGENTS.md"],
    remoteInclude: ["settings.json", "AGENTS.md"],
    localExclude: ["settings.json"],
    remoteExclude: ["AGENTS.md"],
    message: /Synced-content exclusion rules differ\./,
    orderOnly: false,
    excludeDifference: true,
  },
  {
    name: "include membership difference",
    localInclude: ["settings.json"],
    remoteInclude: ["settings.json", "AGENTS.md"],
    localExclude: ["future"],
    remoteExclude: ["future"],
    message: /Remote-only paths: 1 · Device-only paths: 0/,
    orderOnly: false,
    excludeDifference: false,
  },
  {
    name: "include order difference with equivalent exclusion sets",
    localInclude: ["settings.json", "AGENTS.md"],
    remoteInclude: ["AGENTS.md", "settings.json"],
    localExclude: ["future", "skills/private"],
    remoteExclude: ["SKILLS/private", "future"],
    message: /Only the synced-content order differs\./,
    orderOnly: true,
    excludeDifference: false,
  },
  {
    name: "include membership and exclusion differences",
    localInclude: ["settings.json"],
    remoteInclude: ["AGENTS.md"],
    localExclude: ["future"],
    remoteExclude: ["other"],
    message: /Remote-only paths: 1 · Device-only paths: 1/,
    orderOnly: false,
    excludeDifference: true,
  },
];

for (const item of cases)
  test(`manager summary reports ${item.name}`, async () =>
    withTempHome(async (root) => {
      await fs.mkdir(root, { recursive: true });
      const settings = v3S3Settings({ include: item.localInclude });
      settings.version = 6;
      Object.assign(settings.syncSetups.home.sync, { exclude: item.localExclude });
      await fs.writeFile(localConfigPath(), JSON.stringify(settings), { mode: 0o600 });
      const config = await loadConfig();
      const attention = {
        decision: {
          setupName: config.setupName,
          configIdentity: syncConfigReviewFingerprint(config),
          localInclude: config.include,
          remoteInclude: item.remoteInclude,
          localExclude: config.exclude,
          remoteExclude: item.remoteExclude,
        },
        origin: "sync" as const,
        offered: false,
      };
      const manager = await describeManagerState(undefined, attention, async () => ({ kind: "free" }));
      assert.match(manager.title, /Sync status: Review needed/);
      assert.match(manager.title, item.message);
      assert.equal(/Only the synced-content order differs\./.test(manager.title), item.orderOnly);
      assert.equal(/exclusion rules differ/i.test(manager.title), item.excludeDifference);
      assert.equal(manager.attentionBlocksSync, true);
      assert.deepEqual(manager.attention, attention);
    }));

for (const [exclude, enabled] of [
  [[], true],
  [["sessions"], false],
  [["sessions/**"], false],
  [["sessions/**/draft-*.jsonl"], true],
] as const)
  test(`manager transfer permission uses effective sessions selection: ${JSON.stringify(exclude)}`, async () =>
    withTempHome(async (root) => {
      await fs.mkdir(root, { recursive: true });
      const settings = v3S3Settings({ include: ["sessions"], automatic: true });
      settings.version = 6;
      Object.assign(settings.syncSetups.home.sync, { exclude: [...exclude] });
      await fs.writeFile(localConfigPath(), JSON.stringify(settings), { mode: 0o600 });
      const manager = await describeManagerState(undefined, undefined, async () => ({ kind: "free" }));
      assert.equal(manager.title.includes("Automatic transfer permission: On"), enabled);
    }));
