import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { test, vi } from "vitest";
import { withTargetQueues } from "../src/snapshot/snapshot-mutation-queues.js";
import { applySnapshotTransaction, recoverPendingSnapshotTransactions } from "../src/snapshot/snapshot-transaction.js";
import { caseInsensitiveLookup, withSnapshotQueueRoot } from "./snapshot-queue-fixture.js";
import { deferred } from "./startup-check-helpers.js";

const image = (value: string) => `file:${createHash("sha256").update(value).digest("hex")}`;

async function caseJournal(root: string, missing: boolean) {
  const directory = path.join(root, "pi-sync/transactions/interrupted");
  await fs.mkdir(path.join(directory, "before"), { recursive: true });
  await fs.writeFile(path.join(directory, "before/0"), "before");
  await fs.writeFile(
    path.join(directory, "journal.json"),
    JSON.stringify({
      version: 5,
      root,
      entries: [
        {
          target: path.join(root, "append_system.md"),
          afterTarget: path.join(root, "APPEND_SYSTEM.md"),
          backupName: "0",
          kind: "file",
          beforeImage: image("before"),
          afterImage: image("after"),
          postFiles: [],
          removalPending: missing,
          replacementStarted: !missing,
        },
      ],
    }),
  );
  return directory;
}

for (const recovery of [false, true])
  for (const initiallyMissing of [false, true])
    for (const canonicalWriter of [false, true])
      for (const sourceSpelling of [false, true])
        for (const content of ["NEWER PI CONTENT", "before", "after"])
          test(`aliased ${recovery ? "recovery" : "apply"} refuses ${initiallyMissing ? "missing" : "existing"} ${canonicalWriter ? "canonical" : "lexical"} ${sourceSpelling ? "source" : "destination"} writer: ${content}`, async () =>
            withSnapshotQueueRoot(true, async (root, canonicalRoot) => {
              const before = path.join(root, "append_system.md");
              const after = path.join(root, "APPEND_SYSTEM.md");
              if (!initiallyMissing) await fs.writeFile(recovery ? after : before, recovery ? "after" : "before");
              const directory = recovery ? await caseJournal(root, initiallyMissing) : undefined;
              const restore = await caseInsensitiveLookup(root);
              const target = path.join(
                canonicalWriter ? canonicalRoot : root,
                sourceSpelling ? "append_system.md" : "APPEND_SYSTEM.md",
              );
              const entered = deferred();
              const release = deferred();
              // The installed queue selects its realpath/existing or lexical/missing key
              // before the writer materializes the file. No timer guesses registration.
              const writer = withFileMutationQueue(target, async () => {
                await fs.writeFile(target, content);
                entered.resolve();
                await release.promise;
              });
              try {
                await entered.promise;
                await assert.rejects(
                  recovery
                    ? recoverPendingSnapshotTransactions()
                    : applySnapshotTransaction({
                        deletes: initiallyMissing ? [] : [before],
                        writes: [{ target: after, content: Buffer.from("after") }],
                      }),
                  /aliased parent.*canonical agent\/session path/,
                );
                assert.equal(await fs.readFile(target, "utf8"), content);
                if (directory) {
                  await fs.access(path.join(directory, "journal.json"));
                  assert.equal(await fs.readFile(path.join(directory, "before/0"), "utf8"), "before");
                } else await assert.rejects(fs.access(path.join(root, "pi-sync/transactions")), { code: "ENOENT" });
              } finally {
                release.resolve();
                await writer;
                restore();
              }
              // Rejection did not retain any public queue reservation.
              for (const spelling of [before, after]) await withFileMutationQueue(spelling, async () => {});
            }));

for (const operation of ["overwrite", "delete-recreate", "delete-only", "missing-descendant", "file-ancestor"] as const)
  test(`aliased ordinary ${operation} refuses before live mutation`, async () =>
    withSnapshotQueueRoot(true, async (root) => {
      const target = path.join(root, "custom.md");
      await fs.writeFile(target, "before");
      const descendant = path.join(root, operation === "file-ancestor" ? "custom.md" : "absent", "nested", "new.md");
      await assert.rejects(
        applySnapshotTransaction({
          deletes: ["delete-recreate", "delete-only", "file-ancestor"].includes(operation) ? [target] : [],
          writes:
            operation === "delete-only"
              ? []
              : [
                  {
                    target: ["missing-descendant", "file-ancestor"].includes(operation) ? descendant : target,
                    content: Buffer.from("after"),
                  },
                ],
        }),
        /aliased parent/,
      );
      assert.equal(await fs.readFile(target, "utf8"), "before");
      await assert.rejects(fs.access(path.join(root, "absent")), { code: "ENOENT" });
      await assert.rejects(fs.access(path.join(root, "pi-sync/transactions")), { code: "ENOENT" });
    }));

