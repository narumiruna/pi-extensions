import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { test, vi } from "vitest";
import { createMockContext, createMockPi } from "../../../test/support.js";
import { withPiDaemonClient } from "../src/daemon/pi-client.js";
import { loadConfig } from "../src/settings/config.js";
import { localConfigPath, withConfigReplacementInstalledHookForTest } from "../src/settings/config-file.js";
import { updateLocalConfig } from "../src/settings/settings-store.js";
import type { PiSyncSettingsV3 } from "../src/settings/settings-types.js";
import { withStateDirectoryAccess } from "../src/state/state-directory.js";
import { lockPath, writeStateForConfig } from "../src/state/sync-state-store.js";
import { setSyncStatus } from "../src/ui/sync-status.js";
import { adoptFixtureRoot } from "./daemon-test-helpers.js";
import { installEngineFixtureHost } from "./engine-host.js";
import { v3S3Settings, v3WebDavSettings, withTempHome } from "./helpers.js";
import { initializationGate } from "./initialization-gate.js";
import { MockWebDavServer } from "./mock-webdav-server.js";
import { contextUi, deferred, inspectionFixture, observeCheckCompletion } from "./startup-check-helpers.js";

async function configured(run: (agentDir: string) => Promise<void>) {
  await withTempHome(async (agentDir) => {
    await fs.mkdir(agentDir, { recursive: true });
    await fs.writeFile(localConfigPath(), JSON.stringify(v3S3Settings({ automatic: true })));
    await fs.writeFile(path.join(agentDir, "settings.json"), "{}\n");
    await adoptFixtureRoot(agentDir);
    await run(agentDir);
  });
}

for (const reason of ["startup", "reload", "new", "resume", "fork"] as const) {
  test(`${reason} returns with a pending check; foreground help cancels and drains it`, async () => {
    await configured(async (agentDir) => {
      const { default: sync } = await import("../src/sync-extension.js");
      const started = deferred();
      const cleanup = deferred();
      let aborted = false;
      let mutatingLoads = 0;
      const mock = createMockPi();
      sync(mock.pi, {
        loadSyncOperations: async () => {
          mutatingLoads++;
          throw new Error("must remain lazy");
        },
        loadSyncInspection: async () => ({
          inspectSync: async (config, _options, signal) => {
            started.resolve();
            await new Promise<void>((resolve) =>
              signal?.addEventListener(
                "abort",
                () => {
                  aborted = true;
                  resolve();
                },
                { once: true },
              ),
            );
            await cleanup.promise;
            return inspectionFixture(config, { localChanged: true });
          },
        }),
      });
      const context = createMockContext({ hasUI: true, mode: "rpc" });
      await mock.events.get("session_start")?.[0]?.({ reason }, context.ctx);
      await started.promise;
      assert.equal(mutatingLoads, 0);
      assert.equal(context.statuses.get("sync"), "sync ...");
      const command = mock.commands.get("sync")?.handler("help", context.ctx);
      // Use the task's abort event, not a network sleep, as the handoff boundary.
      await vi.waitFor(() => assert.equal(aborted, true));
      assert.equal(context.notifications.length, 0, "foreground has not bypassed cleanup");
      cleanup.resolve();
      await command;
      assert.equal(context.widgets.get("sync:attention"), undefined);
      assert.equal(context.statuses.get("sync"), undefined);
      assert.equal(await fs.readFile(path.join(agentDir, "settings.json"), "utf8"), "{}\n");
      await mock.events.get("session_shutdown")?.[0]?.({ reason: "reload" }, context.ctx);
    });
  });
}

