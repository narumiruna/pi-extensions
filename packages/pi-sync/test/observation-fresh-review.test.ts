import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { type ExtensionCommandContext, initTheme } from "@earendil-works/pi-coding-agent";
import { createTuiHarness } from "@narumitw/pi-tui-kit/testing";
import { test, vi } from "vitest";
import { createMockContext as createBaseContext } from "../../../test/support.js";
import * as backendFactory from "../src/backends/backend-factory.js";
import { handleCommand } from "../src/commands/command-handler.js";
import { loadConfig, syncCheckConfigFingerprint, syncConfigReviewFingerprint } from "../src/settings/config.js";
import { localConfigPath } from "../src/settings/config-file.js";
import { statePathForConfig, writeStateForConfig } from "../src/state/sync-state-store.js";
import { createSyncLoaders } from "../src/sync/sync-loaders.js";
import { showRemoteSelectionReview } from "../src/ui/remote-selection-ui.js";
import { createSyncAttentionController } from "../src/ui/sync-attention.js";
import { snapshot, v3S3Settings, withTempHome } from "./helpers.js";
import { MemorySyncBackend } from "./memory-sync-backend.js";
import { inspectionFixture } from "./startup-check-helpers.js";

initTheme("dark", false);

// Run asynchronous work owners once; the general selector mock accepts only
// synchronous menu factories and cannot dispose or drain a work component.
function createMockContext(overrides: {
  mode: "tui" | "rpc";
  select?: (title: string) => Promise<string | undefined>;
}) {
  const context = createBaseContext(overrides);
  if (overrides.mode !== "tui") return context;
  (context.ctx as ExtensionCommandContext).ui.custom = async (factory, options) => {
    const tui = createTuiHarness({ width: 100, rows: 24 });
    try {
      const pending = tui.custom(factory, options);
      try {
        await tui.waitForOpen();
      } catch (error) {
        if (error instanceof Error && error.message === "TUI custom component settled before opening")
          return await pending;
        throw error;
      }
      const frame = tui.render().join("\n");
      if (
        /Checking remote content list|Checking and saving remote content list|Refreshing remote content list/u.test(
          frame,
        )
      )
        return await pending;
      const choice = await overrides.select?.(frame);
      if (choice === undefined) tui.press("tui.select.cancel");
      else {
        for (let index = 0; index < 30; index += 1) {
          if (tui.render().some((line) => line.startsWith(`→ ${choice}`))) break;
          tui.press("tui.select.down");
        }
        tui.press("tui.select.confirm");
      }
      return await pending;
    } finally {
      tui.dispose();
    }
  };
  return context;
}