for (const recovery of [false, true])
  test(`native case-insensitive alias ${recovery ? "recovery" : "apply"} refuses without deleting evidence`, async ({
    skip,
  }) =>
    withSnapshotQueueRoot(true, async (root) => {
      const before = path.join(root, "append_system.md");
      const after = path.join(root, "APPEND_SYSTEM.md");
      await fs.writeFile(recovery ? after : before, recovery ? "after" : "before");
      if ((await fs.realpath(before).catch(() => undefined)) !== (await fs.realpath(after).catch(() => undefined)))
        skip();
      const directory = recovery ? await caseJournal(root, false) : undefined;
      await assert.rejects(
        recovery
          ? recoverPendingSnapshotTransactions()
          : applySnapshotTransaction({ deletes: [before], writes: [{ target: after, content: Buffer.from("after") }] }),
        /aliased parent/,
      );
      assert.equal(await fs.readFile(before, "utf8"), recovery ? "after" : "before");
      if (directory) assert.equal(await fs.readFile(path.join(directory, "before/0"), "utf8"), "before");
    }));

for (const kind of ["existing", "missing", "delete-recreate", "symlink-delete-recreate"] as const)
  test(`canonical ${kind} queues a missing-path writer through installation`, async () =>
    withSnapshotQueueRoot(false, async (root) => {
      const target = path.join(root, "AGENTS.md");
      const referent = path.join(root, "referent.md");
      if (kind === "symlink-delete-recreate") {
        await fs.writeFile(referent, "before");
        await fs.symlink(referent, target);
      } else if (kind !== "missing") await fs.writeFile(target, "before");
      const entered = deferred();
      const release = deferred();
      const registered = deferred();
      const events: string[] = [];
      const rename = fs.rename.bind(fs);
      const realpath = fs.realpath.bind(fs);
      const installer = vi.spyOn(fs, "rename").mockImplementation(async (source, destination) => {
        if (String(source).endsWith(".apply") && destination === target) {
          entered.resolve();
          await release.promise;
          await rename(source, destination);
          events.push("installed");
        } else await rename(source, destination);
      });
      let registering = false;
      const observer = vi.spyOn(fs, "realpath").mockImplementation(async (...args) => {
        try {
          return await realpath(...args);
        } finally {
          if (registering && args[0] === target) registered.resolve();
        }
      });
      syncBuiltinESMExports();
      let task: Promise<unknown> | undefined;
      let writer: Promise<unknown> | undefined;
      try {
        task = applySnapshotTransaction({
          deletes: ["delete-recreate", "symlink-delete-recreate"].includes(kind) ? [target] : [],
          writes: [{ target, content: Buffer.from("after") }],
        });
        void task.catch(entered.reject);
        await entered.promise;
        registering = true;
        writer = withFileMutationQueue(target, async () => {
          events.push("writer");
          await fs.writeFile(target, "NEWER PI CONTENT");
        });
        await registered.promise;
        release.resolve();
        await task;
        await writer;
        assert.deepEqual(events, ["installed", "writer"]);
        assert.equal(await fs.readFile(target, "utf8"), "NEWER PI CONTENT");
        if (kind === "symlink-delete-recreate") assert.equal(await fs.readFile(referent, "utf8"), "before");
      } finally {
        release.resolve();
        await Promise.allSettled([...(task ? [task] : []), ...(writer ? [writer] : [])]);
        installer.mockRestore();
        observer.mockRestore();
        syncBuiltinESMExports();
      }
    }));

for (const recovery of [false, true])
  for (const content of ["NEWER PI CONTENT", "before", "after"])
    test(`initially missing ordinary ${recovery ? "recovery" : "apply"} preserves materialization during queue registration: ${content}`, async () =>
      withSnapshotQueueRoot(false, async (root) => {
        const target = path.join(root, "AGENTS.md");
        const directory = recovery ? await caseJournal(root, true) : undefined;
        if (directory) {
          const file = path.join(directory, "journal.json");
          const journal = JSON.parse(await fs.readFile(file, "utf8"));
          journal.version = 4;
          journal.entries[0].target = target;
          delete journal.entries[0].afterTarget;
          await fs.writeFile(file, JSON.stringify(journal));
        }
        const realpath = fs.realpath.bind(fs);
        let injected = false;
        const observer = vi.spyOn(fs, "realpath").mockImplementation(async (...args) => {
          try {
            return await realpath(...args);
          } catch (error) {
            if (!injected && args[0] === target && (error as NodeJS.ErrnoException).code === "ENOENT") {
              injected = true;
              await withFileMutationQueue(target, () => fs.writeFile(target, content));
            }
            throw error;
          }
        });
        syncBuiltinESMExports();
        try {
          await assert.rejects(
            recovery
              ? recoverPendingSnapshotTransactions()
              : applySnapshotTransaction({ deletes: [], writes: [{ target, content: Buffer.from("after") }] }),
            /appeared during queue acquisition/,
          );
          assert.equal(injected, true);
          assert.equal(await fs.readFile(target, "utf8"), content);
          if (directory) {
            await fs.access(path.join(directory, "journal.json"));
            assert.equal(await fs.readFile(path.join(directory, "before/0"), "utf8"), "before");
          } else await assert.rejects(fs.access(path.join(root, "pi-sync/transactions")), { code: "ENOENT" });
          await withFileMutationQueue(target, async () => {});
        } finally {
          observer.mockRestore();
          syncBuiltinESMExports();
        }
      }));

