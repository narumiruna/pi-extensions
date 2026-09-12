import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { createTuiHarness } from "@narumitw/pi-tui-kit/testing";
import { test } from "vitest";
import { createCustomSelectorHarness, createMockPi } from "../../../test/support.js";
import { loadConfig } from "../src/settings/config.js";
import {
  localConfigPath,
  withConfigFilePublicationForTest,
  withLocalConfigFileLock,
} from "../src/settings/config-file.js";
import {
  addStorageConnection,
  addSyncSetup,
  removeStorageConnection,
  removeSyncSetup,
  updateStorageConnection,
  updateSyncSetup,
} from "../src/settings/settings-management.js";
import { configuredSyncSetupNames, readLocalConfigObject, updateLocalConfig } from "../src/settings/settings-store.js";
import { SetupPullRequiresUiError, useSyncSetup } from "../src/sync/setup-switch.js";
import sync from "../src/sync.js";
import { showSyncSettings } from "../src/ui/settings-ui.js";
import { showSetupWizard } from "../src/ui/setup/setup-wizard.js";
import { showStorageConnections } from "../src/ui/storage-connections-ui.js";
import { v3S3Settings, withTempHome } from "./helpers.js";
import { createMockContext } from "./setup-test-context.js";

initTheme("dark", false);
const execFileAsync = promisify(execFile);

function writeSettings(value = v3S3Settings()) {
  writeFileSync(localConfigPath(), `${JSON.stringify(value, null, "\t")}\n`, { mode: 0o600 });
}

test.each([
  ["home", "home"],
  ["work", "work"],
  [" personal ", "personal"],
  ["", "default"],
  ["   ", "default"],
])("first Cloudflare R2 setup uses entered name %j and masked credentials", async (input, name) => {
  await withTempHome(async (agentDir) => {
    mkdirSync(agentDir, { recursive: true });
    const mock = createMockPi();
    sync(mock.pi);
    const choices = [
      "Set up sync",
      "Cloudflare R2",
      "Use an existing bucket at ./",
      "Store credentials privately",
      "Recommended Pi settings",
      "Enable automatic sync",
      "Keep sessions off (recommended)",
      "Save sync setup",
      undefined,
    ];
    const inputs = [input, "https://account.r2.cloudflarestorage.com", "pi-sync", "access-key"];
    const rendered: string[] = [];
    const inputTitles: string[] = [];
    const { ctx } = createMockContext({
      hasUI: true,
      mode: "tui",
      select: async (title: string) => {
        rendered.push(title);
        return choices.shift();
      },
      input: async (title: string) => {
        inputTitles.push(title);
        return inputs.shift();
      },
      custom: secretInput("secret-key", rendered),
    });
    await mock.commands.get("sync")?.handler("", ctx);
    const saved = await readLocalConfigObject();
    assert.equal(saved?.skipSecretScan, false);
    assert.deepEqual(saved?.storageConnections[name], {
      type: "s3",
      endpoint: "https://account.r2.cloudflarestorage.com",
      region: "auto",
      credentials: { accessKeyId: "access-key", secretAccessKey: "secret-key" },
    });
    assert.equal(saved?.activeSyncSetup, name);
    assert.deepEqual(saved?.syncSetups[name].storage, {
      connection: name,
      bucket: "pi-sync",
      path: "./",
    });
    assert.equal(inputTitles[0], "Sync setup name\nFor example: home or work. Leave blank for default.");
    assert.deepEqual(
      inputTitles.slice(1).map((title) => title.split("\n")[0]),
      ["Cloudflare R2 endpoint", "Existing bucket", "Access key ID"],
    );
    assert.match(inputTitles[1], /Example: https:\/\/<account-id>\.r2\.cloudflarestorage\.com/u);
    assert.ok(rendered.join("\n").includes("Storage location: ./"));
    assert.doesNotMatch(rendered.join("\n"), /What will this sync setup be used for/u);
    assert.doesNotMatch(rendered.join("\n"), /profiles\/|secret-key|access-key/u);
  });
});

