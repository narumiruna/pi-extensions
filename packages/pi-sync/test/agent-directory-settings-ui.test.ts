import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { stripVTControlCharacters } from "node:util";
import { matchesKey, visibleWidth } from "@earendil-works/pi-tui";
import { test, vi } from "vitest";
import { createCustomSelectorHarness, createMockContext } from "../../../test/support.js";
import {
  configFromSettings,
  loadConfig,
  syncCheckConfigFingerprint,
  syncConfigReviewIdentity,
} from "../src/settings/config.js";
import { localConfigPath } from "../src/settings/config-file.js";
import { addSyncSetup, updateSyncSetup } from "../src/settings/settings-management.js";
import { readLocalConfigObject } from "../src/settings/settings-store.js";
import { validateSettingsDocument } from "../src/settings/settings-validation.js";
import { configuredSnapshotPathMatcher, syncSessionsSelected } from "../src/sync/sync-policy.js";
import { showFileSelection } from "../src/ui/file-selection.js";
import { type SyncSettingsRoute, showSyncSettings } from "../src/ui/settings-ui.js";
import { showSetupWizard } from "../src/ui/setup/setup-wizard.js";
import { v3S3Settings, withTempHome } from "./helpers.js";
import { createMockContext as setupContext } from "./setup-test-context.js";

const { reviewRemote } = vi.hoisted(() => ({ reviewRemote: vi.fn() }));
vi.mock("../src/ui/remote-selection-ui.js", () => ({ showRemoteSelectionReview: reviewRemote }));

function directorySettings(sync: Record<string, unknown> = {}) {
  const base = v3S3Settings();
  return {
    ...base,
    version: 7,
    future: { keep: true },
    syncSetups: {
      home: {
        ...base.syncSetups.home,
        sync: { scope: "agent-directory", automatic: false, ...sync },
      },
    },
  };
}

const starters = ["sessions", "bin", "npm"];

for (const [policy, error] of [
  [{ include: [] }, /cannot use sync.include/u],
  [{ scope: "home" }, /unsupported sync.scope/u],
  [{ sessions: "yes" }, /sync.sessions must be boolean/u],
  [{ exclude: null }, /array/u],
  [{ reinclude: "notes" }, /array/u],
  [{ reinclude: ["../notes"] }, /safe relative path/u],
] as const) {
  test(`settings reject ambiguous or unsafe directory policy ${JSON.stringify(policy)}`, () => {
    assert.throws(() => validateSettingsDocument(directorySettings(policy)), error);
  });
}

test("settings project only explicit sessions and bind normalized directory rules to reviewed identities", () => {
  assert.throws(() => validateSettingsDocument({ ...directorySettings(), version: 6 }), /version 7/u);
  assert.deepEqual(
    configFromSettings(validateSettingsDocument(directorySettings({ localFields: ["shellPath"] }))).localFields,
    ["shellPath"],
  );
  const legacy = validateSettingsDocument({ ...v3S3Settings({ include: ["skills", "settings.json"] }), version: 7 });
  assert.deepEqual(configFromSettings(legacy).include, ["skills", "settings.json"]);
  Object.assign(legacy.syncSetups.home.sync, { sessions: false });
  assert.throws(() => validateSettingsDocument(legacy), /require agent-directory scope/u);

  const config = (rules?: Record<string, unknown>) =>
    configFromSettings(validateSettingsDocument(directorySettings(rules)));
  assert.deepEqual(config().include, []);
  assert.notEqual(syncConfigReviewIdentity(config()), syncConfigReviewIdentity({ ...config(), scope: undefined }));
  const off = config({ exclude: ["work/", "session-cache"], reinclude: ["WORK/keep", "sessions/**"] });
  assert.deepEqual(off.exclude, ["session-cache", "work"]);
  assert.deepEqual(off.include, []);
  assert.equal(syncSessionsSelected(off), false);
  assert.equal(
    syncConfigReviewIdentity(off),
    syncConfigReviewIdentity(config({ exclude: ["session-cache", "WORK"], reinclude: ["sessions/**", "work/keep/"] })),
  );
  assert.notEqual(syncCheckConfigFingerprint(off), syncCheckConfigFingerprint(config({ exclude: ["work/"] })));
  assert.notEqual(syncConfigReviewIdentity(off), syncConfigReviewIdentity({ ...off, reinclude: [] }));
  const on = config({ sessions: true });
  assert.deepEqual(on.include, ["sessions"]);
  assert.equal(syncSessionsSelected(on), true);
  assert.notEqual(syncConfigReviewIdentity(config()), syncConfigReviewIdentity(on));
});

