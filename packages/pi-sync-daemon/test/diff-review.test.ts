import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test, vi } from "vitest";
import {
  DIFF_REVIEW_CATALOG_BYTES,
  DIFF_REVIEW_CATALOG_FILES,
  DIFF_REVIEW_OUTPUT_BYTES,
  parseDiffReviewInventory,
  readDiffReviewPreview,
} from "../src/diff-review-protocol.js";
import { createDiffReviewStore, type PreparedDiffReview } from "../src/diff-review-store.js";
import {
  createSnapshotCaptureLimits,
  SnapshotCaptureLimitError,
} from "../src/engine/snapshot/snapshot-capture-limit.js";
import type { Snapshot, SnapshotFile } from "../src/engine/snapshot/snapshot-types.js";
import { prepareDiffReview } from "../src/engine/sync/diff-review-capture.js";
import { buildDiffReviewPreview, DIFF_REVIEW_FILE_BYTES } from "../src/engine/sync/diff-review-preview.js";
import { formatDiff } from "../src/engine/ui/sync-format.js";

function file(path: string, value: string | Buffer): SnapshotFile {
  return {
    path,
    sha256: createHash("sha256").update(value).digest("hex"),
    contentBase64: Buffer.from(value).toString("base64"),
  };
}
function snapshot(files: SnapshotFile[], localFields?: string[]): Snapshot {
  return {
    id: "synthetic",
    version: 2,
    profile: "fixture",
    createdAt: "2026-11-28T00:00:00.000Z",
    machine: "fixture",
    files,
    localFields,
  };
}
const preview = (local?: string | Buffer, remote?: string | Buffer) =>
  buildDiffReviewPreview({
    local: local === undefined ? undefined : Buffer.from(local),
    remote: remote === undefined ? undefined : Buffer.from(remote),
  });

test("previews use exact local-minus/remote-plus lines and unified ranges", () => {
  assert.deepEqual(preview("old \r\nlast", "new \r\nlast\n"), {
    kind: "diff",
    content: "--- Local\n+++ Remote\n@@ -1,2 +1,2 @@\n-old \r\n-last\n\\ No newline at end of file\n+new \r\n+last\n",
  });
  assert.deepEqual(preview(undefined, "new\n"), {
    kind: "diff",
    content: "--- Local\n+++ Remote\n@@ -0,0 +1 @@\n+new\n",
  });
  assert.deepEqual(preview("old\n", undefined), {
    kind: "diff",
    content: "--- Local\n+++ Remote\n@@ -1 +0,0 @@\n-old\n",
  });
  const context = "0\n1\n2\n3\n4\n5\n6\n7\n8\n9\n";
  const split = preview(`old\n${context}before\n`, `new\nextra\n${context}after\n`);
  assert.equal(split.kind, "diff");
  assert.match(split.content, /@@ -1,4 \+1,5 @@\n-old\n\+new\n\+extra\n/u);
  assert.match(split.content, /@@ -9,4 \+10,4 @@\n 7\n 8\n 9\n-before\n\+after\n/u);
  assert.doesNotMatch(split.content, /\n [3456]\n/u);
});

test("empty, binary, encoding, byte, output, and edit limits return no partial content", () => {
  const cases = [
    [preview(undefined, ""), /empty.*presence/u],
    [preview("", undefined), /empty.*presence/u],
    [preview("a\n", "a\n"), /no text differences/iu],
    [preview(undefined, Buffer.from([0xc3, 0x28])), /not supported UTF-8/u],
    [preview(undefined, Buffer.from([0])), /binary/u],
    [preview(undefined, "a\rb"), /not supported UTF-8/u],
    [preview(undefined, Buffer.alloc(DIFF_REVIEW_FILE_BYTES + 1, 0x61)), /limits/u],
    [preview("a\n".repeat(1000), "b\n".repeat(1000)), /limits/u],
    [preview(undefined, "a\n".repeat(1999)), /limits/u],
    [preview(Buffer.alloc(DIFF_REVIEW_FILE_BYTES, 0x61), Buffer.alloc(DIFF_REVIEW_FILE_BYTES, 0x62)), /limits/u],
  ] as const;
  for (const [result, expected] of cases) {
    assert.equal(result.kind, "notice");
    assert.match(result.message, expected);
    assert.equal(Object.hasOwn(result, "content"), false);
  }
});

