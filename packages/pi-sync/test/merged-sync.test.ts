import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { test, vi } from "vitest";
import { createMockContext } from "../../../test/support.js";
import { S3SyncBackend } from "../src/backends/s3/s3-backend.js";
import {
  type ExpectedRemoteHead,
  type PublishSnapshotOptions,
  SyncBackendConflictError,
} from "../src/backends/sync-backend.js";
import { localConfigPath } from "../src/settings/config-file.js";
import { createSnapshot, regenerateSnapshotIdentity } from "../src/snapshot/snapshot.js";
import type { Snapshot } from "../src/snapshot/snapshot-types.js";
import { readMergeAncestor, stageMergeBaseline } from "../src/state/merge-baseline-store.js";
import {
  readStateForConfig,
  statePathForConfig,
  syncStateFingerprint,
  writeStateForConfig,
} from "../src/state/sync-state-store.js";
import {
  mergeJournalIdentity,
  mergeJournalPath,
  readMergeJournal,
  writeMergeJournal,
} from "../src/sync/merge-journal.js";
import { SyncDecisionRequiredError } from "../src/sync/sync-errors.js";
import { push, rollback, syncBoth } from "../src/sync/sync-mutations.js";
import { fileHashMap } from "../src/sync/sync-state.js";
import { snapshot, v3S3Settings, withTempHome } from "./helpers.js";
import { MemorySyncBackend } from "./memory-sync-backend.js";
import { createMergeFixture as fixture, mergeOptions as options } from "./merged-sync-fixture.js";

for (const mode of ["manual-review", "manual-yes", "automatic"] as const)
  test(`legacy remote selection requires review in ${mode}`, async () =>
    withTempHome(async (agentDir) => {
      const f = await fixture(agentDir);
      if (mode === "automatic") {
        const settings = JSON.parse(await fs.readFile(localConfigPath(), "utf8"));
        settings.syncSetups.home.sync.automaticTransfer = true;
        await fs.writeFile(localConfigPath(), JSON.stringify(settings));
      }
      const legacy = structuredClone(f.base);
      delete legacy.selection;
      await f.backend.publishSnapshot(regenerateSnapshotIdentity(legacy), {
        kind: "revision",
        revision: f.baseHead.revision,
      });
      await fs.writeFile(path.join(agentDir, "settings.json"), '{"theme":"local"}');
      const state = await readStateForConfig(f.config);
      const head = await f.backend.readHead();
      const publish = vi.spyOn(f.backend, "publishSnapshot");
      try {
        await assert.rejects(
          syncBoth(f.ctx, { ...options, yes: mode !== "manual-review", auto: mode === "automatic" }, () => f.backend),
          (error: unknown) => {
            assert.ok(error instanceof SyncDecisionRequiredError);
            assert.equal(error.decision.kind, "remote-or-policy-changed");
            assert.match(error.decision.review, /legacy snapshot/);
            assert.match(error.decision.review, /explicit direction adopts/);
            return true;
          },
        );
        assert.equal(publish.mock.calls.length, 0);
        assert.deepEqual(await f.backend.readHead(), head);
        assert.deepEqual(await readStateForConfig(f.config), state);
        assert.equal(await readMergeJournal(f.config), undefined);
        assert.equal(await fs.readFile(path.join(agentDir, "settings.json"), "utf8"), '{"theme":"local"}');
      } finally {
        publish.mockRestore();
      }
    }));

for (const accepted of [false, true])
  test(`legacy apply-only journal ${accepted ? "retires a completed baseline" : "requires selection review before apply"}`, async () =>
    withTempHome(async (agentDir) => {
      const f = await fixture(agentDir);
      const state = await readStateForConfig(f.config);
      const legacy = structuredClone(f.base);
      delete legacy.selection;
      legacy.files = [
        ...legacy.files.filter((file) => file.path !== "AGENTS.md"),
        ...snapshot([{ path: "AGENTS.md", content: Buffer.from("legacy remote instructions") }]).files,
      ];
      const after = regenerateSnapshotIdentity(legacy);
      const committed = await f.backend.publishSnapshot(after, { kind: "revision", revision: f.baseHead.revision });
      await writeMergeJournal(f.config, {
        version: 1,
        identity: mergeJournalIdentity(f.config, f.backend.identity),
        before: f.base,
        after,
        upload: after,
        expectedHead: committed.head,
        committedHead: committed.head,
        applyOnly: true,
        backup: "retained-private-backup",
        stateIdentity: syncStateFingerprint(state),
      });
      if (accepted) {
        await fs.writeFile(path.join(agentDir, "AGENTS.md"), "legacy remote instructions");
        await writeStateForConfig(f.config, {
          version: 1,
          profile: f.config.snapshotIdentity,
          lastAppliedSnapshot: committed.head.snapshotId,
          lastRemoteRevision: committed.head.revision,
          lastFileHashes: fileHashMap(after),
          include: [...f.config.include],
        });
      }
      const baseline = await readStateForConfig(f.config);
      if (accepted) {
        assert.equal(await syncBoth(f.ctx, options, () => f.backend), "applied");
        assert.equal(await readMergeJournal(f.config), undefined);
      } else {
        await assert.rejects(
          syncBoth(f.ctx, options, () => f.backend),
          /unavailable remote selection metadata/,
        );
        assert.ok(await readMergeJournal(f.config));
        assert.equal(await fs.readFile(path.join(agentDir, "AGENTS.md"), "utf8"), "original instructions\n");
      }
      assert.deepEqual(await readStateForConfig(f.config), baseline);
      assert.deepEqual(await f.backend.readHead(), committed.head);
    }));

