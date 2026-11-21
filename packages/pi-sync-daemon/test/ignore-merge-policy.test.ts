import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { type MockInstance, test, vi } from "vitest";
import { authorizeAfterExit, consentFingerprint, readConsent, requireHandover } from "../src/consent.js";
import type { RemoteHead, SyncBackend } from "../src/engine/backends/sync-backend.js";
import type { CommandOptions } from "../src/engine/commands/command-types.js";
import { configureEngineHost, type EngineContext, type EngineHost } from "../src/engine/host.js";
import {
  loadEffectiveIgnorePolicy,
  requireUnchangedIgnorePolicy,
} from "../src/engine/ignore/effective-ignore-policy.js";
import * as settings from "../src/engine/settings/config.js";
import type { AnySyncConfig } from "../src/engine/settings/settings-types.js";
import type { Snapshot } from "../src/engine/snapshot/snapshot-types.js";
import { readStateForConfig, syncStateFingerprint, writeStateForConfig } from "../src/engine/state/sync-state-store.js";
import { createContinuousSync } from "../src/engine/sync/continuous-sync.js";
import { watchContinuous } from "../src/engine/sync/continuous-watch.js";
import { applyMergedSnapshot } from "../src/engine/sync/merge-apply.js";
import {
  type MergeJournal,
  mergeJournalIdentity,
  mergeJournalPath,
  readMergeJournal,
  requireNoMergeJournal,
  retireMergeJournal,
  writeMergeJournal,
} from "../src/engine/sync/merge-journal.js";
import { mergeSync } from "../src/engine/sync/merged-sync.js";
import { createEngineLoaders } from "../src/engine/sync/sync-loaders.js";
import { selectionForSnapshot } from "../src/engine/sync/sync-policy.js";
import { acceptedSelection, fileHashMap } from "../src/engine/sync/sync-state.js";
import type { Execution } from "../src/protocol.js";

const filename = ".work.syncignore";
const rules = "/ignored/\n";
const input = { filename, sessions: false, configuredFilenames: [".other.syncignore"] };
const options: CommandOptions = {
  args: [],
  auto: true,
  force: false,
  reload: false,
  silent: true,
  stale: false,
  yes: true,
};

const legacy = settings.configFromSettings({
  version: 7,
  activeSyncSetup: "work",
  onSwitch: "switch-only",
  storageConnections: { memory: { type: "git", remote: "https://example.invalid/sync.git" } },
  syncSetups: {
    work: {
      storage: { connection: "memory", path: "test", branch: "main" },
      sync: { scope: "agent-directory", automatic: true, automaticTransfer: true, agentMode: true },
    },
  },
});

function file(relative: string, content: string) {
  return {
    path: relative,
    contentBase64: Buffer.from(content).toString("base64"),
    sha256: createHash("sha256").update(content).digest("hex"),
  };
}

function snapshot(config: AnySyncConfig, id: string, files: Snapshot["files"]): Snapshot {
  return {
    version: config.ignorePolicy ? 6 : 5,
    selection: selectionForSnapshot(config.include, config.exclude, config),
    profile: config.snapshotIdentity,
    id,
    createdAt: "2026-01-01T00:00:00.000Z",
    machine: "fixture",
    syncSessions: false,
    files,
  };
}

function backendFixture(initial: Snapshot) {
  let current = initial;
  const head = (): RemoteHead => ({
    snapshotId: current.id,
    snapshotRef: current.id,
    revision: current.id,
    syncSessions: false,
    createdAt: current.createdAt,
    machine: current.machine,
    selection: current.selection,
  });
  const committed = vi.fn<(snapshot: Snapshot) => void>();
  const publishHook = vi.fn<() => Promise<void>>(async () => {});
  const readHead = vi.fn(async () => head());
  const readSnapshot = vi.fn(async (id: string) => {
    assert.equal(id, current.id);
    return current;
  });
  const publishSnapshot = vi.fn<SyncBackend["publishSnapshot"]>(async (candidate, _expected, publishOptions) => {
    await publishHook();
    assert.ok(publishOptions?.validateIgnorePolicy, "ignore publication needs a commit guard");
    await publishOptions.validateIgnorePolicy();
    publishOptions.onCommit?.();
    committed(candidate);
    current = candidate;
    return { head: head(), warnings: [] };
  });
  const backend: SyncBackend = {
    identity: "memory",
    destination: "memory",
    capability: "atomic-conditional",
    sameRevision: (left, right) => left === right,
    readHead,
    readSnapshot,
    publishSnapshot,
    diagnose: async () => [],
    listHistory: async () => [],
  };
  return { factory: vi.fn(async () => backend), readHead, readSnapshot, publishSnapshot, committed, publishHook };
}

