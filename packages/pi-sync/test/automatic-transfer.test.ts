import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { test, vi } from "vitest";
import { createMockContext, createMockPi } from "../../../test/support.js";
import { loadConfig } from "../src/settings/config.js";
import { localConfigPath } from "../src/settings/config-file.js";
import { updateSyncSetup } from "../src/settings/settings-management.js";
import { readLocalConfigObject } from "../src/settings/settings-store.js";

let sync: typeof import("../src/sync-extension.js")["default"];

import { withPiDaemonClient } from "../src/daemon/pi-client.js";
import { adoptFixtureRoot } from "./daemon-test-helpers.js";
import { v3S3Settings, withTempHome } from "./helpers.js";
import { contextUi, deferred, inspectionFixture, observeCheckCompletion } from "./startup-check-helpers.js";

async function configure(agentDir: string, daemon = false) {
  await fs.mkdir(agentDir, { recursive: true });
  const settings = v3S3Settings({ automatic: false });
  Object.assign(settings.syncSetups.home.sync, { automaticTransfer: true, futurePolicy: { keep: true } });
  await fs.writeFile(localConfigPath(), JSON.stringify(settings));
  await fs.writeFile(path.join(agentDir, "settings.json"), "{}\n");
  sync = (await import("../src/sync-extension.js")).default;
  if (daemon) await adoptFixtureRoot(agentDir);
}

for (const mode of ["tui", "rpc", "print", "json"] as const)
  test(`automatic-transfer ${mode} is explicit and never opens a modal`, async () =>
    withTempHome(async (agentDir) => {
      await configure(agentDir, true);
      const mock = createMockPi();
      let transfers = 0;
      sync(mock.pi, {
        loadSyncInspection: async () => ({ inspectSync: (config) => inspectionFixture(config) }),
        loadSyncOperations: async () => ({
          ...(await import("@narumitw/pi-sync-daemon/engine/sync/sync-operations")),
          syncBoth: async (_ctx, options) => {
            assert.equal(options.auto, true);
            assert.equal(options.yes, true);
            assert.equal(options.reload, false);
            transfers++;
            return "applied";
          },
        }),
      });
      const context = createMockContext({ mode });
      const done = observeCheckCompletion(context.ctx);
      const confirm = vi.spyOn(contextUi(context.ctx), "confirm");
      const custom = vi.spyOn(contextUi(context.ctx), "custom");
      await mock.events.get("session_start")?.[0]?.({}, context.ctx);
      if (mode === "tui" || mode === "rpc") await done.completed;
      await mock.events.get("session_shutdown")?.[0]?.({ reason: "reload" }, context.ctx);
      assert.equal(transfers, mode === "tui" || mode === "rpc" ? 1 : 0);
      assert.equal(confirm.mock.calls.length, 0);
      assert.equal(custom.mock.calls.length, 0);
      confirm.mockRestore();
      custom.mockRestore();
    }));

test("busy startup queues one attempt until agent_settled, not agent_end", async () =>
  withTempHome(async (agentDir) => {
    await configure(agentDir, true);
    const mock = createMockPi();
    let idle = false;
    let inspections = 0;
    let transfers = 0;
    sync(mock.pi, {
      loadSyncInspection: async () => ({
        inspectSync: async (config) => {
          inspections++;
          return inspectionFixture(config);
        },
      }),
      loadSyncOperations: async () => ({
        ...(await import("@narumitw/pi-sync-daemon/engine/sync/sync-operations")),
        syncBoth: async () => {
          transfers++;
          return "applied";
        },
      }),
    });
    const context = createMockContext({ mode: "rpc", isIdle: () => idle });
    const done = observeCheckCompletion(context.ctx);
    await mock.events.get("session_start")?.[0]?.({}, context.ctx);
    assert.equal(inspections, 0);
    assert.equal(mock.events.get("agent_end"), undefined);
    idle = true;
    await mock.events.get("agent_settled")?.[0]?.({}, context.ctx);
    await done.completed;
    await mock.events.get("agent_settled")?.[0]?.({}, context.ctx);
    assert.equal(inspections, 1);
    assert.equal(transfers, 1);
    await mock.events.get("session_shutdown")?.[0]?.({ reason: "reload" }, context.ctx);
  }));

