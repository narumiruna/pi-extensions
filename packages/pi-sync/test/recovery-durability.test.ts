import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { initializeSync as startSession } from "@narumitw/pi-sync-daemon/engine/sync/initialization";
import { test, vi } from "vitest";
import { createMockContext } from "../../../test/support.js";
import { applySnapshotTransaction, recoverPendingSnapshotTransactions } from "../src/snapshot/snapshot-transaction.js";
import { withTempHome } from "./helpers.js";

const fileImage = (value: string) => `file:${createHash("sha256").update(value).digest("hex")}`;
const directoryImage = (value: string) =>
  `directory:${createHash("sha256")
    .update(JSON.stringify([["old.md", fileImage(value)]]))
    .digest("hex")}`;

for (const mode of ["default-manager", "explicit-manager", "different-manager", "protected-session"] as const)
  test(`startup recovery resolves the effective session root: ${mode}`, async () =>
    withTempHome(async (agentDir) => {
      const sessionRoot = path.join(path.dirname(agentDir), "configured-sessions");
      const otherRoot = path.join(path.dirname(agentDir), "other-sessions");
      await fs.mkdir(sessionRoot, { recursive: true });
      await fs.mkdir(agentDir, { recursive: true });
      await fs.writeFile(path.join(agentDir, "settings.json"), JSON.stringify({ sessionDir: sessionRoot }));
      const target = path.join(sessionRoot, "conversation.jsonl");
      const directory = path.join(agentDir, "pi-sync/transactions/interrupted");
      await fs.mkdir(path.join(directory, "before"), { recursive: true });
      await fs.writeFile(path.join(directory, "before/0"), "before");
      await fs.writeFile(target, "after");
      await fs.writeFile(
        path.join(directory, "journal.json"),
        JSON.stringify({
          version: 2,
          root: agentDir,
          sessionRoot,
          entries: [
            {
              target,
              backupName: "0",
              kind: "file",
              beforeImage: fileImage("before"),
              afterImage: fileImage("after"),
              postFiles: [],
            },
          ],
        }),
      );
      const context = createMockContext({ hasUI: false });
      Object.defineProperties((context.ctx as ExtensionContext).sessionManager, {
        usesDefaultSessionDir: { value: () => mode === "default-manager" || mode === "protected-session" },
        getSessionDir: {
          value: () =>
            mode === "different-manager"
              ? otherRoot
              : mode === "explicit-manager"
                ? sessionRoot
                : path.join(agentDir, "sessions"),
        },
        getSessionFile: { value: () => (mode === "protected-session" ? target : undefined) },
      });
      const recovery = startSession(context.ctx, new AbortController().signal);
      if (mode === "different-manager" || mode === "protected-session") {
        await assert.rejects(recovery, mode === "different-manager" ? /not owned/ : /current session/);
        assert.equal(await fs.readFile(target, "utf8"), "after");
        await fs.access(directory);
      } else {
        await recovery;
        assert.equal(await fs.readFile(target, "utf8"), "before");
        await assert.rejects(fs.access(directory), { code: "ENOENT" });
      }
    }));

for (const pinnedRoot of ["absent", "default", "custom"] as const)
  test(`startup restores invalid settings postimage without session targets (pinned root: ${pinnedRoot})`, async () =>
    withTempHome(async (agentDir) => {
      const target = path.join(agentDir, "settings.json");
      const before = '{"theme":"safe"}';
      const after = '{"sessionDir":true}';
      const directory = path.join(agentDir, "pi-sync/transactions/interrupted");
      await fs.mkdir(path.join(directory, "before"), { recursive: true });
      await fs.writeFile(path.join(directory, "before/0"), before);
      await fs.writeFile(target, after);
      await fs.writeFile(
        path.join(directory, "journal.json"),
        JSON.stringify({
          version: 2,
          root: agentDir,
          ...(pinnedRoot === "absent"
            ? {}
            : {
                sessionRoot:
                  pinnedRoot === "default"
                    ? path.join(agentDir, "sessions")
                    : path.join(path.dirname(agentDir), "custom-sessions"),
              }),
          entries: [
            {
              target,
              backupName: "0",
              kind: "file",
              beforeImage: fileImage(before),
              afterImage: fileImage(after),
              postFiles: [],
            },
          ],
        }),
      );
      const context = createMockContext({ hasUI: false });
      await startSession(context.ctx, new AbortController().signal);
      assert.equal(await fs.readFile(target, "utf8"), before);
      await assert.rejects(fs.access(directory), { code: "ENOENT" });
    }));

