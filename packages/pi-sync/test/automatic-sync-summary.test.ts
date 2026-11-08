import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { test } from "vitest";
import { createMockContext } from "../../../test/support.js";
import { executeCommand } from "../src/commands/command-execution.js";
import { localConfigPath } from "../src/settings/config-file.js";
import { createSyncLoaders } from "../src/sync/sync-loaders.js";
import { describeManagerState } from "../src/ui/manager-state.js";
import { showSetupSwitcher } from "../src/ui/setup/setup-switcher.js";
import {
  AUTOMATIC_SYNC_DESCRIPTION,
  STARTUP_TRANSFER_DESCRIPTION,
  startupTransferSummary,
} from "../src/ui/sync-behavior.js";
import { showSyncSetups } from "../src/ui/sync-setups-ui.js";
import { v3S3Settings, withTempHome } from "./helpers.js";

for (const agentMode of [false, true])
  test(`saved continuous preference with agentMode=${agentMode} is clear in status, help, and setup reviews`, async () =>
    withTempHome(async (agentDir) => {
      await fs.mkdir(agentDir, { recursive: true });
      const settings = v3S3Settings();
      Object.assign(settings.syncSetups.home.sync, { agentMode, continuous: true, mergeSettings: true });
      Object.assign(settings.syncSetups, {
        work: {
          ...settings.syncSetups.home,
          storage: { ...settings.syncSetups.home.storage, path: "work" },
        },
      });
      const before = JSON.stringify(settings);
      await fs.writeFile(localConfigPath(), before);
      const manager = await describeManagerState();
      let switchReview = "";
      const frames: string[] = [];
      const choices = ["home (current)", undefined, undefined];
      let customCalls = 0;
      const context = createMockContext({
        mode: "rpc",
        custom: async () => {
          customCalls++;
        },
        select: async (title: string) => {
          frames.push(title);
          return choices.shift();
        },
        confirm: async (title: string, body: string) => {
          switchReview = `${title}\n${body}`;
          return false;
        },
      });
      await executeCommand("config", context.ctx, undefined, createSyncLoaders({}));
      await executeCommand("help", context.ctx, undefined, createSyncLoaders({}));
      const switched = await showSetupSwitcher(context.ctx, async () => undefined, "work");
      await showSyncSetups(context.ctx, {
        add: async () => undefined,
        edit: async () => undefined,
        makeCurrent: async () => undefined,
        remove: async () => undefined,
      });
      const config = context.notifications.find((entry) => entry.message.startsWith("pi-sync config:"))?.message ?? "";
      const help = context.notifications.find((entry) => entry.message.startsWith("Usage:"))?.message ?? "";
      const detail = frames.find((frame) => frame.includes("Sync setup “home”")) ?? "";
      const autonomous = agentMode ? "On (autonomous merged sync)" : "Off";
      const continuous = agentMode
        ? "On (recurring requests and transfers)"
        : "Saved On; paused until Autonomous sync is enabled";
      for (const review of [detail, switchReview]) {
        assert.ok(review.includes(`Autonomous sync: ${autonomous}`), review);
        assert.ok(review.includes(`Continuous sync: ${continuous}`), review);
      }
      assert.ok(manager.title.includes(`Autonomous sync: ${autonomous}`));
      if (!agentMode) assert.match(manager.title, /Continuous sync: paused; enable Autonomous sync first/);
      assert.match(config, new RegExp(`^autonomous sync: ${agentMode ? "On" : "Off"}$`, "m"));
      assert.match(config, /^settings field merge: On$/m);
      assert.ok(config.includes(`continuous sync: ${agentMode ? "On" : "paused; Autonomous sync is Off"}`));
      assert.match(help, /Continuous sync is a separate default-Off opt-in in Settings\. It requires Autonomous sync/);
      assert.match(help, /recurring network\/model costs/);
      assert.match(help, /Safety blocks and durable automatic request limits remain/);
      assert.doesNotMatch(
        [manager.title, config, help, detail, switchReview].join("\n"),
        /experimental|agent[ -]mode/i,
      );
      assert.equal(switched, false);
      assert.equal(customCalls, 0);
      assert.equal(await fs.readFile(localConfigPath(), "utf8"), before);
    }));

for (const automatic of [false, true]) {
  for (const automaticTransfer of [false, true]) {
    test(`independent automation preferences: check=${automatic} transfer=${automaticTransfer}`, async () => {
      await withTempHome(async (agentDir) => {
        await fs.mkdir(agentDir, { recursive: true });
        const settings = v3S3Settings({ automatic });
        Object.assign(settings.syncSetups.home.sync, { automaticTransfer });
        await fs.writeFile(localConfigPath(), JSON.stringify(settings));
        const state = await describeManagerState();
        assert.match(state.title, new RegExp(`Automatic sync: ${automatic ? "On" : "Off"}`));
        assert.match(state.title, new RegExp(`Startup transfer: ${automaticTransfer ? "On" : "Off"}`));
        for (const type of ["s3", "git", "webdav"] as const) {
          const text = startupTransferSummary({ automaticTransfer, backend: { type } });
          assert.equal(text === "Off", !automaticTransfer);
          if (automaticTransfer) assert.match(text, /next idle startup/);
        }
        assert.match(AUTOMATIC_SYNC_DESCRIPTION, /all selected content/);
        assert.match(AUTOMATIC_SYNC_DESCRIPTION, /reload skips/);
        assert.match(AUTOMATIC_SYNC_DESCRIPTION, /next session start/);
        assert.match(STARTUP_TRANSFER_DESCRIPTION, /separate opt-in/);
        assert.match(STARTUP_TRANSFER_DESCRIPTION, /accepted baseline/);
        assert.match(STARTUP_TRANSFER_DESCRIPTION, /matching remote included paths/);
        assert.match(STARTUP_TRANSFER_DESCRIPTION, /Completed transfers are not undone/);
      });
    });
  }
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
