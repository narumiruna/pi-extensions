import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import nodeFs, { type BigIntStats, constants } from "node:fs";
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
import { scopedIdentity, scopedTransactionImage } from "../src/engine/snapshot/snapshot-transaction-images.js";
import { fileImage } from "../src/engine/snapshot/snapshot-transaction-plan.js";
import {
  AGENT_DIRECTORY_JOURNAL_VERSION,
  FIXED_WORKSPACE_JOURNAL_VERSION,
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
  return {
    before,
    evidence,
    stage,
    workspace: `${stage}.workspace`,
    scratchEvidence: path.join(directory, `scratch-${entry.backupName}.json`),
  };
}

async function recordedWorkspace(base: string, journalFile: string) {
  const journal = JSON.parse(await fs.readFile(journalFile, "utf8")) as TransactionJournal;
  const slot = journal.entries[0]?.recoveryWorkspaceId;
  assert.ok(slot);
  return `${base}.${slot}`;
}

function scratchCandidate(file: unknown, workspaceBase: string) {
  return (
    typeof file === "string" &&
    file.startsWith(`${workspaceBase}.`) &&
    path.basename(path.dirname(file)).includes(".scratch.") &&
    path.basename(file) === "bytes"
  );
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

function substituteBirthtime(match: (file: unknown) => boolean, source: "ctime" | "missing") {
  const substitute = (stat: BigIntStats) => {
    stat.birthtimeNs = source === "ctime" ? stat.ctimeNs : 0n;
    return stat;
  };
  const lstat = fs.lstat.bind(fs);
  vi.spyOn(fs, "lstat").mockImplementation((async (...args: Parameters<typeof fs.lstat>) => {
    const stat = await lstat(...args);
    return stat && "birthtimeNs" in stat && match(args[0]) ? substitute(stat as BigIntStats) : stat;
  }) as typeof fs.lstat);
  // The synchronous statx path cannot succeed again after a permanent fallback.
  const lstatSync = nodeFs.lstatSync.bind(nodeFs);
  let fallback = false;
  vi.spyOn(nodeFs, "lstatSync").mockImplementation(((...args: Parameters<typeof nodeFs.lstatSync>) => {
    const stat = lstatSync(...args);
    fallback ||= match(args[0]);
    return stat && "birthtimeNs" in stat && fallback ? substitute(stat as BigIntStats) : stat;
  }) as typeof nodeFs.lstatSync);
  const open = fs.open.bind(fs);
  vi.spyOn(fs, "open").mockImplementation(async (file, flags, mode) => {
    const handle = await open(file, flags, mode);
    if (match(file)) {
      const statFile = handle.stat.bind(handle);
      handle.stat = (async (...args: Parameters<typeof handle.stat>) => {
        const stat = await statFile(...args);
        return "birthtimeNs" in stat ? substitute(stat as BigIntStats) : stat;
      }) as typeof handle.stat;
    }
    return handle;
  });
}

for (const source of ["ctime", "missing"] as const) {
  const ambiguousPlatform = !["darwin", "freebsd", "netbsd", "win32"].includes(process.platform);
  for (const affected of ["workspace", "scratch", "vacancy", "removal"] as const) {
    test.skipIf(source === "ctime" && !ambiguousPlatform)(
      `scoped ${affected} fails closed with ${source} birth time`,
      () =>
        fixture(async (root) => {
          const target = path.join(root, "tree");
          const leaf = path.join(target, "incoming");
          await fs.mkdir(target);
          await fs.writeFile(leaf, newBytes);
          const { before, evidence, workspace } = await recoveryFixture(root, {
            target,
            backupName: "0",
            kind: "file",
            beforeImage: fileImage(oldBytes),
            afterImage: "missing",
            postFiles: [{ relative: "incoming", image: fileImage(newBytes) }],
          });
          await fs.writeFile(before, oldBytes);
          const belongsToWorkspace = (file: unknown) => typeof file === "string" && file.startsWith(`${workspace}.`);
          substituteBirthtime((file) => {
            if (affected === "removal") return file === target;
            if (affected === "scratch") return scratchCandidate(file, workspace);
            if (!belongsToWorkspace(file) || typeof file !== "string") return false;
            if (affected === "vacancy") return path.basename(file) === "image";
            return path.dirname(file) === root && !scratchCandidate(file, workspace);
          }, source);
          const remove = vi.spyOn(fs, "unlink");
          await assert.rejects(recoverPendingSnapshotTransactions(selection(root)), (error: Error) => {
            if (affected === "removal") {
              assert.match(error.message, /scoped transaction removal stopped/i);
              assert.ok(error.cause instanceof Error);
              error = error.cause;
            }
            assert.match(error.message, /stable filesystem birth time is unavailable/i);
            return true;
          });
          assert.equal(
            remove.mock.calls.some(([file]) => file === leaf),
            false,
          );
          assert.deepEqual(await fs.readFile(leaf), newBytes);
          assert.deepEqual(await fs.readFile(before), oldBytes);
          const journal = JSON.parse(await fs.readFile(evidence, "utf8")) as TransactionJournal;
          assert.equal(journal.entries[0]?.vacantInstall, undefined);
          assert.equal(journal.entries[0]?.removalPending, undefined);
        }),
    );
  }
}

for (const kind of ["file", "directory"] as const) {
  test(`scoped atomic ${kind} removal does not require birth time`, () =>
    fixture(async (root) => {
      const target = path.join(root, "incoming");
      if (kind === "file") await fs.writeFile(target, newBytes);
      else await fs.mkdir(target);
      await recoveryFixture(root, {
        target,
        backupName: "0",
        kind: "missing",
        beforeImage: "missing",
        afterImage: kind === "file" ? fileImage(newBytes) : directoryImage([]),
        postFiles: [],
      });
      substituteBirthtime((file) => file === target, "missing");
      await recoverPendingSnapshotTransactions(selection(root));
      await assert.rejects(fs.lstat(target), { code: "ENOENT" });
      assert.deepEqual(await fs.readdir(transactionRoot()), []);
    }));
}

for (const outcome of ["not committed", "committed", "replacement"] as const) {
  test(`scoped retry after interrupted workspace ownership publication (${outcome})`, () =>
    fixture(async (root) => {
      const target = path.join(root, "note");
      await fs.writeFile(target, newBytes);
      const { before, evidence, workspace } = await recoveryFixture(root, {
        target,
        backupName: "0",
        kind: "file",
        beforeImage: fileImage(oldBytes),
        afterImage: fileImage(newBytes),
        postFiles: [],
      });
      await fs.writeFile(before, oldBytes);
      const rename = fs.rename.bind(fs);
      const fault = vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
        if (to !== evidence) return rename(from, to);
        if (outcome !== "not committed") await rename(from, to);
        throw new Error("workspace evidence write interrupted");
      });
      await assert.rejects(recoverPendingSnapshotTransactions(selection(root)), /workspace evidence write interrupted/);
      fault.mockRestore();
      assert.deepEqual(await fs.readFile(target), newBytes);
      const [candidate, ...others] = (await fs.readdir(root)).filter((name) =>
        name.startsWith(`${path.basename(workspace)}.`),
      );
      assert.ok(candidate);
      assert.deepEqual(others, []);
      const original = path.join(root, candidate);
      const sentinel = path.join(original, "unverified");
      if (outcome === "replacement") {
        const saved = await fs.readFile(evidence);
        await fs.rename(original, path.join(root, "moved"));
        await fs.mkdir(original);
        await assert.rejects(
          recoverPendingSnapshotTransactions(selection(root)),
          /unrecognized recovery staging image/i,
        );
        assert.ok((await fs.lstat(original)).isDirectory());
        assert.deepEqual(await fs.readFile(target), newBytes);
        assert.deepEqual(await fs.readFile(evidence), saved);
        return;
      }
      if (outcome === "not committed") await fs.writeFile(sentinel, "leave untouched");
      await recoverPendingSnapshotTransactions(selection(root));
      assert.deepEqual(await fs.readFile(target), oldBytes);
      await assert.rejects(fs.lstat(evidence), { code: "ENOENT" });
      if (outcome === "committed") await assert.rejects(fs.lstat(original), { code: "ENOENT" });
      else assert.equal(await fs.readFile(sentinel, "utf8"), "leave untouched");
    }));
}

