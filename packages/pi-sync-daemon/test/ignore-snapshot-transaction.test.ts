import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test, vi } from "vitest";
import { configureEngineHost, type EngineHost } from "../src/engine/host.js";
import {
  loadEffectiveIgnorePolicy,
  requireUnchangedIgnorePolicy,
} from "../src/engine/ignore/effective-ignore-policy.js";
import { applySnapshot } from "../src/engine/snapshot/snapshot-apply.js";
import {
  applySnapshotTransaction,
  recoverPendingSnapshotTransactions,
} from "../src/engine/snapshot/snapshot-transaction.js";
import { transactionRoot } from "../src/engine/snapshot/snapshot-transaction-directory.js";
import {
  AGENT_DIRECTORY_JOURNAL_VERSION,
  BOUND_DIRECTORY_JOURNAL_VERSION,
  IGNORE_POLICY_JOURNAL_VERSION,
  type TransactionJournal,
  validateJournalPolicy,
} from "../src/engine/snapshot/snapshot-transaction-policy.js";
import { IGNORE_SNAPSHOT_VERSION, type Snapshot } from "../src/engine/snapshot/snapshot-types.js";
import { selectionForSnapshot } from "../src/engine/sync/sync-policy.js";

const filename = ".work.syncignore";
const input = { filename, configuredFilenames: [".alternate.syncignore"], sessions: false };
const rules = "/ignored/\n";
const changedRules = `${rules}notes.md\n`;
const newBytes = Buffer.from("new content");

test("interrupted snapshot recovery binds the originating setup even if setups share the same rule source", () =>
  fixture(async (root, options) => {
    const bound = {
      ...options,
      setupName: "original",
      recoverySetupKey: "destination-a",
      ignoreSourceIdentity: "fixture-source",
    };
    const target = path.join(root, "notes.md");
    await fs.writeFile(target, "original bytes");
    const cancel = new AbortController();
    const rename = fs.rename.bind(fs);
    const patch = vi.spyOn(fs, "rename").mockImplementation(async (before, after) => {
      await rename(before, after);
      if (after === target) cancel.abort();
    });
    try {
      await assert.rejects(
        applySnapshotTransaction(
          { writes: [{ target, content: newBytes }], deletes: [] },
          {
            ...bound,
            signal: cancel.signal,
          },
        ),
        /evidence retained/,
      );
    } finally {
      patch.mockRestore();
    }
    const { journal, bytes } = await journalState();
    assert.equal(journal.version, BOUND_DIRECTORY_JOURNAL_VERSION);
    assert.match(journal.localPolicyKey ?? "", /^[0-9a-f]{64}$/u);
    for (const candidate of [
      { ...bound, setupName: "another" },
      { ...bound, recoverySetupKey: "destination-b" },
      { ...bound, ignoreSourceIdentity: "replaced-source" },
    ]) {
      await assert.rejects(recoverPendingSnapshotTransactions(candidate), /different setup or ignore policy evidence/);
      assert.equal((await journalState()).bytes, bytes);
      assert.deepEqual(await fs.readFile(target), newBytes);
    }
    await recoverPendingSnapshotTransactions(bound);
    assert.equal(await fs.readFile(target, "utf8"), "original bytes");
    assert.deepEqual(await fs.readdir(transactionRoot()), []);
  }));

function host(root: string, reserveTargets?: EngineHost["reserveTargets"]) {
  configureEngineHost({
    root: () => root,
    mutate: async (_target, action) => action(),
    reserveTargets,
    review: async () => true,
  });
}

async function fixture(run: (root: string, options: Awaited<ReturnType<typeof txOptions>>) => Promise<void>) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "pi-sync-ignore-transaction-")));
  host(root);
  try {
    await fs.writeFile(path.join(root, filename), rules);
    await run(root, await txOptions(root));
  } finally {
    vi.restoreAllMocks();
    await fs.rm(root, { force: true, recursive: true });
  }
}

async function txOptions(root: string, policyInput = input) {
  const ignorePolicy = await loadEffectiveIgnorePolicy(root, policyInput);
  return {
    scope: "agent-directory" as const,
    sessionDir: path.join(root, "sessions"),
    ignorePolicy,
    validateIgnorePolicy: () => requireUnchangedIgnorePolicy(root, ignorePolicy, policyInput),
  };
}

