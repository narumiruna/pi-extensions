import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { test, vi } from "vitest";
import { coalesceCaseReplacements } from "../src/snapshot/snapshot-case-replacement.js";
import {
  applySnapshotTransaction,
  recoverPendingSnapshotTransactions,
  recoverSnapshotTransactionsOnStartup,
} from "../src/snapshot/snapshot-transaction.js";
import { caseInsensitiveLookup, withSnapshotQueueRoot } from "./snapshot-queue-fixture.js";
import { deferred } from "./startup-check-helpers.js";

const withTempHome = <T>(action: (root: string) => Promise<T>) => withSnapshotQueueRoot(false, action);

const image = (value: string) => `file:${createHash("sha256").update(value).digest("hex")}`;

for (const phase of ["prepared", "session", "settings"])
  test(`case-coalesced settings authorize root-transition recovery after ${phase}`, async () =>
    withTempHome(async (root) => {
      await fs.mkdir(root, { recursive: true });
      const original = path.join(root, "SETTINGS.JSON");
      const canonical = path.join(root, "settings.json");
      const oldRoot = path.join(path.dirname(root), "old-sessions");
      const newRoot = path.join(path.dirname(root), "new-sessions");
      const before = JSON.stringify({ sessionDir: oldRoot });
      const after = JSON.stringify({ sessionDir: newRoot });
      await fs.writeFile(original, before);
      await fs.mkdir(newRoot, { recursive: true });
      const target = path.join(newRoot, "conversation.jsonl");
      await fs.writeFile(target, "before-session");
      const controller = new AbortController();
      let injecting = true;
      const restoreLookup = await caseInsensitiveLookup(root, (_from, to) => {
        if (
          injecting &&
          ((phase === "prepared" && String(to).endsWith("journal.json")) ||
            (phase === "session" && to === target) ||
            (phase === "settings" && to === canonical))
        )
          controller.abort();
      });
      try {
        await assert.rejects(
          applySnapshotTransaction(
            {
              deletes: [original],
              writes: [
                { target, content: Buffer.from("after-session") },
                { target: canonical, content: Buffer.from(after) },
              ],
            },
            { sessionDir: newRoot, signal: controller.signal },
          ),
          /cancel|abort/i,
        );
        injecting = false;
        assert.equal(controller.signal.aborted, true, "the requested interruption was reached");
        if (phase === "session") {
          await assert.rejects(fs.access(canonical), { code: "ENOENT" });
          // Arming the case replacement makes its missing settings image ambiguous.
          await assert.rejects(recoverSnapshotTransactionsOnStartup(), /not owned|newer bytes/);
          assert.equal(await fs.readFile(target, "utf8"), "after-session");
          await assert.rejects(fs.access(canonical), { code: "ENOENT" });
          assert.equal((await fs.readdir(path.join(root, "pi-sync/transactions"))).length, 1);
          return;
        }
        await recoverSnapshotTransactionsOnStartup();
        assert.equal(await fs.readFile(original, "utf8"), before);
        assert.equal(await fs.readFile(target, "utf8"), "before-session");
        assert.ok((await fs.readdir(root)).includes("SETTINGS.JSON"));
      } finally {
        restoreLookup();
      }
    }));

test("native case-insensitive filesystem installs and recovers a case replacement", async ({ skip }) =>
  withTempHome(async (root) => {
    await fs.mkdir(root, { recursive: true });
    const before = path.join(root, "append_system.md");
    const after = path.join(root, "APPEND_SYSTEM.md");
    await fs.writeFile(before, "before");
    try {
      if ((await fs.realpath(before)) !== (await fs.realpath(after))) skip();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") skip();
      throw error;
    }
    const controller = new AbortController();
    const rename = fs.rename.bind(fs);
    const spy = vi.spyOn(fs, "rename").mockImplementation(async (source, destination) => {
      await rename(source, destination);
      if (String(source).endsWith(".apply") && destination === after) controller.abort();
    });
    try {
      await assert.rejects(
        applySnapshotTransaction(
          { deletes: [before], writes: [{ target: after, content: Buffer.from("after") }] },
          { signal: controller.signal },
        ),
        /cancelled/,
      );
      assert.deepEqual(
        (await fs.readdir(root)).filter((name) => name.endsWith(".md")),
        ["APPEND_SYSTEM.md"],
      );
      await recoverPendingSnapshotTransactions();
      assert.equal(await fs.readFile(before, "utf8"), "before");
      assert.deepEqual(
        (await fs.readdir(root)).filter((name) => name.endsWith(".md")),
        ["append_system.md"],
      );
    } finally {
      spy.mockRestore();
    }
  }));