for (const content of ["NEWER PI CONTENT", "after"])
  test(`canonical symlink deletion preserves a raced writer instead of rolling back: ${content}`, async () =>
    withSnapshotQueueRoot(false, async (root) => {
      const target = path.join(root, "AGENTS.md");
      const referent = path.join(root, "referent.md");
      await fs.writeFile(referent, "before");
      await fs.symlink(referent, target);
      const rm = fs.rm.bind(fs);
      let injected = false;
      const removal = vi.spyOn(fs, "rm").mockImplementation(async (...args) => {
        await rm(...args);
        if (!injected && args[0] === target) {
          injected = true;
          await withFileMutationQueue(target, () => fs.writeFile(target, content));
        }
      });
      try {
        await assert.rejects(
          applySnapshotTransaction({ deletes: [target], writes: [{ target, content: Buffer.from("after") }] }),
          /evidence retained/,
        );
        assert.equal(injected, true);
        assert.equal(await fs.readFile(target, "utf8"), content);
        assert.equal(await fs.readFile(referent, "utf8"), "before");
        const pending = await fs.readdir(path.join(root, "pi-sync/transactions"));
        assert.equal(pending.length, 1);
        await fs.access(path.join(root, "pi-sync/transactions", pending[0] ?? "", "journal.json"));
        await withFileMutationQueue(target, async () => {});
      } finally {
        removal.mockRestore();
      }
    }));

for (const content of ["NEWER PI CONTENT", "before", "after"])
  test(`missing case recovery preserves a pre-reservation destination writer: ${content}`, async () =>
    withSnapshotQueueRoot(false, async (root) => {
      const before = path.join(root, "append_system.md");
      const after = path.join(root, "APPEND_SYSTEM.md");
      const directory = await caseJournal(root, true);
      const restore = await caseInsensitiveLookup(root);
      const lstat = vi.mocked(fs.lstat).getMockImplementation();
      assert.ok(lstat);
      let injected = false;
      const observation = vi.spyOn(fs, "lstat").mockImplementation(async (...args) => {
        try {
          return await lstat(...args);
        } catch (error) {
          if (!injected && args[0] === after && (error as NodeJS.ErrnoException).code === "ENOENT") {
            injected = true;
            await withFileMutationQueue(after, () => fs.writeFile(after, content));
          }
          throw error;
        }
      });
      try {
        await assert.rejects(recoverPendingSnapshotTransactions(), /changed before destination queue/);
        assert.equal(injected, true);
        assert.equal(await fs.readFile(before, "utf8"), content);
        assert.equal(await fs.readFile(path.join(directory, "before/0"), "utf8"), "before");
        await fs.access(path.join(directory, "journal.json"));
        for (const spelling of [before, after]) await withFileMutationQueue(spelling, async () => {});
      } finally {
        observation.mockRestore();
        restore();
      }
    }));

for (const invalidation of ["abort", "owner"] as const)
  test(`canonical queued transaction releases every key after ${invalidation}`, async () =>
    withSnapshotQueueRoot(false, async (root) => {
      const target = path.join(root, "AGENTS.md");
      await fs.writeFile(target, "before");
      const entered = deferred();
      const release = deferred();
      const registered = deferred();
      const controller = new AbortController();
      let valid = true;
      const blocker = withFileMutationQueue(target, async () => {
        entered.resolve();
        await release.promise;
      });
      await entered.promise;
      const realpath = fs.realpath.bind(fs);
      let lookups = 0;
      const observer = vi.spyOn(fs, "realpath").mockImplementation(async (...args) => {
        const result = await realpath(...args);
        if (args[0] === target && ++lookups === 2) registered.resolve();
        return result;
      });
      syncBuiltinESMExports();
      const task = applySnapshotTransaction(
        { deletes: [], writes: [{ target, content: Buffer.from("after") }] },
        {
          signal: controller.signal,
          validateMutation: () => {
            if (!valid) throw new Error("owner replaced");
          },
        },
      );
      const rejected = assert.rejects(task, /abort|owner replaced/i);
      try {
        await registered.promise;
        if (invalidation === "abort") controller.abort();
        else valid = false;
        release.resolve();
        await rejected;
        await blocker;
        assert.equal(await fs.readFile(target, "utf8"), "before");
        await withTargetQueues([target], {}, async () => {});
      } finally {
        release.resolve();
        await Promise.allSettled([task, rejected, blocker]);
        observer.mockRestore();
        syncBuiltinESMExports();
      }
    }));