test("classification matches the legacy hash summary and keeps session and conflicting field policies metadata-only", () => {
  const local = snapshot(
    [
      file("local.txt", "local body"),
      file("change.txt", "before"),
      file("same", "same"),
      file("sessions/a/b.jsonl", "session on disk"),
      file("logs/data.JSONL", "session alias"),
      file("settings.json", "{}"),
      file("raw\u202e", "direction mark"),
      file("raw?", "question mark"),
    ],
    ["machine"],
  );
  const remote = snapshot([
    file("remote.txt", "remote body"),
    file("change.txt", "after"),
    file("same", "same"),
    file("sessions/a/b.jsonl", "remote session on disk"),
    file("settings.json", '{"machine":"private"}'),
  ]);
  const result = prepareDiffReview({ local, remote, lines: ["overview"], warnings: [] }, async () => false);
  assert.ok("prepared" in result);
  const { inventory, rows } = result.prepared;
  assert.deepEqual(parseDiffReviewInventory(inventory), inventory);
  assert.deepEqual(
    inventory.files.map(({ path, status }) => [path, status]),
    [
      ["change.txt", "different"],
      ["local.txt", "local-only"],
      ["logs/data.JSONL", "local-only"],
      ["raw?", "local-only"],
      ["raw\u202e", "local-only"],
      ["remote.txt", "remote-only"],
      ["sessions/a/b.jsonl", "different"],
      ["settings.json", "different"],
    ],
  );
  assert.match(formatDiff(local, remote), /Different: change\.txt\nLocal only: local\.txt/u);
  assert.match(formatDiff(local, remote), /Remote only: remote\.txt/u);
  for (const entry of inventory.files) {
    const row = rows.get(entry.id);
    assert.ok(row);
    if (entry.path.toLowerCase().endsWith("jsonl") || entry.path === "settings.json") {
      assert.ok("notice" in row);
      assert.doesNotMatch(JSON.stringify(row), /session on disk|session alias|private/u);
    }
  }
  assert.doesNotMatch(JSON.stringify(inventory), /local body|before|remote body|session on disk|private/u);
});

test("catalog depth, count and bytes and retained payload overflow fall back to a bounded summary", () => {
  const normal = file("only.txt", "present");
  const assertLimited = (files: SnapshotFile[], lines: string[] = []) => {
    const result = prepareDiffReview(
      { local: snapshot(files), lines, warnings: ["session risk"], selectionState: { kind: "different" } },
      async () => false,
    );
    assert.ok("unavailable" in result);
    assert.match(result.unavailable.message, /Summary only.*Remote is empty.*differs from this setup.*session risk/su);
    assert.ok(Buffer.byteLength(JSON.stringify(result.unavailable)) <= DIFF_REVIEW_CATALOG_BYTES);
    assert.doesNotMatch(result.unavailable.message, /UNIQUE_FILE_BODY/u);
  };
  assertLimited([normal, file(`${"a/".repeat(64)}extra.txt`, "UNIQUE_FILE_BODY")]);
  assertLimited([normal, file(`${"é".repeat(2100)}.txt`, "UNIQUE_FILE_BODY")]);
  assertLimited(Array.from({ length: DIFF_REVIEW_CATALOG_FILES + 1 }, (_, i) => ({ ...normal, path: `${i}.txt` })));
  assertLimited(Array.from({ length: 160 }, (_, i) => ({ ...normal, path: `${i}-${"ø".repeat(1500)}.txt` })));
  const huge = file("body.txt", Buffer.alloc(DIFF_REVIEW_FILE_BYTES, 0x61));
  assertLimited(Array.from({ length: 129 }, (_, i) => ({ ...huge, path: `${i}.txt` })));
  assertLimited([normal], ["ø".repeat(DIFF_REVIEW_CATALOG_BYTES)]);
  const empty = prepareDiffReview(
    { local: snapshot([]), remote: snapshot([]), lines: [], warnings: [] },
    async () => false,
  );
  assert.ok("prepared" in empty);
  assert.ok(empty.prepared.inventory.lines.includes("No file differences."));
});

