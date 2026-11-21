import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test, vi } from "vitest";
import { configureEngineHost } from "../src/engine/host.js";
import { MAX_AGENT_DIRECTORY_BYTES } from "../src/engine/snapshot/snapshot-bounds.js";
import {
  applySnapshotTransaction,
  recoverPendingSnapshotTransactions,
} from "../src/engine/snapshot/snapshot-transaction.js";
import { transactionRoot } from "../src/engine/snapshot/snapshot-transaction-directory.js";
import { scopedTransactionImage } from "../src/engine/snapshot/snapshot-transaction-images.js";
import { fileImage } from "../src/engine/snapshot/snapshot-transaction-plan.js";
import {
  AGENT_DIRECTORY_JOURNAL_VERSION,
  type TransactionEntry,
  type TransactionJournal,
} from "../src/engine/snapshot/snapshot-transaction-policy.js";
import { selectionForSnapshot } from "../src/engine/sync/sync-policy.js";

async function fixture(run: (root: string) => Promise<void>) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "pi-sync-scoped-transaction-")));
  configureEngineHost({ root: () => root, mutate: async (_target, action) => action(), review: async () => true });
  try {
    await run(root);
  } finally {
    vi.restoreAllMocks();
    await fs.rm(root, { recursive: true, force: true });
  }
}

function selection(root: string) {
  return { scope: "agent-directory" as const, sessionDir: path.join(root, "sessions") };
}

function directoryImage(rows: [string, string][]) {
  return `directory:${createHash("sha256").update(JSON.stringify(rows)).digest("hex")}`;
}

const oldBytes = Buffer.from("reviewed file");
const newBytes = Buffer.from("installed file");

for (const change of ["none", "growth", "cancel"] as const) {
  test(`scoped descriptor reads use bounded chunks (${change})`, () =>
    fixture(async (root) => {
      const target = path.join(root, "note.txt");
      const original = Buffer.alloc(192 * 1024, 33);
      await fs.writeFile(target, original);
      const controller = new AbortController();
      const open = fs.open.bind(fs);
      let closed = false;
      let observed = 0;
      let largestRequest = 0;
      vi.spyOn(fs, "open").mockImplementation(async (file, flags, mode) => {
        const handle = await open(file, flags, mode);
        if (file !== target) return handle;
        assert.equal(typeof flags, "number");
        assert.equal(Number(flags) & (constants.O_NOFOLLOW ?? 0), constants.O_NOFOLLOW ?? 0);
        const read = handle.read.bind(handle);
        const close = handle.close.bind(handle);
        handle.read = (async (buffer: Buffer, offset: number, length: number, position: number) => {
          const result = await read(buffer, offset, length, position);
          largestRequest = Math.max(largestRequest, length);
          if (observed === 0) {
            if (change === "growth") await fs.appendFile(target, "a concurrent append");
            if (change === "cancel") controller.abort(new Error("owner cancelled"));
          }
          observed += result.bytesRead;
          return result;
        }) as typeof handle.read;
        handle.close = async () => {
          await close();
          closed = true;
        };
        return handle;
      });
      const image = scopedTransactionImage(target, { signal: controller.signal });
      if (change === "none") assert.equal((await image).value, fileImage(original));
      else await assert.rejects(image, change === "growth" ? /changed or is unsafe/ : /owner cancelled/);
      assert.equal(closed, true);
      assert.ok(largestRequest > 0 && largestRequest < original.length);
      if (change === "cancel") assert.ok(observed < original.length);
      else assert.equal(observed, original.length);
    }));
}

test("scoped directory image bounds combined file sizes before opening the over-budget leaf", () =>
  fixture(async (root) => {
    const dir = path.join(root, "tree");
    await fs.mkdir(dir);
    for (const leaf of ["a.txt", "b.txt"]) {
      const file = path.join(dir, leaf);
      await fs.writeFile(file, "");
      await fs.truncate(file, MAX_AGENT_DIRECTORY_BYTES / 2 + 1);
    }
    const open = vi.spyOn(fs, "open");
    await assert.rejects(scopedTransactionImage(dir, {}), /64 MiB byte bound/);
    assert.deepEqual(
      open.mock.calls.map(([file]) => file),
      [path.join(dir, "a.txt")],
    );
  }));

