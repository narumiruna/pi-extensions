import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "vitest";
import { expectedRemoteHead, type RemoteHead, type SyncBackend } from "../src/engine/backends/sync-backend.js";
import type { CommandOptions } from "../src/engine/commands/command-types.js";
import { configureEngineHost, type EngineContext } from "../src/engine/host.js";
import { loadConfig } from "../src/engine/settings/config.js";
import { snapshotOptionsForContext } from "../src/engine/snapshot/session-paths.js";
import { createSnapshot } from "../src/engine/snapshot/snapshot.js";
import type { Snapshot, SnapshotFile } from "../src/engine/snapshot/snapshot-types.js";
import { readStateForConfig } from "../src/engine/state/sync-state-store.js";
import { applyMergedSnapshot, preflightMergedTargets } from "../src/engine/sync/merge-apply.js";
import { inspectSync } from "../src/engine/sync/sync-inspection.js";
import { push, rollback, syncBoth } from "../src/engine/sync/sync-mutations.js";

const options: CommandOptions = {
  args: [],
  auto: false,
  force: false,
  reload: false,
  silent: true,
  stale: false,
  yes: true,
};

function file(path: string, content: string | Buffer): SnapshotFile {
  const bytes = typeof content === "string" ? Buffer.from(content) : content;
  return { path, contentBase64: bytes.toString("base64"), sha256: createHash("sha256").update(bytes).digest("hex") };
}

function remoteFixture() {
  let head: RemoteHead | undefined;
  const history = new Map<string, Snapshot>();
  const publications: Snapshot[] = [];
  const seed = (snapshot: Snapshot): RemoteHead => {
    history.set(snapshot.id, snapshot);
    head = {
      snapshotId: snapshot.id,
      snapshotRef: snapshot.id,
      revision: snapshot.id,
      createdAt: snapshot.createdAt,
      machine: snapshot.machine,
      syncSessions: snapshot.syncSessions ?? false,
      selection: snapshot.selection,
    };
    return head;
  };
  const backend: SyncBackend = {
    identity: "memory",
    destination: "memory",
    capability: "atomic-conditional",
    sameRevision: (left, right) => left === right,
    readHead: async () => head,
    readSnapshot: async (ref) => {
      const snapshot = history.get(ref);
      assert.ok(snapshot);
      return snapshot;
    },
    publishSnapshot: async (snapshot, expected, opts) => {
      assert.deepEqual(expected, expectedRemoteHead(head));
      opts?.onCommit?.();
      publications.push(snapshot);
      return { head: seed(snapshot), warnings: [] };
    },
    diagnose: async () => [],
    listHistory: async () => [],
  };
  return { backend, factory: async () => backend, seed, history, publications };
}

