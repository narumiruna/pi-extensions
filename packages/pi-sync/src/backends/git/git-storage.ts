import { createHash } from "node:crypto";
import type { Snapshot, SnapshotSelection } from "../../snapshot/snapshot-types.js";
import { portableSnapshotSelection, snapshotSelectionInclude } from "../../sync/sync-policy.js";

export const GIT_MANIFEST_VERSION = 2;
export const MAX_GIT_MANIFEST_BYTES = 1024 * 1024;
export const MAX_GIT_TREE_OUTPUT_BYTES = 16 * 1024 * 1024;
export const MAX_GIT_PAYLOAD_BYTES = 100 * 1024 * 1024;
export const MAX_GIT_SNAPSHOT_BYTES = 512 * 1024 * 1024;
const SNAPSHOT_VERSION = 1;

export interface GitManifestFile {
  path: string;
  sha256: string;
  size: number;
}

export interface GitManifest {
  version: number;
  snapshotVersion: number;
  snapshotId: string;
  createdAt: string;
  machine: string;
  profile: string;
  syncSessions: boolean;
  snapshotSyncSessions?: boolean;
  selection?: SnapshotSelection;
  files: GitManifestFile[];
}

export interface PreparedGitFile extends GitManifestFile {
  content: Buffer;
}

export interface GitTreeEntry {
  mode: string;
  type: string;
  object: string;
  path: string;
}

export function isGitPayloadSizeAllowed(size: number) {
  return Number.isSafeInteger(size) && size >= 0 && size <= MAX_GIT_PAYLOAD_BYTES;
}

export function requireGitManifest(value: unknown): GitManifest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Git publication manifest is malformed.");
  }
  const manifest = value as Partial<GitManifest>;
  if (manifest.version === 1) {
    throw new Error(
      "Git publication uses the unsupported pre-release gzip format; recreate this pi-sync-owned test branch.",
    );
  }
  if (
    manifest.version !== GIT_MANIFEST_VERSION ||
    manifest.snapshotVersion !== SNAPSHOT_VERSION ||
    typeof manifest.snapshotId !== "string" ||
    manifest.snapshotId.length > 512 ||
    !/^[A-Za-z0-9._-]+$/u.test(manifest.snapshotId) ||
    typeof manifest.createdAt !== "string" ||
    manifest.createdAt.length > 64 ||
    hasControlCharacter(manifest.createdAt) ||
    Number.isNaN(Date.parse(manifest.createdAt)) ||
    typeof manifest.machine !== "string" ||
    manifest.machine.length > 256 ||
    hasControlCharacter(manifest.machine) ||
    typeof manifest.profile !== "string" ||
    manifest.profile.length === 0 ||
    manifest.profile.length > 256 ||
    hasControlCharacter(manifest.profile) ||
    typeof manifest.syncSessions !== "boolean" ||
    (manifest.snapshotSyncSessions !== undefined && typeof manifest.snapshotSyncSessions !== "boolean") ||
    !Array.isArray(manifest.files) ||
    !hasExactKeys(manifest as Record<string, unknown>, [
      "version",
      "snapshotVersion",
      "snapshotId",
      "createdAt",
      "machine",
      "profile",
      "syncSessions",
      ...(manifest.snapshotSyncSessions === undefined ? [] : ["snapshotSyncSessions"]),
      ...(manifest.selection === undefined ? [] : ["selection"]),
      "files",
    ])
  ) {
    throw new Error("Git publication manifest is malformed.");
  }
  if (manifest.selection !== undefined) portableSnapshotSelection(manifest.selection);
  let total = 0;
  const paths = new Set<string>();
  for (const rawFile of manifest.files) {
    if (!rawFile || typeof rawFile !== "object" || Array.isArray(rawFile)) {
      throw new Error("Git publication manifest file is malformed.");
    }
    const file = rawFile as Partial<GitManifestFile>;
    if (
      !hasExactKeys(file as Record<string, unknown>, ["path", "sha256", "size"]) ||
      !isSafeSnapshotPath(file.path) ||
      typeof file.sha256 !== "string" ||
      !/^[0-9a-f]{64}$/u.test(file.sha256) ||
      typeof file.size !== "number" ||
      !isGitPayloadSizeAllowed(file.size) ||
      paths.has(file.path)
    ) {
      throw new Error("Git publication manifest file is malformed.");
    }
    total += file.size;
    if (!Number.isSafeInteger(total) || total > MAX_GIT_SNAPSHOT_BYTES) {
      throw new Error(`Git snapshot content exceeds the ${MAX_GIT_SNAPSHOT_BYTES}-byte limit.`);
    }
    paths.add(file.path);
  }
  assertNoPathConflicts([...paths]);
  return manifest as GitManifest;
}

export function validateGitSnapshot(snapshot: Snapshot, manifest: GitManifest, namespace: string) {
  const prepared = prepareGitSnapshot(snapshot, namespace);
  const syncSessions =
    snapshot.syncSessions === true || snapshot.files.some((file) => file.path.startsWith("sessions/"));
  if (
    snapshot.id !== manifest.snapshotId ||
    snapshot.createdAt !== manifest.createdAt ||
    snapshot.machine !== manifest.machine ||
    snapshot.profile !== manifest.profile ||
    snapshot.syncSessions !== manifest.snapshotSyncSessions ||
    syncSessions !== manifest.syncSessions ||
    !sameOptionalInclude(
      snapshotSelectionInclude(snapshot),
      manifest.selection === undefined ? undefined : portableSnapshotSelection(manifest.selection).include,
    ) ||
    prepared.length !== manifest.files.length ||
    prepared.some((file, index) => {
      const expected = manifest.files[index];
      return !expected || file.path !== expected.path || file.sha256 !== expected.sha256 || file.size !== expected.size;
    })
  ) {
    throw new Error("Git snapshot identity does not match its publication manifest.");
  }
}