for (const storage of ["external", "nested-agent"] as const)
  test(`startup with ${storage} session targets refuses invalid settings and retains all evidence`, async () =>
    withTempHome(async (agentDir) => {
      const sessionRoot = path.join(storage === "external" ? path.dirname(agentDir) : agentDir, "custom-sessions");
      const target = path.join(sessionRoot, "conversation.jsonl");
      const directory = path.join(agentDir, "pi-sync/transactions/interrupted");
      await fs.mkdir(path.join(directory, "before"), { recursive: true });
      await fs.mkdir(sessionRoot, { recursive: true });
      await fs.writeFile(path.join(agentDir, "settings.json"), '{"sessionDir":true}');
      await fs.writeFile(path.join(directory, "before/0"), "before");
      await fs.writeFile(target, "after");
      await fs.writeFile(
        path.join(directory, "journal.json"),
        JSON.stringify({
          version: 2,
          root: agentDir,
          sessionRoot,
          entries: [
            {
              target,
              backupName: "0",
              kind: "file",
              beforeImage: fileImage("before"),
              afterImage: fileImage("after"),
              postFiles: [],
            },
          ],
        }),
      );
      const context = createMockContext({ hasUI: false });
      await assert.rejects(startSession(context.ctx, new AbortController().signal), { name: "TypeError" });
      assert.equal(await fs.readFile(target, "utf8"), "after");
      assert.equal(await fs.readFile(path.join(directory, "before/0"), "utf8"), "before");
      await fs.access(path.join(directory, "journal.json"));
    }));

test("startup without recovery does not parse unrelated Pi settings", async () =>
  withTempHome(async (agentDir) => {
    await fs.mkdir(agentDir, { recursive: true });
    await fs.writeFile(path.join(agentDir, "settings.json"), "invalid settings sentinel");
    const context = createMockContext({ hasUI: false });
    await startSession(context.ctx, new AbortController().signal);
    await assert.rejects(fs.access(path.join(agentDir, "pi-sync")), { code: "ENOENT" });
  }));

for (const fail of [false, true])
  test.skipIf(process.platform === "win32")(
    `backup directory fsync ${fail ? "failure prevents mutation" : "precedes journal publication"}`,
    async () =>
      withTempHome(async (agentDir) => {
        await fs.mkdir(agentDir, { recursive: true });
        const target = path.join(agentDir, "AGENTS.md");
        await fs.writeFile(target, "before");
        const open = fs.open.bind(fs);
        const rename = fs.rename.bind(fs);
        let synced = false;
        let published = false;
        const syncSpies: ReturnType<typeof vi.spyOn>[] = [];
        const openSpy = vi.spyOn(fs, "open").mockImplementation(async (...args) => {
          const handle = await open(...args);
          if (String(args[0]).endsWith(`${path.sep}before`) && args[1] === "r") {
            const sync = handle.sync.bind(handle);
            syncSpies.push(
              vi.spyOn(handle, "sync").mockImplementation(async () => {
                if (fail) throw new Error("injected backup directory fsync failure");
                await sync();
                synced = true;
              }),
            );
          }
          return handle;
        });
        const renameSpy = vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
          if (String(to).endsWith("journal.json")) {
            assert.equal(synced, true);
            published = true;
          }
          return rename(from, to);
        });
        try {
          const applied = applySnapshotTransaction({
            deletes: [],
            writes: [{ target, content: Buffer.from("after") }],
          });
          if (fail) {
            await assert.rejects(applied, /backup directory fsync/);
            assert.equal(published, false);
            assert.equal(await fs.readFile(target, "utf8"), "before");
          } else {
            await applied;
            assert.equal(published, true);
            assert.equal(await fs.readFile(target, "utf8"), "after");
          }
        } finally {
          openSpy.mockRestore();
          renameSpy.mockRestore();
          for (const spy of syncSpies) spy.mockRestore();
        }
      }),
  );

