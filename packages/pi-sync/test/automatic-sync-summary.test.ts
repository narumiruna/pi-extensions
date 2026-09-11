import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { test } from "vitest";
import { createMockContext } from "../../../test/support.js";
import { executeCommand } from "../src/commands/command-execution.js";
import { localConfigPath } from "../src/settings/config-file.js";
import { createSyncLoaders } from "../src/sync/sync-loaders.js";
import { describeManagerState } from "../src/ui/manager-state.js";
import { showSetupSwitcher } from "../src/ui/setup/setup-switcher.js";
import { v3S3Settings, withTempHome } from "./helpers.js";

for (const automatic of [false, true]) {
  for (const sessions of [false, true]) {
    test(`automatic=${automatic} sessions=${sessions}: manager, config, and switch disclose shutdown scope`, async () => {
      await withTempHome(async (agentDir) => {
        await fs.mkdir(agentDir, { recursive: true });
        const settings = v3S3Settings({
          automatic,
          include: sessions ? ["settings.json", "sessions"] : ["settings.json"],
        });
        Object.assign(settings.syncSetups, {
          work: {
            ...settings.syncSetups.home,
            storage: { ...settings.syncSetups.home.storage, path: "work" },
          },
        });
        const bytes = JSON.stringify(settings);
        await fs.writeFile(localConfigPath(), bytes);
        const expected = automatic
          ? "On (startup check; shutdown pushes selected content if sessions included)"
          : "Off";
        assert.ok((await describeManagerState()).title.includes(`Automatic sync: ${expected}`));
        let confirmation = "";
        const context = createMockContext({
          mode: "rpc",
          confirm: async (_title: string, body: string) => {
            confirmation = body;
            return false;
          },
        });
        await executeCommand("config", context.ctx, undefined, createSyncLoaders({}));
        assert.ok(context.notifications.some((n) => n.message.includes(`automatic sync: ${expected}`)));
        assert.equal(
          await showSetupSwitcher(
            context.ctx,
            async () => {
              throw new Error("must not transfer");
            },
            "work",
          ),
          false,
        );
        assert.ok(confirmation.includes(`Automatic sync: ${expected}`));
        assert.equal(await fs.readFile(localConfigPath(), "utf8"), bytes);
      });
    });
  }
}
