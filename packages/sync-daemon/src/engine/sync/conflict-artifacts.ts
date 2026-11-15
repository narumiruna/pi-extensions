import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { AnySyncConfig } from "../settings/settings-types.js";
import type { Snapshot, SnapshotFile } from "../snapshot/snapshot-types.js";
import { syncDirectory, writeJson } from "../state/json-file.js";
import type { SyncState } from "../state/state-types.js";
import { statePathForConfig, syncStateFingerprint } from "../state/sync-state-store.js";
import { planFileMerge } from "./file-merge-planner.js";

export { conflictGroups } from "./conflict-groups.js";

import { mergeJournalIdentity } from "./merge-journal.js";
export interface ConflictArtifact {
  version: 1;
  identity: string;
  ancestors?: SnapshotFile[];
  state: SyncState;
  local: Snapshot;
  remote: Snapshot;
  groups: { paths: string[]; reasons: string[] }[];
  observed: { snapshotId: string; revision: string };
}
const LIMIT = 192 * 1024 * 1024;
export function conflictArtifactFingerprint(artifact: ConflictArtifact) {
  return createHash("sha256").update(JSON.stringify(artifact)).digest("hex");
}
export function conflictDirectory(config: AnySyncConfig) {
  return `${statePathForConfig(config)}.conflicts`;
}
async function directory(config: AnySyncConfig, create = false) {
  const target = conflictDirectory(config);
  if (create) await fs.mkdir(target, { recursive: true, mode: 0o700 });
  const stat = await fs.lstat(target);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (process.platform !== "win32" && (stat.mode & 0o077) !== 0))
    throw new Error("Unsafe private conflict directory.");
  return target;
}
function tokenPath(config: AnySyncConfig, token: string) {
  if (!/^[a-f0-9-]{36}$/u.test(token)) throw new Error("Invalid conflict token.");
  return path.join(conflictDirectory(config), `${token}.json`);
}
export interface CreatedConflictArtifact {
  token: string;
  target: string;
  dev: number;
  ino: number;
  size: number;
  fingerprint: string;
}
export async function saveConflictArtifact(
  config: AnySyncConfig,
  backend: string,
  artifact: Omit<ConflictArtifact, "version" | "identity">,
  validate: () => void,
  onCreated?: (created: CreatedConflictArtifact) => void,
) {
  validate();
  const identity = mergeJournalIdentity(config, backend);
  const local = Object.fromEntries(artifact.local.files.map((file) => [file.path, file.sha256]));
  const remote = Object.fromEntries(artifact.remote.files.map((file) => [file.path, file.sha256]));
  const fingerprint = createHash("sha256")
    .update(
      JSON.stringify([
        identity,
        artifact.groups.map((group) =>
          group.paths.map((filePath) => [
            filePath,
            artifact.state.lastFileHashes[filePath] ?? null,
            local[filePath] ?? null,
            remote[filePath] ?? null,
          ]),
        ),
      ]),
    )
    .digest("hex")
    .slice(0, 32);
  const token = `${fingerprint.slice(0, 8)}-${fingerprint.slice(8, 12)}-${fingerprint.slice(12, 16)}-${fingerprint.slice(16, 20)}-${fingerprint.slice(20)}`;
  await directory(config, true);
  validate();
  const reuse = async () => {
    const existing = await readConflictArtifact(config, backend, token);
    validate();
    const oldLocal = Object.fromEntries(existing.local.files.map((file) => [file.path, file.sha256]));
    const oldRemote = Object.fromEntries(existing.remote.files.map((file) => [file.path, file.sha256]));
    if (
      JSON.stringify(existing.groups.map((group) => group.paths)) !==
        JSON.stringify(artifact.groups.map((group) => group.paths)) ||
      artifact.groups.some((group) =>
        group.paths.some(
          (filePath) =>
            existing.state.lastFileHashes[filePath] !== artifact.state.lastFileHashes[filePath] ||
            oldLocal[filePath] !== local[filePath] ||
            oldRemote[filePath] !== remote[filePath],
        ),
      )
    )
      throw new Error("Conflict identity does not match retained immutable evidence.");
    return token;
  };
  const target = tokenPath(config, token);
  try {
    await fs.lstat(target);
    validate();
    return await reuse();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const temporary = `${target}.${randomUUID()}.pending`;
  const candidate: ConflictArtifact = { version: 1, identity, ...artifact };
  try {
    await writeJson(temporary, candidate, { maxBytes: LIMIT });
    validate();
    const stat = await fs.lstat(temporary);
    validate();
    try {
      // Publish immutable evidence without replacing a concurrent/pre-existing owner.
      await fs.link(temporary, target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      validate();
      return await reuse();
    }
    // Register ownership before any cancellation or durability await can fail.
    onCreated?.({
      token,
      target,
      dev: stat.dev,
      ino: stat.ino,
      size: stat.size,
      fingerprint: conflictArtifactFingerprint(candidate),
    });
    validate();
    await syncDirectory(path.dirname(target));
    validate();
    await syncDirectory(path.dirname(conflictDirectory(config)));
    validate();
    return token;
  } finally {
    await fs.rm(temporary, { force: true });
  }
}
export async function readConflictArtifact(config: AnySyncConfig, backend: string, token: string) {
  try {
    await directory(config);
    const target = tokenPath(config, token);
    const stat = await fs.lstat(target);
    if (!stat.isFile() || stat.size > LIMIT || (process.platform !== "win32" && (stat.mode & 0o077) !== 0))
      throw new Error("Unsafe conflict artifact.");
    const artifact = JSON.parse(await fs.readFile(target, "utf8")) as ConflictArtifact;
    if (
      artifact.version !== 1 ||
      artifact.identity !== mergeJournalIdentity(config, backend) ||
      !Array.isArray(artifact.groups) ||
      artifact.groups.length > 16_384 ||
      artifact.groups.some(
        (group) =>
          !Array.isArray(group.paths) ||
          !group.paths.length ||
          group.paths.length > 16_384 ||
          !Array.isArray(group.reasons),
      )
    )
      throw new Error("Invalid conflict artifact.");
    const plan = planFileMerge({
      baseline: artifact.state.lastFileHashes,
      local: artifact.local.files,
      remote: artifact.remote.files,
      selectionCompatible: true,
    });
    if (plan.kind !== "planned") throw new Error("Invalid conflict versions.");
    const known = new Set(plan.decisions.map((item) => item.path));
    if (artifact.groups.some((group) => group.paths.some((value) => !known.has(value))))
      throw new Error("Invalid conflict paths.");
    if (artifact.ancestors) {
      if (
        !Array.isArray(artifact.ancestors) ||
        artifact.ancestors.length > 16_384 ||
        artifact.ancestors.some((file) => artifact.state.lastFileHashes[file.path] !== file.sha256)
      )
        throw new Error("Invalid artifact ancestor.");
      const basePlan = planFileMerge({
        baseline: {},
        local: artifact.ancestors,
        remote: [],
        selectionCompatible: true,
      });
      if (basePlan.kind !== "planned" || basePlan.conflicts.length) throw new Error("Invalid ancestor bytes.");
    }
    syncStateFingerprint(artifact.state);
    return artifact;
  } catch {
    throw new Error("Cannot verify private conflict artifact; preserve evidence and review a fresh sync.");
  }
}
