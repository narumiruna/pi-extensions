import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test, vi } from "vitest";
import {
  expectedRemoteHead,
  type RemoteHead,
  type SyncBackend,
  verifyPreviousHeadInHistory,
} from "../src/engine/backends/sync-backend.js";
import type { CommandOptions } from "../src/engine/commands/command-types.js";
import { configureEngineHost, type EngineContext, engineHost, getEngineRoot } from "../src/engine/host.js";
import { hasPendingAdoption } from "../src/engine/ignore/adoption-journal.js";
import { ignorePolicyFingerprint } from "../src/engine/ignore/ignore-source.js";
import { configFromSettings, loadConfig, syncCheckConfigFingerprint } from "../src/engine/settings/config.js";
import type { PiSyncSettingsV3 } from "../src/engine/settings/settings-types.js";
import { snapshotOptionsForContext } from "../src/engine/snapshot/session-paths.js";
import { createSnapshot } from "../src/engine/snapshot/snapshot.js";
import { applySnapshot } from "../src/engine/snapshot/snapshot-apply.js";
import { decodeSnapshot } from "../src/engine/snapshot/snapshot-codec.js";
import { pendingTransactionEntries } from "../src/engine/snapshot/snapshot-transaction-directory.js";
import type { Snapshot, SnapshotFile } from "../src/engine/snapshot/snapshot-types.js";
import { readStateForConfig, statePathForConfig } from "../src/engine/state/sync-state-store.js";
import { initializeSync } from "../src/engine/sync/initialization.js";
import { readRemoteSnapshot } from "../src/engine/sync/remote-snapshot.js";
import { inspectSync } from "../src/engine/sync/sync-inspection.js";
import { pull, push, rollback, syncBoth } from "../src/engine/sync/sync-mutations.js";
import {
  compileSyncPolicyExclude,
  compileSyncPolicyTraversal,
  configuredSnapshotPathMatcher,
  RemoteSelectionMismatchError,
  selectionForSnapshot,
} from "../src/engine/sync/sync-policy.js";
import { syncPolicyChanged } from "../src/engine/sync/sync-state.js";
import { formatPullSummary, formatRollbackSummary } from "../src/engine/ui/sync-format.js";

vi.mock(import("../src/engine/settings/config.js"), async (importOriginal) => {
  const actual = await importOriginal();
  const load = async (setup?: string) => {
    const settings = JSON.parse(await fs.readFile(path.join(getEngineRoot(), "pi-sync.json"), "utf8"));
    return actual.resolveIgnoreConfig(settings, setup);
  };
  return { ...actual, loadConfig: load, loadConfigForCheck: load };
});

const options: CommandOptions = {
  args: [],
  auto: false,
  force: false,
  reload: false,
  silent: true,
  stale: false,
  yes: false,
};

function file(path: string, content: string): SnapshotFile {
  return {
    path,
    contentBase64: Buffer.from(content).toString("base64"),
    sha256: createHash("sha256").update(content).digest("hex"),
  };
}

function memoryRemote() {
  const snapshots = new Map<string, Snapshot>();
  const history: RemoteHead[] = [];
  let head: RemoteHead | undefined;
  let reads = 0;
  let publicationHook: (() => void | Promise<void>) | undefined;
  const commits: Snapshot[] = [];
  const seed = (snapshot: Snapshot) => {
    snapshots.set(snapshot.id, snapshot);
    head = {
      snapshotId: snapshot.id,
      snapshotRef: snapshot.id,
      revision: String(snapshots.size),
      createdAt: snapshot.createdAt,
      machine: snapshot.machine,
      syncSessions: snapshot.syncSessions ?? false,
      selection: snapshot.selection,
    };
    history.push(head);
    return head;
  };
  const backend: SyncBackend = {
    identity: "memory",
    destination: "memory",
    capability: "atomic-conditional",
    sameRevision: (a, b) => a === b,
    readHead: async () => head,
    readSnapshot: async (reference) => {
      reads++;
      const snapshot = snapshots.get(reference);
      assert.ok(snapshot);
      return snapshot;
    },
    publishSnapshot: async (snapshot, expected, opts) => {
      await publicationHook?.();
      assert.ok(opts?.validateIgnorePolicy, "v6 publication requires a late freshness guard");
      await opts.validateIgnorePolicy();
      assert.deepEqual(expected, expectedRemoteHead(head));
      if (opts.preservePreviousHead && head) await verifyPreviousHeadInHistory(backend, head, opts.signal);
      opts.onCommit?.();
      commits.push(snapshot);
      return { head: seed(snapshot), warnings: [] };
    },
    listHistory: async () => history,
    diagnose: async () => [],
  };
  return {
    backend,
    factory: async () => backend,
    seed,
    commits,
    reads: () => reads,
    retain: (snapshot: Snapshot) => snapshots.set(snapshot.id, snapshot),
    duringPublish: (hook: typeof publicationHook) => {
      publicationHook = hook;
    },
  };
}

const activeRules = "/private.txt\n";