for (const event of ["foreground", "agent_start", "replacement", "shutdown"] as const)
  test(`${event} cancels and drains automatic work before continuing`, async () =>
    withTempHome(async (agentDir) => {
      await configure(agentDir, true);
      const mock = createMockPi();
      const entered = deferred();
      const aborted = deferred();
      const cleanup = deferred();
      sync(mock.pi, {
        loadSyncInspection: async () => ({ inspectSync: (config) => inspectionFixture(config) }),
        loadSyncOperations: async () => ({
          ...(await import("@narumitw/pi-sync-daemon/engine/sync/sync-operations")),
          syncBoth: async (_ctx, options) => {
            entered.resolve();
            await new Promise<void>((resolve) =>
              options.signal?.addEventListener(
                "abort",
                () => {
                  aborted.resolve();
                  resolve();
                },
                { once: true },
              ),
            );
            await cleanup.promise;
            return "cancelled";
          },
        }),
      });
      const context = createMockContext({ mode: "rpc" });
      await mock.events.get("session_start")?.[0]?.({}, context.ctx);
      await entered.promise;
      let completed = false;
      const next =
        event === "foreground"
          ? mock.commands.get("sync")?.handler("help", context.ctx)
          : mock.events.get(
              event === "replacement" ? "session_start" : event === "shutdown" ? "session_shutdown" : "agent_start",
            )?.[0]?.({ reason: "reload" }, context.ctx);
      const drain = Promise.resolve(next).then(() => {
        completed = true;
      });
      await aborted.promise;
      assert.equal(completed, false);
      if (event === "replacement")
        await withPiDaemonClient(context.ctx, () =>
          updateSyncSetup("home", (setup) => ({ ...setup, sync: { ...setup.sync, automaticTransfer: false } })),
        );
      cleanup.resolve();
      await drain;
      assert.equal(context.statuses.get("sync"), undefined, "cancellation clears progress before shutdown");
      await mock.events.get("session_shutdown")?.[0]?.({ reason: "reload" }, context.ctx);
      assert.equal(context.statuses.get("sync"), undefined);
    }));

for (const mode of ["tui", "rpc"] as const)
  for (const cancellation of ["stop", "interrupt", "replaced-session"] as const)
    test(`${mode} ${cancellation} clears only owned progress without publishing stale attention`, async () =>
      withTempHome(async (agentDir) => {
        await configure(agentDir);
        const { createStartupCheck } = await import("../src/sync/startup-check.js");
        const { createSyncLoaders } = await import("../src/sync/sync-loaders.js");
        const { createSyncAttentionController } = await import("../src/ui/sync-attention.js");
        const entered = deferred();
        const attention = createSyncAttentionController();
        const publish = vi.spyOn(attention, "publish");
        const controller = createStartupCheck(
          createSyncLoaders({
            loadSyncInspection: async () => ({ inspectSync: (config) => inspectionFixture(config) }),
            loadSyncOperations: async () => ({
              ...(await import("@narumitw/pi-sync-daemon/engine/sync/sync-operations")),
              syncBoth: async (_ctx, options) => {
                entered.resolve();
                await new Promise<void>((resolve) =>
                  options.signal?.addEventListener("abort", () => resolve(), { once: true }),
                );
                return "cancelled" as const;
              },
            }),
          }),
          attention,
        );
        const context = createMockContext({ mode });
        const session = new AbortController();
        controller.start(context.ctx, session.signal, await loadConfig());
        await entered.promise;
        assert.equal(context.statuses.get("sync"), "sync ...");
        if (cancellation === "replaced-session") {
          session.abort();
          contextUi(context.ctx).setStatus("sync", "replacement-owned status");
        }
        if (cancellation === "interrupt") await controller.interrupt(context.ctx);
        else await controller.stop();
        assert.equal(publish.mock.calls.length, 0);
        assert.equal(context.widgets.get("sync:attention"), undefined);
        assert.equal(context.notifications.length, 0);
        assert.equal(
          context.statuses.get("sync"),
          cancellation === "replaced-session" ? "replacement-owned status" : undefined,
        );
      }));