test("disabled status remains active when the session starts without a sync setup", async () => {
  await configured(async () => {
    await fs.writeFile(
      localConfigPath(),
      JSON.stringify({
        version: 3,
        onSwitch: "ask-before-pull",
        skipSecretScan: false,
        showStatus: false,
        storageConnections: {},
        syncSetups: {},
      }),
    );
    const { default: sync } = await import("../src/sync-extension.js");
    const mock = createMockPi();
    sync(mock.pi);
    const context = createMockContext({ mode: "rpc" });

    await mock.events.get("session_start")?.[0]?.({}, context.ctx);
    const configuredSettings = v3S3Settings() as PiSyncSettingsV3;
    await withPiDaemonClient(context.ctx, () =>
      updateLocalConfig((settings) => ({
        ...settings,
        activeSyncSetup: configuredSettings.activeSyncSetup,
        storageConnections: configuredSettings.storageConnections,
        syncSetups: configuredSettings.syncSetups,
      })),
    );
    setSyncStatus(context.ctx, "sync ⇡");

    assert.equal(context.statuses.get("sync"), undefined);
    await mock.events.get("session_shutdown")?.[0]?.({ reason: "reload" }, context.ctx);
  });
});

test("disabled status suppresses startup progress and one-sided results", async () => {
  await configured(async () => {
    const settings = { ...v3S3Settings({ automatic: true }), showStatus: false };
    await fs.writeFile(localConfigPath(), JSON.stringify(settings));
    const { default: sync } = await import("../src/sync-extension.js");
    const entered = deferred();
    const release = deferred();
    const mock = createMockPi();
    sync(mock.pi, {
      loadSyncInspection: async () => ({
        inspectSync: async (config) => {
          entered.resolve();
          await release.promise;
          return inspectionFixture(config, { localChanged: true });
        },
      }),
    });
    const context = createMockContext({ mode: "rpc" });
    await mock.events.get("session_start")?.[0]?.({}, context.ctx);
    await entered.promise;
    assert.equal(context.statuses.get("sync"), undefined);
    release.resolve();
    await mock.commands.get("sync")?.handler("help", context.ctx);
    assert.equal(context.statuses.get("sync"), undefined);
    assert.equal(context.widgets.get("sync:attention"), undefined);
    await mock.events.get("session_shutdown")?.[0]?.({ reason: "reload" }, context.ctx);
  });
});

for (const mode of ["tui", "rpc", "print", "json"] as const) {
  for (const automatic of [false, true]) {
    test(`${mode} automatic=${automatic}: correct loading and no startup dialogs`, async () => {
      await configured(async () => {
        await fs.writeFile(localConfigPath(), JSON.stringify(v3S3Settings({ automatic })));
        const { default: sync } = await import("../src/sync-extension.js");
        let loads = 0;
        const mock = createMockPi();
        sync(mock.pi, {
          loadSyncInspection: async () => {
            loads++;
            return { inspectSync: (config) => inspectionFixture(config) };
          },
        });
        const context = createMockContext({ mode });
        const dialogs = ["custom", "select", "confirm", "input", "editor"] as const;
        const spies = dialogs.map((name) => vi.spyOn(contextUi(context.ctx), name));
        const completion = observeCheckCompletion(context.ctx);
        try {
          await mock.events.get("session_start")?.[0]?.({}, context.ctx);
          const enabled = automatic && (mode === "tui" || mode === "rpc");
          if (enabled) await completion.completed;
          await mock.events.get("session_shutdown")?.[0]?.({ reason: "reload" }, context.ctx);
          assert.equal(loads, enabled ? 1 : 0);
          for (const spy of spies) assert.equal(spy.mock.calls.length, 0);
          assert.deepEqual(context.notifications, []);
        } finally {
          for (const spy of spies) spy.mockRestore();
        }
      });
    });
  }
}

