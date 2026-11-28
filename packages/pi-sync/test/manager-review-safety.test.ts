import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { syncBoth } from "@narumitw/pi-sync-daemon/engine/sync/sync-operations";
import { test } from "vitest";
import { createMockContext } from "../../../test/support.js";
import { executeCommand } from "../src/commands/command-execution.js";
import { loadConfig, syncCheckConfigFingerprint } from "../src/settings/config.js";
import { localConfigPath } from "../src/settings/config-file.js";
import { updateLocalConfig } from "../src/settings/settings-store.js";
import type { PiSyncSettingsV3 } from "../src/settings/settings-types.js";
import { writeStateForConfig } from "../src/state/sync-state-store.js";
import { createSyncLoaders } from "../src/sync/sync-loaders.js";
import type { DirectionalIntent } from "../src/ui/cancellable-operation.js";
import { showSyncManager } from "../src/ui/manager-ui.js";
import { v3S3Settings, withTempHome } from "./helpers.js";
import { MemorySyncBackend } from "./memory-sync-backend.js";

initTheme("dark", false);

const setupActions = [
  ["Sync now", "sync"],
  ["Pull from remote", "pull"],
  ["Push to remote", "push"],
  ["View differences", "diff"],
  ["History", "history"],
  ["Review unresolved conflicts", "conflicts"],
  ["Settings", undefined],
] as const;

async function configured(run: (agentDir: string) => Promise<void>) {
  await withTempHome(async (agentDir) => {
    mkdirSync(agentDir, { recursive: true });
    const settings = v3S3Settings() as PiSyncSettingsV3;
    settings.syncSetups.work = {
      storage: { connection: "r2", bucket: "pi-sync-test", path: "pi-sync/work" },
      sync: { include: ["settings.json"], automatic: false, agentMode: true },
    };
    writeFileSync(localConfigPath(), JSON.stringify(settings), { mode: 0o600 });
    await run(agentDir);
  });
}

async function exposeAction(label: string) {
  if (label === "Review unresolved conflicts")
    await writeStateForConfig(await loadConfig("home"), {
      version: 2,
      profile: "home",
      lastFileHashes: {},
      unresolved: [{ paths: ["settings.json"], artifact: "fixture" }],
    });
}

for (const mode of ["tui", "rpc"] as const) {
  for (const [label] of setupActions) {
    test(`${mode} manager refuses stale ${label} after active setup A becomes B`, async () => {
      await configured(async () => {
        await exposeAction(label);
        const owner = new AbortController();
        const frames: string[] = [];
        let confirmations = 0;
        const context = createMockContext({
          mode,
          select: async (title: string) => {
            frames.push(title);
            if (frames.length > 1) return undefined;
            await updateLocalConfig((settings) => ({ ...settings, activeSyncSetup: "work" }));
            return label;
          },
          confirm: async () => {
            confirmations += 1;
            return true;
          },
        });
        const routes: string[] = [];
        await showSyncManager(
          context.ctx,
          async (route) => {
            routes.push(route);
            return { kind: "completed" };
          },
          owner.signal,
        );
        assert.deepEqual(routes, []);
        assert.equal(confirmations, 0);
        assert.equal(frames.length, 2);
        const setupLine = mode === "tui" ? "Manage sync · " : "Current sync setup: ";
        assert.ok(frames[0]?.includes(`${setupLine}home\n`));
        assert.ok(frames[1]?.includes(`${setupLine}work\n`));
        assert.match(context.notifications.at(-1)?.message ?? "", /Sync setup changed while the manager was open/u);
        assert.equal((await loadConfig()).setupName, "work");
      });
    });
  }
}

for (const [label, route] of setupActions) {
  if (!route) continue;
  test(`unchanged ${label} dispatches the explicit reviewed setup`, async () => {
    await configured(async () => {
      await exposeAction(label);
      const choices: Array<string | undefined> = [label, undefined];
      const context = createMockContext({ mode: "rpc", select: async () => choices.shift() });
      const fingerprint = syncCheckConfigFingerprint(await loadConfig("home"));
      const calls: Array<{ route: string; setup?: string; retry?: boolean; directional?: DirectionalIntent }> = [];
      await showSyncManager(context.ctx, async (actualRoute, _signal, _commit, setup, _dialog, retry, directional) => {
        calls.push({ route: actualRoute, setup, retry, directional });
        return { kind: "completed", outcome: "cancelled" };
      });
      assert.deepEqual(calls, [
        {
          route,
          setup: "home",
          retry: label.startsWith("Retry") ? true : undefined,
          directional: route === "push" || route === "pull" ? { fingerprint, intent: "reject-conflicts" } : undefined,
        },
      ]);
    });
  });
}

