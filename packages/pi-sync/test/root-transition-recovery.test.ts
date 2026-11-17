import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { initializeSync as startSession } from "@narumitw/pi-sync-daemon/engine/sync/initialization";
import { test, vi } from "vitest";
import { createMockContext } from "../../../test/support.js";
import {
  applySnapshotTransaction,
  recoverSnapshotTransactionsOnStartup,
} from "../src/snapshot/snapshot-transaction.js";
import { withTempHome } from "./helpers.js";

async function interrupted(agentDir: string, direction: string, phase: string, missingSettings = false) {
  const oldRoot =
    direction === "default-custom" ? path.join(agentDir, "sessions") : path.join(path.dirname(agentDir), "old");
  const newRoot =
    direction === "custom-default" ? path.join(agentDir, "sessions") : path.join(path.dirname(agentDir), "new");
  await fs.mkdir(agentDir, { recursive: true });
  await fs.mkdir(newRoot, { recursive: true });
  const settings = path.join(agentDir, "settings.json");
  const before = JSON.stringify(direction === "default-custom" ? {} : { sessionDir: oldRoot });
  const after = JSON.stringify(direction === "custom-default" ? {} : { sessionDir: newRoot });
  if (!missingSettings) await fs.writeFile(settings, before);
  const target = path.join(newRoot, "conversation.jsonl");
  await fs.writeFile(target, "before-session");
  const controller = new AbortController();
  const rename = fs.rename.bind(fs);
  const spy = vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
    await rename(from, to);
    if (
      (phase === "prepared" && String(to).endsWith("journal.json")) ||
      (phase === "session" && to === target) ||
      (phase === "settings" && to === settings)
    )
      controller.abort();
  });
  try {
    await assert.rejects(
      applySnapshotTransaction(
        {
          deletes: [],
          writes: [
            { target, content: Buffer.from("after-session") },
            { target: settings, content: Buffer.from(after) },
          ],
        },
        { sessionDir: direction === "custom-default" ? undefined : newRoot, signal: controller.signal },
      ),
    );
  } finally {
    spy.mockRestore();
  }
  const transactions = path.join(agentDir, "pi-sync/transactions");
  const names = await fs.readdir(transactions);
  assert.equal(names.length, 1);
  const journalFile = path.join(transactions, names[0] ?? "", "journal.json");
  const journal = JSON.parse(await fs.readFile(journalFile, "utf8"));
  const context = createMockContext({ hasUI: false });
  Object.defineProperty((context.ctx as ExtensionContext).sessionManager, "usesDefaultSessionDir", {
    value: () => true,
    configurable: true,
  });
  return { target, settings, before, after, journalFile, journal, transactions, context, oldRoot, newRoot };
}

for (const direction of ["default-custom", "custom-custom", "custom-default"])
  for (const phase of ["prepared", "session", "settings"])
    test(`${direction} restores reviewed transition interrupted after ${phase}`, async () =>
      withTempHome(async (agentDir) => {
        const f = await interrupted(agentDir, direction, phase);
        await startSession(f.context.ctx, new AbortController().signal);
        assert.equal(await fs.readFile(f.settings, "utf8"), f.before);
        assert.equal(await fs.readFile(f.target, "utf8"), "before-session");
        assert.deepEqual(await fs.readdir(f.transactions), []);
      }));

for (const refusal of [
  "unrelated-root",
  "newer-settings",
  "protected-session",
  "corrupt-backup",
  "wrong-after-root",
  "legacy-version",
  "wrong-before-root",
  "different-manager",
])
  test(`root transition retains evidence for ${refusal}`, async () =>
    withTempHome(async (agentDir) => {
      const f = await interrupted(agentDir, "custom-custom", "session");
      if (refusal === "unrelated-root")
        await fs.writeFile(f.settings, JSON.stringify({ sessionDir: path.join(agentDir, "unrelated") }));
      if (refusal === "newer-settings")
        await fs.writeFile(f.settings, JSON.stringify({ sessionDir: f.oldRoot, newer: true }));
      if (refusal === "protected-session")
        Object.defineProperty((f.context.ctx as ExtensionContext).sessionManager, "getSessionFile", {
          value: () => f.target,
        });
      if (refusal === "corrupt-backup") {
        const entry = f.journal.entries.find((item: { target: string }) => item.target === f.settings);
        await fs.writeFile(path.join(path.dirname(f.journalFile), "before", entry.backupName), "corrupt");
      }
      if (refusal === "wrong-after-root")
        f.journal.sessionRootTransition.settingsAfterBase64 = Buffer.from("{}").toString("base64");
      if (refusal === "legacy-version") f.journal.version = 4;
      if (refusal === "wrong-before-root") f.journal.sessionRootTransition.beforeRoot = f.newRoot;
      if (refusal === "different-manager") {
        Object.defineProperty((f.context.ctx as ExtensionContext).sessionManager, "getSessionDir", {
          value: () => path.join(agentDir, "unrelated-manager"),
        });
        Object.defineProperty((f.context.ctx as ExtensionContext).sessionManager, "usesDefaultSessionDir", {
          value: () => false,
        });
      }
      if (["wrong-after-root", "legacy-version", "wrong-before-root"].includes(refusal))
        await fs.writeFile(f.journalFile, JSON.stringify(f.journal));
      const settings = await fs.readFile(f.settings);
      await assert.rejects(startSession(f.context.ctx, new AbortController().signal));
      assert.equal(await fs.readFile(f.target, "utf8"), "after-session");
      assert.deepEqual(await fs.readFile(f.settings), settings);
      await fs.access(f.journalFile);
    }));

