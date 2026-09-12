import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { test, vi } from "vitest";
import { createMockContext } from "../../../test/support.js";
import type { SyncBackend } from "../src/backends/sync-backend.js";
import { handleCommand, resolveSelectionAttention } from "../src/commands/command-handler.js";
import { loadConfig, syncCheckConfigFingerprint } from "../src/settings/config.js";
import { localConfigPath } from "../src/settings/config-file.js";
import { withLock } from "../src/state/lock.js";
import { statePathForConfig, writeStateForConfig } from "../src/state/sync-state-store.js";
import { createSyncLoaders } from "../src/sync/sync-loaders.js";
import * as operations from "../src/sync/sync-operations.js";
import * as dispatcher from "../src/ui/manager-result-dispatcher.js";
import * as selectionReview from "../src/ui/remote-selection-ui.js";
import { createSyncAttentionController } from "../src/ui/sync-attention.js";
import { v3S3Settings, withTempHome } from "./helpers.js";
import { inspectionFixture } from "./startup-check-helpers.js";

async function fixture(agentDir: string) {
  await fs.mkdir(agentDir, { recursive: true });
  await fs.writeFile(localConfigPath(), JSON.stringify(v3S3Settings({ automatic: true })));
  const config = await loadConfig();
  const attention = createSyncAttentionController();
  const observation = {
    setupName: config.setupName,
    configIdentity: syncCheckConfigFingerprint(config),
    checkedAt: "2026-09-06T12:00:00.000Z",
    inspection: await inspectionFixture(config, { localChanged: true }),
  };
  attention.observe(observation);
  return { config, attention, observation };
}

test("cancelling a real push confirmation preserves the hint and all content without publication", async () => {
  await withTempHome(async (agentDir) => {
    const { config, attention, observation } = await fixture(agentDir);
    const settingsBefore = await fs.readFile(localConfigPath());
    const managedPath = path.join(agentDir, "settings.json");
    const managedBytes = '{"theme":"dark"}\n';
    await fs.writeFile(managedPath, managedBytes);
    let headReads = 0;
    let confirmations = 0;
    const forbidden = async (): Promise<never> => {
      throw new Error("must not publish or read payloads");
    };
    const backend: SyncBackend = {
      identity: "test",
      destination: "test",
      capability: "lease-protected",
      sameRevision: (left, right) => left === right,
      readHead: async () => {
        headReads++;
        return undefined;
      },
      readSnapshot: forbidden,
      publishSnapshot: forbidden,
      listHistory: forbidden,
      diagnose: forbidden,
    };
    const context = createMockContext({
      mode: "rpc",
      confirm: async () => {
        confirmations++;
        return false;
      },
    });
    await handleCommand(
      "push",
      context.ctx,
      new AbortController().signal,
      createSyncLoaders({
        loadSyncOperations: async () => ({
          ...operations,
          push: (ctx, options, input) => operations.push(ctx, options, input, async () => backend),
        }),
      }),
      attention,
    );
    assert.equal(headReads, 1);
    assert.equal(confirmations, 1);
    assert.equal(attention.observation(), observation);
    assert.equal(context.statuses.get("sync"), "local changes pending");
    assert.equal(context.widgets.get("sync:attention"), undefined);
    assert.deepEqual(await fs.readFile(localConfigPath()), settingsBefore);
    assert.equal(await fs.readFile(managedPath, "utf8"), managedBytes);
    await assert.rejects(fs.access(statePathForConfig(config)), { code: "ENOENT" });
  });
});

for (const route of ["sync", "push", "pull", "rollback snapshot"]) {
  for (const outcome of ["cancelled", "failed", "committed", "commit-failed"] as const) {
    test(`${route} ${outcome} invalidates startup observation only at commit`, async () => {
      await withTempHome(async (agentDir) => {
        const { attention, observation } = await fixture(agentDir);
        let runs = 0;
        const operation = async (_ctx: unknown, options: { onCommit?: () => void }) => {
          runs++;
          if (outcome.startsWith("commit")) options.onCommit?.();
          if (outcome.endsWith("failed")) throw new Error("controlled failure");
          return outcome === "cancelled" ? "cancelled" : "applied";
        };
        const loaders = createSyncLoaders({
          loadSyncOperations: async () =>
            ({
              syncBoth: operation,
              push: operation,
              pull: operation,
              rollback: operation,
            }) as never,
        });
        const context = createMockContext({ mode: "rpc" });
        await handleCommand(route, context.ctx, new AbortController().signal, loaders, attention);
        assert.equal(runs, 1);
        const committed = outcome.startsWith("commit");
        assert.equal(attention.observation(), committed ? undefined : observation);
        assert.equal(context.statuses.get("sync"), committed ? undefined : "local changes pending");
        assert.equal(context.widgets.get("sync:attention"), undefined);
      });
    });
  }
}

