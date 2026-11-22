import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { DefaultResourceLoader, SettingsManager } from "@earendil-works/pi-coding-agent";
import { ensureDaemon, findDaemon } from "@narumitw/pi-sync-daemon";
import { test } from "vitest";
import { createMockContext } from "../../../test/support.js";
import { localConfigPath } from "../src/settings/config-file.js";
import { v3S3Settings, withTempHome } from "./helpers.js";

const packageRoot = path.resolve("packages/pi-sync");

test("generated Jiti runtime reviews and stops a daemon through RPC without starting another", () =>
  withTempHome(async (root) => {
    await fs.mkdir(root, { recursive: true });
    await fs.writeFile(localConfigPath(), JSON.stringify(v3S3Settings()), { mode: 0o600 });
    const owner = await ensureDaemon(root);
    const loader = new DefaultResourceLoader({
      cwd: root,
      agentDir: root,
      settingsManager: SettingsManager.inMemory({}),
      noContextFiles: true,
      additionalExtensionPaths: [path.join(packageRoot, "dist/index.ts")],
    });
    await loader.reload();
    const loaded = loader.getExtensions();
    const reviews: string[] = [];
    const { ctx, notifications } = createMockContext({
      mode: "rpc",
      confirm: async (_title: string, message: string) => {
        reviews.push(message);
        return true;
      },
    });
    const extension = loaded.extensions.find((item) => item.commands.has("sync"));
    try {
      assert.deepEqual(loaded.errors, []);
      const command = extension?.commands.get("sync");
      assert.ok(command);
      for (const start of extension?.handlers.get("session_start") ?? [])
        await start({ type: "session_start", reason: "startup" }, ctx);
      await command.handler("daemon recover", ctx);
      assert.match(reviews[0] ?? "", new RegExp(`PID: ${owner.identity.pid}`, "u"));
      assert.match(notifications.at(-1)?.message ?? "", /daemon exited\. Use \/reload/u);
      assert.equal(await findDaemon(root), undefined);
      for (const shutdown of extension?.handlers.get("session_shutdown") ?? [])
        await shutdown({ type: "session_shutdown", reason: "reload" }, ctx);
      for (const start of extension?.handlers.get("session_start") ?? [])
        await start({ type: "session_start", reason: "reload" }, ctx);
      const replacement = await findDaemon(root);
      assert.ok(replacement);
      assert.notEqual(replacement.identity.instance, owner.identity.instance);
      assert.ok(!notifications.some((item) => item.level === "error"));
    } finally {
      for (const shutdown of extension?.handlers.get("session_shutdown") ?? [])
        await shutdown({ type: "session_shutdown", reason: "reload" }, ctx);
      loaded.runtime.invalidate("daemon recovery generated smoke complete");
    }
  }));

test("generated Jiti runtime loads exclude-enabled settings through a lazy command in RPC", async () =>
  withTempHome(async (root) => {
    await fs.mkdir(root, { recursive: true });
    const settings = v3S3Settings({ include: ["skills"] });
    settings.version = 6;
    Object.assign(settings.syncSetups.home.sync, { exclude: ["skills/private"] });
    await fs.writeFile(localConfigPath(), JSON.stringify(settings), { mode: 0o600 });
    const loader = new DefaultResourceLoader({
      cwd: root,
      agentDir: root,
      settingsManager: SettingsManager.inMemory({}),
      noContextFiles: true,
      additionalExtensionPaths: [path.join(packageRoot, "dist/index.ts")],
    });
    await loader.reload();
    const loaded = loader.getExtensions();
    try {
      assert.deepEqual(loaded.errors, []);
      const extension = loaded.extensions.find((extension) => extension.commands.has("sync"));
      assert.ok(extension);
      const command = extension.commands.get("sync");
      assert.ok(command);
      const { ctx, notifications } = createMockContext({
        hasUI: true,
        mode: "rpc",
        custom: async () => {
          throw new Error("Custom UI is TUI-only");
        },
      });
      for (const start of extension.handlers.get("session_start") ?? [])
        await start({ type: "session_start", reason: "startup" }, ctx);
      await command.handler("files", ctx);
      assert.ok(notifications.some((item) => /exclude: skills\/private/.test(item.message)));
      for (const shutdown of extension.handlers.get("session_shutdown") ?? [])
        await shutdown({ type: "session_shutdown", reason: "quit" }, ctx);
    } finally {
      loaded.runtime.invalidate("exclude generated smoke complete");
    }
  }));