async function journalState() {
  const [id, ...rest] = await fs.readdir(transactionRoot());
  assert.ok(id);
  assert.deepEqual(rest, []);
  const directory = path.join(transactionRoot(), id);
  const file = path.join(directory, "journal.json");
  const bytes = await fs.readFile(file, "utf8");
  return { directory, file, bytes, journal: JSON.parse(bytes) as TransactionJournal };
}

function imageHash(bytes: Buffer) {
  return createHash("sha256").update(bytes).digest("hex");
}

function fileImage(bytes: Buffer) {
  return `file:${imageHash(bytes)}`;
}

test("v6 apply requires explicit matching local selection and an async validator", () =>
  fixture(async (root, options) => {
    const target = path.join(root, "notes.md");
    const protectedDirectory = path.join(root, "ignored");
    const siblingSource = path.join(root, input.configuredFilenames[0] as string);
    await fs.mkdir(protectedDirectory);
    await fs.writeFile(path.join(protectedDirectory, "keep"), "private");
    await fs.writeFile(siblingSource, "reserved sibling source");
    const file = (relative: string) => ({
      path: relative,
      contentBase64: newBytes.toString("base64"),
      sha256: imageHash(newBytes),
    });
    const snapshot: Snapshot = {
      version: IGNORE_SNAPSHOT_VERSION,
      selection: selectionForSnapshot(undefined, undefined, options),
      id: "local-projection",
      profile: "test",
      machine: "another device",
      createdAt: "2026-01-01T00:00:00Z",
      files: [file("notes.md"), file("ignored/keep"), file(filename), file(path.basename(siblingSource))],
    };
    await assert.rejects(applySnapshot(snapshot), /cannot transfer an ignore-file snapshot/i);
    await assert.rejects(
      applySnapshot(snapshot, new Set(), { ...options, validateIgnorePolicy: undefined }),
      /freshness check/i,
    );
    const wire = snapshot.selection;
    assert.ok(wire?.version === 4);
    await assert.rejects(
      applySnapshotTransaction({ deletes: [], writes: [{ target, content: newBytes }] }, wire),
      /freshness check/i,
    );
    await assert.rejects(
      applySnapshot(snapshot, new Set(), {
        ...options,
        validateIgnorePolicy: (() => undefined) as unknown as () => Promise<void>,
      }),
      (error: Error) =>
        (error.cause as Error | undefined)?.message === "The ignore policy freshness check must be async.",
    );
    for (const selection of [
      { ...wire, fingerprint: "0".repeat(64) },
      { ...wire, sessions: true },
    ]) {
      await assert.rejects(applySnapshot({ ...snapshot, selection }, new Set(), options), /does not match/i);
    }
    await assert.rejects(
      applySnapshot({ ...snapshot, version: 1, selection: undefined }, new Set(), options),
      /project the snapshot/i,
    );
    await assert.rejects(fs.lstat(target), { code: "ENOENT" });
    assert.deepEqual(await applySnapshot(snapshot, new Set(), options), { "notes.md": imageHash(newBytes) });
    assert.deepEqual(await fs.readFile(target), newBytes);
    assert.equal(await fs.readFile(path.join(protectedDirectory, "keep"), "utf8"), "private");
    assert.equal(await fs.readFile(siblingSource, "utf8"), "reserved sibling source");
    assert.equal(await fs.readFile(path.join(root, filename), "utf8"), rules);
  }));

test("freshness is checked after target reservation, before preparation or rollback", () =>
  fixture(async (root, options) => {
    const target = path.join(root, "notes.md");
    await fs.writeFile(target, "before");
    host(root, async (targets, action) => {
      assert.deepEqual(targets, [target]);
      await fs.writeFile(path.join(root, filename), changedRules);
      return action();
    });
    await assert.rejects(
      applySnapshotTransaction({ deletes: [], writes: [{ target, content: newBytes }] }, options),
      /ignore policy changed/i,
    );
    assert.equal(await fs.readFile(target, "utf8"), "before");
    await assert.rejects(fs.lstat(transactionRoot()), { code: "ENOENT" });
  }));