for (const force of [false, true])
  test(`rollback cannot bypass a pending merge journal (force: ${force})`, async () =>
    withTempHome(async (agentDir) => {
      const f = await fixture(agentDir);
      const state = await readStateForConfig(f.config);
      await writeMergeJournal(f.config, {
        version: 1,
        identity: mergeJournalIdentity(f.config, f.backend.identity),
        before: f.base,
        after: f.base,
        upload: f.base,
        expectedHead: f.baseHead,
        backup: "retained-private-backup",
        stateIdentity: syncStateFingerprint(state),
      });
      const journal = await fs.readFile(mergeJournalPath(f.config));
      await fs.writeFile(path.join(agentDir, "AGENTS.md"), "newer local instructions");
      const read = vi.spyOn(f.backend, "readSnapshot");
      const publish = vi.spyOn(f.backend, "publishSnapshot");
      try {
        await assert.rejects(
          rollback(f.ctx, { ...options, args: [f.base.id], force }, () => f.backend),
          /merged transfer needs recovery/,
        );
        assert.equal(read.mock.calls.length, 0);
        assert.equal(publish.mock.calls.length, 0);
        assert.deepEqual(await fs.readFile(mergeJournalPath(f.config)), journal);
        assert.deepEqual(await readStateForConfig(f.config), state);
        assert.equal(await fs.readFile(path.join(agentDir, "AGENTS.md"), "utf8"), "newer local instructions");
      } finally {
        read.mockRestore();
        publish.mockRestore();
      }
    }));

for (const auto of [false, true])
  for (const transition of ["default-to-custom", "custom-to-custom", "custom-to-default"])
    test(`${auto ? "automatic" : "manual"} merge blocks ${transition} session-root acceptance`, async () =>
      withTempHome(async (agentDir) => {
        const f = await fixture(agentDir, new MemorySyncBackend(), true);
        const oldRoot = path.join(path.dirname(agentDir), "old-sessions");
        const newRoot = path.join(path.dirname(agentDir), "new-sessions");
        if (transition !== "default-to-custom") {
          await fs.rename(path.join(agentDir, "sessions"), oldRoot);
          await fs.writeFile(path.join(agentDir, "settings.json"), JSON.stringify({ sessionDir: oldRoot }));
          await push(f.ctx, { ...options, force: true }, undefined, () => f.backend);
        }
        const settingsBefore = await fs.readFile(path.join(agentDir, "settings.json"));
        await f.remoteEdit(
          "settings.json",
          JSON.stringify(transition === "custom-to-default" ? {} : { sessionDir: newRoot }),
        );
        // An independent local edit would require combined publication without the barrier.
        await fs.writeFile(path.join(agentDir, "AGENTS.md"), "independent local");
        const state = await readStateForConfig(f.config);
        const head = await f.backend.readHead();
        const publish = vi.spyOn(f.backend, "publishSnapshot");
        try {
          await assert.rejects(
            syncBoth(f.ctx, { ...options, auto }, () => f.backend),
            /changes the session root/,
          );
          assert.equal(publish.mock.calls.length, 0);
          assert.deepEqual(await readStateForConfig(f.config), state);
          assert.deepEqual(await f.backend.readHead(), head);
          assert.deepEqual(await fs.readFile(path.join(agentDir, "settings.json")), settingsBefore);
          assert.equal(await readMergeJournal(f.config), undefined);
          await assert.rejects(fs.access(newRoot), { code: "ENOENT" });
        } finally {
          publish.mockRestore();
        }
      }));

for (const unsafe of [false, true])
  test(`stable configured session root ${unsafe ? "is preflighted before publication" : "receives merged sessions"}`, async () =>
    withTempHome(async (agentDir) => {
      const f = await fixture(agentDir, new MemorySyncBackend(), true);
      const sessionRoot = path.join(path.dirname(agentDir), "custom-sessions");
      await fs.rename(path.join(agentDir, "sessions"), sessionRoot);
      await fs.writeFile(path.join(agentDir, "settings.json"), JSON.stringify({ sessionDir: sessionRoot }));
      const settings = v3S3Settings({ include: ["AGENTS.md", "sessions"] });
      await fs.writeFile(localConfigPath(), JSON.stringify(settings));
      await push(f.ctx, { ...options, force: true }, undefined, () => f.backend);
      if (unsafe) {
        const outside = path.join(path.dirname(agentDir), "outside");
        await fs.mkdir(outside);
        await fs.symlink(outside, path.join(sessionRoot, "linked"), "dir");
      }
      const relative = unsafe ? "sessions/linked/new.jsonl" : "sessions/project/new.jsonl";
      await f.remoteEdit(relative, '{"new":"session"}\n');
      await fs.writeFile(path.join(agentDir, "AGENTS.md"), "independent local");
      const publish = vi.spyOn(f.backend, "publishSnapshot");
      try {
        if (unsafe) {
          await assert.rejects(
            syncBoth(f.ctx, options, () => f.backend),
            /filesystem layout/,
          );
          assert.equal(publish.mock.calls.length, 0);
        } else {
          await syncBoth(f.ctx, options, () => f.backend);
          assert.equal(await fs.readFile(path.join(sessionRoot, "project/new.jsonl"), "utf8"), '{"new":"session"}\n');
          assert.equal(
            await fs.readFile(path.join(sessionRoot, "project/unchanged.jsonl"), "utf8"),
            '{"session":"preserved"}\n',
          );
          await assert.rejects(fs.access(path.join(agentDir, "sessions")), { code: "ENOENT" });
        }
      } finally {
        publish.mockRestore();
      }
    }));

for (const invalid of ["{private-token", '{"sessionDir":true}', "[]"])
  test(`merge refuses invalid remote session settings ${invalid} before publication`, async () =>
    withTempHome(async (agentDir) => {
      const f = await fixture(agentDir, new MemorySyncBackend(), true);
      const state = await readStateForConfig(f.config);
      await f.remoteEdit("settings.json", invalid);
      await fs.writeFile(path.join(agentDir, "AGENTS.md"), "independent local");
      const publish = vi.spyOn(f.backend, "publishSnapshot");
      try {
        await assert.rejects(
          syncBoth(f.ctx, options, () => f.backend),
          (error: unknown) => {
            assert.ok(error instanceof Error);
            assert.doesNotMatch(error.message, /private-token/);
            return true;
          },
        );
        assert.equal(publish.mock.calls.length, 0);
        assert.deepEqual(await readStateForConfig(f.config), state);
        assert.equal(await readMergeJournal(f.config), undefined);
      } finally {
        publish.mockRestore();
      }
    }));

