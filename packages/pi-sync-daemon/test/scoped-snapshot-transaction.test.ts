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
  LEGACY_AGENT_DIRECTORY_JOURNAL_VERSION,
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

async function recoveryFixture(root: string, entry: TransactionEntry, version = AGENT_DIRECTORY_JOURNAL_VERSION) {
  const directory = path.join(transactionRoot(), "interrupted");
  const before = path.join(directory, "before", entry.backupName);
  await fs.mkdir(path.dirname(before), { recursive: true });
  const journal: TransactionJournal = {
    version,
    selection: selectionForSnapshot([], undefined, selection(root)),
    root,
    sessionRoot: selection(root).sessionDir,
    entries: [entry],
  };
  const evidence = path.join(directory, "journal.json");
  await fs.writeFile(evidence, JSON.stringify(journal));
  const token = createHash("sha256").update(directory).update("\\0").update(entry.backupName).digest("hex");
  const suffix = entry.kind === "file" ? "restore" : "restore-tree";
  const stage = path.join(path.dirname(entry.target), `.pi-sync.json.${token}.${suffix}`);
  return { before, evidence, stage, workspace: `${stage}.workspace` };
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
        assert.ok(journal.entries[0]?.recoveryWorkspace);
        assert.equal(journal.entries[0]?.scopedRemoval?.image, "after");
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
      const { before, evidence, stage } = await recoveryFixture(
        root,
        {
          target,
          backupName: "0",
          kind: "directory",
          beforeImage: directoryImage([["known.txt", fileImage(oldBytes)]]),
          afterImage: fileImage(newBytes),
          postFiles: [],
          recoveryStaged: true,
        },
        LEGACY_AGENT_DIRECTORY_JOURNAL_VERSION,
      );
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

for (const change of ["none", "changed scratch", "foreign scratch", "oversized scratch", "foreign payload"] as const) {
  test(`scoped restarted copy requires ownership of partial bytes (${change})`, () =>
    fixture(async (root) => {
      const target = path.join(root, "tree");
      const big = Buffer.alloc(80 * 1024, 53);
      await fs.writeFile(target, newBytes);
      const { before, evidence, workspace } = await recoveryFixture(root, {
        target,
        backupName: "0",
        kind: "directory",
        beforeImage: directoryImage([
          ["a", fileImage(oldBytes)],
          ["b", fileImage(big)],
        ]),
        afterImage: fileImage(newBytes),
        postFiles: [],
      });
      const scratch = path.join(workspace, "scratch");
      const stagedFirst = path.join(workspace, "image", "a");
      const stagedSecond = path.join(workspace, "image", "b");
      await fs.mkdir(before);
      await fs.writeFile(path.join(before, "a"), oldBytes);
      await fs.writeFile(path.join(before, "b"), big);
      const open = fs.open.bind(fs);
      let started = 0;
      const fault = vi.spyOn(fs, "open").mockImplementation(async (file, flags, mode) => {
        const handle = await open(file, flags, mode);
        if (file === scratch && flags === "wx" && ++started === 2) {
          const write = handle.writeFile.bind(handle);
          handle.writeFile = async (chunk) => {
            await write(chunk);
            throw new Error("copy interrupted after its first chunk");
          };
        }
        return handle;
      });
      await assert.rejects(recoverPendingSnapshotTransactions(selection(root)), /copy interrupted/);
      fault.mockRestore();
      assert.deepEqual(await fs.readFile(target), newBytes);
      assert.deepEqual(await fs.readFile(stagedFirst), oldBytes);
      await assert.rejects(fs.lstat(stagedSecond), { code: "ENOENT" });
      const partial = await fs.readFile(scratch);
      assert.ok(partial.length > 0 && partial.length < big.length);
      const originalEvidence = await fs.readFile(evidence);
      if (change === "changed scratch") await fs.writeFile(scratch, "ordinary changed bytes");
      if (change === "foreign scratch") {
        await fs.rename(scratch, path.join(root, "saved-scratch"));
        await fs.writeFile(scratch, partial);
      }
      if (change === "oversized scratch") await fs.truncate(scratch, MAX_AGENT_DIRECTORY_BYTES + 1);
      if (change === "foreign payload") await fs.writeFile(stagedSecond, partial);
      const retriedOpen = vi.spyOn(fs, "open");
      const retry = recoverPendingSnapshotTransactions(selection(root));
      if (change === "none") {
        await retry;
        assert.deepEqual(await fs.readFile(path.join(target, "a")), oldBytes);
        assert.deepEqual(await fs.readFile(path.join(target, "b")), big);
        await assert.rejects(fs.lstat(workspace), { code: "ENOENT" });
        await assert.rejects(fs.lstat(evidence), { code: "ENOENT" });
      } else {
        await assert.rejects(
          retry,
          change === "oversized scratch" ? /64 MiB byte bound/ : /unrecognized recovery staging image/i,
        );
        assert.deepEqual(await fs.readFile(target), newBytes);
        assert.deepEqual(await fs.readFile(evidence), originalEvidence);
        if (change === "oversized scratch") {
          assert.equal(
            retriedOpen.mock.calls.some(([file]) => file === scratch),
            false,
          );
          assert.equal((await fs.lstat(scratch)).size, MAX_AGENT_DIRECTORY_BYTES + 1);
        } else if (change === "changed scratch") {
          assert.equal(await fs.readFile(scratch, "utf8"), "ordinary changed bytes");
        } else {
          assert.deepEqual(await fs.readFile(change === "foreign payload" ? stagedSecond : scratch), partial);
        }
      }
    }));
}

for (const change of ["none", "install completed", "foreign preimage", "foreign postimage", "foreign stage"] as const) {
  test(`scoped recovery can restart at a reserved vacancy (${change})`, () =>
    fixture(async (root) => {
      const target = path.join(root, "tree");
      await fs.mkdir(target);
      await fs.writeFile(path.join(target, "incoming"), newBytes);
      const { before, evidence, workspace } = await recoveryFixture(root, {
        target,
        backupName: "0",
        kind: "file",
        beforeImage: fileImage(oldBytes),
        afterImage: "missing",
        postFiles: [{ relative: "incoming", image: fileImage(newBytes) }],
      });
      await fs.writeFile(before, oldBytes);
      const payload = path.join(workspace, "image");
      const rename = fs.rename.bind(fs);
      const fault = vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
        if (from !== payload || to !== target) return rename(from, to);
        if (change === "install completed") await rename(from, to);
        throw new Error("recovery interrupted at installation");
      });
      await assert.rejects(recoverPendingSnapshotTransactions(selection(root)), /interrupted at installation/);
      fault.mockRestore();
      const originalEvidence = await fs.readFile(evidence);
      const journal = JSON.parse(originalEvidence.toString()) as TransactionJournal;
      assert.ok(journal.entries[0]?.vacantInstall);
      if (change !== "install completed") await assert.rejects(fs.lstat(target), { code: "ENOENT" });
      if (change === "foreign preimage") await fs.writeFile(target, oldBytes);
      if (change === "foreign postimage") {
        await fs.mkdir(target);
        await fs.writeFile(path.join(target, "incoming"), newBytes);
      }
      if (change === "foreign stage") {
        await fs.rename(payload, path.join(root, "saved-payload"));
        await fs.writeFile(payload, oldBytes);
      }
      const retry = recoverPendingSnapshotTransactions(selection(root));
      if (change === "none" || change === "install completed") {
        await retry;
        assert.deepEqual(await fs.readFile(target), oldBytes);
        await assert.rejects(fs.lstat(workspace), { code: "ENOENT" });
        await assert.rejects(fs.lstat(evidence), { code: "ENOENT" });
      } else {
        await assert.rejects(retry, /unrecognized or newer bytes|no verified staging image/);
        assert.deepEqual(await fs.readFile(evidence), originalEvidence);
        assert.deepEqual(await fs.readFile(payload), oldBytes);
        if (change === "foreign preimage") assert.deepEqual(await fs.readFile(target), oldBytes);
        if (change === "foreign postimage")
          assert.deepEqual(await fs.readFile(path.join(target, "incoming")), newBytes);
        if (change === "foreign stage") await assert.rejects(fs.lstat(target), { code: "ENOENT" });
      }
    }));
}

