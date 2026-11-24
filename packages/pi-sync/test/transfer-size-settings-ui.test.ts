import assert from "node:assert/strict";
import fs from "node:fs/promises";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { createTuiHarness } from "@narumitw/pi-tui-kit/testing";
import { test } from "vitest";
import { createMockContext } from "../../../test/support.js";
import { loadSettingsConfig } from "../src/settings/config.js";
import { localConfigPath, withConfigFilePublicationForTest } from "../src/settings/config-file.js";
import { updateLocalConfig } from "../src/settings/settings-store.js";
import { showSyncSettings } from "../src/ui/settings-ui.js";
import { v3S3Settings, withTempHome } from "./helpers.js";

const fileLabel = "Max file size";
const directoryLabel = "Max directory size";

async function writeSettings(root: string, version = 3) {
  await fs.mkdir(root, { recursive: true });
  const settings = v3S3Settings();
  const work = v3S3Settings({ path: "pi-sync/work" }).syncSetups.home;
  const text = JSON.stringify({
    ...settings,
    version,
    futureField: "keep",
    syncSetups: { ...settings.syncSetups, work },
  });
  await fs.writeFile(localConfigPath(), text);
  return text;
}

function search(tui: ReturnType<typeof createTuiHarness>, label: string) {
  tui.send("\u0015");
  tui.send(`\u001b[200~${label}\u001b[201~`);
}

async function savedLimits() {
  const config = await loadSettingsConfig();
  return [config.maxFileSizeMiB, config.maxDirectorySizeMiB, config.settingsVersion];
}

const keys: Record<string, string> = {
  "tui.select.confirm": "x",
  "tui.select.cancel": "q",
  "tui.select.up": "k",
  "tui.select.down": "j",
};

function limitHarness() {
  return createTuiHarness({
    width: 80,
    rows: 24,
    keybindings: {
      matches: (data, action) => data === keys[action],
      getKeys: (action) => (keys[action] ? [keys[action]] : []) as never,
    },
  });
}

test("transfer size rows save independently, warn only on upgrade, and retain search", async () =>
  withTempHome(async (root) => {
    const before = await writeSettings(root);
    const tui = limitHarness();
    const values = ["Off", "3", "8589934591", "  oFf  ", "Off"];
    const reviews: string[] = [];
    const prompts: string[] = [];
    const routes: string[] = [];
    const context = createMockContext({
      mode: "tui",
      custom: tui.custom,
      input: async (title: string) => {
        prompts.push(title);
        return values.shift();
      },
      confirm: async (title: string, body: string) => {
        reviews.push(`${title}\n${body}`);
        return true;
      },
    });
    const running = showSyncSettings(context.ctx, async (route) => {
      routes.push(route);
    });
    const edit = async (label: string) => {
      search(tui, label);
      tui.send("x");
      await tui.waitForPending();
      await tui.waitForOpen();
      return tui.render().join("\n");
    };
    try {
      await tui.waitForOpen();
      assert.match(await edit(fileLabel), /Max file size\s+Off/u);
      assert.equal(await fs.readFile(localConfigPath(), "utf8"), before);
      assert.deepEqual(context.notifications, []);
      assert.match(await edit(fileLabel), /Max file size\s+3 MiB/u);
      assert.deepEqual(await savedLimits(), [3, undefined, 9]);
      const directory = await edit(directoryLabel);
      assert.match(directory, /Max directory size\s+8589934591 MiB/u);
      assert.doesNotMatch(directory, /Included paths|Max file size/u);
      assert.deepEqual(await savedLimits(), [3, 8589934591, 9]);
      for (const width of [1, 12, 32, 48]) {
        const frame = tui.resize({ width, rows: 4 });
        assert.equal(frame.length, 1);
        assert.ok(visibleWidth(frame[0] ?? "") <= width);
        if (width >= 48) assert.match(frame[0] ?? "", /→ Max directory size/u);
      }
      tui.resize({ width: 80, rows: 24 });
      assert.match(await edit(fileLabel), /Max file size\s+Off/u);
      assert.deepEqual(await savedLimits(), [undefined, 8589934591, 9]);
      assert.match(await edit(directoryLabel), /Max directory size\s+Off/u);
      assert.deepEqual(await savedLimits(), [undefined, undefined, 9]);
      tui.send("q");
      await running;
      const saved = JSON.parse(await fs.readFile(localConfigPath(), "utf8"));
      const original = JSON.parse(before);
      assert.deepEqual(saved, { ...original, version: 9 });
      assert.deepEqual(routes, []);
      assert.equal(reviews.length, 1);
      assert.match(reviews[0] ?? "", /Upgrade Pi Sync settings to version 9\?/u);
      assert.match(reviews[0] ?? "", /cannot read this settings file for any setup/u);
      assert.match(reviews[0] ?? "", /limits Off later does not downgrade/u);
      assert.match(reviews[0] ?? "", /Remote snapshots are unchanged/u);
      assert.match(prompts[3] ?? "", /Max file size for “home” \(current: 3 MiB\)/u);
      assert.equal(context.notifications.filter(({ message }) => /no transfer started/u.test(message)).length, 4);
    } finally {
      tui.dispose();
      await running;
    }
  }));