for (const mode of ["tui", "rpc"] as const)
  for (const mutation of ["selection", "missing", "invalid"] as const)
    for (const phase of ["loader", "failure", "success"] as const)
      test(`${mode} ${mutation} settings at ${phase} invalidate captured automatic attention`, async () =>
        withTempHome(async (agentDir) => {
          await configure(agentDir);
          const { createStartupCheck } = await import("../src/sync/startup-check.js");
          const { createSyncLoaders } = await import("../src/sync/sync-loaders.js");
          const { createSyncAttentionController } = await import("../src/ui/sync-attention.js");
          const attention = createSyncAttentionController();
          const finished = deferred();
          let changed = false;
          const originalPublish = attention.publish.bind(attention);
          const publish = vi.spyOn(attention, "publish").mockImplementation(async (...args) => {
            await originalPublish(...args);
            if (changed) finished.resolve();
          });
          const context = createMockContext({ mode });
          const invalidate = async () => {
            assert.ok(attention.observation(), "observation was captured before settings changed");
            // Model an existing presentation too, not just a never-published observation.
            await attention.publish(context.ctx);
            publish.mockClear();
            assert.ok(context.statuses.get("sync"));
            if (mutation === "missing") await fs.rm(localConfigPath());
            else if (mutation === "invalid") await fs.writeFile(localConfigPath(), "{broken");
            else {
              const settings = JSON.parse(await fs.readFile(localConfigPath(), "utf8"));
              settings.syncSetups.home.sync.include = ["AGENTS.md"];
              await fs.writeFile(localConfigPath(), JSON.stringify(settings));
            }
            changed = true;
          };
          const controller = createStartupCheck(
            createSyncLoaders({
              loadSyncInspection: async () => ({
                inspectSync: (config) => inspectionFixture(config, { localChanged: true, remoteChanged: true }),
              }),
              loadSyncOperations: async () => {
                if (phase === "loader") {
                  await invalidate();
                  throw new Error("settings changed during loading");
                }
                return {
                  ...(await import("@narumitw/pi-sync-daemon/engine/sync/sync-operations")),
                  syncBoth: async () => {
                    await invalidate();
                    if (phase === "failure") throw new Error("settings changed before commit");
                    return "cancelled" as const;
                  },
                };
              },
            }),
            attention,
          );
          const originalReset = attention.reset.bind(attention);
          vi.spyOn(attention, "reset").mockImplementation((ctx) => {
            originalReset(ctx);
            finished.resolve();
          });
          controller.start(context.ctx, new AbortController().signal, await loadConfig());
          await finished.promise;
          await controller.stop();
          assert.equal(attention.observation(), undefined);
          assert.equal(publish.mock.calls.length, 0);
          assert.equal(context.statuses.get("sync"), undefined);
          assert.equal(context.widgets.get("sync:attention"), undefined);
          assert.equal(context.notifications.length, 0);
        }));

