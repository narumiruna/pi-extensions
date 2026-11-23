import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "vitest";
import {
  GIT_MANIFEST_VERSION,
  prepareGitSnapshot,
  requireGitManifest,
} from "../src/engine/backends/git/git-storage.js";
import { compileIgnoreRules, ignorePolicyFingerprint, ignoreSourceDigest } from "../src/engine/ignore/ignore-source.js";
import { selectSnapshotIgnoreRules } from "../src/engine/ignore/snapshot-ignore-rules.js";
import { decodeSnapshot, encodeSnapshot } from "../src/engine/snapshot/snapshot-codec.js";
import { RULES_SNAPSHOT_VERSION, type Snapshot } from "../src/engine/snapshot/snapshot-types.js";

function snapshot(text: string, filename = ".syncignore"): Snapshot {
  return {
    version: RULES_SNAPSHOT_VERSION,
    id: "fixture",
    createdAt: "2026-01-01T00:00:00Z",
    machine: "fixture",
    profile: "fixture",
    selection: {
      version: 4,
      scope: "agent-directory",
      sessions: false,
      fingerprint: ignorePolicyFingerprint(text, false),
    },
    ignoreRules: { filename, text },
    files: [],
  };
}

test.each([
  [".syncignore", "", true],
  [".syncignore", "/.syncignore\n", false],
  [".syncignore", "/.syncignore\n!/.syncignore\n", true],
  [".syncignore", "/.SYNCIGNORE\n/.syncignore/\n", true],
  ["Local.rules", "*.rules\n", false],
  ["Local.rules", "*.rules\n!/Local.rules\n", true],
])("selects %s with rules %j only when it doesn't exclude itself", (filename, text, included) => {
  const sourceDigest = ignoreSourceDigest(filename, true, Buffer.from(text));
  const source = { filename, text, sourceDigest, present: true as const, identity: "1:1:1" };
  const policy = {
    filename,
    sourceDigest,
    fingerprint: ignorePolicyFingerprint(text, false),
    sessions: false,
    reservedNames: [filename],
    matches: compileIgnoreRules(text),
  };
  assert.deepEqual(selectSnapshotIgnoreRules(source, policy), included ? { filename, text } : null);
  assert.throws(() => selectSnapshotIgnoreRules({ ...source, sourceDigest: "different" }, policy), /changed/u);
});

test.each(["", "\uFEFF# Rules\r\n/private/\r\n# no final newline", "/.syncignore\n"])(
  "round-trips exact rules for %j",
  async (text) => {
    const image = snapshot(text);
    if (compileIgnoreRules(text)(".syncignore")) image.ignoreRules = null;
    assert.deepEqual(await decodeSnapshot(await encodeSnapshot(image)), image);
    const manifest = {
      version: GIT_MANIFEST_VERSION,
      snapshotVersion: image.version,
      snapshotId: image.id,
      createdAt: image.createdAt,
      machine: image.machine,
      profile: image.profile,
      syncSessions: false,
      selection: image.selection,
      ignoreRules: image.ignoreRules,
      files: [],
    };
    assert.deepEqual(requireGitManifest(JSON.parse(JSON.stringify(manifest))).ignoreRules, image.ignoreRules);
    assert.deepEqual(prepareGitSnapshot(image, image.profile), []);
    assert.throws(() => requireGitManifest({ ...manifest, snapshotVersion: 6 }), /Unexpected.*ignore rules/u);
  },
);

test("refuses rules that exclude themselves, duplicate active source, edited rule text, or excluded data", async () => {
  for (const variant of [
    snapshot("/.syncignore\n"),
    { ...snapshot(""), ignoreRules: { filename: ".syncignore", text: "changed" } },
    snapshot("#".repeat(65537)),
    snapshot("bad\\/rule"),
    snapshot("# valid", "auth.json"),
    { ...snapshot(""), ignoreRules: undefined },
  ])
    await assert.rejects(encodeSnapshot(variant));
  const image = snapshot("/private.txt\n", "Local.rules");
  for (const path of ["Local.rules", ".syncignore", "private.txt", "auth.json", "sessions/off.jsonl"]) {
    const payload = { ...image, files: [{ path, contentBase64: "", sha256: createHash("sha256").digest("hex") }] };
    await assert.rejects(encodeSnapshot(payload), /excluded or unsafe/u);
  }
});

test("still reads a version 6 snapshot with only the ignore-policy fingerprint", async () => {
  const { ignoreRules: _ignoreRules, ...image } = snapshot("");
  const legacy = { ...image, version: 6 };
  assert.deepEqual(await decodeSnapshot(await encodeSnapshot(legacy)), legacy);
});
