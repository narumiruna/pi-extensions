import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { type ExtensionCommandContext, initTheme } from "@earendil-works/pi-coding-agent";
import { createTuiHarness } from "@narumitw/pi-tui-kit/testing";
import { test } from "vitest";
import { createMockContext } from "../../../test/support.js";
import { loadConfig } from "../src/settings/config.js";
import { localConfigPath, withConfigReplacementInstalledHookForTest } from "../src/settings/config-file.js";
import { saveAgentMode } from "../src/ui/agent-mode-setting.js";
import { showSyncSettings } from "../src/ui/settings-ui.js";
import { v3S3Settings, withTempHome } from "./helpers.js";

initTheme("dark", false);

for (const enabled of [false, true])
  for (const interruption of ["cancel", "replace"] as const)
    test(`Agent mode ${enabled} save stays committed after publication-time ${interruption}`, async () =>
      withTempHome(async (agentDir) => {
        await fs.mkdir(agentDir, { recursive: true });
        const settings = { ...v3S3Settings(), unknown: "preserve" };
        Object.assign(settings.syncSetups.home.sync, { agentMode: !enabled });
        await fs.writeFile(localConfigPath(), JSON.stringify(settings));
        const controller = new AbortController();
        const mock = createMockContext({ mode: "rpc", select: async () => "Yes, Enable Agent mode" });
        const ctx = mock.ctx as ExtensionCommandContext;
        const saved = await withConfigReplacementInstalledHookForTest(
          async () => {
            if (interruption === "cancel") controller.abort();
            else ctx.sessionManager = { ...ctx.sessionManager, getSessionId: () => "replacement" };
          },
          () => saveAgentMode(mock.ctx, "home", enabled, controller.signal),
        );
        assert.equal(saved, true);
        assert.equal((await loadConfig()).agentMode, enabled);
        assert.equal(JSON.parse(await fs.readFile(localConfigPath(), "utf8")).unknown, "preserve");
        assert.deepEqual(mock.notifications, []);
      }));

for (const reason of ["active", "cancel", "replace", "notification-failure"] as const)
  test(`Settings reads the committed Agent mode value after save (${reason})`, async () =>
    withTempHome(async (agentDir) => {
      await fs.mkdir(agentDir, { recursive: true });
      const settings = v3S3Settings();
      Object.assign(settings.syncSetups.home.sync, { agentMode: true });
      await fs.writeFile(localConfigPath(), JSON.stringify(settings));
      const controller = new AbortController();
      const cancel = reason === "cancel" || reason === "replace";
      const tui = createTuiHarness({ width: 100, rows: 24 });
      const mock = createMockContext({ mode: "tui", hasUI: true, custom: tui.custom });
      const ctx = mock.ctx as ExtensionCommandContext;
      try {
        await withConfigReplacementInstalledHookForTest(
          async () => {
            if (reason === "replace") ctx.sessionManager = { ...ctx.sessionManager, getSessionId: () => "replacement" };
            if (reason === "notification-failure")
              ctx.ui.notify = () => {
                throw new Error("UI closed");
              };
            if (cancel) controller.abort();
          },
          async () => {
            const running = showSyncSettings(mock.ctx, async () => undefined, controller.signal);
            await tui.waitForOpen();
            tui.send("\u001b[200~Agent mode\u001b[201~");
            tui.press("tui.select.confirm");
            await tui.waitForPending();
            if (!cancel) {
              await tui.waitForOpen();
              assert.match(tui.render().join("\n"), /Agent mode.*Off/);
              tui.press("ctrl+c");
            }
            await running;
          },
        );
        assert.equal((await loadConfig()).agentMode, false);
        assert.equal(
          mock.notifications.some((entry) => /failed|rejected/i.test(entry.message)),
          false,
        );
        if (cancel) assert.deepEqual(mock.notifications, []);
        // A new Settings flow must use the disk value, not the abandoned draft.
        const reopened = showSyncSettings(mock.ctx, async () => undefined);
        await tui.waitForOpen();
        tui.send("\u001b[200~Agent mode\u001b[201~");
        assert.match(tui.render().join("\n"), /Agent mode.*Off/);
        tui.press("ctrl+c");
        await reopened;
      } finally {
        controller.abort();
        tui.dispose();
      }
    }));
