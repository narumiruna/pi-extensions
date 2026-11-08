import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { createTuiHarness } from "@narumitw/pi-tui-kit/testing";
import { test } from "vitest";
import { createMockContext } from "../../../test/support.js";
import { loadConfig } from "../src/settings/config.js";
import { localConfigPath, withConfigFilePublicationForTest } from "../src/settings/config-file.js";
import { showSyncSettings } from "../src/ui/settings-ui.js";
import { v3S3Settings, withTempHome } from "./helpers.js";

initTheme("dark", false);

for (const failFirst of [false, true]) {
  test(`debug settings with remapped keys ${failFirst ? "recover after failed publication" : "save the searched row"}`, async () => {
    await withTempHome(async (root) => {
      await fs.mkdir(root, { recursive: true });
      await fs.writeFile(localConfigPath(), JSON.stringify({ ...v3S3Settings(), futureField: "keep" }));
      const keys: Record<string, string> = {
        "tui.select.confirm": "x",
        "tui.select.cancel": "q",
        "tui.select.down": "j",
        "tui.select.up": "k",
      };
      const tui = createTuiHarness({
        width: 80,
        rows: 24,
        keybindings: {
          matches: (data, action) => data === keys[action],
          getKeys: (action) => (keys[action] ? [keys[action]] : []) as never,
        },
      });
      const context = createMockContext({ mode: "tui", custom: tui.custom });
      const running = showSyncSettings(context.ctx, async () => undefined);
      const toggle = async () => {
        tui.send("x");
        await tui.waitForPending();
        await tui.waitForOpen();
      };
      try {
        await tui.waitForOpen();
        tui.send("\u001b[200~Debug startup timings\u001b[201~");
        assert.match(tui.render().join("\n"), /Debug startup timings.*Off/u);
        if (failFirst) {
          await withConfigFilePublicationForTest(async () => {
            throw new Error("publication failed");
          }, toggle);
          assert.equal((await loadConfig()).debug, false);
          assert.match(tui.render().join("\n"), /Debug startup timings.*Off/u);
          assert.ok(context.notifications.some((entry) => /save failed/iu.test(entry.message)));
        }
        await toggle();
        assert.equal((await loadConfig()).debug, true);
        assert.match(tui.render().join("\n"), /Debug startup timings.*On/u);
        assert.equal(JSON.parse(await fs.readFile(localConfigPath(), "utf8")).futureField, "keep");
        assert.ok(context.notifications.some((entry) => entry.message.includes("next session start")));
        tui.send("q");
        await running;
      } finally {
        tui.dispose();
      }
    });
  });
}