for (const change of ["none", "added child", "changed child", "foreign tree", "version 8"] as const) {
  test(`scoped apply can roll back an interrupted reviewed preimage removal (${change})`, () =>
    fixture(async (root) => {
      const target = path.join(root, "tree");
      const nested = path.join(target, "nested");
      const first = path.join(nested, "a");
      const second = path.join(nested, "b");
      await fs.mkdir(nested, { recursive: true });
      await fs.writeFile(first, oldBytes);
      await fs.writeFile(second, newBytes);
      const nestedImage = directoryImage([
        ["a", fileImage(oldBytes)],
        ["b", fileImage(newBytes)],
      ]);
      const before = directoryImage([["nested", nestedImage]]);
      const controller = new AbortController();
      const unlink = fs.unlink.bind(fs);
      const fault = vi.spyOn(fs, "unlink").mockImplementation(async (file) => {
        await unlink(file);
        if (file === first) controller.abort();
      });
      await assert.rejects(
        applySnapshotTransaction(
          { deletes: [target, nested, first], writes: [{ target, content: newBytes }] },
          {
            ...selection(root),
            signal: controller.signal,
            expectedPreimages: new Map([
              [target, before],
              [nested, nestedImage],
              [first, fileImage(oldBytes)],
            ]),
          },
        ),
        /apply cancelled/i,
      );
      fault.mockRestore();
      const [id] = await fs.readdir(transactionRoot());
      assert.ok(id);
      const evidence = path.join(transactionRoot(), id, "journal.json");
      const journal = JSON.parse(await fs.readFile(evidence, "utf8")) as TransactionJournal;
      assert.equal(journal.entries.find((entry) => entry.target === target)?.scopedRemoval?.image, "before");
      assert.equal(journal.entries.find((entry) => entry.target === nested)?.scopedRemoval?.image, "before");
      await assert.rejects(fs.lstat(first), { code: "ENOENT" });
      if (change === "added child") await fs.writeFile(path.join(nested, "extra"), oldBytes);
      if (change === "changed child") await fs.writeFile(second, oldBytes);
      if (change === "foreign tree") {
        await fs.rename(target, path.join(root, "saved-tree"));
        await fs.mkdir(nested, { recursive: true });
        await fs.writeFile(second, newBytes);
      }
      if (change === "version 8") {
        journal.version = LEGACY_AGENT_DIRECTORY_JOURNAL_VERSION;
        for (const entry of journal.entries) delete entry.scopedRemoval;
        await fs.writeFile(evidence, JSON.stringify(journal));
      }
      const originalEvidence = await fs.readFile(evidence);
      const retry = recoverPendingSnapshotTransactions(selection(root));
      if (change === "none") {
        await retry;
        assert.deepEqual(await fs.readFile(first), oldBytes);
        assert.deepEqual(await fs.readFile(second), newBytes);
        await assert.rejects(fs.lstat(evidence), { code: "ENOENT" });
      } else {
        await assert.rejects(retry, /unrecognized or newer bytes/);
        await assert.rejects(fs.lstat(first), { code: "ENOENT" });
        assert.deepEqual(await fs.readFile(second), change === "changed child" ? oldBytes : newBytes);
        if (change === "added child") assert.deepEqual(await fs.readFile(path.join(nested, "extra")), oldBytes);
        assert.deepEqual(await fs.readFile(evidence), originalEvidence);
      }
    }));
}