function host(root: string, mutate: EngineHost["mutate"] = async (_target, action) => action()) {
  configureEngineHost({ root: () => root, mutate, review: async () => true });
}

async function fixture(
  run: (fixture: {
    root: string;
    ignoreFile: string;
    config: AnySyncConfig;
    load: MockInstance<typeof settings.loadConfig>;
    ctx: EngineContext;
  }) => Promise<void>,
) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "pi-sync-ignore-merge-")));
  const ignoreFile = path.join(root, filename);
  const loadIgnore = async () => {
    const ignorePolicy = await loadEffectiveIgnorePolicy(root, input);
    return {
      ...legacy,
      ignorePolicy,
      validateIgnorePolicy: () => requireUnchangedIgnorePolicy(root, ignorePolicy, input),
    };
  };
  host(root);
  try {
    await fs.writeFile(ignoreFile, rules);
    const load = vi.spyOn(settings, "loadConfig").mockImplementation(loadIgnore);
    const ctx: EngineContext = {
      cwd: root,
      mode: "rpc",
      hasUI: true,
      sessionManager: { usesDefaultSessionDir: () => true },
      isIdle: () => true,
      modelRegistry: { streamSimple: () => assert.fail("Unexpected model request.") },
      ui: { notify() {}, setStatus() {}, confirm: async () => true, select: async () => undefined },
    };
    await run({ root, ignoreFile, config: await loadIgnore(), load, ctx });
  } finally {
    vi.restoreAllMocks();
    await fs.rm(root, { recursive: true, force: true });
  }
}

async function baseline(config: AnySyncConfig, policy = config) {
  const image = snapshot(policy, "baseline", [file("notes.md", "baseline")]);
  const state = {
    version: 1,
    profile: config.snapshotIdentity,
    lastAppliedSnapshot: image.id,
    lastRemoteRevision: image.id,
    lastFileHashes: fileHashMap(image),
    ...acceptedSelection(policy),
  };
  await writeStateForConfig(config, state);
  return state;
}

test("v6 merge records local policy evidence separately and publishes only managed paths", () =>
  fixture(async ({ root, config, ctx }) => {
    await baseline(config);
    await fs.writeFile(path.join(root, "notes.md"), "local edit");
    await fs.writeFile(path.join(root, "auth.json"), "local only");
    const remote = backendFixture(
      snapshot(config, "remote", [
        file("notes.md", "baseline"),
        file("new.md", "remote edit"),
        file(".other.syncignore", "remote only"),
      ]),
    );
    let observed: MergeJournal | undefined;
    remote.publishHook.mockImplementation(async () => {
      observed = await readMergeJournal(config);
    });
    assert.equal(await mergeSync(ctx, options, remote.factory), "applied");
    assert.equal(observed?.version, 2);
    assert.deepEqual(observed?.ignoreSource, {
      version: 1,
      filename,
      sourceDigest: config.ignorePolicy?.sourceDigest,
      reservedNames: [".other.syncignore", ".syncignore", filename],
    });
    const [published] = remote.committed.mock.calls[0] ?? [];
    assert.ok(published?.selection);
    assert.deepEqual(
      published.files.map((entry) => entry.path),
      ["new.md", "notes.md"],
    );
    assert.deepEqual(Object.keys(published.selection).sort(), ["fingerprint", "scope", "sessions", "version"]);
    assert.equal(await fs.readFile(path.join(root, "new.md"), "utf8"), "remote edit");
    assert.equal(await fs.readFile(path.join(root, "auth.json"), "utf8"), "local only");
    assert.equal((await readStateForConfig(config)).lastAppliedSnapshot, published.id);
    assert.equal(await readMergeJournal(config), undefined);
    assert.equal(remote.readHead.mock.calls.length, 4);
    assert.equal(remote.readSnapshot.mock.calls.length, 2);
  }));

