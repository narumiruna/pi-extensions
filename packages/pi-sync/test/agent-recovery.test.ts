import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { test, vi } from "vitest";
import type { SyncBackend } from "../src/backends/sync-backend.js";
import { loadConfig } from "../src/settings/config.js";
import { localConfigPath } from "../src/settings/config-file.js";
import { withStateDirectoryAccess } from "../src/state/state-directory.js";
import { readStateForConfig, syncStateFingerprint, writeStateForConfig } from "../src/state/sync-state-store.js";
import { withAgentSyncLock } from "../src/sync/agent-sync.js";
import { mergeJournalIdentity, readMergeJournal, writeMergeJournal } from "../src/sync/merge-journal.js";
import { syncBoth } from "../src/sync/sync-mutations.js";
import { fileHashMap } from "../src/sync/sync-state.js";
import { agentContext, selectRemote } from "./agent-test-helpers.js";
import { withTempHome } from "./helpers.js";
import type { MemorySyncBackend } from "./memory-sync-backend.js";
import { createMergeFixture, mergeOptions } from "./merged-sync-fixture.js";

function weakBackend(backend: MemorySyncBackend): SyncBackend {
  return {
    identity: backend.identity,
    destination: backend.destination,
    capability: "read-check-write-verify",
    sameRevision: backend.sameRevision.bind(backend),
    readHead: backend.readHead.bind(backend),
    readSnapshot: backend.readSnapshot.bind(backend),
    publishSnapshot: backend.publishSnapshot.bind(backend),
    listHistory: backend.listHistory.bind(backend),
    diagnose: backend.diagnose.bind(backend),
  };
}

async function enable() {
  const settings = JSON.parse(await fs.readFile(localConfigPath(), "utf8"));
  settings.syncSetups.home.sync.agentMode = true;
  settings.syncSetups.home.sync.automaticTransfer = true;
  await fs.writeFile(localConfigPath(), JSON.stringify(settings));
  return loadConfig();
}

for (const auto of [false, true]) {
  for (const mode of ["apply-only", "published", "uncertain", "inactive", "accepted-newer"] as const)
    test(`recovers ${mode} journal on weak backend with legacy flags (auto=${auto})`, async () =>
      withTempHome(async (agentDir) => {
        const f = await createMergeFixture(agentDir);
        const config = await enable();
        const state = await readStateForConfig(config);
        if (mode !== "inactive") await f.remoteEdit("AGENTS.md", "committed remote\n");
        const head = await f.backend.readHead();
        assert.ok(head);
        const after = await f.backend.readSnapshot(head.snapshotRef);
        await writeMergeJournal(config, {
          version: 1,
          identity: mergeJournalIdentity(config, f.backend.identity),
          before: f.base,
          after,
          upload: after,
          expectedHead: mode === "apply-only" ? head : f.baseHead,
          ...(["apply-only", "published", "accepted-newer"].includes(mode) ? { committedHead: head } : {}),
          ...(mode === "apply-only" ? { applyOnly: true } : {}),
          backup: "retained-private-backup",
          stateIdentity: syncStateFingerprint(state),
        });
        if (mode === "accepted-newer") {
          await fs.writeFile(path.join(agentDir, "AGENTS.md"), "accepted local edits\n");
          await writeStateForConfig(config, {
            version: 1,
            profile: config.snapshotIdentity,
            lastAppliedSnapshot: head.snapshotId,
            lastRemoteRevision: head.revision,
            lastFileHashes: fileHashMap(after),
            include: [...config.include],
          });
          await f.remoteEdit("AGENTS.md", "newer remote\n");
        }
        const currentHead = await f.backend.readHead();
        const publish = vi.spyOn(f.backend, "publishSnapshot");
        const weak = weakBackend(f.backend);
        const mock = agentContext(selectRemote);
        const options = { ...mergeOptions, auto };
        const result = await withStateDirectoryAccess(() =>
          withAgentSyncLock(mock.ctx, options, (current) => syncBoth(mock.ctx, current, () => weak)),
        );
        assert.equal(result, mode === "inactive" ? "cancelled" : "applied");
        assert.equal(publish.mock.calls.length, 0);
        assert.equal(mock.requests.length, 0);
        assert.deepEqual(await f.backend.readHead(), currentHead);
        assert.equal(await readMergeJournal(config), undefined);
        assert.equal(
          await fs.readFile(path.join(agentDir, "AGENTS.md"), "utf8"),
          mode === "inactive"
            ? "original instructions\n"
            : mode === "accepted-newer"
              ? "accepted local edits\n"
              : "committed remote\n",
        );
        if (mode === "inactive") assert.deepEqual(await readStateForConfig(config), state);
        else assert.equal((await readStateForConfig(config)).lastRemoteRevision, head.revision);
      }));

  if (auto)
    test(`Startup transfer rejects a new transfer on weak backend`, async () =>
      withTempHome(async (agentDir) => {
        const f = await createMergeFixture(agentDir);
        const config = await enable();
        await f.remoteEdit("AGENTS.md", "remote\n");
        await fs.writeFile(path.join(agentDir, "AGENTS.md"), "local\n");
        const head = await f.backend.readHead();
        const state = await readStateForConfig(config);
        const publish = vi.spyOn(f.backend, "publishSnapshot");
        const weak = weakBackend(f.backend);
        const mock = agentContext(selectRemote);
        const options = { ...mergeOptions, auto };
        await assert.rejects(
          withStateDirectoryAccess(() =>
            withAgentSyncLock(mock.ctx, options, (current) => syncBoth(mock.ctx, current, () => weak)),
          ),
          /requires conditional publication/,
        );
        assert.equal(publish.mock.calls.length, 0);
        assert.equal(mock.requests.length, 0);
        assert.deepEqual(await f.backend.readHead(), head);
        assert.deepEqual(await readStateForConfig(config), state);
        assert.equal(await fs.readFile(path.join(agentDir, "AGENTS.md"), "utf8"), "local\n");
        assert.equal(await readMergeJournal(config), undefined);
      }));
}

test("weak-backend journal recovery retains newer local edits and its journal", async () =>
  withTempHome(async (agentDir) => {
    const f = await createMergeFixture(agentDir);
    const config = await enable();
    const state = await readStateForConfig(config);
    await f.remoteEdit("AGENTS.md", "committed remote\n");
    const head = await f.backend.readHead();
    assert.ok(head);
    const after = await f.backend.readSnapshot(head.snapshotRef);
    await writeMergeJournal(config, {
      version: 1,
      identity: mergeJournalIdentity(config, f.backend.identity),
      before: f.base,
      after,
      upload: after,
      expectedHead: head,
      committedHead: head,
      applyOnly: true,
      backup: "retained-private-backup",
      stateIdentity: syncStateFingerprint(state),
    });
    await fs.writeFile(path.join(agentDir, "AGENTS.md"), "new user edits\n");
    const weak = weakBackend(f.backend);
    const mock = agentContext(selectRemote);
    const publish = vi.spyOn(f.backend, "publishSnapshot");
    await assert.rejects(
      withStateDirectoryAccess(() =>
        withAgentSyncLock(mock.ctx, mergeOptions, (current) => syncBoth(mock.ctx, current, () => weak)),
      ),
    );
    assert.equal(publish.mock.calls.length, 0);
    assert.equal(mock.requests.length, 0);
    assert.ok(await readMergeJournal(config));
    assert.deepEqual(await readStateForConfig(config), state);
    assert.equal(await fs.readFile(path.join(agentDir, "AGENTS.md"), "utf8"), "new user edits\n");
  }));
