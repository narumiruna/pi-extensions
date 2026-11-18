import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { test, vi } from "vitest";
import {
  createSnapshot,
  filterSnapshotForConfigPolicy,
  mergeRemotePreservedFiles,
  mergeRemoteSessionFiles,
  snapshotIncludesSessions,
  snapshotWithoutSessions,
} from "../src/snapshot/snapshot.js";
import { applySnapshot, preflightSnapshotApply, preflightSnapshotMutations } from "../src/snapshot/snapshot-apply.js";
import { decodeSnapshot, encodeSnapshot } from "../src/snapshot/snapshot-codec.js";
import { applySnapshotTransaction, recoverPendingSnapshotTransactions } from "../src/snapshot/snapshot-transaction.js";
import { transactionRoot } from "../src/snapshot/snapshot-transaction-directory.js";
import { portableSnapshot, validatePortableSnapshot } from "../src/sync/local-fields.js";
import { preflightMergedTargets } from "../src/sync/merge-apply.js";
import { readSnapshotForHead } from "../src/sync/remote-snapshot.js";
import { selectionForSnapshot } from "../src/sync/sync-policy.js";
import { snapshot, withTempHome } from "./helpers.js";
import { MemorySyncBackend } from "./memory-sync-backend.js";

const include = ["settings.json", "skills", "custom", "sessions"];
const exclude = ["settings.json", "skills/private", "custom/**/*.log", "sessions/**/scratch-*.jsonl"];

test("collection prunes excluded directories before any content reads, including virtual sessions", async () =>
  withTempHome(async (root) => {
    for (const name of ["skills/private", "skills/public", "custom/nested", "conversation-store/project"])
      await fs.mkdir(path.join(root, name), { recursive: true });
    const excludedFiles = [
      "settings.json",
      "skills/private/a.md",
      "custom/nested/a.log",
      "conversation-store/project/scratch-a.jsonl",
    ].map((name) => path.join(root, name));
    for (const file of excludedFiles) await fs.writeFile(file, "sk-123456789012345678901234567890");
    for (const name of ["skills/public/a.md", "custom/nested/keep.txt", "conversation-store/project/keep.jsonl"])
      await fs.writeFile(path.join(root, name), "keep");
    const read = vi.spyOn(fs, "readFile");
    const list = vi.spyOn(fs, "readdir");
    try {
      const result = await createSnapshot("home", {
        include,
        exclude,
        sessionDir: path.join(root, "conversation-store"),
      });
      assert.equal(result.version, 4);
      assert.deepEqual(result.selection, selectionForSnapshot(include, exclude));
      assert.deepEqual(
        result.files.map((file) => file.path),
        ["custom/nested/keep.txt", "sessions/project/keep.jsonl", "skills/public/a.md"],
      );
      const readFiles = read.mock.calls.map(([file]) => String(file));
      for (const file of excludedFiles) assert.ok(!readFiles.includes(file), `unexpected read: ${file}`);
      assert.ok(list.mock.calls.every(([file]) => String(file) !== path.join(root, "skills/private")));
    } finally {
      read.mockRestore();
      list.mockRestore();
    }
  }));

test("a trailing globstar prunes the session root and its effective session metadata", async () =>
  withTempHome(async (root) => {
    await fs.mkdir(root, { recursive: true });
    const result = await createSnapshot("home", {
      include: ["sessions"],
      exclude: ["sessions/**"],
      sessionDir: path.join(root, "missing-sessions"),
    });
    assert.deepEqual(result.files, []);
    assert.equal(result.syncSessions, false);
    assert.equal(snapshotIncludesSessions(result), false);
  }));

test("new publications omit excluded remote files, but preserve unrelated unmanaged content", () => {
  const local = {
    ...snapshot([{ path: "skills/public/a.md", content: Buffer.from("local") }]),
    version: 4,
    selection: selectionForSnapshot(include, exclude),
  };
  const remote = snapshot([
    { path: "skills/private/a.md", content: Buffer.from("private") },
    { path: "custom/a.log", content: Buffer.from("log") },
    { path: "other.toml", content: Buffer.from("unmanaged") },
  ]);
  assert.deepEqual(
    mergeRemotePreservedFiles(local, remote, { include, exclude }).files.map((file) => file.path),
    ["other.toml", "skills/public/a.md"],
  );
  assert.deepEqual(filterSnapshotForConfigPolicy(remote, { include, exclude }).files, []);
});

