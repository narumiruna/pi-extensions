import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createTuiHarness } from "@narumitw/pi-tui-kit/testing";
import { test } from "vitest";
import { loadConfig, loadPartialConfig } from "../src/settings/config.js";
import { localConfigPath } from "../src/settings/config-file.js";
import { readLocalConfigObject, updateLocalConfig } from "../src/settings/settings-store.js";
import {
  showAddWebDavStorageProfile,
  showAddWebDavTarget,
  showEditWebDavTarget,
  showWebDavSetup,
} from "../src/ui/setup/webdav-ui.js";
import { v3S3Settings, v3WebDavSettings, withTempHome } from "./helpers.js";
import { createMockContext } from "./setup-test-context.js";

test("first WebDAV setup stores masked credentials in the exact version 3 shape", async () => {
  await withTempHome(async (agentDir) => {
    mkdirSync(agentDir, { recursive: true });
    const inputs = ["https://cloud.example.com/remote.php/dav/files/user", "user", "pi-sync/home"];
    const choices = [
      "Recommended Pi settings",
      "Enable automatic sync",
      "Keep sessions off (recommended)",
      "Save setup",
    ];
    const rendered: string[] = [];
    const { ctx } = createMockContext({
      hasUI: true,
      mode: "tui",
      input: async () => inputs.shift(),
      select: async (title: string) => {
        rendered.push(title);
        return choices.shift();
      },
      custom: secretInput("app-password", rendered),
    });
    assert.equal(await showWebDavSetup(ctx, "home"), true);
    const raw = await readLocalConfigObject();
    assert.deepEqual(raw?.storageConnections.home, {
      type: "webdav",
      url: "https://cloud.example.com/remote.php/dav/files/user/",
      credentials: { username: "user", password: "app-password" },
    });
    assert.deepEqual(raw?.syncSetups.home.storage, {
      connection: "home",
      path: "pi-sync/home",
    });
    assert.doesNotMatch(rendered.join("\n"), /app-password/u);
  });
});

test("WebDAV connection reuse adds a second setup without exposing credentials", async () => {
  await withTempHome(async (agentDir) => {
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(localConfigPath(), JSON.stringify(v3S3Settings()), { mode: 0o600 });
    const connectionInputs = ["dav", "https://cloud.example.com/dav", "user"];
    const reviews: string[] = [];
    const connectionCtx = createMockContext({
      hasUI: true,
      mode: "tui",
      input: async () => connectionInputs.shift(),
      select: async (title: string) => {
        reviews.push(title);
        return "Add storage connection";
      },
      custom: secretInput("private-password", reviews),
    });
    assert.equal(await showAddWebDavStorageProfile(connectionCtx.ctx), true);

    const targetInputs = ["backups/work"];
    const targetChoices = ["Minimal settings", "Keep automatic sync off", "Add sync setup"];
    const targetCtx = createMockContext({
      hasUI: true,
      mode: "tui",
      input: async () => targetInputs.shift(),
      select: async (title: string) => {
        reviews.push(title);
        return targetChoices.shift();
      },
    });
    assert.equal(await showAddWebDavTarget(targetCtx.ctx, "work", "dav"), true);
    const config = await loadConfig("work");
    assert.equal(config.connectionName, "dav");
    assert.equal(config.storagePath, "backups/work");
    assert.doesNotMatch(reviews.join("\n"), /private-password/u);
  });
});

test("WebDAV setup edit persists one complete path and rejects unsafe paths", async () => {
  await withTempHome(async (agentDir) => {
    mkdirSync(agentDir, { recursive: true });
    const settings = v3S3Settings();
    (settings.storageConnections as Record<string, unknown>).dav = {
      type: "webdav",
      url: "https://cloud.example.com/dav",
      credentials: { username: "user", password: "password" },
    };
    (settings.syncSetups as Record<string, unknown>).work = {
      storage: { connection: "dav", path: "pi-sync/work" },
      sync: { include: ["settings.json"], automatic: false },
    };
    writeFileSync(localConfigPath(), JSON.stringify(settings), { mode: 0o600 });
    const inputs = ["archives/work"];
    const { ctx } = createMockContext({
      hasUI: true,
      mode: "tui",
      input: async () => inputs.shift(),
      select: async () => "Save sync setup",
    });
    await showEditWebDavTarget(ctx, await loadPartialConfig("work"));
    assert.equal((await loadConfig("work")).storagePath, "archives/work");

    const before = readFileSync(localConfigPath());
    const invalidInputs = ["../escape", undefined];
    const invalid = createMockContext({
      hasUI: true,
      mode: "tui",
      input: async () => invalidInputs.shift(),
      select: async () => "Save sync setup",
    });
    assert.equal(await showEditWebDavTarget(invalid.ctx, await loadPartialConfig("work")), false);
    assert.match(invalid.notifications.at(-1)?.message ?? "", /Invalid pi-sync WebDAV path/u);
    assert.deepEqual(readFileSync(localConfigPath()), before);
  });
});

