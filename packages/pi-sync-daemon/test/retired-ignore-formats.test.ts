import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { test } from "vitest";
import type { RemoteHead, SyncBackend } from "../src/engine/backends/sync-backend.js";
import { configFromSettings } from "../src/engine/settings/config.js";
import { assertNoRetiredRuleJournal } from "../src/engine/settings/retired-ignore-recovery.js";
import { validateSettingsDocument } from "../src/engine/settings/settings-validation.js";
import { decodeSnapshot } from "../src/engine/snapshot/snapshot-codec.js";
import { validateJournalPolicy } from "../src/engine/snapshot/snapshot-transaction-policy.js";
import { readStateForConfig, statePathForConfig } from "../src/engine/state/sync-state-store.js";
import { mergeJournalPath, requireNoMergeJournal } from "../src/engine/sync/merge-journal.js";
import { readSnapshotForHead } from "../src/engine/sync/remote-snapshot.js";
import { portableSnapshotSelection } from "../src/engine/sync/sync-policy.js";
import { installServiceHost } from "../src/service-host.js";

const help = /\/skill:configure-pi-sync/u;
const selection = { version: 4, scope: "agent-directory", fingerprint: "a".repeat(64), sessions: false };
const latest: RemoteHead = {
  snapshotId: "fixture",
  snapshotRef: "fixture",
  revision: "r1",
  createdAt: "2026-01-01T00:00:00Z",
  machine: "fixture",
  syncSessions: false,
};

test.each([
  [6, {}],
  [7, { ignoreRules: null }],
  [7, { ignoreRules: { filename: ".syncignore", text: "/private/\n" } }],
])("retired snapshot v%i is refused even when the remote head omits selection", async (version, metadata) => {
  const bytes = gzipSync(
    JSON.stringify({ ...latest, ...metadata, id: latest.snapshotId, version, selection, files: [] }),
  );
  const backend = {
    readSnapshot: async (reference) => {
      assert.equal(reference, latest.snapshotRef);
      return decodeSnapshot(bytes);
    },
  } satisfies Pick<SyncBackend, "readSnapshot">;
  await assert.rejects(decodeSnapshot(bytes), help);
  await assert.rejects(readSnapshotForHead(backend as SyncBackend, latest), help);
  assert.throws(() => portableSnapshotSelection(selection), help);
});

test.each([8, 9])("settings version %i remains valid until a retired setup is present", (version) => {
  const settings = {
    version,
    onSwitch: "switch-only",
    activeSyncSetup: "home",
    storageConnections: { git: { type: "git", remote: "git@example.invalid:owner/sync.git" } },
    syncSetups: {
      home: {
        storage: { connection: "git", branch: "home", path: "./" },
        sync: { include: ["AGENTS.md"], automatic: false },
      },
    },
  };
  assert.equal(validateSettingsDocument(settings).version, version);
  assert.throws(
    () =>
      validateSettingsDocument({
        ...settings,
        syncSetups: {
          ...settings.syncSetups,
          retired: {
            storage: { connection: "git", branch: "retired", path: "./" },
            sync: { scope: "agent-directory", pathPolicy: "ignore-file", automatic: false },
          },
        },
      }),
    help,
  );
});

test("retired baseline and pending merge cannot be accepted or cleared by force", async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "pi-sync-retired-state-")));
  try {
    installServiceHost(root);
    const config = configFromSettings(
      validateSettingsDocument({
        version: 8,
        onSwitch: "switch-only",
        activeSyncSetup: "home",
        storageConnections: { git: { type: "git", remote: "git@example.invalid:owner/sync.git" } },
        syncSetups: {
          home: {
            storage: { connection: "git", branch: "home", path: "./" },
            sync: { include: ["AGENTS.md"], automatic: false },
          },
        },
      }),
    );
    const file = statePathForConfig(config);
    const journal = mergeJournalPath(config);
    await fs.mkdir(path.dirname(file), { recursive: true });
    const baseline = JSON.stringify({
      version: 2,
      profile: config.snapshotIdentity,
      lastFileHashes: {},
      ignorePolicyKey: "a".repeat(64),
    });
    const pending = JSON.stringify({ version: 3, localPolicyKey: "b".repeat(64) });
    await fs.writeFile(file, baseline, { mode: 0o600 });
    await fs.writeFile(journal, pending, { mode: 0o600 });
    await assert.rejects(readStateForConfig(config), /last accepted sync.*configure-pi-sync/u);
    await assert.rejects(requireNoMergeJournal(config, { force: true }), /recovery.*configure-pi-sync/u);
    assert.equal(await fs.readFile(file, "utf8"), baseline);
    assert.equal(await fs.readFile(journal, "utf8"), pending);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test.each([11, 12, 13])("transaction journal v%i cannot authorize recovery or cleanup", (version) => {
  assert.throws(() => validateJournalPolicy({ version }), /recovery.*configure-pi-sync/u);
});

test.each([".pi-sync.json.syncignore-creation", "pi-sync/ignore-adoption.json"])(
  "preserve pending %s without blocking an archived record",
  async (relative) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-sync-retired-journal-"));
    try {
      const archive = path.join(root, "pi-sync/backups/archive.ignore-adoption.json");
      await fs.mkdir(path.dirname(archive), { recursive: true });
      await fs.writeFile(archive, "archive\n");
      assert.doesNotThrow(() => assertNoRetiredRuleJournal(root));
      const pending = path.join(root, relative);
      await fs.writeFile(pending, "pending evidence\n");
      assert.throws(() => assertNoRetiredRuleJournal(root), /recovery.*configure-pi-sync/u);
      assert.equal(await fs.readFile(pending, "utf8"), "pending evidence\n");
      assert.equal(await fs.readFile(archive, "utf8"), "archive\n");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  },
);