for (const mode of [
  "default",
  "default sessions",
  "custom",
  "decline sessions",
  "discard",
  "join directory",
  "join legacy",
] as const) {
  test(`first Git setup: ${mode}`, async () =>
    withTempHome(async () => {
      reviewRemote.mockReset();
      const seen: string[] = [];
      const joining = mode.startsWith("join");
      const custom = mode === "custom";
      const inputs = ["home", "git@github.com:owner/private-pi-sync.git", "", ""];
      if (custom) inputs.push('[\n"sessions/", "private/", "bin"\n]', '["private/share", "sessions/work.jsonl"]');
      const optIn = custom || mode === "default sessions" || mode === "decline sessions";
      const selections = [
        "Git",
        joining
          ? "Join an existing remote"
          : custom
            ? "Agent directory · edit starter rules"
            : "Agent directory (recommended)",
        ...(joining
          ? [mode === "join legacy" ? "Selected paths (legacy)" : "Pi agent directory"]
          : ["Keep automatic sync off", optIn ? "Include session conversations" : "Keep sessions off (recommended)"]),
        mode === "discard" ? "Cancel" : "Save setup",
      ];
      let firstOption: string | undefined;
      let acknowledgements = 0;
      let joinedVersion: number | undefined;
      reviewRemote.mockImplementation(async () => {
        joinedVersion = (await readLocalConfigObject())?.version;
        return { kind: "back" };
      });
      const { ctx } = setupContext({
        mode: "tui",
        input: async () => inputs.shift(),
        confirm: async () => {
          acknowledgements++;
          return mode !== "decline sessions";
        },
        select: async (title: string, options: string[]) => {
          seen.push(title);
          if (title.startsWith("Choose synced content")) firstOption = options[0];
          return selections.shift();
        },
      });
      const saved = mode !== "discard" && mode !== "decline sessions";
      assert.equal(await showSetupWizard(ctx), saved);
      assert.equal(firstOption, "Agent directory (recommended)");
      assert.equal(acknowledgements, optIn ? 1 : 0);
      assert.equal(reviewRemote.mock.calls.length, joining ? 1 : 0);
      if (!saved) {
        await assert.rejects(fs.stat(localConfigPath()), { code: "ENOENT" });
        return;
      }
      const document = await readLocalConfigObject();
      const policy = document?.syncSetups.home.sync;
      if (joining) {
        assert.equal(joinedVersion, document?.version);
        const call = reviewRemote.mock.calls[0];
        assert.equal(call[1], "home");
        assert.deepEqual(call[4], { origin: "settings" });
        assert.equal(policy?.automatic, false);
        assert.match(seen.join("\n"), /No policy is adopted without your review/u);
      }
      if (mode === "join legacy") {
        assert.equal(document?.version, 3);
        assert.equal(policy?.scope, undefined);
        assert.equal(policy?.include?.includes("sessions"), false);
        return;
      }
      assert.equal(document?.version, 7);
      assert.equal(policy?.scope, "agent-directory");
      assert.equal(Object.hasOwn(policy ?? {}, "include"), false);
      assert.deepEqual(policy?.exclude, custom ? ["bin", "private", "sessions"] : optIn ? ["bin", "npm"] : starters);
      assert.equal(policy?.sessions, optIn);
      assert.deepEqual(policy?.reinclude, custom ? ["private/share", "sessions/work.jsonl"] : undefined);
      const selects = configuredSnapshotPathMatcher(await loadConfig());
      assert.equal(selects("sessions/work.jsonl"), optIn);
      assert.equal(selects("sessions/other.jsonl"), optIn && !custom);
      const rendered = seen.join("\n");
      assert.match(rendered, /Always local: Pi credentials \(auth.json\), project trust \(trust.json\)/u);
      assert.match(rendered, /secret scanner cannot identify/u);
    }));
}

