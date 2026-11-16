import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { test } from "vitest";
import { createMockContext } from "../../../test/support.js";
import { WebDavSyncBackend } from "../src/backends/webdav/webdav-backend.js";
import { executeCommand, executeRecoveryCommand } from "../src/commands/command-execution.js";
import { loadConfig } from "../src/settings/config.js";
import { isSyncDecisionRequiredError, SyncDecisionRequiredError } from "../src/sync/sync-decision.js";
import { createSyncLoaders } from "../src/sync/sync-loaders.js";
import { RemoteSelectionMismatchError } from "../src/sync/sync-policy.js";
import { dispatchManagerResult } from "../src/ui/manager-result-dispatcher.js";
import { adoptFixtureRoot } from "./daemon-test-helpers.js";
import { snapshot, v3WebDavSettings, withTempHome } from "./helpers.js";
import { MockWebDavServer } from "./mock-webdav-server.js";

for (const mismatch of [false, true])
  test(`the actual daemon preserves ${mismatch ? "remote-selection" : "directional sync"} decisions through command and recovery routing`, () =>
    withTempHome(async (agentDir) => {
      await fs.mkdir(agentDir, { recursive: true });
      const storage = await new MockWebDavServer().start();
      try {
        const settings = v3WebDavSettings();
        settings.storageConnections.dav.url = storage.url;
        await fs.writeFile(path.join(agentDir, "pi-sync.json"), JSON.stringify(settings), { mode: 0o600 });
        const original = '{"local":true}\n';
        await fs.writeFile(path.join(agentDir, "settings.json"), original);
        const config = await loadConfig();
        assert.equal(config.backend.type, "webdav");
        if (config.backend.type !== "webdav") throw new Error("Expected fixture backend.");
        const remote = {
          ...snapshot([{ path: "settings.json", content: Buffer.from('{"remote":true}\n') }]),
          profile: config.snapshotIdentity,
          selection: { version: 1 as const, include: mismatch ? ["settings.json", "AGENTS.md"] : ["settings.json"] },
        };
        await new WebDavSyncBackend(config.backend).publishSnapshot(remote, { kind: "missing" });
        const before = new Map(storage.resources);
        const menus: Array<{ title: string; choices: string[] }> = [];
        const context = createMockContext({
          mode: "rpc",
          cwd: agentDir,
          model: undefined,
          select: async (title: string, choices: string[]) => {
            menus.push({ title, choices });
            return undefined;
          },
        });
        // Set the disposable root before importing the session-bound adapter.
        const { bindPiDaemonClient, installPiDaemonHost, withPiDaemonClient } = await import(
          "../src/daemon/pi-client.js"
        );
        await adoptFixtureRoot(agentDir);
        installPiDaemonHost();
        const client = bindPiDaemonClient(context.ctx, new AbortController().signal);
        const loaders = createSyncLoaders({});
        try {
          await withPiDaemonClient(context.ctx, async (ctx) => {
            let decision: unknown;
            await assert.rejects(client.run("sync", { args: [], reload: false }), (error: unknown) => {
              if (mismatch) {
                assert.ok(error instanceof RemoteSelectionMismatchError);
                assert.deepEqual(error.decision.remoteInclude, ["settings.json", "AGENTS.md"]);
                decision = error.decision;
              } else {
                assert.ok(error instanceof SyncDecisionRequiredError);
                assert.ok(isSyncDecisionRequiredError(error));
                assert.equal(error.decision.kind, "first-sync-settings-diverged");
                assert.deepEqual(error.decision.directions, ["push", "pull"]);
                assert.equal(error.message, error.decision.directMessage);
                decision = error.decision;
              }
              return true;
            });
            const expectedKind = mismatch ? "remote-selection-required" : "decision-required";
            const result = await executeCommand("sync", ctx, undefined, loaders);
            assert.equal(result.kind, expectedKind);
            assert.deepEqual("decision" in result ? result.decision : undefined, decision);
            const recovery = await executeRecoveryCommand("sync", ctx, undefined, loaders);
            assert.equal(recovery.kind, expectedKind);
            assert.deepEqual("decision" in recovery ? recovery.decision : undefined, decision);
            if (!mismatch) {
              await dispatchManagerResult(ctx, result, "sync", async () => {
                throw new Error("Cancelling the resolution menu must not start another transfer.");
              });
              assert.equal(menus.length, 1);
              assert.match(menus[0]?.title ?? "", /^Resolve sync conflict\n/u);
              assert.match(menus[0]?.choices.join("\n") ?? "", /Use local as initial source…/u);
              assert.match(menus[0]?.choices.join("\n") ?? "", /Use remote as initial source…/u);
            }
            // Unclassified failures must still follow the observable failed route.
            storage.options.unavailable = true;
            assert.equal((await executeCommand("sync", ctx, undefined, loaders)).kind, "failed");
            assert.equal(context.notifications.at(-1)?.level, "error");
          });
          assert.equal(await fs.readFile(path.join(agentDir, "settings.json"), "utf8"), original);
          assert.deepEqual(storage.resources, before);
        } finally {
          await client.dispose();
        }
      } finally {
        await storage.close();
      }
    }));