test("WebDAV new setups default to root while edits keep the existing nested path", async () => {
  await withTempHome(async (agentDir) => {
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(localConfigPath(), JSON.stringify(v3WebDavSettings()), { mode: 0o600 });
    const titles: string[] = [];
    const choices = ["Minimal settings", "Keep automatic sync off", "Add sync setup", "Save sync setup"];
    const { ctx } = createMockContext({
      hasUI: true,
      mode: "tui",
      input: async (title: string) => {
        titles.push(title);
        return "";
      },
      select: async () => choices.shift(),
    });
    assert.equal(await showAddWebDavTarget(ctx, "work", "dav"), true);
    assert.equal((await loadConfig("work")).storagePath, "./");
    const before = readFileSync(localConfigPath());
    assert.equal(await showEditWebDavTarget(ctx, await loadPartialConfig("home")), true);
    assert.equal((await loadConfig("home")).storagePath, "pi-sync/home");
    assert.deepEqual(readFileSync(localConfigPath()), before);
    assert.match(titles[0], /Default: \.\//u);
    assert.match(titles[1], /Default: pi-sync\/home/u);
  });
});

test("WebDAV setup edit rejects a backend rebind while its review is open", async () => {
  await withTempHome(async (agentDir) => {
    mkdirSync(agentDir, { recursive: true });
    const settings = v3S3Settings();
    (settings.storageConnections as Record<string, unknown>).dav = {
      type: "webdav",
      url: "https://cloud.example.com/dav",
      credentials: { username: "user", password: "password" },
    };
    (settings.syncSetups as Record<string, unknown>).work = {
      storage: { connection: "dav", path: "pi-sync/work" },
      sync: { include: ["settings.json"], automatic: false },
    };
    writeFileSync(localConfigPath(), JSON.stringify(settings), { mode: 0o600 });
    const partial = await loadPartialConfig("work");
    const { ctx } = createMockContext({
      hasUI: true,
      mode: "tui",
      input: async () => "archives/work",
      select: async () => {
        await updateLocalConfig((current) => ({
          ...current,
          syncSetups: {
            ...current.syncSetups,
            work: {
              ...current.syncSetups.work,
              storage: {
                connection: "r2",
                bucket: "pi-sync-test",
                path: "rebound/work",
              },
            },
          },
        }));
        return "Save sync setup";
      },
    });
    await assert.rejects(showEditWebDavTarget(ctx, partial), /changed while it was open/u);
    const config = await loadConfig("work");
    assert.equal(config.connectionName, "r2");
    assert.equal(config.storagePath, "rebound/work");
  });
});

test("cancelled WebDAV setup leaves settings byte-for-byte unchanged", async () => {
  await withTempHome(async (agentDir) => {
    mkdirSync(agentDir, { recursive: true });
    const before = Buffer.from(`${JSON.stringify(v3S3Settings())}\n`);
    writeFileSync(localConfigPath(), before, { mode: 0o600 });
    const { ctx } = createMockContext({
      hasUI: true,
      mode: "tui",
      input: async () => undefined,
    });
    assert.equal(await showAddWebDavStorageProfile(ctx), false);
    assert.deepEqual(readFileSync(localConfigPath()), before);
  });
});

function secretInput(secret: string, rendered: string[] = []) {
  return async (factory: unknown) => {
    const tui = createTuiHarness({ width: 50 });
    const running = tui.custom(factory as Parameters<typeof tui.custom>[0]);
    await tui.waitForOpen();
    tui.type(secret);
    rendered.push(tui.render().join("\n"));
    tui.press("tui.input.submit");
    return running;
  };
}
