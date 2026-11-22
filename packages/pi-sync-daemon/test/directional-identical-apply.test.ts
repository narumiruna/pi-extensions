import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test, vi } from "vitest";
import { configureEngineHost } from "../src/engine/host.js";
import { createSnapshot } from "../src/engine/snapshot/snapshot.js";
import { applySnapshot } from "../src/engine/snapshot/snapshot-apply.js";
import { recoverPendingSnapshotTransactions } from "../src/engine/snapshot/snapshot-transaction.js";
import { pendingTransactionEntries, transactionRoot } from "../src/engine/snapshot/snapshot-transaction-directory.js";
import type { TransactionJournal } from "../src/engine/snapshot/snapshot-transaction-policy.js";
import type { SnapshotFile, SnapshotOptions } from "../src/engine/snapshot/snapshot-types.js";

async function fixture(run: (root: string, held: ReadonlySet<string>) => Promise<void>) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "pi-sync-directional-identical-")));
  const held = new Set<string>();
  configureEngineHost({
    root: () => root,
    mutate: async (target, action) => {
      assert.ok(!held.has(target));
      held.add(target);
      try {
        return await action();
      } finally {
        held.delete(target);
      }
    },
    review: async () => true,
  });
  try {
    await run(root, held);
    assert.equal(held.size, 0);
  } finally {
    vi.restoreAllMocks();
    await fs.rm(root, { recursive: true, force: true });
  }
}