test("session and field projections retain exclude format and omit excluded session files", () => {
  const local = {
    ...snapshot([{ path: "settings.json", content: Buffer.from('{"local":"private","theme":"dark"}') }]),
    version: 4,
    selection: selectionForSnapshot(include, ["sessions/**/scratch-*.jsonl"]),
  };
  const portable = portableSnapshot(local, ["local"]);
  assert.equal(portable.version, 4);
  assert.doesNotMatch(Buffer.from(portable.files[0]?.contentBase64 ?? "", "base64").toString(), /private/);
  const remote = snapshot([
    { path: "sessions/p/scratch-a.jsonl", content: Buffer.from("excluded") },
    { path: "sessions/p/keep.jsonl", content: Buffer.from("keep") },
  ]);
  const merged = mergeRemoteSessionFiles(portable, remote);
  assert.equal(merged.version, 4);
  assert.equal(
    merged.files.some((file) => file.path.includes("scratch-")),
    false,
  );
  assert.deepEqual(snapshotWithoutSessions(merged).selection?.exclude, local.selection.exclude);
  validatePortableSnapshot(snapshotWithoutSessions(merged));
});

for (const outer of [1, 2, 3])
  test(`snapshot v${outer} cannot smuggle an exclude policy`, async () => {
    const invalid = { ...snapshot([]), version: outer, selection: selectionForSnapshot(["skills"], []) };
    await assert.rejects(decodeSnapshot(gzipSync(JSON.stringify(invalid))), /version 4/);
  });

test("v4 codec binds the complete head policy and rejects excluded payloads", async () => {
  const image = { ...snapshot([]), version: 4, selection: selectionForSnapshot(["skills"], ["skills/private"]) };
  assert.deepEqual(await decodeSnapshot(await encodeSnapshot(image)), image);
  const dirty = { ...image, files: snapshot([{ path: "skills/private/a.md", content: Buffer.from("private") }]).files };
  await assert.rejects(encodeSnapshot(dirty), /excluded paths/);
  await assert.rejects(decodeSnapshot(gzipSync(JSON.stringify(dirty))), /excluded paths/);
  const backend = new MemorySyncBackend();
  const { head } = await backend.publishSnapshot(image, { kind: "missing" });
  await assert.rejects(
    readSnapshotForHead(backend, { ...head, selection: selectionForSnapshot(["skills"], ["skills/other"]) }),
    /selection does not match/,
  );
});

test("apply filters both writes and deletion baselines, leaving excluded local bytes unchanged", async () =>
  withTempHome(async (root) => {
    await fs.mkdir(path.join(root, "skills/private"), { recursive: true });
    await fs.writeFile(path.join(root, "skills/private/a.md"), "local-private");
    await fs.writeFile(path.join(root, "skills/old.md"), "delete-managed");
    const incoming = snapshot([
      { path: "skills/private/a.md", content: Buffer.from("remote-private") },
      { path: "skills/new.md", content: Buffer.from("new") },
    ]);
    const hashes = await applySnapshot(incoming, new Set(), { include: ["skills"], exclude: ["skills/private"] });
    assert.equal(await fs.readFile(path.join(root, "skills/private/a.md"), "utf8"), "local-private");
    await assert.rejects(fs.stat(path.join(root, "skills/old.md")), { code: "ENOENT" });
    assert.deepEqual(Object.keys(hashes), ["skills/new.md"]);
  }));

test("directional and merged ancestor replacements refuse excluded descendants before backup/publication", async () =>
  withTempHome(async (root) => {
    await fs.mkdir(path.join(root, "custom/private"), { recursive: true });
    await fs.writeFile(path.join(root, "custom/private/a.txt"), "untouched");
    await fs.writeFile(path.join(root, "custom/public.txt"), "managed");
    const options = { include: ["custom"], exclude: ["custom/private"] };
    const before = await createSnapshot("home", options);
    const after = snapshot([{ path: "custom", content: Buffer.from("replace-directory") }]);
    const plan = preflightSnapshotApply(root, after, before, options);
    await assert.rejects(preflightSnapshotMutations(root, plan, undefined, options), /excluded/);
    await assert.rejects(preflightMergedTargets(before, after, options), /excluded/);
    await assert.rejects(applySnapshotTransaction(plan, options), /excluded/);
    assert.equal(await fs.readFile(path.join(root, "custom/private/a.txt"), "utf8"), "untouched");
  }));

test("pending transaction with a changed exclude policy remains untouched for reviewed recovery", async () =>
  withTempHome(async (root) => {
    await fs.mkdir(root, { recursive: true });
    const directory = path.join(transactionRoot(), "pending");
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(path.join(directory, "journal.json"), JSON.stringify({ version: 4, root, entries: [] }));
    await assert.rejects(
      recoverPendingSnapshotTransactions({ exclude: ["skills/private"] }),
      /different exclude policy/,
    );
    assert.ok(await fs.stat(path.join(directory, "journal.json")));
  }));