test.each(
  ["Cloudflare R2", "Other S3-compatible storage"].flatMap((preset) =>
    ["work/", "work///", "team/work/", "work /", "/", " work/ "].map((input) => ({
      preset,
      input,
    })),
  ),
)("$preset setup named $input uses the exact reviewed root path", async ({ preset, input }) => {
  await withTempHome(async () => {
    const r2 = preset === "Cloudflare R2";
    const choices = [
      preset,
      "Use an existing bucket at ./",
      "Store credentials privately",
      "Minimal settings",
      "Keep automatic sync off",
      "Keep sessions off (recommended)",
      "Save sync setup",
    ];
    const inputs = [
      r2 ? "https://account.r2.cloudflarestorage.com" : "https://s3.example.com",
      ...(r2 ? [] : ["us-east-1"]),
      "existing-bucket",
      "access-key",
    ];
    const titles: string[] = [];
    let nameCalls = 0;
    let review = "";
    const { ctx, notifications } = createMockContext({
      hasUI: true,
      mode: "tui",
      select: async (title: string) => {
        if (title.includes("Review sync setup")) review = title;
        return choices.shift();
      },
      input: async (title: string) => {
        titles.push(title);
        if (title.startsWith("Sync setup name")) {
          nameCalls++;
          return input;
        }
        return inputs.shift();
      },
      custom: secretInput("secret-key"),
    });
    assert.equal(await showSetupWizard(ctx), true);
    assert.match(review, /Storage location: \.\//u);
    assert.match(titles[0], /^Sync setup name/u);
    assert.equal(nameCalls, 1);
    assert.equal(notifications.filter((item) => item.level === "warning").length, 0);
    const saved = await readLocalConfigObject();
    const name = input.trim();
    assert.equal(saved?.activeSyncSetup, name);
    assert.equal(saved?.syncSetups[name].storage.path, "./");
    const config = await loadConfig();
    assert.equal(config.storagePath, "./");
    assert.equal(config.backend.type, "s3");
    if (config.backend.type !== "s3") return;
    assert.equal(config.backend.destination.prefix, "./");
  });
});

test("generic S3 setup reviews one complete custom storage path", async () => {
  await withTempHome(async (agentDir) => {
    mkdirSync(agentDir, { recursive: true });
    const mock = createMockPi();
    sync(mock.pi);
    const choices = [
      "Set up sync",
      "Other S3-compatible storage",
      "Customize remote location",
      "Store credentials privately",
      "Minimal settings",
      "Keep automatic sync off",
      "Keep sessions off (recommended)",
      "Save sync setup",
      undefined,
    ];
    const inputs = ["work", "https://s3.example.com", "ap-northeast-1", "company-pi", "teams/pi/work", "access-key"];
    const inputTitles: string[] = [];
    const { ctx } = createMockContext({
      hasUI: true,
      mode: "tui",
      select: async () => choices.shift(),
      input: async (title: string) => {
        inputTitles.push(title);
        return inputs.shift();
      },
      custom: secretInput("secret-key"),
    });
    await mock.commands.get("sync")?.handler("", ctx);
    const saved = await readLocalConfigObject();
    assert.deepEqual(saved?.syncSetups.work.storage, {
      connection: "work",
      bucket: "company-pi",
      path: "teams/pi/work",
    });
    assert.ok(inputTitles.some((title) => title.startsWith("Storage path\n")));
    assert.equal(inputTitles.filter((title) => /name/iu.test(title.split("\n")[0])).length, 1);
    assert.ok(!inputTitles.includes("Remote prefix"));
    assert.ok(!inputTitles.includes("Remote namespace"));
  });
});

test("session inclusion requires privacy acknowledgement before settings publication", async () => {
  await withTempHome(async (agentDir) => {
    mkdirSync(agentDir, { recursive: true });
    const mock = createMockPi();
    sync(mock.pi);
    const choices = [
      "Set up sync",
      "Cloudflare R2",
      "Use an existing bucket at ./",
      "Store credentials privately",
      "Recommended Pi settings",
      "Keep automatic sync off",
      "Include session conversations",
    ];
    const inputs = ["home", "https://account.r2.cloudflarestorage.com", "existing-bucket", "access-key"];
    let privacyShown = false;
    const { ctx } = createMockContext({
      hasUI: true,
      mode: "tui",
      select: async () => choices.shift(),
      input: async () => inputs.shift(),
      confirm: async (title: string) => {
        privacyShown = title === "Include session conversations?";
        return false;
      },
      custom: secretInput("secret-key"),
    });
    await mock.commands.get("sync")?.handler("", ctx);
    assert.equal(privacyShown, true);
    assert.equal(await readLocalConfigObject(), undefined);
  });
});

test("cancelling first setup creates neither settings nor sync state", async () => {
  await withTempHome(async (agentDir) => {
    mkdirSync(agentDir, { recursive: true });
    const mock = createMockPi();
    sync(mock.pi);
    const choices = ["Set up sync", undefined];
    const { ctx } = createMockContext({
      hasUI: true,
      mode: "tui",
      select: async () => choices.shift(),
    });
    await mock.commands.get("sync")?.handler("", ctx);
    assert.equal(await readLocalConfigObject(), undefined);
    assert.equal(existsSync(path.join(agentDir, "pi-sync")), false);
    assert.equal(existsSync(path.join(agentDir, ".pisync")), false);
  });
});

test.each(["Cloudflare R2", "Other S3-compatible storage", "WebDAV", "Git"])(
  "%s setup asks directly for a name and cancellation creates no settings or state",
  async (preset) => {
    await withTempHome(async (agentDir) => {
      const selections: string[][] = [];
      const inputs: string[] = [];
      const { ctx } = createMockContext({
        hasUI: true,
        mode: "tui",
        select: async (_title: string, options: string[]) => {
          selections.push(options);
          return selections.length === 1 ? preset : undefined;
        },
        input: async (title: string) => {
          inputs.push(title);
          return undefined;
        },
      });
      assert.equal(await showSetupWizard(ctx), false);
      assert.equal(selections.length, 1);
      assert.equal(inputs.length, 1);
      assert.match(inputs[0], /^Sync setup name\n/u);
      assert.equal(await readLocalConfigObject(), undefined);
      assert.equal(existsSync(path.join(agentDir, "pi-sync")), false);
      assert.equal(existsSync(path.join(agentDir, ".pisync")), false);
    });
  },
);

test("aborting the name input ignores a late answer without advancing setup", async () => {
  await withTempHome(async () => {
    const controller = new AbortController();
    let inputCalls = 0;
    let receivedSignal: AbortSignal | undefined;
    const { ctx } = createMockContext({
      hasUI: true,
      mode: "tui",
      select: async () => "Cloudflare R2",
      input: async (_title: string, _placeholder?: string, options?: { signal?: AbortSignal }) => {
        inputCalls += 1;
        receivedSignal = options?.signal;
        controller.abort(new DOMException("Session replaced", "AbortError"));
        return "home";
      },
    });
    await assert.rejects(showSetupWizard(ctx, controller.signal), { name: "AbortError" });
    assert.equal(receivedSignal, controller.signal);
    assert.equal(inputCalls, 1);
    assert.equal(await readLocalConfigObject(), undefined);
  });
});

test("S3 storage connection edit preserves masked credentials and reviews dependents", async () => {
  await withTempHome(async (agentDir) => {
    mkdirSync(agentDir, { recursive: true });
    writeSettings();
    const choices = [
      "r2",
      "Edit storage connection…",
      "Keep current credentials",
      "Save storage connection",
      "Back",
      "Back",
    ];
    const inputs = ["https://new.example.com", "us-east-1"];
    const rendered: string[] = [];
    const { ctx } = createMockContext({
      hasUI: true,
      mode: "tui",
      select: async (title: string) => {
        rendered.push(title);
        return choices.shift();
      },
      input: async () => inputs.shift(),
    });
    await showStorageConnections(ctx);
    const config = await loadConfig();
    assert.equal(config.backend.type, "s3");
    if (config.backend.type !== "s3") return;
    assert.equal(config.backend.profile.endpoint, "https://new.example.com");
    assert.equal(config.backend.profile.accessKeyId, "access-key");
    assert.match(rendered.join("\n"), /Affected sync setups: home/u);
    assert.doesNotMatch(rendered.join("\n"), /access-key|secret-key/u);
  });
});

test("replacing stored S3 credentials drops the prior session token", async () => {
  await withTempHome(async (agentDir) => {
    mkdirSync(agentDir, { recursive: true });
    const settings = v3S3Settings();
    (settings.storageConnections.r2.credentials as Record<string, string>).sessionToken = "stale-session-token";
    writeSettings(settings);
    const choices = [
      "r2",
      "Edit storage connection…",
      "Change credential source",
      "Store credentials privately",
      "Save storage connection",
      "Back",
      "Back",
    ];
    const inputs = [
      settings.storageConnections.r2.endpoint,
      settings.storageConnections.r2.region,
      "replacement-access-key",
    ];
    const { ctx } = createMockContext({
      hasUI: true,
      mode: "tui",
      select: async () => choices.shift(),
      input: async () => inputs.shift(),
      custom: secretInput("replacement-secret-key"),
    });
    await showStorageConnections(ctx);
    assert.deepEqual((await readLocalConfigObject())?.storageConnections.r2.credentials, {
      accessKeyId: "replacement-access-key",
      secretAccessKey: "replacement-secret-key",
    });
  });
});

test("S3 manager reuses a connection and defaults a new setup to the bucket root", async () => {
  await withTempHome(async (agentDir) => {
    mkdirSync(agentDir, { recursive: true });
    writeSettings();
    const mock = createMockPi();
    sync(mock.pi);
    const choices = [
      "More…",
      "Sync setups…",
      "Add sync setup",
      "r2",
      "Same bucket as “home”",
      "Recommended Pi settings",
      "Keep automatic sync off",
      "Add sync setup",
      undefined,
      undefined,
    ];
    const inputs = ["work"];
    const rendered: string[] = [];
    const { ctx } = createMockContext({
      hasUI: true,
      mode: "tui",
      select: async (title: string) => {
        rendered.push(title);
        return choices.shift();
      },
      input: async () => inputs.shift(),
    });
    await mock.commands.get("sync")?.handler("", ctx);
    const config = await loadConfig("work");
    assert.equal(config.connectionName, "r2");
    assert.equal(config.storagePath, "./");
    assert.equal((await loadConfig("home")).storagePath, "pi-sync/home");
    assert.match(rendered.join("\n"), /Remote path: \.\//u);
    assert.match(rendered.join("\n"), /different path or bucket for independent setups/u);
    assert.doesNotMatch(rendered.join("\n"), /profiles\//u);
  });
});

test("storage connections are reusable by multiple independently named sync setups", async () => {
  await withTempHome(async (agentDir) => {
    mkdirSync(agentDir, { recursive: true });
    writeSettings();
    await addSyncSetup("work", {
      storage: { connection: "r2", bucket: "pi-sync-test", path: "pi-sync/work" },
      sync: { include: ["settings.json"], automatic: false },
    });
    assert.deepEqual(await configuredSyncSetupNames(), ["home", "work"]);
    assert.equal((await loadConfig("work")).connectionName, "r2");
    assert.equal((await loadConfig("work")).storagePath, "pi-sync/work");
  });
});

test("duplicate normalized remote locations fail before publication", async () => {
  await withTempHome(async (agentDir) => {
    mkdirSync(agentDir, { recursive: true });
    writeSettings();
    await assert.rejects(
      addSyncSetup("duplicate", {
        storage: { connection: "r2", bucket: "pi-sync-test", path: "/pi-sync/home/" },
        sync: { include: [], automatic: false },
      }),
      /duplicates the storage location/u,
    );
  });
});

test("referenced connections and a current setup with alternatives cannot be removed", async () => {
  await withTempHome(async (agentDir) => {
    mkdirSync(agentDir, { recursive: true });
    writeSettings();
    await addSyncSetup("work", {
      storage: { connection: "r2", bucket: "pi-sync-test", path: "pi-sync/work" },
      sync: { include: ["settings.json"], automatic: false },
    });
    await assert.rejects(removeStorageConnection("r2"), /used by sync setup “home”/u);
    await assert.rejects(removeSyncSetup("home"), /another sync setup/u);
    assert.equal((await readLocalConfigObject())?.activeSyncSetup, "home");
  });
});

test("removing the sole current setup clears the active reference", async () => {
  await withTempHome(async (agentDir) => {
    mkdirSync(agentDir, { recursive: true });
    writeSettings();
    await removeSyncSetup("home");
    const settings = await readLocalConfigObject();
    assert.deepEqual(settings?.syncSetups, {});
    assert.equal(Object.hasOwn(settings ?? {}, "activeSyncSetup"), false);
    assert.ok(settings?.storageConnections.r2);
  });
});

test("storage connection and sync setup CRUD preserve unknown retained fields", async () => {
  await withTempHome(async (agentDir) => {
    mkdirSync(agentDir, { recursive: true });
    const initial = v3S3Settings() as unknown as Record<string, unknown>;
    initial.futureTop = { keep: true };
    writeSettings(initial as ReturnType<typeof v3S3Settings>);
    await addStorageConnection("git", {
      type: "git",
      remote: "git@github.com:user/pi-sync.git",
      futureConnection: "keep",
    });
    await addSyncSetup("backup", {
      storage: {
        connection: "git",
        branch: "pi-sync/backup",
        path: "pi-sync/backup",
        futureStorage: "keep",
      },
      sync: { include: [], automatic: false, futurePolicy: "keep" },
      futureSetup: "keep",
    });
    await updateStorageConnection("git", (connection) => {
      if (connection.type !== "git") throw new Error("expected Git");
      return { ...connection, remote: "ssh://git@github.com/user/pi-sync.git" };
    });
    await updateSyncSetup("backup", (setup) => ({ ...setup, futureSetup: "still" }));
    const saved = JSON.parse(readFileSync(localConfigPath(), "utf8"));
    assert.deepEqual(saved.futureTop, { keep: true });
    assert.equal(saved.storageConnections.git.futureConnection, "keep");
    assert.equal(saved.syncSetups.backup.storage.futureStorage, "keep");
    assert.equal(saved.syncSetups.backup.sync.futurePolicy, "keep");
    assert.equal(saved.syncSetups.backup.futureSetup, "still");
  });
});

test("switching setup is atomic and follows all three onSwitch policies", async () => {
  await withTempHome(async (agentDir) => {
    mkdirSync(agentDir, { recursive: true });
    writeSettings();
    await addSyncSetup("work", {
      storage: { connection: "r2", bucket: "pi-sync-test", path: "pi-sync/work" },
      sync: { include: ["settings.json"], automatic: false },
    });
    await updateLocalConfig((settings) => ({ ...settings, onSwitch: "switch-only" }));
    const mock = createMockContext({ hasUI: true, mode: "tui" });
    assert.deepEqual(await useSyncSetup(mock.ctx, "work"), { pullApplied: false });
    assert.equal((await readLocalConfigObject())?.activeSyncSetup, "work");

    await updateLocalConfig((settings) => ({
      ...settings,
      onSwitch: "ask-before-pull",
      activeSyncSetup: "home",
    }));
    let pullCalls = 0;
    const declined = createMockContext({
      hasUI: true,
      mode: "tui",
      confirm: async () => false,
    });
    assert.deepEqual(
      await useSyncSetup(declined.ctx, "work", async () => {
        pullCalls += 1;
        return "applied";
      }),
      { pullApplied: false },
    );
    assert.equal(pullCalls, 0);
    assert.equal((await readLocalConfigObject())?.activeSyncSetup, "work");

    await updateLocalConfig((settings) => ({ ...settings, onSwitch: "pull-after-switch" }));
    const noUi = createMockContext({ hasUI: false, mode: "print" });
    await assert.rejects(useSyncSetup(noUi.ctx, "home"), SetupPullRequiresUiError);
    assert.equal((await readLocalConfigObject())?.activeSyncSetup, "work");

    let pulled: string | undefined;
    await assert.rejects(
      useSyncSetup(mock.ctx, "home", async (name) => {
        pulled = name;
        throw new Error("pull failed");
      }),
      /pull failed/u,
    );
    assert.equal(pulled, "home");
    assert.equal((await readLocalConfigObject())?.activeSyncSetup, "home");
    assert.deepEqual(await useSyncSetup(mock.ctx, "home"), { pullApplied: false });
  });
});

test("cross-process settings mutations serialize under one read-modify-write lock", async () => {
  await withTempHome(async (agentDir) => {
    mkdirSync(agentDir, { recursive: true });
    writeSettings();
    const configModule = pathToFileURL(
      path.join(
        process.cwd(),
        "node_modules/.cache/pi-extensions-test/packages/pi-sync/src/settings/settings-store.js",
      ),
    ).href;
    const mutate = (field: string) =>
      execFileAsync(
        process.execPath,
        [
          "--input-type=module",
          "--eval",
          `import { updateLocalConfig } from ${JSON.stringify(configModule)}; await updateLocalConfig((settings) => ({ ...settings, ${field}: true }));`,
        ],
        { env: { ...process.env, PI_CODING_AGENT_DIR: agentDir } },
      );
    await Promise.all([mutate("processOne"), mutate("processTwo")]);
    const saved = JSON.parse(readFileSync(localConfigPath(), "utf8"));
    assert.equal(saved.processOne, true);
    assert.equal(saved.processTwo, true);
  });
});

test("concurrent settings mutations serialize without dropping either update", async () => {
  await withTempHome(async (agentDir) => {
    mkdirSync(agentDir, { recursive: true });
    writeSettings();
    await Promise.all([
      updateLocalConfig((settings) => ({ ...settings, firstUnknown: true })),
      updateLocalConfig((settings) => ({ ...settings, secondUnknown: true })),
    ]);
    const saved = JSON.parse(readFileSync(localConfigPath(), "utf8"));
    assert.equal(saved.firstUnknown, true);
    assert.equal(saved.secondUnknown, true);
    if (process.platform !== "win32") assert.equal(statSync(localConfigPath()).mode & 0o777, 0o600);
  });
});

test("an aborted settings mutation waiting on the update queue never publishes", async () => {
  await withTempHome(async (agentDir) => {
    mkdirSync(agentDir, { recursive: true });
    writeSettings();
    let releaseLock = () => {};
    let reportLockHeld = () => {};
    const lockHeld = new Promise<void>((resolve) => {
      reportLockHeld = () => resolve();
    });
    const release = new Promise<void>((resolve) => {
      releaseLock = () => resolve();
    });
    const blocker = withLocalConfigFileLock(async () => {
      reportLockHeld();
      await release;
    });
    await lockHeld;
    const first = updateLocalConfig((settings) => ({ ...settings, firstQueued: true }));
    const controller = new AbortController();
    const second = updateLocalConfig((settings) => ({ ...settings, abortedQueued: true }), controller.signal);
    const rejected = assert.rejects(second, { name: "AbortError" });
    controller.abort(new DOMException("Session replaced", "AbortError"));
    releaseLock();
    await blocker;
    await first;
    await rejected;
    const saved = await readLocalConfigObject();
    assert.equal(saved?.firstQueued, true);
    assert.equal(saved?.abortedQueued, undefined);
  });
});

test("an aborted settings mutation waiting on the cross-process lock never publishes", async () => {
  await withTempHome(async (agentDir) => {
    mkdirSync(agentDir, { recursive: true });
    writeSettings();
    let releaseLock = () => {};
    let reportLockHeld = () => {};
    const lockHeld = new Promise<void>((resolve) => {
      reportLockHeld = () => resolve();
    });
    const release = new Promise<void>((resolve) => {
      releaseLock = () => resolve();
    });
    const blocker = withLocalConfigFileLock(async () => {
      reportLockHeld();
      await release;
    });
    await lockHeld;
    const controller = new AbortController();
    const update = updateLocalConfig((settings) => ({ ...settings, abortedWhileLocked: true }), controller.signal);
    const rejected = assert.rejects(update, { name: "AbortError" });
    controller.abort(new DOMException("Session replaced", "AbortError"));
    releaseLock();
    await blocker;
    await rejected;
    assert.equal((await readLocalConfigObject())?.abortedWhileLocked, undefined);
  });
});

test("settings UI exposes local editing and synced-content comparison", async () => {
  await withTempHome(async (agentDir) => {
    mkdirSync(agentDir, { recursive: true });
    const before = Buffer.from(`${JSON.stringify(v3S3Settings())}\n`);
    writeFileSync(localConfigPath(), before, { mode: 0o600 });
    let rendered = "";
    const { ctx } = createMockContext({
      hasUI: true,
      mode: "tui",
      custom: async (factory: unknown) => {
        const harness = createCustomSelectorHarness(factory, 100);
        rendered = harness.render().join("\n");
        harness.handleInput("tui.select.cancel");
        return harness.result;
      },
    });

    await showSyncSettings(ctx, async () => undefined);

    assert.match(rendered, /Included content/u);
    assert.match(rendered, /Compare synced content/u);
    assert.deepEqual(readFileSync(localConfigPath()), before);
  });
});

test("settings UI persists the global secret-scan override", async () => {
  await withTempHome(async (agentDir) => {
    mkdirSync(agentDir, { recursive: true });
    writeSettings();
    const { ctx, notifications } = createMockContext({
      hasUI: true,
      mode: "tui",
      custom: async (factory: unknown) => {
        const harness = createCustomSelectorHarness(factory, 100);
        harness.handleInput("tui.select.down");
        harness.handleInput("\r");
        for (let attempt = 0; attempt < 100 && notifications.length === 0; attempt += 1) {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        harness.handleInput("\u001b");
        return harness.result;
      },
    });

    await showSyncSettings(ctx, async () => undefined);

    assert.equal((await loadConfig()).skipSecretScan, true);
    assert.equal((await readLocalConfigObject())?.skipSecretScan, true);
  });
});

test("settings UI disposes on session replacement without mutating settings", async () => {
  await withTempHome(async (agentDir) => {
    mkdirSync(agentDir, { recursive: true });
    const before = Buffer.from(`${JSON.stringify(v3S3Settings())}\n`);
    writeFileSync(localConfigPath(), before, { mode: 0o600 });
    const controller = new AbortController();
    const { ctx, notifications } = createMockContext({
      hasUI: true,
      mode: "tui",
      custom: async (factory: unknown) => {
        const harness = createCustomSelectorHarness(factory, 80);
        harness.handleInput("\r");
        controller.abort(new DOMException("Session replaced", "AbortError"));
        harness.dispose();
        return harness.result;
      },
    });
    await showSyncSettings(ctx, async () => undefined, controller.signal);
    assert.deepEqual(readFileSync(localConfigPath()), before);
    assert.deepEqual(notifications, []);
  });
});

test("settings UI restores its displayed value when a private atomic save is rejected", {
  skip: process.platform === "win32",
}, async () => {
  await withTempHome(async (agentDir) => {
    mkdirSync(agentDir, { recursive: true });
    writeSettings();
    let afterFailure = "";
    const { ctx, notifications } = createMockContext({
      hasUI: true,
      mode: "tui",
      custom: async (factory: unknown) => {
        const harness = createCustomSelectorHarness(factory, 80);
        harness.handleInput("tui.select.down");
        harness.handleInput("\r");
        for (let attempt = 0; attempt < 100 && notifications.length === 0; attempt += 1) {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        afterFailure = harness.render().join("\n");
        harness.handleInput("\u001b");
        return harness.result;
      },
    });
    await withConfigFilePublicationForTest(
      async () => {
        const error = new Error("injected settings failure") as NodeJS.ErrnoException;
        error.code = "EACCES";
        throw error;
      },
      () => showSyncSettings(ctx, async () => undefined),
    );
    assert.match(afterFailure, /Skip secret scan/u);
    assert.match(afterFailure, /Off/u);
    assert.match(notifications.at(-1)?.message ?? "", /settings save failed/iu);
    assert.equal((await loadConfig()).skipSecretScan, false);
  });
});

test("invalid files block CRUD and remain byte-for-byte unchanged", async () => {
  await withTempHome(async (agentDir) => {
    mkdirSync(agentDir, { recursive: true });
    const bytes = Buffer.from('{"version":3,"storageConnections":');
    writeFileSync(localConfigPath(), bytes, { mode: 0o600 });
    await assert.rejects(
      addStorageConnection("git", { type: "git", remote: "git@github.com:user/repo.git" }),
      /Invalid JSON/u,
    );
    assert.deepEqual(readFileSync(localConfigPath()), bytes);
  });
});

function secretInput(secret: string, rendered: string[] = []) {
  return async (factory: unknown) => {
    const tui = createTuiHarness({ width: 48 });
    const running = tui.custom(factory as Parameters<typeof tui.custom>[0]);
    await tui.waitForOpen();
    tui.type(secret);
    rendered.push(tui.render().join("\n"));
    tui.press("tui.input.submit");
    return running;
  };
}