test("bounded legacy collection does not read beyond its aggregate disk budget", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-sync-diff-limit-"));
  try {
    const source = path.join(root, "only.txt");
    await fs.writeFile(source, "1234");
    const bounds = createSnapshotCaptureLimits({ bytes: 7, entries: 1, files: 3, depth: 2 });
    assert.deepEqual(
      (await bounds.readEntries(root)).map(({ name }) => name),
      ["only.txt"],
    );
    await assert.rejects(bounds.readEntries(root), SnapshotCaptureLimitError);
    assert.equal((await bounds.readFile(source)).toString(), "1234");
    await assert.rejects(bounds.readFile(source), SnapshotCaptureLimitError);
    await assert.rejects(bounds.readFile(source, AbortSignal.abort()), { name: "AbortError" });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

function offer(bytes: number, staleSetup: PreparedDiffReview["staleSetup"] = async () => false): PreparedDiffReview {
  const file = { id: randomUUID(), path: "one", status: "local-only" } as const;
  return {
    bytes,
    staleSetup,
    inventory: { kind: "review", id: randomUUID(), lines: [], files: [file] },
    rows: new Map([[file.id, { local: Buffer.from("body\n"), remote: undefined }]]),
  };
}

test("the store bounds total retention and drops rows on release, expiry, replacement, and capture cancellation", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    const store = createDiffReviewStore({ totalBytes: 100, lifetime: 200 });
    const left = {};
    const right = {};
    const signal = new AbortController();
    const old = offer(50);
    const next = offer(75);
    assert.equal(store.retain(left, old, signal.signal), true);
    assert.equal(store.retain(right, next, signal.signal), false);
    assert.equal(store.retain(left, next, signal.signal), true);
    assert.equal(old.rows.size, 0);
    assert.deepEqual(await store.read(right, next.inventory.id, [...next.rows.keys()][0], signal.signal), {
      kind: "stale",
    });
    assert.equal((await store.read(left, next.inventory.id, [...next.rows.keys()][0], signal.signal)).kind, "diff");
    store.release(right, next.inventory.id);
    assert.equal(next.rows.size, 1);
    vi.advanceTimersByTime(201);
    assert.equal(next.rows.size, 0);
    const afterExpiry = offer(90);
    assert.equal(store.retain(right, afterExpiry, signal.signal), true);
    signal.abort();
    assert.equal(afterExpiry.rows.size, 0);
    const active = offer(80);
    assert.equal(store.retain(left, active, new AbortController().signal), true);
    store.close();
    assert.equal(active.rows.size, 0);
  } finally {
    vi.useRealTimers();
  }
});

test("closing a review invalidates a blocked read, and cancelling a read preserves a current review", async () => {
  const owner = {};
  const store = createDiffReviewStore();
  const parent = new AbortController().signal;
  const hold = Promise.withResolvers<boolean>();
  const read = new AbortController();
  const prepared = offer(200, async () => hold.promise);
  const id = prepared.inventory.id;
  const fileId = [...prepared.rows.keys()][0];
  assert.equal(store.retain(owner, prepared, parent), true);
  const first = store.read(owner, id, fileId, read.signal);
  const busy = await store.read(owner, id, fileId, parent);
  assert.equal(busy.kind, "notice");
  read.abort();
  hold.resolve(false);
  await assert.rejects(first, { name: "AbortError" });
  assert.equal((await store.read(owner, id, fileId, parent)).kind, "diff");
  const gate = Promise.withResolvers<boolean>();
  const pending = offer(200, async () => gate.promise);
  assert.equal(store.retain(owner, pending, parent), true);
  const stopped = store.read(owner, pending.inventory.id, [...pending.rows.keys()][0], parent);
  store.release(owner, pending.inventory.id);
  gate.resolve(false);
  assert.deepEqual(await stopped, { kind: "stale" });
});

test("untrusted inventories and previews reject extra fields, unknown identities, and oversized data without reflecting it", () => {
  const { inventory } = offer(123);
  const row = inventory.files[0];
  for (const invalid of [
    { ...inventory, files: [row, { ...row, path: "other" }] },
    { ...inventory, files: [row, { ...row, id: randomUUID() }] },
    { ...inventory, files: [{ ...row, path: "../body" }] },
    { ...inventory, files: [{ ...row, status: "unknown" }] },
    { ...inventory, content: "BODY_MARKER" },
    { kind: "unavailable", message: "a".repeat(DIFF_REVIEW_CATALOG_BYTES) },
  ])
    assert.throws(() => parseDiffReviewInventory(invalid), { message: "Invalid daemon diff review inventory." });
  for (const invalid of [
    { kind: "diff", content: "BODY_MARKER" },
    { kind: "diff", content: `--- Local\n+++ Remote\n@@ ${"ø".repeat(DIFF_REVIEW_OUTPUT_BYTES)}` },
    { kind: "stale", content: "BODY_MARKER" },
    { kind: "notice", message: "a".repeat(1025) },
  ])
    assert.throws(() => readDiffReviewPreview(invalid), { message: "Invalid daemon diff review preview." });
});