async function fixture(
  run: (fixture: {
    root: string;
    ctx: EngineContext;
    remote: ReturnType<typeof memoryRemote>;
    rules: string;
    settings: PiSyncSettingsV3;
    save: () => Promise<void>;
  }) => Promise<void>,
) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "pi-sync-ignore-direction-")));
  const rules = path.join(root, "Local.rules");
  try {
    configureEngineHost({ root: () => root, mutate: async (_target, action) => action(), review: async () => true });
    const ctx: EngineContext = {
      cwd: root,
      mode: "rpc",
      hasUI: true,
      sessionManager: { getSessionDir: () => path.join(root, "sessions") },
      isIdle: () => true,
      modelRegistry: { streamSimple: () => assert.fail("Unexpected model request") },
      ui: { notify() {}, setStatus() {}, confirm: async () => true, select: async () => undefined },
    };
    const settings: PiSyncSettingsV3 = {
      version: 8,
      onSwitch: "switch-only",
      activeSyncSetup: "work",
      storageConnections: { origin: { type: "git", remote: "git@example.invalid:owner/work.git" } },
      syncSetups: {
        work: {
          storage: { connection: "origin", path: "work", branch: "main" },
          sync: { scope: "agent-directory", pathPolicy: "ignore-file", ignoreFile: "Local.rules", automatic: false },
        },
      },
    };
    const save = () => fs.writeFile(path.join(root, "pi-sync.json"), JSON.stringify(settings), { mode: 0o600 });
    await fs.writeFile(rules, activeRules);
    await save();
    await run({ root, ctx, rules, settings, save, remote: memoryRemote() });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

const legacy = (id: string, files: SnapshotFile[] = []): Snapshot => ({
  version: 3,
  id,
  createdAt: "2026-01-01T00:00:00.000Z",
  machine: "fixture",
  profile: "work",
  syncSessions: false,
  selection: { version: 1, include: ["remote.txt"] },
  files,
});

test("local transfer summaries count all writes and case cleanup without listing individual paths", () =>
  fixture(async () => {
    const config = await loadConfig();
    const before = legacy("before", [
      file("update.md", "old"),
      file("remove.md", "old"),
      file("sessions/live.jsonl", "keep"),
    ]);
    const after = legacy("after", [file("add.md", "new"), file("update.md", "new")]);
    const protectedPaths = new Set(["sessions/live.jsonl"]);
    for (const review of [
      formatPullSummary(config, "memory", before, after, protectedPaths, ["ADD.md"]),
      formatRollbackSummary(config, "memory", before, after, after.id, protectedPaths, ["ADD.md"]),
    ]) {
      const summary = review.lines.join("\n");
      assert.match(summary, /1 add · 1 update · 2 remove/u);
      assert.match(summary, /Case-variant aliases are removed/u);
      assert.doesNotMatch(summary, /(?:Add|Update|Remove) locally:/u);
      assert.match(review.content, /Add locally: add\.md/u);
      assert.match(review.content, /Update locally: update\.md/u);
      assert.match(review.content, /Remove locally: remove\.md/u);
      assert.match(review.content, /Remove locally: ADD\.md/u);
      assert.doesNotMatch(review.content, /sessions\/live\.jsonl/u);
    }
  }));

function mismatch(comparison: string) {
  return (error: unknown) =>
    error instanceof RemoteSelectionMismatchError && error.decision.ignorePolicyComparison === comparison;
}

for (const comparison of ["mismatch", "local-ignore-remote-legacy"] as const) {
  test(`blocks unreviewed pushes and all pulls for an empty ${comparison} policy`, () =>
    fixture(async ({ ctx, remote }) => {
      const config = await loadConfig();
      const local = await createSnapshot(config.snapshotIdentity, snapshotOptionsForContext(ctx, config));
      assert.ok(local.selection?.version === 4);
      remote.seed(
        comparison === "mismatch"
          ? {
              ...local,
              id: "foreign",
              selection: { ...local.selection, fingerprint: "f".repeat(64) },
            }
          : legacy("foreign"),
      );
      // Status uses the authenticated projection without fetching the snapshot body.
      const inspection = await inspectSync(config, snapshotOptionsForContext(ctx, config), undefined, remote.factory);
      assert.equal(inspection.selectionState?.ignorePolicyComparison, comparison);
      assert.equal(inspection.remoteChanged, true);
      assert.equal(remote.reads(), 0);
      const observed = await readRemoteSnapshot(remote.backend, config, undefined, { allowSelectionDifference: true });
      assert.equal(observed.selectionState?.ignorePolicyComparison, comparison);
      assert.deepEqual(observed.snapshot?.selection, local.selection);
      ctx.ui.confirm = async () => false;
      assert.equal(await push(ctx, options, undefined, remote.factory), "cancelled");
      const unattended = { ...options, force: true, yes: true };
      await assert.rejects(push(ctx, unattended, undefined, remote.factory), mismatch(comparison));
      await assert.rejects(pull(ctx, unattended, remote.factory), mismatch(comparison));
      await assert.rejects(
        pull(ctx, options, remote.factory),
        comparison === "mismatch" ? /does not contain rule text/u : mismatch(comparison),
      );
      await assert.rejects(syncBoth(ctx, options, remote.factory), mismatch(comparison));
      await assert.rejects(pull(ctx, { ...options, auto: true }, remote.factory), mismatch(comparison));
      assert.equal(remote.commits.length, 0);
      assert.equal((await readStateForConfig(config)).lastAppliedSnapshot, undefined);
    }));
}

test("a legacy setup can compare a new remote but cannot pull it or force a downgrade", () =>
  fixture(async ({ ctx, settings, save, remote }) => {
    const config = await loadConfig();
    const local = await createSnapshot(config.snapshotIdentity, snapshotOptionsForContext(ctx, config));
    remote.seed(local);
    const setup = settings.syncSetups.work;
    assert.ok(setup);
    settings.syncSetups.work = {
      ...setup,
      sync: { include: ["remote.txt"], automatic: false },
    };
    await save();
    const legacyConfig = await loadConfig();
    const compared = await readRemoteSnapshot(remote.backend, legacyConfig, undefined, {
      allowSelectionDifference: true,
    });
    assert.equal(compared.snapshot, undefined);
    assert.equal(compared.selectionState?.ignorePolicyComparison, "local-legacy-remote-ignore");
    await assert.rejects(
      push(ctx, { ...options, force: true, yes: true }, undefined, remote.factory),
      mismatch("local-legacy-remote-ignore"),
    );
    await assert.rejects(
      pull(ctx, { ...options, force: true, yes: true }, remote.factory),
      mismatch("local-legacy-remote-ignore"),
    );
    assert.deepEqual(remote.commits, []);
  }));

test("reviewed push transitions selected-path history using only current local bytes and records a source-bound baseline", () =>
  fixture(async ({ root, ctx, settings, save, remote }) => {
    await fs.writeFile(path.join(root, "notes.txt"), "current");
    await fs.writeFile(path.join(root, "private.txt"), "local only");
    remote.seed(legacy("old-head", [file("remote.txt", "old bytes")]));
    const config = await loadConfig();
    let review = "";
    ctx.ui.confirm = async (_title, content) => {
      review = content;
      return true;
    };
    assert.equal(await push(ctx, { ...options, force: true }, undefined, remote.factory), "applied");
    assert.match(review, /Remove remotely: remote\.txt/u);
    assert.match(review, /Add remotely: notes\.txt/u);
    assert.match(review, /Remote rules are not adopted/u);
    const [upload] = remote.commits;
    assert.ok(upload);
    assert.equal(upload.version, 7);
    assert.deepEqual(
      upload.files.map((entry) => entry.path),
      ["notes.txt"],
    );
    assert.deepEqual(upload.selection, selectionForSnapshot([], undefined, config));
    assert.deepEqual(upload.ignoreRules, { filename: "Local.rules", text: activeRules });
    assert.doesNotMatch(JSON.stringify(upload.selection), /Local\.rules|private\.txt|sourceDigest/u);
    const accepted = await readStateForConfig(config);
    assert.ok(accepted.ignorePolicyKey);
    assert.ok(!syncPolicyChanged(accepted, config));
    await fs.writeFile(path.join(root, "Other.rules"), activeRules);
    const setup = settings.syncSetups.work;
    assert.ok(setup);
    setup.sync = {
      scope: "agent-directory",
      pathPolicy: "ignore-file",
      ignoreFile: "Other.rules",
      automatic: false,
    };
    await save();
    const switched = await loadConfig();
    assert.equal(switched.ignorePolicy?.fingerprint, config.ignorePolicy?.fingerprint);
    assert.ok(syncPolicyChanged(accepted, switched));
    await assert.rejects(
      push(ctx, { ...options, force: true, yes: true }, undefined, remote.factory),
      /policy or source changed/u,
    );
    assert.equal(remote.commits.length, 1);
  }));

for (const change of ["source", "filename", "head", "session", "abort", "cancel"] as const) {
  test(`reviewed migration refuses stale ${change} evidence or a cancelled review`, () =>
    fixture(async ({ root, ctx, rules, remote, settings, save }) => {
      remote.seed(legacy("old-head"));
      const cancellation = new AbortController();
      ctx.ui.confirm = async () => {
        if (change === "source") await fs.appendFile(rules, "# Only a comment changed\n");
        if (change === "filename") {
          const setup = settings.syncSetups.work;
          assert.ok(setup?.sync.pathPolicy === "ignore-file");
          await fs.writeFile(path.join(root, "Other.rules"), activeRules);
          setup.sync.ignoreFile = "Other.rules";
          await save();
        }
        if (change === "head") remote.seed(legacy("new-head"));
        if (change === "session") ctx.sessionManager = { ...ctx.sessionManager };
        if (change === "abort") cancellation.abort();
        return change !== "cancel";
      };
      const result = push(ctx, { ...options, force: true, signal: cancellation.signal }, undefined, remote.factory);
      if (change === "cancel") assert.equal(await result, "cancelled");
      else if (change === "abort") await assert.rejects(result, { name: "AbortError" });
      else await assert.rejects(result, /Settings changed|Remote changed|Session changed/u);
      assert.deepEqual(remote.commits, []);
    }));
}

test("a policy change inside the backend prevents the reviewed head commit", () =>
  fixture(async ({ ctx, rules, remote }) => {
    remote.seed(legacy("old-head"));
    remote.duringPublish(() => fs.appendFile(rules, "# Only a comment changed\n"));
    await assert.rejects(push(ctx, { ...options, force: true }, undefined, remote.factory), /ignore policy changed/u);
    assert.deepEqual(remote.commits, []);
  }));

test("matching head metadata never overrides a differing immutable policy on mutation", () =>
  fixture(async ({ ctx, remote }) => {
    const config = await loadConfig();
    const local = await createSnapshot(config.snapshotIdentity, snapshotOptionsForContext(ctx, config));
    assert.ok(local.selection?.version === 4);
    const head = remote.seed(local);
    remote.retain({ ...local, selection: { ...local.selection, fingerprint: "f".repeat(64) } });
    const inspection = await inspectSync(config, snapshotOptionsForContext(ctx, config), undefined, remote.factory);
    assert.equal(inspection.selectionState?.ignorePolicyComparison, "match");
    await assert.rejects(
      pull(ctx, { ...options, yes: true, force: true }, remote.factory),
      /does not match its immutable snapshot/u,
    );
    await assert.rejects(
      push(ctx, { ...options, force: true }, undefined, remote.factory),
      /does not match its immutable snapshot/u,
    );
    assert.equal((await remote.backend.readHead())?.revision, head.revision);
    assert.deepEqual(remote.commits, []);
  }));

test("pull projects matching v6 under the reviewed local policy and does not install ignored files", () =>
  fixture(async ({ root, ctx, remote }) => {
    await fs.writeFile(path.join(root, "private.txt"), "keep local");
    const config = await loadConfig();
    const local = await createSnapshot(config.snapshotIdentity, snapshotOptionsForContext(ctx, config));
    remote.seed({ ...local, files: [file("notes.txt", "incoming"), file("private.txt", "do not install")] });
    assert.equal(await pull(ctx, options, remote.factory), "applied");
    assert.equal(await fs.readFile(path.join(root, "notes.txt"), "utf8"), "incoming");
    assert.equal(await fs.readFile(path.join(root, "private.txt"), "utf8"), "keep local");
    assert.ok(!syncPolicyChanged(await readStateForConfig(config), config));
  }));

for (const history of ["v6", "legacy"] as const) {
  test(`rollback reviews the exact local and remote effects of ${history} history under current rules`, () =>
    fixture(async ({ root, ctx, remote }) => {
      await fs.writeFile(path.join(root, "private.txt"), "keep local");
      await fs.writeFile(path.join(root, "notes.txt"), "initial local");
      const config = await loadConfig();
      const current = await createSnapshot(config.snapshotIdentity, snapshotOptionsForContext(ctx, config));
      assert.ok(current.selection?.version === 4);
      remote.seed(current);
      const files = [file("notes.txt", "historical"), file("private.txt", "do not restore")];
      const historical =
        history === "legacy"
          ? legacy("historical", files)
          : ({
              ...current,
              id: "historical",
              selection: { ...current.selection, fingerprint: "f".repeat(64) },
              files,
            } satisfies Snapshot);
      remote.retain(historical);
      await assert.rejects(
        rollback(ctx, { ...options, args: [historical.id], force: true, yes: true }, remote.factory),
        /separate foreground review/u,
      );
      let review = "";
      ctx.ui.confirm = async (_title, content) => {
        review = content;
        return true;
      };
      await rollback(ctx, { ...options, args: [historical.id] }, remote.factory);
      assert.match(review, /Historical rules are not adopted/u);
      assert.match(review, /Update locally: notes\.txt/u);
      assert.match(review, /Update remotely: notes\.txt/u);
      assert.doesNotMatch(review, /private\.txt/u);
      assert.equal(await fs.readFile(path.join(root, "notes.txt"), "utf8"), "historical");
      assert.equal(await fs.readFile(path.join(root, "private.txt"), "utf8"), "keep local");
      assert.deepEqual(remote.commits[0]?.selection, current.selection);
    }));
}

async function boundAction(ctx: EngineContext): Promise<CommandOptions> {
  ctx.ui.confirm = async () => assert.fail("Unexpected transfer confirmation");
  ctx.ui.select = async () => assert.fail("Unexpected transfer selection");
  const expected = syncCheckConfigFingerprint(await loadConfig());
  return {
    ...options,
    directionalAction: {
      validate: (current) => assert.equal(syncCheckConfigFingerprint(current), expected, "stale settings binding"),
    },
  };
}

for (const direction of ["push", "pull"] as const) {
  test(`the bound ${direction} selects its source, keeps excluded/live files, and retains a usable exact restore point`, () =>
    fixture(async ({ root, ctx, settings, save, remote }) => {
      const setup = settings.syncSetups.work;
      assert.ok(setup && setup.sync.scope === "agent-directory");
      setup.sync.sessions = true;
      await save();
      const dir = path.join(root, "sessions");
      await fs.mkdir(dir);
      const peer = path.join(dir, "peer.jsonl");
      ctx.protectedSessionFiles = [peer];
      const note = path.join(root, "notes.txt");
      const privateFile = path.join(root, "private.txt");
      const localOnly = path.join(root, "local.txt");
      const remoteOnly = path.join(root, "remote.txt");
      await fs.writeFile(peer, "local live");
      await fs.writeFile(privateFile, "private stays");
      await fs.writeFile(note, "accepted");
      assert.equal(await push(ctx, await boundAction(ctx), undefined, remote.factory), "applied");
      const config = await loadConfig();
      const seed = await createSnapshot(config.snapshotIdentity, snapshotOptionsForContext(ctx, config));
      const previous = remote.seed({
        ...seed,
        files: [
          file("notes.txt", "remote changed"),
          file("remote.txt", "remote only"),
          file("sessions/peer.jsonl", "remote live"),
        ],
      });
      await fs.writeFile(note, "local changed");
      await fs.writeFile(localOnly, "unpushed local only");
      const action = await boundAction(ctx);
      let message = "";
      assert.ok(action.directionalAction);
      action.directionalAction.notifySuccess = (value) => {
        message = value;
      };
      if (direction === "push") {
        await assert.rejects(push(ctx, options, undefined, remote.factory), /Remote or sync policy changed/u);
        assert.equal(await push(ctx, action, undefined, remote.factory), "applied");
        const latest = remote.commits.at(-1);
        assert.deepEqual(latest?.files, [
          file("local.txt", "unpushed local only"),
          file("notes.txt", "local changed"),
          file("sessions/peer.jsonl", "remote live"),
        ]);
        assert.match(message, /Restore the previous remote version .*History/u);
        const history = await remote.backend.listHistory();
        assert.ok(history.some((entry) => entry.snapshotRef === previous.snapshotRef));
        ctx.ui.confirm = async () => true;
        await rollback(ctx, { ...options, args: [previous.snapshotRef] }, remote.factory);
        assert.deepEqual(remote.commits.at(-1)?.files, [
          file("notes.txt", "remote changed"),
          file("remote.txt", "remote only"),
          file("sessions/peer.jsonl", "remote live"),
        ]);
      } else {
        await assert.rejects(pull(ctx, options, remote.factory), /Both local and remote changed/u);
        assert.equal(await pull(ctx, action, remote.factory), "applied");
        assert.equal(await fs.readFile(note, "utf8"), "remote changed");
        assert.equal(await fs.readFile(remoteOnly, "utf8"), "remote only");
        await assert.rejects(fs.stat(localOnly), { code: "ENOENT" });
        const backupPath = /Local backup: (.*\.json\.gz)\. To restore/u.exec(message)?.[1];
        assert.ok(backupPath);
        const backup = await decodeSnapshot(await fs.readFile(backupPath));
        assert.deepEqual(backup.files, [
          file("local.txt", "unpushed local only"),
          file("notes.txt", "local changed"),
          file("sessions/peer.jsonl", "local live"),
        ]);
        await applySnapshot(backup, new Set(["sessions/peer.jsonl"]), snapshotOptionsForContext(ctx, config));
        assert.equal(await fs.readFile(note, "utf8"), "local changed");
        assert.equal(await fs.readFile(localOnly, "utf8"), "unpushed local only");
        assert.equal((await remote.backend.readHead())?.revision, previous.revision);
      }
      assert.equal(await fs.readFile(privateFile, "utf8"), "private stays");
      assert.equal(await fs.readFile(peer, "utf8"), "local live");
    }));
}

for (const direction of ["push", "pull"] as const) {
  test(`one-action ${direction} requires approval before a narrowing policy can overwrite the destination`, () =>
    fixture(async ({ root, ctx, rules, remote }) => {
      await fs.writeFile(path.join(root, "notes.txt"), "accepted");
      await fs.writeFile(path.join(root, "omitted.txt"), "kept local");
      await fs.writeFile(path.join(root, "private.txt"), "never synchronized");
      await push(ctx, await boundAction(ctx), undefined, remote.factory);
      const invoke = (action: CommandOptions) =>
        direction === "push" ? push(ctx, action, undefined, remote.factory) : pull(ctx, action, remote.factory);
      const narrowed = "/private.txt\n/omitted.txt\n";
      await fs.writeFile(rules, narrowed);
      let action = await boundAction(ctx);
      ctx.ui.confirm = async (title) => {
        assert.match(title, /^Overwrite /u);
        return false;
      };
      assert.equal(await invoke(action), "cancelled");
      assert.equal(await fs.readFile(rules, "utf8"), narrowed);
      assert.equal(remote.commits.length, 1);
      action = await boundAction(ctx);
      ctx.ui.confirm = async (title) => {
        assert.match(title, /^Overwrite /u);
        return true;
      };
      assert.equal(await invoke(action), "applied");
      assert.equal(await fs.readFile(rules, "utf8"), direction === "push" ? narrowed : activeRules);
      assert.equal(await fs.readFile(path.join(root, "omitted.txt"), "utf8"), "kept local");
      assert.equal(await fs.readFile(path.join(root, "private.txt"), "utf8"), "never synchronized");
      assert.equal(remote.commits.length, direction === "push" ? 2 : 1);
      if (direction === "push")
        assert.deepEqual(
          remote.commits.at(-1)?.files.map((item) => item.path),
          ["notes.txt"],
        );
    }));
}

for (const failure of ["backup write", "backup corruption", "local race", "remote race"] as const) {
  test(`one-action Pull does not overwrite after ${failure}`, () =>
    fixture(async ({ root, ctx, remote }) => {
      const note = path.join(root, "notes.txt");
      const backups = path.join(root, "pi-sync", "backups");
      await fs.writeFile(note, "local");
      const config = await loadConfig();
      const snapshot = await createSnapshot(config.snapshotIdentity, snapshotOptionsForContext(ctx, config));
      remote.seed({ ...snapshot, files: [file("notes.txt", "incoming")] });
      if (failure === "backup write") {
        await fs.mkdir(path.dirname(backups));
        await fs.writeFile(backups, "not a directory");
      } else {
        engineHost().reserveTargets = async (_targets, run) => {
          if (failure === "backup corruption") {
            const [backup] = await fs.readdir(backups);
            assert.ok(backup);
            await fs.writeFile(path.join(backups, backup), "not a snapshot");
          } else if (failure === "local race") await fs.writeFile(note, "edited during reservation");
          else remote.seed({ ...snapshot, id: "raced", files: [file("notes.txt", "new incoming")] });
          return run();
        };
      }
      const onCommit = vi.fn();
      const expected = {
        "backup write": /EEXIST/u,
        "backup corruption": /backup could not be verified/u,
        "local race": /preimage changed/u,
        "remote race": /Remote changed/u,
      }[failure];
      await assert.rejects(pull(ctx, { ...(await boundAction(ctx)), onCommit }, remote.factory), expected);
      assert.equal(onCommit.mock.calls.length, 0);
      assert.equal(await fs.readFile(note, "utf8"), failure === "local race" ? "edited during reservation" : "local");
    }));
}

test("an aggregate Pull failure retains the exact backup and both cleanup errors", () =>
  fixture(async ({ root, ctx, remote }) => {
    const note = path.join(root, "notes.txt");
    await fs.writeFile(note, "local before Pull");
    const config = await loadConfig();
    const local = await createSnapshot(config.snapshotIdentity, snapshotOptionsForContext(ctx, config));
    remote.seed({ ...local, files: [file("notes.txt", "incoming")] });
    const failures = [new Error("Apply did not settle."), new Error("Cleanup could not be confirmed.")];
    engineHost().reserveTargets = async (_targets, apply) => {
      await apply();
      throw new AggregateError(failures, "Queue cleanup did not settle after apply.");
    };
    let archive: string | undefined;
    await assert.rejects(pull(ctx, await boundAction(ctx), remote.factory), (error: unknown) => {
      assert.ok(error instanceof AggregateError);
      assert.deepEqual(error.errors, failures);
      assert.match(error.message, /outcome is not verified/u);
      archive = /Local backup: (.*\.json\.gz)\. To restore/u.exec(error.message)?.[1];
      return true;
    });
    assert.ok(archive);
    assert.deepEqual((await decodeSnapshot(await fs.readFile(archive))).files, [
      file("notes.txt", "local before Pull"),
    ]);
  }));

test("bound Push rechecks the checkpoint before any remote write", () =>
  fixture(async ({ root, ctx, remote }) => {
    const note = path.join(root, "notes.txt");
    await fs.writeFile(note, "initially approved");
    const action = await boundAction(ctx);
    assert.ok(action.directionalAction);
    action.directionalAction.checkpoint = async (fingerprint) => {
      assert.match(fingerprint, /^[a-f0-9]{64}$/u);
      await fs.writeFile(note, "changed while the checkpoint was retained");
    };
    await assert.rejects(
      push(ctx, action, undefined, remote.factory),
      /Local bytes changed at the push publication boundary/u,
    );
    assert.equal(remote.commits.length, 0);
  }));

test("bound Push still rejects local changes inside backend publication", () =>
  fixture(async ({ root, ctx, remote }) => {
    const note = path.join(root, "notes.txt");
    await fs.writeFile(note, "initial bytes");
    remote.duringPublish(() => fs.writeFile(note, "changed in backend"));
    await assert.rejects(
      push(ctx, await boundAction(ctx), undefined, remote.factory),
      /Local bytes changed at the push publication boundary/u,
    );
    assert.equal(remote.commits.length, 0);
    assert.equal(await fs.readFile(note, "utf8"), "changed in backend");
  }));

test("one-action Pull protects a selected-path case alias even for a destination-only removal", () =>
  fixture(async ({ root, ctx, settings, save, remote }) => {
    const setup = settings.syncSetups.work;
    assert.ok(setup);
    setup.sync = { include: ["AGENTS.md"], automatic: false };
    await save();
    await fs.writeFile(path.join(root, "agents.MD"), "preimage not stored at its actual spelling");
    const config = await loadConfig();
    const snapshot = await createSnapshot(config.snapshotIdentity, snapshotOptionsForContext(ctx, config));
    remote.seed({ ...snapshot, files: [] });
    await assert.rejects(pull(ctx, await boundAction(ctx), remote.factory), /case-variant paths/u);
    assert.equal(await fs.readFile(path.join(root, "agents.MD"), "utf8"), "preimage not stored at its actual spelling");
  }));

test("the bound Push cannot be combined with existing commands or authorization flags", () =>
  fixture(async ({ ctx, remote }) => {
    const action = await boundAction(ctx);
    for (const extra of [{ auto: true }, { force: true }, { yes: true }, { background: { validate() {} } }]) {
      await assert.rejects(
        push(ctx, { ...action, ...extra }, undefined, remote.factory),
        /bound foreground Push or Pull/u,
      );
    }
    await assert.rejects(syncBoth(ctx, action, remote.factory), /cannot authorize bidirectional Sync/u);
    assert.deepEqual(remote.commits, []);
  }));

test.each(["during payload", "before rule install", "after rule install", "during rule directory sync"] as const)(
  "an interruption %s leaves a reviewed recovery path after the remote head advances",
  (phase) =>
    fixture(async ({ root, rules, ctx, remote }) => {
      const config = await loadConfig();
      const local = await createSnapshot(config.snapshotIdentity, snapshotOptionsForContext(ctx, config));
      assert.equal(local.selection?.version, 4);
      const incomingRules = "# Active publisher rules\r\n/leave-local.txt\r\n";
      if (phase === "during rule directory sync" && process.platform === "win32") return;
      const head = remote.seed({
        ...local,
        id: "incoming",
        version: 7,
        selection: { ...local.selection, fingerprint: ignorePolicyFingerprint(incomingRules, false) },
        ignoreRules: { filename: ".syncignore", text: incomingRules },
        files: [file("notes.txt", "incoming")],
      });
      const notes = path.join(root, "notes.txt");
      await fs.writeFile(notes, "local");
      await fs.writeFile(path.join(root, "leave-local.txt"), "left local under the new rules");
      const controller = new AbortController();
      const mutate = engineHost().mutate;
      const rename = fs.rename;
      const open = fs.open;
      const syncFault = vi.spyOn(fs, "open").mockImplementation(async (...args) => {
        if (
          phase === "during rule directory sync" &&
          args[0] === root &&
          args[1] === "r" &&
          (await fs.readFile(rules, "utf8")) === incomingRules
        )
          throw new Error("Simulated interruption syncing the rule directory");
        return open(...args);
      });
      const fault = vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
        if (phase === "after rule install" && to === statePathForConfig(config))
          throw new Error("Simulated interruption before baseline publication");
        await rename(from, to);
        if (phase === "during payload" && to === notes) controller.abort();
      });
      engineHost().mutate = async (target, action) => {
        if (phase === "before rule install" && target === rules)
          throw new Error("Simulated interruption before rule installation");
        return mutate(target, action);
      };
      try {
        await assert.rejects(
          pull(ctx, { ...options, signal: controller.signal }, remote.factory),
          /Simulated interruption|cancelled/u,
        );
      } finally {
        fault.mockRestore();
        engineHost().mutate = mutate;
      }
      try {
        if (phase === "during rule directory sync") {
          await assert.rejects(pull(ctx, options, remote.factory), /interruption syncing the rule directory/u);
          assert.equal(hasPendingAdoption(), true);
          assert.equal((await readStateForConfig(config)).lastAppliedSnapshot, undefined);
        }
      } finally {
        syncFault.mockRestore();
      }
      assert.equal(await fs.readFile(notes, "utf8"), "incoming");
      assert.equal(
        await fs.readFile(rules, "utf8"),
        phase === "after rule install" || phase === "during rule directory sync" ? incomingRules : activeRules,
      );
      assert.equal(hasPendingAdoption(), true);
      assert.equal((await readStateForConfig(config)).lastAppliedSnapshot, undefined);
      await assert.rejects(push(ctx, options, undefined, remote.factory), /Pending ignore-rule adoption/u);
      const newer = remote.seed(legacy("newer-head", [file("remote.txt", "not reviewed")]));
      if (phase === "during payload") {
        assert.ok((await pendingTransactionEntries()).length);
        const reads = remote.reads();
        await fs.writeFile(rules, "# different local rules\n");
        await assert.rejects(initializeSync(ctx, new AbortController().signal), /file transaction no longer match/u);
        assert.ok((await pendingTransactionEntries()).length);
        assert.equal(await fs.readFile(notes, "utf8"), "incoming");
        await fs.writeFile(rules, activeRules);
        await initializeSync(ctx, new AbortController().signal);
        assert.equal(remote.reads(), reads);
        assert.equal(await fs.readFile(notes, "utf8"), "local");
        assert.equal(await fs.readFile(rules, "utf8"), activeRules);
        assert.deepEqual(await pendingTransactionEntries(), []);
        assert.equal(hasPendingAdoption(), true);
      }
      ctx.ui.confirm = async (title, summary) => {
        assert.match(title, /Resume reviewed/u);
        assert.match(summary, /recorded snapshot, not the current remote head/u);
        return false;
      };
      assert.equal(await pull(ctx, options, remote.factory), "cancelled");
      assert.equal(hasPendingAdoption(), true);
      ctx.ui.confirm = async () => true;
      assert.equal(await pull(ctx, options, remote.factory), "applied");
      assert.equal(hasPendingAdoption(), false);
      assert.equal(await fs.readFile(rules, "utf8"), incomingRules);
      assert.equal(await fs.readFile(path.join(root, "leave-local.txt"), "utf8"), "left local under the new rules");
      assert.equal((await readStateForConfig(await loadConfig())).lastAppliedSnapshot, head.snapshotId);
      assert.equal((await remote.backend.readHead())?.revision, newer.revision);
      assert.equal(await fs.readFile(notes, "utf8"), "incoming");
    }),
);