test("invalid UTF-8 session settings are withheld before publication", async () =>
  withTempHome(async (agentDir) => {
    const f = await fixture(agentDir, new MemorySyncBackend(), true);
    const head = await f.backend.readHead();
    assert.ok(head);
    const original = await f.backend.readSnapshot(head.snapshotRef);
    const invalid = snapshot([{ path: "settings.json", content: Buffer.from([0x7b, 0xff, 0x7d]) }]).files[0];
    assert.ok(invalid);
    await f.backend.publishSnapshot(
      regenerateSnapshotIdentity({
        ...original,
        files: [...original.files.filter((file) => file.path !== invalid.path), invalid],
      }),
      { kind: "revision", revision: head.revision },
    );
    await assert.rejects(
      syncBoth(f.ctx, options, () => f.backend),
      /cannot be parsed/,
    );
    assert.equal(await readMergeJournal(f.config), undefined);
  }));

test("established sync avoids a second planning download", async () =>
  withTempHome(async (agentDir) => {
    const f = await fixture(agentDir);
    await f.remoteEdit("AGENTS.md", "remote instructions");
    const read = vi.spyOn(f.backend, "readSnapshot");
    await syncBoth(f.ctx, options, () => f.backend);
    // One planning read and one post-publication verification, never a duplicate planning read.
    assert.equal(read.mock.calls.length, 2);
    read.mockRestore();
  }));

test("no-op established sync downloads once", async () =>
  withTempHome(async (agentDir) => {
    const f = await fixture(agentDir);
    const read = vi.spyOn(f.backend, "readSnapshot");
    await syncBoth(f.ctx, options, () => f.backend);
    assert.equal(read.mock.calls.length, 1);
    read.mockRestore();
  }));

test("no-op acceptance refuses a concurrently advanced head", async () =>
  withTempHome(async (agentDir) => {
    const f = await fixture(agentDir);
    const state = await readStateForConfig(f.config);
    const original = f.backend.readHead.bind(f.backend);
    let reads = 0;
    const read = vi.spyOn(f.backend, "readHead").mockImplementation(async (...args) => {
      if (++reads === 2) {
        read.mockRestore();
        await f.remoteEdit("AGENTS.md", "newer remote");
      }
      return original(...args);
    });
    await assert.rejects(
      syncBoth(f.ctx, options, () => f.backend),
      /Remote changed before baseline acceptance/,
    );
    assert.deepEqual(await readStateForConfig(f.config), state);
  }));

test("an older committed session-root transition journal requires directional recovery", async () =>
  withTempHome(async (agentDir) => {
    const f = await fixture(agentDir, new MemorySyncBackend(), true);
    const before = await createSnapshot(f.config.snapshotIdentity, { include: f.config.include });
    const state = await readStateForConfig(f.config);
    const result = await f.remoteEdit(
      "settings.json",
      JSON.stringify({ sessionDir: path.join(path.dirname(agentDir), "new-sessions") }),
    );
    const after = await f.backend.readSnapshot(result.head.snapshotRef);
    await writeMergeJournal(f.config, {
      version: 1,
      identity: mergeJournalIdentity(f.config, f.backend.identity),
      before,
      after,
      upload: after,
      expectedHead: f.baseHead,
      committedHead: result.head,
      backup: "retained-private-backup",
      stateIdentity: syncStateFingerprint(state),
      sessionRoot: path.join(agentDir, "sessions"),
    });
    const count = (await f.backend.listHistory()).length;
    await assert.rejects(
      syncBoth(f.ctx, options, () => f.backend),
      /changes the session root/,
    );
    assert.deepEqual(await readStateForConfig(f.config), state);
    assert.equal((await f.backend.listHistory()).length, count);
    assert.ok(await readMergeJournal(f.config));
    assert.equal(await fs.readFile(path.join(agentDir, "settings.json"), "utf8"), '{"theme":"original"}\n');
  }));

for (const changedRoot of [false, true])
  test(`merge journal ${changedRoot ? "refuses a replacement context root" : "refuses legacy missing-root evidence"}`, async () =>
    withTempHome(async (agentDir) => {
      const f = await fixture(agentDir, new MemorySyncBackend(), true);
      const firstRoot = path.join(path.dirname(agentDir), "sessions-a");
      const secondRoot = path.join(path.dirname(agentDir), "sessions-b");
      await fs.rename(path.join(agentDir, "sessions"), firstRoot);
      await fs.mkdir(secondRoot);
      Object.defineProperty((f.ctx as ExtensionContext).sessionManager, "getSessionDir", { value: () => firstRoot });
      await fs.writeFile(path.join(agentDir, "AGENTS.md"), "independent local");
      await f.remoteEdit("sessions/project/remote-added.jsonl", "remote conversation\n");
      const state = await readStateForConfig(f.config);
      f.backend.failNextPublicationAfterCommit = true;
      await assert.rejects(
        syncBoth(f.ctx, options, () => f.backend),
        /interrupted/,
      );
      const pending = await readMergeJournal(f.config);
      assert.ok(pending);
      assert.equal(pending.sessionRoot, firstRoot);
      if (!changedRoot) {
        delete pending.sessionRoot;
        await writeMergeJournal(f.config, pending);
      }
      const replacement = createMockContext();
      Object.defineProperty((replacement.ctx as ExtensionContext).sessionManager, "getSessionDir", {
        value: () => (changedRoot ? secondRoot : firstRoot),
      });
      const head = await f.backend.readHead();
      await assert.rejects(
        syncBoth(replacement.ctx, options, () => f.backend),
        /journal session root/,
      );
      assert.deepEqual(await readStateForConfig(f.config), state);
      assert.deepEqual(await f.backend.readHead(), head);
      assert.ok(await readMergeJournal(f.config));
      for (const root of [firstRoot, secondRoot])
        await assert.rejects(fs.access(path.join(root, "project/remote-added.jsonl")), { code: "ENOENT" });
      if (changedRoot) {
        await syncBoth(f.ctx, options, () => f.backend);
        assert.equal(
          await fs.readFile(path.join(firstRoot, "project/remote-added.jsonl"), "utf8"),
          "remote conversation\n",
        );
        assert.deepEqual(await f.backend.readHead(), head);
      }
    }));