test("the final freshness await does not authorize overwriting a newly changed preimage", () =>
  fixture(async (root, options) => {
    const target = path.join(root, "notes.md");
    await fs.writeFile(target, "before");
    let staged = false;
    const open = fs.open.bind(fs);
    vi.spyOn(fs, "open").mockImplementation(async (file, flags, mode) => {
      const handle = await open(file, flags, mode);
      if (String(file).endsWith(".apply")) staged = true;
      return handle;
    });
    await assert.rejects(
      applySnapshotTransaction(
        { deletes: [], writes: [{ target, content: newBytes }] },
        {
          ...options,
          validateIgnorePolicy: async () => {
            await options.validateIgnorePolicy();
            if (staged) {
              staged = false;
              await fs.writeFile(target, "concurrent bytes");
            }
          },
        },
      ),
      /guarded recovery requires review/i,
    );
    assert.equal(await fs.readFile(target, "utf8"), "concurrent bytes");
    const { journal } = await journalState();
    assert.equal(journal.completed, undefined);
  }));

test("an edit between destructive directory steps stops subsequent removals and retains images", () =>
  fixture(async (root, options) => {
    const target = path.join(root, "tree");
    const first = path.join(target, "a");
    const second = path.join(target, "b");
    await fs.mkdir(target);
    const old = Buffer.from("old");
    await fs.writeFile(first, old);
    await fs.writeFile(second, old);
    const before = `directory:${imageHash(
      Buffer.from(
        JSON.stringify([
          ["a", fileImage(old)],
          ["b", fileImage(old)],
        ]),
      ),
    )}`;
    const unlink = fs.unlink.bind(fs);
    vi.spyOn(fs, "unlink").mockImplementation(async (file) => {
      await unlink(file);
      if (file === first) await fs.writeFile(path.join(root, filename), `${rules}/tree/b\n`);
    });
    await assert.rejects(
      applySnapshotTransaction(
        { deletes: [target], writes: [{ target, content: newBytes }] },
        { ...options, expectedPreimages: new Map([[target, before]]) },
      ),
      /ignore policy changed/i,
    );
    await assert.rejects(fs.lstat(first), { code: "ENOENT" });
    assert.deepEqual(await fs.readFile(second), old);
    const { directory, journal } = await journalState();
    assert.equal(journal.version, IGNORE_POLICY_JOURNAL_VERSION);
    assert.equal(journal.entries[0]?.removalPending, true);
    assert.deepEqual(await fs.readFile(path.join(directory, "before", "0", "a")), old);
  }));

test("pending recovery binds source, session intent, and reserved names and rechecks before installing a backup", () =>
  fixture(async (root, options) => {
    const target = path.join(root, "notes.md");
    await fs.writeFile(target, "before");
    const rulesFile = path.join(root, filename);
    const rename = fs.rename.bind(fs);
    const renameSpy = vi.spyOn(fs, "rename").mockImplementation(async (source, destination) => {
      await rename(source, destination);
      if (destination === target) await fs.writeFile(rulesFile, changedRules);
    });
    await assert.rejects(
      applySnapshotTransaction({ deletes: [], writes: [{ target, content: newBytes }] }, options),
      /ignore policy changed/i,
    );
    const { bytes, file, journal } = await journalState();
    assert.equal(journal.completed, undefined);
    assert.equal(journal.version, IGNORE_POLICY_JOURNAL_VERSION);
    assert.deepEqual(journal.ignoreSource, {
      version: 1,
      filename,
      sourceDigest: options.ignorePolicy.sourceDigest,
      reservedNames: options.ignorePolicy.reservedNames,
    });
    assert.deepEqual(journal.selection, selectionForSnapshot(undefined, undefined, options));
    assert.equal(bytes.includes(changedRules), false);
    await assert.rejects(recoverPendingSnapshotTransactions(), /different ignore-file policy/i);
    await assert.rejects(recoverPendingSnapshotTransactions(await txOptions(root)), /different ignore-file policy/i);
    await assert.rejects(
      recoverPendingSnapshotTransactions({ ...options, validateIgnorePolicy: undefined }),
      /freshness check/i,
    );
    await assert.rejects(recoverPendingSnapshotTransactions(options), /ignore policy changed/i);
    await fs.writeFile(rulesFile, rules);
    const alternate = ".alternate.syncignore";
    await fs.writeFile(path.join(root, alternate), rules);
    const sameFingerprint = await txOptions(root, { ...input, filename: alternate });
    assert.equal(sameFingerprint.ignorePolicy.fingerprint, options.ignorePolicy.fingerprint);
    for (const other of [
      sameFingerprint,
      await txOptions(root, { ...input, sessions: true }),
      await txOptions(root, { ...input, configuredFilenames: [] }),
    ]) {
      await assert.rejects(recoverPendingSnapshotTransactions(other), /different ignore-file policy/i);
    }
    for (const malformed of [
      { ...journal, version: AGENT_DIRECTORY_JOURNAL_VERSION },
      { ...journal, ignoreSource: undefined },
      { ...journal, ignoreSource: { ...journal.ignoreSource, version: 2 } },
    ]) {
      assert.throws(() => validateJournalPolicy(malformed as TransactionJournal), /preserve evidence/i);
    }
    assert.equal(await fs.readFile(file, "utf8"), bytes);
    assert.deepEqual(await fs.readFile(target), newBytes);

    renameSpy.mockImplementation(async (source, destination) => {
      await rename(source, destination);
      if (String(destination).endsWith(`${path.sep}image`)) await fs.writeFile(rulesFile, changedRules);
    });
    await assert.rejects(recoverPendingSnapshotTransactions(options), /ignore policy changed/i);
    const interrupted = await journalState();
    assert.equal(interrupted.journal.version, IGNORE_POLICY_JOURNAL_VERSION);
    assert.equal(interrupted.journal.completed, undefined);
    assert.ok(interrupted.journal.entries[0]?.recoveryWorkspaceId);
    assert.deepEqual(await fs.readFile(target), newBytes);
    await fs.writeFile(rulesFile, rules);
    renameSpy.mockRestore();
    await recoverPendingSnapshotTransactions(options);
    assert.equal(await fs.readFile(target, "utf8"), "before");
    assert.deepEqual(await fs.readdir(transactionRoot()), []);
  }));