function file(relative: string, bytes: string): SnapshotFile {
  return {
    path: relative,
    contentBase64: Buffer.from(bytes).toString("base64"),
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

function applyRenames(calls: readonly Parameters<typeof fs.rename>[]) {
  return calls.flatMap(([from, to]) => (String(from).endsWith(".apply") ? [to] : []));
}

const scopes: Record<string, SnapshotOptions> = {
  directory: { scope: "agent-directory" },
  selected: { include: ["extensions", "settings.json"] },
};

for (const [name, options] of Object.entries(scopes)) {
  for (const change of [0, 1]) {
    test(`${name}: ${change} live replacements for a 300-file directional apply with ${change} changed files`, () =>
      fixture(async (root, held) => {
        const items = Array.from({ length: 300 }, (_, i) => `extensions/item-${i}.ts`);
        await fs.mkdir(path.join(root, "extensions"));
        await Promise.all(items.map((item) => fs.writeFile(path.join(root, item), "same")));
        const before = await createSnapshot("test", options);
        assert.equal(before.files.length, items.length);
        const changed = "extensions/item-24.ts";
        const incoming = {
          ...before,
          files: before.files.map((item) => (change && item.path === changed ? file(changed, "new!") : item)),
        };
        const rename = vi.spyOn(fs, "rename");
        const review = vi.fn(async () => {
          assert.deepEqual(held, new Set(items.map((item) => path.join(root, item))));
        });
        const hashes = await applySnapshot(incoming, new Set(), {
          ...options,
          reviewedLocal: before,
          validateApplyReview: review,
        });
        assert.deepEqual(hashes, Object.fromEntries(incoming.files.map(({ path, sha256 }) => [path, sha256])));
        assert.deepEqual(applyRenames(rename.mock.calls), change ? [path.join(root, changed)] : []);
        assert.equal(review.mock.calls.length, 1);
        assert.equal(await fs.readFile(path.join(root, changed), "utf8"), change ? "new!" : "same");
        assert.deepEqual(await pendingTransactionEntries(), []);
        if (!change) await assert.rejects(fs.lstat(transactionRoot()), { code: "ENOENT" });
      }));
  }

  test(`${name}: rejects same-size skipped preimage edits at the no-op review boundary`, () =>
    fixture(async (root, held) => {
      const target = path.join(root, "extensions", "keep.ts");
      await fs.mkdir(path.dirname(target));
      await fs.writeFile(target, "old!");
      const before = await createSnapshot("test", options);
      const rename = vi.spyOn(fs, "rename");
      const review = vi.fn(async () => {
        assert.ok(held.has(target));
        await fs.writeFile(target, "edit");
      });
      await assert.rejects(
        applySnapshot(before, new Set(), { ...options, reviewedLocal: before, validateApplyReview: review }),
        /Skipped file preimage changed/,
      );
      assert.equal(review.mock.calls.length, 1);
      assert.deepEqual(applyRenames(rename.mock.calls), []);
      assert.equal(await fs.readFile(target, "utf8"), "edit");
      await assert.rejects(fs.lstat(transactionRoot()), { code: "ENOENT" });
    }));

  for (const interrupt of [false, true]) {
    test(`${name}: ${interrupt ? "recovery" : "rollback on stale preimage"} never restores an omitted file`, () =>
      fixture(async (root, held) => {
        const kept = path.join(root, "extensions", "keep.ts");
        const changed = path.join(root, "extensions", "change.ts");
        await fs.mkdir(path.dirname(kept));
        await fs.writeFile(kept, "old!");
        await fs.writeFile(changed, "before");
        const before = await createSnapshot("test", options);
        const incoming = {
          ...before,
          files: [file("extensions/change.ts", "after"), file("extensions/keep.ts", "old!")],
        };
        const controller = new AbortController();
        const rename = fs.rename.bind(fs);
        const renames = vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
          await rename(from, to);
          if (to !== changed || !String(from).endsWith(".apply")) return;
          assert.ok(held.has(kept) && held.has(changed));
          await fs.writeFile(kept, "edit");
          if (interrupt) controller.abort();
        });
        await assert.rejects(
          applySnapshot(incoming, new Set(), { ...options, signal: controller.signal, reviewedLocal: before }),
          interrupt ? /guarded transaction evidence retained/ : /Skipped file preimage changed/,
        );
        assert.deepEqual(applyRenames(renames.mock.calls), [changed]);
        if (interrupt) {
          const [entry, ...others] = await pendingTransactionEntries();
          assert.ok(entry);
          assert.deepEqual(others, []);
          const journal = JSON.parse(
            await fs.readFile(path.join(transactionRoot(), entry.name, "journal.json"), "utf8"),
          ) as TransactionJournal;
          assert.deepEqual(
            journal.entries.map(({ target }) => target),
            [changed],
          );
          assert.equal(await fs.readFile(changed, "utf8"), "after");
          await recoverPendingSnapshotTransactions(options);
        }
        assert.equal(await fs.readFile(changed, "utf8"), "before");
        assert.equal(await fs.readFile(kept, "utf8"), "edit");
        assert.deepEqual(await pendingTransactionEntries(), []);
      }));
  }

  test(`${name}: retains additions, removals and both structural replacements`, () =>
    fixture(async (root) => {
      const extensions = path.join(root, "extensions");
      await fs.mkdir(path.join(extensions, "to-file"), { recursive: true });
      for (const item of ["keep.ts", "remove.ts", "to-dir", "to-file/old.ts"])
        await fs.writeFile(path.join(extensions, item), "same");
      const before = await createSnapshot("test", options);
      const files = ["keep.ts", "add.ts", "to-dir/new.ts", "to-file"].map((item) => file(`extensions/${item}`, "same"));
      const rename = vi.spyOn(fs, "rename");
      const hashes = await applySnapshot({ ...before, files }, new Set(), { ...options, reviewedLocal: before });
      assert.deepEqual(hashes, Object.fromEntries(files.map(({ path, sha256 }) => [path, sha256])));
      assert.deepEqual(
        applyRenames(rename.mock.calls),
        ["add.ts", "to-dir/new.ts", "to-file"].map((item) => path.join(extensions, item)),
      );
      assert.equal(await fs.readFile(path.join(extensions, "to-dir", "new.ts"), "utf8"), "same");
      assert.equal(await fs.readFile(path.join(extensions, "to-file"), "utf8"), "same");
      await assert.rejects(fs.lstat(path.join(extensions, "remove.ts")), { code: "ENOENT" });
      assert.deepEqual(
        (await createSnapshot("test", options)).files.map(({ path }) => path),
        files.map(({ path }) => path).sort((a, b) => a.localeCompare(b)),
      );
    }));
}

test("selected: equal settings bytes still require the physical case correction", () =>
  fixture(async (root) => {
    const target = path.join(root, "settings.json");
    await fs.writeFile(path.join(root, "SETTINGS.JSON"), "{}");
    const options = { include: ["settings.json"] };
    const before = await createSnapshot("test", options);
    assert.deepEqual(before.files, [file("settings.json", "{}")]);
    const rename = vi.spyOn(fs, "rename");
    await applySnapshot(before, new Set(), { ...options, reviewedLocal: before });
    assert.deepEqual(applyRenames(rename.mock.calls), [target]);
    const names = await fs.readdir(root);
    assert.ok(names.includes("settings.json"));
    assert.ok(!names.includes("SETTINGS.JSON"));
  }));

test("directory: equal bytes still require a case-only path change", () =>
  fixture(async (root) => {
    const original = path.join(root, "Case.txt");
    const target = path.join(root, "case.txt");
    await fs.writeFile(original, "same");
    const options = { scope: "agent-directory" as const };
    const before = await createSnapshot("test", options);
    const rename = vi.spyOn(fs, "rename");
    await applySnapshot({ ...before, files: [file("case.txt", "same")] }, new Set(), {
      ...options,
      reviewedLocal: before,
    });
    assert.deepEqual(applyRenames(rename.mock.calls), [target]);
    const names = await fs.readdir(root);
    assert.ok(names.includes("case.txt"));
    assert.ok(!names.includes("Case.txt"));
  }));

