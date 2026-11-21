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
  mergeJournalPolicy,
  readMergeJournal,
  requireNoMergeJournal,
  retireMergeJournal,
  writeMergeJournal,
} from "../src/engine/sync/merge-journal.js";
import { mergeSync } from "../src/engine/sync/merged-sync.js";
import { createEngineLoaders } from "../src/engine/sync/sync-loaders.js";
import { pull, push, syncBoth } from "../src/engine/sync/sync-mutations.js";
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
  const readHead = vi.fn<SyncBackend["readHead"]>(async () => head());
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
  return {
    factory: vi.fn(async () => backend),
    head,
    readHead,
    readSnapshot,
    publishSnapshot,
    committed,
    publishHook,
    replaceHead(snapshot: Snapshot) {
      current = snapshot;
    },
  };
}

function host(
  root: string,
  mutate: EngineHost["mutate"] = async (_target, action) => action(),
  review: EngineHost["review"] = async () => true,
) {
  configureEngineHost({ root: () => root, mutate, review });
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

test.each([
  ["legacy", "published", true],
  ["legacy", "apply-only", true],
  ["ignore", "published", true],
  ["ignore", "apply-only", true],
  ["legacy", "published", false],
  ["legacy", "apply-only", false],
  ["ignore", "published", false],
  ["ignore", "apply-only", false],
] as const)("%s %s journal, accepted=%s, with newer incompatible remote policy", (policy, operation, accepted) =>
  fixture(async ({ root, config, ctx, load }) => {
    const localPolicy = policy === "legacy" ? legacy : config;
    if (policy === "legacy") load.mockResolvedValue(legacy);
    const state = await baseline(localPolicy);
    const before = snapshot(localPolicy, "baseline", [file("notes.md", "baseline")]);
    const after = snapshot(localPolicy, "committed", [file("notes.md", "accepted")]);
    const remote = backendFixture(before);
    const expectedHead = remote.head();
    remote.replaceHead(after);
    const committedHead = remote.head();
    const applyOnly = operation === "apply-only";
    await writeMergeJournal(localPolicy, {
      ...mergeJournalPolicy(localPolicy),
      identity: mergeJournalIdentity(localPolicy, "memory"),
      before,
      after,
      upload: after,
      accepted: after,
      expectedHead: applyOnly ? committedHead : expectedHead,
      committedHead,
      ...(applyOnly ? { applyOnly: true } : {}),
      backup: "fixture-backup",
      stateIdentity: syncStateFingerprint(state),
      sessionRoot: path.join(root, "sessions"),
    });
    const journalPath = mergeJournalPath(localPolicy);
    const recorded = await fs.readFile(journalPath);
    const expectedState = accepted
      ? {
          ...state,
          lastAppliedSnapshot: after.id,
          lastRemoteRevision: committedHead.revision,
          lastFileHashes: fileHashMap(after),
        }
      : state;
    if (accepted) await writeStateForConfig(localPolicy, expectedState);
    const next = snapshot(policy === "legacy" ? config : legacy, "new-policy", [file("notes.md", "incoming")]);
    remote.replaceHead(next);
    await fs.writeFile(path.join(root, "notes.md"), "newer local edit");
    const run = () => syncBoth(ctx, foreground, remote.factory);
    if (accepted) {
      assert.equal(await run(), "applied");
      await requireNoMergeJournal(localPolicy);
    } else {
      await assert.rejects(run(), /Remote ignore-file policy differs or is unavailable/);
      assert.deepEqual(await fs.readFile(journalPath), recorded);
    }
    assert.deepEqual(await readStateForConfig(localPolicy), expectedState);
    assert.equal(await fs.readFile(path.join(root, "notes.md"), "utf8"), "newer local edit");
    assert.equal((await remote.readHead())?.snapshotId, next.id);
    assert.equal(remote.readSnapshot.mock.calls.length, 0);
    assert.equal(remote.publishSnapshot.mock.calls.length, 0);
  }),
);

const foreground = { ...options, auto: false, yes: false, silent: false };

async function interruptBeforeCommit(root: string, config: AnySyncConfig, ctx: EngineContext) {
  const state = await baseline(config);
  const target = path.join(root, "notes.md");
  await fs.writeFile(target, "local edit");
  const remote = backendFixture(
    snapshot(config, "remote", [file("notes.md", "baseline"), file("new.md", "remote edit")]),
  );
  remote.publishHook.mockRejectedValueOnce(new Error("Connection lost before commit"));
  await assert.rejects(mergeSync(ctx, options, remote.factory), /journal and backup retained/i);
  const pending = await readMergeJournal(config);
  assert.ok(pending?.version === 2 && !pending.committedHead);
  const journalPath = mergeJournalPath(config);
  const journalBytes = await fs.readFile(journalPath);
  const backupBytes = await fs.readFile(pending.backup);
  await fs.writeFile(target, "newer local edit");
  return { state, target, remote, pending, journalPath, journalBytes, backupBytes };
}

for (const [mode, approve] of [
  ["tui", true],
  ["rpc", true],
  ["rpc", false],
] as const) {
  test(`only the journal is archived after ${mode} review, approve=${approve}`, () =>
    fixture(async ({ root, config, ctx }) => {
      const { state, target, remote, pending, journalPath, journalBytes, backupBytes } = await interruptBeforeCommit(
        root,
        config,
        ctx,
      );
      ctx.mode = mode;
      const review = vi.fn<EngineHost["review"]>(async () => {
        if (approve) await fs.writeFile(target, "edit made during review");
        return approve;
      });
      host(root, undefined, review);
      for (const run of [
        () => push(ctx, { ...foreground, force: true }, undefined, remote.factory),
        () => pull(ctx, { ...foreground, force: true }, remote.factory),
        () => mergeSync(ctx, options, remote.factory),
        () => syncBoth(ctx, { ...foreground, yes: true }, remote.factory),
        () => syncBoth({ ...ctx, mode: "print", hasUI: false }, foreground, remote.factory),
      ]) {
        await assert.rejects(run(), /directional --force cannot bypass it.*requires foreground review/);
      }
      assert.equal(review.mock.calls.length, 0);
      const notify = vi.spyOn(ctx.ui, "notify");
      assert.equal(await syncBoth(ctx, foreground, remote.factory), approve ? "archived" : "cancelled");
      if (approve) assert.match(notify.mock.calls[0]?.[0] ?? "", /Archived the inactive merge journal/);
      else assert.equal(notify.mock.calls.length, 0);
      const request = review.mock.calls[0]?.[1];
      assert.equal(request?.confirmationLabel, "archive journal only");
      assert.match(request.content, /Keep its backup and all current local and remote files/);
      const directory = path.dirname(journalPath);
      const archives = (await fs.readdir(directory)).filter((entry) => entry.endsWith(".resolved"));
      assert.equal(archives.length, approve ? 1 : 0);
      if (approve) await requireNoMergeJournal(config);
      assert.deepEqual(await fs.readFile(approve ? path.join(directory, archives[0]) : journalPath), journalBytes);
      assert.deepEqual(await fs.readFile(pending.backup), backupBytes);
      assert.deepEqual(await readStateForConfig(config), state);
      assert.deepEqual(await remote.readHead(), pending.expectedHead);
      assert.equal(remote.committed.mock.calls.length, 0);
      assert.equal(remote.publishSnapshot.mock.calls.length, 1);
      assert.equal(await fs.readFile(target, "utf8"), approve ? "edit made during review" : "newer local edit");
      await assert.rejects(fs.stat(path.join(root, "new.md")), { code: "ENOENT" });
    }));
}

for (const change of ["head", "head policy", "baseline", "ignore source", "session", "abort"] as const) {
  test(`archive approval does not survive a changed ${change}`, () =>
    fixture(async ({ root, config, ignoreFile, ctx }) => {
      const { state, target, remote, pending, journalPath, journalBytes, backupBytes } = await interruptBeforeCommit(
        root,
        config,
        ctx,
      );
      const abort = new AbortController();
      let session = "original";
      ctx.sessionManager.getSessionId = () => session;
      const review = vi.fn<EngineHost["review"]>(async () => {
        if (change === "head") remote.replaceHead(snapshot(config, "advanced", []));
        if (change === "head policy")
          remote.readHead.mockResolvedValueOnce({ ...pending.expectedHead, selection: undefined });
        if (change === "baseline") await writeStateForConfig(config, { ...state, lastRemoteRevision: "different" });
        if (change === "ignore source") await fs.writeFile(ignoreFile, `${rules}# changed during review\n`);
        if (change === "session") session = "replacement";
        if (change === "abort") abort.abort();
        return true;
      });
      host(root, undefined, review);
      const run = () => syncBoth(ctx, { ...foreground, signal: abort.signal }, remote.factory);
      if (change === "session" || change === "abort") assert.equal(await run(), "cancelled");
      else await assert.rejects(run(), /changed during (recovery review|transfer)/);
      assert.equal(review.mock.calls.length, 1);
      assert.deepEqual(await fs.readFile(journalPath), journalBytes);
      assert.deepEqual(await fs.readFile(pending.backup), backupBytes);
      assert.equal(remote.publishSnapshot.mock.calls.length, 1);
      assert.equal(await fs.readFile(target, "utf8"), "newer local edit");
    }));
}

for (const remoteDisposition of [
  "missing",
  "different",
  "candidate active",
  "same revision but different snapshot",
  "candidate equals expected snapshot",
  "unavailable head policy",
  "changed baseline",
  "superseded apply-only",
] as const) {
  test(`a pending ignore-policy merge with ${remoteDisposition} does not offer archive`, () =>
    fixture(async ({ root, config, ctx }) => {
      const { state, target, remote, pending, journalPath, backupBytes } = await interruptBeforeCommit(
        root,
        config,
        ctx,
      );
      const review = vi.fn<EngineHost["review"]>(async () => true);
      host(root, undefined, review);
      if (remoteDisposition === "missing") remote.readHead.mockResolvedValueOnce(undefined);
      if (remoteDisposition === "different") remote.replaceHead(snapshot(config, "unrelated", []));
      if (remoteDisposition === "candidate active") {
        remote.replaceHead(pending.upload);
        await fs.writeFile(path.join(root, "new.md"), "newer byte at a planned target");
      }
      if (remoteDisposition === "same revision but different snapshot") {
        remote.readHead.mockResolvedValueOnce({ ...pending.expectedHead, snapshotId: "unrelated" });
      }
      if (remoteDisposition === "candidate equals expected snapshot") {
        await writeMergeJournal(config, {
          ...pending,
          upload: { ...pending.upload, id: pending.expectedHead.snapshotId },
        });
      }
      if (remoteDisposition === "unavailable head policy") {
        remote.readHead.mockResolvedValueOnce({ ...pending.expectedHead, selection: undefined });
      }
      if (remoteDisposition === "changed baseline")
        await writeStateForConfig(config, { ...state, lastRemoteRevision: "different" });
      if (remoteDisposition === "superseded apply-only") {
        remote.replaceHead(pending.upload);
        const committedHead = remote.head();
        await writeMergeJournal(config, { ...pending, applyOnly: true, expectedHead: committedHead, committedHead });
        remote.replaceHead(snapshot(config, "advanced", []));
      }
      const journalBytes = await fs.readFile(journalPath);
      await assert.rejects(syncBoth(ctx, foreground, remote.factory));
      if (remoteDisposition === "candidate active") {
        assert.equal(await fs.readFile(path.join(root, "new.md"), "utf8"), "newer byte at a planned target");
      }
      assert.equal(review.mock.calls.length, 0);
      assert.deepEqual(await fs.readFile(journalPath), journalBytes);
      assert.deepEqual(await fs.readFile(pending.backup), backupBytes);
      assert.equal(remote.publishSnapshot.mock.calls.length, 1);
      assert.equal(await fs.readFile(target, "utf8"), "newer local edit");
    }));
}

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
      expectedHead: remote.head(),
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
