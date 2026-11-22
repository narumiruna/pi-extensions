import assert from "node:assert/strict";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { test } from "vitest";
import { createMockContext, createMockPi } from "../../../test/support.js";
import { loadConfig } from "../src/settings/config.js";
import { localConfigPath } from "../src/settings/config-file.js";
import { saveOnSwitch, useSyncSetup } from "../src/sync/setup-switch.js";
import { showSetupSwitcher } from "../src/ui/setup/setup-switcher.js";
import { showSyncSetups } from "../src/ui/sync-setups-ui.js";
import { runRegisteredCommand } from "./daemon-test-helpers.js";
import { v3S3Settings, withTempHome } from "./helpers.js";

for (const url of ["https://cloud.example.com/dav/owner-a/", "https://cloud.example.com/dav/owner-b/"]) {
  test(`saved WebDAV setup detail exposes the exact collection ${url} without writes`, async () => {
    await withTempHome(async (agentDir) => {
      mkdirSync(agentDir, { recursive: true });
      const settings = v3S3Settings();
      Object.assign(settings.storageConnections, {
        dav: {
          type: "webdav",
          url,
          credentials: { username: "user", password: "private-password" },
        },
      });
      Object.assign(settings.syncSetups, {
        work: {
          storage: { connection: "dav", path: "pi-sync/work" },
          sync: { include: ["settings.json"], automatic: false },
        },
      });
      const before = JSON.stringify(settings);
      writeFileSync(localConfigPath(), before, { mode: 0o600 });
      const { showSyncManager } = await import("../src/ui/manager-ui.js");
      const choices = ["Settings", "Manage sync setups", "work"];
      const frames: string[] = [];
      const routes: string[] = [];
      const { ctx, notifications } = createMockContext({
        hasUI: true,
        mode: "rpc",
        select: async (title: string) => {
          frames.push(title);
          return choices.shift();
        },
      });
      await showSyncManager(ctx, async (route) => {
        routes.push(route);
      });
      assert.ok(frames.some((frame) => frame.includes(`Endpoint: ${url}`)));
      assert.ok(frames.some((frame) => frame.includes("Storage location: WebDAV · pi-sync/work")));
      assert.doesNotMatch(frames.join("\n"), /private-password/u);
      assert.deepEqual(routes, []);
      assert.equal(notifications.length, 1);
      assert.match(notifications[0]?.message ?? "", /Edit pi-sync settings manually/u);
      assert.equal(readFileSync(localConfigPath(), "utf8"), before);
    });
  });
}

for (const replaced of [false, true]) {
  test(`mixed setup switch saves only settings and rejects replaced rule evidence (${replaced})`, () =>
    withTempHome(async (root) => {
      mkdirSync(root, { recursive: true });
      const legacy = v3S3Settings();
      const settings = {
        ...legacy,
        version: 8,
        onSwitch: "pull-after-switch",
        syncSetups: {
          ...legacy.syncSetups,
          work: {
            storage: { connection: "r2", bucket: "work-bucket", path: "work" },
            sync: { scope: "agent-directory", pathPolicy: "ignore-file", automatic: true },
          },
        },
      };
      const rules = path.join(root, ".syncignore");
      writeFileSync(rules, "/private/\n", { mode: 0o600 });
      writeFileSync(localConfigPath(), JSON.stringify(settings), { mode: 0o600 });
      const { ctx, notifications } = createMockContext({
        mode: "tui",
        confirm: async (_title: string, message: string) => {
          assert.match(message, /only saves the active setup/u);
          if (replaced) {
            renameSync(rules, `${rules}.original`);
            writeFileSync(rules, "/private/\n", { mode: 0o600 });
          }
          return true;
        },
      });
      let routes = 0;
      const switched = await showSetupSwitcher(
        ctx,
        async () => {
          routes++;
          return { kind: "completed" };
        },
        "work",
      );
      const message = notifications.map(({ message }) => message).join("\n");
      assert.equal(switched, replaced ? false : "switched", message);
      assert.equal((await loadConfig()).setupName, replaced ? "home" : "work");
      assert.equal(routes, 0);
      assert.match(message, replaced ? /changed while the switch preview/u : /No files were pulled/u);
      assert.equal(readFileSync(rules, "utf8"), "/private/\n");
    }));
}

for (const originalPolicy of ["switch-only", "ask-before-pull", "pull-after-switch"]) {
  test(`switch-only selection replaces ${originalPolicy} without pulling`, async () => {
    await withTempHome(async (agentDir) => {
      mkdirSync(agentDir, { recursive: true });
      const settings = v3S3Settings();
      settings.onSwitch = originalPolicy;
      Object.assign(settings.syncSetups, {
        work: {
          storage: { connection: "r2", bucket: "work-bucket", path: "pi-sync/work" },
          sync: { include: ["settings.json"], automatic: false },
        },
      });
      writeFileSync(localConfigPath(), JSON.stringify(settings), { mode: 0o600 });
      assert.equal((await loadConfig()).setupName, "home");
      assert.equal((await loadConfig("work")).setupName, "work");
      const { ctx, notifications } = createMockContext({ hasUI: true, mode: "rpc" });
      await saveOnSwitch("switch-only");
      let pulls = 0;
      await useSyncSetup(ctx, "work", async () => {
        pulls += 1;
        return "applied";
      });
      assert.equal(pulls, 0);
      assert.equal((await loadConfig()).setupName, "work");
      const { default: sync } = await import("../src/sync.js");
      const mock = createMockPi();
      sync(mock.pi);
      await runRegisteredCommand(mock, ctx as ExtensionCommandContext, "config");
      assert.ok(notifications.some(({ message }) => message.includes("sync setup: work")));
      const selections: string[][] = [];
      const menuContext = createMockContext({
        hasUI: true,
        mode: "rpc",
        select: async (_title: string, options: string[]) => {
          selections.push(options);
          return undefined;
        },
      });
      await showSyncSetups(menuContext.ctx, {
        add: async () => undefined,
        edit: async () => undefined,
        makeCurrent: async () => undefined,
        remove: async () => undefined,
      });
      assert.ok(selections[0]?.includes("work (current)"));
    });
  });
}