for (const cancellation of ["stop", "replacement"] as const)
  test(`${cancellation} during final settings validation prevents stale publication`, async () =>
    withTempHome(async (agentDir) => {
      await configure(agentDir);
      const { createStartupCheck } = await import("../src/sync/startup-check.js");
      const { createSyncLoaders } = await import("../src/sync/sync-loaders.js");
      const { createSyncAttentionController } = await import("../src/ui/sync-attention.js");
      const attention = createSyncAttentionController();
      const publish = vi.spyOn(attention, "publish");
      const reset = vi.spyOn(attention, "reset");
      const entered = deferred();
      const release = deferred();
      let finalizing = false;
      const open = fs.open.bind(fs);
      const read = vi.spyOn(fs, "open").mockImplementation(async (...args) => {
        if (finalizing && args[0] === localConfigPath()) {
          finalizing = false;
          entered.resolve();
          await release.promise;
        }
        return open(...args);
      });
      const controller = createStartupCheck(
        createSyncLoaders({
          loadSyncInspection: async () => ({ inspectSync: (config) => inspectionFixture(config) }),
          loadSyncOperations: async () => ({
            ...(await import("@narumitw/pi-sync-daemon/engine/sync/sync-operations")),
            syncBoth: async () => {
              finalizing = true;
              return "cancelled" as const;
            },
          }),
        }),
        attention,
      );
      const context = createMockContext({ mode: "rpc" });
      const session = new AbortController();
      try {
        controller.start(context.ctx, session.signal, await loadConfig());
        await entered.promise;
        if (cancellation === "replacement") {
          session.abort();
          contextUi(context.ctx).setStatus("sync", "replacement-owned status");
        }
        const stopped = controller.stop();
        release.resolve();
        await stopped;
        assert.equal(publish.mock.calls.length, 0);
        assert.equal(reset.mock.calls.length, 0);
        assert.equal(
          context.statuses.get("sync"),
          cancellation === "replacement" ? "replacement-owned status" : undefined,
        );
      } finally {
        release.resolve();
        await controller.stop();
        read.mockRestore();
      }
    }));

for (const committed of [false, true])
  test(`automatic transfer failure ${committed ? "after" : "before"} commit preserves only current attention`, async () =>
    withTempHome(async (agentDir) => {
      await configure(agentDir);
      const { createStartupCheck } = await import("../src/sync/startup-check.js");
      const { createSyncLoaders } = await import("../src/sync/sync-loaders.js");
      const { createSyncAttentionController } = await import("../src/ui/sync-attention.js");
      const attention = createSyncAttentionController();
      const clear = vi.spyOn(attention, "clearObservation");
      const completed = deferred();
      const publish = vi.spyOn(attention, "publish").mockImplementation(async () => {
        completed.resolve();
      });
      const controller = createStartupCheck(
        createSyncLoaders({
          loadSyncInspection: async () => ({ inspectSync: (config) => inspectionFixture(config) }),
          loadSyncOperations: async () => ({
            ...(await import("@narumitw/pi-sync-daemon/engine/sync/sync-operations")),
            syncBoth: async (_ctx, options) => {
              if (committed) options.onCommit?.();
              throw new Error("injected transfer failure");
            },
          }),
        }),
        attention,
      );
      const context = createMockContext({ mode: "rpc" });
      controller.start(context.ctx, new AbortController().signal, await loadConfig());
      await completed.promise;
      await controller.stop();
      assert.equal(clear.mock.calls.length, committed ? 1 : 0);
      assert.equal(attention.observation() === undefined, committed);
      assert.equal(publish.mock.calls.length, 1);
      assert.ok(context.notifications.some((item) => /injected transfer failure/.test(item.message)));
    }));

test("turning off a queued policy before idle performs no transfer", async () =>
  withTempHome(async (agentDir) => {
    await configure(agentDir, true);
    const mock = createMockPi();
    let idle = false;
    let transfers = 0;
    sync(mock.pi, {
      loadSyncInspection: async () => ({ inspectSync: (config) => inspectionFixture(config) }),
      loadSyncOperations: async () => {
        transfers++;
        throw new Error("must not load");
      },
    });
    const context = createMockContext({ mode: "rpc", isIdle: () => idle });
    await mock.events.get("session_start")?.[0]?.({}, context.ctx);
    await withPiDaemonClient(context.ctx, () =>
      updateSyncSetup("home", (setup) => ({ ...setup, sync: { ...setup.sync, automaticTransfer: false } })),
    );
    idle = true;
    const done = observeCheckCompletion(context.ctx);
    await mock.events.get("agent_settled")?.[0]?.({}, context.ctx);
    await done.completed;
    await mock.events.get("session_shutdown")?.[0]?.({ reason: "reload" }, context.ctx);
    assert.equal(transfers, 0);
  }));

