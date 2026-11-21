import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test, vi } from "vitest";
import { documentFingerprint } from "../src/document.js";
import { configureEngineHost, engineHost } from "../src/engine/host.js";
import { DEFAULT_IGNORE_CREATION_RECORD, DEFAULT_IGNORE_RULES } from "../src/engine/ignore/ignore-source.js";
import {
  configFromSettings,
  loadConfig,
  loadConfigForCheck,
  loadPartialConfig,
  loadSettingsConfig,
  resolveIgnoreConfig,
  syncCheckConfigFingerprint,
  syncConfigReviewFingerprint,
} from "../src/engine/settings/config.js";
import {
  type LocalConfigDocument,
  peekLocalConfigDocument,
  updateLocalConfigDocument,
  withConfigPublicationReadyHookForTest,
} from "../src/engine/settings/config-file.js";
import { addSyncSetup, saveNewV3Settings, updateSyncSetup } from "../src/engine/settings/settings-management.js";
import { updateLocalConfig } from "../src/engine/settings/settings-store.js";
import type { PiSyncSettingsV3, SyncPolicySettings, SyncSetupSettings } from "../src/engine/settings/settings-types.js";
import { validateSettingsDocument } from "../src/engine/settings/settings-validation.js";

const ignoreSync = { scope: "agent-directory", pathPolicy: "ignore-file", automatic: false } as const;
const legacySync = {
  scope: "agent-directory",
  automatic: false,
  exclude: ["drafts"],
  reinclude: ["docs"],
} satisfies SyncPolicySettings;

function setup(location: string, sync: SyncPolicySettings): SyncSetupSettings {
  return { storage: { connection: "origin", branch: "sync", path: location }, sync };
}

function settings(sync: SyncPolicySettings = ignoreSync): PiSyncSettingsV3 {
  return {
    version: 8,
    onSwitch: "switch-only",
    activeSyncSetup: "home",
    storageConnections: { origin: { type: "git", remote: "git@example.invalid:owner/sync.git" } },
    syncSetups: { home: setup("home", sync) },
  };
}