for (const boundary of ["backup", "journal"] as const)
  test(`a newer local edit during ${boundary} is refused before backend publication`, async () =>
    withTempHome(async (agentDir) => {
      const f = await fixture(agentDir);
      await fs.writeFile(path.join(agentDir, "settings.json"), '{"local":true}');
      await f.remoteEdit("AGENTS.md", "reviewed remote");
      const state = await readStateForConfig(f.config);
      const head = await f.backend.readHead();
      let edited = false;
      const mutate = async () => {
        edited = true;
        await fs.writeFile(path.join(agentDir, "AGENTS.md"), "newer external bytes");
      };
      const open = fs.open.bind(fs);
      const rename = fs.rename.bind(fs);
      const openSpy = vi.spyOn(fs, "open").mockImplementation(async (...args) => {
        const handle = await open(...args);
        if (!edited && boundary === "backup" && String(args[0]).endsWith(".json.gz")) await mutate();
        return handle;
      });
      const renameSpy = vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
        await rename(from, to);
        if (!edited && boundary === "journal" && to === mergeJournalPath(f.config)) await mutate();
      });
      const publish = vi.spyOn(f.backend, "publishSnapshot");
      try {
        await assert.rejects(
          syncBoth(f.ctx, options, () => f.backend),
          /changed before publication/,
        );
        assert.equal(edited, true);
        assert.equal(publish.mock.calls.length, 0);
        assert.deepEqual(await f.backend.readHead(), head);
        assert.deepEqual(await readStateForConfig(f.config), state);
        assert.equal(await readMergeJournal(f.config), undefined);
        assert.equal(await fs.readFile(path.join(agentDir, "AGENTS.md"), "utf8"), "newer external bytes");
      } finally {
        openSpy.mockRestore();
        renameSpy.mockRestore();
        publish.mockRestore();
      }
    }));

test("apply-only candidate retires when the remote advances during journal publication", async () =>
  withTempHome(async (agentDir) => {
    const f = await fixture(agentDir);
    await f.remoteEdit("AGENTS.md", "remote instructions");
    const state = await readStateForConfig(f.config);
    const rename = fs.rename.bind(fs);
    let advanced = false;
    const renameSpy = vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
      await rename(from, to);
      if (!advanced && to === mergeJournalPath(f.config)) {
        advanced = true;
        await f.remoteEdit("AGENTS.md", "newer remote instructions");
      }
    });
    try {
      assert.equal(await syncBoth(f.ctx, options, () => f.backend), "cancelled");
      assert.equal(advanced, true);
      assert.equal(await readMergeJournal(f.config), undefined);
      assert.deepEqual(await readStateForConfig(f.config), state);
      assert.equal(await fs.readFile(path.join(agentDir, "AGENTS.md"), "utf8"), "original instructions\n");
    } finally {
      renameSpy.mockRestore();
    }
  }));

test("remote advance after apply retains an apply-only journal instead of accepting a stale baseline", async () =>
  withTempHome(async (agentDir) => {
    const f = await fixture(agentDir);
    await f.remoteEdit("AGENTS.md", "remote instructions");
    const state = await readStateForConfig(f.config);
    const original = f.backend.readHead.bind(f.backend);
    const read = vi.spyOn(f.backend, "readHead").mockImplementation(async (...args) => {
      if ((await fs.readFile(path.join(agentDir, "AGENTS.md"), "utf8")) === "remote instructions") {
        read.mockRestore();
        await f.remoteEdit("AGENTS.md", "newer remote instructions");
      }
      return original(...args);
    });
    await assert.rejects(
      syncBoth(f.ctx, options, () => f.backend),
      /Remote changed during merged apply/,
    );
    assert.equal(await fs.readFile(path.join(agentDir, "AGENTS.md"), "utf8"), "remote instructions");
    assert.deepEqual(await readStateForConfig(f.config), state);
    assert.ok(await readMergeJournal(f.config));
    await assert.rejects(
      syncBoth(f.ctx, options, () => f.backend),
      /Apply-only remote head advanced/,
    );
    assert.ok(await readMergeJournal(f.config));
  }));

for (const applyOnly of [false, true])
  test(`accepted ${applyOnly ? "apply-only" : "published"} merge retires its journal after a newer remote revision`, async () =>
    withTempHome(async (agentDir) => {
      const f = await fixture(agentDir);
      const originalState = await readStateForConfig(f.config);
      const before = await createSnapshot(f.config.snapshotIdentity, { include: f.config.include });
      const committed = await f.remoteEdit("AGENTS.md", "accepted remote\n");
      const after = await f.backend.readSnapshot(committed.head.snapshotRef);
      await fs.writeFile(path.join(agentDir, "AGENTS.md"), "accepted remote\n");
      await writeMergeJournal(f.config, {
        version: 1,
        identity: mergeJournalIdentity(f.config, f.backend.identity),
        before,
        after,
        upload: after,
        expectedHead: applyOnly ? committed.head : f.baseHead,
        committedHead: committed.head,
        ...(applyOnly ? { applyOnly: true } : {}),
        backup: "retained-private-backup",
        stateIdentity: syncStateFingerprint(originalState),
      });
      const accepted = {
        version: 1 as const,
        profile: f.config.snapshotIdentity,
        lastAppliedSnapshot: committed.head.snapshotId,
        lastRemoteRevision: committed.head.revision,
        lastFileHashes: fileHashMap(after),
        include: [...f.config.include],
      };
      await writeStateForConfig(f.config, accepted);
      await f.remoteEdit("AGENTS.md", "newer remote\n");
      const currentHead = await f.backend.readHead();
      const publish = vi.spyOn(f.backend, "publishSnapshot");
      try {
        assert.equal(await syncBoth(f.ctx, options, () => f.backend), "applied");
        assert.equal(await readMergeJournal(f.config), undefined);
        assert.deepEqual(await readStateForConfig(f.config), accepted);
        assert.deepEqual(await f.backend.readHead(), currentHead);
        assert.equal(await fs.readFile(path.join(agentDir, "AGENTS.md"), "utf8"), "accepted remote\n");
        assert.equal(publish.mock.calls.length, 0);
      } finally {
        publish.mockRestore();
      }
    }));

