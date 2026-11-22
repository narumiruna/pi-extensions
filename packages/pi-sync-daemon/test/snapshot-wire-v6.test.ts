import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { test, vi } from "vitest";
import { GitSyncBackend } from "../src/engine/backends/git/git-backend.js";
import { runGit } from "../src/engine/backends/git/git-runner.js";
import {
  GIT_MANIFEST_VERSION,
  type GitManifest,
  prepareGitSnapshot,
  requireGitManifest,
  validateGitSnapshot,
} from "../src/engine/backends/git/git-storage.js";
import { expectedRemoteHead } from "../src/engine/backends/sync-backend.js";
import { applySnapshot } from "../src/engine/snapshot/snapshot-apply.js";
import { MAX_AGENT_DIRECTORY_BYTES } from "../src/engine/snapshot/snapshot-bounds.js";
import { decodeSnapshot, encodeSnapshot } from "../src/engine/snapshot/snapshot-codec.js";
import type { IgnoreSnapshotSelection, Snapshot, SnapshotFile } from "../src/engine/snapshot/snapshot-types.js";
import { validatePortableSnapshot } from "../src/engine/sync/local-fields.js";
import { readSnapshotForHead } from "../src/engine/sync/remote-snapshot.js";
import { MAX_AGENT_DIRECTORY_FILES } from "../src/engine/sync/sync-policy.js";

const policy: IgnoreSnapshotSelection = {
  version: 4,
  scope: "agent-directory",
  fingerprint: "a".repeat(64),
  sessions: false,
};

