import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { initializeSync as startSession } from "@narumitw/pi-sync-daemon/engine/sync/initialization";
import { test, vi } from "vitest";
import { createMockContext } from "../../../test/support.js";
import { configuredSessionDir, sessionDirForApply } from "../src/snapshot/session-paths.js";
import { sessionStorageRoot } from "../src/snapshot/snapshot-paths.js";
import {
  prepareSessionRootTransition,
  resolveTransitionSessionRoot,
} from "../src/snapshot/snapshot-root-transition.js";
import { applySnapshotTransaction } from "../src/snapshot/snapshot-transaction.js";
import { fileImage } from "../src/snapshot/snapshot-transaction-plan.js";
import { snapshot, withTempHome } from "./helpers.js";

function defaultContext() {
  const context = createMockContext({ hasUI: false });
  Object.defineProperty((context.ctx as ExtensionContext).sessionManager, "usesDefaultSessionDir", {
    value: () => true,
  });
  return context;
}

for (const home of ["unset", "empty", "present"] as const)
  for (const tilde of ["~", "~/stored"])
    for (const direction of ["default-custom", "custom-default"] as const)
      test(`${home} HOME ${tilde} ${direction} uses canonical apply roots in both transition images`, async () =>
        withTempHome(async (root) => {
          const savedHome = process.env.HOME;
          const fakeHome = path.join(path.dirname(root), "os-home");
          const homedir = vi.spyOn(os, "homedir").mockReturnValue(home === "empty" ? "" : fakeHome);
          if (home === "unset") delete process.env.HOME;
          else process.env.HOME = home === "empty" ? "" : fakeHome;
          try {
            const before = Buffer.from(JSON.stringify(direction === "custom-default" ? { sessionDir: tilde } : {}));
            const after = Buffer.from(JSON.stringify(direction === "default-custom" ? { sessionDir: tilde } : {}));
            const directory = path.join(root, "pi-sync/transactions/evidence");
            await fs.mkdir(path.join(directory, "before"), { recursive: true });
            await fs.writeFile(path.join(directory, "before/0"), before);
            const settings = path.join(root, "settings.json");
            await fs.writeFile(settings, before);
            const ctx = defaultContext().ctx;
            const currentRoot = sessionStorageRoot(root, await configuredSessionDir());
            const destination = sessionStorageRoot(
              root,
              await sessionDirForApply(ctx, snapshot([{ path: "settings.json", content: after }])),
            );
            const target = path.join(destination, "conversation.jsonl");
            const entries = [
              {
                target: settings,
                backupName: "0",
                kind: "file",
                beforeImage: fileImage(before),
                afterImage: fileImage(after),
              },
              {
                target,
                backupName: "1",
                kind: "missing",
                beforeImage: "missing",
                afterImage: fileImage(Buffer.from("session")),
              },
            ];
            // Evidence-only test: never create session files under the real OS home or CWD.
            const transition = await prepareSessionRootTransition(directory, root, destination, entries, {
              deletes: [],
              writes: [
                { target: settings, content: after },
                { target, content: Buffer.from("session") },
              ],
            });
            assert.ok(transition);
            assert.equal(transition.beforeRoot, currentRoot);
            assert.equal(
              await resolveTransitionSessionRoot(directory, root, destination, transition, entries, currentRoot),
              destination,
            );
          } finally {
            homedir.mockRestore();
            if (savedHome === undefined) delete process.env.HOME;
            else process.env.HOME = savedHome;
          }
        }));