async function fixture(
  run: (root: string, ctx: EngineContext, remote: ReturnType<typeof remoteFixture>) => Promise<void>,
) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "pi-sync-directory-operations-")));
  try {
    configureEngineHost({
      root: () => root,
      mutate: async (_target, action) => action(),
      review: async () => true,
    });
    const ctx: EngineContext = {
      cwd: root,
      mode: "rpc",
      hasUI: true,
      sessionManager: { getSessionDir: () => path.join(root, "conversations") },
      isIdle: () => true,
      modelRegistry: { streamSimple: () => assert.fail("Unexpected model request.") },
      ui: { notify() {}, setStatus() {}, confirm: async () => true, select: async () => undefined },
    };
    await fs.writeFile(
      path.join(root, "pi-sync.json"),
      JSON.stringify({
        version: 7,
        activeSyncSetup: "work",
        onSwitch: "switch-only",
        storageConnections: { memory: { type: "git", remote: "https://example.invalid/pi-sync.git" } },
        syncSetups: {
          work: {
            storage: { connection: "memory", path: "test", branch: "main" },
            sync: {
              scope: "agent-directory",
              exclude: ["cache"],
              reinclude: ["cache/keep.txt"],
              automatic: false,
              partialSync: true,
            },
          },
        },
      }),
      { mode: 0o600 },
    );
    await run(root, ctx, remoteFixture());
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

const historical = (files: SnapshotFile[]): Snapshot => ({
  version: 1,
  id: "2026-01-01T00-00-00-000Z-11111111",
  createdAt: "2026-01-01T00:00:00.000Z",
  machine: "fixture",
  profile: "test",
  syncSessions: false,
  selection: { version: 1, include: ["notes.txt"] },
  files,
});

test("an empty explicit include still inspects, publishes and merges a scoped selection", () =>
  fixture(async (root, ctx, remote) => {
    await fs.mkdir(path.join(root, "cache"));
    await fs.mkdir(path.join(root, "conversations"));
    await fs.writeFile(path.join(root, "notes.txt"), "local");
    await fs.writeFile(path.join(root, "cache/keep.txt"), "selected");
    await fs.writeFile(path.join(root, "cache/private.txt"), "excluded");
    await fs.writeFile(path.join(root, "conversations/private.jsonl"), "private conversation");
    await fs.writeFile(path.join(root, "auth.json"), "local credentials");
    const config = await loadConfig();
    assert.deepEqual(config.include, []);
    const inspection = await inspectSync(config, snapshotOptionsForContext(ctx, config), undefined, remote.factory);
    assert.equal(inspection.emptyInclude, false);
    assert.equal(inspection.localFiles, 2);

    await syncBoth(ctx, options, remote.factory);
    const initial = remote.publications[0];
    assert.ok(initial);
    assert.equal(initial.version, 5);
    assert.equal(initial.selection?.version, 3);
    assert.deepEqual(
      initial.files.map((entry) => entry.path),
      ["cache/keep.txt", "notes.txt"],
    );
    const accepted = await readStateForConfig(config);
    assert.equal(accepted.scope, "agent-directory");
    assert.deepEqual(accepted.reinclude, ["cache/keep.txt"]);

    await fs.writeFile(path.join(root, "notes.txt"), "local edit");
    remote.seed({ ...initial, id: "remote-edit", files: [...initial.files, file("custom.txt", "remote edit")] });
    assert.equal(await syncBoth(ctx, options, remote.factory), "applied");
    assert.equal(await fs.readFile(path.join(root, "custom.txt"), "utf8"), "remote edit");
    assert.equal(await fs.readFile(path.join(root, "cache/private.txt"), "utf8"), "excluded");
    const merged = remote.publications[1];
    assert.ok(merged);
    assert.equal(merged.version, 5);
    assert.equal(merged.selection?.version, 3);
    assert.deepEqual(
      merged.files.map((entry) => entry.path),
      ["cache/keep.txt", "custom.txt", "notes.txt"],
    );
  }));

for (const branch of ["remote only", "matching local subset"]) {
  for (const change of ["none", "local", "remote", "remote after review check", "settings", "session storage"]) {
    test(`first sync with ${branch} ${change === "none" ? "pulls unchanged sources" : `rejects changed ${change}`}`, () =>
      fixture(async (root, ctx, remote) => {
        const target = path.join(root, "notes.txt");
        const subset = branch === "matching local subset";
        if (subset) await fs.writeFile(target, "reviewed");
        const config = await loadConfig();
        const snapshot: Snapshot = {
          ...historical([file("notes.txt", "reviewed"), file("shared.txt", "new remote content")]),
          version: 5,
          profile: config.snapshotIdentity,
          selection: {
            version: 3,
            scope: "agent-directory",
            include: [],
            exclude: ["cache"],
            reinclude: ["cache/keep.txt"],
          },
        };
        const head = remote.seed(snapshot);
        const advanceRemote = () =>
          remote.seed({ ...snapshot, id: "advanced-remote", files: [file("notes.txt", "new remote content")] });
        let opens = 0;
        if (change === "remote after review check") {
          const readHead = remote.backend.readHead;
          let pullReads = 0;
          remote.backend.readHead = async (signal) => {
            const observed = await readHead(signal);
            // The first pull read opens its snapshot; the second checks freshness before backup.
            if (opens === 2 && ++pullReads === 2) advanceRemote();
            return observed;
          };
        }
        let commits = 0;
        const sync = syncBoth(ctx, { ...options, onCommit: () => commits++ }, async () => {
          // The second open happens after syncBoth has chosen the initial source.
          if (++opens === 2) {
            if (change === "local") await fs.writeFile(target, "new local content");
            if (change === "remote") advanceRemote();
            if (change === "settings") {
              const settingsPath = path.join(root, "pi-sync.json");
              const settings = JSON.parse(await fs.readFile(settingsPath, "utf8"));
              settings.syncSetups.work.sync.reinclude = [];
              await fs.writeFile(settingsPath, JSON.stringify(settings));
            }
            if (change === "session storage")
              ctx.sessionManager.getSessionDir = () => path.join(root, "other-sessions");
          }
          return remote.backend;
        });
        if (change === "none") {
          await sync;
          assert.equal(commits, 1);
          assert.equal(await fs.readFile(target, "utf8"), "reviewed");
          assert.equal((await readStateForConfig(config)).lastAppliedSnapshot, head.snapshotId);
        } else {
          await assert.rejects(sync, /(?:initial pull|during pull review)/u);
          assert.equal(commits, 0);
          assert.equal((await readStateForConfig(config)).lastAppliedSnapshot, undefined);
          assert.equal(
            await fs.readFile(target, "utf8").catch(() => undefined),
            change === "local" ? "new local content" : subset ? "reviewed" : undefined,
          );
          await assert.rejects(fs.stat(path.join(root, "shared.txt")), { code: "ENOENT" });
        }
        assert.equal(remote.publications.length, 0);
      }));
  }
}

for (const reviewed of [true, false]) {
  test(`scoped merge ${reviewed ? "defers" : "refuses"} a nested target blocked by a ${reviewed ? "reviewed" : "different"} file`, () =>
    fixture(async (root, ctx) => {
      const ancestor = path.join(root, "work");
      await fs.writeFile(ancestor, "blocking file");
      await fs.writeFile(path.join(root, "notes.txt"), "unrelated reviewed removal");
      const config = await loadConfig();
      const snapshotOptions = snapshotOptionsForContext(ctx, config);
      const before = await createSnapshot(config.snapshotIdentity, snapshotOptions);
      if (!reviewed) before.files = before.files.filter((entry) => entry.path !== "work");
      const after = { ...before, files: [file("work/sub/item.txt", "nested")] };
      if (!reviewed) {
        await assert.rejects(preflightMergedTargets(before, after, snapshotOptions), /Unsafe merge filesystem layout/u);
        assert.equal(await fs.readFile(ancestor, "utf8"), "blocking file");
        assert.equal(await fs.readFile(path.join(root, "notes.txt"), "utf8"), "unrelated reviewed removal");
        return;
      }
      await preflightMergedTargets(before, after, snapshotOptions);
      assert.equal(await fs.readFile(ancestor, "utf8"), "blocking file");
      await applyMergedSnapshot(before, after, new Set(), snapshotOptions, async () => {});
      assert.equal(await fs.readFile(path.join(ancestor, "sub/item.txt"), "utf8"), "nested");
      // The same committed plan can recover after the replacement already landed.
      await applyMergedSnapshot(before, after, new Set(), snapshotOptions, async () => {});
    }));
}

test("scoped merge counts protected session bytes at review and at recovery", () =>
  fixture(async (root, ctx) => {
    const config = await loadConfig();
    const snapshotOptions = { ...snapshotOptionsForContext(ctx, config), include: ["sessions"] };
    const sessionDir = path.join(root, "conversations");
    const session = path.join(sessionDir, "protected.jsonl");
    const sessionPath = "sessions/protected.jsonl";
    await fs.mkdir(sessionDir);
    await fs.writeFile(session, Buffer.alloc(1024 * 1024));
    const before = await createSnapshot(config.snapshotIdentity, snapshotOptions);
    assert.deepEqual(
      before.files.map((entry) => entry.path),
      [sessionPath],
    );
    const incoming = file("incoming.txt", Buffer.alloc(63 * 1024 * 1024));
    const after = { ...before, files: [...before.files, incoming] };
    // The reviewed directory is exactly 64 MiB and the protected session is unchanged in the plan.
    await preflightMergedTargets(before, after, snapshotOptions, session);
    await fs.appendFile(session, Buffer.alloc(1024 * 1024));
    const larger = await createSnapshot(config.snapshotIdentity, snapshotOptions);
    await assert.rejects(
      preflightMergedTargets(larger, { ...after, files: [...larger.files, incoming] }, snapshotOptions, session),
      /exceeds the 64 MiB scan byte bound/u,
    );
    await assert.rejects(
      applyMergedSnapshot(before, after, new Set([sessionPath]), snapshotOptions, async () => {}, session),
      /exceeds the 64 MiB scan byte bound/u,
    );
    assert.equal((await fs.stat(session)).size, 2 * 1024 * 1024);
    await assert.rejects(fs.stat(path.join(root, "incoming.txt")), { code: "ENOENT" });
  }));

test("a force push cannot convert an existing allowlist remote to directory scope", () =>
  fixture(async (root, ctx, remote) => {
    await fs.writeFile(path.join(root, "notes.txt"), "local");
    remote.seed(historical([file("notes.txt", "remote")]));
    await assert.rejects(
      push(ctx, { ...options, force: true }, undefined, remote.factory),
      /Converting an existing remote/u,
    );
    assert.equal(remote.publications.length, 0);
    assert.equal((await readStateForConfig(await loadConfig())).lastAppliedSnapshot, undefined);
  }));

test("a rule change during reviewed push prevents publication", () =>
  fixture(async (root, ctx, remote) => {
    await fs.writeFile(path.join(root, "notes.txt"), "local");
    let review = "";
    ctx.ui.confirm = async (_title, content) => {
      review = content;
      const settingsPath = path.join(root, "pi-sync.json");
      const settings = JSON.parse(await fs.readFile(settingsPath, "utf8"));
      settings.syncSetups.work.sync.reinclude = [];
      await fs.writeFile(settingsPath, JSON.stringify(settings));
      return true;
    };
    await assert.rejects(
      push(ctx, { ...options, yes: false }, undefined, remote.factory),
      /Settings changed during push review/u,
    );
    assert.match(review, /scanner cannot identify/u);
    assert.equal(remote.publications.length, 0);
  }));

test("rollback projects legacy history without applying or publishing credentials, trust, or a physical session alias", () =>
  fixture(async (root, ctx, remote) => {
    await fs.mkdir(path.join(root, "conversations"));
    const protectedPaths = [
      "auth.json",
      "auth.json.lock",
      "trust.json",
      "trust.json.lock",
      "conversations/private.jsonl",
    ];
    for (const relative of protectedPaths) await fs.writeFile(path.join(root, relative), "original");
    await fs.writeFile(path.join(root, "notes.txt"), "current");
    await push(ctx, options, undefined, remote.factory);
    const snapshot = historical([
      file("notes.txt", "historic"),
      ...protectedPaths.map((relative) => file(relative, "do not apply")),
    ]);
    remote.history.set(snapshot.id, snapshot);
    await rollback(ctx, { ...options, args: [snapshot.id] }, remote.factory);
    assert.equal(await fs.readFile(path.join(root, "notes.txt"), "utf8"), "historic");
    for (const relative of protectedPaths)
      assert.equal(await fs.readFile(path.join(root, relative), "utf8"), "original");
    assert.deepEqual(
      remote.publications[1]?.files.map((entry) => entry.path),
      ["notes.txt"],
    );
  }));