const keys = {
  getKeys(binding: string) {
    if (binding === "tui.select.confirm") return ["ctrl+y" as const];
    if (binding === "tui.select.cancel") return ["ctrl+x" as const];
    if (binding === "tui.select.down") return ["ctrl+n" as const];
    return [];
  },
  matches(data: string, binding: string) {
    return this.getKeys(binding).some((key) => matchesKey(data, key));
  },
};

for (const mode of ["save", "cancel", "hard-cancel", "stale", "opt in only", "opt out only"] as const) {
  test(`agent directory review ${mode} binds rules and session consent atomically`, async () =>
    withTempHome(async (root) => {
      await fs.mkdir(root, { recursive: true });
      const toggleOnly = mode === "opt in only" || mode === "opt out only";
      const original = JSON.stringify(
        directorySettings({
          exclude: starters,
          ...(toggleOnly ? { reinclude: ["sessions/work.jsonl"], sessions: mode === "opt out only" } : {}),
          ownedByFutureVersion: true,
        }),
      );
      await fs.writeFile(localConfigPath(), original, { mode: 0o600 });
      const choices = [
        ...(toggleOnly ? [] : ["Edit excluded paths", "Edit re-included paths"]),
        "Session opt-in",
        "Review changes",
      ];
      const frames: string[] = [];
      const placeholders: string[] = [];
      let privacyWarnings = 0;
      let bounded = true;
      const { ctx, notifications } = createMockContext({
        mode: "tui",
        input: async (title: string, placeholder?: string) => {
          placeholders.push(placeholder ?? "");
          if (title.startsWith("Excluded paths")) return '[\n"sessions/", "private/", "bin"\n]';
          return '["private/share", "sessions/work.jsonl"]';
        },
        confirm: async () => {
          privacyWarnings++;
          return true;
        },
        custom: async (factory: unknown) => {
          const harness = createCustomSelectorHarness(factory, 100, keys, 48);
          try {
            const frame = stripVTControlCharacters(harness.render().join("\n"));
            frames.push(frame);
            bounded &&= harness.render(15).every((line) => visibleWidth(line) <= 15);
            if (frame.includes("Review agent directory scope")) {
              if (mode === "stale") {
                await updateSyncSetup("home", (setup) => {
                  if (setup.sync.scope !== "agent-directory") throw new Error("Unexpected scope");
                  return { ...setup, sync: { ...setup.sync, reinclude: ["from-another-write"] } };
                });
              }
              harness.handleInput(mode === "cancel" ? "\u0018" : mode === "hard-cancel" ? "\u0003" : "\u0019");
            } else {
              const desired = choices.shift();
              for (let index = 0; desired && index < 4; index++) {
                const focused = harness.render().find((line) => /^\s*→/u.test(line));
                if (focused?.includes(desired)) break;
                harness.handleInput("\u000e");
              }
              harness.handleInput(desired ? "\u0019" : "\u0018");
            }
            await harness.waitForPending();
            return harness.result;
          } finally {
            harness.dispose();
          }
        },
      });
      await showFileSelection(ctx, "home");
      assert.deepEqual(choices, []);
      assert.equal(privacyWarnings, mode === "opt out only" ? 0 : 1);
      assert.deepEqual(
        placeholders.map((value) => JSON.parse(value)),
        toggleOnly ? [] : [["bin", "npm", "sessions"], []],
      );
      assert.equal(bounded, true);
      const review = frames.find((frame) => frame.includes("Review agent directory scope")) ?? "";
      assert.match(review, /sessions\/work\.jsonl/u);
      assert.match(review, mode === "opt out only" ? /Sessions: Off/u : /Sessions: On — explicit opt-in/u);
      assert.match(review, /ctrl\+y/u);
      if (mode === "cancel" || mode === "hard-cancel") {
        assert.equal(await fs.readFile(localConfigPath(), "utf8"), original);
        return;
      }
      const saved = await readLocalConfigObject();
      const policy = saved?.syncSetups.home.sync;
      assert.equal(saved?.version, 7);
      assert.deepEqual(saved?.future, { keep: true });
      assert.equal(policy?.ownedByFutureVersion, true);
      if (mode === "stale") {
        assert.deepEqual(policy?.exclude, starters);
        assert.deepEqual(policy?.reinclude, ["from-another-write"]);
        assert.equal(policy?.sessions, undefined);
        assert.match(notifications.at(-1)?.message ?? "", /not saved.*changed while it was open/u);
      } else {
        assert.deepEqual(policy?.exclude, toggleOnly ? starters : ["bin", "private", "sessions"]);
        assert.deepEqual(
          policy?.reinclude,
          toggleOnly ? ["sessions/work.jsonl"] : ["private/share", "sessions/work.jsonl"],
        );
        assert.equal(policy?.sessions, mode !== "opt out only");
        const selects = configuredSnapshotPathMatcher(await loadConfig());
        assert.equal(selects("sessions/work.jsonl"), mode !== "opt out only");
        assert.equal(selects("sessions/other.jsonl"), false);
        assert.match(notifications.at(-1)?.message ?? "", /no transfer started/u);
      }
    }));
}