test("transfer size input rejects invalid or overflowing values before any upgrade review", async () =>
  withTempHome(async (root) => {
    const before = await writeSettings(root);
    const invalid = ["", "  ", "0", "-1", "+1", "1.0", "1.5", "1e3", "0x10", "0b1", "1 MiB", "NaN", "8589934592"];
    const drafts = [...invalid];
    const reviews: string[] = [];
    const tui = createTuiHarness();
    const context = createMockContext({
      mode: "tui",
      custom: tui.custom,
      input: async () => drafts.shift(),
      confirm: async (title: string) => {
        reviews.push(title);
        return true;
      },
    });
    const running = showSyncSettings(context.ctx, async () => undefined);
    try {
      await tui.waitForOpen();
      search(tui, fileLabel);
      for (const input of invalid) {
        tui.press("tui.select.confirm");
        await tui.waitForPending();
        assert.equal(context.notifications.at(-1)?.level, "error", input);
        assert.match(context.notifications.at(-1)?.message ?? "", /Off or a positive whole number.*safe byte count/u);
        assert.match(tui.render().join("\n"), /Max file size\s+Off/u);
      }
      assert.deepEqual(drafts, []);
      assert.deepEqual(reviews, []);
      assert.equal(context.notifications.length, invalid.length);
      assert.equal(await fs.readFile(localConfigPath(), "utf8"), before);
      tui.press("ctrl+c");
      await running;
    } finally {
      tui.dispose();
      await running;
    }
  }));

for (const cancelAt of ["input", "upgrade"] as const) {
  test(`cancelling transfer-size ${cancelAt} leaves old settings unchanged`, async () =>
    withTempHome(async (root) => {
      const before = await writeSettings(root, 8);
      const tui = limitHarness();
      let reviews = 0;
      const context = createMockContext({
        mode: "tui",
        custom: tui.custom,
        input: async () => (cancelAt === "input" ? undefined : "4"),
        confirm: async () => {
          reviews++;
          return false;
        },
      });
      const running = showSyncSettings(context.ctx, async () => undefined);
      try {
        await tui.waitForOpen();
        search(tui, directoryLabel);
        tui.send("x");
        await tui.waitForPending();
        assert.equal(tui.isOpen, true);
        assert.match(tui.render().join("\n"), /Max directory size\s+Off/u);
        assert.equal(reviews, cancelAt === "input" ? 0 : 1);
        assert.equal(await fs.readFile(localConfigPath(), "utf8"), before);
        assert.deepEqual(context.notifications, []);
        tui.send("q");
        assert.equal(await running, "back");
      } finally {
        tui.dispose();
        await running;
      }
    }));
}

test("a failed transfer-size write leaves the row unchanged and permits retry", async () =>
  withTempHome(async (root) => {
    const before = await writeSettings(root, 9);
    const tui = createTuiHarness();
    const context = createMockContext({ mode: "tui", custom: tui.custom, input: async () => "5" });
    const running = showSyncSettings(context.ctx, async () => undefined);
    const submit = async () => {
      tui.press("tui.select.confirm");
      await tui.waitForPending();
    };
    try {
      await tui.waitForOpen();
      search(tui, directoryLabel);
      await withConfigFilePublicationForTest(async () => {
        throw new Error("publication failed");
      }, submit);
      assert.equal(await fs.readFile(localConfigPath(), "utf8"), before);
      assert.match(tui.render().join("\n"), /Max directory size\s+Off/u);
      assert.equal(context.notifications.at(-1)?.message, "Pi Sync settings save failed: publication failed");
      await submit();
      await tui.waitForOpen();
      assert.match(tui.render().join("\n"), /Max directory size\s+5 MiB/u);
      assert.deepEqual(await savedLimits(), [undefined, 5, 9]);
      tui.press("ctrl+c");
      await running;
    } finally {
      tui.dispose();
      await running;
    }
  }));