for (const route of ["init", "use home", "migrate-state --yes"]) {
  test(`${route} without a settings or state change preserves startup observation`, async () => {
    await withTempHome(async (agentDir) => {
      const { attention, observation } = await fixture(agentDir);
      const loaders = createSyncLoaders({
        loadSetupSwitch: async () => ({ useSyncSetup: async () => ({ pullApplied: false }) }),
      });
      await handleCommand(
        route,
        createMockContext({ mode: "rpc" }).ctx,
        new AbortController().signal,
        loaders,
        attention,
      );
      assert.equal(attention.observation(), observation);
    });
  });
}

test("a busy manager hides unavailable baseline data without discarding the stored observation", async () => {
  await withTempHome(async (agentDir) => {
    const { attention, observation } = await fixture(agentDir);
    const context = createMockContext({ mode: "rpc" });
    await withLock("other-operation", () =>
      handleCommand("", context.ctx, new AbortController().signal, createSyncLoaders({}), attention),
    );
    assert.equal(attention.observation(), observation);
    assert.equal(context.statuses.get("sync"), "local changes pending");
  });
});

for (const commit of [false, true]) {
  test(`direct selection recovery commit=${commit} preserves hints until commit and forwards the UI callback`, async () => {
    await withTempHome(async (agentDir) => {
      const { config, attention, observation } = await fixture(agentDir);
      attention.set(
        {
          setupName: config.setupName,
          configIdentity: "review-fixture",
          localInclude: config.include,
          remoteInclude: ["models.json"],
        },
        "push",
      );
      let uiCommits = 0;
      const dispatch = vi
        .spyOn(dispatcher, "dispatchManagerResult")
        .mockImplementation(async (_ctx, _result, _route, runRoute) => {
          await runRoute("push", undefined, () => uiCommits++);
          return { kind: "stay" };
        });
      try {
        await resolveSelectionAttention(
          createMockContext({ mode: "tui" }).ctx,
          attention,
          new AbortController().signal,
          createSyncLoaders({
            loadSyncOperations: async () =>
              ({
                push: async (_ctx: unknown, options: { onCommit?: () => void }) => {
                  if (commit) options.onCommit?.();
                  return "cancelled";
                },
              }) as never,
          }),
        );
        assert.equal(dispatch.mock.calls.length, 1);
        assert.equal(uiCommits, commit ? 1 : 0);
        assert.equal(attention.observation(), commit ? undefined : observation);
      } finally {
        dispatch.mockRestore();
      }
    });
  });
}

for (const mutation of ["none", "config", "baseline", "replacement"] as const) {
  test(`failed operation preserves observation unless ${mutation} invalidates it`, async () => {
    await withTempHome(async (agentDir) => {
      const { config, attention, observation } = await fixture(agentDir);
      const controller = new AbortController();
      const replacement = { ...observation, checkedAt: "2026-09-07T00:00:00.000Z" };
      const loaders = createSyncLoaders({
        loadSyncOperations: async () =>
          ({
            push: async (_ctx: unknown, options: { onCommit?: () => void }) => {
              if (mutation === "config")
                await fs.writeFile(localConfigPath(), JSON.stringify(v3S3Settings({ automatic: false })));
              if (mutation === "baseline")
                await writeStateForConfig(config, {
                  version: 2,
                  profile: config.snapshotIdentity,
                  lastAppliedSnapshot: "new",
                  lastFileHashes: {},
                });
              if (mutation === "replacement") {
                controller.abort();
                attention.observe(replacement);
                options.onCommit?.();
              }
              throw new Error("controlled failure");
            },
          }) as never,
      });
      await handleCommand("push", createMockContext({ mode: "rpc" }).ctx, controller.signal, loaders, attention);
      assert.equal(
        attention.observation(),
        mutation === "none" ? observation : mutation === "replacement" ? replacement : undefined,
      );
    });
  });
}

for (const exit of ["back", "closed", "stale", "failure", "config-changed"] as const) {
  test(`manager content review ${exit} retains only a still-valid startup observation`, async () => {
    await withTempHome(async (agentDir) => {
      const { attention, observation } = await fixture(agentDir);
      observation.inspection.selectionState = {
        kind: "different",
        include: ["models.json"],
        remoteOnly: ["models.json"],
        localOnly: ["settings.json"],
      };
      const before = await fs.readFile(localConfigPath());
      const review = vi.spyOn(selectionReview, "showRemoteSelectionReview").mockImplementation(async () => {
        if (exit === "failure") throw new Error("controlled review failure");
        if (exit === "config-changed")
          await fs.writeFile(localConfigPath(), JSON.stringify(v3S3Settings({ automatic: false })));
        return { kind: exit === "config-changed" ? "done" : exit };
      });
      const frames: string[] = [];
      const choices = ["Review synced content (recommended)", undefined];
      const context = createMockContext({
        mode: "tui",
        select: async (title: string) => {
          frames.push(title);
          return choices.shift();
        },
      });
      try {
        await handleCommand("", context.ctx, new AbortController().signal, createSyncLoaders({}), attention);
        assert.equal(review.mock.calls.length, 1);
        assert.match(frames.join("\n"), /Review synced content/u);
        assert.equal(attention.observation(), exit === "config-changed" ? undefined : observation);
        if (exit !== "config-changed") assert.deepEqual(await fs.readFile(localConfigPath()), before);
      } finally {
        review.mockRestore();
      }
    });
  });
}