for (const published of [false, true]) {
  test(`scoped scratch ownership publication can be retried (${published ? "committed" : "not committed"})`, () =>
    fixture(async (root) => {
      const target = path.join(root, "tree");
      await fs.writeFile(target, newBytes);
      const { before, evidence, workspace, scratchEvidence } = await recoveryFixture(root, {
        target,
        backupName: "0",
        kind: "directory",
        beforeImage: directoryImage([
          ["a", fileImage(oldBytes)],
          ["b", fileImage(oldBytes)],
        ]),
        afterImage: fileImage(newBytes),
        postFiles: [],
      });
      await fs.mkdir(before);
      await fs.writeFile(path.join(before, "a"), oldBytes);
      await fs.writeFile(path.join(before, "b"), oldBytes);
      const open = fs.open.bind(fs);
      const candidates: string[] = [];
      vi.spyOn(fs, "open").mockImplementation(async (file, flags, mode) => {
        const handle = await open(file, flags, mode);
        if (typeof file === "string" && flags === "wx" && scratchCandidate(file, workspace)) candidates.push(file);
        return handle;
      });
      const rename = fs.rename.bind(fs);
      const fault = vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
        if (typeof from === "string" && scratchCandidate(from, workspace) && process.platform !== "win32")
          assert.equal((await fs.stat(path.dirname(from))).mode & 0o077, 0);
        if (to !== scratchEvidence || candidates.length !== 2) return rename(from, to);
        if (published) await rename(from, to);
        throw new Error("scratch evidence write interrupted");
      });
      await assert.rejects(recoverPendingSnapshotTransactions(selection(root)), /scratch evidence write interrupted/);
      fault.mockRestore();
      const [first, second] = candidates;
      assert.ok(first && second);
      await assert.rejects(fs.lstat(first), { code: "ENOENT" });
      assert.equal((await fs.lstat(second)).size, 0);
      assert.deepEqual(await fs.readFile(target), newBytes);
      assert.deepEqual(
        await fs.readFile(path.join(await recordedWorkspace(workspace, evidence), "image", "a")),
        oldBytes,
      );
      if (!published) await fs.writeFile(second, "leave untouched");
      await recoverPendingSnapshotTransactions(selection(root));
      assert.deepEqual(await fs.readFile(path.join(target, "a")), oldBytes);
      assert.deepEqual(await fs.readFile(path.join(target, "b")), oldBytes);
      await assert.rejects(fs.lstat(evidence), { code: "ENOENT" });
      if (published) await assert.rejects(fs.lstat(second), { code: "ENOENT" });
      else assert.equal(await fs.readFile(second, "utf8"), "leave untouched");
      assert.equal(candidates.length, 3);
    }));
}

