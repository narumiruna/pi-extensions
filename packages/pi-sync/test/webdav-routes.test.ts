import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "vitest";
import { createMockContext, createMockPi } from "../../../test/support.js";
import type { CommandOptions } from "../src/commands/command-types.js";
import { localConfigPath } from "../src/settings/config-file.js";
import { diff, doctor, history, pull, push, rollback, status, syncBoth } from "../src/sync/sync-operations.js";
import syncExtension from "../src/sync.js";
import { withTempHome } from "./helpers.js";
import { MockWebDavServer } from "./mock-webdav-server.js";

function options(args: string[] = []): CommandOptions {
  return {
    yes: true,
    force: false,
    stale: false,
    silent: false,
    reload: false,
    auto: false,
    args,
  };
}

test("all backend-neutral sync routes operate against a WebDAV target", async () => {
  const server = await new MockWebDavServer().start();
  try {
    await withTempHome(async (agentDir) => {
      mkdirSync(agentDir, { recursive: true });
      writeFileSync(path.join(agentDir, "settings.json"), '{"theme":"dark"}\n');
      writeFileSync(
        localConfigPath(),
        JSON.stringify({
          version: 3,
          activeSyncSetup: "home",
          onSwitch: "ask-before-pull",
          storageConnections: {
            dav: {
              type: "webdav",
              url: server.url,
              credentials: { username: "user", password: "pass" },
            },
          },
          syncSetups: {
            home: {
              storage: { connection: "dav", path: "pi-sync/home" },
              sync: { include: ["settings.json"], automatic: true },
            },
          },
        }),
      );
      const { ctx, notifications } = createMockContext({ hasUI: true });
      await doctor(ctx, options());
      await status(ctx, options());
      await diff(ctx, options());
      await push(ctx, options());
      const pointer = JSON.parse(server.resources.get("/dav/pi-sync/home/latest.json")?.toString("utf8") ?? "null") as {
        snapshot: string;
      };
      assert.ok(pointer.snapshot);
      await history(ctx, options());
      writeFileSync(path.join(agentDir, "settings.json"), '{"theme":"light"}\n');
      await pull(ctx, options());
      assert.equal(readFileSync(path.join(agentDir, "settings.json"), "utf8"), '{"theme":"dark"}\n');
      await syncBoth(ctx, options());
      await rollback(ctx, options([pointer.snapshot]));
      const mock = createMockPi();
      syncExtension(mock.pi);
      await mock.commands.get("sync")?.handler("config", ctx);
      const configOutput = notifications.at(-1)?.message ?? "";
      assert.match(configOutput, /kind: webdav/);
      assert.match(configOutput, /password: configured/);
      assert.match(configOutput, /url: http:\/\/127\.0\.0\.1:\d+\/…/u);
      assert.doesNotMatch(configOutput, /endpoint:|bucket:|password: pass/);
      assert.match(notifications.map((item) => item.message).join("\n"), /WebDAV|webdav|snapshot/i);
    });
  } finally {
    await server.close();
  }
});
