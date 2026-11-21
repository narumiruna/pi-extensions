import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test, vi } from "vitest";
import { expectedRemoteHead, type RemoteHead, type SyncBackend } from "../src/engine/backends/sync-backend.js";
import type { CommandOptions } from "../src/engine/commands/command-types.js";
import { configureEngineHost, type EngineContext, getEngineRoot } from "../src/engine/host.js";
import { configFromSettings, loadConfig } from "../src/engine/settings/config.js";
import type { PiSyncSettingsV3 } from "../src/engine/settings/settings-types.js";
import { snapshotOptionsForContext } from "../src/engine/snapshot/session-paths.js";
import { createSnapshot } from "../src/engine/snapshot/snapshot.js";
import type { Snapshot, SnapshotFile } from "../src/engine/snapshot/snapshot-types.js";
import { readStateForConfig } from "../src/engine/state/sync-state-store.js";
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

vi.mock(import("../src/engine/settings/config.js"), async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    loadConfig: async (setup?: string) => {
      const settings = JSON.parse(await fs.readFile(path.join(getEngineRoot(), "pi-sync.json"), "utf8"));
      return actual.resolveIgnoreConfig(settings, setup);
    },
  };
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
      opts.onCommit?.();
      commits.push(snapshot);
      return { head: seed(snapshot), warnings: [] };
    },
    listHistory: async () => [],
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
      for (const direction of [options, { ...options, force: true, yes: true }]) {
        await assert.rejects(push(ctx, direction, undefined, remote.factory), mismatch(comparison));
        await assert.rejects(pull(ctx, direction, remote.factory), mismatch(comparison));
        await assert.rejects(syncBoth(ctx, direction, remote.factory), mismatch(comparison));
      }
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
    assert.equal(upload.version, 6);
    assert.deepEqual(
      upload.files.map((entry) => entry.path),
      ["notes.txt"],
    );
    assert.deepEqual(upload.selection, selectionForSnapshot([], undefined, config));
    assert.doesNotMatch(JSON.stringify(upload), /Local\.rules|private\.txt|sourceDigest/u);
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