for (const change of ["active setup", "same setup policy"] as const) {
  test(`transfer size save refuses a stale ${change} after upgrade review`, async () =>
    withTempHome(async (root) => {
      await writeSettings(root, 8);
      const choices = [fileLabel, undefined];
      let externalDocument: string | undefined;
      const context = createMockContext({
        mode: "tui",
        select: async () => choices.shift(),
        input: async () => "5",
        confirm: async () => {
          await updateLocalConfig((settings) => {
            if (change === "active setup") return { ...settings, activeSyncSetup: "work" };
            const home = settings.syncSetups.home;
            return {
              ...settings,
              syncSetups: {
                ...settings.syncSetups,
                home: { ...home, sync: { ...home.sync, automatic: true } },
              },
            };
          });
          externalDocument = await fs.readFile(localConfigPath(), "utf8");
          return true;
        },
      });
      await showSyncSettings(context.ctx, async () => undefined);
      assert.ok(externalDocument);
      assert.equal(await fs.readFile(localConfigPath(), "utf8"), externalDocument);
      assert.equal(context.notifications.at(-1)?.level, "error");
      assert.match(context.notifications.at(-1)?.message ?? "", /changed.*reopen/iu);
      assert.deepEqual(await savedLimits(), [undefined, undefined, 8]);
    }));
}

type TerminalInputHandler = Parameters<ExtensionCommandContext["ui"]["onTerminalInput"]>[0];

for (const reason of [
  "Ctrl+C during input",
  "Ctrl+C during upgrade review",
  "owner cancellation",
  "component disposal",
  "session replacement",
] as const) {
  test(`pending transfer-size edit is abandoned on ${reason}`, async () =>
    withTempHome(async (root) => {
      const before = await writeSettings(root);
      const tui = limitHarness();
      const owner = new AbortController();
      const listeners = new Set<TerminalInputHandler>();
      const context = createMockContext({
        mode: "tui",
        custom: tui.custom,
        onTerminalInput(listener: TerminalInputHandler) {
          listeners.add(listener);
          return () => {
            listeners.delete(listener);
          };
        },
      });
      const ctx = context.ctx as ExtensionCommandContext;
      const opened = Promise.withResolvers<AbortSignal | undefined>();
      const answer = Promise.withResolvers<string | undefined>();
      const waitForAnswer = (signal?: AbortSignal) => {
        signal?.addEventListener("abort", () => answer.resolve(undefined), { once: true });
        opened.resolve(signal);
        return answer.promise;
      };
      ctx.ui.input = async (_title, _placeholder, options) =>
        reason === "Ctrl+C during upgrade review" ? "5" : waitForAnswer(options?.signal);
      ctx.ui.confirm = async (_title, _message, options) => (await waitForAnswer(options?.signal)) === "yes";
      const hardCancel = reason === "Ctrl+C during input" || reason === "Ctrl+C during upgrade review";
      const running = showSyncSettings(ctx, async () => undefined, owner.signal);
      try {
        await tui.waitForOpen();
        search(tui, fileLabel);
        tui.send("x");
        const dialogSignal = await opened.promise;
        assert.ok(dialogSignal);
        assert.equal(dialogSignal.aborted, false);
        if (hardCancel) {
          const listener = [...listeners][0];
          assert.ok(listener);
          assert.equal(listener("\u001b[99;5:3u"), undefined);
          assert.equal(listener("\u001b[200~\u0003\u001b[201~"), undefined);
          assert.deepEqual(listener("\u0003"), { consume: true });
        } else if (reason === "owner cancellation") owner.abort();
        else if (reason === "component disposal") tui.dispose();
        else {
          ctx.sessionManager = { ...ctx.sessionManager, getSessionId: () => "replacement" };
          answer.resolve("5");
        }
        await tui.waitForPending();
        if (reason !== "session replacement") assert.equal(dialogSignal.aborted, true);
        if (hardCancel) {
          assert.equal(tui.isOpen, false);
          assert.equal(await running, "exit");
        } else {
          if (tui.isOpen) tui.press("ctrl+c");
          await running;
        }
        assert.equal(listeners.size, 0);
        assert.equal(await fs.readFile(localConfigPath(), "utf8"), before);
        assert.deepEqual(context.notifications, []);
      } finally {
        answer.resolve(undefined);
        owner.abort();
        tui.dispose();
        await running;
      }
    }));
}

for (const mode of ["rpc", "print", "json"] as const) {
  test(`transfer-size settings do not open preference dialogs in ${mode} mode`, async () =>
    withTempHome(async (root) => {
      const before = await writeSettings(root);
      const dialogs: string[] = [];
      const context = createMockContext({
        mode,
        custom: async () => dialogs.push("custom"),
        input: async () => dialogs.push("input"),
        confirm: async () => dialogs.push("confirm"),
      });
      await showSyncSettings(context.ctx, async () => undefined);
      assert.deepEqual(dialogs, []);
      assert.equal(await fs.readFile(localConfigPath(), "utf8"), before);
      if (mode === "rpc") {
        const message = context.notifications[0]?.message ?? "";
        assert.ok(message.startsWith(`Edit pi-sync settings manually: ${localConfigPath()}`));
        assert.match(message, /sync\.maxFileSizeMiB.*sync\.maxDirectorySizeMiB/u);
        assert.match(message, /requires settings version 9/u);
      } else assert.deepEqual(context.notifications, []);
    }));
}