test("newer remote revision retains an unaccepted published journal", async () =>
  withTempHome(async (agentDir) => {
    const f = await fixture(agentDir);
    const originalState = await readStateForConfig(f.config);
    const before = await createSnapshot(f.config.snapshotIdentity, { include: f.config.include });
    const committed = await f.remoteEdit("AGENTS.md", "committed remote\n");
    const after = await f.backend.readSnapshot(committed.head.snapshotRef);
    await writeMergeJournal(f.config, {
      version: 1,
      identity: mergeJournalIdentity(f.config, f.backend.identity),
      before,
      after,
      upload: after,
      expectedHead: f.baseHead,
      committedHead: committed.head,
      backup: "retained-private-backup",
      stateIdentity: syncStateFingerprint(originalState),
    });
    await f.remoteEdit("AGENTS.md", "newer remote\n");
    await assert.rejects(
      syncBoth(f.ctx, options, () => f.backend),
      /Publication outcome cannot be reconciled/,
    );
    assert.ok(await readMergeJournal(f.config));
    assert.deepEqual(await readStateForConfig(f.config), originalState);
    assert.equal(await fs.readFile(path.join(agentDir, "AGENTS.md"), "utf8"), "original instructions\n");
  }));

test("identical remote publications prune older ancestors while preserving accepted and unknown evidence", async () =>
  withTempHome(async (agentDir) => {
    const f = await fixture(agentDir);
    const directory = `${statePathForConfig(f.config)}.ancestors`;
    const unknown = `${"f".repeat(64)}.json`;
    await fs.writeFile(path.join(directory, unknown), "unknown evidence");
    for (let index = 0; index < 3; index++) {
      const previous = await readStateForConfig(f.config);
      await f.backend.publishSnapshot(
        { ...f.base, id: `identical-${index}` },
        { kind: "revision", revision: (await f.backend.readHead())?.revision ?? "" },
      );
      await syncBoth(f.ctx, options, () => f.backend);
      const accepted = await readStateForConfig(f.config);
      assert.equal(await readMergeAncestor(f.config, previous, "settings.json"), undefined);
      assert.ok(await readMergeAncestor(f.config, accepted, "settings.json"));
      assert.deepEqual(
        (await fs.readdir(directory)).sort(),
        [unknown, `${syncStateFingerprint(accepted)}.json`].sort(),
      );
    }
  }));

test("already accepted journal recovery prunes old ancestors without replaying local bytes", async () =>
  withTempHome(async (agentDir) => {
    const f = await fixture(agentDir);
    const accepted = await readStateForConfig(f.config);
    const old = { ...accepted, lastRemoteRevision: "old-revision" };
    await stageMergeBaseline(f.config, f.base, old);
    await writeMergeJournal(f.config, {
      version: 1,
      identity: mergeJournalIdentity(f.config, f.backend.identity),
      before: f.base,
      after: f.base,
      accepted: f.base,
      upload: f.base,
      expectedHead: f.baseHead,
      committedHead: f.baseHead,
      backup: "retained-backup",
      stateIdentity: syncStateFingerprint(old),
    });
    await fs.writeFile(path.join(agentDir, "settings.json"), '{"theme":"newer"}\n');
    await syncBoth(f.ctx, options, () => f.backend);
    assert.equal(await fs.readFile(path.join(agentDir, "settings.json"), "utf8"), '{"theme":"newer"}\n');
    assert.equal(await readMergeJournal(f.config), undefined);
    assert.equal(await readMergeAncestor(f.config, old, "settings.json"), undefined);
    assert.ok(await readMergeAncestor(f.config, accepted, "settings.json"));
  }));

test("settings conflicts merge against an accepted private ancestor", async () =>
  withTempHome(async (agentDir) => {
    const f = await fixture(agentDir);
    await syncBoth(f.ctx, options, () => f.backend); // Accepted equality captures the ancestor.
    await fs.writeFile(path.join(agentDir, "settings.json"), '{"theme":"local"}\n');
    await f.remoteEdit("settings.json", '{"theme":"original","defaultModel":"remote-model"}\n');
    await syncBoth(f.ctx, options, () => f.backend);
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(agentDir, "settings.json"), "utf8")), {
      theme: "local",
      defaultModel: "remote-model",
    });
    const head = await f.backend.readHead();
    assert.ok(head);
    const remote = await f.backend.readSnapshot(head.snapshotRef);
    assert.deepEqual(
      JSON.parse(
        Buffer.from(
          remote.files.find((file) => file.path === "settings.json")?.contentBase64 ?? "",
          "base64",
        ).toString(),
      ),
      { theme: "local", defaultModel: "remote-model" },
    );
  }));

test("divergent settings field retains whole-transfer review and names no credential values", async () =>
  withTempHome(async (agentDir) => {
    const f = await fixture(agentDir);
    await syncBoth(f.ctx, options, () => f.backend);
    await fs.writeFile(path.join(agentDir, "settings.json"), '{"theme":"local-private-value"}\n');
    await f.remoteEdit("settings.json", '{"theme":"remote-private-value"}\n');
    const publication = vi.spyOn(f.backend, "publishSnapshot");
    await assert.rejects(
      syncBoth(f.ctx, options, () => f.backend),
      (error) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /Settings fields: theme/);
        assert.doesNotMatch(error.message, /local-private-value|remote-private-value/);
        return true;
      },
    );
    assert.equal(publication.mock.calls.length, 0);
  }));

test("merged sync publishes both independent edits and applies remote bytes without reload", async () =>
  withTempHome(async (agentDir) => {
    const f = await fixture(agentDir);
    await fs.writeFile(path.join(agentDir, "settings.json"), '{"theme":"local"}\n');
    await f.remoteEdit("AGENTS.md", "remote instructions\n");
    await syncBoth(f.ctx, options, () => f.backend);
    assert.equal(await fs.readFile(path.join(agentDir, "AGENTS.md"), "utf8"), "remote instructions\n");
    assert.equal(await fs.readFile(path.join(agentDir, "settings.json"), "utf8"), '{"theme":"local"}\n');
    const head = await f.backend.readHead();
    assert.ok(head);
    assert.deepEqual(
      (await readStateForConfig(f.config)).lastFileHashes,
      fileHashMap(await f.backend.readSnapshot(head.snapshotRef)),
    );
    assert.equal(await readMergeJournal(f.config), undefined);
    assert.match(f.notifications.at(-1)?.message ?? "", /No automatic reload/);
  }));

