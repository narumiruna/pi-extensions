import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { setImmediate } from "node:timers/promises";
import { stripVTControlCharacters } from "node:util";
import {
  DefaultResourceLoader,
  type ExtensionCommandContext,
  initTheme,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { createTuiHarness } from "@narumitw/pi-tui-kit/testing";
import { test } from "vitest";
import { bindMockToolLoadout, createMockContext } from "../../../test/support.js";
import { adoptFixtureRoot } from "./daemon-test-helpers.js";
import { v3WebDavSettings, withTempHome } from "./helpers.js";
import { MockWebDavServer } from "./mock-webdav-server.js";

initTheme("dark", false);

for (const entrypoint of ["menu", "direct"] as const) {
  test(`packaged Jiti: ${entrypoint} View differences opens a read-only preview from loopback WebDAV`, async ({
    signal,
  }) => {
    const server = await new MockWebDavServer().start();
    try {
      await withTempHome(async (agentDir) => {
        await mkdir(agentDir, { recursive: true });
        const settings = v3WebDavSettings({ automatic: false, include: ["settings.json"] });
        settings.storageConnections.dav.url = server.url;
        const config = JSON.stringify(settings);
        const local = '{"theme":"local-fake-value"}\n';
        await writeFile(join(agentDir, "pi-sync.json"), config, { mode: 0o600 });
        await writeFile(join(agentDir, "settings.json"), local);
        await adoptFixtureRoot(agentDir);
        const loader = new DefaultResourceLoader({
          cwd: agentDir,
          agentDir,
          settingsManager: SettingsManager.inMemory({}),
          additionalExtensionPaths: [resolve("packages/pi-sync")],
        });
        await loader.reload();
        const loaded = loader.getExtensions();
        assert.deepEqual(loaded.errors, []);
        bindMockToolLoadout(loaded.runtime);
        const extension = loaded.extensions[0];
        const command = extension?.commands.get("sync");
        assert.ok(extension && command);
        const tui = createTuiHarness({ width: 80, rows: 24 });
        let requestedOverlay = false;
        const custom: ExtensionCommandContext["ui"]["custom"] = (factory, options) => {
          if (options?.overlay) requestedOverlay = true;
          return tui.custom(factory);
        };
        const mock = createMockContext({ mode: "tui", custom });
        const report = () => stripVTControlCharacters(tui.render().join("\n"));
        let running: Promise<void> | undefined;
        let finished = false;
        const waitFor = async (text: RegExp) => {
          while (!tui.isOpen || !text.test(report())) {
            signal.throwIfAborted();
            if (finished) {
              await running;
              assert.fail(`Sync closed before reaching ${text}; notifications: ${JSON.stringify(mock.notifications)}`);
            }
            await setImmediate(undefined, { signal });
          }
        };
        try {
          for (const start of extension.handlers.get("session_start") ?? [])
            await start({ type: "session_start", reason: "startup" }, mock.ctx);
          running = Promise.resolve(command.handler(entrypoint === "menu" ? "" : "diff", mock.ctx)).finally(() => {
            finished = true;
          });
          void running.catch(() => {});
          if (entrypoint === "menu") {
            await waitFor(/Manage sync/u);
            for (let index = 0; index < 8 && !/→ View differences/u.test(report()); index++)
              tui.press("tui.select.down");
            assert.match(report(), /→ View differences/u);
            tui.press("tui.select.confirm");
          }
          await waitFor(/Local only/u);
          assert.match(report(), /settings\.json/u);
          assert.doesNotMatch(report(), /local-fake-value/u);
          tui.press("tui.select.confirm");
          await waitFor(/-\{"theme":"local-fake-value"\}/u);
          assert.equal(requestedOverlay, true);
          tui.press("tui.select.cancel");
          await waitFor(/Local only/u);
          assert.match(report(), /→ settings\.json/u);
          tui.press("ctrl+c");
          await running;
          assert.equal(tui.isOpen, false);
          assert.ok(server.requests.some((request) => request.method === "GET"));
          assert.ok(server.requests.every((request) => request.method === "GET" || request.method === "PROPFIND"));
          assert.equal(await readFile(join(agentDir, "settings.json"), "utf8"), local);
          assert.equal(await readFile(join(agentDir, "pi-sync.json"), "utf8"), config);
          assert.ok(mock.notifications.every((notice) => !notice.message.includes("local-fake-value")));
        } finally {
          tui.dispose();
          try {
            for (const shutdown of extension.handlers.get("session_shutdown") ?? [])
              await shutdown({ type: "session_shutdown", reason: "reload" }, mock.ctx);
            await running?.catch(() => {});
          } finally {
            loaded.runtime.invalidate("generated comparison smoke complete");
          }
        }
      });
    } finally {
      await server.close();
    }
  });
}