export function prepareGitSnapshot(snapshot: Snapshot, namespace: string) {
  snapshotSelectionInclude(snapshot);
  if (
    snapshot.version !== SNAPSHOT_VERSION ||
    typeof snapshot.id !== "string" ||
    !snapshot.id ||
    snapshot.id.length > 512 ||
    !/^[A-Za-z0-9._-]+$/u.test(snapshot.id) ||
    snapshot.profile !== namespace ||
    !Array.isArray(snapshot.files) ||
    typeof snapshot.createdAt !== "string" ||
    !snapshot.createdAt ||
    snapshot.createdAt.length > 64 ||
    hasControlCharacter(snapshot.createdAt) ||
    Number.isNaN(Date.parse(snapshot.createdAt)) ||
    typeof snapshot.machine !== "string" ||
    snapshot.machine.length > 256 ||
    hasControlCharacter(snapshot.machine)
  ) {
    throw new Error("Invalid Git snapshot publication.");
  }
  const paths = new Set<string>();
  const prepared: PreparedGitFile[] = [];
  let total = 0;
  for (const file of snapshot.files) {
    if (
      !isSafeSnapshotPath(file.path) ||
      typeof file.contentBase64 !== "string" ||
      typeof file.sha256 !== "string" ||
      !/^[0-9a-f]{64}$/u.test(file.sha256) ||
      paths.has(file.path)
    ) {
      throw new Error("Invalid Git snapshot file.");
    }
    const content = Buffer.from(file.contentBase64, "base64");
    if (content.toString("base64") !== file.contentBase64 || sha256(content) !== file.sha256) {
      throw new Error("Git snapshot file checksum mismatch.");
    }
    if (!isGitPayloadSizeAllowed(content.byteLength)) {
      throw new Error(
        `Git snapshot file exceeds GitHub's ${MAX_GIT_PAYLOAD_BYTES}-byte regular-Git limit: ${file.path}`,
      );
    }
    total += content.byteLength;
    if (!Number.isSafeInteger(total) || total > MAX_GIT_SNAPSHOT_BYTES) {
      throw new Error(`Git snapshot content exceeds the ${MAX_GIT_SNAPSHOT_BYTES}-byte limit.`);
    }
    paths.add(file.path);
    prepared.push({ path: file.path, sha256: file.sha256, size: content.byteLength, content });
  }
  assertNoPathConflicts([...paths]);
  return prepared;
}

export function parseGitTree(output: Buffer): GitTreeEntry[] {
  if (output.byteLength === 0) return [];
  if (output.at(-1) !== 0) throw new Error("Git publication tree response is malformed.");
  return output
    .subarray(0, -1)
    .toString("utf8")
    .split("\0")
    .map((line) => {
      const match = /^(?<mode>[0-9]{6}) (?<type>blob|tree|commit) (?<object>[0-9a-f]{40})\t(?<path>.+)$/u.exec(line);
      if (!match?.groups || hasControlCharacter(match.groups.path)) {
        throw new Error("Git publication tree response is malformed.");
      }
      return {
        mode: match.groups.mode,
        type: match.groups.type,
        object: match.groups.object,
        path: match.groups.path,
      };
    });
}

export function validateGitPublicationTree(
  entries: GitTreeEntry[],
  manifest: GitManifest,
  manifestPath: string,
  filePath: (path: string) => string,
) {
  const byPath = new Map<string, GitTreeEntry>();
  for (const entry of entries) {
    if (byPath.has(entry.path)) throw new Error("Git publication tree contains duplicate paths.");
    byPath.set(entry.path, entry);
  }
  const expectedPaths = [manifestPath, ...manifest.files.map((file) => filePath(file.path))];
  if (entries.length !== expectedPaths.length || expectedPaths.some((path) => !byPath.has(path))) {
    throw new Error("Git publication tree has missing or extra files.");
  }
  for (const expectedPath of expectedPaths) {
    const entry = byPath.get(expectedPath);
    if (entry?.mode !== "100644" || entry.type !== "blob") {
      throw new Error(`Git publication tree contains a non-regular file: ${expectedPath}`);
    }
  }
  return manifest.files.map((file) => byPath.get(filePath(file.path)) as GitTreeEntry);
}

function sameOptionalInclude(left: string[] | undefined, right: string[] | undefined) {
  if (!left || !right) return left === right;
  return left.length === right.length && left.every((item, index) => item === right[index]);
}

function isSafeSnapshotPath(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 4096 &&
    !value.startsWith("/") &&
    !value.includes("\\") &&
    !hasControlCharacter(value) &&
    value
      .split("/")
      .every((segment) => segment && segment !== "." && segment !== ".." && segment.toLowerCase() !== ".git")
  );
}

function hasExactKeys(value: Record<string, unknown>, expected: string[]) {
  const keys = Object.keys(value).sort();
  const expectedKeys = [...expected].sort();
  return keys.length === expectedKeys.length && keys.every((key, index) => key === expectedKeys[index]);
}

function assertNoPathConflicts(paths: string[]) {
  const sorted = [...paths].sort();
  for (let index = 1; index < sorted.length; index += 1) {
    const parent = sorted[index - 1];
    const child = sorted[index];
    if (parent && child?.startsWith(`${parent}/`)) {
      throw new Error(`Git snapshot file path conflict: ${parent} and ${child}`);
    }
  }
}

function sha256(value: Buffer) {
  return createHash("sha256").update(value).digest("hex");
}

function hasControlCharacter(value: string) {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: Reject untrusted terminal/ref controls.
  return /[\u0000-\u001f\u007f-\u009f]/u.test(value);
}