for (const preimage of ["file", "directory"] as const)
  for (const newer of [false, true])
    test(`${preimage} replacement recovers durable deletion intent${newer ? " without overwriting newer bytes" : " after interruption"}`, async () =>
      withTempHome(async (agentDir) => {
        await fs.mkdir(agentDir, { recursive: true });
        const target = path.join(agentDir, "custom");
        if (preimage === "file") await fs.writeFile(target, "before");
        else {
          await fs.mkdir(target);
          await fs.writeFile(path.join(target, "old.md"), "before");
        }
        const controller = new AbortController();
        const rm = fs.rm.bind(fs);
        const spy = vi.spyOn(fs, "rm").mockImplementation(async (...args) => {
          await rm(...args);
          if (args[0] === target) controller.abort();
        });
        try {
          await assert.rejects(
            applySnapshotTransaction(
              {
                deletes: preimage === "directory" ? [target, path.join(target, "old.md")] : [target],
                writes: [
                  {
                    target: preimage === "directory" ? target : path.join(target, "new.md"),
                    content: Buffer.from("after"),
                  },
                ],
              },
              { signal: controller.signal },
            ),
            /cancelled/,
          );
        } finally {
          spy.mockRestore();
        }
        const transactions = path.join(agentDir, "pi-sync/transactions");
        const entries = await fs.readdir(transactions);
        assert.equal(entries.length, 1);
        const journalFile = path.join(transactions, entries[0] ?? "", "journal.json");
        const journal = JSON.parse(await fs.readFile(journalFile, "utf8"));
        assert.equal(journal.version, 4);
        assert.ok(journal.entries.every((entry: { removalPending?: boolean }) => entry.removalPending));
        await assert.rejects(fs.access(target), { code: "ENOENT" });
        if (newer) {
          await fs.writeFile(target, "newer external bytes");
          await assert.rejects(recoverPendingSnapshotTransactions(), /newer bytes/);
          assert.equal(await fs.readFile(target, "utf8"), "newer external bytes");
          await fs.access(journalFile);
        } else {
          await recoverPendingSnapshotTransactions();
          assert.equal(await fs.readFile(preimage === "file" ? target : path.join(target, "old.md"), "utf8"), "before");
          assert.deepEqual(await fs.readdir(transactions), []);
        }
      }));

test("directory-to-file rename failure retains ambiguous evidence for review", async () =>
  withTempHome(async (agentDir) => {
    const target = path.join(agentDir, "custom");
    const child = path.join(target, "old.md");
    await fs.mkdir(target, { recursive: true });
    await fs.writeFile(child, "before");
    const rename = fs.rename.bind(fs);
    const spy = vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
      if (to === target && String(from).endsWith(".apply")) throw new Error("injected directory replacement failure");
      return rename(from, to);
    });
    try {
      await assert.rejects(
        applySnapshotTransaction({ deletes: [target, child], writes: [{ target, content: Buffer.from("after") }] }),
        /guarded recovery requires review/,
      );
      await assert.rejects(fs.access(target), { code: "ENOENT" });
      const transactions = path.join(agentDir, "pi-sync/transactions");
      const entries = await fs.readdir(transactions);
      assert.equal(entries.length, 1);
      assert.equal(await fs.readFile(path.join(transactions, entries[0] ?? "", "before/0/old.md"), "utf8"), "before");
      await assert.rejects(recoverPendingSnapshotTransactions(), /newer bytes/);
    } finally {
      spy.mockRestore();
    }
  }));

async function directoryRecoveryFixture(agentDir: string) {
  const directory = path.join(agentDir, "pi-sync/transactions/interrupted");
  const target = path.join(agentDir, "custom");
  await fs.mkdir(path.join(directory, "before/0"), { recursive: true });
  await fs.writeFile(path.join(directory, "before/0/old.md"), "before");
  await fs.writeFile(target, "after");
  await fs.writeFile(
    path.join(directory, "journal.json"),
    JSON.stringify({
      version: 2,
      root: agentDir,
      entries: [
        {
          target,
          backupName: "0",
          kind: "directory",
          beforeImage: directoryImage("before"),
          afterImage: fileImage("after"),
          postFiles: [],
        },
      ],
    }),
  );
  return { directory, target };
}

