import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import * as configModule from "@narumitw/pi-sync-daemon/engine/settings/config";
import { test, vi } from "vitest";
import { updateLocalConfig } from "../src/settings/settings-store.js";
import { readStateForConfig } from "../src/state/sync-state-store.js";
import { AgentResolutionRequired } from "../src/sync/agent-request.js";
import { readContinuousRecord } from "../src/sync/continuous-record.js";
import { continuousBinding } from "../src/sync/continuous-storage.js";
import { createContinuousSync } from "../src/sync/continuous-sync.js";
import { readMergeJournal } from "../src/sync/merge-journal.js";
import { syncBoth } from "../src/sync/sync-mutations.js";
import { agentContext, selectRemote } from "./agent-test-helpers.js";
import { continuousLoaders, enableContinuous, fakeContinuousTime, requiredHome } from "./continuous-test-helpers.js";
import { withTempHome } from "./helpers.js";
import { createMergeFixture } from "./merged-sync-fixture.js";
import { deferred } from "./startup-check-helpers.js";

// Watcher hints and the five-second guard must not be needed to reject a new transfer.
vi.mock("@narumitw/pi-sync-daemon/engine/sync/continuous-watch", () => ({ watchContinuous: async () => () => {} }));

for (const boundary of ["sync entry", "merge entry"] as const)
  for (const change of ["continuous off", "agent off with startup transfer on", "credentials", "model"] as const)
    for (const conflict of [false, true])
      test(`${change} at ${boundary} rejects the old ${conflict ? "conflicting" : "conflict-free"} cycle`, async () =>
        withTempHome(async (agentDir) => {
          const f = await createMergeFixture(agentDir);
          const config = await enableContinuous();
          await fs.writeFile(path.join(agentDir, "AGENTS.md"), "local\n");
          if (conflict) await f.remoteEdit("AGENTS.md", "remote\n");
          const baseline = await readStateForConfig(config);
          const head = await f.backend.readHead();
          const publish = vi.spyOn(f.backend, "publishSnapshot");
          const mock = agentContext(selectRemote);
          const finished = deferred<unknown>();
          const loadConfig = configModule.loadConfig;
          let transferring = false;
          let changed = false;
          const replaceAuthorization = async () => {
            if (changed) return;
            changed = true;
            if (change === "model") {
              assert.ok(mock.ctx.model);
              mock.ctx.model = { ...mock.ctx.model, id: "replacement-model" };
            } else {
              await updateLocalConfig((current) => {
                const setup = requiredHome(current);
                if (change === "credentials") {
                  const connection = current.storageConnections[setup.storage.connection];
                  assert.ok(connection?.type === "s3");
                  return {
                    ...current,
                    storageConnections: {
                      ...current.storageConnections,
                      [setup.storage.connection]: {
                        ...connection,
                        credentials: { ...connection.credentials, secretAccessKey: "replacement-secret" },
                      },
                    },
                  };
                }
                return {
                  ...current,
                  syncSetups: {
                    ...current.syncSetups,
                    home: {
                      ...setup,
                      sync: {
                        ...setup.sync,
                        ...(change === "continuous off"
                          ? { continuous: false }
                          : { agentMode: false, automaticTransfer: true }),
                      },
                    },
                  },
                };
              });
            }
          };
          vi.spyOn(configModule, "loadConfig").mockImplementation(async (...args) => {
            const current = await loadConfig(...args);
            // Return the old syncBoth snapshot, then make mergeSync read the new settings.
            if (transferring && boundary === "merge entry") await replaceAuthorization();
            return current;
          });
          const service = createContinuousSync(
            continuousLoaders(f.backend, {
              loadSyncOperations: async () => ({
                ...(await import("@narumitw/pi-sync-daemon/engine/sync/sync-operations")),
                syncBoth: async (ctx, options) => {
                  transferring = true;
                  let failure: unknown;
                  try {
                    if (boundary === "sync entry") await replaceAuthorization();
                    return await syncBoth(ctx, options, () => f.backend);
                  } catch (error) {
                    failure = error;
                    throw error;
                  } finally {
                    if (!(failure instanceof AgentResolutionRequired)) finished.resolve(failure);
                  }
                },
              }),
            }),
          );
          fakeContinuousTime();
          try {
            service.start(mock.ctx, new AbortController().signal);
            const failure = await finished.promise;
            await service.stop();
            assert.ok(changed);
            assert.ok(failure instanceof Error && failure.name === "AbortError", String(failure));
            assert.equal(mock.requests.length, 0, "no new provider dispatch under replaced authorization");
            const accounting = await readContinuousRecord(await continuousBinding(config));
            assert.deepEqual(accounting.calls, []);
            assert.deepEqual(accounting.attempts, {});
            assert.equal(publish.mock.calls.length, 0, "no publication under replaced authorization");
            assert.equal(await fs.readFile(path.join(agentDir, "AGENTS.md"), "utf8"), "local\n");
            assert.deepEqual(await readStateForConfig(config), baseline);
            assert.deepEqual(await f.backend.readHead(), head);
            assert.equal(await readMergeJournal(config), undefined);
            await assert.rejects(fs.stat(path.join(agentDir, "pi-sync/continuous/scheduler.lock")), /ENOENT/);
            await assert.rejects(fs.stat(path.join(agentDir, "pi-sync/agent-resolver/claim.json")), /ENOENT/);
            assert.equal(vi.getTimerCount(), 0);
          } finally {
            await service.stop();
            vi.useRealTimers();
          }
        }));
