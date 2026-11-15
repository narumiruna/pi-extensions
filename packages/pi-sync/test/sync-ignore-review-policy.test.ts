import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { test } from "vitest";
import {
  type GitManifest,
  prepareGitSnapshot,
  requireGitManifest,
  validateGitSnapshot,
} from "../src/backends/git/git-storage.js";
import { collectFiles, filterSnapshotForConfigPolicy, mergeRemotePreservedFiles } from "../src/snapshot/snapshot.js";
import type { Snapshot, SnapshotSelection } from "../src/snapshot/snapshot-types.js";
import { hasLocalChanges } from "../src/sync/sync-state.js";
import { snapshot, withTempHome } from "./helpers.js";

for (const location of ["history", "nested/history", ".", "../outside", "alias"])
  for (const enabled of [false, true])
    test(`physical session root ${location}, sessions enabled=${enabled}`, async () =>
      withTempHome(async (root) => {
        await fs.mkdir(root, { recursive: true });
        const sessionDir = path.resolve(root, location);
        if (location === "alias") {
          const actual = path.join(root, "real-history");
          await fs.mkdir(actual);
          await fs.symlink(actual, sessionDir);
        }
        await fs.mkdir(path.join(sessionDir, "project"), { recursive: true });
        await fs.writeFile(path.join(sessionDir, "project/conversation.jsonl"), "private conversation\n");
        await fs.writeFile(path.join(sessionDir, "project/not-a-session.txt"), "private auxiliary bytes\n");
        const files = await collectFiles(root, { syncIgnore: enabled ? "" : "/sessions/\n", sessionDir });
        const conversations = files.filter((file) =>
          Buffer.from(file.contentBase64, "base64").toString().includes("private"),
        );
        assert.deepEqual(
          conversations.map((file) => file.path),
          enabled ? ["sessions/project/conversation.jsonl"] : [],
        );
        assert.equal(
          files.some((file) => file.path.includes("not-a-session")),
          false,
        );
      }));

test("ignore filtering and accepted state keep exact case-sensitive file identities", () => {
  const source = snapshot([
    { path: "Notes.md", content: Buffer.from("upper") },
    { path: "notes.md", content: Buffer.from("lower") },
    { path: "SETTINGS.JSON", content: Buffer.from("upper settings") },
  ]);
  const config = { syncIgnore: "/settings.json\n" };
  const filtered = filterSnapshotForConfigPolicy(source, config);
  assert.deepEqual(filtered.files.map((file) => file.path).sort(), ["Notes.md", "SETTINGS.JSON", "notes.md"].sort());
  const state = {
    version: 2,
    profile: "default",
    syncIgnore: config.syncIgnore,
    lastFileHashes: Object.fromEntries(source.files.map((file) => [file.path, file.sha256])),
  };
  assert.equal(hasLocalChanges(filtered, state, config), false);
});

test("remote preservation retains ignored names even when a selected path differs only by case", () => {
  const local = snapshot([{ path: "notes.md", content: Buffer.from("local") }]);
  const remote = snapshot([{ path: "Notes.md", content: Buffer.from("remote ignored") }]);
  const result = mergeRemotePreservedFiles(local, remote, { syncIgnore: "/Notes.md\n" });
  assert.deepEqual(result.files.map((file) => file.path).sort(), ["Notes.md", "notes.md"]);
});

for (const selection of [
  undefined,
  { include: ["settings.json"], version: 1 } as SnapshotSelection,
  { ignore: "/sessions/\n", version: 2 } as SnapshotSelection,
])
  test(`Git selection comparison ignores object-key order, version=${selection?.version ?? "absent"}`, () => {
    const source: Snapshot = {
      ...snapshot(selection?.version === 2 ? [{ path: ".syncignore", content: Buffer.from(selection.ignore) }] : []),
      version: selection?.version === 2 ? 4 : 1,
      syncSessions: false,
      ...(selection ? { selection } : {}),
    };
    const files = prepareGitSnapshot(source, source.profile);
    const normalized =
      selection?.version === 2
        ? { version: 2 as const, ignore: selection.ignore }
        : selection?.version === 1
          ? { version: 1 as const, include: selection.include }
          : undefined;
    const manifest: GitManifest = {
      version: 2,
      snapshotVersion: source.version,
      snapshotId: source.id,
      createdAt: source.createdAt,
      machine: source.machine,
      profile: source.profile,
      syncSessions: false,
      snapshotSyncSessions: false,
      ...(normalized ? { selection: normalized } : {}),
      files: files.map(({ content: _content, ...file }) => file),
    };
    const validated = requireGitManifest(manifest);
    assert.doesNotThrow(() => validateGitSnapshot(source, validated, source.profile));
    if (selection)
      assert.equal(
        filterSnapshotForConfigPolicy(
          source,
          selection.version === 2 ? { syncIgnore: selection.ignore } : { include: selection.include },
          { regenerateId: true },
        ).id,
        source.id,
      );
  });
