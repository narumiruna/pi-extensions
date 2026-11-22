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
import {
  BOUND_INCLUDED_PATHS_JOURNAL_VERSION,
  type TransactionJournal,
} from "../src/engine/snapshot/snapshot-transaction-policy.js";
import type { Snapshot, SnapshotOptions } from "../src/engine/snapshot/snapshot-types.js";
import { acceptedSelection, syncPolicyChanged } from "../src/engine/sync/sync-state.js";

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

      await assert.rejects(applySnapshot(incoming, new Set(), mixed), /freshness check/);
      const applied = await applySnapshot(incoming, new Set(), { ...mixed, validateIgnorePolicy: async () => {} });
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

test("mixed legacy baselines bind the setup and normalized reservations without changing wire selection", () => {
  const config = { setupName: "legacy", include: ["notes"], ...reserved };
  const accepted = {
    version: 1,
    profile: "legacy",
    lastAppliedSnapshot: "accepted",
    lastFileHashes: {},
    ...acceptedSelection(config),
  };
  assert.equal(syncPolicyChanged(accepted, config), false);
  assert.equal(
    syncPolicyChanged(accepted, {
      ...config,
      reservedIgnoreNames: [...reserved.reservedIgnoreNames].reverse().map((name) => name.toUpperCase()),
    }),
    false,
  );
  for (const changed of [
    { ...config, setupName: "other" },
    { ...config, reservedIgnoreNames: [...reserved.reservedIgnoreNames, "another.rules"] },
    { ...config, reservedIgnoreNames: undefined },
  ])
    assert.equal(syncPolicyChanged(accepted, changed), true);
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

test("mixed operations refuse settings symlinks when the host permits their creation", ({ skip }) =>
  fixture(async (root) => {
    const privateFile = await put(root, "Work.Rules", '{"sessionDir":"/unrelated"}');
    const settings = path.join(root, "settings.json");
    try {
      await fs.symlink(privateFile, settings);
    } catch (error) {
      if (process.platform === "win32" && (error as NodeJS.ErrnoException).code === "EPERM") {
        skip("Windows file symlinks require Developer Mode or symlink privileges.");
      }
      throw error;
    }
    assert.equal(await configuredSessionDir(), "/unrelated");
    await assert.rejects(configuredSessionDir(reserved), protectedPath);
    await assert.rejects(createSnapshot("legacy", { ...reserved, include: ["settings.json"] }), protectedPath);
  }));

test("mixed operations refuse linked source files without requiring symlink privileges", () =>
  fixture(async (root) => {
    const privateFile = await put(root, "Work.Rules", '{"sessionDir":"/unrelated"}');
    const settings = path.join(root, "settings.json");
    await fs.link(privateFile, settings);
    await assert.rejects(configuredSessionDir(reserved), /unsafe filesystem layout/);
    await assert.rejects(
      preflightSnapshotMutations(root, { deletes: [settings], writes: [] }, undefined, reserved),
      /hard link/,
    );
  }));

test("mixed operations refuse reserved physical session storage through directory aliases", () =>
  fixture(async (root) => {
    const privateDir = path.dirname(await put(root, "Alternate.Rules/session.jsonl"));
    const logicalSessionAlias = path.join(root, "alias");
    await fs.symlink(privateDir, logicalSessionAlias, process.platform === "win32" ? "junction" : "dir");
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
    await assert.rejects(recoverPendingSnapshotTransactions(reserved), /different setup or ignore policy evidence/);
    assert.deepEqual(await fs.readdir(transactionRoot()), pending);
    assert.equal(await fs.readFile(file, "utf8"), "after");
  }));

test.each(
  (["apply write", "apply delete", "restore file", "restore directory"] as const).flatMap((operation) =>
    (["cancelled", "ownership lost"] as const).map((stop) => ({ operation, stop })),
  ),
)("mixed legacy $operation stops when $stop during final image verification", ({ operation, stop }) =>
  fixture(async (root) => {
    const directory = operation === "restore directory";
    const restoring = directory || operation === "restore file";
    const deleting = directory || operation === "apply delete";
    const target = path.join(root, "notes");
    const original = await put(root, directory ? "notes/child" : "notes", "before");
    const plan = deleting
      ? { deletes: [target], writes: [] }
      : { deletes: [], writes: [{ target, content: Buffer.from("after") }] };
    const options = { ...reserved, setupName: "legacy", validateIgnorePolicy: async () => {} };
    const initial = restoring ? new AbortController() : undefined;
    const cancellation = new AbortController();
    const reason = new Error(stop);
    let journalFile: string | undefined;
    let finalCheck = false;
    let verificationReached = false;
    const rename = fs.rename.bind(fs);
    const rm = fs.rm.bind(fs);
    const lstat = fs.lstat.bind(fs);
    const renames = vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
      await rename(from, to);
      if (typeof to === "string" && path.basename(to) === "journal.json") journalFile = to;
      if (to === target) initial?.abort();
    });
    const removals = vi.spyOn(fs, "rm").mockImplementation(async (file, options) => {
      await rm(file, options);
      if (file === target) initial?.abort();
    });
    const reads = vi.spyOn(fs, "lstat").mockImplementation(async (...args) => {
      try {
        return await lstat(...args);
      } finally {
        // Only the image verification uses bigint stats; the exclude check uses regular stats.
        if (finalCheck && !verificationReached && args[0] === target && args[1]?.bigint) {
          verificationReached = true;
          renames.mockClear();
          removals.mockClear();
          if (stop === "cancelled") cancellation.abort(reason);
        }
      }
    });
    try {
      if (initial)
        await assert.rejects(applySnapshotTransaction(plan, { ...options, signal: initial.signal }), /apply cancelled/);
      const guarded = {
        ...options,
        signal: cancellation.signal,
        validateMutation: () => {
          if (stop === "ownership lost" && verificationReached) throw reason;
        },
        validateIgnorePolicy: async () => {
          if (operation === "apply write") {
            finalCheck = (await fs.readdir(root)).some((name) => name.endsWith(".apply"));
          } else if (journalFile) {
            const { entries } = JSON.parse(await fs.readFile(journalFile, "utf8")) as TransactionJournal;
            finalCheck = restoring ? entries[0]?.replacementStarted === true : entries[0]?.removalPending === true;
          }
        },
      };
      if (restoring) await assert.rejects(recoverPendingSnapshotTransactions(guarded), (error) => error === reason);
      else
        await assert.rejects(
          applySnapshotTransaction(plan, guarded),
          stop === "cancelled" ? /apply cancelled/ : /guarded recovery requires review/,
        );
      assert.ok(verificationReached);
      assert.equal(
        renames.mock.calls.some(([, to]) => to === target),
        false,
        "live target was renamed",
      );
      assert.equal(
        removals.mock.calls.some(([file]) => file === target),
        false,
        "live target was removed",
      );
    } finally {
      reads.mockRestore();
      removals.mockRestore();
      renames.mockRestore();
    }
    if (directory) await assert.rejects(fs.lstat(target), { code: "ENOENT" });
    else assert.equal(await fs.readFile(target, "utf8"), restoring ? "after" : "before");
    assert.ok(journalFile);
    const journalBytes = await fs.readFile(journalFile, "utf8");
    const journal = JSON.parse(journalBytes) as TransactionJournal;
    assert.equal(journal.version, BOUND_INCLUDED_PATHS_JOURNAL_VERSION);
    assert.equal(journal.completed, undefined);
    const backup = path.join(path.dirname(journalFile), "before", "0");
    assert.equal(await fs.readFile(directory ? path.join(backup, "child") : backup, "utf8"), "before");
    if (directory) {
      // A vacancy is no longer accepted after the journal arms replacement.
      await assert.rejects(recoverPendingSnapshotTransactions(options), /automatic rollback refused/);
      assert.equal(await fs.readFile(journalFile, "utf8"), journalBytes);
    } else {
      await recoverPendingSnapshotTransactions(options);
      assert.equal(await fs.readFile(original, "utf8"), "before");
      assert.deepEqual(await fs.readdir(transactionRoot()), []);
    }
  }),
);

