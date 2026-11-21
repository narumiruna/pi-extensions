import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test, vi } from "vitest";
import { configureEngineHost, type EngineContext } from "../src/engine/host.js";
import { configFromSettings } from "../src/engine/settings/config.js";
import type { PiSyncSettingsV3 } from "../src/engine/settings/settings-types.js";
import { configuredSessionDir, snapshotOptionsForContext } from "../src/engine/snapshot/session-paths.js";
import {
  createSnapshot,
  filterSnapshotForConfigPolicy,
  mergeRemotePreservedFiles,
} from "../src/engine/snapshot/snapshot.js";
import { applySnapshot, preflightSnapshotMutations } from "../src/engine/snapshot/snapshot-apply.js";
import { decodeSnapshot, encodeSnapshot } from "../src/engine/snapshot/snapshot-codec.js";
import { assertUnexcludedTargets } from "../src/engine/snapshot/snapshot-exclude-safety.js";
import {
  applySnapshotTransaction,
  recoverPendingSnapshotTransactions,
} from "../src/engine/snapshot/snapshot-transaction.js";
import { transactionRoot } from "../src/engine/snapshot/snapshot-transaction-directory.js";
import type { Snapshot, SnapshotOptions } from "../src/engine/snapshot/snapshot-types.js";

const reserved = { reservedIgnoreNames: [".syncignore", "alternate.rules", "work.rules"] } as const;
const rules = [".SYNCIGNORE", "Alternate.Rules", "WORK.Rules"] as const;
const protectedPath = /protected ignore rule path/;

async function fixture(run: (root: string) => Promise<void>) {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "pi-sync-mixed-legacy-")));
  const root = path.join(base, "agent.jsonl");
  try {
    await fs.mkdir(root);
    configureEngineHost({ root: () => root, mutate: async (_target, action) => action(), review: async () => true });
    await run(root);
  } finally {
    await fs.rm(base, { recursive: true, force: true });
  }
}

async function put(root: string, relative: string, value = relative) {
  const target = path.join(root, relative);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, value);
  return target;
}

function remoteFile(path: string) {
  const bytes = Buffer.from(`remote:${path}`);
  return { path, contentBase64: bytes.toString("base64"), sha256: createHash("sha256").update(bytes).digest("hex") };
}

function paths(snapshot: Snapshot) {
  return snapshot.files.map(({ path }) => path).sort();
}

const scopes = [
  { include: [...rules, "notes", "remove.md"] },
  { include: [...rules, "notes", "remove.md"], exclude: [] },
  { scope: "agent-directory", include: [], exclude: ["notes"], reinclude: ["notes/*.rules", "work.rules"] },
] satisfies SnapshotOptions[];

test.each(scopes.map((options, idx) => ({ options, version: [1, 4, 5][idx] })))(
  "mixed legacy snapshot v$version does not collect, project, preserve, write, or delete reserved paths",
  ({ options, version }) =>
    fixture(async (root) => {
      for (const file of [...rules, "notes/alternate.rules", "remove.md"]) await put(root, file);
      const legacy = await createSnapshot("legacy", options);
      for (const file of rules) assert.ok(paths(legacy).includes(file));
      const mixed = { ...options, ...reserved };
      const local = await createSnapshot("legacy", mixed);
      assert.equal(local.version, version);
      assert.deepEqual(local.selection, legacy.selection);
      assert.deepEqual(paths(local), ["notes/alternate.rules", "remove.md"]);
      assert.deepEqual(await decodeSnapshot(await encodeSnapshot(local)), local);

      const incoming = {
        ...legacy,
        files: [
          remoteFile("notes/alternate.rules"),
          remoteFile("wOrK.rUlEs"),
          remoteFile("alternate.rules/leaf"),
          remoteFile(".syncignore"),
        ],
      };
      assert.deepEqual(paths(filterSnapshotForConfigPolicy(incoming, mixed)), ["notes/alternate.rules"]);
      const preserved = mergeRemotePreservedFiles(legacy, incoming, mixed);
      assert.deepEqual(paths(preserved), paths(local));
      assert.deepEqual(preserved.selection, legacy.selection);

      const applied = await applySnapshot(incoming, new Set(), mixed);
      assert.deepEqual(Object.keys(applied), ["notes/alternate.rules"]);
      for (const file of rules) assert.equal(await fs.readFile(path.join(root, file), "utf8"), file);
      assert.equal(await fs.readFile(path.join(root, "notes/alternate.rules"), "utf8"), "remote:notes/alternate.rules");
      await assert.rejects(fs.stat(path.join(root, "remove.md")), { code: "ENOENT" });
    }),
);