for (const change of [
  "valid",
  "workspace replaced",
  "scratch replaced",
  "old timestamp mismatches",
  "workspace has no birth time",
] as const) {
  test(`scoped recovery preserves exact v9 stage identity checks (${change})`, () =>
    fixture(async (root) => {
      const target = path.join(root, "note");
      await fs.writeFile(target, newBytes);
      const { before, evidence, workspace, scratchEvidence } = await recoveryFixture(
        root,
        {
          target,
          backupName: "0",
          kind: "file",
          beforeImage: fileImage(oldBytes),
          afterImage: fileImage(newBytes),
          postFiles: [],
        },
        FIXED_WORKSPACE_JOURNAL_VERSION,
      );
      await fs.writeFile(before, oldBytes);
      await fs.mkdir(workspace);
      const scratch = path.join(workspace, "scratch");
      const partial = oldBytes.subarray(0, 3);
      await fs.writeFile(scratch, partial);
      const stat = await fs.lstat(scratch, { bigint: true });
      const identity =
        change === "old timestamp mismatches"
          ? `${stat.dev}:${stat.ino}:${stat.birthtimeNs + 1n}`
          : scopedIdentity(stat);
      await fs.writeFile(
        scratchEvidence,
        JSON.stringify({ identity, file: createHash("sha256").update("").digest("hex") }),
      );
      const journal = JSON.parse(await fs.readFile(evidence, "utf8")) as TransactionJournal;
      const [entry] = journal.entries;
      assert.ok(entry);
      const workspaceStat = await fs.lstat(workspace, { bigint: true });
      if (change === "workspace has no birth time") {
        workspaceStat.birthtimeNs = 0n;
        substituteBirthtime((file) => file === workspace, "missing");
      }
      entry.recoveryWorkspace = scopedIdentity(workspaceStat);
      const prior = JSON.stringify(journal);
      await fs.writeFile(evidence, prior);
      if (change === "workspace replaced") {
        await fs.rename(workspace, path.join(root, "moved"));
        await fs.mkdir(workspace);
        await fs.writeFile(scratch, partial);
      }
      if (change === "scratch replaced") {
        await fs.rename(scratch, path.join(root, "moved"));
        await fs.writeFile(scratch, partial);
      }
      if (change === "valid") {
        await recoverPendingSnapshotTransactions(selection(root));
        assert.deepEqual(await fs.readFile(target), oldBytes);
        await assert.rejects(fs.lstat(workspace), { code: "ENOENT" });
      } else {
        await assert.rejects(
          recoverPendingSnapshotTransactions(selection(root)),
          change === "workspace has no birth time"
            ? /stable filesystem birth time/i
            : /unrecognized recovery staging image/i,
        );
        assert.deepEqual(await fs.readFile(scratch), partial);
        assert.deepEqual(await fs.readFile(target), newBytes);
        // The legacy journal may have been upgraded before rechecking its writable workspace.
        const saved = JSON.parse(await fs.readFile(evidence, "utf8")) as TransactionJournal;
        assert.deepEqual(saved.entries, journal.entries);
        if (change !== "workspace has no birth time") assert.equal(JSON.stringify(saved), prior);
      }
    }));
}