test("mixed legacy recovery rejects changed or removed reservations and restores only with the original binding", () =>
  fixture(async (root) => {
    const target = await put(root, "notes.md", "before");
    const original = { ...reserved, include: ["notes.md"], setupName: "legacy", validateIgnorePolicy: async () => {} };
    const cancellation = new AbortController();
    const rename = fs.rename.bind(fs);
    const patch = vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
      await rename(from, to);
      if (to === target) cancellation.abort();
    });
    try {
      await assert.rejects(
        applySnapshotTransaction(
          { deletes: [], writes: [{ target, content: Buffer.from("after") }] },
          {
            ...original,
            signal: cancellation.signal,
          },
        ),
        /transaction evidence retained/,
      );
    } finally {
      patch.mockRestore();
    }
    const pending = await fs.readdir(transactionRoot());
    assert.equal(pending.length, 1);
    for (const candidate of [
      { ...original, reservedIgnoreNames: undefined },
      { ...original, reservedIgnoreNames: [...reserved.reservedIgnoreNames, "notes.md"] },
      { ...original, setupName: "other" },
    ]) {
      await assert.rejects(recoverPendingSnapshotTransactions(candidate), /different setup or ignore policy evidence/);
      assert.deepEqual(await fs.readdir(transactionRoot()), pending);
      assert.equal(await fs.readFile(target, "utf8"), "after");
    }
    const interruptedRecovery = new AbortController();
    const stagePatch = vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
      await rename(from, to);
      if (
        typeof to === "string" &&
        path.basename(to) === "journal.json" &&
        (await fs.readFile(to, "utf8")).includes('"recoveryStaged": true')
      )
        interruptedRecovery.abort();
    });
    try {
      await assert.rejects(recoverPendingSnapshotTransactions({ ...original, signal: interruptedRecovery.signal }), {
        name: "AbortError",
      });
      assert.ok(interruptedRecovery.signal.aborted);
      assert.equal(await fs.readFile(target, "utf8"), "after");
    } finally {
      stagePatch.mockRestore();
    }
    await recoverPendingSnapshotTransactions(original);
    assert.equal(await fs.readFile(target, "utf8"), "before");
    assert.deepEqual(await fs.readdir(transactionRoot()), []);
  }));