test("merged sync applies unilateral deletion and addition while retaining independent local bytes", async () =>
  withTempHome(async (agentDir) => {
    const f = await fixture(agentDir);
    await fs.writeFile(path.join(agentDir, "settings.json"), '{"local":true}\n');
    await f.remoteEdit("AGENTS.md");
    await f.remoteEdit("prompts/new.md", "remote prompt\n");
    await syncBoth(f.ctx, options, () => f.backend);
    await assert.rejects(fs.readFile(path.join(agentDir, "AGENTS.md")), { code: "ENOENT" });
    assert.equal(await fs.readFile(path.join(agentDir, "prompts/new.md"), "utf8"), "remote prompt\n");
  }));

test("true conflict prevents every publication, local apply and baseline advance", async () =>
  withTempHome(async (agentDir) => {
    const f = await fixture(agentDir);
    await fs.writeFile(path.join(agentDir, "AGENTS.md"), "local divergent\n");
    await f.remoteEdit("AGENTS.md", "remote divergent\n");
    await f.remoteEdit("prompts/new.md", "independent\n");
    const state = await readStateForConfig(f.config);
    const head = await f.backend.readHead();
    await assert.rejects(
      syncBoth(f.ctx, options, () => f.backend),
      /Conflicting or protected/,
    );
    assert.deepEqual(await readStateForConfig(f.config), state);
    assert.deepEqual(await f.backend.readHead(), head);
    await assert.rejects(fs.readFile(path.join(agentDir, "prompts/new.md")), { code: "ENOENT" });
  }));

test("review cancellation and a newer local edit never mutate the reviewed files", async () =>
  withTempHome(async (agentDir) => {
    const f = await fixture(agentDir);
    await fs.writeFile(path.join(agentDir, "settings.json"), '{"local":true}\n');
    await f.remoteEdit("AGENTS.md", "remote\n");
    const cancelled = createMockContext({ mode: "rpc", select: async () => undefined });
    assert.equal(await syncBoth(cancelled.ctx, { ...options, yes: false }, () => f.backend), "cancelled");
    const stale = createMockContext({
      mode: "rpc",
      select: async (_title: string, choices: string[]) => {
        await fs.writeFile(path.join(agentDir, "AGENTS.md"), "newer writer\n");
        return choices.find((choice) => choice.startsWith("Yes,"));
      },
    });
    await assert.rejects(
      syncBoth(stale.ctx, { ...options, yes: false }, () => f.backend),
      /Local content changed during review/,
    );
    assert.equal(await fs.readFile(path.join(agentDir, "AGENTS.md"), "utf8"), "newer writer\n");
    assert.equal(await readMergeJournal(f.config), undefined);
  }));

test("unknown committed publication is reconciled once without republishing", async () =>
  withTempHome(async (agentDir) => {
    const f = await fixture(agentDir);
    await fs.writeFile(path.join(agentDir, "settings.json"), '{"local":true}\n');
    await f.remoteEdit("AGENTS.md", "remote\n");
    f.backend.failNextPublicationAfterCommit = true;
    await assert.rejects(
      syncBoth(f.ctx, options, () => f.backend),
      /interrupted.*retained/,
    );
    assert.ok(await readMergeJournal(f.config));
    const committed = await f.backend.readHead();
    const count = (await f.backend.listHistory()).length;
    await assert.rejects(
      push(f.ctx, options, undefined, () => f.backend),
      /needs recovery/,
    );
    await syncBoth(f.ctx, options, () => f.backend);
    assert.deepEqual(await f.backend.readHead(), committed);
    assert.equal((await f.backend.listHistory()).length, count);
    assert.equal(await fs.readFile(path.join(agentDir, "AGENTS.md"), "utf8"), "remote\n");
  }));

test("new local bytes after remote publication prevent apply and survive repeated recovery", async () =>
  withTempHome(async (agentDir) => {
    const f = await fixture(agentDir);
    await fs.writeFile(path.join(agentDir, "settings.json"), '{"local":true}\n');
    await f.remoteEdit("AGENTS.md", "remote\n");
    await assert.rejects(
      syncBoth(
        f.ctx,
        {
          ...options,
          onCommit: () => {
            void 0;
          },
        },
        () => ({
          ...backendFacade(f.backend),
          publishSnapshot: async (s, e, o) => {
            const result = await f.backend.publishSnapshot(s, e, o);
            await fs.writeFile(path.join(agentDir, "AGENTS.md"), "newer\n");
            return result;
          },
        }),
      ),
      /Local content changed/,
    );
    await assert.rejects(
      syncBoth(f.ctx, options, () => f.backend),
      /Local content changed/,
    );
    assert.equal(await fs.readFile(path.join(agentDir, "AGENTS.md"), "utf8"), "newer\n");
    assert.ok(await readMergeJournal(f.config));
  }));

test("state persistence obstruction retains recovery evidence", async () =>
  withTempHome(async (agentDir) => {
    const f = await fixture(agentDir);
    await fs.writeFile(path.join(agentDir, "settings.json"), '{"local":true}\n');
    await f.remoteEdit("AGENTS.md", "remote\n");
    const stateFile = statePathForConfig(f.config);
    const saved = await fs.readFile(stateFile);
    const backend = {
      ...backendFacade(f.backend),
      publishSnapshot: async (s: Snapshot, e: ExpectedRemoteHead, o?: PublishSnapshotOptions) => {
        const result = await f.backend.publishSnapshot(s, e, o);
        await fs.rm(stateFile);
        await fs.mkdir(stateFile);
        return result;
      },
    };
    await assert.rejects(syncBoth(f.ctx, options, () => backend));
    assert.ok(await readMergeJournal(f.config));
    await fs.rm(stateFile, { recursive: true });
    await fs.writeFile(stateFile, saved);
    await syncBoth(f.ctx, options, () => f.backend);
    assert.equal(await readMergeJournal(f.config), undefined);
  }));

