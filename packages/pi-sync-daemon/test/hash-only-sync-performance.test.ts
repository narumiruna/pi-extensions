import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test, vi } from "vitest";
import { expectedRemoteHead, type RemoteHead, type SyncBackend } from "../src/engine/backends/sync-backend.js";
import type { CommandOptions } from "../src/engine/commands/command-types.js";
import { configureEngineHost, type EngineContext } from "../src/engine/host.js";
import { configFromSettings, loadConfig } from "../src/engine/settings/config.js";
import { resolvedSnapshotOptionsForContext } from "../src/engine/snapshot/session-paths.js";
import { createSnapshot, observeSnapshot } from "../src/engine/snapshot/snapshot.js";
import type { Snapshot } from "../src/engine/snapshot/snapshot-types.js";
import { readStateForConfig, writeStateForConfig } from "../src/engine/state/sync-state-store.js";
import { portableSnapshot } from "../src/engine/sync/local-fields.js";
import { acceptedState } from "../src/engine/sync/merge-acceptance.js";
import { readMergeJournal } from "../src/engine/sync/merge-journal.js";
import { mergeSync } from "../src/engine/sync/merged-sync.js";
import { inspectSync } from "../src/engine/sync/sync-inspection.js";
import { fileHashMap, hasLocalChanges } from "../src/engine/sync/sync-state.js";

const commandOptions: CommandOptions = {
  args: [],
  auto: false,
  force: false,
  reload: false,
  silent: true,
  stale: false,
  yes: false,
};
const settingsBytes = '{ "theme": "local A", "nested": { "z": 1, "a": 2 } }\n';
const sentinel = Buffer.from([0, 0, 43, 125, 190, 255]);

function document(scope?: "agent-directory") {
  return {
    version: 7 as const,
    activeSyncSetup: "work",
    onSwitch: "switch-only" as const,
    storageConnections: { memory: { type: "git" as const, remote: "https://example.invalid/sync.git" } },
    syncSetups: {
      work: {
        storage: { connection: "memory", path: "work", branch: "main" },
        sync: {
          ...(scope ? { scope } : { include: ["settings.json", "a.txt", "blob.dat"] }),
          automatic: true,
          automaticTransfer: true,
          agentMode: true,
          continuous: true,
          localFields: ["theme"],
        },
      },
    },
  };
}

function remoteFixture(initial: Snapshot) {
  let snapshot = initial;
  const head = (): RemoteHead => ({
    snapshotId: snapshot.id,
    snapshotRef: snapshot.id,
    revision: snapshot.id,
    createdAt: snapshot.createdAt,
    machine: snapshot.machine,
    selection: snapshot.selection,
    syncSessions: snapshot.syncSessions ?? false,
  });
  const publishSnapshot = vi.fn<SyncBackend["publishSnapshot"]>(async (candidate, expected, opts) => {
    assert.deepEqual(expected, expectedRemoteHead(head()));
    await opts?.validatePublication?.();
    opts?.onCommit?.();
    snapshot = candidate;
    return { head: head(), warnings: [] };
  });
  const readSnapshot = vi.fn<SyncBackend["readSnapshot"]>(async (ref) => {
    assert.equal(ref, snapshot.id);
    return snapshot;
  });
  const backend: SyncBackend = {
    identity: "memory",
    destination: "memory",
    capability: "atomic-conditional",
    readHead: async () => head(),
    readSnapshot,
    publishSnapshot,
    sameRevision: (left, right) => left === right,
    diagnose: async () => [],
    listHistory: async () => [],
  };
  return {
    factory: async () => backend,
    head,
    readSnapshot,
    publishSnapshot,
    advance: (next: Snapshot) => {
      snapshot = next;
    },
  };
}

async function fixture(run: (root: string, ctx: EngineContext) => Promise<void>) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "pi-sync-hash-only-")));
  try {
    configureEngineHost({ root: () => root, mutate: async (_target, action) => action(), review: async () => true });
    const ctx: EngineContext = {
      cwd: root,
      mode: "rpc",
      hasUI: true,
      sessionManager: { usesDefaultSessionDir: () => true },
      isIdle: () => true,
      modelRegistry: { streamSimple: () => assert.fail("Unexpected model request") },
      ui: { notify() {}, setStatus() {}, confirm: async () => true, select: async () => undefined },
    };
    await fs.writeFile(path.join(root, "settings.json"), settingsBytes);
    await fs.writeFile(path.join(root, "blob.dat"), sentinel);
    await fs.writeFile(path.join(root, "a.txt"), "baseline");
    await run(root, ctx);
  } finally {
    vi.restoreAllMocks();
    await fs.rm(root, { recursive: true, force: true });
  }
}