for (const change of ["none", "late child"] as const) {
  test(`scoped apply removes reviewed leaves only (${change})`, () =>
    fixture(async (root) => {
      const target = path.join(root, "tree");
      const reviewed = path.join(target, "nested", "known.txt");
      const unknown = path.join(target, "concurrent.txt");
      await fs.mkdir(path.dirname(reviewed), { recursive: true });
      await fs.mkdir(path.join(target, "empty"));
      await fs.writeFile(reviewed, oldBytes);
      const before = directoryImage([
        ["empty", directoryImage([])],
        ["nested", directoryImage([["known.txt", fileImage(oldBytes)]])],
      ]);
      const rmdir = fs.rmdir.bind(fs);
      let inserted = false;
      vi.spyOn(fs, "rmdir").mockImplementation(async (dir) => {
        if (dir === target && change === "late child") {
          await fs.writeFile(unknown, "ordinary concurrent write", { flag: "wx" });
          inserted = true;
        }
        return rmdir(dir);
      });
      const rm = vi.spyOn(fs, "rm");
      const apply = applySnapshotTransaction(
        { deletes: [target, reviewed], writes: [{ target, content: newBytes }] },
        {
          ...selection(root),
          expectedPreimages: new Map([
            [target, before],
            [reviewed, fileImage(oldBytes)],
          ]),
        },
      );
      if (change === "none") {
        await apply;
        assert.deepEqual(await fs.readFile(target), newBytes);
        assert.deepEqual(await fs.readdir(transactionRoot()), []);
      } else {
        await assert.rejects(apply, /scoped transaction removal stopped/i);
        assert.equal(inserted, true);
        assert.equal(await fs.readFile(unknown, "utf8"), "ordinary concurrent write");
        await assert.rejects(fs.lstat(reviewed), { code: "ENOENT" });
        const [id, ...others] = await fs.readdir(transactionRoot());
        assert.ok(id);
        assert.deepEqual(others, []);
        const directory = path.join(transactionRoot(), id);
        const journalPath = path.join(directory, "journal.json");
        const evidence = await fs.readFile(journalPath);
        const journal = JSON.parse(evidence.toString()) as TransactionJournal;
        assert.equal(journal.entries[0]?.removalPending, true);
        assert.deepEqual(await fs.readFile(path.join(directory, "before", "0", "nested", "known.txt")), oldBytes);
        await assert.rejects(recoverPendingSnapshotTransactions(selection(root)), /unrecognized or newer bytes/);
        assert.deepEqual(await fs.readFile(journalPath), evidence);
        assert.equal(await fs.readFile(unknown, "utf8"), "ordinary concurrent write");
      }
      assert.equal(
        rm.mock.calls.some(([file, options]) => file === target && options?.recursive),
        false,
      );
    }));
}

async function recoveryFixture(root: string, entry: TransactionEntry) {
  const directory = path.join(transactionRoot(), "interrupted");
  const before = path.join(directory, "before", entry.backupName);
  await fs.mkdir(path.dirname(before), { recursive: true });
  const journal: TransactionJournal = {
    version: AGENT_DIRECTORY_JOURNAL_VERSION,
    selection: selectionForSnapshot([], undefined, selection(root)),
    root,
    sessionRoot: selection(root).sessionDir,
    entries: [entry],
  };
  const evidence = path.join(directory, "journal.json");
  await fs.writeFile(evidence, JSON.stringify(journal));
  const token = createHash("sha256").update(directory).update("\\0").update(entry.backupName).digest("hex");
  const stage = path.join(path.dirname(entry.target), `.pi-sync.json.${token}.restore-tree`);
  return { before, evidence, stage };
}