for (const content of ["after", "before"])
  test(`case replacement installs canonical spelling with ${content === "before" ? "equal" : "changed"} bytes`, async () =>
    withTempHome(async (root) => {
      await fs.mkdir(root, { recursive: true });
      const before = path.join(root, "append_system.md");
      const after = path.join(root, "APPEND_SYSTEM.md");
      await fs.writeFile(before, "before");
      const restore = await caseInsensitiveLookup(root);
      try {
        await applySnapshotTransaction({
          deletes: [before],
          writes: [{ target: after, content: Buffer.from(content) }],
        });
        assert.deepEqual(
          (await fs.readdir(root)).filter((name) => name.toLowerCase() === "append_system.md"),
          ["APPEND_SYSTEM.md"],
        );
        assert.equal(await fs.readFile(after, "utf8"), content);
        assert.deepEqual(await fs.readdir(path.join(root, "pi-sync/transactions")), []);
      } finally {
        restore();
      }
    }));

for (const phase of [
  "prepared",
  "removed",
  "armed-missing",
  "installed",
  "installed-equal",
  "newer",
  "deleted",
] as const)
  test(`case replacement recovery: ${phase}`, async () =>
    withTempHome(async (root) => {
      const before = path.join(root, "append_system.md");
      const after = path.join(root, "APPEND_SYSTEM.md");
      const directory = path.join(root, "pi-sync/transactions/interrupted");
      await fs.mkdir(path.join(directory, "before"), { recursive: true });
      await fs.writeFile(path.join(directory, "before/0"), "before");
      if (phase === "prepared") await fs.writeFile(before, "before");
      if (phase === "installed") await fs.writeFile(after, "after");
      if (phase === "installed-equal") await fs.writeFile(after, "before");
      if (phase === "newer") await fs.writeFile(after, "newer");
      await fs.writeFile(
        path.join(directory, "journal.json"),
        JSON.stringify({
          version: 5,
          root,
          entries: [
            {
              target: before,
              afterTarget: after,
              backupName: "0",
              kind: "file",
              beforeImage: image("before"),
              afterImage: image(phase === "installed-equal" ? "before" : "after"),
              postFiles: [],
              removalPending: phase === "removed",
              replacementStarted: !["prepared", "removed"].includes(phase),
            },
          ],
        }),
      );
      const restore = await caseInsensitiveLookup(root);
      try {
        if (["armed-missing", "newer", "deleted"].includes(phase)) {
          await assert.rejects(recoverPendingSnapshotTransactions(), /unrecognized or newer/);
          await fs.access(directory);
          if (phase === "newer") assert.equal(await fs.readFile(after, "utf8"), "newer");
          else
            assert.deepEqual(
              (await fs.readdir(root)).filter((name) => name.endsWith(".md")),
              [],
            );
        } else {
          await recoverPendingSnapshotTransactions();
          assert.equal(await fs.readFile(before, "utf8"), "before");
          assert.deepEqual(
            (await fs.readdir(root)).filter((name) => name.endsWith(".md")),
            ["append_system.md"],
          );
          await assert.rejects(fs.access(directory), { code: "ENOENT" });
        }
      } finally {
        restore();
      }
    }));