for (const mutation of ["automatic", "include", "destination", "credentials", "setup", "state", "invalid"] as const) {
  test(`late check result is discarded after independent ${mutation} change`, async () => {
    await configured(async () => {
      const { default: sync } = await import("../src/sync-extension.js");
      const ready = deferred();
      const release = deferred();
      const mock = createMockPi();
      sync(mock.pi, {
        loadSyncInspection: async () => ({
          inspectSync: async (config) => {
            const result = await inspectionFixture(config, { localChanged: true });
            ready.resolve();
            await release.promise;
            return result;
          },
        }),
      });
      const context = createMockContext({ mode: "rpc" });
      const completion = observeCheckCompletion(context.ctx);
      await mock.events.get("session_start")?.[0]?.({}, context.ctx);
      await ready.promise;
      const settings = v3S3Settings({ automatic: true });
      if (mutation === "automatic") settings.syncSetups.home.sync.automatic = false;
      if (mutation === "include") settings.syncSetups.home.sync.include = ["AGENTS.md"];
      if (mutation === "destination") settings.syncSetups.home.storage.path = "different";
      if (mutation === "credentials") settings.storageConnections.r2.credentials.secretAccessKey = "replaced-secret";
      if (mutation === "setup") {
        Object.assign(settings.syncSetups, {
          work: {
            ...settings.syncSetups.home,
            storage: { ...settings.syncSetups.home.storage, path: "work" },
          },
        });
        settings.activeSyncSetup = "work";
      }
      if (mutation === "state")
        await withPiDaemonClient(context.ctx, async () =>
          writeStateForConfig(await loadConfig(), {
            version: 2,
            profile: "home",
            lastAppliedSnapshot: "newer",
            lastFileHashes: {},
          }),
        );
      else await fs.writeFile(localConfigPath(), mutation === "invalid" ? "{broken" : JSON.stringify(settings));
      release.resolve();
      await completion.completed;
      assert.deepEqual(context.notifications, []);
      assert.equal(context.widgets.get("sync:attention"), undefined);
      await mock.events.get("session_shutdown")?.[0]?.({ reason: "reload" }, context.ctx);
    });
  });
}

test("shutdown and replacement cancel late loader work before it can start a backend", async () => {
  await configured(async () => {
    const { default: sync } = await import("../src/sync-extension.js");
    const loaded = deferred();
    const release = deferred();
    let queries = 0;
    const mock = createMockPi();
    sync(mock.pi, {
      loadSyncInspection: async () => {
        loaded.resolve();
        await release.promise;
        return {
          inspectSync: async (config) => {
            queries++;
            return inspectionFixture(config);
          },
        };
      },
    });
    const first = createMockContext({ mode: "rpc" });
    await mock.events.get("session_start")?.[0]?.({}, first.ctx);
    await loaded.promise;
    const shutdown = mock.events.get("session_shutdown")?.[0]?.({ reason: "reload" }, first.ctx);
    release.resolve();
    await shutdown;
    assert.equal(queries, 0);
    assert.equal(first.statuses.get("sync"), undefined);
    await mock.events.get("session_shutdown")?.[0]?.({ reason: "reload" }, first.ctx);
  });
});

test("check deadline aborts underlying work and reports one actionable warning", async () => {
  await configured(async () => {
    const { createStartupCheck } = await import("../src/sync/startup-check.js");
    const { createSyncLoaders } = await import("../src/sync/sync-loaders.js");
    const { createSyncAttentionController } = await import("../src/ui/sync-attention.js");
    let released = false;
    const entered = deferred();
    const deadline = deferred();
    const setTimer = globalThis.setTimeout;
    // Control only the controller's overall deadline; leave file-lock timers real.
    const timerSpy = vi.spyOn(globalThis, "setTimeout").mockImplementation(((
      fn: () => void,
      ms: number,
      ...args: unknown[]
    ) => {
      if (ms === 12345) {
        void deadline.promise.then(fn);
        return setTimer(() => undefined, 0);
      }
      return setTimer(fn, ms, ...args);
    }) as typeof setTimeout);
    const controller = createStartupCheck(
      createSyncLoaders({
        loadSyncInspection: async () => ({
          inspectSync: async (_config, _options, signal) => {
            entered.resolve();
            await new Promise<void>((resolve) =>
              signal?.addEventListener(
                "abort",
                () => {
                  released = true;
                  resolve();
                },
                { once: true },
              ),
            );
            signal?.throwIfAborted();
            throw new Error("unreachable");
          },
        }),
      }),
      createSyncAttentionController(),
      12345,
    );
    const context = createMockContext({ mode: "rpc" });
    const completion = observeCheckCompletion(context.ctx);
    try {
      controller.start(context.ctx, new AbortController().signal);
      await entered.promise;
      deadline.resolve();
      await completion.completed;
      assert.equal(released, true);
      assert.equal(context.notifications.length, 1);
      assert.match(context.notifications[0]?.message ?? "", /timed out.*\/sync status/u);
    } finally {
      await controller.stop();
      timerSpy.mockRestore();
    }
  });
});

