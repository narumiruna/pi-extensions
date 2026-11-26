import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { test } from "vitest";
import { prepareGitSnapshot, requireGitManifest } from "../src/engine/backends/git/git-storage.js";
import { isDeniedPath } from "../src/engine/paths.js";
import { applySnapshot } from "../src/engine/snapshot/snapshot-apply.js";
import { decodeSnapshot, encodeSnapshot } from "../src/engine/snapshot/snapshot-codec.js";
import type { Snapshot } from "../src/engine/snapshot/snapshot-types.js";
import {
  compileSyncPolicyTraversal,
  configuredSnapshotPathMatcher,
  normalizeSyncInclude,
} from "../src/engine/sync/sync-policy.js";

const directory = { scope: "agent-directory", include: [], reinclude: ["**"] } as const;
const error = /local-only pi-sync\.log\. Review the old snapshot/u;
const aliases = ["pi-sync.log", "PI-SYNC.LOG", "pi-sync.log/path", "pi-sync.log.", "pi-sync.log:stream"];

function oldSnapshot(path: string): Snapshot {
  const content = Buffer.from("foreign data");
  return {
    version: 1,
    id: "old",
    createdAt: "2026-01-01T00:00:00Z",
    machine: "test",
    profile: "default",
    files: [
      { path, contentBase64: content.toString("base64"), sha256: createHash("sha256").update(content).digest("hex") },
    ],
  };
}

test("directory policy keeps the root log local despite broad re-inclusion", () => {
  const matches = configuredSnapshotPathMatcher(directory);
  const traverse = compileSyncPolicyTraversal(directory);
  assert.equal(matches("portable.md"), true);
  for (const alias of aliases) {
    assert.equal(matches(alias), false, alias);
    assert.equal(traverse(alias), false, alias);
    assert.equal(isDeniedPath(alias), true, alias);
    assert.throws(() => normalizeSyncInclude([alias]), /cannot be synced/u, alias);
  }
  for (const _name of ["pi-sync.log", "PI-SYNC.LOG"]) assert.equal(isDeniedPath("notes/pi-sync.log"), false);
});

test("old object and Git snapshots containing the log are rejected without applying or rewriting", async () => {
  for (const alias of aliases) {
    const snapshot = oldSnapshot(alias);
    await assert.rejects(decodeSnapshot(gzipSync(JSON.stringify(snapshot))), error);
    await assert.rejects(encodeSnapshot(snapshot), error);
    await assert.rejects(applySnapshot(snapshot), error);
    assert.throws(() => prepareGitSnapshot(snapshot, "default"), error);
    assert.throws(
      () =>
        requireGitManifest({
          version: 2,
          snapshotVersion: 1,
          snapshotId: snapshot.id,
          createdAt: snapshot.createdAt,
          machine: snapshot.machine,
          profile: snapshot.profile,
          syncSessions: false,
          files: [{ path: alias, sha256: snapshot.files[0].sha256, size: 12 }],
        }),
      error,
    );
  }
  const portable = oldSnapshot("notes/pi-sync.log");
  assert.deepEqual(await decodeSnapshot(await encodeSnapshot(portable)), portable);
});