function countSentinelEncodes(scanBuffersOnly = false) {
  const convert = Buffer.prototype.toString;
  const allocations = new WeakSet<Buffer>();
  if (scanBuffersOnly) {
    const allocate = Buffer.alloc;
    vi.spyOn(Buffer, "alloc").mockImplementation((...args) => {
      const buffer = allocate(...args);
      if (buffer.length === sentinel.length) allocations.add(buffer);
      return buffer;
    });
  }
  let encodes = 0;
  vi.spyOn(Buffer.prototype, "toString").mockImplementation(function (this: Buffer, ...args) {
    if (args[0] === "base64" && (!scanBuffersOnly || allocations.has(this)) && this.equals(sentinel)) encodes++;
    return convert.apply(this, args);
  });
  return () => encodes;
}

for (const selection of ["selected", "directory"] as const) {
  test(`hash-only ${selection} inspection preserves ordered raw hashes and portable change detection`, () =>
    fixture(async (root, _ctx) => {
      const scoped = selection === "selected" ? undefined : "agent-directory";
      const base = configFromSettings(document(scoped));
      const config = base;
      const snapshotOptions = { include: config.include, scope: config.scope };
      await fs.writeFile(path.join(root, "scratch.omit"), "outside selected paths");
      const local = await createSnapshot(config.snapshotIdentity, snapshotOptions);
      const accepted = portableSnapshot(local, config.localFields);
      const remote = remoteFixture(accepted);
      await writeStateForConfig(config, acceptedState(config, remote.head(), accepted));
      const encodes = countSentinelEncodes();
      const first = await inspectSync(config, snapshotOptions, undefined, remote.factory);
      assert.equal(first.localChanged, false);
      assert.equal(first.remoteChanged, false);
      assert.equal(first.localFiles, local.files.length);
      assert.equal(
        first.localIdentity,
        createHash("sha256")
          .update(JSON.stringify(fileHashMap(local)))
          .digest("hex"),
      );
      assert.equal(encodes(), 0);

      await fs.writeFile(path.join(root, "settings.json"), settingsBytes.replace("local A", "local B"));
      const machineOnly = await inspectSync(config, snapshotOptions, undefined, remote.factory);
      assert.notEqual(machineOnly.localIdentity, first.localIdentity);
      assert.equal(machineOnly.localChanged, false);
      await fs.writeFile(path.join(root, "a.txt"), "modified"); // Same size as the accepted file.
      const changed = await inspectSync(config, snapshotOptions, undefined, remote.factory);
      assert.notEqual(changed.localIdentity, machineOnly.localIdentity);
      assert.equal(changed.localChanged, true);
      assert.equal(encodes(), 0);
      assert.equal(remote.readSnapshot.mock.calls.length, 0);
    }));
}

test("hash-only inspection preserves malformed settings projection and policy short-circuit ordering", () =>
  fixture(async (root, ctx) => {
    const config = configFromSettings(document("agent-directory"));
    const options = await resolvedSnapshotOptionsForContext(ctx, config);
    const clean = createSnapshot(config.snapshotIdentity, options);
    const remote = remoteFixture(portableSnapshot(await clean, config.localFields));
    const state = acceptedState(config, remote.head(), await clean);
    await writeStateForConfig(config, state);
    await fs.writeFile(path.join(root, "settings.json"), '{"theme": 1, "theme": 2}');
    const malformed = await createSnapshot(config.snapshotIdentity, options);
    assert.throws(() => hasLocalChanges(malformed, state, config), /unsupported settings json syntax/i);
    await assert.rejects(inspectSync(config, options, undefined, remote.factory), /unsupported settings json syntax/i);
    await writeStateForConfig(config, { ...state, localFields: [] });
    assert.equal((await inspectSync(config, options, undefined, remote.factory)).localChanged, true);

    await fs.rm(path.join(root, "settings.json"));
    await fs.writeFile(path.join(root, "SETTINGS.JSON"), settingsBytes);
    await writeStateForConfig(config, state);
    const noncanonical = await createSnapshot(config.snapshotIdentity, options);
    assert.ok(!noncanonical.files.some((entry) => entry.path.toLowerCase() === "settings.json"));
    const observed = await inspectSync(config, options, undefined, remote.factory);
    assert.equal(observed.localFiles, noncanonical.files.length);
    assert.equal(observed.localChanged, true);
    await fs.rm(path.join(root, "SETTINGS.JSON"));
    await fs.writeFile(path.join(root, "settings.json"), "{");
    await assert.rejects(
      inspectSync(config, { ...options, sessionDir: undefined }, undefined, remote.factory),
      /cannot be parsed/i,
    );
  }));