async function fixture(run: (root: string, save: (document: PiSyncSettingsV3) => Promise<void>) => Promise<void>) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "pi-sync-ignore-settings-")));
  configureEngineHost({ root: () => root, mutate: async (_file, action) => action(), review: async () => false });
  try {
    await run(root, (document) =>
      fs.writeFile(path.join(root, "pi-sync.json"), JSON.stringify(document), { mode: 0o600 }),
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

test("version 8 validates and preserves mixed setup policies, including unknown fields", () => {
  const document = settings({ ...ignoreSync, ignoreFile: "Current.rules", sessions: true, future: { n: 1 } });
  document.syncSetups.selected = setup("selected", {
    include: ["notes"],
    exclude: ["notes/private"],
    automatic: false,
  });
  document.syncSetups.directory = setup("directory", legacySync);
  assert.equal(validateSettingsDocument(document), document);
  const current = configFromSettings(document);
  assert.equal(current.pathPolicy, "ignore-file");
  assert.equal(current.ignoreFile, "Current.rules");
  assert.deepEqual(current.include, ["sessions"]);
  assert.deepEqual(current.reservedIgnoreNames, [".syncignore", "current.rules"]);
  assert.equal(current.ignorePolicy, undefined);
  assert.equal(current.validateIgnorePolicy, undefined);
  const selected = configFromSettings(document, "selected");
  assert.deepEqual(selected.include, ["notes"]);
  assert.deepEqual(selected.exclude, ["notes/private"]);
  const directory = configFromSettings(document, "directory");
  assert.equal(directory.scope, "agent-directory");
  assert.deepEqual(directory.reinclude, ["docs"]);
});

test("invalid versions, ambiguous policies and unsafe filenames are rejected", () => {
  type InvalidPolicy = [Record<string, unknown>, unknown, RegExp];
  const cases: InvalidPolicy[] = [
    [ignoreSync, 7, /requires explicit settings version 8/u],
    [ignoreSync, 9, /Unsupported pi-sync settings/u],
    [ignoreSync, "8", /Unsupported pi-sync settings/u],
    [{ ...ignoreSync, scope: undefined }, 8, /requires agent-directory scope/u],
    [{ ...ignoreSync, scope: "selected-paths" }, 8, /requires agent-directory scope/u],
    [{ ...ignoreSync, pathPolicy: "other" }, 8, /unsupported sync.pathPolicy/u],
    [{ ...ignoreSync, include: [] }, 8, /cannot use sync.include/u],
    [{ ...ignoreSync, exclude: [] }, 8, /cannot use sync.exclude/u],
    [{ ...ignoreSync, reinclude: [] }, 8, /cannot use sync.reinclude/u],
    [{ ...ignoreSync, sessions: "true" }, 8, /sync.sessions must be boolean/u],
    [{ ...legacySync, ignoreFile: "rules" }, 8, /sync.ignoreFile requires ignore-file pathPolicy/u],
    [
      { include: ["notes"], ignoreFile: "rules", automatic: false },
      8,
      /sync.ignoreFile requires ignore-file pathPolicy/u,
    ],
    ...[
      null,
      "",
      "../rules",
      "root/rules",
      "root\\rules",
      "C:rules",
      "trust.json",
      "AUTH.JSON",
      "pi-sync.json",
      ".SYNCIGNORE",
      "AUX",
    ].map((ignoreFile): InvalidPolicy => [{ ...ignoreSync, ignoreFile }, 8, /Invalid sync.ignoreFile/u]),
  ];
  for (const [sync, version, message] of cases) {
    const document = settings();
    const input = { ...document, version, syncSetups: { home: { ...document.syncSetups.home, sync } } };
    assert.throws(() => validateSettingsDocument(input), message, JSON.stringify(input));
  }
});

test("configuration reads do not create rules, and legacy operation loaders refuse unfenced ignore setups", () =>
  fixture(async (root, save) => {
    const document = settings();
    document.syncSetups.legacy = setup("legacy", { automatic: false, include: ["Current.rules"] });
    document.syncSetups.peer = setup("peer", { ...ignoreSync, ignoreFile: "Current.rules" });
    await save(document);
    assert.deepEqual(configFromSettings(document, "legacy").reservedIgnoreNames, [".syncignore", "current.rules"]);
    await assert.rejects(loadConfig(), /does not yet support/u);
    await assert.rejects(loadConfigForCheck(), /does not yet support/u);
    await assert.rejects(loadConfig("legacy"), /does not yet support/u);
    await assert.rejects(resolveIgnoreConfig(document, "legacy"), /does not yet support/u);
    await assert.rejects(resolveIgnoreConfig(document, "peer"), /Current.rules.*does not exist/u);
    assert.equal((await loadPartialConfig()).ignoreFile, ".syncignore");
    const absent = await resolveIgnoreConfig(document);
    assert.ok(absent.ignorePolicy);
    assert.ok(absent.ignorePolicy.matches("npm/installed.js"));
    assert.deepEqual(absent.ignorePolicy.reservedNames, [".syncignore", "current.rules"]);
    assert.ok(absent.validateIgnorePolicy);
    await assert.rejects(absent.validateIgnorePolicy(), /starter rules can only be used for a preview/u);
    assert.deepEqual(await fs.readdir(root), ["pi-sync.json"]);
    await fs.writeFile(path.join(root, DEFAULT_IGNORE_CREATION_RECORD), "interrupted");
    await assert.rejects(resolveIgnoreConfig(document), /unfinished creation record/u);
    await assert.rejects(absent.validateIgnorePolicy(), /unfinished creation record/u);
    await fs.rm(path.join(root, DEFAULT_IGNORE_CREATION_RECORD));
    await fs.writeFile(path.join(root, ".syncignore"), DEFAULT_IGNORE_RULES);
    const initialized = await resolveIgnoreConfig(document);
    assert.equal(initialized.ignorePolicy?.fingerprint, absent.ignorePolicy.fingerprint);
    assert.notEqual(syncCheckConfigFingerprint(initialized), syncCheckConfigFingerprint(absent));
    assert.notEqual(syncConfigReviewFingerprint(initialized), syncConfigReviewFingerprint(absent));
    await assert.rejects(absent.validateIgnorePolicy(), /reopen the review/u);
    assert.ok(initialized.validateIgnorePolicy);
    await initialized.validateIgnorePolicy();
    await fs.rm(path.join(root, ".syncignore"));
    await assert.rejects(initialized.validateIgnorePolicy(), /reopen the review/u);
  }));

test("settings display does not migrate the document or open the configured rule file", () =>
  fixture(async (root, save) => {
    await assert.rejects(loadSettingsConfig(), /Missing pi-sync settings/u);
    assert.deepEqual(await fs.readdir(root), []);
    const document = settings({ ...ignoreSync, ignoreFile: "Current.rules" });
    await save(document);
    const legacy = path.join(root, "pi-sync.local.json");
    await fs.rename(path.join(root, "pi-sync.json"), legacy);
    const before = await fs.readFile(legacy, "utf8");
    const config = await loadSettingsConfig();
    assert.equal(config.ignoreFile, "Current.rules");
    assert.equal(config.ignorePolicy, undefined);
    assert.equal(config.validateIgnorePolicy, undefined);
    assert.equal(await fs.readFile(legacy, "utf8"), before);
    assert.deepEqual(await fs.readdir(root), ["pi-sync.local.json"]);
  }));

test("source and settings changes invalidate operation fingerprints without serializing rule bytes", () =>
  fixture(async (root, save) => {
    const document = settings({ ...ignoreSync, sessions: true, ignoreFile: "Current.rules" });
    document.syncSetups.peer = setup("peer", { ...ignoreSync, ignoreFile: "peer.rules" });
    const rules = "# PRIVATE-RULE-TEXT\n/sessions/\n";
    await fs.writeFile(path.join(root, "Current.rules"), rules);
    await fs.writeFile(path.join(root, "next.rules"), rules);
    await save(document);
    const resolved = await resolveIgnoreConfig(document);
    assert.ok(resolved.validateIgnorePolicy);
    assert.ok(resolved.ignorePolicy);
    assert.ok(resolved.ignorePolicy.matches("sessions/log.jsonl"));
    assert.equal(resolved.ignorePolicy.sessions, true);
    assert.ok(!JSON.stringify(resolved).includes("PRIVATE-RULE-TEXT"));
    assert.ok(!JSON.stringify(resolved).includes("/sessions/"));
    await resolved.validateIgnorePolicy();
    await fs.appendFile(path.join(root, "Current.rules"), "# edited\n");
    const edited = await resolveIgnoreConfig(document);
    assert.notEqual(syncCheckConfigFingerprint(edited), syncCheckConfigFingerprint(resolved));
    assert.notEqual(syncConfigReviewFingerprint(edited), syncConfigReviewFingerprint(resolved));
    await assert.rejects(resolved.validateIgnorePolicy(), /ignore policy changed/u);
    await fs.writeFile(path.join(root, "Current.rules"), rules);
    for (const next of [
      { ...document, activeSyncSetup: "peer" },
      {
        ...document,
        syncSetups: {
          ...document.syncSetups,
          home: setup("home", { ...ignoreSync, ignoreFile: "next.rules", sessions: true }),
        },
      },
      {
        ...document,
        syncSetups: {
          ...document.syncSetups,
          home: setup("home", { ...ignoreSync, ignoreFile: "Current.rules", sessions: false }),
        },
      },
      {
        ...document,
        syncSetups: { ...document.syncSetups, peer: setup("peer", { ...ignoreSync, ignoreFile: "new-peer.rules" }) },
      },
    ]) {
      await save(next);
      await assert.rejects(resolved.validateIgnorePolicy(), /settings changed/u);
    }
    await save({ ...document, activeSyncSetup: "peer" });
    const pinned = await resolveIgnoreConfig(document, "home");
    assert.ok(pinned.validateIgnorePolicy);
    await pinned.validateIgnorePolicy();
    const controller = new AbortController();
    const cancellable = await resolveIgnoreConfig(document, "home", controller.signal);
    controller.abort(new Error("review cancelled"));
    assert.ok(cancellable.validateIgnorePolicy);
    await assert.rejects(cancellable.validateIgnorePolicy(), /review cancelled/u);
    await assert.rejects(resolveIgnoreConfig(document, "home", controller.signal), /review cancelled/u);
  }));

test.each([false, true])("a sessions change from %s during the ignore source read invalidates review", (sessions) =>
  fixture(async (root, save) => {
    const filename = "Current.rules";
    const document = settings({ ...ignoreSync, ignoreFile: filename, sessions });
    const sourcePath = path.join(root, filename);
    const rules = "# unchanged rules\n";
    await fs.writeFile(sourcePath, rules);
    await save(document);
    const resolved = await resolveIgnoreConfig(document);
    assert.ok(resolved.validateIgnorePolicy);
    await withPausedOpen(sourcePath, resolved.validateIgnorePolicy, async () => {
      await save(settings({ ...ignoreSync, ignoreFile: filename, sessions: !sessions }));
      return /settings changed/u;
    });
    assert.equal(await fs.readFile(sourcePath, "utf8"), rules);
  }),
);

test.each(["abort", "root", "rules"] as const)(
  "a change in %s during the final settings read invalidates review",
  (change) =>
    fixture(async (root, save) => {
      const document = settings();
      const rules = path.join(root, ".syncignore");
      await save(document);
      await fs.writeFile(rules, DEFAULT_IGNORE_RULES);
      const controller = new AbortController();
      const resolved = await resolveIgnoreConfig(document, undefined, controller.signal);
      assert.ok(resolved.validateIgnorePolicy);
      const host = engineHost();
      try {
        await withPausedOpen(path.join(root, "pi-sync.json"), resolved.validateIgnorePolicy, async () => {
          if (change === "abort") {
            controller.abort(new Error("review cancelled"));
            return /review cancelled/u;
          }
          if (change === "rules") {
            await fs.writeFile(rules, "/other/\n");
            return /ignore policy changed/u;
          }
          configureEngineHost({ ...host, root: () => path.join(root, "replacement") });
          return /agent directory changed/u;
        });
      } finally {
        configureEngineHost(host);
      }
    }),
);

test.each(["pi-sync.json", "pi-sync.local.json"])(
  "the daemon holds its settings lock from the only async %s read through the rule check",
  (filename) =>
    fixture(async (root) => {
      const document = settings();
      const settingsPath = path.join(root, filename);
      const rulesPath = path.join(root, ".syncignore");
      const lock = path.join(root, "pi-sync.json.mutation-lock");
      await fs.writeFile(settingsPath, JSON.stringify(document), { mode: 0o600 });
      await fs.writeFile(rulesPath, DEFAULT_IGNORE_RULES);
      const resolved = await resolveIgnoreConfig(document);
      assert.ok(resolved.validateIgnorePolicy);
      const reads: { file: string; locked: boolean }[] = [];
      const open = fs.open;
      const spy = vi.spyOn(fs, "open").mockImplementation(async (...args) => {
        if (args[0] === settingsPath || args[0] === rulesPath) {
          const stat = await fs.lstat(lock).catch(() => undefined);
          reads.push({ file: args[0], locked: stat?.isDirectory() ?? false });
        }
        return open(...args);
      });
      try {
        await resolved.validateIgnorePolicy();
      } finally {
        spy.mockRestore();
      }
      assert.deepEqual(reads, [
        { file: settingsPath, locked: true },
        { file: rulesPath, locked: true },
      ]);
      assert.deepEqual((await fs.readdir(root)).sort(), [".syncignore", filename]);
    }),
);

async function withPausedOpen(file: string, validate: () => Promise<void>, change: () => Promise<RegExp>) {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const open = fs.open;
  const spy = vi.spyOn(fs, "open").mockImplementation(async (...args) => {
    if (args[0] === file) {
      entered.resolve();
      await release.promise;
    }
    return open(...args);
  });
  const validation = validate();
  try {
    await Promise.race([
      entered.promise,
      validation.then(() => assert.fail("Review finished before reaching the paused read")),
    ]);
    const rejected = assert.rejects(validation, await change());
    release.resolve();
    await rejected;
  } finally {
    release.resolve();
    await validation.catch(() => undefined);
    spy.mockRestore();
  }
}

test("legacy-only configurations keep their previous fingerprint when the document version is 8", () => {
  const cases: [SyncPolicySettings, string, string][] = [
    [
      legacySync,
      "551c1945cfb54e913b4b5c0ed7cef9c749af2267eab0626909cb2e00ea8dcb86",
      "29c25004832ba67e9101b85ba6c073ee402ee0577db2adc3e3d204a34c84037f",
    ],
    [
      { include: ["notes"], automatic: true, exclude: ["docs"] },
      "b4f0ec8274802949fca1327b6a711aa02270d71faa713a890c79b86ec756d57e",
      "4d34cc86317522b5431afa69c382ce57964317dfe24c6ca3c6b7e6be269e87fe",
    ],
  ];
  for (const [sync, review, check] of cases) {
    for (const version of [7, 8] as const) {
      const config = configFromSettings(validateSettingsDocument({ ...settings(sync), version }));
      assert.equal(syncConfigReviewFingerprint(config), review);
      assert.equal(syncCheckConfigFingerprint(config), check);
    }
  }
});

test.each([
  "current",
  "no-op",
  "edited before lock",
  "edited at publication",
  "canonical appeared at publication",
] as const)("shared reviewed save from the legacy settings filename: %s", (change) =>
  fixture(async (root) => {
    const canonical = path.join(root, "pi-sync.json");
    const legacy = path.join(root, "pi-sync.local.json");
    const original = { ...settings(legacySync), future: { preserved: true } };
    const bytes = `${JSON.stringify(original)}\n\n`;
    await fs.writeFile(legacy, bytes, { mode: 0o600 });
    const fingerprint = (document: LocalConfigDocument | undefined) =>
      documentFingerprint(document && { bytes: document.bytes.toString("base64"), identity: document.identity });
    const reviewed = fingerprint(await peekLocalConfigDocument());
    const update = () =>
      updateLocalConfigDocument(
        original,
        (current) => (change === "no-op" ? current : { ...current, debug: true }),
        validateSettingsDocument,
        undefined,
        (document) => {
          if (fingerprint(document) !== reviewed) throw new Error("Reviewed settings changed.");
        },
      );
    if (change === "current" || change === "no-op") {
      assert.deepEqual(await update(), change === "current" ? { ...original, debug: true } : original);
      if (change === "current") {
        assert.deepEqual(JSON.parse(await fs.readFile(canonical, "utf8")), { ...original, debug: true });
        if (process.platform !== "win32") assert.equal((await fs.stat(canonical)).mode & 0o777, 0o600);
      } else await assert.rejects(fs.lstat(canonical), { code: "ENOENT" });
    } else {
      if (change === "edited before lock") await fs.appendFile(legacy, "\n");
      await assert.rejects(
        withConfigPublicationReadyHookForTest(async () => {
          if (change === "edited before lock") assert.fail("Stale approval reached publication");
          if (change === "edited at publication") await fs.appendFile(legacy, "\n");
          else await fs.writeFile(canonical, bytes, { mode: 0o600 });
        }, update),
        /settings changed/iu,
      );
      if (change === "canonical appeared at publication") assert.equal(await fs.readFile(canonical, "utf8"), bytes);
      else await assert.rejects(fs.lstat(canonical), { code: "ENOENT" });
    }
    assert.equal(await fs.readFile(legacy, "utf8"), change.startsWith("edited") ? `${bytes}\n` : bytes);
    assert.ok(!(await fs.readdir(root)).some((name) => name.startsWith(".pi-sync.json.")));
  }),
);

test.each(["missing", "legacy"] as const)(
  "a reviewed %s source does not clobber canonical settings created at the final destination probe",
  (source) =>
    fixture(async (root) => {
      const canonical = path.join(root, "pi-sync.json");
      const legacy = path.join(root, "pi-sync.local.json");
      const original = settings(legacySync);
      if (source === "legacy") await fs.writeFile(legacy, JSON.stringify(original), { mode: 0o600 });
      const concurrent = `${JSON.stringify({ ...original, showStatus: false })}\n\n`;
      let staged = false;
      let checkedAfterStaging = false;
      const lstat = fs.lstat.bind(fs);
      const probe = vi.spyOn(fs, "lstat").mockImplementation(async (...args) => {
        if (checkedAfterStaging && args[0] === canonical) {
          checkedAfterStaging = false;
          await fs.writeFile(canonical, concurrent, { flag: "wx", mode: 0o600 });
        }
        return lstat(...args);
      });
      try {
        await assert.rejects(
          withConfigPublicationReadyHookForTest(
            async () => {
              staged = true;
            },
            () =>
              updateLocalConfigDocument(
                original,
                (current) => ({ ...current, debug: true }),
                validateSettingsDocument,
                undefined,
                (document) => {
                  assert.equal(document?.path, source === "legacy" ? legacy : undefined);
                  checkedAfterStaging = staged;
                },
              ),
          ),
          /already exist|created concurrently/u,
        );
      } finally {
        probe.mockRestore();
      }
      assert.equal(await fs.readFile(canonical, "utf8"), concurrent);
      if (source === "legacy") assert.deepEqual(JSON.parse(await fs.readFile(legacy, "utf8")), original);
      assert.ok(!(await fs.readdir(root)).some((name) => name.endsWith(".migrate")));
    }),
);

test("settings writers advance to 8 for ignore-file policies and preserve 8 on unrelated legacy updates", () =>
  fixture(async (root) => {
    const original = settings();
    const first = await saveNewV3Settings({
      setupName: "home",
      connectionName: "origin",
      connection: original.storageConnections.origin,
      setup: original.syncSetups.home,
    });
    assert.equal(first.version, 8);
    await updateLocalConfig((latest) => ({ ...latest, future: { preserved: true } }));
    await addSyncSetup("legacy", setup("legacy", legacySync));
    await updateSyncSetup("legacy", (current) => ({ ...current, sync: { ...current.sync, automatic: true } }));
    await updateSyncSetup("home", (current) => ({ ...current, displayName: "Main setup" }));
    const saved = validateSettingsDocument(JSON.parse(await fs.readFile(path.join(root, "pi-sync.json"), "utf8")));
    assert.equal(saved.version, 8);
    assert.deepEqual(saved.future, { preserved: true });
    assert.deepEqual(saved.syncSetups.home.sync, ignoreSync);
    assert.equal(saved.syncSetups.legacy.sync.automatic, true);
    assert.deepEqual(await fs.readdir(root), ["pi-sync.json"]);
  }));
