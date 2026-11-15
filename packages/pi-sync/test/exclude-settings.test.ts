import assert from "node:assert/strict";
import fs from "node:fs/promises";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { test } from "vitest";
import { createCustomSelectorHarness, createMockContext } from "../../../test/support.js";
import { configFromSettings, loadConfig, syncConfigReviewIdentity } from "../src/settings/config.js";
import { localConfigPath } from "../src/settings/config-file.js";
import { readLocalConfigObject, updateLocalConfig } from "../src/settings/settings-store.js";
import { validateSettingsDocument } from "../src/settings/settings-validation.js";
import { mergeJournalIdentity } from "../src/sync/merge-journal.js";
import { remoteChangedSinceState, syncPolicyChanged } from "../src/sync/sync-state.js";
import { showExcludedPaths } from "../src/ui/excluded-paths-ui.js";
import { showSyncSettings } from "../src/ui/settings-ui.js";
import { v3S3Settings, withTempHome } from "./helpers.js";

function settings(version = 6, exclude: unknown = ["skills/private"]) {
  const base = v3S3Settings({ include: ["skills"] });
  return {
    ...base,
    version,
    syncSetups: { home: { ...base.syncSetups.home, sync: { ...base.syncSetups.home.sync, exclude } } },
  };
}

for (const version of [3, 4, 5])
  test(`settings v${version} refuses an explicit exclude array`, () => {
    for (const rules of [[], ["skills/private"]])
      assert.throws(() => validateSettingsDocument(settings(version, rules)), /version 6/);
  });

test("v6 composes field/content policies; missing exclude defaults without rewriting legacy settings", () => {
  const value = settings();
  Object.assign(value.syncSetups.home.sync, { localFields: [], mergeContent: true, partialSync: true });
  const config = configFromSettings(validateSettingsDocument(value));
  assert.deepEqual(config.exclude, ["skills/private"]);
  assert.equal(config.partialSync, true);
  assert.equal(configFromSettings(validateSettingsDocument(v3S3Settings())).exclude, undefined);
  assert.throws(() => validateSettingsDocument(settings(6, null)), /array/);
});

test("exclude-only edits change state, approval and journal identities without changing legacy identity", () => {
  const config = configFromSettings(validateSettingsDocument(v3S3Settings({ include: ["skills"] })));
  const state = {
    version: 1,
    profile: config.snapshotIdentity,
    include: ["skills"],
    lastFileHashes: {},
    lastAppliedSnapshot: "base",
  };
  const changed = { ...config, exclude: ["skills/private"] };
  assert.equal(syncPolicyChanged(state, config), false);
  assert.equal(syncPolicyChanged(state, changed), true);
  assert.notEqual(syncConfigReviewIdentity(config), syncConfigReviewIdentity(changed));
  assert.notEqual(mergeJournalIdentity(config, "backend"), mergeJournalIdentity(changed, "backend"));
  assert.equal(
    mergeJournalIdentity(config, "backend"),
    JSON.stringify([config.setupName, "backend", ["skills"], null]),
  );
  assert.equal(
    syncConfigReviewIdentity({ ...changed, exclude: ["SKILLS/private"] }),
    syncConfigReviewIdentity(changed),
  );
});

test("legacy session state still requires the original remote-policy refresh without exclusions", () => {
  const state = {
    version: 1,
    profile: "home",
    lastFileHashes: {},
    lastAppliedSnapshot: "base",
    lastRemoteRevision: "rev",
    syncFiles: [],
    syncSessions: true,
  };
  const head = {
    snapshotRef: "base",
    snapshotId: "base",
    revision: "rev",
    createdAt: "2026-11-15",
    machine: "test",
    syncSessions: true,
  };
  assert.equal(
    remoteChangedSinceState(head, state, { include: ["sessions"] }, (a, b) => a === b),
    true,
  );
});

for (const choice of ["save", "discard", "dispose", "hard-cancel"])
  test(`exclude draft ${choice} is transactional with non-default keys`, async () =>
    withTempHome(async (root) => {
      await fs.mkdir(root, { recursive: true });
      const before = JSON.stringify({ ...v3S3Settings({ include: ["skills"] }), future: { retained: true } });
      await fs.writeFile(localConfigPath(), before, { mode: 0o600 });
      const frames: string[][] = [];
      let inputSignal = false;
      const { ctx } = createMockContext({
        hasUI: true,
        mode: "tui",
        custom: async (factory: unknown) => {
          const harness = createCustomSelectorHarness(factory, 48, {
            matches: (data, key) =>
              (key === "tui.select.confirm" && data === "\u0019") ||
              (key === "tui.select.cancel" && data === "\u0018") ||
              (key === "tui.select.down" && data === "\u000e"),
            getKeys: (key) =>
              key === "tui.select.confirm" ? ["ctrl+y"] : key === "tui.select.cancel" ? ["ctrl+x"] : [],
          });
          frames.push(harness.render(48));
          if (choice === "dispose") harness.dispose();
          else {
            if (choice === "discard") harness.handleInput("\u000e");
            harness.handleInput(choice === "hard-cancel" ? "\u0003" : "\u0019");
            await harness.waitForPending();
            harness.dispose();
          }
          return harness.result;
        },
      });
      (ctx as ExtensionCommandContext).ui.input = async (_title, _placeholder, options) => {
        inputSignal = Boolean(options?.signal);
        return '["skills/private", "**/*.log"]';
      };
      const controller = new AbortController();
      await showExcludedPaths(ctx, "home", controller.signal);
      assert.equal(inputSignal, true);
      assert.match(frames.flat().join("\n"), /version 6|snapshot version 4/);
      if (choice === "save") {
        const saved = await readLocalConfigObject();
        assert.equal(saved?.version, 6);
        assert.deepEqual(saved?.future, { retained: true });
        assert.deepEqual((await loadConfig()).exclude, ["**/*.log", "skills/private"]);
        if (process.platform !== "win32") assert.equal((await fs.stat(localConfigPath())).mode & 0o777, 0o600);
      } else assert.equal(await fs.readFile(localConfigPath(), "utf8"), before);
    }));

