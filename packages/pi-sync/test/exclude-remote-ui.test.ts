import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { createTuiHarness } from "@narumitw/pi-tui-kit/testing";
import { test } from "vitest";
import { createMockContext } from "../../../test/support.js";
import { loadConfig } from "../src/settings/config.js";
import { localConfigPath } from "../src/settings/config-file.js";
import { readLocalConfigObject } from "../src/settings/settings-store.js";
import { selectionForSnapshot } from "../src/sync/sync-policy.js";
import { showRemoteSelectionReview } from "../src/ui/remote-selection-ui.js";
import { snapshot, v3S3Settings, withTempHome } from "./helpers.js";
import { MemorySyncBackend } from "./memory-sync-backend.js";

initTheme("dark", false);
async function ready(tui: ReturnType<typeof createTuiHarness>) {
  for (let i = 0; i < 10; i++) {
    await tui.waitForOpen();
    if (
      !/Checking remote content list|Checking and saving remote content list|Refreshing remote content list/u.test(
        tui.render().join("\n"),
      )
    )
      return;
    await tui.waitForPending();
  }
  assert.fail("Selection UI did not become ready");
}

for (const clearing of [false, true])
  test(`remote adoption saves both policies without a transfer; clear=${clearing}`, async () =>
    withTempHome(async (root) => {
      await fs.mkdir(root, { recursive: true });
      const base = v3S3Settings({ include: ["skills"] });
      if (clearing) {
        base.version = 6;
        Object.assign(base.syncSetups.home.sync, { exclude: ["skills/private"] });
      }
      await fs.writeFile(localConfigPath(), JSON.stringify({ ...base, future: "retained" }));
      const backend = new MemorySyncBackend();
      await backend.publishSnapshot(
        {
          ...snapshot([]),
          version: clearing ? 1 : 4,
          selection: selectionForSnapshot(["skills"], clearing ? undefined : ["skills/private"]),
        },
        { kind: "missing" },
      );
      const head = await backend.readHead();
      let confirmations = 0;
      let routes = 0;
      const tui = createTuiHarness({ width: 100, rows: 30 });
      const { ctx } = createMockContext({
        hasUI: true,
        mode: "tui",
        custom: tui.custom,
        confirm: async () => {
          confirmations++;
          return true;
        },
      });
      const running = showRemoteSelectionReview(ctx, "home", undefined, () => backend, {
        runRoute: async () => {
          routes++;
          return { kind: "completed" };
        },
      });
      await ready(tui);
      const summary = tui.render().join("\n");
      assert.match(summary, /excluded paths/i);
      assert.doesNotMatch(summary, /Only the ordering differs/);
      tui.press("tui.select.down");
      tui.press("tui.select.confirm");
      await ready(tui);
      assert.match(tui.render().join("\n"), /Remote content list saved/);
      tui.press("tui.select.cancel");
      await running;
      tui.dispose();
      assert.deepEqual((await loadConfig()).exclude, clearing ? [] : ["skills/private"]);
      assert.equal((await readLocalConfigObject())?.version, 6);
      assert.equal((await readLocalConfigObject())?.future, "retained");
      assert.equal(confirmations, clearing ? 0 : 1);
      assert.equal(routes, 0);
      assert.deepEqual(await backend.readHead(), head);
    }));

test("RPC reports exclude-only mismatch without calling it order-only or opening custom UI", async () =>
  withTempHome(async (root) => {
    await fs.mkdir(root, { recursive: true });
    await fs.writeFile(localConfigPath(), JSON.stringify(v3S3Settings({ include: ["skills"] })));
    const backend = new MemorySyncBackend();
    await backend.publishSnapshot(
      { ...snapshot([]), version: 4, selection: selectionForSnapshot(["skills"], ["skills/private"]) },
      { kind: "missing" },
    );
    const before = await fs.readFile(localConfigPath(), "utf8");
    const { ctx, notifications } = createMockContext({
      hasUI: true,
      mode: "rpc",
      custom: async () => {
        throw new Error("TUI forbidden");
      },
    });
    await showRemoteSelectionReview(ctx, "home", undefined, () => backend);
    const output = notifications.map((item) => item.message).join("\n");
    assert.match(output, /Remote excluded paths: skills\/private/);
    assert.doesNotMatch(output, /Only ordering differs/);
    assert.equal(await fs.readFile(localConfigPath(), "utf8"), before);
  }));

test("exclude-only remote race refreshes rather than adopting a stale rule", async () =>
  withTempHome(async (root) => {
    await fs.mkdir(root, { recursive: true });
    const before = JSON.stringify(v3S3Settings({ include: ["skills"] }));
    await fs.writeFile(localConfigPath(), before);
    const backend = new MemorySyncBackend();
    await backend.publishSnapshot(
      { ...snapshot([]), version: 4, selection: selectionForSnapshot(["skills"], ["skills/private"]) },
      { kind: "missing" },
    );
    const read = backend.readSnapshot.bind(backend);
    let reads = 0;
    backend.readSnapshot = async (reference, signal) => {
      const value = await read(reference, signal);
      if (++reads === 2) {
        const head = await backend.readHead();
        assert.ok(head);
        await backend.publishSnapshot(
          { ...value, id: "changed-exclude", selection: selectionForSnapshot(["skills"], ["skills/other"]) },
          { kind: "revision", revision: head.revision },
        );
      }
      return value;
    };
    const controller = new AbortController();
    const tui = createTuiHarness({ width: 100, rows: 30 });
    const { ctx, notifications } = createMockContext({
      hasUI: true,
      mode: "tui",
      custom: tui.custom,
      confirm: async () => true,
    });
    const running = showRemoteSelectionReview(ctx, "home", controller.signal, () => backend);
    await ready(tui);
    tui.press("tui.select.down");
    tui.press("tui.select.confirm");
    await ready(tui);
    controller.abort();
    tui.dispose();
    await running;
    assert.equal(await fs.readFile(localConfigPath(), "utf8"), before);
    assert.ok(notifications.some((item) => /Refreshing/u.test(item.message)));
  }));