test("selected: equal hard-linked bytes do not qualify as independent", () =>
  fixture(async (root) => {
    const target = path.join(root, "extensions", "keep.ts");
    const alias = path.join(root, "outside-selection.ts");
    await fs.mkdir(path.dirname(target));
    await fs.writeFile(target, "same");
    await fs.link(target, alias);
    const options = { include: ["extensions"] };
    const before = await createSnapshot("test", options);
    const rename = vi.spyOn(fs, "rename");
    await applySnapshot(before, new Set(), options);
    assert.deepEqual(applyRenames(rename.mock.calls), [target]);
    assert.notEqual((await fs.stat(target)).ino, (await fs.stat(alias)).ino);
    assert.equal(await fs.readFile(alias, "utf8"), "same");
  }));

test("acceptance rechecks an earlier skipped file after verifying the rest of the group", () =>
  fixture(async (root) => {
    const first = path.join(root, "extensions", "first.ts");
    const last = path.join(root, "extensions", "last.ts");
    await fs.mkdir(path.dirname(first));
    await fs.writeFile(first, "old!");
    await fs.writeFile(last, "old!");
    const options = { include: ["extensions"] };
    const before = await createSnapshot("test", options);
    const open = fs.open.bind(fs);
    let accepting = false;
    let edited = false;
    vi.spyOn(fs, "open").mockImplementation(async (target, flags, mode) => {
      if (accepting && target === last && !edited) {
        edited = true;
        await fs.writeFile(first, "edit");
      }
      return open(target, flags, mode);
    });
    await assert.rejects(
      applySnapshot(before, new Set(), {
        ...options,
        validateApplyReview: async () => {
          accepting = true;
        },
      }),
      /Skipped file preimage changed/,
    );
    assert.equal(edited, true);
    assert.equal(await fs.readFile(first, "utf8"), "edit");
  }));

test("directional apply retains protected and excluded files without reserving them as skipped targets", () =>
  fixture(async (root, held) => {
    const options = { scope: "agent-directory" as const, include: ["sessions"], exclude: ["private.txt"] };
    await fs.mkdir(path.join(root, "sessions"));
    for (const target of ["private.txt", "sessions/current.jsonl", "sessions/peer.jsonl", "keep.txt"])
      await fs.writeFile(path.join(root, target), "old");
    const before = await createSnapshot("test", options);
    const files = [file("private.txt", "new"), file("sessions/current.jsonl", "new"), file("keep.txt", "old")];
    const rename = vi.spyOn(fs, "rename");
    const hashes = await applySnapshot(
      { ...before, files },
      new Set(["sessions/current.jsonl", "sessions/peer.jsonl"]),
      {
        ...options,
        reviewedLocal: before,
        validateApplyReview: async () => assert.deepEqual(held, new Set([path.join(root, "keep.txt")])),
      },
    );
    assert.deepEqual(applyRenames(rename.mock.calls), []);
    assert.deepEqual(hashes, Object.fromEntries(before.files.map(({ path, sha256 }) => [path, sha256])));
    assert.equal(await fs.readFile(path.join(root, "private.txt"), "utf8"), "old");
    assert.equal(await fs.readFile(path.join(root, "sessions", "current.jsonl"), "utf8"), "old");
    assert.equal(await fs.readFile(path.join(root, "sessions", "peer.jsonl"), "utf8"), "old");
  }));

test("an unchanged empty selection still checks apply review and returns the accepted hash map", () =>
  fixture(async (root, held) => {
    const options = { include: ["extensions"] };
    const before = await createSnapshot("test", options);
    const review = vi.fn(async () => assert.equal(held.size, 0));
    assert.deepEqual(await applySnapshot(before, new Set(), { ...options, validateApplyReview: review }), {});
    assert.equal(review.mock.calls.length, 1);
    await assert.rejects(fs.lstat(path.join(root, "extensions")), { code: "ENOENT" });
  }));

test("incoming bytes are verified even when the advertised hash matches the local file", () =>
  fixture(async (root) => {
    await fs.writeFile(path.join(root, "settings.json"), "{}");
    const options = { include: ["settings.json"] };
    const before = await createSnapshot("test", options);
    const replacement = { ...file("settings.json", "[]"), sha256: file("settings.json", "{}").sha256 };
    await assert.rejects(applySnapshot({ ...before, files: [replacement] }, new Set(), options), /Checksum mismatch/);
    await assert.rejects(fs.lstat(transactionRoot()), { code: "ENOENT" });
  }));