for (const direction of ["push", "pull"] as const) {
  for (const stop of ["stale setup", "session replaced", "back"] as const) {
    test(`${direction} conflict does not schedule Force after ${stop}`, () =>
      configured(async () => {
        const owner = new AbortController();
        const label = direction === "push" ? "Push to remote" : "Pull from remote";
        const review = `Review Force ${direction}…`;
        const seen: string[][] = [];
        const context = createMockContext({
          mode: "rpc",
          select: async (_title: string, choices: string[]) => {
            seen.push(choices);
            if (seen.length === 1) return label;
            if (!choices.includes(review)) return undefined;
            if (stop === "back") return "Back";
            if (stop === "session replaced") owner.abort();
            else await updateLocalConfig((settings) => ({ ...settings, activeSyncSetup: "work" }));
            return review;
          },
        });
        const intents: Array<DirectionalIntent | undefined> = [];
        await showSyncManager(
          context.ctx,
          async (_route, _signal, _commit, _setup, _dialog, _retry, intent) => {
            intents.push(intent);
            return { kind: "destination-conflict" };
          },
          owner.signal,
        );
        assert.ok(seen.some((choices) => choices.includes(review)));
        assert.deepEqual(
          intents.map((intent) => intent?.intent),
          ["reject-conflicts"],
        );
      }));
  }
}

for (const change of ["automatic-transfer", "connection", "included-paths", "secret-scan"] as const) {
  test(`manager refuses changed ${change} even when the active setup name is unchanged`, async () => {
    await configured(async () => {
      let selected = false;
      const context = createMockContext({
        mode: "rpc",
        select: async () => {
          if (selected) return undefined;
          selected = true;
          await updateLocalConfig((settings) => {
            const setup = settings.syncSetups.home;
            const connection = settings.storageConnections.r2;
            assert.ok(setup && !setup.sync.scope && connection?.type === "s3");
            if (change === "secret-scan") return { ...settings, skipSecretScan: true };
            if (change === "connection")
              return {
                ...settings,
                storageConnections: {
                  ...settings.storageConnections,
                  r2: { ...connection, endpoint: "https://other.example" },
                },
              };
            return {
              ...settings,
              syncSetups: {
                ...settings.syncSetups,
                home: {
                  ...setup,
                  sync: {
                    ...setup.sync,
                    ...(change === "automatic-transfer" ? { automaticTransfer: true } : { include: ["AGENTS.md"] }),
                  },
                },
              },
            };
          });
          return "Sync now";
        },
      });
      let calls = 0;
      await showSyncManager(context.ctx, async () => {
        calls += 1;
      });
      assert.equal(calls, 0);
      assert.match(context.notifications.at(-1)?.message ?? "", /Review the refreshed setup/u);
    });
  });
}

test("changing an unrelated setup does not block the reviewed current setup", async () => {
  await configured(async () => {
    let selected = false;
    const context = createMockContext({
      mode: "rpc",
      select: async () => {
        if (selected) return undefined;
        selected = true;
        await updateLocalConfig((settings) => {
          const setup = settings.syncSetups.work;
          assert.ok(setup);
          return {
            ...settings,
            syncSetups: { ...settings.syncSetups, work: { ...setup, sync: { ...setup.sync, automatic: true } } },
          };
        });
        return "Sync now";
      },
    });
    const targets: Array<string | undefined> = [];
    await showSyncManager(context.ctx, async (_route, _signal, _commit, setup) => {
      targets.push(setup);
      return { kind: "completed" };
    });
    assert.deepEqual(targets, ["home"]);
    assert.deepEqual(context.notifications, []);
  });
});

test("a stale Sync now cannot reach real syncBoth or publish the new Agent-mode setup", async () => {
  await configured(async (agentDir) => {
    const localPath = path.join(agentDir, "settings.json");
    writeFileSync(localPath, '{"theme":"dark"}\n');
    const before = readFileSync(localPath);
    const backend = new MemorySyncBackend();
    let operations = 0;
    const loaders = createSyncLoaders({
      loadSyncOperations: async () =>
        ({
          syncBoth: async (ctx, options) => {
            operations += 1;
            return syncBoth(ctx, options, () => backend);
          },
        }) as Awaited<ReturnType<ReturnType<typeof createSyncLoaders>["operations"]>>,
    });
    let selected = false;
    const context = createMockContext({
      mode: "rpc",
      select: async () => {
        if (selected) return undefined;
        selected = true;
        await updateLocalConfig((settings) => ({ ...settings, activeSyncSetup: "work" }));
        return "Sync now";
      },
    });
    await showSyncManager(context.ctx, (route, signal, onCommit, setup) =>
      executeCommand(route, context.ctx, signal, loaders, onCommit, setup),
    );
    assert.equal(operations, 0);
    assert.equal(await backend.readHead(), undefined);
    assert.deepEqual(readFileSync(localPath), before);
  });
});