test("an edit at the publish guard retains pending evidence across force, retry and legacy lookup", () =>
  fixture(async ({ root, ignoreFile, config, ctx }) => {
    const state = await baseline(config);
    await fs.writeFile(path.join(root, "notes.md"), "local edit");
    const remote = backendFixture(
      snapshot(config, "remote", [file("notes.md", "baseline"), file("new.md", "remote edit")]),
    );
    remote.publishHook.mockImplementation(async () => fs.writeFile(ignoreFile, `${rules}# changed source\n`));
    await assert.rejects(mergeSync(ctx, options, remote.factory), /journal and backup retained/i);
    assert.equal(remote.committed.mock.calls.length, 0);
    assert.deepEqual(await readStateForConfig(config), state);
    await assert.rejects(fs.readFile(path.join(root, "new.md")), { code: "ENOENT" });
    const filePath = mergeJournalPath(config);
    const pending = await fs.readFile(filePath);
    assert.equal(filePath, mergeJournalPath(legacy));
    const current = await settings.loadConfig();
    for (const lookup of [current, legacy]) {
      await assert.rejects(requireNoMergeJournal(lookup, { force: true }), /preserve/i);
      await assert.rejects(retireMergeJournal(lookup), /preserve/i);
    }
    remote.factory.mockClear();
    await assert.rejects(mergeSync(ctx, options, remote.factory), /preserve/i);
    assert.equal(remote.factory.mock.calls.length, 0);
    assert.deepEqual(await fs.readFile(filePath), pending);
  }));

test("recovering an uncertain v6 commit applies its verified snapshot without republishing", () =>
  fixture(async ({ root, config, ctx }) => {
    const state = await baseline(config);
    await fs.writeFile(path.join(root, "notes.md"), "local edit");
    const remote = backendFixture(
      snapshot(config, "remote", [file("notes.md", "baseline"), file("new.md", "remote edit")]),
    );
    const publish = remote.publishSnapshot.getMockImplementation();
    assert.ok(publish);
    remote.publishSnapshot.mockImplementationOnce(async (...args) => {
      await publish(...args);
      throw new Error("Connection lost after commit");
    });
    await assert.rejects(mergeSync(ctx, options, remote.factory), /journal and backup retained/i);
    const journal = await readMergeJournal(config);
    assert.ok(journal?.version === 2);
    assert.equal(journal.committedHead, undefined);
    assert.deepEqual(await readStateForConfig(config), state);
    assert.equal(await mergeSync(ctx, options, remote.factory), "applied");
    assert.equal(await fs.readFile(path.join(root, "new.md"), "utf8"), "remote edit");
    assert.equal((await readStateForConfig(config)).lastAppliedSnapshot, journal.upload.id);
    assert.equal(await readMergeJournal(config), undefined);
    assert.equal(remote.publishSnapshot.mock.calls.length, 1);
  }));

test("a pending v1 journal still resolves to its original path but cannot authorize v8 recovery", () =>
  fixture(async ({ root, config, ctx }) => {
    const state = await baseline(legacy);
    const image = snapshot(legacy, "baseline", [file("notes.md", "baseline")]);
    const remote = backendFixture(image);
    await writeMergeJournal(legacy, {
      version: 1,
      identity: mergeJournalIdentity(legacy, "memory"),
      before: image,
      after: image,
      accepted: image,
      upload: image,
      expectedHead: await remote.readHead(),
      backup: "fixture-backup",
      stateIdentity: syncStateFingerprint(state),
      sessionRoot: path.join(root, "sessions"),
    });
    assert.equal((await readMergeJournal(config))?.version, 1);
    const journalPath = mergeJournalPath(config);
    const journalBytes = await fs.readFile(journalPath);
    await assert.rejects(mergeSync(ctx, options, remote.factory), /lacks ignore-file policy evidence/i);
    await assert.rejects(requireNoMergeJournal(config, { force: true }), /lacks ignore-file policy evidence/i);
    await assert.rejects(retireMergeJournal(config), /lacks ignore-file policy evidence/i);
    assert.equal(remote.factory.mock.calls.length, 0);
    assert.deepEqual(await fs.readFile(journalPath), journalBytes);
    assert.deepEqual(await readStateForConfig(config), state);
  }));

