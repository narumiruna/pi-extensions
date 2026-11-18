import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { type ExtensionCommandContext, initTheme, type TerminalInputHandler } from "@earendil-works/pi-coding-agent";
import { type KeyId, matchesKey } from "@earendil-works/pi-tui";
import { createTuiHarness } from "@narumitw/pi-tui-kit/testing";
import { test, vi } from "vitest";
import { createMockContext, createMockPi } from "../../../test/support.js";
import { adoptFixtureRoot } from "./daemon-test-helpers.js";
import { v3WebDavSettings, withTempHome } from "./helpers.js";
import { MockWebDavServer } from "./mock-webdav-server.js";

initTheme("dark", false);

const keys: Record<string, KeyId[]> = {
  "tui.select.up": ["k"],
  "tui.select.down": ["j"],
  "tui.select.confirm": ["l"],
  "tui.select.cancel": ["q"],
};

test("History rollback closes the loader and manager before reloading", () =>
  withTempHome(async (agentDir) => {
    const storage = await new MockWebDavServer().start();
    const tui = createTuiHarness({
      keybindings: {
        getKeys: (action) => keys[action] ?? [],
        matches: (data, action) => (keys[action] ?? []).some((key) => matchesKey(data, key)),
      },
    });
    const mock = createMockPi();
    const listeners = new Set<TerminalInputHandler>();
    const reloads: Array<{ loaderOpen: boolean; listeners: number }> = [];
    const confirmations: string[] = [];
    const selections: string[] = [];
    const { ctx } = createMockContext({
      mode: "tui",
      cwd: agentDir,
      custom: tui.custom,
      confirm: async (title: string) => {
        confirmations.push(title);
        return true;
      },
      reload: async () => {
        reloads.push({ loaderOpen: tui.isOpen, listeners: listeners.size });
      },
      onTerminalInput(handler: TerminalInputHandler) {
        listeners.add(handler);
        return () => listeners.delete(handler);
      },
    });
    // Keep the native History selector separate from the Kit custom screens.
    (ctx as ExtensionCommandContext).ui.select = async (title, choices) => {
      selections.push(title);
      return choices[0];
    };
    let running: Promise<unknown> | undefined;
    try {
      await fs.mkdir(agentDir, { recursive: true });
      const file = path.join(agentDir, "AGENTS.md");
      const original = "Remote baseline.\n";
      await fs.writeFile(file, original);
      const settings = v3WebDavSettings({ include: ["AGENTS.md"] });
      settings.storageConnections.dav.url = storage.url;
      await fs.writeFile(path.join(agentDir, "pi-sync.json"), JSON.stringify(settings), { mode: 0o600 });
      const { default: sync } = await import("../src/sync-extension.js");
      sync(mock.pi);
      await adoptFixtureRoot(agentDir);
      await mock.events.get("session_start")?.[0]?.({ reason: "startup" }, ctx);
      const command = mock.commands.get("sync");
      assert.ok(command);
      await command.handler("push --yes", ctx);
      await fs.writeFile(file, "Local change.\n");
      confirmations.length = 0;

      let returned = false;
      running = Promise.resolve(command.handler("", ctx)).then(() => {
        returned = true;
      });
      await Promise.race([tui.waitForOpen(), running]);
      assert.match(tui.render().join("\n"), /Manage sync/u);
      for (let index = 0; index < 12 && !tui.render().some((line) => line.includes("→ History")); index++) {
        tui.send("j");
      }
      assert.match(tui.render().join("\n"), /→ History/u);
      tui.send("l");
      await vi.waitFor(() => assert.equal(reloads.length, 1), { timeout: 2_000 });
      assert.deepEqual(reloads, [{ loaderOpen: false, listeners: 0 }]);
      await vi.waitFor(() => assert.equal(returned, true));
      assert.equal(tui.openCount, 2, "do not reopen the manager on the old runtime");
      assert.match(selections.join("\n"), /Choose a snapshot to preview rollback/u);
      assert.deepEqual(confirmations, ["Rollback pi settings?", "Reload Pi resources now?"]);
      assert.equal(await fs.readFile(file, "utf8"), original);
    } finally {
      try {
        await mock.events.get("session_shutdown")?.[0]?.({ reason: "reload" }, ctx);
      } finally {
        tui.dispose();
        await running?.catch(() => {});
        await storage.close();
      }
    }
  }));