test("Settings opens the Files route for the reviewed directory-scope setup", async () =>
  withTempHome(async (root) => {
    await fs.mkdir(root, { recursive: true });
    await fs.writeFile(localConfigPath(), JSON.stringify(directorySettings({ exclude: starters })), { mode: 0o600 });
    const route = vi.fn<SyncSettingsRoute>(async () => undefined);
    let frame = "";
    let opened = false;
    const { ctx } = createMockContext({
      mode: "tui",
      custom: async (factory: unknown) => {
        const harness = createCustomSelectorHarness(factory, 110);
        try {
          if (!opened) {
            opened = true;
            frame = stripVTControlCharacters(harness.render().join("\n"));
            harness.handleInput("tui.select.confirm");
            await harness.waitForPending();
          }
          harness.handleInput("tui.select.cancel");
          await harness.waitForPending();
          return harness.result;
        } finally {
          harness.dispose();
        }
      },
    });
    await showSyncSettings(ctx, route);
    assert.match(frame, /Agent directory scope/u);
    assert.match(frame, /Compare sync policies/u);
    assert.doesNotMatch(frame, /Included paths/u);
    assert.deepEqual(
      route.mock.calls.map(([name, _signal, _argument, setup]) => [name, setup]),
      [["files", "home"]],
    );
  }));

test("RPC Settings and Files expose directory scope without TUI or a write", async () =>
  withTempHome(async (root) => {
    await fs.mkdir(root, { recursive: true });
    const original = JSON.stringify(directorySettings({ exclude: starters, reinclude: ["work/notes"] }));
    await fs.writeFile(localConfigPath(), original, { mode: 0o600 });
    const custom = vi.fn();
    const route = vi.fn();
    const { ctx, notifications } = createMockContext({ mode: "rpc", custom });
    await showSyncSettings(ctx, route);
    await showFileSelection(ctx);
    assert.equal(custom.mock.calls.length, 0);
    assert.equal(route.mock.calls.length, 0);
    assert.equal(notifications.length, 2);
    for (const item of notifications) {
      assert.match(item.message, /Scope: Pi agent directory/u);
      assert.match(item.message, /Excluded paths: 3 · bin, npm, sessions/u);
      assert.match(item.message, /Re-included paths: 1 · work\/notes/u);
      assert.match(item.message, /Session opt-in: Off/u);
    }
    assert.equal(await fs.readFile(localConfigPath(), "utf8"), original);
  }));

test("adding directory scope promotes a legacy document without changing its active setup or downgrading later", async () =>
  withTempHome(async (root) => {
    await fs.mkdir(root, { recursive: true });
    const document = v3S3Settings();
    await fs.writeFile(localConfigPath(), JSON.stringify(document), { mode: 0o600 });
    const added = {
      storage: { connection: "r2", bucket: "pi-sync-test", path: "directory" },
      sync: { scope: "agent-directory" as const, exclude: starters, automatic: false },
    };
    await addSyncSetup("directory", added);
    const withDirectory = await readLocalConfigObject();
    assert.equal(withDirectory?.version, 7);
    assert.equal(withDirectory?.activeSyncSetup, "home");
    assert.deepEqual(withDirectory?.syncSetups.home, document.syncSetups.home);
    await updateSyncSetup("home", (setup) => ({ ...setup, sync: { ...setup.sync, exclude: ["private"] } }), {
      upgradeExclude: true,
    });
    const result = await readLocalConfigObject();
    assert.equal(result?.version, 7);
    assert.deepEqual(result?.syncSetups.directory, added);
    assert.deepEqual((await loadConfig()).exclude, ["private"]);
  }));