function backendFacade(backend: MemorySyncBackend) {
  return {
    identity: backend.identity,
    destination: backend.destination,
    capability: backend.capability,
    sameRevision: backend.sameRevision.bind(backend),
    readHead: backend.readHead.bind(backend),
    readSnapshot: backend.readSnapshot.bind(backend),
    publishSnapshot: backend.publishSnapshot.bind(backend),
    listHistory: backend.listHistory.bind(backend),
    diagnose: backend.diagnose.bind(backend),
  };
}

for (const races of [1, 3])
  test(`precommit races replan with a finite bound (${races})`, async () =>
    withTempHome(async (agentDir) => {
      const f = await fixture(agentDir);
      await fs.writeFile(path.join(agentDir, "settings.json"), '{"local":true}\n');
      await f.remoteEdit("AGENTS.md", "remote\n");
      let attempts = 0;
      const backend = {
        ...backendFacade(f.backend),
        publishSnapshot: async (s: Snapshot, e: ExpectedRemoteHead, o?: PublishSnapshotOptions) => {
          if (attempts++ < races) {
            await f.remoteEdit("prompts/race.md", `race ${attempts}\n`);
            throw new SyncBackendConflictError("race");
          }
          return f.backend.publishSnapshot(s, e, o);
        },
      };
      if (races === 3)
        await assert.rejects(
          syncBoth(f.ctx, options, () => backend),
          /all three attempts/,
        );
      else await syncBoth(f.ctx, options, () => backend);
      assert.equal(attempts, races === 3 ? 3 : 2);
      assert.equal(await readMergeJournal(f.config), undefined);
    }));

test("automatic transfer rejects missing baseline and nonconditional publication", async () =>
  withTempHome(async (agentDir) => {
    const f = await fixture(agentDir);
    const settings = v3S3Settings({ include: ["settings.json", "AGENTS.md", "prompts"] });
    Object.assign(settings.syncSetups.home.sync, { automaticTransfer: true });
    await fs.writeFile(localConfigPath(), JSON.stringify(settings));
    const weak = { ...backendFacade(f.backend), capability: "read-check-write-verify" as const };
    await assert.rejects(
      syncBoth(f.ctx, { ...options, auto: true }, () => weak),
      /requires conditional/,
    );
  }));

test("automatic transfer accepts the S3 conditional-required capability at an established baseline", async () =>
  withTempHome(async (agentDir) => {
    const f = await fixture(agentDir);
    const settings = JSON.parse(await fs.readFile(localConfigPath(), "utf8"));
    settings.syncSetups.home.sync.automaticTransfer = true;
    await fs.writeFile(localConfigPath(), JSON.stringify(settings));
    assert.equal(f.config.backend.type, "s3");
    if (f.config.backend.type !== "s3") throw new Error("expected S3 fixture");
    const capability = new S3SyncBackend(f.config.backend).capability;
    const backend = { ...backendFacade(f.backend), capability };
    await fs.writeFile(path.join(agentDir, "AGENTS.md"), "local instructions\n");
    assert.equal(await syncBoth(f.ctx, { ...options, auto: true }, () => backend), "applied");
    const head = await f.backend.readHead();
    assert.notEqual(head?.snapshotId, f.baseHead.snapshotId);
    assert.equal((await readStateForConfig(f.config)).lastAppliedSnapshot, head?.snapshotId);
    assert.equal(await readMergeJournal(f.config), undefined);
  }));

test("merge journal is private and snapshots cannot select the operational files", async () =>
  withTempHome(async (agentDir) => {
    const f = await fixture(agentDir);
    await fs.writeFile(path.join(agentDir, "settings.json"), '{"local":true}\n');
    await f.remoteEdit("AGENTS.md", "remote\n");
    f.backend.failNextPublicationAfterCommit = true;
    await assert.rejects(syncBoth(f.ctx, options, () => f.backend));
    if (process.platform !== "win32") assert.equal((await fs.stat(mergeJournalPath(f.config))).mode & 0o777, 0o600);
    const local = await createSnapshot(f.config.snapshotIdentity, { include: f.config.include });
    assert.ok(local.files.every((file) => !file.path.includes("pi-sync") && !file.path.includes("journal")));
  }));

test("local apply and baseline-write fault boundaries recover without republishing", async () =>
  withTempHome(async (agentDir) => {
    const f = await fixture(agentDir);
    await fs.writeFile(path.join(agentDir, "settings.json"), '{"local":true}\n');
    await f.remoteEdit("AGENTS.md", "remote\n");
    await f.remoteEdit("prompts/new.md", "new\n");
    const originalRename = fs.rename.bind(fs);
    let failLocal = true;
    let failState = false;
    const spy = vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
      if (
        (failLocal && to === path.join(agentDir, "prompts/new.md")) ||
        (failState && to === statePathForConfig(f.config))
      ) {
        throw Object.assign(new Error("injected rename failure"), { code: "EACCES" });
      }
      return originalRename(from, to);
    });
    try {
      await assert.rejects(
        syncBoth(f.ctx, options, () => f.backend),
        /injected/,
      );
      assert.equal(await fs.readFile(path.join(agentDir, "AGENTS.md"), "utf8"), "remote\n");
      assert.ok(await readMergeJournal(f.config));
      const committedHead = await f.backend.readHead();
      const count = (await f.backend.listHistory()).length;
      failLocal = false;
      failState = true;
      await assert.rejects(
        syncBoth(f.ctx, options, () => f.backend),
        /injected/,
      );
      assert.equal(await fs.readFile(path.join(agentDir, "prompts/new.md"), "utf8"), "new\n");
      assert.ok(await readMergeJournal(f.config));
      failState = false;
      await syncBoth(f.ctx, options, () => f.backend);
      assert.equal(await readMergeJournal(f.config), undefined);
      assert.deepEqual(await f.backend.readHead(), committedHead);
      assert.equal((await f.backend.listHistory()).length, count);
    } finally {
      spy.mockRestore();
    }
  }));