test("recovery completes before startup or foreground mutations become available", async () => {
  await configured(async (agentDir) => {
    const { default: sync } = await import("../src/sync-extension.js");
    const directory = path.join(agentDir, "pi-sync/transactions/interrupted");
    const target = path.join(agentDir, "AGENTS.md");
    await fs.mkdir(path.join(directory, "before"), { recursive: true });
    await fs.writeFile(path.join(directory, "before/0"), "original instructions");
    await fs.writeFile(target, "interrupted instructions");
    await fs.writeFile(
      path.join(directory, "journal.json"),
      JSON.stringify({
        version: 2,
        root: agentDir,
        entries: [
          {
            target,
            backupName: "0",
            kind: "file",
            beforeImage: `file:${createHash("sha256").update("original instructions").digest("hex")}`,
            afterImage: `file:${createHash("sha256").update("interrupted instructions").digest("hex")}`,
            postFiles: [],
          },
        ],
      }),
    );
    const gate = await initializationGate(agentDir);
    let mutations = 0;
    const mock = createMockPi();
    sync(mock.pi, {
      loadSyncOperations: async () =>
        ({
          push: async () => {
            assert.equal(await fs.readFile(target, "utf8"), "original instructions");
            mutations++;
          },
        }) as never,
      loadSyncInspection: async () => ({ inspectSync: (config) => inspectionFixture(config) }),
    });
    const context = createMockContext({ mode: "rpc" });
    const startup = mock.events.get("session_start")?.[0]?.({}, context.ctx);
    try {
      await gate.initializing;
      const command = mock.commands.get("sync")?.handler("push --yes", context.ctx);
      assert.equal(mutations, 0);
      gate.release();
      await startup;
      await command;
      assert.equal(mutations, 1);
      await assert.rejects(fs.access(directory), { code: "ENOENT" });
    } finally {
      gate.release();
      await startup;
      await mock.events.get("session_shutdown")?.[0]?.({ reason: "reload" }, context.ctx);
      await gate.close();
    }
  });
});

for (const owner of [process.pid, 2147483647]) {
  test(`background checking never removes an existing lock owned by ${owner === process.pid ? "a live process" : "a stopped process"}`, async () => {
    await configured(async (agentDir) => {
      const { default: sync } = await import("../src/sync-extension.js");
      await fs.mkdir(path.join(agentDir, "pi-sync"), { recursive: true });
      const bytes = JSON.stringify({
        id: "other-owner",
        pid: owner,
        command: "push",
        startedAt: new Date().toISOString(),
      });
      await fs.writeFile(lockPath(), bytes);
      const storage = await new MockWebDavServer().start();
      const settings = v3WebDavSettings({ automatic: true });
      settings.storageConnections.dav.url = storage.url;
      await fs.writeFile(localConfigPath(), JSON.stringify(settings));
      const mock = createMockPi();
      sync(mock.pi);
      const context = createMockContext({ mode: "rpc" });
      const completion = observeCheckCompletion(context.ctx);
      await mock.events.get("session_start")?.[0]?.({}, context.ctx);
      await completion.completed;
      assert.equal(storage.requests.length, 0);
      assert.equal(await fs.readFile(lockPath(), "utf8"), bytes);
      assert.match(context.notifications.at(-1)?.message ?? "", /startup check skipped/u);
      await mock.events.get("session_shutdown")?.[0]?.({ reason: "reload" }, context.ctx);
      await storage.close();
    });
  });
}

