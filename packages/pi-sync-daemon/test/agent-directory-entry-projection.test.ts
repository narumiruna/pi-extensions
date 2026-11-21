import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test, vi } from "vitest";
import { configureEngineHost, engineHost } from "../src/engine/host.js";
import { agentDirectoryInventory, createSnapshot } from "../src/engine/snapshot/snapshot.js";
import { applySnapshot } from "../src/engine/snapshot/snapshot-apply.js";
import type { Snapshot, SnapshotFile } from "../src/engine/snapshot/snapshot-types.js";
import { applyMergedSnapshot, preflightMergedTargets } from "../src/engine/sync/merge-apply.js";
import { MAX_AGENT_DIRECTORY_ENTRIES as entryLimit } from "../src/engine/sync/sync-policy.js";

// Exercise the actual scanner and both apply paths without creating 65,536 filesystem entries.
vi.mock("../src/engine/sync/sync-policy.js", async (original) => ({
  ...(await original<typeof import("../src/engine/sync/sync-policy.js")>()),
  MAX_AGENT_DIRECTORY_ENTRIES: 8,
}));

const scope = { scope: "agent-directory" as const };

function file(relative: string): SnapshotFile {
  const bytes = Buffer.from("incoming");
  return {
    path: relative,
    contentBase64: bytes.toString("base64"),
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

function incoming(before: Snapshot, ...paths: string[]): Snapshot {
  return { ...before, files: paths.map(file) };
}

async function fixture(run: (root: string) => Promise<void>) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "pi-sync-inventory-")));
  try {
    configureEngineHost({ root: () => root, mutate: async (_target, action) => action(), review: async () => true });
    await run(root);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

async function createEmptyDirectories(root: string, count: number) {
  await Promise.all(Array.from({ length: count }, (_, index) => fs.mkdir(path.join(root, `empty-${index}`))));
}

test("directional projection counts retained entries absent from the payload", () =>
  fixture(async (root) => {
    const options = { ...scope, exclude: ["ignored"] };
    await createEmptyDirectories(root, entryLimit - 3);
    await fs.mkdir(path.join(root, "ignored", "unvisited"), { recursive: true });
    await fs.mkdir(path.join(root, "sessions"));
    await fs.writeFile(path.join(root, "auth.json"), "fixture");
    const before = await createSnapshot("test", options);
    assert.equal(agentDirectoryInventory(before)?.entries.size, entryLimit);
    assert.deepEqual(before.files, []);
    assert.equal(agentDirectoryInventory(JSON.parse(JSON.stringify(before))), undefined);
    assert.doesNotMatch(JSON.stringify(before), /unvisited|empty-0|auth\.json/);
    await assert.rejects(
      applySnapshot(incoming(before, "new.md"), new Set(), { ...options, reviewedLocal: before }),
      /Projected agent directory exceeds the scan entry bound/,
    );
    await assert.rejects(fs.stat(path.join(root, "new.md")), { code: "ENOENT" });
  }));

test("directional projection subtracts deleted entries before checking the final count", () =>
  fixture(async (root) => {
    await createEmptyDirectories(root, entryLimit - 3);
    await fs.writeFile(path.join(root, "old-1"), "old");
    await fs.writeFile(path.join(root, "old-2"), "old");
    await fs.writeFile(path.join(root, "old-3"), "old");
    const before = await createSnapshot("test", scope);
    await applySnapshot(incoming(before, "new"), new Set(), { ...scope, reviewedLocal: before });
    const after = await createSnapshot("test", scope);
    assert.deepEqual(
      after.files.map(({ path }) => path),
      ["new"],
    );
    assert.equal(agentDirectoryInventory(after)?.entries.size, entryLimit - 1);
  }));

for (const fits of [true, false]) {
  test(`directional file-to-directory projection ${fits ? "fits" : "exceeds"} the entry bound`, () =>
    fixture(async (root) => {
      await createEmptyDirectories(root, entryLimit - (fits ? 4 : 3));
      await fs.writeFile(path.join(root, "work"), "reviewed file");
      const before = await createSnapshot("test", scope);
      const apply = applySnapshot(incoming(before, "work/sub/item.md"), new Set(), { ...scope, reviewedLocal: before });
      if (fits) {
        await apply;
        assert.equal(await fs.readFile(path.join(root, "work/sub/item.md"), "utf8"), "incoming");
        assert.equal(agentDirectoryInventory(await createSnapshot("test", scope))?.entries.size, entryLimit);
      } else {
        await assert.rejects(apply, /Projected agent directory exceeds the scan entry bound/);
        assert.equal(await fs.readFile(path.join(root, "work"), "utf8"), "reviewed file");
      }
    }));
}

for (const excludedRoute of [true, false]) {
  test(`directional projection counts a missing nested session route with ${excludedRoute ? "excluded" : "selected"} physical parents`, () =>
    fixture(async (root) => {
      await createEmptyDirectories(root, entryLimit - 4);
      const options = {
        ...scope,
        include: ["sessions"],
        exclude: excludedRoute ? ["route"] : [],
        sessionDir: path.join(root, "route/store"),
      };
      const before = await createSnapshot("test", options);
      const apply = applySnapshot(incoming(before, "sessions/folder/item.jsonl"), new Set(), {
        ...options,
        reviewedLocal: before,
      });
      if (excludedRoute) {
        await apply;
        assert.equal(await fs.readFile(path.join(root, "route/store/folder/item.jsonl"), "utf8"), "incoming");
        assert.equal(agentDirectoryInventory(await createSnapshot("test", options))?.entries.size, entryLimit);
      } else {
        await assert.rejects(apply, /Projected agent directory exceeds the scan entry bound/);
        await assert.rejects(fs.stat(path.join(root, "route")), { code: "ENOENT" });
      }
    }));
}

test("projection counts retained non-session entries in selected session storage", () =>
  fixture(async (root) => {
    await createEmptyDirectories(root, entryLimit - 3);
    await fs.mkdir(path.join(root, "sessions"));
    await fs.writeFile(path.join(root, "sessions", "metadata.txt"), "non-session metadata");
    const options = { ...scope, include: ["sessions"] };
    const before = await createSnapshot("test", options);
    assert.deepEqual(before.files, []);
    await assert.rejects(
      applySnapshot(incoming(before, "sessions/new.jsonl"), new Set(), { ...options, reviewedLocal: before }),
      /exceeds the scan entry bound/,
    );
    assert.equal(await fs.readFile(path.join(root, "sessions", "metadata.txt"), "utf8"), "non-session metadata");
  }));

for (const contents of [
  "all-empty",
  "mixed",
  "new empty after review",
  "new empty while queuing",
  "excluded child",
] as const) {
  test(`directional directory replacement: ${contents}`, () =>
    fixture(async (root) => {
      const target = path.join(root, "tree");
      const added = path.join(target, "added");
      await fs.mkdir(path.join(target, "empty/deeper"), { recursive: true });
      if (contents !== "all-empty") await fs.writeFile(path.join(target, "note.md"), "reviewed child");
      const options = { ...scope, exclude: contents === "excluded child" ? ["tree/empty"] : [] };
      const before = await createSnapshot("test", options);
      if (contents === "new empty after review") await fs.mkdir(added);
      if (contents === "new empty while queuing") {
        const originalHost = engineHost();
        let queued = false;
        configureEngineHost({
          ...originalHost,
          mutate: async (key, run) => {
            if (!queued) {
              queued = true;
              await fs.mkdir(added);
            }
            return originalHost.mutate(key, run);
          },
        });
      }
      const apply = applySnapshot(incoming(before, "tree"), new Set(), { ...options, reviewedLocal: before });
      if (contents === "all-empty" || contents === "mixed") {
        await apply;
        assert.equal(await fs.readFile(target, "utf8"), "incoming");
      } else {
        await assert.rejects(apply, contents === "excluded child" ? /excluded path/ : /preimage changed/);
        assert.equal(await fs.readFile(path.join(target, "note.md"), "utf8"), "reviewed child");
        assert.ok((await fs.stat(path.join(target, "empty/deeper"))).isDirectory());
      }
    }));
}

test("merge checks retained entries before publication and again on recovery", () =>
  fixture(async (root) => {
    await createEmptyDirectories(root, entryLimit - 1);
    const before = await createSnapshot("test", scope);
    const after = incoming(before, "new.md");
    await preflightMergedTargets(before, after, scope);
    await fs.mkdir(path.join(root, "new-empty"));
    const current = await createSnapshot("test", scope);
    await assert.rejects(preflightMergedTargets(current, after, scope), /exceeds the scan entry bound/);
    await assert.rejects(
      applyMergedSnapshot(JSON.parse(JSON.stringify(before)), after, new Set(), scope, async () => {}),
      /exceeds the scan entry bound/,
    );
    await assert.rejects(fs.stat(path.join(root, "new.md")), { code: "ENOENT" });
  }));

test("merge subtracts reviewed directory removals, even when recovery has already deleted a file", () =>
  fixture(async (root) => {
    await createEmptyDirectories(root, entryLimit - 3);
    const filePath = path.join(root, "tree", "nested", "old.md");
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, "old content");
    const before = await createSnapshot("test", scope);
    const after = incoming(before, "tree", "new.md", "another.md");
    await preflightMergedTargets(before, after, scope);
    await fs.rm(filePath);
    await applyMergedSnapshot(JSON.parse(JSON.stringify(before)), after, new Set(), scope, async () => {});
    const current = await createSnapshot("test", scope);
    assert.equal(agentDirectoryInventory(current)?.entries.size, entryLimit);
    assert.deepEqual(
      current.files.map(({ path }) => path),
      ["another.md", "new.md", "tree"],
    );
  }));

