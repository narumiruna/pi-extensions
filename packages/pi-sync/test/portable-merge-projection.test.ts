import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { test, vi } from "vitest";
import { createMockContext } from "../../../test/support.js";
import { loadConfig } from "../src/settings/config.js";
import { localConfigPath } from "../src/settings/config-file.js";
import { createSnapshot, regenerateSnapshotIdentity } from "../src/snapshot/snapshot.js";
import { readMergeAncestor } from "../src/state/merge-baseline-store.js";
import {
  readStateForConfig,
  statePathForConfig,
  syncStateFingerprint,
  writeStateForConfig,
} from "../src/state/sync-state-store.js";
import { overlayLocalFields, portableSnapshot } from "../src/sync/local-fields.js";
import { mergeJournalIdentity, readMergeJournal, writeMergeJournal } from "../src/sync/merge-journal.js";
import { push, syncBoth } from "../src/sync/sync-mutations.js";
import { diff } from "../src/sync/sync-queries.js";
import { fileHashMap, hasLocalChanges, hasRemoteChanges } from "../src/sync/sync-state.js";
import { snapshot, v3S3Settings, withTempHome } from "./helpers.js";
import { MemorySyncBackend } from "./memory-sync-backend.js";
import { mergeOptions as options } from "./merge-options.js";

async function fixture(root: string) {
  await fs.mkdir(root, { recursive: true });
  const settings = v3S3Settings({ include: ["settings.json", "AGENTS.md"] });
  Object.assign(settings.syncSetups.home.sync, { mergeSettings: true, localFields: ["machine"] });
  await fs.writeFile(localConfigPath(), JSON.stringify({ ...settings, version: 4 }));
  await fs.writeFile(path.join(root, "settings.json"), '{"theme":"base","machine":"local-private"}');
  await fs.writeFile(path.join(root, "AGENTS.md"), "base instructions");
  const { ctx, notifications } = createMockContext({ hasUI: true });
  const backend = new MemorySyncBackend();
  await push(ctx, options, undefined, () => backend);
  const config = await loadConfig();
  const state = await readStateForConfig(config);
  const head = await backend.readHead();
  assert.ok(head);
  const base = await backend.readSnapshot(head.snapshotRef);
  return { ctx, notifications, backend, config, state, head, base };
}

for (const first of [false, true])
  test(`pretty portable equality keeps the remote head and canonical baseline (first: ${first})`, async () =>
    withTempHome(async (root) => {
      const f = await fixture(root);
      const pretty = regenerateSnapshotIdentity({
        ...f.base,
        files: [
          ...f.base.files.filter((file) => file.path !== "settings.json"),
          ...snapshot([{ path: "settings.json", content: Buffer.from('{\n  "theme": "base"\n}\n') }]).files,
        ],
      });
      const head = (await f.backend.publishSnapshot(pretty, { kind: "revision", revision: f.head.revision })).head;
      if (first) await fs.rm(statePathForConfig(f.config));
      const publish = vi.spyOn(f.backend, "publishSnapshot");
      await syncBoth(f.ctx, options, () => f.backend);
      const state = await readStateForConfig(f.config);
      assert.equal(state.lastAppliedSnapshot, head.snapshotId);
      assert.equal(
        hasLocalChanges(
          await createSnapshot(f.config.snapshotIdentity, { include: f.config.include }),
          state,
          f.config,
        ),
        false,
      );
      assert.equal(hasRemoteChanges(pretty, state, f.config), false);
      f.notifications.length = 0;
      await diff(f.ctx as Parameters<typeof diff>[0], options, () => f.backend);
      assert.match(f.notifications.map(({ message }) => message).join("\n"), /No file differences/);
      await syncBoth(f.ctx, options, () => f.backend);
      assert.equal(publish.mock.calls.length, 0);
      assert.deepEqual(await f.backend.readHead(), head);
      assert.deepEqual(
        (await readStateForConfig(f.config)).lastFileHashes,
        fileHashMap(portableSnapshot(pretty, ["machine"])),
      );
      publish.mockRestore();
    }));

