import assert from "node:assert/strict";
import type { BigIntStats } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test, vi } from "vitest";
import { configureEngineHost } from "../src/engine/host.js";
import { installedVacancyIdentityMatches } from "../src/engine/snapshot/snapshot-transaction-images.js";
import { fileImage } from "../src/engine/snapshot/snapshot-transaction-plan.js";
import {
  AGENT_DIRECTORY_JOURNAL_VERSION,
  type TransactionEntry,
  type TransactionJournal,
} from "../src/engine/snapshot/snapshot-transaction-policy.js";
import { verifyTarget } from "../src/engine/snapshot/snapshot-transaction-verification.js";
import { selectionForSnapshot } from "../src/engine/sync/sync-policy.js";

const oldBytes = Buffer.from("reviewed file");

for (const platform of ["win32", "linux"] as const) {
  test(`installed vacancy birth-time matching is limited to Windows files (${platform})`, () => {
    const descriptor = Object.getOwnPropertyDescriptor(process, "platform");
    assert.ok(descriptor);
    Object.defineProperty(process, "platform", { value: platform });
    try {
      const stat = { dev: 12n, ino: 34n, birthtimeNs: 56n } as BigIntStats;
      const file = { kind: "file" as const, value: fileImage(oldBytes), stat };
      assert.equal(installedVacancyIdentityMatches(file, "12:34:56"), true);
      assert.equal(installedVacancyIdentityMatches(file, "12:34:78"), platform === "win32");
      for (const expected of ["13:34:78", "12:35:78", "12:34", "12:34:78:90", "bad"])
        assert.equal(installedVacancyIdentityMatches(file, expected), false);
      assert.equal(installedVacancyIdentityMatches({ ...file, stat: { ...stat, ino: 0n } }, "12:0:78"), false);
      assert.equal(
        installedVacancyIdentityMatches({ kind: "directory", value: "directory:test", stat, children: [] }, "12:34:78"),
        false,
      );
      assert.equal(installedVacancyIdentityMatches({ kind: "missing", value: "missing" }, "12:34:78"), false);
    } finally {
      Object.defineProperty(process, "platform", descriptor);
    }
  });
}

for (const change of ["cancelled", "owner replaced"] as const) {
  test(`installed vacancy revalidates ${change} during the fallback directory read`, async () => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "pi-sync-vacancy-identity-")));
    const descriptor = Object.getOwnPropertyDescriptor(process, "platform");
    assert.ok(descriptor);
    configureEngineHost({ root: () => root, mutate: async (_target, action) => action(), review: async () => true });
    try {
      const directory = path.join(root, "recovery");
      const target = path.join(root, "notes.md");
      await fs.mkdir(path.join(directory, "before"), { recursive: true });
      await fs.writeFile(target, oldBytes);
      await fs.writeFile(path.join(directory, "before", "0"), oldBytes);
      const stat = await fs.lstat(target, { bigint: true });
      const entry: TransactionEntry = {
        target,
        backupName: "0",
        kind: "file",
        beforeImage: fileImage(oldBytes),
        afterImage: "missing",
        postFiles: [],
        vacantInstall: `${stat.dev}:${stat.ino}:${stat.birthtimeNs + 1n}`,
      };
      const selection = { scope: "agent-directory" as const, sessionDir: path.join(root, "sessions") };
      const journal: TransactionJournal = {
        version: AGENT_DIRECTORY_JOURNAL_VERSION,
        root,
        sessionRoot: selection.sessionDir,
        selection: selectionForSnapshot([], undefined, selection),
        entries: [entry],
      };
      const controller = new AbortController();
      const failure = new Error(change);
      let current = true;
      let observed = false;
      const readdir = fs.readdir.bind(fs);
      vi.spyOn(fs, "readdir").mockImplementation((async (...args: unknown[]) => {
        const names = await Reflect.apply(readdir, fs, args);
        if (args[0] === root && args.length === 1) {
          observed = true;
          if (change === "cancelled") controller.abort(failure);
          else current = false;
        }
        return names;
      }) as typeof fs.readdir);
      Object.defineProperty(process, "platform", { value: "win32" });
      await assert.rejects(
        verifyTarget(directory, entry, journal, {
          ...selection,
          signal: controller.signal,
          validateMutation: () => {
            if (!current) throw failure;
          },
        }),
        (error) => error === failure,
      );
      assert.equal(observed, true);
      assert.deepEqual(await fs.readFile(target), oldBytes);
    } finally {
      Object.defineProperty(process, "platform", descriptor);
      vi.restoreAllMocks();
      await fs.rm(root, { recursive: true, force: true });
    }
  });
}