test("continue editing retains a pasted JSON draft and invalid input never writes", async () =>
  withTempHome(async (root) => {
    await fs.mkdir(root, { recursive: true });
    const before = JSON.stringify(v3S3Settings({ include: ["skills"] }));
    await fs.writeFile(localConfigPath(), before);
    const draft = '[\n  "skills/private",\n  "**/*.log"\n]';
    const placeholders: string[] = [];
    let edits = 0;
    let reviews = 0;
    const { ctx } = createMockContext({
      hasUI: true,
      mode: "tui",
      custom: async (factory: unknown) => {
        const harness = createCustomSelectorHarness(factory);
        if (reviews++ === 0) {
          harness.handleInput("tui.select.down");
          harness.handleInput("tui.select.down");
        }
        harness.handleInput("tui.select.confirm");
        await harness.waitForPending();
        harness.dispose();
        return harness.result;
      },
    });
    (ctx as ExtensionCommandContext).ui.input = async (_title, placeholder) => {
      placeholders.push(placeholder ?? "");
      return ["invalid-json", draft, ""][edits++];
    };
    await showExcludedPaths(ctx, "home");
    assert.equal(placeholders[2], draft);
    assert.deepEqual((await loadConfig()).exclude, ["**/*.log", "skills/private"]);
  }));

for (const invalidFile of [false, true])
  test(`concurrent settings change is preserved, malformed=${invalidFile}`, async () =>
    withTempHome(async (root) => {
      await fs.mkdir(root, { recursive: true });
      await fs.writeFile(localConfigPath(), JSON.stringify(v3S3Settings({ include: ["skills"] })));
      const { ctx, notifications } = createMockContext({
        hasUI: true,
        mode: "tui",
        custom: async (factory: unknown) => {
          if (invalidFile) await fs.writeFile(localConfigPath(), "{invalid");
          else
            await updateLocalConfig((current) => {
              const setup = current.syncSetups.home;
              assert.ok(setup);
              setup.sync.include = ["skills", "prompts"];
              return current;
            });
          const harness = createCustomSelectorHarness(factory);
          harness.handleInput("tui.select.confirm");
          await harness.waitForPending();
          harness.dispose();
          return harness.result;
        },
      });
      (ctx as ExtensionCommandContext).ui.input = async () => '["skills/private"]';
      await showExcludedPaths(ctx, "home");
      assert.match(notifications.at(-1)?.message ?? "", /not saved/);
      if (invalidFile) assert.equal(await fs.readFile(localConfigPath(), "utf8"), "{invalid");
      else {
        assert.equal((await loadConfig()).exclude, undefined);
        assert.deepEqual((await loadConfig()).include, ["skills", "prompts"]);
      }
    }));

for (const label of ["Machine-local", "Content merge"])
  test(`editing ${label} never downgrades version-6 settings`, async () =>
    withTempHome(async (root) => {
      await fs.mkdir(root, { recursive: true });
      const initial = settings(6, ["future"]);
      initial.syncSetups.home.sync.include = ["settings.json"];
      await fs.writeFile(localConfigPath(), JSON.stringify(initial));
      let opened = false;
      const { ctx } = createMockContext({
        hasUI: true,
        mode: "tui",
        confirm: async () => true,
        custom: async (factory: unknown) => {
          const harness = createCustomSelectorHarness(factory);
          if (!opened) {
            opened = true;
            harness.handleInput(label);
            harness.handleInput("tui.select.confirm");
            await harness.waitForPending();
          }
          harness.handleInput("tui.select.cancel");
          await harness.waitForPending();
          harness.dispose();
          return harness.result;
        },
      });
      (ctx as ExtensionCommandContext).ui.input = async () => "[]";
      await showSyncSettings(ctx, async () => undefined);
      assert.equal((await readLocalConfigObject())?.version, 6);
      assert.deepEqual((await loadConfig()).exclude, ["future"]);
    }));

test("owned cancellation aborts native input and RPC remains read-only", async () =>
  withTempHome(async (root) => {
    await fs.mkdir(root, { recursive: true });
    const before = JSON.stringify(v3S3Settings({ include: ["skills"] }));
    await fs.writeFile(localConfigPath(), before);
    const controller = new AbortController();
    let cancelled = false;
    const { ctx } = createMockContext({ hasUI: true, mode: "tui" });
    (ctx as ExtensionCommandContext).ui.input = async (_title, _placeholder, options) =>
      new Promise((resolve) => {
        options?.signal?.addEventListener(
          "abort",
          () => {
            cancelled = true;
            resolve(undefined);
          },
          { once: true },
        );
        controller.abort();
      });
    await showExcludedPaths(ctx, "home", controller.signal);
    assert.equal(cancelled, true);
    const rpc = createMockContext({
      hasUI: true,
      mode: "rpc",
      custom: async () => {
        throw new Error("No custom RPC UI");
      },
    });
    await showExcludedPaths(rpc.ctx, "home");
    assert.match(rpc.notifications[0]?.message ?? "", /sync.exclude|version 6/);
    assert.equal(await fs.readFile(localConfigPath(), "utf8"), before);
  }));