test("a case replacement does not install the new spelling after rules change during removal", () =>
  fixture(async (root, options) => {
    const before = path.join(root, "Notes.md");
    const target = path.join(root, "notes.md");
    const rulesFile = path.join(root, filename);
    const old = Buffer.from("before");
    await fs.writeFile(before, old);
    const unlink = fs.unlink.bind(fs);
    const unlinkSpy = vi.spyOn(fs, "unlink").mockImplementation(async (file) => {
      await unlink(file);
      if (file === before) await fs.writeFile(rulesFile, changedRules);
    });
    await assert.rejects(
      applySnapshotTransaction(
        { deletes: [before], writes: [{ target, content: newBytes }] },
        { ...options, expectedPreimages: new Map([[before, fileImage(old)]]) },
      ),
      /ignore policy changed/i,
    );
    await assert.rejects(fs.lstat(before), { code: "ENOENT" });
    await assert.rejects(fs.lstat(target), { code: "ENOENT" });
    const { journal } = await journalState();
    assert.equal(journal.version, IGNORE_POLICY_JOURNAL_VERSION);
    assert.equal(journal.entries[0]?.removalPending, true);
    await assert.rejects(recoverPendingSnapshotTransactions(options), /ignore policy changed/i);
    unlinkSpy.mockRestore();
    await fs.writeFile(rulesFile, rules);
    await recoverPendingSnapshotTransactions(options);
    assert.deepEqual(await fs.readFile(before), old);
    assert.ok(!(await fs.readdir(root)).includes(path.basename(target)));
    assert.deepEqual(await fs.readdir(transactionRoot()), []);
  }));

test("committed v11 cleanup does not require the original ignore policy and never rolls back", () =>
  fixture(async (root, options) => {
    const target = path.join(root, "notes.md");
    await fs.writeFile(target, "before");
    const rm = fs.rm.bind(fs);
    const rmSpy = vi.spyOn(fs, "rm").mockImplementation(async (file, options) => {
      if (path.dirname(String(file)) === transactionRoot()) throw new Error("cleanup interrupted");
      return rm(file, options);
    });
    await assert.rejects(
      applySnapshotTransaction({ deletes: [], writes: [{ target, content: newBytes }] }, options),
      /cleanup interrupted/i,
    );
    const { journal } = await journalState();
    assert.equal(journal.version, IGNORE_POLICY_JOURNAL_VERSION);
    assert.equal(journal.completed, true);
    rmSpy.mockRestore();
    await fs.writeFile(path.join(root, filename), changedRules);
    await recoverPendingSnapshotTransactions();
    assert.deepEqual(await fs.readFile(target), newBytes);
    assert.deepEqual(await fs.readdir(transactionRoot()), []);
  }));