for (const newer of [false, true])
  test(`interrupted actual case replacement retains one backup and ${newer ? "refuses newer bytes" : "restores original spelling"}`, async () =>
    withTempHome(async (root) => {
      await fs.mkdir(root, { recursive: true });
      const before = path.join(root, "append_system.md");
      const after = path.join(root, "APPEND_SYSTEM.md");
      await fs.writeFile(before, "before");
      const rename = fs.rename.bind(fs);
      const restore = await caseInsensitiveLookup(root);
      const controller = new AbortController();
      const spy = vi.spyOn(fs, "rename").mockImplementation(async (source, destination) => {
        await rename(source, destination);
        if (String(source).endsWith(".apply") && destination === after) controller.abort();
      });
      try {
        await assert.rejects(
          applySnapshotTransaction(
            { deletes: [before], writes: [{ target: after, content: Buffer.from("after") }] },
            { signal: controller.signal },
          ),
          /cancelled/,
        );
        spy.mockRestore();
        const pending = path.join(root, "pi-sync/transactions");
        const directories = await fs.readdir(pending);
        assert.equal(directories.length, 1);
        const directory = path.join(pending, directories[0] ?? "");
        const journal = JSON.parse(await fs.readFile(path.join(directory, "journal.json"), "utf8"));
        assert.equal(journal.version, 5);
        assert.equal(journal.entries.length, 1);
        assert.equal(journal.entries[0].target, before);
        assert.equal(journal.entries[0].afterTarget, after);
        assert.equal(await fs.readFile(path.join(directory, "before/0"), "utf8"), "before");
        if (newer) await fs.writeFile(after, "newer");
        if (newer) {
          await assert.rejects(recoverPendingSnapshotTransactions(), /unrecognized or newer/);
          assert.equal(await fs.readFile(after, "utf8"), "newer");
          await fs.access(directory);
        } else {
          await recoverPendingSnapshotTransactions();
          assert.equal(await fs.readFile(before, "utf8"), "before");
          assert.deepEqual(
            (await fs.readdir(root)).filter((name) => name.endsWith(".md")),
            ["append_system.md"],
          );
        }
      } finally {
        spy.mockRestore();
        restore();
      }
    }));

for (const malformed of ["old-version", "non-file", "other-name", "other-root"] as const)
  test(`case replacement rejects ${malformed} naming evidence`, async () =>
    withTempHome(async (root) => {
      const target = path.join(root, "append_system.md");
      const directory = path.join(root, "pi-sync/transactions/interrupted");
      await fs.mkdir(path.join(directory, "before"), { recursive: true });
      await fs.writeFile(target, "before");
      await fs.writeFile(path.join(directory, "before/0"), "before");
      await fs.writeFile(
        path.join(directory, "journal.json"),
        JSON.stringify({
          version: malformed === "old-version" ? 4 : 5,
          root,
          entries: [
            {
              target,
              afterTarget:
                malformed === "other-root"
                  ? path.join(path.dirname(root), "APPEND_SYSTEM.md")
                  : path.join(root, malformed === "other-name" ? "OTHER.md" : "APPEND_SYSTEM.md"),
              backupName: "0",
              kind: malformed === "non-file" ? "directory" : "file",
              beforeImage: image("before"),
              afterImage: image("after"),
              postFiles: [],
            },
          ],
        }),
      );
      await assert.rejects(recoverPendingSnapshotTransactions(), /Invalid transaction case replacement/);
      assert.equal(await fs.readFile(target, "utf8"), "before");
      await fs.access(directory);
    }));

async function caseQueueFixture(root: string, recovery: boolean, removed = false) {
  const before = path.join(root, "append_system.md");
  const after = path.join(root, "APPEND_SYSTEM.md");
  await fs.mkdir(root, { recursive: true });
  if (!removed) await fs.writeFile(recovery ? after : before, recovery ? "after" : "before");
  if (recovery) {
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
            target: before,
            afterTarget: after,
            backupName: "0",
            kind: "file",
            beforeImage: image("before"),
            afterImage: image("after"),
            postFiles: [],
            removalPending: removed,
            replacementStarted: !removed,
          },
        ],
      }),
    );
  }
  return {
    before,
    after,
    run: (options: { signal?: AbortSignal; validateMutation?: () => void } = {}) =>
      recovery
        ? recoverPendingSnapshotTransactions(options)
        : applySnapshotTransaction(
            { deletes: [before], writes: [{ target: after, content: Buffer.from("after") }] },
            options,
          ),
  };
}