for (const direction of ["default-custom", "custom-default"] as const)
  for (const phase of ["prepared", "session"] as const)
    test(`unset HOME ${direction} recovers before settings installation after ${phase}`, async () =>
      withTempHome(async (root) => {
        const savedHome = process.env.HOME;
        delete process.env.HOME;
        const home = path.join(path.dirname(root), "os-home");
        const homedir = vi.spyOn(os, "homedir").mockReturnValue(home);
        const controller = new AbortController();
        const rename = fs.rename.bind(fs);
        let renaming: ReturnType<typeof vi.spyOn> | undefined;
        try {
          const settings = path.join(root, "settings.json");
          await fs.mkdir(root, { recursive: true });
          const before = JSON.stringify(direction === "custom-default" ? { sessionDir: "~/stored" } : {});
          const after = Buffer.from(JSON.stringify(direction === "default-custom" ? { sessionDir: "~/stored" } : {}));
          await fs.writeFile(settings, before);
          const context = defaultContext();
          const sessionDir = await sessionDirForApply(
            context.ctx,
            snapshot([{ path: "settings.json", content: after }]),
          );
          const destination = sessionStorageRoot(root, sessionDir);
          const target = path.join(destination, "conversation.jsonl");
          await fs.mkdir(destination, { recursive: true });
          await fs.writeFile(target, "before-session");
          renaming = vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
            await rename(from, to);
            if ((phase === "prepared" && String(to).endsWith("journal.json")) || (phase === "session" && to === target))
              controller.abort();
          });
          await assert.rejects(
            applySnapshotTransaction(
              {
                deletes: [],
                writes: [
                  { target, content: Buffer.from("after-session") },
                  { target: settings, content: after },
                ],
              },
              { sessionDir, signal: controller.signal },
            ),
            /cancel|abort/i,
          );
          assert.equal(controller.signal.aborted, true);
          renaming.mockRestore();
          await startSession(context.ctx, new AbortController().signal);
          assert.equal(await fs.readFile(settings, "utf8"), before);
          assert.equal(await fs.readFile(target, "utf8"), "before-session");
          assert.deepEqual(await fs.readdir(path.join(root, "pi-sync/transactions")), []);
        } finally {
          renaming?.mockRestore();
          homedir.mockRestore();
          if (savedHome === undefined) delete process.env.HOME;
          else process.env.HOME = savedHome;
        }
      }));

async function deletionFixture(root: string, phase: string, missingSession = false) {
  const settings = path.join(root, "settings.json");
  const oldRoot = path.join(path.dirname(root), "custom-sessions");
  const destination = path.join(root, "sessions");
  await fs.mkdir(destination, { recursive: true });
  const before = JSON.stringify({ sessionDir: oldRoot });
  await fs.writeFile(settings, before);
  const target = path.join(destination, "conversation.jsonl");
  if (!missingSession) await fs.writeFile(target, "before-session");
  const controller = new AbortController();
  const rename = fs.rename.bind(fs);
  const rm = fs.rm.bind(fs);
  const renaming = vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
    await rename(from, to);
    if ((phase === "prepared" && String(to).endsWith("journal.json")) || (phase === "session" && to === target))
      controller.abort();
  });
  const deleting = vi.spyOn(fs, "rm").mockImplementation(async (...args) => {
    if (phase === "completed" && path.dirname(String(args[0])) === path.join(root, "pi-sync/transactions"))
      throw new Error("interrupted completed cleanup");
    await rm(...args);
    if (phase === "deleted" && args[0] === settings) controller.abort();
  });
  try {
    await assert.rejects(
      applySnapshotTransaction(
        { deletes: [settings], writes: [{ target, content: Buffer.from("after-session") }] },
        {
          sessionDir: destination,
          signal: controller.signal,
        },
      ),
      phase === "completed" ? /interrupted completed cleanup/ : /cancel|abort/i,
    );
    assert.equal(controller.signal.aborted, phase !== "completed");
  } finally {
    renaming.mockRestore();
    deleting.mockRestore();
  }
  const transactions = path.join(root, "pi-sync/transactions");
  const names = await fs.readdir(transactions);
  assert.equal(names.length, 1);
  const journalFile = path.join(transactions, names[0] ?? "", "journal.json");
  const journal = JSON.parse(await fs.readFile(journalFile, "utf8"));
  return { settings, target, before, destination, oldRoot, transactions, journalFile, journal };
}

for (const phase of ["prepared", "deleted", "session"])
  test(`settings deletion restores the reviewed transition interrupted after ${phase}`, async () =>
    withTempHome(async (root) => {
      const f = await deletionFixture(root, phase);
      await startSession(defaultContext().ctx, new AbortController().signal);
      if (phase === "prepared") {
        assert.equal(f.journal.version, 7);
        assert.equal(f.journal.sessionRootTransition.settingsAfterBase64, null);
        assert.equal(f.journal.sessionRootTransition.beforeRoot, f.oldRoot);
      }
      assert.equal(await fs.readFile(f.settings, "utf8"), f.before);
      assert.equal(await fs.readFile(f.target, "utf8"), "before-session");
      assert.deepEqual(await fs.readdir(f.transactions), []);
    }));