for (const lateDirectory of [false, true]) {
  test(`merge ${lateDirectory ? "refuses a retained entry added after projection" : "installs exactly at the entry bound"}`, () =>
    fixture(async (root) => {
      await createEmptyDirectories(root, entryLimit - 1);
      const before = await createSnapshot("test", scope);
      const after = incoming(before, "new.md");
      const release = vi.spyOn(fs, "opendir");
      const latePath = path.join(root, "late-empty");
      let inserted = false;
      try {
        const run = applyMergedSnapshot(JSON.parse(JSON.stringify(before)), after, new Set(), scope, async () => {
          if (!lateDirectory || inserted || !release.mock.calls.some(([target]) => target === root)) return;
          inserted = true;
          await fs.mkdir(latePath);
        });
        if (lateDirectory) {
          await assert.rejects(run, /Projected agent directory exceeds the scan entry bound/);
          assert.equal(inserted, true);
          assert.ok((await fs.stat(latePath)).isDirectory());
          await assert.rejects(fs.stat(path.join(root, "new.md")), { code: "ENOENT" });
        } else {
          await run;
          assert.equal(await fs.readFile(path.join(root, "new.md"), "utf8"), "incoming");
          assert.equal(agentDirectoryInventory(await createSnapshot("test", scope))?.entries.size, entryLimit);
        }
      } finally {
        release.mockRestore();
      }
    }));
}

test("merge refuses directories not authorized by the durable file preimage before deleting reviewed files", () =>
  fixture(async (root) => {
    const target = path.join(root, "tree");
    await fs.mkdir(path.join(target, "empty"), { recursive: true });
    await fs.writeFile(path.join(target, "note.md"), "reviewed child");
    const before = await createSnapshot("test", scope);
    const after = incoming(before, "tree");
    await assert.rejects(preflightMergedTargets(before, after, scope), /unreviewed directory/);
    await assert.rejects(
      applyMergedSnapshot(JSON.parse(JSON.stringify(before)), after, new Set(), scope, async () => {}),
      /unreviewed directory/,
    );
    assert.equal(await fs.readFile(path.join(target, "note.md"), "utf8"), "reviewed child");
  }));
