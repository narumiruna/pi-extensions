import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test, vi } from "vitest";
import { configureEngineHost } from "../src/engine/host.js";
import { createSnapshot } from "../src/engine/snapshot/snapshot.js";
import {
  createSnapshotCaptureLimits,
  SnapshotCaptureLimitError,
} from "../src/engine/snapshot/snapshot-capture-limit.js";

const scope = { scope: "agent-directory" as const };

async function fixture(run: (root: string) => Promise<void>) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "pi-sync-capture-budget-")));
  try {
    configureEngineHost({ root: () => root, mutate: async (_target, action) => action(), review: async () => true });
    await run(root);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

test("agent-directory capture admits exactly the examined entries and eligible files and bytes", () =>
  fixture(async (root) => {
    const options = { ...scope, include: ["sessions"], exclude: ["ignored"] };
    for (const name of ["notes", "ignored", "sessions"]) await fs.mkdir(path.join(root, name));
    await fs.writeFile(path.join(root, "notes/note.md"), "abc");
    await fs.writeFile(path.join(root, "ignored/never-visited"), "outside the budget");
    await fs.writeFile(path.join(root, "sessions/active.jsonl"), "de");
    await fs.writeFile(path.join(root, "sessions/not-a-session.txt"), "outside the budget");
    const exact = { bytes: 5, files: 2, entries: 6, depth: 2 };
    const bounded = await createSnapshot("test", options, createSnapshotCaptureLimits(exact));
    const regular = await createSnapshot("test", options);
    assert.deepEqual(bounded.files, regular.files);
    assert.deepEqual(
      bounded.files.map(({ path, contentBase64 }) => [path, Buffer.from(contentBase64, "base64").toString()]),
      [
        ["notes/note.md", "abc"],
        ["sessions/active.jsonl", "de"],
      ],
    );

    const open = vi.spyOn(fs, "open");
    try {
      for (const bound of ["entries", "files", "bytes"] as const) {
        const limits = createSnapshotCaptureLimits({ ...exact, [bound]: exact[bound] - 1 });
        await assert.rejects(createSnapshot("test", options, limits), SnapshotCaptureLimitError, bound);
        assert.equal(open.mock.calls.length, 0, `opened a payload before checking the ${bound} limit`);
      }
    } finally {
      open.mockRestore();
    }
  }));

test("agent-directory capture charges selected settings once, apart from fixed-budget routing reads", () =>
  fixture(async (root) => {
    const settingsPath = path.join(root, "settings.json");
    await fs.writeFile(settingsPath, "{}");
    const exact = { bytes: 2, files: 1, entries: 1, depth: 1 };
    const open = vi.spyOn(fs, "open");
    const reads = () => open.mock.calls.map(([file]) => file);
    try {
      const excluded = await createSnapshot(
        "test",
        { ...scope, exclude: ["settings.json"] },
        createSnapshotCaptureLimits({ ...exact, bytes: 0, files: 0 }),
      );
      assert.deepEqual(excluded.files, []);
      assert.deepEqual(reads(), [settingsPath, settingsPath]);

      open.mockClear();
      const included = await createSnapshot("test", scope, createSnapshotCaptureLimits(exact));
      assert.deepEqual(
        included.files.map(({ path }) => path),
        ["settings.json"],
      );
      assert.deepEqual(reads(), [settingsPath, settingsPath, settingsPath]);

      for (const limit of [{ bytes: 1 }, { files: 0 }]) {
        open.mockClear();
        await assert.rejects(
          createSnapshot("test", scope, createSnapshotCaptureLimits({ ...exact, ...limit })),
          SnapshotCaptureLimitError,
        );
        assert.deepEqual(reads(), [settingsPath]);
      }
    } finally {
      open.mockRestore();
    }
  }));

test("included-path capture shares settings, entry, and payload accounting", () =>
  fixture(async (root) => {
    await fs.writeFile(path.join(root, "settings.json"), "{}");
    await fs.writeFile(path.join(root, "AGENTS.md"), "abc");
    const options = { include: ["AGENTS.md", "settings.json"] };
    const exact = { bytes: 7, files: 3, entries: 2, depth: 1 };
    const bounded = await createSnapshot("test", options, createSnapshotCaptureLimits(exact));
    assert.deepEqual(bounded.files, (await createSnapshot("test", options)).files);
    for (const bound of ["entries", "files", "bytes"] as const) {
      const limits = createSnapshotCaptureLimits({ ...exact, [bound]: exact[bound] - 1 });
      await assert.rejects(createSnapshot("test", options, limits), SnapshotCaptureLimitError, bound);
    }
  }));

test("agent-directory capture still rejects eligible hard links before opening them", () =>
  fixture(async (root) => {
    const source = path.join(root, "file.md");
    await fs.writeFile(source, "abc");
    await fs.link(source, path.join(root, "alias.md"));
    const open = vi.spyOn(fs, "open");
    try {
      const limits = createSnapshotCaptureLimits({ bytes: 6, files: 2, entries: 2, depth: 1 });
      await assert.rejects(createSnapshot("test", scope, limits), /unsafe filesystem layout/u);
      assert.equal(open.mock.calls.length, 0);
    } finally {
      open.mockRestore();
    }
  }));

test("agent-directory capture rejects a different file descriptor after admission", () =>
  fixture(async (root) => {
    const source = path.join(root, "file.md");
    const replacement = path.join(root, "replacement.md");
    await fs.writeFile(source, "abc");
    await fs.writeFile(replacement, "abc");
    const originalOpen = fs.open.bind(fs);
    const open = vi
      .spyOn(fs, "open")
      .mockImplementation((file, ...args) => originalOpen(file === source ? replacement : file, ...args));
    try {
      const options = { ...scope, exclude: ["replacement.md"] };
      const limits = createSnapshotCaptureLimits({ bytes: 3, files: 1, entries: 2, depth: 1 });
      await assert.rejects(createSnapshot("test", options, limits), /unsafe filesystem layout/u);
      assert.deepEqual(
        open.mock.calls.map(([file]) => file),
        [source],
      );
    } finally {
      open.mockRestore();
    }
  }));
