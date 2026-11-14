import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { initTheme, type KeybindingsManager } from "@earendil-works/pi-coding-agent";
import { type KeyId, visibleWidth } from "@earendil-works/pi-tui";
import { createTuiHarness } from "@narumitw/pi-tui-kit/testing";
import { test } from "vitest";
import { createMockContext } from "../../../test/support.js";
import { loadConfig, syncConfigReviewFingerprint } from "../src/settings/config.js";
import { localConfigPath } from "../src/settings/config-file.js";
import type { PiSyncSettingsV3 } from "../src/settings/settings-types.js";
import { readSyncIgnoreFile } from "../src/settings/sync-ignore-file.js";
import { remoteSelectionMismatch } from "../src/sync/sync-policy.js";
import { showRemoteSelectionReview } from "../src/ui/remote-selection-ui.js";
import { showSyncSettings } from "../src/ui/settings-ui.js";
import { showSyncIgnoreSettings } from "../src/ui/sync-ignore-ui.js";
import { snapshot, v3S3Settings, withTempHome } from "./helpers.js";
import { MemorySyncBackend } from "./memory-sync-backend.js";

initTheme("dark", false);

function remappedKeys(): Pick<KeybindingsManager, "matches" | "getKeys"> {
  const keys: Record<string, [string, KeyId]> = {
    "tui.select.cancel": ["\u0011", "ctrl+q"],
    "tui.select.confirm": ["\r", "enter"],
    "tui.input.submit": ["\r", "enter"],
    "tui.select.down": ["\u001b[B", "down"],
    "tui.select.up": ["\u001b[A", "up"],
  };
  return {
    matches: (data, action) => keys[action]?.[0] === data,
    getKeys: (action) => (keys[action] ? [keys[action][1]] : []),
  };
}

async function seed(root: string, rules?: string) {
  await fs.mkdir(root, { recursive: true });
  const settings = v3S3Settings() as unknown as PiSyncSettingsV3;
  if (rules !== undefined) {
    settings.version = 6;
    delete settings.syncSetups.home?.sync.include;
    await fs.writeFile(path.join(root, ".syncignore"), rules);
  }
  await fs.writeFile(localConfigPath(), JSON.stringify(settings));
}

test("settings migration uses the existing screen owner and saves only after explicit confirmation", async () =>
  withTempHome(async (root) => {
    await seed(root);
    const tui = createTuiHarness({ width: 80, rows: 30 });
    const { ctx, notifications } = createMockContext({ mode: "tui", custom: tui.custom });
    const running = showSyncSettings(ctx, async () => assert.fail("No transfer should start"));
    try {
      await tui.waitForOpen();
      tui.press("tui.select.confirm");
      await tui.waitForPending();
      await tui.waitForOpen();
      const review = tui.render().join("\n");
      assert.match(review, /Migrate all setups/u);
      assert.match(review, /intersection/u);
      assert.equal((await loadConfig()).syncIgnore, undefined);
      tui.press("end");
      tui.press("tui.select.confirm");
      await tui.waitForPending();
      await tui.waitForOpen();
      assert.match(tui.render().join("\n"), /.syncignore rules/u);
      assert.equal(typeof (await loadConfig()).syncIgnore, "string");
      assert.equal(
        notifications.some((item) => item.level === "error"),
        false,
      );
      tui.press("ctrl+c");
      await running;
    } finally {
      tui.dispose();
      await running;
    }
  }));

for (const cancellation of ["back", "ctrl+c", "disposal", "replacement", "shutdown"] as const)
  test(`migration ${cancellation} preserves legacy settings and creates no ignore file`, async () =>
    withTempHome(async (root) => {
      await seed(root);
      const before = await fs.readFile(localConfigPath());
      const owner = new AbortController();
      const tui = createTuiHarness({ width: 52, rows: 16, keybindings: remappedKeys() });
      const { ctx } = createMockContext({ mode: "tui", custom: tui.custom });
      const running = showSyncIgnoreSettings(ctx, owner.signal);
      try {
        await tui.waitForOpen();
        assert.ok(tui.render().every((line) => visibleWidth(line) <= 52));
        if (cancellation === "back") tui.send("\u0011");
        else if (cancellation === "ctrl+c") tui.press("ctrl+c");
        else if (cancellation === "disposal") tui.dispose();
        else owner.abort();
        await running;
        assert.deepEqual(await fs.readFile(localConfigPath()), before);
        assert.equal(await readSyncIgnoreFile(), undefined);
      } finally {
        owner.abort();
        tui.dispose();
        await running;
      }
    }));

test("ignore review is read-only and RPC provides a manual path without custom UI", async () =>
  withTempHome(async (root) => {
    const rules = "/sessions/\n/private/\n";
    await seed(root, rules);
    const { ctx, notifications } = createMockContext({
      mode: "rpc",
      custom: async () => assert.fail("RPC must not open custom UI"),
    });
    await showSyncIgnoreSettings(ctx);
    assert.match(notifications.at(-1)?.message ?? "", /.syncignore/u);
    assert.equal(await readSyncIgnoreFile(), rules);
  }));