for (const transition of ["old baseline", "legacy remote", "different remote", "legacy local"] as const) {
  test(`automatic merge refuses ${transition} without applying or publishing`, () =>
    fixture(async ({ root, config, ctx, load }) => {
      await fs.writeFile(path.join(root, "notes.md"), "local edit");
      const state = await baseline(config, transition === "old baseline" ? legacy : config);
      if (transition === "legacy local") load.mockResolvedValue(legacy);
      const image = snapshot(transition === "legacy remote" ? legacy : config, "remote", [file("new.md", "remote")]);
      if (transition === "different remote" && image.selection?.version === 4)
        image.selection.fingerprint = "0".repeat(64);
      const remote = backendFixture(image);
      await assert.rejects(mergeSync(ctx, options, remote.factory));
      assert.equal(remote.publishSnapshot.mock.calls.length, 0);
      await assert.rejects(fs.readFile(path.join(root, "new.md")), { code: "ENOENT" });
      assert.deepEqual(await readStateForConfig(config), state);
      assert.equal(await readMergeJournal(config), undefined);
    }));
}

test("continuous inspection of a v6 policy mismatch never enters operations", () =>
  fixture(async ({ root, config, ctx }) => {
    vi.spyOn(settings, "loadConfigForCheck").mockResolvedValue({ ...config, continuous: true });
    const remote = backendFixture(snapshot(legacy, "legacy-remote", [file("notes.md", "baseline")]));
    await baseline(config);
    await fs.writeFile(path.join(root, "notes.md"), "local edit");
    const load = createEngineLoaders();
    const operations = vi.spyOn(load, "operations");
    const actualInspection = await load.inspection();
    vi.spyOn(load, "inspection").mockResolvedValue({
      ...actualInspection,
      inspectSync: (...args) => actualInspection.inspectSync(args[0], args[1], args[2], remote.factory, args[4]),
    });
    const statuses: (string | undefined)[] = [];
    ctx.ui.setStatus = (_key, text) => statuses.push(text);
    const continuous = createContinuousSync(load);
    const controller = new AbortController();
    continuous.start(ctx, controller.signal);
    try {
      await vi.waitFor(() => assert.ok(statuses.some((text) => text?.includes("blocked"))), { interval: 5 });
    } finally {
      controller.abort();
      await continuous.stop();
    }
    assert.equal(remote.readHead.mock.calls.length, 1);
    assert.equal(operations.mock.calls.length, 0);
    assert.equal(remote.publishSnapshot.mock.calls.length, 0);
  }));

test("an ignore source edit invalidates an unattended consent review before it can publish", () =>
  fixture(async ({ root, config, ignoreFile, load }) => {
    const continuous = { ...config, continuous: true };
    load.mockResolvedValue(continuous);
    const signal = new AbortController().signal;
    const execution: Execution = {
      root,
      signal,
      clientId: undefined,
      facts: () => undefined,
      participants: () => [],
      liveClients: () => [],
      withParticipants: (action) => action([]),
      validate: () => signal.throwIfAborted(),
      request: async () => true,
      emit() {},
      committed() {},
    };
    await requireHandover(execution);
    const fingerprint = consentFingerprint(root, continuous);
    let reviewed: unknown;
    execution.request = async (_type, value) => {
      reviewed = value;
      await fs.writeFile(ignoreFile, `${rules}# changed during review\n`);
      return true;
    };
    await assert.rejects(authorizeAfterExit(execution, { fingerprint, afterExit: true }), /ignore policy changed/i);
    assert.ok(JSON.stringify(reviewed).includes(filename));
    assert.ok(!JSON.stringify(reviewed).includes("/ignored/"));
    assert.deepEqual(readConsent(root)?.setups, {});
  }));

