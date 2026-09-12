import assert from "node:assert/strict";
import { chmod, lstat, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import type { MessageCandidate } from "../src/messages.js";
import { MAX_RECALL_RECORDS, RecallStore, RecallStoreFormatError } from "../src/store.js";

async function withStore(
  run: (store: RecallStore, filePath: string, root: string) => Promise<void>,
  options: ConstructorParameters<typeof RecallStore>[1] = {},
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "pi-recall-test-"));
  const filePath = join(root, "pi-recall.jsonl");
  try {
    await run(new RecallStore(filePath, options), filePath, root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function candidate(entryId: string, text = `message ${entryId}`): MessageCandidate {
  return {
    entryId,
    role: "assistant",
    text,
    messageTimestamp: 1_786_000_000_000,
    source: { sessionId: "session-a", sessionName: "Named", cwd: "/work/project" },
  };
}

test("saves versioned records, rejects duplicate source identity, and physically deletes", async () => {
  let nextId = 0;
  await withStore(
    async (store, filePath) => {
      assert.deepEqual((await store.load()).records, []);
      const saved = await store.save(candidate("entry-a"));
      assert.equal(saved.id, "id-1");
      assert.equal(saved.savedAt, "2026-08-04T12:00:00.000Z");
      assert.equal((await lstat(filePath)).mode & 0o777, 0o600);
      await assert.rejects(store.save(candidate("entry-a")), /already saved/i);
      assert.equal((await store.load()).records.length, 1);
      assert.equal(await store.delete(saved.id), true);
      assert.equal(await store.delete(saved.id), false);
      assert.equal(await readFile(filePath, "utf8"), "");
    },
    {
      now: () => Date.parse("2026-08-04T12:00:00.000Z"),
      createId: () => `id-${++nextId}`,
    },
  );
});

test("rejects a generated ID collision without corrupting valid storage", async () => {
  await withStore(
    async (store, filePath) => {
      await store.save(candidate("entry-a"));
      const previous = await readFile(filePath, "utf8");
      await assert.rejects(store.save(candidate("entry-b")), /duplicate ID/i);
      assert.equal(await readFile(filePath, "utf8"), previous);
    },
    { createId: () => "same-id" },
  );
});

test("serializes concurrent writers from separate store instances without lost updates", async () => {
  await withStore(async (first, filePath) => {
    let sequence = 0;
    const second = new RecallStore(filePath, { createId: () => `second-${++sequence}` });
    const third = new RecallStore(filePath, { createId: () => `third-${++sequence}` });
    await Promise.all([
      first.save(candidate("entry-a")),
      second.save(candidate("entry-b")),
      third.save(candidate("entry-c")),
    ]);
    const records = (await first.load()).records;
    assert.deepEqual(records.map(({ source }) => source.entryId).sort(), ["entry-a", "entry-b", "entry-c"]);
    assert.equal(new Set(records.map(({ id }) => id)).size, 3);
  });
});

test("preserves unknown fields on valid v1 records during rewrite", async () => {
  await withStore(async (store, filePath) => {
    await writeFile(
      filePath,
      `${JSON.stringify({
        type: "recall_message",
        version: 1,
        id: "existing",
        savedAt: "2026-08-04T12:00:00.000Z",
        source: {
          sessionId: "other",
          entryId: "other-entry",
          cwd: "/other",
          messageTimestamp: 1,
          futureSource: true,
        },
        role: "user",
        text: "existing",
        futureTopLevel: { keep: true },
      })}\n`,
    );
    await store.save(candidate("new-entry"));
    const raw = (await readFile(filePath, "utf8")).split("\n")[0];
    const parsed = JSON.parse(raw ?? "{}") as Record<string, unknown>;
    assert.deepEqual(parsed.futureTopLevel, { keep: true });
    assert.equal((parsed.source as Record<string, unknown>).futureSource, true);
  });
});

test("malformed, newer, duplicate-id, and oversized stores fail closed without mutation", async () => {
  const invalidValues = [
    "{broken\n",
    `${JSON.stringify({ type: "recall_message", version: 2 })}\n`,
    `${JSON.stringify({
      type: "recall_message",
      version: 1,
      id: "same",
      savedAt: "2026-08-04T12:00:00.000Z",
      source: { sessionId: "s", entryId: "a", cwd: "/a", messageTimestamp: 1 },
      role: "user",
      text: "a",
    })}\n${JSON.stringify({
      type: "recall_message",
      version: 1,
      id: "same",
      savedAt: "2026-08-04T12:00:00.000Z",
      source: { sessionId: "s", entryId: "b", cwd: "/a", messageTimestamp: 2 },
      role: "user",
      text: "b",
    })}\n`,
  ];
  for (const value of invalidValues) {
    await withStore(async (store, filePath) => {
      await writeFile(filePath, value);
      await assert.rejects(store.save(candidate("entry")), RecallStoreFormatError);
      assert.equal(await readFile(filePath, "utf8"), value);
    });
  }

  await withStore(async (store, filePath) => {
    const records = Array.from({ length: MAX_RECALL_RECORDS + 1 }, (_, index) =>
      JSON.stringify({
        type: "recall_message",
        version: 1,
        id: `id-${index}`,
        savedAt: "2026-08-04T12:00:00.000Z",
        source: { sessionId: "s", entryId: `e-${index}`, cwd: "/a", messageTimestamp: 1 },
        role: "user",
        text: "x",
      }),
    ).join("\n");
    await writeFile(filePath, `${records}\n`);
    await assert.rejects(store.load(), /at most/i);
  });
});

test("rejects symlink storage and leaves its target unchanged", async () => {
  await withStore(async (store, filePath, root) => {
    const target = join(root, "target.txt");
    await writeFile(target, "secret");
    await symlink(target, filePath);
    await assert.rejects(store.save(candidate("entry")), /regular file/i);
    assert.equal(await readFile(target, "utf8"), "secret");
  });
});

test("an interrupted publication preserves the previous canonical bytes and cleans temporary files", async () => {
  let publications = 0;
  await withStore(
    async (store, filePath, root) => {
      await store.save(candidate("entry-a"));
      const previous = await readFile(filePath, "utf8");
      await assert.rejects(store.save(candidate("entry-b")), /injected publication failure/);
      assert.equal(await readFile(filePath, "utf8"), previous);
      const entries = await import("node:fs/promises").then(({ readdir }) => readdir(root));
      assert.deepEqual(entries.sort(), ["pi-recall.jsonl"]);
    },
    {
      beforeRename: async () => {
        publications += 1;
        if (publications === 2) throw new Error("injected publication failure");
      },
    },
  );
});

test("aborts a lock wait promptly and releases the winning lock", async () => {
  await withStore(async (store, filePath) => {
    await chmod(join(filePath, ".."), 0o700).catch(() => undefined);
    const lockfile = (await import("proper-lockfile")).default;
    const release = await lockfile.lock(filePath, { realpath: false, retries: 0 });
    const controller = new AbortController();
    const pending = store.save(candidate("entry"), controller.signal);
    setTimeout(() => controller.abort(), 20);
    await assert.rejects(pending, /abort/i);
    await release();
    await store.save(candidate("entry"));
    assert.equal((await store.load()).records.length, 1);
  });
});