for (const boundary of ["stat", "read"] as const)
  for (const cancellation of ["abort", "owner"] as const)
    test(`transition evidence ${boundary} revalidates ${cancellation} before restoration`, async () =>
      withTempHome(async (agentDir) => {
        const f = await interrupted(agentDir, "custom-custom", "session");
        const entry = f.journal.entries.find((item: { target: string }) => item.target === f.settings);
        const backup = path.join(path.dirname(f.journalFile), "before", entry.backupName);
        const controller = new AbortController();
        let owned = true;
        const cancel = () => {
          if (cancellation === "abort") controller.abort();
          else owned = false;
        };
        const lstat = fs.lstat.bind(fs);
        const readFile = fs.readFile.bind(fs);
        const stat = vi.spyOn(fs, "lstat").mockImplementation(async (...args) => {
          const result = await lstat(...args);
          if (boundary === "stat" && args[0] === backup) cancel();
          return result;
        });
        const read = vi.spyOn(fs, "readFile").mockImplementation(async (...args) => {
          const result = await readFile(...args);
          if (boundary === "read" && args[0] === backup) cancel();
          return result;
        });
        try {
          await assert.rejects(
            recoverSnapshotTransactionsOnStartup({
              signal: controller.signal,
              validateMutation: () => {
                if (!owned) throw new Error("replacement owner");
              },
            }),
          );
          assert.equal(await fs.readFile(f.target, "utf8"), "after-session");
          assert.equal(await fs.readFile(f.settings, "utf8"), f.before);
          await fs.access(f.journalFile);
        } finally {
          stat.mockRestore();
          read.mockRestore();
        }
      }));

test("absent default settings preimage authorizes the reviewed destination only", async () =>
  withTempHome(async (agentDir) => {
    const f = await interrupted(agentDir, "default-custom", "prepared", true);
    await startSession(f.context.ctx, new AbortController().signal);
    await assert.rejects(fs.access(f.settings), { code: "ENOENT" });
    assert.equal(await fs.readFile(f.target, "utf8"), "before-session");
    assert.deepEqual(await fs.readdir(f.transactions), []);
  }));

test("completed version-7 transition permits cleanup only without remaining backup or root authorization", async () =>
  withTempHome(async (agentDir) => {
    const f = await interrupted(agentDir, "custom-custom", "prepared");
    await startSession(f.context.ctx, new AbortController().signal);
    const rm = fs.rm.bind(fs);
    const cleanup = vi.spyOn(fs, "rm").mockImplementation(async (...args) => {
      if (path.dirname(String(args[0])) === f.transactions) throw new Error("interrupted completed cleanup");
      return rm(...args);
    });
    try {
      await assert.rejects(
        applySnapshotTransaction(
          {
            deletes: [],
            writes: [
              { target: f.target, content: Buffer.from("after-session") },
              { target: f.settings, content: Buffer.from(f.after) },
            ],
          },
          { sessionDir: f.newRoot },
        ),
        /interrupted completed cleanup/,
      );
    } finally {
      cleanup.mockRestore();
    }
    const names = await fs.readdir(f.transactions);
    assert.equal(names.length, 1);
    const directory = path.join(f.transactions, names[0] ?? "");
    const journal = JSON.parse(await fs.readFile(path.join(directory, "journal.json"), "utf8"));
    assert.equal(journal.version, 7);
    assert.equal(journal.completed, true);
    await fs.rm(path.join(directory, "before"), { recursive: true });
    await fs.writeFile(f.target, "newer-session");
    await fs.writeFile(f.settings, "invalid settings sentinel");
    await startSession(f.context.ctx, new AbortController().signal);
    assert.equal(await fs.readFile(f.target, "utf8"), "newer-session");
    assert.equal(await fs.readFile(f.settings, "utf8"), "invalid settings sentinel");
    assert.deepEqual(await fs.readdir(f.transactions), []);
  }));