for (const change of ["none", "late child", "different spelling"] as const) {
  test(`scoped recovery removes an authorized post-tree without sweeping other children (${change})`, () =>
    fixture(async (root) => {
      const target = path.join(root, "tree");
      const postFile = path.join(target, change === "different spelling" ? "Known.txt" : "known.txt");
      const unknown = path.join(target, "concurrent.txt");
      await fs.mkdir(target);
      await fs.writeFile(postFile, newBytes);
      const { before, evidence } = await recoveryFixture(root, {
        target,
        backupName: "0",
        kind: "file",
        beforeImage: fileImage(oldBytes),
        afterImage: "missing",
        postFiles: [{ relative: "known.txt", image: fileImage(newBytes) }],
      });
      await fs.writeFile(before, oldBytes);
      const rmdir = fs.rmdir.bind(fs);
      vi.spyOn(fs, "rmdir").mockImplementation(async (dir) => {
        if (dir === target && change === "late child") await fs.writeFile(unknown, "new local data", { flag: "wx" });
        return rmdir(dir);
      });
      const rm = vi.spyOn(fs, "rm");
      const recover = recoverPendingSnapshotTransactions(selection(root));
      if (change === "none") {
        await recover;
        assert.deepEqual(await fs.readFile(target), oldBytes);
        await assert.rejects(fs.lstat(evidence), { code: "ENOENT" });
      } else if (change === "different spelling") {
        await assert.rejects(recover, /unrecognized or newer bytes/);
        assert.deepEqual(await fs.readFile(postFile), newBytes);
        assert.ok((await fs.lstat(evidence)).isFile());
      } else {
        await assert.rejects(recover, /scoped transaction removal stopped/i);
        assert.equal(await fs.readFile(unknown, "utf8"), "new local data");
        assert.deepEqual(await fs.readFile(before), oldBytes);
        const journal = JSON.parse(await fs.readFile(evidence, "utf8")) as TransactionJournal;
        assert.equal(journal.entries[0]?.removalPending, true);
        assert.equal(journal.entries[0]?.recoveryStaged, true);
        assert.equal(journal.completed, undefined);
      }
      assert.equal(
        rm.mock.calls.some(([file, options]) => file === target && options?.recursive),
        false,
      );
    }));
}

for (const change of ["none", "partial", "extra child", "late child"] as const) {
  test(`scoped restart cleans only a complete known sibling stage (${change})`, () =>
    fixture(async (root) => {
      const target = path.join(root, "tree");
      await fs.writeFile(target, newBytes);
      const { before, evidence, stage } = await recoveryFixture(root, {
        target,
        backupName: "0",
        kind: "directory",
        beforeImage: directoryImage([["known.txt", fileImage(oldBytes)]]),
        afterImage: fileImage(newBytes),
        postFiles: [],
        recoveryStaged: true,
      });
      await fs.mkdir(before);
      await fs.writeFile(path.join(before, "known.txt"), oldBytes);
      await fs.mkdir(stage);
      if (change !== "partial") await fs.writeFile(path.join(stage, "known.txt"), oldBytes);
      const unknown = path.join(stage, "concurrent.txt");
      if (change === "extra child") await fs.writeFile(unknown, "new local data");
      if (change === "late child") {
        const rmdir = fs.rmdir.bind(fs);
        vi.spyOn(fs, "rmdir").mockImplementation(async (dir) => {
          if (dir === stage) await fs.writeFile(unknown, "new local data", { flag: "wx" });
          return rmdir(dir);
        });
      }
      const rm = vi.spyOn(fs, "rm");
      const recover = recoverPendingSnapshotTransactions(selection(root));
      if (change === "none") {
        await recover;
        assert.deepEqual(await fs.readFile(path.join(target, "known.txt")), oldBytes);
        await assert.rejects(fs.lstat(stage), { code: "ENOENT" });
        await assert.rejects(fs.lstat(evidence), { code: "ENOENT" });
      } else {
        const originalEvidence = await fs.readFile(evidence);
        if (change === "late child") await assert.rejects(recover);
        else await assert.rejects(recover, /unrecognized recovery staging image/i);
        assert.deepEqual(await fs.readFile(target), newBytes);
        assert.deepEqual(await fs.readFile(evidence), originalEvidence);
        assert.ok((await fs.lstat(stage)).isDirectory());
        if (change !== "partial") assert.equal(await fs.readFile(unknown, "utf8"), "new local data");
      }
      assert.equal(
        rm.mock.calls.some(([file, options]) => file === stage && options?.recursive),
        false,
      );
    }));
}