for (const failure of ["copy", "rename", "cancel", "newer"] as const)
  test(`staged directory restoration preserves recovery on ${failure}`, async () =>
    withTempHome(async (agentDir) => {
      const f = await directoryRecoveryFixture(agentDir);
      const cp = fs.cp.bind(fs);
      const rename = fs.rename.bind(fs);
      const controller = new AbortController();
      let injected = false;
      const cpSpy = vi.spyOn(fs, "cp").mockImplementation(async (...args) => {
        // Includes the old unsafe implementation so the regression fails against direct live copies.
        if (!injected && args[0] === path.join(f.directory, "before/0")) {
          injected = true;
          if (failure === "copy") {
            await fs.mkdir(args[1], { recursive: true });
            await fs.writeFile(path.join(String(args[1]), "partial.md"), "partial");
            throw new Error("injected partial directory copy");
          }
          await cp(...args);
          if (failure === "cancel") controller.abort();
          if (failure === "newer") await fs.writeFile(f.target, "newer external bytes");
          return;
        }
        return cp(...args);
      });
      const renameSpy = vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
        if (failure === "rename" && to === f.target) throw new Error("injected staged rename failure");
        return rename(from, to);
      });
      try {
        await assert.rejects(recoverPendingSnapshotTransactions({ signal: controller.signal }));
        assert.equal(injected, true);
        if (failure === "rename") await assert.rejects(fs.access(f.target), { code: "ENOENT" });
        else assert.equal(await fs.readFile(f.target, "utf8"), failure === "newer" ? "newer external bytes" : "after");
        await fs.access(path.join(f.directory, "journal.json"));
        assert.equal(await fs.readFile(path.join(f.directory, "before/0/old.md"), "utf8"), "before");
        assert.ok((await fs.readdir(agentDir)).every((name) => !name.endsWith(".restore-tree")));
      } finally {
        cpSpy.mockRestore();
        renameSpy.mockRestore();
      }
      if (failure === "rename") {
        await assert.rejects(recoverPendingSnapshotTransactions(), /newer bytes/);
        await assert.rejects(fs.access(f.target), { code: "ENOENT" });
        await fs.access(f.directory);
      } else if (failure !== "newer") {
        await recoverPendingSnapshotTransactions();
        assert.equal(await fs.readFile(path.join(f.target, "old.md"), "utf8"), "before");
        await assert.rejects(fs.access(f.directory), { code: "ENOENT" });
      }
    }));

test("explicit manager root authorizes recovery without a settings-derived match", async () =>
  withTempHome(async (root) => {
    const sessionRoot = path.join(path.dirname(root), "explicit-manager");
    const target = path.join(sessionRoot, "session.jsonl");
    await fs.mkdir(sessionRoot, { recursive: true });
    await fs.mkdir(root, { recursive: true });
    await fs.writeFile(path.join(root, "settings.json"), "{}");
    await fs.writeFile(target, "before");
    const controller = new AbortController();
    const rename = fs.rename.bind(fs);
    const spy = vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
      await rename(from, to);
      if (to === target) controller.abort();
    });
    try {
      await assert.rejects(
        applySnapshotTransaction(
          {
            writes: [{ target, content: Buffer.from("after") }],
            deletes: [],
          },
          { sessionDir: sessionRoot, signal: controller.signal },
        ),
      );
    } finally {
      spy.mockRestore();
    }
    const context = createMockContext({ hasUI: false });
    Object.defineProperties((context.ctx as ExtensionContext).sessionManager, {
      usesDefaultSessionDir: { value: () => false },
      getSessionDir: { value: () => sessionRoot },
    });
    await startSession(context.ctx, new AbortController().signal);
    assert.equal(await fs.readFile(target, "utf8"), "before");
    assert.deepEqual(await fs.readdir(path.join(root, "pi-sync/transactions")), []);
  }));

for (const copied of [false, true])
  test(`restart removes ${copied ? "complete" : "partial"} recovery staging left by a crash`, async () =>
    withTempHome(async (root) => {
      const f = await directoryRecoveryFixture(root);
      const cp = fs.cp.bind(fs);
      const rm = fs.rm.bind(fs);
      let staged = "";
      const copying = vi.spyOn(fs, "cp").mockImplementation(async (...args) => {
        staged = String(args[1]);
        const journal = JSON.parse(await fs.readFile(path.join(f.directory, "journal.json"), "utf8"));
        assert.equal(journal.entries[0].recoveryStaged, true);
        if (copied) await cp(...args);
        else {
          await fs.mkdir(staged);
          await fs.writeFile(path.join(staged, "partial.md"), "private partial copy");
        }
        throw new Error("simulated process crash");
      });
      const cleanup = vi.spyOn(fs, "rm").mockImplementation(async (...args) => {
        if (String(args[0]) !== staged) await rm(...args);
      });
      try {
        await assert.rejects(recoverPendingSnapshotTransactions(), /simulated process crash/);
      } finally {
        copying.mockRestore();
        cleanup.mockRestore();
      }
      await fs.access(staged);
      assert.equal(await fs.readFile(f.target, "utf8"), "after");
      await recoverPendingSnapshotTransactions();
      assert.equal(await fs.readFile(path.join(f.target, "old.md"), "utf8"), "before");
      await assert.rejects(fs.access(staged), { code: "ENOENT" });
      await assert.rejects(fs.access(f.directory), { code: "ENOENT" });
    }));