for (const mode of ["tui", "rpc"] as const)
  for (const automaticTransfer of [false, true])
    for (const change of ["none", "local", "remote"] as const)
      test(`${mode} legacy ${change} observation with transfer=${automaticTransfer} explains its review barrier`, async () =>
        withTempHome(async (agentDir) => {
          await configure(agentDir, true);
          const settings = JSON.parse(await fs.readFile(localConfigPath(), "utf8"));
          settings.syncSetups.home.sync.automatic = true;
          settings.syncSetups.home.sync.automaticTransfer = automaticTransfer;
          await fs.writeFile(localConfigPath(), JSON.stringify(settings));
          const mock = createMockPi();
          let transfers = 0;
          sync(mock.pi, {
            loadSyncInspection: async () => ({
              inspectSync: (config) =>
                inspectionFixture(config, {
                  selectionState: { kind: "legacy", discovered: [] },
                  localChanged: change === "local",
                  remoteChanged: change === "remote",
                }),
            }),
            loadSyncOperations: async () => {
              transfers++;
              throw new Error("Legacy automatic transfer must not run");
            },
          });
          const context = createMockContext({ mode });
          const done = observeCheckCompletion(context.ctx);
          await mock.events.get("session_start")?.[0]?.({}, context.ctx);
          await done.completed;
          assert.equal(transfers, 0);
          assert.equal(context.statuses.get("sync") === "sync ⇕", automaticTransfer);
          assert.equal(
            typeof context.widgets.get("sync:attention") === "function",
            automaticTransfer && mode === "tui",
          );
          assert.equal(
            context.notifications.some((item) => /explicit direction.*adopt policy/.test(item.message)),
            automaticTransfer && mode === "rpc",
          );
          await mock.events.get("session_shutdown")?.[0]?.({ reason: "reload" }, context.ctx);
        }));

for (const barrier of ["firstSync", "missingRemote", "selection"] as const)
  test(`${barrier} remains a startup review barrier`, async () =>
    withTempHome(async (agentDir) => {
      await configure(agentDir, true);
      const mock = createMockPi();
      let transfers = 0;
      sync(mock.pi, {
        loadSyncInspection: async () => ({
          inspectSync: (config) =>
            inspectionFixture(
              config,
              barrier === "firstSync"
                ? { firstSync: true }
                : barrier === "missingRemote"
                  ? { head: undefined }
                  : {
                      selectionState: {
                        kind: "different",
                        include: ["AGENTS.md"],
                        remoteOnly: ["AGENTS.md"],
                        localOnly: ["settings.json"],
                      },
                    },
            ),
        }),
        loadSyncOperations: async () => {
          transfers++;
          throw new Error("must not load");
        },
      });
      const context = createMockContext({ mode: "rpc" });
      const done = observeCheckCompletion(context.ctx);
      await mock.events.get("session_start")?.[0]?.({}, context.ctx);
      await done.completed;
      assert.equal(transfers, 0);
      assert.ok(context.notifications.some((item) => /review|baseline|missing/i.test(item.message)));
      await mock.events.get("session_shutdown")?.[0]?.({ reason: "reload" }, context.ctx);
    }));

test("automatic-transfer writes are validated, ordered, private and preserve unknown policy", async () =>
  withTempHome(async (agentDir) => {
    await configure(agentDir);
    const first = updateSyncSetup("home", (setup) => ({ ...setup, sync: { ...setup.sync, automaticTransfer: false } }));
    const second = updateSyncSetup("home", (setup) => ({ ...setup, sync: { ...setup.sync, automaticTransfer: true } }));
    await Promise.all([first, second]);
    assert.equal((await loadConfig()).automaticTransfer, true);
    assert.deepEqual((await readLocalConfigObject())?.syncSetups.home?.sync.futurePolicy, { keep: true });
    const before = await fs.readFile(localConfigPath());
    await assert.rejects(
      updateSyncSetup("home", (setup) => ({
        ...setup,
        sync: { ...setup.sync, automaticTransfer: "yes" as unknown as boolean },
      })),
      /must be boolean/,
    );
    assert.deepEqual(await fs.readFile(localConfigPath()), before);
    if (process.platform !== "win32") assert.equal((await fs.stat(localConfigPath())).mode & 0o777, 0o600);
  }));