for (const committed of [false, true])
  test(`cancellation ${committed ? "after" : "before"} backend commit retains safe recovery`, async () =>
    withTempHome(async (agentDir) => {
      const f = await fixture(agentDir);
      await fs.writeFile(path.join(agentDir, "settings.json"), '{"local":true}\n');
      await f.remoteEdit("AGENTS.md", "remote\n");
      const controller = new AbortController();
      const backend = {
        ...backendFacade(f.backend),
        publishSnapshot: async (s: Snapshot, e: ExpectedRemoteHead, o?: PublishSnapshotOptions) => {
          if (!committed) {
            controller.abort();
            throw controller.signal.reason;
          }
          const result = await f.backend.publishSnapshot(s, e, o);
          controller.abort();
          return result;
        },
      };
      await assert.rejects(syncBoth(f.ctx, { ...options, signal: controller.signal }, () => backend));
      assert.equal(await fs.readFile(path.join(agentDir, "AGENTS.md"), "utf8"), "original instructions\n");
      const count = (await f.backend.listHistory()).length;
      const result = await syncBoth(f.ctx, options, () => f.backend);
      assert.equal(result, committed ? "applied" : "cancelled");
      assert.equal((await f.backend.listHistory()).length, count);
      assert.equal(await readMergeJournal(f.config), undefined);
    }));

test("a reviewed force direction archives a stale journal without restoring newer bytes", async () =>
  withTempHome(async (agentDir) => {
    const f = await fixture(agentDir);
    await fs.writeFile(path.join(agentDir, "settings.json"), '{"local":true}\n');
    await f.remoteEdit("AGENTS.md", "remote\n");
    f.backend.failNextPublicationAfterCommit = true;
    await assert.rejects(syncBoth(f.ctx, options, () => f.backend));
    await fs.writeFile(path.join(agentDir, "AGENTS.md"), "newer chosen local\n");
    await assert.rejects(
      syncBoth(f.ctx, options, () => f.backend),
      /Local content changed/,
    );
    await push(f.ctx, { ...options, force: true }, undefined, () => f.backend);
    assert.equal(await readMergeJournal(f.config), undefined);
    assert.equal(await fs.readFile(path.join(agentDir, "AGENTS.md"), "utf8"), "newer chosen local\n");
    const archived = await fs.readdir(path.dirname(mergeJournalPath(f.config)));
    assert.ok(archived.some((name) => name.endsWith(".resolved")));
  }));

test("Pi exact-path mutation queues serialize apply behind a newer writer", async () =>
  withTempHome(async (agentDir) => {
    await fs.mkdir(agentDir, { recursive: true });
    const target = path.join(agentDir, "AGENTS.md");
    await fs.writeFile(target, "before");
    const before = snapshot([{ path: "AGENTS.md", content: Buffer.from("before") }]);
    const after = snapshot([{ path: "AGENTS.md", content: Buffer.from("approved") }]);
    const { withFileMutationQueue } = await import("@earendil-works/pi-coding-agent");
    const { applyMergedSnapshot } = await import("../src/sync/merge-apply.js");
    const { deferred } = await import("./startup-check-helpers.js");
    const held = deferred();
    const release = deferred();
    const writer = withFileMutationQueue(target, async () => {
      held.resolve();
      await release.promise;
      await fs.writeFile(target, "newer");
    });
    await held.promise;
    const applied = assert.rejects(
      applyMergedSnapshot(before, after, new Set(), { include: ["AGENTS.md"] }, async () => {}),
      /Local content changed/,
    );
    release.resolve();
    await writer;
    await applied;
    assert.equal(await fs.readFile(target, "utf8"), "newer");
  }));

test("literal prototype-named paths retain explicit missing-file semantics", async () =>
  withTempHome(async (agentDir) => {
    await fs.mkdir(agentDir, { recursive: true });
    const { applyMergedSnapshot } = await import("../src/sync/merge-apply.js");
    const before = snapshot([]);
    const after = snapshot([{ path: "constructor", content: Buffer.from("literal file") }]);
    await applyMergedSnapshot(before, after, new Set(), { include: ["constructor"] }, async () => {});
    assert.equal(await fs.readFile(path.join(agentDir, "constructor"), "utf8"), "literal file");
  }));

for (const kind of ["symlink", "hardlink"] as const)
  test(`filesystem ${kind} review barriers precede combined publication`, async () =>
    withTempHome(async (agentDir) => {
      const f = await fixture(agentDir);
      const outside = path.join(path.dirname(agentDir), "outside");
      await fs.mkdir(outside, { recursive: true });
      if (kind === "symlink") {
        await fs.mkdir(path.join(agentDir, "prompts"), { recursive: true });
        await fs.symlink(outside, path.join(agentDir, "prompts/linked"), "dir");
        await f.remoteEdit("prompts/linked/incoming.md", "incoming");
      } else {
        await fs.link(path.join(agentDir, "AGENTS.md"), path.join(outside, "linked.md"));
        await f.remoteEdit("AGENTS.md", "incoming");
      }
      await fs.writeFile(path.join(agentDir, "settings.json"), '{"local":true}');
      const publish = vi.spyOn(f.backend, "publishSnapshot");
      try {
        await assert.rejects(
          syncBoth(f.ctx, options, () => f.backend),
          /filesystem layout|hard-linked/,
        );
        assert.equal(publish.mock.calls.length, 0);
        assert.equal(await readMergeJournal(f.config), undefined);
        assert.equal(await fs.readFile(path.join(agentDir, "AGENTS.md"), "utf8"), "original instructions\n");
      } finally {
        publish.mockRestore();
      }
    }));

test("same-manager in-memory session replacement cancels reviewed authorization", async () =>
  withTempHome(async (agentDir) => {
    const f = await fixture(agentDir);
    await fs.writeFile(path.join(agentDir, "settings.json"), '{"local":true}');
    await f.remoteEdit("AGENTS.md", "remote");
    let id = "original";
    const context = createMockContext({
      mode: "rpc",
      select: async (_title: string, choices: string[]) => {
        id = "replacement";
        return choices.find((choice) => choice.startsWith("Yes,"));
      },
    });
    Object.defineProperty((context.ctx as ExtensionContext).sessionManager, "getSessionId", { value: () => id });
    const publish = vi.spyOn(f.backend, "publishSnapshot");
    try {
      assert.equal(await syncBoth(context.ctx, { ...options, yes: false }, () => f.backend), "cancelled");
      assert.equal(publish.mock.calls.length, 0);
      assert.equal(await readMergeJournal(f.config), undefined);
    } finally {
      publish.mockRestore();
    }
  }));
