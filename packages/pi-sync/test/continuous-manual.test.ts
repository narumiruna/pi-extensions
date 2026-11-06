import assert from "node:assert/strict";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { test } from "vitest";
import { handleCommand } from "../src/commands/command-handler.js";
import { createSyncLoaders } from "../src/sync/sync-loaders.js";
import { createSyncAttentionController } from "../src/ui/sync-attention.js";
import { agentContext, selectRemote } from "./agent-test-helpers.js";
import { enableContinuous } from "./continuous-test-helpers.js";
import { withTempHome } from "./helpers.js";
import { createMergeFixture } from "./merged-sync-fixture.js";

for (const route of ["sync", "sync --invalid-flag", "status", "sync --setup other"])
  test(`only validated explicit sync routes request background retry: ${route}`, async () =>
    withTempHome(async (agentDir) => {
      await createMergeFixture(agentDir);
      await enableContinuous();
      const retried: (string | undefined)[] = [];
      const mock = agentContext(selectRemote);
      const loaders = createSyncLoaders({
        loadSyncOperations: async () => ({
          ...(await import("../src/sync/sync-operations.js")),
          syncBoth: async () => "applied" as const,
          status: async () => {},
        }),
      });
      await handleCommand(
        route,
        mock.ctx as ExtensionCommandContext,
        new AbortController().signal,
        loaders,
        createSyncAttentionController(),
        (setup) => retried.push(setup),
      );
      assert.deepEqual(retried, route === "sync" ? [undefined] : route === "sync --setup other" ? ["other"] : []);
      assert.equal(mock.requests.length, 0);
    }));

test("Sync now in the manager uses the same explicit retry boundary", async () =>
  withTempHome(async (agentDir) => {
    await createMergeFixture(agentDir);
    await enableContinuous();
    let selected = false;
    const mock = agentContext(selectRemote, {
      select: async () => {
        if (selected) return undefined;
        selected = true;
        return "Sync now";
      },
    });
    const retried: (string | undefined)[] = [];
    const loaders = createSyncLoaders({
      loadSyncOperations: async () => ({
        ...(await import("../src/sync/sync-operations.js")),
        syncBoth: async () => "applied" as const,
      }),
    });
    await handleCommand(
      "",
      mock.ctx as ExtensionCommandContext,
      new AbortController().signal,
      loaders,
      createSyncAttentionController(),
      (setup) => retried.push(setup),
    );
    assert.deepEqual(retried, ["home"]);
    assert.equal(mock.requests.length, 0);
  }));
