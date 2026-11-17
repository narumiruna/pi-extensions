import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { inspectSync } from "@narumitw/pi-sync-daemon/engine/sync/sync-inspection";
import { test, vi } from "vitest";
import { createMockContext } from "../../../test/support.js";
import type { CommandOptions } from "../src/commands/command-types.js";
import { loadConfig } from "../src/settings/config.js";
import { localConfigPath } from "../src/settings/config-file.js";
import { updateLocalConfig } from "../src/settings/settings-store.js";
import { statePathForConfig } from "../src/state/sync-state-store.js";
import { push } from "../src/sync/sync-mutations.js";
import { status } from "../src/sync/sync-queries.js";
import { classifyObservation } from "../src/ui/sync-attention.js";
import { v3S3Settings, withTempHome } from "./helpers.js";
import { MemorySyncBackend } from "./memory-sync-backend.js";

const options: CommandOptions = {
  args: [],
  yes: true,
  force: false,
  stale: false,
  silent: false,
  reload: false,
  auto: false,
};
for (const [before, after, changed] of [
  [undefined, [], true],
  [[], undefined, true],
  [["machine"], [], true],
  [[], ["machine"], true],
  [["machine"], ["unused"], true],
  [undefined, undefined, false],
  [[], [], false],
  [["machine"], ["machine"], false],
] as const) {
  test(`inspection/status expose byte-identical policy transition ${JSON.stringify(before)} -> ${JSON.stringify(after)}`, async () =>
    withTempHome(async (root) => {
      await fs.mkdir(root, { recursive: true });
      const settings = v3S3Settings();
      if (before !== undefined) Object.assign(settings.syncSetups.home.sync, { localFields: [...before] });
      await fs.writeFile(localConfigPath(), JSON.stringify({ ...settings, version: before === undefined ? 3 : 4 }));
      await fs.writeFile(path.join(root, "settings.json"), '{"theme":"base"}\n');
      const { ctx, notifications } = createMockContext({ hasUI: true, mode: "rpc" });
      const backend = new MemorySyncBackend();
      await push(ctx, options, undefined, () => backend);
      await updateLocalConfig((current) => {
        const setup = current.syncSetups.home;
        assert.ok(setup);
        const sync = { ...setup.sync };
        if (after === undefined) delete sync.localFields;
        else sync.localFields = [...after];
        return { ...current, version: 4, syncSetups: { ...current.syncSetups, home: { ...setup, sync } } };
      });
      const config = await loadConfig();
      const stateBefore = await fs.readFile(statePathForConfig(config));
      const settingsBefore = await fs.readFile(localConfigPath());
      const head = await backend.readHead();
      const reads = vi.spyOn(backend, "readSnapshot");
      const publication = vi.spyOn(backend, "publishSnapshot");
      const result = await inspectSync(config, { include: config.include }, undefined, () => backend);
      assert.equal(result.localChanged, changed);
      assert.equal(result.remoteChanged, changed);
      assert.equal(
        classifyObservation({
          setupName: config.setupName,
          configIdentity: "test",
          checkedAt: "test",
          inspection: result,
        }),
        changed ? "review" : "none",
      );
      await status(ctx as ExtensionCommandContext, options, () => backend);
      const message = notifications.at(-1)?.message ?? "";
      assert.match(message, new RegExp(`local changed since last sync: ${changed ? "yes" : "no"}`));
      assert.match(message, new RegExp(`remote changed since last sync: ${changed ? "yes" : "no"}`));
      assert.equal(reads.mock.calls.length, 0);
      assert.equal(publication.mock.calls.length, 0);
      assert.deepEqual(await fs.readFile(statePathForConfig(config)), stateBefore);
      assert.deepEqual(await fs.readFile(localConfigPath()), settingsBefore);
      assert.deepEqual(await backend.readHead(), head);
      assert.equal(await fs.readFile(path.join(root, "settings.json"), "utf8"), '{"theme":"base"}\n');
    }));
}
