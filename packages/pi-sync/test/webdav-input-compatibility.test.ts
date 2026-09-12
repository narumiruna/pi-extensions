import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { createTuiHarness } from "@narumitw/pi-tui-kit/testing";
import { test } from "vitest";
import { WebDavClient } from "../src/backends/webdav/webdav-client.js";
import { loadConfig, loadPartialConfig } from "../src/settings/config.js";
import { localConfigPath } from "../src/settings/config-file.js";
import { readLocalConfigObject } from "../src/settings/settings-store.js";
import {
  showAddWebDavStorageProfile,
  showAddWebDavTarget,
  showEditWebDavStorageProfile,
  showEditWebDavTarget,
  showWebDavSetup,
} from "../src/ui/setup/webdav-ui.js";
import { v3WebDavSettings, withTempHome } from "./helpers.js";
import { createMockContext } from "./setup-test-context.js";

initTheme("dark", false);

function seed(value: unknown) {
  mkdirSync(path.dirname(localConfigPath()), { recursive: true });
  writeFileSync(localConfigPath(), JSON.stringify(value), { mode: 0o600 });
}

for (const storagePath of ["backups/<work>", "backups/work>", "backups/<work"]) {
  test.each(["", storagePath])("WebDAV edit retains valid path %s", async (answer) => {
    await withTempHome(async () => {
      const settings = v3WebDavSettings();
      settings.syncSetups.home.storage.path = storagePath;
      seed(settings);
      const before = await loadConfig();
      const { ctx } = createMockContext({
        hasUI: true,
        mode: "tui",
        input: async () => answer,
        select: async () => "Save sync setup",
      });
      assert.equal(await showEditWebDavTarget(ctx, await loadPartialConfig()), true);
      assert.equal((await loadConfig()).storagePath, before.storagePath);
    });
  });
}

test.each(["first", "add", "edit"])(
  "WebDAV %s connection accepts valid brackets without exposing credentials",
  async (flow) => {
    await withTempHome(async () => {
      const settings = v3WebDavSettings();
      if (flow !== "first") seed(settings);
      const inputs = [
        ...(flow === "add" ? ["<archive>"] : []),
        "https://cloud.example.com/<dav>",
        "<account>",
        ...(flow === "first" ? ["backups/<work>"] : []),
      ];
      const choices =
        flow === "first"
          ? ["Minimal settings", "Keep automatic sync off", "Keep sessions off (recommended)", "Save setup"]
          : flow === "add"
            ? ["Add storage connection"]
            : ["Keep current password", "Save storage connection"];
      const titles: string[] = [];
      const { ctx, notifications } = createMockContext({
        hasUI: true,
        mode: "tui",
        input: async (title: string) => {
          titles.push(title);
          return inputs.shift();
        },
        select: async (title: string) => {
          titles.push(title);
          return choices.shift();
        },
        custom: async (factory: unknown) => {
          const tui = createTuiHarness();
          const running = tui.custom(factory as Parameters<typeof tui.custom>[0]);
          await tui.waitForOpen();
          tui.type("private-password");
          tui.press("tui.input.submit");
          return running;
        },
      });
      const saved =
        flow === "first"
          ? await showWebDavSetup(ctx, "home")
          : flow === "add"
            ? await showAddWebDavStorageProfile(ctx)
            : await showEditWebDavStorageProfile(ctx, "dav", {
                ...settings.storageConnections.dav,
                ...settings.storageConnections.dav.credentials,
              });
      assert.equal(saved, true);
      const name = flow === "first" ? "home" : flow === "add" ? "<archive>" : "dav";
      const connection = (await readLocalConfigObject())?.storageConnections[name];
      assert.equal(connection?.type, "webdav");
      if (connection?.type !== "webdav") return;
      assert.equal(connection.url, "https://cloud.example.com/%3Cdav%3E/");
      assert.equal(connection.credentials.username, "<account>");
      assert.doesNotMatch(
        [...titles, ...notifications.map((n) => n.message)].join("\n"),
        /<account>|private-password/u,
      );
    });
  },
);

test("WebDAV additional setup accepts a bracket path and cancellation preserves settings", async () => {
  await withTempHome(async () => {
    seed(v3WebDavSettings());
    const choices = ["Minimal settings", "Keep automatic sync off", "Add sync setup"];
    const { ctx } = createMockContext({
      hasUI: true,
      mode: "tui",
      input: async () => "backups/<work>",
      select: async () => choices.shift(),
    });
    assert.equal(await showAddWebDavTarget(ctx, "work", "dav"), true);
    assert.equal((await loadConfig("work")).storagePath, "backups/<work>");
    const before = readFileSync(localConfigPath());
    const controller = new AbortController();
    const late = createMockContext({
      hasUI: true,
      mode: "tui",
      input: async () => {
        controller.abort(new DOMException("Session replaced", "AbortError"));
        return "backups/<late>";
      },
    });
    await assert.rejects(showAddWebDavTarget(late.ctx, "late", "dav", controller.signal), {
      name: "AbortError",
    });
    assert.deepEqual(readFileSync(localConfigPath()), before);
  });
});

test("WebDAV client percent-encodes literal brackets in each remote segment", async () => {
  const original = globalThis.fetch;
  const urls: string[] = [];
  globalThis.fetch = async (input) => {
    urls.push(String(input));
    return new Response(null, { status: 404 });
  };
  try {
    const client = new WebDavClient({
      type: "webdav",
      profile: {
        kind: "webdav",
        url: "https://cloud.example.com/dav/",
        username: "user",
        password: "pass",
      },
      destination: { path: "backups/<work>", namespace: "<work>" },
    });
    assert.equal((await client.getBuffer("backups/<work>/latest.json")).missing, true);
    assert.deepEqual(urls, ["https://cloud.example.com/dav/backups/%3Cwork%3E/latest.json"]);
  } finally {
    globalThis.fetch = original;
  }
});