for (const interrupted of [false, true])
  test(`portable field merge records canonical accepted bytes (interrupted: ${interrupted})`, async () =>
    withTempHome(async (root) => {
      const f = await fixture(root);
      await fs.writeFile(path.join(root, "settings.json"), '{"theme":"local","machine":"local-private"}');
      await f.backend.publishSnapshot(
        regenerateSnapshotIdentity({
          ...f.base,
          files: [
            ...f.base.files.filter((file) => file.path !== "settings.json"),
            ...snapshot([{ path: "settings.json", content: Buffer.from('{"alpha":"remote","theme":"base"}\n') }]).files,
          ],
        }),
        { kind: "revision", revision: f.head.revision },
      );
      if (interrupted) {
        f.backend.failNextPublicationAfterCommit = true;
        await assert.rejects(
          syncBoth(f.ctx, options, () => f.backend),
          /interrupted/,
        );
        assert.ok(await readMergeJournal(f.config));
      }
      await syncBoth(f.ctx, options, () => f.backend);
      const state = await readStateForConfig(f.config);
      const local = await createSnapshot(f.config.snapshotIdentity, { include: f.config.include });
      assert.equal(hasLocalChanges(local, state, f.config), false);
      assert.deepEqual(JSON.parse(await fs.readFile(path.join(root, "settings.json"), "utf8")), {
        theme: "local",
        machine: "local-private",
        alpha: "remote",
      });
      assert.equal(
        (await readMergeAncestor(f.config, state, "settings.json"))?.toString(),
        '{"alpha":"remote","theme":"local"}\n',
      );
      const head = await f.backend.readHead();
      await syncBoth(f.ctx, options, () => f.backend);
      assert.deepEqual(await f.backend.readHead(), head);
      assert.equal(await readMergeJournal(f.config), undefined);
    }));

for (const mode of ["pending", "accepted", "advanced"] as const)
  test(`legacy pretty portable journal recovery: ${mode}`, async () =>
    withTempHome(async (root) => {
      const f = await fixture(root);
      const before = await createSnapshot(f.config.snapshotIdentity, { include: f.config.include });
      const accepted = regenerateSnapshotIdentity({
        ...f.base,
        files: [
          ...f.base.files.filter((file) => file.path !== "settings.json"),
          ...snapshot([
            {
              path: "settings.json",
              content: Buffer.from('{\n  "theme": "remote",\n  "alpha": {"z": 1, "a": 2}\n}\n'),
            },
          ]).files,
        ],
      });
      const after = overlayLocalFields(accepted, before, ["machine"]);
      const result = await f.backend.publishSnapshot(accepted, { kind: "revision", revision: f.head.revision });
      const journal = {
        version: 1 as const,
        identity: mergeJournalIdentity(f.config, f.backend.identity),
        before,
        after,
        accepted,
        upload: accepted,
        expectedHead: f.head,
        committedHead: result.head,
        backup: "retained-private-backup",
        stateIdentity: syncStateFingerprint(f.state),
      };
      await writeMergeJournal(f.config, journal);
      assert.deepEqual(await readMergeJournal(f.config), journal);
      const completed = mode !== "pending";
      if (completed) {
        await writeStateForConfig(f.config, {
          ...f.state,
          lastAppliedSnapshot: result.head.snapshotId,
          lastRemoteRevision: result.head.revision,
          lastFileHashes: fileHashMap(accepted),
        });
        await fs.writeFile(path.join(root, "settings.json"), '{"theme":"newer","machine":"newer-private"}');
      }
      if (mode === "advanced")
        await f.backend.publishSnapshot(
          regenerateSnapshotIdentity({
            ...accepted,
            files: accepted.files.filter((file) => file.path !== "AGENTS.md"),
          }),
          { kind: "revision", revision: result.head.revision },
        );
      await syncBoth(f.ctx, options, () => f.backend);
      assert.equal(await readMergeJournal(f.config), undefined);
      const local = await createSnapshot(f.config.snapshotIdentity, { include: f.config.include });
      if (completed) {
        assert.equal(
          await fs.readFile(path.join(root, "settings.json"), "utf8"),
          '{"theme":"newer","machine":"newer-private"}',
        );
      } else {
        const state = await readStateForConfig(f.config);
        assert.equal(hasLocalChanges(local, state, f.config), false);
        assert.deepEqual(state.lastFileHashes, fileHashMap(portableSnapshot(after, ["machine"])));
        assert.equal(JSON.parse(await fs.readFile(path.join(root, "settings.json"), "utf8")).machine, "local-private");
        await syncBoth(f.ctx, options, () => f.backend);
        assert.equal(
          hasLocalChanges(
            await createSnapshot(f.config.snapshotIdentity, { include: f.config.include }),
            await readStateForConfig(f.config),
            f.config,
          ),
          false,
        );
      }
      await writeMergeJournal(f.config, { ...journal, accepted: portableSnapshot(before, ["machine"]) });
      await assert.rejects(readMergeJournal(f.config), /Invalid accepted merge projection/);
    }));