for (const remote of [
  "same",
  "empty",
  "legacy",
  "different",
  "head-error",
  "payload-error",
  "cancelled",
  "replacement",
  "new-observation",
] as const) {
  test(`manager fresh ${remote} review invalidates only superseded mismatch observations`, async () => {
    await withTempHome(async (agentDir) => {
      await fs.mkdir(agentDir, { recursive: true });
      await fs.writeFile(localConfigPath(), JSON.stringify(v3S3Settings({ automatic: true })));
      const config = await loadConfig();
      const managedPath = path.join(agentDir, "settings.json");
      await fs.writeFile(managedPath, '{"theme":"dark"}\n');
      await writeStateForConfig(config, {
        version: 2,
        profile: config.snapshotIdentity,
        lastAppliedSnapshot: "baseline",
        lastFileHashes: {},
      });
      const statePath = statePathForConfig(config);
      const paths = [localConfigPath(), managedPath, statePath];
      const before = await Promise.all(paths.map((file) => fs.readFile(file)));
      const attention = createSyncAttentionController();
      const observation = {
        setupName: config.setupName,
        configIdentity: syncCheckConfigFingerprint(config),
        checkedAt: "2026-09-06T00:00:00.000Z",
        inspection: await inspectionFixture(config, {
          selectionState: {
            kind: "different",
            include: ["models.json"],
            remoteOnly: ["models.json"],
            localOnly: config.include,
          },
        }),
      };
      attention.observe(observation);
      const replacement = { ...observation, checkedAt: "2026-09-07T00:00:00.000Z" };
      const controller = new AbortController();
      const backend = new MemorySyncBackend();
      if (remote !== "empty")
        await backend.publishSnapshot(
          {
            ...snapshot([]),
            ...(remote === "legacy"
              ? {}
              : {
                  selection: {
                    version: 1 as const,
                    include: remote === "different" ? ["models.json"] : config.include,
                  },
                }),
          },
          { kind: "missing" },
        );
      const headBefore = await backend.readHead();
      const readHead = backend.readHead.bind(backend);
      const headSpy = vi.spyOn(backend, "readHead").mockImplementation(async (signal) => {
        if (remote === "head-error") throw new Error("head unavailable");
        if (remote === "cancelled") controller.abort();
        if (remote === "replacement") {
          controller.abort();
          attention.observe(replacement);
        }
        if (remote === "new-observation") attention.observe(replacement);
        return readHead(signal);
      });
      const payload = vi.spyOn(backend, "readSnapshot");
      if (remote === "payload-error") payload.mockRejectedValue(new Error("payload unavailable"));
      const publish = vi.spyOn(backend, "publishSnapshot");
      const factory = vi.spyOn(backendFactory, "createSyncBackend").mockReturnValue(backend);
      const frames: string[] = [];
      let choices = 0;
      const context = createMockContext({
        mode: "tui",
        select: async (title: string) => {
          frames.push(title);
          return choices++ === 0 ? "Review synced content (recommended)" : undefined;
        },
      });
      try {
        await handleCommand("", context.ctx, controller.signal, createSyncLoaders({}), attention);
        const superseded = ["same", "empty", "legacy"].includes(remote);
        assert.equal(headSpy.mock.calls.length, 1);
        assert.equal(
          attention.observation(),
          superseded ? undefined : remote === "replacement" || remote === "new-observation" ? replacement : observation,
        );
        if (superseded) {
          const managerFrames = frames.filter((frame) => frame.includes("Manage sync"));
          assert.equal(managerFrames.length, 2);
          assert.match(managerFrames[0] ?? "", /Review synced content/u);
          assert.doesNotMatch(managerFrames[1] ?? "", /Review synced content|Synced-content list differs/u);
          assert.equal(context.statuses.get("sync"), undefined);
        }
        assert.equal(publish.mock.calls.length, 0);
        assert.deepEqual(await readHead(), headBefore);
        assert.deepEqual(await Promise.all(paths.map((file) => fs.readFile(file))), before);
        if (remote === "legacy")
          assert.match(context.notifications.map((n) => n.message).join("\n") + frames.join("\n"), /legacy|partial/u);
      } finally {
        factory.mockRestore();
        headSpy.mockRestore();
        payload.mockRestore();
        publish.mockRestore();
      }
    });
  });
}

for (const mode of ["tui", "rpc"] as const) {
  for (const remote of ["same", "empty", "legacy"] as const) {
    test(`${mode} initial fresh ${remote} selection signals supersession once`, async () => {
      await withTempHome(async (agentDir) => {
        await fs.mkdir(agentDir, { recursive: true });
        await fs.writeFile(localConfigPath(), JSON.stringify(v3S3Settings()));
        const backend = new MemorySyncBackend();
        if (remote !== "empty")
          await backend.publishSnapshot(
            {
              ...snapshot([]),
              ...(remote === "legacy" ? {} : { selection: { version: 1 as const, include: ["settings.json"] } }),
            },
            { kind: "missing" },
          );
        let resolved = 0;
        const result = await showRemoteSelectionReview(
          createMockContext({ mode }).ctx,
          "home",
          undefined,
          () => backend,
          { onSelectionResolved: () => resolved++ },
        );
        assert.deepEqual(result, { kind: "back" });
        assert.equal(resolved, 1);
      });
    });
  }
}

for (const remote of ["same", "empty", "legacy"] as const) {
  test(`refresh after stale adoption signals fresh ${remote} supersession once`, async () => {
    await withTempHome(async (agentDir) => {
      await fs.mkdir(agentDir, { recursive: true });
      await fs.writeFile(localConfigPath(), JSON.stringify(v3S3Settings()));
      const config = await loadConfig();
      const bytes = await fs.readFile(localConfigPath());
      const backend = new MemorySyncBackend();
      if (remote !== "empty")
        await backend.publishSnapshot(
          {
            ...snapshot([]),
            ...(remote === "legacy" ? {} : { selection: { version: 1 as const, include: config.include } }),
          },
          { kind: "missing" },
        );
      let resolved = 0;
      const context = createMockContext({
        mode: "tui",
        select: async () => "Use remote content list",
      });
      await showRemoteSelectionReview(context.ctx, "home", undefined, () => backend, {
        decision: {
          setupName: config.setupName,
          configIdentity: syncConfigReviewFingerprint(config),
          localInclude: config.include,
          remoteInclude: ["models.json"],
        },
        onSelectionResolved: () => resolved++,
      });
      assert.equal(resolved, 1);
      assert.deepEqual(await fs.readFile(localConfigPath()), bytes);
      await assert.rejects(fs.access(statePathForConfig(config)), { code: "ENOENT" });
    });
  });
}