test("the active ignore source issues a control hint, not a content hint", () =>
  fixture(async ({ root, config, ignoreFile }) => {
    const changes: boolean[] = [];
    const close = await watchContinuous(config, (control) => changes.push(control));
    try {
      await fs.writeFile(path.join(root, "auth.json"), "credentials are not a hint");
      await fs.writeFile(path.join(root, ".other.syncignore"), "unused policy is not a hint");
      await fs.writeFile(ignoreFile, `${rules}# update local policy\n`);
      await vi.waitFor(() => assert.ok(changes.includes(true)), { interval: 5 });
      assert.ok(changes.every(Boolean));
      await fs.writeFile(path.join(root, "notes.md"), "managed edit");
      await vi.waitFor(() => assert.ok(changes.includes(false)), { interval: 5 });
    } finally {
      close();
    }
  }));

test("an ignore-policy edit while waiting for the target queue performs no merged write", () =>
  fixture(async ({ root, ignoreFile, config }) => {
    const target = path.join(root, "notes.md");
    await fs.writeFile(target, "before");
    host(root, async (reserved, action) => {
      assert.equal(reserved, target);
      await fs.writeFile(ignoreFile, `${rules}notes.md\n`);
      return action();
    });
    await assert.rejects(
      applyMergedSnapshot(
        snapshot(config, "before", [file("notes.md", "before")]),
        snapshot(config, "after", [file("notes.md", "after")]),
        new Set(),
        { ...config, sessionDir: path.join(root, "sessions") },
        async () => {},
      ),
      /ignore policy changed/i,
    );
    assert.equal(await fs.readFile(target, "utf8"), "before");
  }));

test("a policy edit between merged deletions protects remaining paths", () =>
  fixture(async ({ root, config, ignoreFile }) => {
    const first = path.join(root, "a.md");
    const second = path.join(root, "b.md");
    await fs.writeFile(first, "first");
    await fs.writeFile(second, "second");
    const remove = fs.rm.bind(fs);
    vi.spyOn(fs, "rm").mockImplementation(async (target, options) => {
      await remove(target, options);
      if (target === first) await fs.writeFile(ignoreFile, `${rules}b.md\n`);
    });
    await assert.rejects(
      applyMergedSnapshot(
        snapshot(config, "before", [file("a.md", "first"), file("b.md", "second")]),
        snapshot(config, "after", []),
        new Set(),
        { ...config, sessionDir: path.join(root, "sessions") },
        async () => {},
      ),
      /ignore policy changed/i,
    );
    await assert.rejects(fs.lstat(first), { code: "ENOENT" });
    assert.equal(await fs.readFile(second, "utf8"), "second");
  }));

test("merged rename rechecks its preimage after the freshness await", () =>
  fixture(async ({ root, config }) => {
    const target = path.join(root, "notes.md");
    await fs.writeFile(target, "before");
    let staged = false;
    const open = fs.open.bind(fs);
    vi.spyOn(fs, "open").mockImplementation(async (filePath, flags, mode) => {
      const handle = await open(filePath, flags, mode);
      if (String(filePath).endsWith(".apply")) staged = true;
      return handle;
    });
    await assert.rejects(
      applyMergedSnapshot(
        snapshot(config, "before", [file("notes.md", "before")]),
        snapshot(config, "after", [file("notes.md", "after")]),
        new Set(),
        {
          ...config,
          sessionDir: path.join(root, "sessions"),
          validateIgnorePolicy: async () => {
            await config.validateIgnorePolicy?.();
            if (staged) {
              staged = false;
              await fs.writeFile(target, "concurrent edit");
            }
          },
        },
        async () => {},
      ),
      /changed/i,
    );
    assert.equal(await fs.readFile(target, "utf8"), "concurrent edit");
  }));