test.each(["head changed", "shared source", "session opt-in changed", "protected live file"] as const)(
  "Pull preserves local rules and files when the %s",
  (reason) =>
    fixture(async ({ root, ctx, rules, remote, settings, save }) => {
      const config = await loadConfig();
      const local = await createSnapshot(config.snapshotIdentity, snapshotOptionsForContext(ctx, config));
      assert.equal(local.selection?.version, 4);
      const text = "# remote rules\n/private.txt\n";
      const sessions = reason === "session opt-in changed";
      const foreign = {
        ...local,
        id: "incoming-rules",
        version: 7,
        ignoreRules: { filename: ".syncignore", text },
        selection: { ...local.selection, sessions, fingerprint: ignorePolicyFingerprint(text, sessions) },
        files: [file("notes.txt", "incoming")],
      };
      remote.seed(foreign);
      const note = path.join(root, "notes.txt");
      await fs.writeFile(note, "keep local");
      if (reason === "shared source") {
        const setup = settings.syncSetups.work;
        assert.ok(setup);
        settings.syncSetups.shared = { ...setup, storage: { ...setup.storage, path: "another" } };
        await save();
      }
      if (reason === "protected live file") ctx.protectedSessionFiles = [rules];
      ctx.ui.confirm = async () => {
        assert.equal(reason, "head changed");
        remote.seed({ ...foreign, id: "advanced" });
        return true;
      };
      const error = {
        "head changed": /Remote changed/u,
        "shared source": /shared by other setups/u,
        "session opt-in changed": /Sessions opt-in differs/u,
        "protected live file": /protected live session/u,
      }[reason];
      await assert.rejects(pull(ctx, options, remote.factory), error);
      assert.equal(await fs.readFile(note, "utf8"), "keep local");
      assert.equal(await fs.readFile(rules, "utf8"), activeRules);
      assert.equal(hasPendingAdoption(), false);
    }),
);