for (const [recovery, removed, boundary] of [
  [false, false, "rename"],
  [true, false, "rename"],
  [true, true, "rename"],
  [true, true, "stage"],
] as const)
  test(`case ${recovery ? "recovery" : "apply"}${removed ? " after interrupted removal" : ""} holds both spelling queues at ${boundary}`, async () =>
    withTempHome(async (root) => {
      const f = await caseQueueFixture(root, recovery, removed);
      const restore = await caseInsensitiveLookup(root);
      const entered = deferred();
      const release = deferred();
      const registered = deferred();
      const events: string[] = [];
      const rename = vi.mocked(fs.rename).getMockImplementation();
      const realpath = vi.mocked(fs.realpath).getMockImplementation();
      const copyFile = vi.mocked(fs.copyFile).getMockImplementation();
      assert.ok(rename && realpath && copyFile);
      const stage = vi.spyOn(fs, "copyFile").mockImplementation(async (...args) => {
        await copyFile(...args);
        if (boundary === "stage" && String(args[1]).endsWith(".restore")) {
          entered.resolve();
          await release.promise;
        }
      });
      const installer = vi.spyOn(fs, "rename").mockImplementation(async (source, destination) => {
        if (String(source).endsWith(recovery ? ".restore" : ".apply")) {
          if (boundary === "rename") {
            entered.resolve();
            await release.promise;
          }
          await rename(source, destination);
          events.push("installed");
          return;
        }
        return rename(source, destination);
      });
      let registrationCount = 0;
      const observer = vi.spyOn(fs, "realpath").mockImplementation(async (...args) => {
        try {
          return await realpath(...args);
        } finally {
          if (events.includes("registering") && [f.before, f.after].includes(String(args[0]))) {
            if (++registrationCount === 2) registered.resolve();
          }
        }
      });
      syncBuiltinESMExports();
      let task: Promise<unknown> | undefined;
      let writers: Promise<unknown>[] = [];
      try {
        task = f.run();
        void task.catch(entered.reject);
        await entered.promise;
        events.push("registering");
        writers = [f.before, f.after].map((target) =>
          withFileMutationQueue(target, async () => {
            events.push(`writer:${target}`);
            await fs.writeFile(target, "queued Pi bytes");
          }),
        );
        await registered.promise;
        release.resolve();
        await task;
        await Promise.all(writers);
        assert.equal(events.filter((event) => event.startsWith("writer:")).length, 2);
        for (const target of [f.before, f.after])
          assert.ok(events.indexOf(`writer:${target}`) > events.indexOf("installed"));
        assert.equal(await fs.readFile(recovery ? f.before : f.after, "utf8"), "queued Pi bytes");
      } finally {
        release.resolve();
        await Promise.allSettled([...(task ? [task] : []), ...writers]);
        installer.mockRestore();
        observer.mockRestore();
        stage.mockRestore();
        restore();
      }
    }));

for (const recovery of [false, true])
  for (const content of ["late Pi bytes", "before", "after"])
    test(`case ${recovery ? "recovery" : "apply"} preserves pre-reservation writer content: ${content}`, async () =>
      withTempHome(async (root) => {
        const f = await caseQueueFixture(root, recovery);
        const restore = await caseInsensitiveLookup(root);
        const rm = vi.mocked(fs.rm).getMockImplementation();
        assert.ok(rm);
        const destination = recovery ? f.before : f.after;
        let injected = false;
        const removal = vi.spyOn(fs, "rm").mockImplementation(async (target, options) => {
          await rm(target, options);
          if (!injected && target === f.before) {
            injected = true;
            await withFileMutationQueue(destination, () => fs.writeFile(destination, content));
          }
        });
        syncBuiltinESMExports();
        try {
          await assert.rejects(f.run(), recovery ? /changed before destination queue/ : /evidence retained/);
          assert.equal(await fs.readFile(destination, "utf8"), content);
          const entries = await fs.readdir(path.join(root, "pi-sync/transactions"));
          assert.equal(entries.length, 1);
          const directory = path.join(root, "pi-sync/transactions", entries[0] as string);
          await fs.access(path.join(directory, "journal.json"));
          assert.equal(await fs.readFile(path.join(directory, "before/0"), "utf8"), "before");
        } finally {
          removal.mockRestore();
          restore();
        }
      }));