test("state migration refuses an active legacy user and succeeds after its guard drains", async () => {
  await withTempHome(async (agentDir) => {
    await fs.mkdir(path.join(agentDir, ".pisync"), { recursive: true });
    await fs.writeFile(localConfigPath(), JSON.stringify(v3S3Settings({ automatic: true })));
    const entered = deferred();
    const release = deferred();
    const holder = withStateDirectoryAccess(async () => {
      entered.resolve();
      await release.promise;
    });
    await entered.promise;
    const { default: sync } = await import("../src/sync-extension.js");
    const mock = createMockPi();
    sync(mock.pi);
    const context = createMockContext({ mode: "rpc" });
    contextUi(context.ctx).confirm = async () => true;
    try {
      await mock.events.get("session_start")?.[0]?.({}, context.ctx);
      await mock.commands.get("sync")?.handler("migrate-state --yes", context.ctx);
      await fs.access(path.join(agentDir, ".pisync"));
      await assert.rejects(fs.access(path.join(agentDir, "pi-sync")), { code: "ENOENT" });
      assert.ok(context.notifications.some((item) => /migration was deferred/u.test(item.message)));
      release.resolve();
      await holder;
      await mock.commands.get("sync")?.handler("migrate-state --yes", context.ctx);
      await assert.rejects(fs.access(path.join(agentDir, ".pisync")), { code: "ENOENT" });
      await fs.access(path.join(agentDir, "pi-sync"));
      assert.ok(context.notifications.some((item) => /Migrated pi-sync state/u.test(item.message)));
    } finally {
      release.resolve();
      await holder;
      await mock.events.get("session_shutdown")?.[0]?.({ reason: "reload" }, context.ctx);
    }
  });
});

test("failed recovery blocks checks, foreground mutations, and shutdown publication", async () => {
  await configured(async (agentDir) => {
    const { default: sync } = await import("../src/sync-extension.js");
    const journal = path.join(agentDir, "pi-sync", "transactions", "interrupted");
    await fs.mkdir(journal, { recursive: true });
    await fs.writeFile(path.join(journal, "journal.json"), "{broken");
    let loads = 0;
    const forbidden = async (): Promise<never> => {
      loads++;
      throw new Error("must not run");
    };
    const mock = createMockPi();
    sync(mock.pi, { loadSyncInspection: forbidden, loadSyncOperations: forbidden });
    const context = createMockContext({ mode: "rpc" });
    await mock.events.get("session_start")?.[0]?.({}, context.ctx);
    await mock.commands.get("sync")?.handler("push --yes", context.ctx);
    await mock.events.get("session_shutdown")?.[0]?.({ reason: "quit" }, context.ctx);
    assert.equal(loads, 0);
    assert.match(context.notifications.map((n) => n.message).join("\n"), /recovery required/u);
    assert.equal(await fs.readFile(path.join(journal, "journal.json"), "utf8"), "{broken");
  });
});

test("startup settings read waits for an ordered save and observes its durable Off value", async () => {
  await configured(async () => {
    const { default: sync } = await import("../src/sync-extension.js");
    const saving = deferred();
    const release = deferred();
    let loads = 0;
    await withConfigReplacementInstalledHookForTest(
      async () => {
        saving.resolve();
        await release.promise;
      },
      async () => {
        const save = updateLocalConfig((raw) => {
          const settings = raw as unknown as ReturnType<typeof v3S3Settings>;
          settings.syncSetups.home.sync.automatic = false;
          return raw;
        });
        await saving.promise;
        const mock = createMockPi();
        sync(mock.pi, {
          loadSyncInspection: async () => {
            loads++;
            throw new Error("Off should not load");
          },
        });
        const context = createMockContext({ mode: "rpc" });
        const startup = mock.events.get("session_start")?.[0]?.({}, context.ctx);
        release.resolve();
        await save;
        await startup;
        await mock.events.get("session_shutdown")?.[0]?.({ reason: "reload" }, context.ctx);
        assert.equal(loads, 0);
        installEngineFixtureHost();
        assert.equal((await loadConfig()).automatic, false);
      },
    );
  });
});