test("hash-only guarded reads reject a replaced path and close on cancellation", () =>
  fixture(async (root) => {
    const target = path.join(root, "blob.dat");
    const open = fs.open.bind(fs);
    const cancel = new AbortController();
    const abort = new Error("cancel during guarded read");
    const options = { scope: "agent-directory" as const, sessionDir: path.join(root, "sessions") };
    const spy = vi.spyOn(fs, "open").mockImplementation(async (name, flags, mode) => {
      const handle = await open(name, flags, mode);
      if (name === target) {
        await fs.rename(target, path.join(root, "original.dat"));
        await fs.writeFile(target, sentinel);
      }
      return handle;
    });
    await assert.rejects(observeSnapshot(options), /unsafe filesystem layout/i);
    let closed = false;
    spy.mockImplementation(async (name, flags, mode) => {
      const handle = await open(name, flags, mode);
      if (name === target) {
        const close = handle.close.bind(handle);
        handle.close = async () => {
          await close();
          closed = true;
        };
        cancel.abort(abort);
      }
      return handle;
    });
    await assert.rejects(observeSnapshot({ ...options, signal: cancel.signal }), (error) => error === abort);
    assert.equal(closed, true);
  }));

async function mergeFixture(
  run: (fixture: {
    root: string;
    ctx: EngineContext;
    config: Awaited<ReturnType<typeof loadConfig>>;
    remote: ReturnType<typeof remoteFixture>;
  }) => Promise<void>,
  continuous = true,
) {
  return fixture(async (root, ctx) => {
    const selected = document("agent-directory");
    if (!continuous) {
      selected.syncSetups.work.sync.continuous = false;
      selected.syncSetups.work.sync.agentMode = false;
    }
    await fs.writeFile(path.join(root, "pi-sync.json"), JSON.stringify(selected), { mode: 0o600 });
    const config = await loadConfig();
    const raw = await createSnapshot(config.snapshotIdentity, await resolvedSnapshotOptionsForContext(ctx, config));
    const initial = portableSnapshot(raw, config.localFields);
    const remote = remoteFixture(initial);
    await writeStateForConfig(config, acceptedState(config, remote.head(), initial), initial);
    await run({ root, ctx, config, remote });
  });
}

for (const phase of ["review", "backup", "cancel"] as const) {
  test(`merged sync does not use reviewed bytes as approval after ${phase}`, () =>
    mergeFixture(async ({ root, ctx, config, remote }) => {
      await fs.writeFile(path.join(root, "a.txt"), "modified");
      const originalState = await readStateForConfig(config);
      const mutation = () => fs.writeFile(path.join(root, "a.txt"), "new edit");
      const cancel = new AbortController();
      if (phase === "backup") {
        const open = fs.open.bind(fs);
        vi.spyOn(fs, "open").mockImplementation(async (name, flags, mode) => {
          const handle = await open(name, flags, mode);
          if (String(name).includes(`${path.sep}backups${path.sep}`) && flags === "wx") await mutation();
          return handle;
        });
      }
      configureEngineHost({
        root: () => root,
        mutate: async (_target, action) => action(),
        review: async () => {
          if (phase === "review") await mutation();
          if (phase === "cancel") cancel.abort(new Error("cancelled review"));
          return true;
        },
      });
      const options = { ...commandOptions, signal: cancel.signal };
      if (phase === "cancel") {
        assert.equal(await mergeSync(ctx, options, remote.factory), "cancelled");
      } else if (phase === "review") {
        await assert.rejects(mergeSync(ctx, options, remote.factory), /changed during review/i);
      } else {
        await assert.rejects(mergeSync(ctx, options, remote.factory), /changed before publication/i);
      }
      assert.equal(remote.publishSnapshot.mock.calls.length, 0);
      assert.deepEqual(await readStateForConfig(config), originalState);
      assert.equal(await readMergeJournal(config), undefined);
      assert.equal(await fs.readFile(path.join(root, "a.txt"), "utf8"), phase === "cancel" ? "modified" : "new edit");
    }, false));
}