test("reserved names are local snapshot options derived from all setups in a mixed document", () => {
  const settings: PiSyncSettingsV3 = {
    version: 8,
    activeSyncSetup: "legacy",
    onSwitch: "switch-only",
    storageConnections: { origin: { type: "git", remote: "git@example.invalid:owner/sync.git" } },
    syncSetups: {
      legacy: {
        storage: { connection: "origin", path: "legacy" },
        sync: { include: ["WORK.Rules"], automatic: false },
      },
      custom: {
        storage: { connection: "origin", path: "custom" },
        sync: { scope: "agent-directory", pathPolicy: "ignore-file", ignoreFile: "Work.Rules", automatic: false },
      },
      alternate: {
        storage: { connection: "origin", path: "alternate" },
        sync: { scope: "agent-directory", pathPolicy: "ignore-file", ignoreFile: "Alternate.Rules", automatic: false },
      },
    },
  };
  const context = { sessionManager: {} } as EngineContext;
  const options = snapshotOptionsForContext(context, configFromSettings(settings));
  assert.deepEqual(options.reservedIgnoreNames, reserved.reservedIgnoreNames);
  assert.deepEqual(options.include, ["WORK.Rules"]);
  assert.equal(options.ignorePolicy, undefined);
});

test("mixed safety preflight refuses rule paths and ancestor replacements even without glob rules", () =>
  fixture(async (root) => {
    const child = await put(root, "Work.Rules/leaf");
    for (const exclude of [undefined, []]) {
      const legacy = { exclude, sessionDir: path.dirname(root) };
      await assertUnexcludedTargets(root, [child, root], legacy);
      for (const target of [child, path.dirname(child), root, path.dirname(root)]) {
        const options = { ...legacy, ...reserved };
        await assert.rejects(assertUnexcludedTargets(root, [target], options), protectedPath);
        await assert.rejects(
          preflightSnapshotMutations(root, { deletes: [target], writes: [] }, legacy.sessionDir, options),
          protectedPath,
        );
      }
    }
  }));

test("mixed operations refuse settings aliases, linked source files and reserved physical session storage", () =>
  fixture(async (root) => {
    const privateFile = await put(root, "Work.Rules", '{"sessionDir":"/unrelated"}');
    const settings = path.join(root, "settings.json");
    await fs.symlink(privateFile, settings);
    assert.equal(await configuredSessionDir(), "/unrelated");
    await assert.rejects(configuredSessionDir(reserved), protectedPath);
    await assert.rejects(createSnapshot("legacy", { ...reserved, include: ["settings.json"] }), protectedPath);
    await fs.unlink(settings);
    await fs.link(privateFile, settings);
    await assert.rejects(configuredSessionDir(reserved), /unsafe filesystem layout/);
    await assert.rejects(
      preflightSnapshotMutations(root, { deletes: [settings], writes: [] }, undefined, reserved),
      /hard link/,
    );

    await fs.unlink(settings);
    const privateDir = path.dirname(await put(root, "Alternate.Rules/session.jsonl"));
    const logicalSessionAlias = path.join(root, "alias");
    await fs.symlink(privateDir, logicalSessionAlias, "dir");
    await assert.rejects(
      createSnapshot("legacy", { ...reserved, include: ["sessions"], sessionDir: logicalSessionAlias }),
      protectedPath,
    );
    await assert.rejects(createSnapshot("legacy", { ...reserved, include: ["alias/session.jsonl"] }), protectedPath);
    await assert.rejects(
      createSnapshot("legacy", {
        ...reserved,
        scope: "agent-directory",
        include: ["sessions"],
        sessionDir: privateDir,
      }),
      /overlaps protected agent files/,
    );
    await assert.rejects(
      preflightSnapshotMutations(
        root,
        {
          deletes: [],
          writes: [{ target: path.join(logicalSessionAlias, "new.jsonl"), content: Buffer.from("remote") }],
        },
        logicalSessionAlias,
        reserved,
      ),
      protectedPath,
    );
    assert.equal(await fs.readFile(path.join(privateDir, "session.jsonl"), "utf8"), "Alternate.Rules/session.jsonl");
  }));

test("mixed recovery retains a legacy journal that would restore over a newly reserved path", () =>
  fixture(async (root) => {
    const file = await put(root, "WORK.Rules", "before");
    const cancellation = new AbortController();
    const rename = fs.rename.bind(fs);
    const patch = vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
      await rename(from, to);
      if (to === file) cancellation.abort();
    });
    try {
      await assert.rejects(
        applySnapshotTransaction(
          { deletes: [], writes: [{ target: file, content: Buffer.from("after") }] },
          {
            signal: cancellation.signal,
          },
        ),
        /transaction evidence retained/,
      );
    } finally {
      patch.mockRestore();
    }
    assert.equal(await fs.readFile(file, "utf8"), "after");
    const pending = await fs.readdir(transactionRoot());
    assert.equal(pending.length, 1);
    await assert.rejects(recoverPendingSnapshotTransactions(reserved), protectedPath);
    assert.deepEqual(await fs.readdir(transactionRoot()), pending);
    assert.equal(await fs.readFile(file, "utf8"), "after");
  }));