for (const change of ["none", "changed scratch", "foreign scratch", "oversized scratch", "foreign payload"] as const) {
  test(`scoped restarted copy requires ownership of partial bytes (${change})`, () =>
    fixture(async (root) => {
      const target = path.join(root, "tree");
      const big = Buffer.alloc(80 * 1024, 53);
      await fs.writeFile(target, newBytes);
      const {
        before,
        evidence,
        workspace: workspaceBase,
      } = await recoveryFixture(root, {
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
      let scratch: string | undefined;
      await fs.mkdir(before);
      await fs.writeFile(path.join(before, "a"), oldBytes);
      await fs.writeFile(path.join(before, "b"), big);
      const open = fs.open.bind(fs);
      let started = 0;
      const fault = vi.spyOn(fs, "open").mockImplementation(async (file, flags, mode) => {
        const handle = await open(file, flags, mode);
        if (typeof file === "string" && scratchCandidate(file, workspaceBase) && flags === "wx" && ++started === 2) {
          scratch = file;
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
      assert.ok(scratch);
      const workspace = await recordedWorkspace(workspaceBase, evidence);
      const stagedFirst = path.join(workspace, "image", "a");
      const stagedSecond = path.join(workspace, "image", "b");
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
      const {
        before,
        evidence,
        workspace: workspaceBase,
      } = await recoveryFixture(root, {
        target,
        backupName: "0",
        kind: "file",
        beforeImage: fileImage(oldBytes),
        afterImage: "missing",
        postFiles: [{ relative: "incoming", image: fileImage(newBytes) }],
      });
      await fs.writeFile(before, oldBytes);
      const rename = fs.rename.bind(fs);
      const fault = vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
        if (typeof from !== "string" || !from.startsWith(`${workspaceBase}.`) || to !== target) return rename(from, to);
        if (change === "install completed") await rename(from, to);
        throw new Error("recovery interrupted at installation");
      });
      await assert.rejects(recoverPendingSnapshotTransactions(selection(root)), /interrupted at installation/);
      fault.mockRestore();
      const workspace = await recordedWorkspace(workspaceBase, evidence);
      const payload = path.join(workspace, "image");
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

for (const change of [
  "birth time",
  "different inode",
  "different device",
  "wrong bytes",
  "wrong spelling",
  "late bytes",
  "late inode",
  "cancelled",
] as const) {
  test(`Windows recovery rechecks an installed vacancy after interruption (${change})`, () =>
    fixture(async (root) => {
      const target = path.join(root, "tree");
      await fs.mkdir(target);
      await fs.writeFile(path.join(target, "incoming"), newBytes);
      const {
        before,
        evidence,
        workspace: workspaceBase,
      } = await recoveryFixture(root, {
        target,
        backupName: "0",
        kind: "file",
        beforeImage: fileImage(oldBytes),
        afterImage: "missing",
        postFiles: [{ relative: "incoming", image: fileImage(newBytes) }],
      });
      await fs.writeFile(before, oldBytes);
      const rename = fs.rename.bind(fs);
      const fault = vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
        await rename(from, to);
        if (typeof from === "string" && from.startsWith(`${workspaceBase}.`) && to === target)
          throw new Error("recovery interrupted after installation");
      });
      await assert.rejects(recoverPendingSnapshotTransactions(selection(root)), /interrupted after installation/);
      fault.mockRestore();
      const workspace = await recordedWorkspace(workspaceBase, evidence);
      const journal = JSON.parse(await fs.readFile(evidence, "utf8")) as TransactionJournal;
      const entry = journal.entries[0];
      assert.ok(entry?.vacantInstall);
      const installed = await fs.lstat(target, { bigint: true });
      entry.vacantInstall = `${installed.dev}:${installed.ino}:${installed.birthtimeNs + 1n}`;
      if (change === "different inode") {
        await fs.rename(target, path.join(root, "saved-installed"));
        await fs.writeFile(target, oldBytes);
      }
      if (change === "different device")
        entry.vacantInstall = `${installed.dev + 1n}:${installed.ino}:${installed.birthtimeNs + 1n}`;
      if (change === "wrong bytes") await fs.writeFile(target, newBytes);
      await fs.writeFile(evidence, JSON.stringify(journal));
      const originalEvidence = await fs.readFile(evidence);
      if (["wrong spelling", "late bytes", "late inode"].includes(change)) {
        const readdir = fs.readdir.bind(fs);
        let observed = false;
        vi.spyOn(fs, "readdir").mockImplementation((async (...args: unknown[]) => {
          const names = await Reflect.apply(readdir, fs, args);
          if (args[0] !== root || args.length !== 1 || observed) return names;
          observed = true;
          if (change === "wrong spelling") return names.map((name: string) => (name === "tree" ? "TREE" : name));
          if (change === "late inode") {
            await fs.rename(target, path.join(root, "late-installed"));
            await fs.writeFile(target, oldBytes);
          } else await fs.writeFile(target, newBytes);
          return names;
        }) as typeof fs.readdir);
      }
      const controller = new AbortController();
      if (change === "cancelled") controller.abort();
      const descriptor = Object.getOwnPropertyDescriptor(process, "platform");
      assert.ok(descriptor);
      Object.defineProperty(process, "platform", { value: "win32" });
      try {
        const retry = recoverPendingSnapshotTransactions({ ...selection(root), signal: controller.signal });
        if (change === "birth time") {
          await retry;
          assert.deepEqual(await fs.readFile(target), oldBytes);
          await assert.rejects(fs.lstat(workspace), { code: "ENOENT" });
          await assert.rejects(fs.lstat(evidence), { code: "ENOENT" });
        } else {
          await assert.rejects(
            retry,
            change === "cancelled" ? /abort/i : /unrecognized or newer bytes|changed or is unsafe/,
          );
          assert.deepEqual(await fs.readFile(evidence), originalEvidence);
          assert.deepEqual(
            await fs.readFile(target),
            ["wrong bytes", "late bytes"].includes(change) ? newBytes : oldBytes,
          );
        }
      } finally {
        Object.defineProperty(process, "platform", descriptor);
      }
    }));
}

test("recovery vacancy birth-time tolerance never applies to the staged payload", () =>
  fixture(async (root) => {
    const target = path.join(root, "tree");
    await fs.mkdir(target);
    await fs.writeFile(path.join(target, "incoming"), newBytes);
    const {
      before,
      evidence,
      workspace: workspaceBase,
    } = await recoveryFixture(root, {
      target,
      backupName: "0",
      kind: "file",
      beforeImage: fileImage(oldBytes),
      afterImage: "missing",
      postFiles: [{ relative: "incoming", image: fileImage(newBytes) }],
    });
    await fs.writeFile(before, oldBytes);
    const rename = fs.rename.bind(fs);
    const fault = vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
      if (typeof from === "string" && from.startsWith(`${workspaceBase}.`) && to === target)
        throw new Error("recovery interrupted before installation");
      await rename(from, to);
    });
    await assert.rejects(recoverPendingSnapshotTransactions(selection(root)), /interrupted before installation/);
    fault.mockRestore();
    const workspace = await recordedWorkspace(workspaceBase, evidence);
    const payload = path.join(workspace, "image");
    const journal = JSON.parse(await fs.readFile(evidence, "utf8")) as TransactionJournal;
    const entry = journal.entries[0];
    assert.ok(entry?.vacantInstall);
    const stat = await fs.lstat(payload, { bigint: true });
    entry.vacantInstall = `${stat.dev}:${stat.ino}:${stat.birthtimeNs + 1n}`;
    await fs.writeFile(evidence, JSON.stringify(journal));
    const originalEvidence = await fs.readFile(evidence);
    const descriptor = Object.getOwnPropertyDescriptor(process, "platform");
    assert.ok(descriptor);
    Object.defineProperty(process, "platform", { value: "win32" });
    try {
      await assert.rejects(recoverPendingSnapshotTransactions(selection(root)), /no verified staging image/);
      await assert.rejects(fs.lstat(target), { code: "ENOENT" });
      assert.deepEqual(await fs.readFile(payload), oldBytes);
      assert.deepEqual(await fs.readFile(evidence), originalEvidence);
    } finally {
      Object.defineProperty(process, "platform", descriptor);
    }
  }));