for (const recovery of [false, true])
  for (const invalidation of ["abort", "owner"] as const)
    test(`case ${recovery ? "recovery" : "apply"} releases destination reservation after ${invalidation}`, async () =>
      withTempHome(async (root) => {
        const f = await caseQueueFixture(root, recovery);
        const restore = await caseInsensitiveLookup(root);
        const destination = recovery ? f.before : f.after;
        const rm = vi.mocked(fs.rm).getMockImplementation();
        const realpath = vi.mocked(fs.realpath).getMockImplementation();
        assert.ok(rm && realpath);
        const controller = new AbortController();
        let valid = true;
        let injected = false;
        let entered = false;
        let lookups = 0;
        const waiting = deferred();
        const release = deferred();
        let writer: Promise<unknown> | undefined;
        const removal = vi.spyOn(fs, "rm").mockImplementation(async (target, options) => {
          await rm(target, options);
          if (!injected && target === f.before) {
            injected = true;
            writer = withFileMutationQueue(destination, async () => {
              entered = true;
              await release.promise;
              await fs.writeFile(destination, "late queued bytes");
            });
          }
        });
        const observer = vi.spyOn(fs, "realpath").mockImplementation(async (...args) => {
          try {
            return await realpath(...args);
          } finally {
            if (entered && String(args[0]) === destination && ++lookups === 1) waiting.resolve();
          }
        });
        syncBuiltinESMExports();
        const task = f.run({
          signal: controller.signal,
          validateMutation: () => {
            if (!valid) throw new Error("owner replaced");
          },
        });
        const rejected = assert.rejects(task, recovery ? /aborted|owner replaced/i : /cancelled|evidence retained/i);
        try {
          await waiting.promise;
          if (invalidation === "abort") controller.abort();
          else valid = false;
          release.resolve();
          await rejected;
          await writer;
          assert.equal(await fs.readFile(destination, "utf8"), "late queued bytes");
          for (const spelling of [f.before, f.after]) await withFileMutationQueue(spelling, async () => {});
          assert.equal((await fs.readdir(path.join(root, "pi-sync/transactions"))).length, 1);
        } finally {
          release.resolve();
          await Promise.allSettled([task, rejected, ...(writer ? [writer] : [])]);
          removal.mockRestore();
          observer.mockRestore();
          restore();
        }
      }));

test("case-sensitive independent spellings keep separate targets", async ({ skip }) =>
  withTempHome(async (root) => {
    await fs.mkdir(root, { recursive: true });
    const before = path.join(root, "append_system.md");
    const after = path.join(root, "APPEND_SYSTEM.md");
    await fs.writeFile(before, "before");
    // This control requires distinct physical targets; the native alias test covers the other branch.
    const aliases = await fs.realpath(after).then(
      () => true,
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return false;
        throw error;
      },
    );
    if (aliases) skip();
    const plan = { deletes: [before], writes: [{ target: after, content: Buffer.from("after") }] };
    assert.equal((await coalesceCaseReplacements(root, plan)).replacements.size, 0);
    await applySnapshotTransaction(plan);
    assert.equal(await fs.readFile(after, "utf8"), "after");
    await assert.rejects(fs.access(before), { code: "ENOENT" });
  }));

for (const kind of ["symlink", "hardlink", "multiple-writes"] as const)
  test(`case replacement refuses ${kind}`, async () =>
    withTempHome(async (root) => {
      await fs.mkdir(root, { recursive: true });
      const before = path.join(root, "append_system.md");
      const after = path.join(root, "APPEND_SYSTEM.md");
      const other = path.join(root, "other.md");
      await fs.writeFile(other, "before");
      if (kind === "symlink") await fs.symlink(other, before);
      else if (kind === "hardlink") await fs.link(other, before);
      else await fs.writeFile(before, "before");
      const restore = await caseInsensitiveLookup(root);
      try {
        const writes = [{ target: after, content: Buffer.from("after") }];
        if (kind === "multiple-writes") writes.push({ target: after, content: Buffer.from("different") });
        await assert.rejects(applySnapshotTransaction({ deletes: [before], writes }), /Unsafe case|Multiple writes/);
        assert.equal(await fs.readFile(before, "utf8"), "before");
        assert.equal(await fs.readFile(other, "utf8"), "before");
      } finally {
        restore();
      }
    }));