for (const phase of ["prepared", "deleted", "session"])
  test(`settings deletion with missing session preimage recovers after ${phase}`, async () =>
    withTempHome(async (root) => {
      const f = await deletionFixture(root, phase, true);
      await startSession(defaultContext().ctx, new AbortController().signal);
      assert.equal(await fs.readFile(f.settings, "utf8"), f.before);
      await assert.rejects(fs.access(f.target), { code: "ENOENT" });
      assert.deepEqual(await fs.readdir(f.transactions), []);
    }));

test("completed missing-settings transition resumes cleanup without restoring newer targets", async () =>
  withTempHome(async (root) => {
    const f = await deletionFixture(root, "completed");
    assert.equal(f.journal.completed, true);
    assert.equal(f.journal.version, 7);
    assert.equal(f.journal.sessionRootTransition.settingsAfterBase64, null);
    await fs.rm(path.join(path.dirname(f.journalFile), "before"), { recursive: true });
    await fs.writeFile(f.settings, "invalid newer settings sentinel");
    await fs.writeFile(f.target, "newer-session");
    await startSession(defaultContext().ctx, new AbortController().signal);
    assert.equal(await fs.readFile(f.settings, "utf8"), "invalid newer settings sentinel");
    assert.equal(await fs.readFile(f.target, "utf8"), "newer-session");
    assert.deepEqual(await fs.readdir(f.transactions), []);
  }));

for (const invalid of ["empty-postimage", "mismatched-hash", "unrelated-root", "newer-settings"])
  test(`settings deletion refuses ${invalid} without changing any target`, async () =>
    withTempHome(async (root) => {
      const f = await deletionFixture(root, "session");
      assert.ok(f.journal.sessionRootTransition);
      if (invalid === "empty-postimage") f.journal.sessionRootTransition.settingsAfterBase64 = "";
      if (invalid === "mismatched-hash")
        f.journal.entries.find((entry: { target: string }) => entry.target === f.settings).afterImage = fileImage(
          Buffer.from("{}"),
        );
      if (invalid === "unrelated-root")
        await fs.writeFile(f.settings, JSON.stringify({ sessionDir: path.join(root, "unrelated") }));
      if (invalid === "newer-settings")
        await fs.writeFile(f.settings, JSON.stringify({ sessionDir: f.oldRoot, newer: true }));
      await fs.writeFile(f.journalFile, JSON.stringify(f.journal));
      const settings = await fs.readFile(f.settings).catch(() => undefined);
      await assert.rejects(startSession(defaultContext().ctx, new AbortController().signal));
      assert.equal(await fs.readFile(f.target, "utf8"), "after-session");
      assert.deepEqual(await fs.readFile(f.settings).catch(() => undefined), settings);
      await fs.access(f.journalFile);
    }));

test("large reviewed settings postimage is private sidecar evidence, not journal payload", async () =>
  withTempHome(async (root) => {
    const directory = path.join(root, "pi-sync/transactions/large");
    const settings = path.join(root, "settings.json");
    const destination = path.join(path.dirname(root), "new-root");
    const before = Buffer.from("{}");
    const after = Buffer.from(JSON.stringify({ sessionDir: destination, padding: "x".repeat(25 * 1024 * 1024) }));
    await fs.mkdir(path.join(directory, "before"), { recursive: true });
    await fs.writeFile(path.join(directory, "before/0"), before);
    const entries = [
      { target: settings, backupName: "0", kind: "file", beforeImage: fileImage(before), afterImage: fileImage(after) },
      {
        target: path.join(destination, "session.jsonl"),
        backupName: "1",
        kind: "missing",
        beforeImage: "missing",
        afterImage: fileImage(Buffer.from("session")),
      },
    ];
    const transition = await prepareSessionRootTransition(directory, root, destination, entries, {
      deletes: [],
      writes: [{ target: settings, content: after }],
    });
    assert.ok(transition);
    assert.ok(JSON.stringify(transition).length < 1024);
    assert.equal(transition.settingsAfterFile, true);
    assert.equal(transition.settingsAfterBase64, undefined);
    const sidecar = path.join(directory, "settings-after");
    assert.deepEqual(await fs.readFile(sidecar), after);
    if (process.platform !== "win32") assert.equal((await fs.stat(sidecar)).mode & 0o077, 0);
    assert.equal(
      await resolveTransitionSessionRoot(
        directory,
        root,
        destination,
        transition,
        entries,
        path.join(root, "sessions"),
      ),
      destination,
    );
    await fs.writeFile(sidecar, "{}");
    await assert.rejects(
      resolveTransitionSessionRoot(directory, root, destination, transition, entries, path.join(root, "sessions")),
      /Inconsistent/,
    );
  }));