test("a self-excluding publication never carries the active rule text forward or deletes local rules on Pull", () =>
  fixture(async ({ root, rules, ctx, remote }) => {
    await fs.writeFile(path.join(root, "notes.txt"), "notes");
    assert.equal(await push(ctx, options, undefined, remote.factory), "applied");
    const first = await remote.backend.readHead();
    assert.ok(first);
    await fs.appendFile(rules, "/Local.rules\n# text stays local\n");
    assert.equal(await push(ctx, options, undefined, remote.factory), "applied");
    assert.equal(remote.commits.at(-1)?.ignoreRules, null);
    assert.doesNotMatch(JSON.stringify(remote.commits.at(-1)), /text stays local/u);
    assert.deepEqual((await remote.backend.readSnapshot(first.snapshotRef)).ignoreRules, {
      filename: "Local.rules",
      text: activeRules,
    });
    await fs.writeFile(rules, activeRules);
    await assert.rejects(pull(ctx, options, remote.factory), /exclude their own file/u);
    assert.equal(await fs.readFile(rules, "utf8"), activeRules);
  }));

test("mixed legacy setups reserve configured ignore control files without changing portable selection", () =>
  fixture(async ({ settings }) => {
    const setup = settings.syncSetups.work;
    assert.ok(setup);
    const policies: (typeof setup.sync)[] = [
      { include: ["Local.rules", "notes.txt"], automatic: false },
      { scope: "agent-directory", exclude: ["local.rules"], reinclude: ["local.rules"], automatic: false },
    ];
    for (const policy of policies) {
      settings.syncSetups.other = { ...setup, sync: policy };
      const config = configFromSettings(settings, "other");
      assert.equal(compileSyncPolicyExclude(config)("LOCAL.RULES"), true);
      assert.equal(compileSyncPolicyTraversal(config)("LOCAL.RULES/child"), false);
      assert.equal(configuredSnapshotPathMatcher(config)("Local.rules"), false);
      assert.equal(configuredSnapshotPathMatcher(config)("notes.txt"), true);
      const selection = selectionForSnapshot(config.include, config.exclude, config);
      assert.equal(selection.version, policy.scope ? 3 : 1);
      assert.doesNotMatch(JSON.stringify(selection), /reservedIgnoreNames/u);
    }
  }));