function file(relative: string, content = "x"): SnapshotFile {
  const bytes = Buffer.from(content);
  return {
    path: relative,
    contentBase64: bytes.toString("base64"),
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

function snapshot(files: SnapshotFile[] = [], sessions = false): Snapshot {
  return {
    version: 6,
    id: "test-snapshot",
    createdAt: "2026-01-01T00:00:00.000Z",
    machine: "test-machine",
    profile: "test",
    syncSessions: false,
    selection: { ...policy, sessions },
    files,
  };
}

function manifest(image: Snapshot): GitManifest {
  return {
    version: GIT_MANIFEST_VERSION,
    snapshotVersion: image.version,
    snapshotId: image.id,
    createdAt: image.createdAt,
    machine: image.machine,
    profile: image.profile,
    syncSessions:
      image.syncSessions === true || image.files.some(({ path: relative }) => relative.startsWith("sessions/")),
    snapshotSyncSessions: image.syncSessions,
    selection: image.selection,
    ...(image.localFields === undefined ? {} : { localFields: image.localFields }),
    files: image.files.map(({ path: relative, sha256, contentBase64 }) => ({
      path: relative,
      sha256,
      size: Buffer.byteLength(contentBase64, "base64"),
    })),
  };
}

function jsonGzip(image: unknown) {
  return gzipSync(JSON.stringify(image));
}

async function rejectsGzip(image: unknown, error: RegExp) {
  await assert.rejects(decodeSnapshot(jsonGzip(image)), error);
  await assert.rejects(encodeSnapshot(image as Snapshot), error);
}

test("v6 gzip and Git carry only portable policy intent, independent of file presence", async () => {
  for (const image of [
    snapshot(),
    snapshot([], true),
    snapshot([file("npm/file"), file("truth.json"), file("docs/local-rules")]),
    { ...snapshot([file("sessions/project/s.jsonl")], true), syncSessions: true },
  ]) {
    const compressed = await encodeSnapshot(image);
    const wire = JSON.parse(gunzipSync(compressed).toString("utf8"));
    assert.deepEqual(wire.selection, image.selection);
    assert.deepEqual(Object.keys(wire.selection).sort(), ["fingerprint", "scope", "sessions", "version"]);
    assert.deepEqual(await decodeSnapshot(compressed), image);
    const declared = manifest(image);
    assert.deepEqual(requireGitManifest(declared), declared);
    validateGitSnapshot(image, declared, image.profile);
  }
  const image = snapshot();
  const changed = { ...image, selection: { ...policy, fingerprint: "b".repeat(64) } };
  assert.throws(() => validateGitSnapshot(changed, manifest(image), image.profile), /does not match/);
});

test("v6 and v4 are paired, and private or malformed selection fields are refused", async () => {
  const image = snapshot();
  const badVersions = [
    { ...image, selection: undefined },
    { ...image, selection: { version: 1, include: [] } },
    { ...image, version: 5 },
    { ...image, version: 7 },
    { ...image, version: "6" },
  ];
  const badSelections = [
    { ...policy, version: "4" },
    { ...policy, scope: "selected-paths" },
    { ...policy, sessions: undefined },
    { ...policy, sessions: "true" },
    { ...policy, fingerprint: undefined },
    { ...policy, fingerprint: "a".repeat(63) },
    { ...policy, fingerprint: `a${"a".repeat(63)}\n` },
    { ...policy, fingerprint: "A".repeat(64) },
    { ...policy, include: [] },
    { ...policy, exclude: [] },
    { ...policy, reinclude: [] },
    { ...policy, ignoreFile: ".private.syncignore" },
    { ...policy, rules: "/private/" },
  ].map((selection) => ({ ...image, selection }));
  for (const invalid of [...badVersions, ...badSelections]) {
    await rejectsGzip(invalid, /policy|Unsupported snapshot format/);
    assert.throws(() => requireGitManifest(manifest(invalid as Snapshot)), /policy|manifest is malformed/);
  }
  await rejectsGzip({ ...image, ignoreFile: ".private.syncignore" }, /payload/);
  assert.throws(() => requireGitManifest({ ...manifest(image), rules: "/private/" }), /manifest is malformed/);
});

test("v6 wire validation retains hard path protections and the session opt-in", async () => {
  for (const relative of [
    "auth.json",
    "TRUST.json/child",
    "pi-sync.json",
    "pi-sync/state.db",
    "skills/.git/config",
    "skills/.env/child",
    ".syncignore",
    ".SYNCIGNORE/child",
    "../outside.md",
    "C:/outside.md",
    "docs/AUX.md",
    "docs/file. ",
    "docs/\ud800.md",
    "sessions",
    "sessions/project/s.txt",
    "Sessions/project/s.jsonl",
  ]) {
    const image = snapshot([file(relative)], true);
    await rejectsGzip(image, /unsafe agent-directory paths/);
    assert.throws(() => requireGitManifest(manifest(image)), /manifest file is malformed/, relative);
  }
  const optedOut = snapshot([file("sessions/project/s.jsonl")]);
  await rejectsGzip(optedOut, /unsafe agent-directory paths/);
  assert.throws(() => requireGitManifest(manifest(optedOut)), /manifest file is malformed/);
  for (const syncSessions of [true, "false"]) {
    const invalid = { ...snapshot(), syncSessions };
    await rejectsGzip(invalid, /session metadata/);
    assert.throws(() => requireGitManifest(manifest(invalid as Snapshot)), /session metadata|manifest is malformed/);
  }
  const enabledWithNoSessions = manifest(snapshot([], true));
  assert.throws(() => requireGitManifest({ ...enabledWithNoSessions, syncSessions: true }), /session metadata/);
  const enabledWithSession = manifest(snapshot([file("sessions/project/s.jsonl")], true));
  assert.throws(() => requireGitManifest({ ...enabledWithSession, syncSessions: false }), /session metadata/);
});

test("v6 refuses malformed file bytes, portable settings fields, and invalid UTF-8", async () => {
  const entry = file("test.txt");
  for (const invalid of [
    { ...entry, contentBase64: "!$@#" },
    { ...entry, contentBase64: "eB==" },
    { ...entry, sha256: "0".repeat(64) },
    { ...entry, sha256: `${entry.sha256}\n` },
    { ...entry, rules: "private" },
  ]) {
    const image = snapshot([invalid]);
    await rejectsGzip(image, /base64|checksum|file/);
    assert.throws(() => prepareGitSnapshot(image, image.profile), /base64|checksum|file/);
  }
  const image = { ...snapshot([file("settings.json", '{"privateField":true}')]), localFields: ["privateField"] };
  await rejectsGzip(image, /retains excluded fields/);
  assert.throws(() => prepareGitSnapshot(image, image.profile), /retains excluded fields/);
  const broken = Buffer.from(JSON.stringify({ ...snapshot(), machine: "!" }));
  broken[broken.indexOf(33)] = 0xff;
  await assert.rejects(decodeSnapshot(gzipSync(broken)), /UTF-8/);
  await assert.rejects(decodeSnapshot(jsonGzip(snapshot()), { maxOutputLength: 10 }), /byte limit/);
});

test("v6 checks portable path layout and Git checks declared size before fetching blobs", async () => {
  for (const paths of [
    ["one", "one/child"],
    ["a/file", "A/other"],
    ["é", "e\u0301"],
    ["same", "same"],
  ]) {
    const image = snapshot(paths.map((relative) => file(relative)));
    await rejectsGzip(image, /conflicting portable paths/);
    assert.throws(() => requireGitManifest(manifest(image)), /conflicting portable paths|manifest file is malformed/);
  }
  const many = snapshot(Array.from({ length: MAX_AGENT_DIRECTORY_FILES + 1 }, (_, i) => file(`empty-${i}`, "")));
  await rejectsGzip(many, /file bound/);
  assert.throws(() => requireGitManifest(manifest(many)), /file bound/);
  const declared = manifest(snapshot([file("a"), file("b")]));
  for (const entry of declared.files) entry.size = MAX_AGENT_DIRECTORY_BYTES / 2;
  requireGitManifest(declared);
  const [first] = declared.files;
  assert.ok(first);
  first.size += 1;
  assert.throws(() => requireGitManifest(declared), /byte limit/);
  const settings = manifest(snapshot([file("settings.json", "{}")]));
  const [settingsFile] = settings.files;
  assert.ok(settingsFile);
  settingsFile.size = 1024 * 1024 + 1;
  assert.throws(() => requireGitManifest(settings), /settings\.json.*byte bound/);
});

test("legacy v1 through v5 keep their gzip bytes and policy behavior", async () => {
  const image = { ...snapshot([file("notes.md")]), selection: undefined };
  const legacyImages: Snapshot[] = [
    { ...image, version: 1 },
    { ...image, version: 1, selection: { version: 1, include: ["notes.md"] } },
    { ...image, version: 2, localFields: [] },
    { ...image, version: 3 },
    { ...image, version: 4, selection: { version: 2, include: ["notes.md"], exclude: ["private"] } },
    {
      ...image,
      version: 5,
      selection: { version: 3, scope: "agent-directory", include: [], exclude: [], reinclude: [] },
      files: [file(".syncignore")],
    },
  ];
  for (const legacy of legacyImages) {
    assert.deepEqual(await encodeSnapshot(legacy), jsonGzip(legacy));
    assert.deepEqual(await decodeSnapshot(jsonGzip(legacy)), JSON.parse(JSON.stringify(legacy)));
    validateGitSnapshot(legacy, requireGitManifest(JSON.parse(JSON.stringify(manifest(legacy)))), legacy.profile);
  }
});

test("local bare Git round-trips v6 while legacy read and apply refuse the same valid image", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-sync-wire-v6-"));
  try {
    const remote = path.join(root, "remote.git");
    await runGit(["-c", "init.templateDir=", "init", "--bare", "--object-format=sha1", remote]);
    const branch = "pi-sync/test";
    const backend = new GitSyncBackend(
      {
        type: "git",
        profile: { kind: "git", remote },
        destination: { branch, namespace: "test", directory: "pi-sync" },
      },
      { cacheRoot: path.join(root, "cache"), allowLocalRemotes: true },
    );
    const image = snapshot([file("notes.md")]);
    const legacy = { ...image, id: "legacy-before-activation", version: 1, selection: undefined };
    const first = await backend.publishSnapshot(legacy, { kind: "missing" });
    await assert.rejects(
      backend.publishSnapshot(image, expectedRemoteHead(first.head), {
        validateIgnorePolicy: async () => {
          throw new Error("reviewed rules changed");
        },
      }),
      /reviewed rules changed/u,
    );
    assert.deepEqual(await backend.readHead(), first.head);
    const { head } = await backend.publishSnapshot(image, expectedRemoteHead(first.head));
    assert.equal((await backend.readSnapshot(first.head.snapshotRef)).id, legacy.id);
    const { stdout } = await runGit(["show", `refs/heads/${branch}:pi-sync/manifest.json`], { gitDir: remote });
    assert.deepEqual(JSON.parse(stdout.toString("utf8")), manifest(image));
    assert.deepEqual(head.selection, image.selection);
    const update = vi.spyOn(Object.getPrototypeOf(createHash("sha256")), "update");
    try {
      const decoded = await backend.readSnapshot(head.snapshotRef);
      validatePortableSnapshot(decoded);
      assert.deepEqual(decoded, image);
      assert.equal(
        update.mock.calls.filter(([value]) => Buffer.isBuffer(value) && value.equals(Buffer.from("x"))).length,
        1,
      );
      const verified = decoded.files[0];
      assert.ok(verified);
      verified.sha256 = "a".repeat(64);
      assert.throws(() => validatePortableSnapshot(decoded), /checksum or encoding mismatch/);
    } finally {
      update.mockRestore();
    }
    await assert.rejects(readSnapshotForHead(backend, head), /cannot transfer an ignore-file snapshot/i);
    await assert.rejects(applySnapshot(image, new Set()), /cannot transfer an ignore-file snapshot/i);
    assert.deepEqual(await backend.readHead(), head);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