test("remote ignore adoption reviews exact rules and updates all setups without pulling files or starting a route", async () =>
  withTempHome(async (root) => {
    const localRules = "/sessions/\n";
    const remoteRules = "/sessions/\n*.log\n";
    await seed(root, localRules);
    const settings = JSON.parse(await fs.readFile(localConfigPath(), "utf8")) as PiSyncSettingsV3;
    settings.syncSetups.work = {
      storage: { connection: "r2", bucket: "pi-sync-work", path: "./" },
      sync: { automatic: false },
    };
    await fs.writeFile(localConfigPath(), JSON.stringify(settings));
    const config = await loadConfig();
    const backend = new MemorySyncBackend();
    const remote = {
      ...snapshot([
        { path: ".syncignore", content: Buffer.from(remoteRules) },
        { path: "remote-only.toml", content: Buffer.from("remote") },
      ]),
      version: 4,
      selection: { version: 2 as const, ignore: remoteRules },
    };
    await backend.publishSnapshot(remote, { kind: "missing" });
    const decision = remoteSelectionMismatch(config, remote.selection, syncConfigReviewFingerprint(config)).decision;
    const tui = createTuiHarness({ width: 100, rows: 40 });
    const { ctx, notifications } = createMockContext({ mode: "tui", custom: tui.custom });
    const running = showRemoteSelectionReview(ctx, "home", undefined, () => backend, { decision });
    try {
      await tui.waitForOpen();
      assert.match(tui.render().join("\n"), /Review both policies/u);
      tui.press("tui.select.down");
      tui.press("tui.select.confirm");
      await tui.waitForOpen();
      const summary = tui.render().join("\n");
      assert.match(summary, /Save remote .syncignore for all setups/u);
      assert.match(summary, /\*\.log/u);
      assert.equal(await readSyncIgnoreFile(), localRules);
      for (let index = 0; index < 100 && !tui.render().join("\n").includes("→ Yes,"); index++)
        tui.press("tui.select.down");
      tui.press("tui.select.confirm");
      await tui.waitForPending();
      await tui.waitForOpen();
      for (let attempt = 0; attempt < 10 && tui.render().join("\n").includes("Checking and saving"); attempt++) {
        await tui.waitForPending();
        await tui.waitForOpen();
      }
      assert.match(tui.render().join("\n"), /Remote .syncignore saved/u, JSON.stringify(notifications));
      assert.equal(await readSyncIgnoreFile(), remoteRules);
      assert.equal((await loadConfig("work")).syncIgnore, remoteRules);
      await assert.rejects(fs.stat(path.join(root, "remote-only.toml")), { code: "ENOENT" });
      assert.equal(
        notifications.some((item) => item.level === "error"),
        false,
      );
      tui.press("tui.select.confirm");
      await running;
    } finally {
      tui.dispose();
      await running;
    }
  }));

test("declining session privacy acknowledgement keeps local ignore rules unchanged", async () =>
  withTempHome(async (root) => {
    const localRules = "/sessions/\n";
    await seed(root, localRules);
    const config = await loadConfig();
    const backend = new MemorySyncBackend();
    const remote = {
      ...snapshot([{ path: ".syncignore", content: Buffer.from("") }]),
      version: 4,
      selection: { version: 2 as const, ignore: "" },
    };
    await backend.publishSnapshot(remote, { kind: "missing" });
    const decision = remoteSelectionMismatch(config, remote.selection, syncConfigReviewFingerprint(config)).decision;
    const tui = createTuiHarness({ width: 100, rows: 40 });
    let acknowledgements = 0;
    const { ctx } = createMockContext({
      mode: "tui",
      custom: tui.custom,
      confirm: async () => {
        acknowledgements++;
        return false;
      },
    });
    const running = showRemoteSelectionReview(ctx, "home", undefined, () => backend, { decision });
    try {
      await tui.waitForOpen();
      tui.press("tui.select.down");
      tui.press("tui.select.confirm");
      await tui.waitForOpen();
      for (let index = 0; index < 100 && !tui.render().join("\n").includes("→ Yes,"); index++)
        tui.press("tui.select.down");
      tui.press("tui.select.confirm");
      await tui.waitForPending();
      await tui.waitForOpen();
      for (let attempt = 0; attempt < 10 && tui.render().join("\n").includes("Checking and saving"); attempt++) {
        await tui.waitForPending();
        await tui.waitForOpen();
      }
      assert.equal(acknowledgements, 1);
      assert.equal(await readSyncIgnoreFile(), localRules);
      tui.press("ctrl+c");
      await running;
    } finally {
      tui.dispose();
      await running;
    }
  }));
