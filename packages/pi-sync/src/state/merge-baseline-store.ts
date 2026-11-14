import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { backendIdentityCoordinates } from "../backends/backend-identity.js";
import type { AnySyncConfig } from "../settings/settings-types.js";
import type { Snapshot, SnapshotFile } from "../snapshot/snapshot-types.js";
import { collidingPaths, planFileMerge } from "../sync/file-merge-planner.js";
import { parseSettingsDocument } from "../sync/json-document.js";
import { validateSession } from "../sync/session-merge.js";
import { isMergeTextPath, text } from "../sync/text-merge.js";
import { syncDirectory, writeJson } from "./json-file.js";
import type { SyncState } from "./state-types.js";
import { statePathForConfig, syncStateFingerprint } from "./sync-state-store.js";

interface MergeBaseline {
  version: 1;
  identity: string;
  acceptedState: string;
  files: SnapshotFile[];
}
const MAX_BYTES = 192 * 1024 * 1024;
function eligible(file: SnapshotFile) {
  try {
    const bytes = Buffer.from(file.contentBase64, "base64");
    if (file.path === "settings.json") parseSettingsDocument(bytes);
    else if (isMergeTextPath(file.path)) text(bytes);
    else if (file.path.startsWith("sessions/") && file.path.endsWith(".jsonl")) validateSession(bytes);
    else return false;
    return true;
  } catch {
    return false;
  }
}

function identity(config: AnySyncConfig) {
  return JSON.stringify([
    config.setupName,
    backendIdentityCoordinates(config),
    config.include,
    ...(config.syncIgnore === undefined ? [] : ["syncIgnore", config.syncIgnore]),
    config.localFields ?? [],
  ]);
}
function directory(config: AnySyncConfig) {
  return `${statePathForConfig(config)}.ancestors`;
}
async function checkDirectory(config: AnySyncConfig, create = false) {
  const target = directory(config);
  if (create) await fs.mkdir(target, { recursive: true, mode: 0o700 });
  const stat = await fs.lstat(target);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (process.platform !== "win32" && (stat.mode & 0o077) !== 0))
    throw new Error("Unsafe private ancestor directory; preserve evidence.");
}
function baselinePath(config: AnySyncConfig, state: SyncState) {
  return path.join(directory(config), `${syncStateFingerprint(state)}.json`);
}

/** Stage before accepted state, retain its previous ancestor until journal retirement. Never bootstrap from current edits. */
export async function stageMergeBaseline(
  config: AnySyncConfig,
  snapshot: Snapshot,
  accepted: SyncState,
  previous?: SyncState,
) {
  const collisions = collidingPaths(snapshot.files.map((file) => file.path));
  const files = snapshot.files.filter((file) => {
    return (
      !collisions.has(file.path) &&
      accepted.lastFileHashes[file.path] === file.sha256 &&
      (file.path === "settings.json" || config.mergeContent || (config.agentMode && isMergeTextPath(file.path))) &&
      eligible(file)
    );
  });
  if (previous) {
    const stagedPaths = new Set(files.map((file) => file.path));
    let ancestors: SnapshotFile[] = [];
    try {
      ancestors = (await readMergeAncestors(config, previous)) ?? [];
    } catch {
      /* Keep unknown evidence; missing bytes are never invented. */
    }
    for (const ancestor of ancestors)
      if (
        !collisions.has(ancestor.path) &&
        accepted.lastFileHashes[ancestor.path] === ancestor.sha256 &&
        !stagedPaths.has(ancestor.path)
      ) {
        files.push(ancestor);
        stagedPaths.add(ancestor.path);
      }
  }
  const plan = planFileMerge({ baseline: {}, local: files, remote: [], selectionCompatible: true });
  if (plan.kind !== "planned" || plan.conflicts.length)
    throw new Error("Cannot stage unverified merge ancestor bytes.");
  const record: MergeBaseline = {
    version: 1,
    identity: identity(config),
    acceptedState: syncStateFingerprint(accepted),
    files,
  };
  await checkDirectory(config, true);
  await writeJson(baselinePath(config, accepted), record, { maxBytes: MAX_BYTES });
}

async function readBaselineRecord(
  config: AnySyncConfig,
  target: string,
  acceptedState: string,
  validate: () => void = () => {},
): Promise<MergeBaseline> {
  const stat = await fs.lstat(target);
  validate();
  if (!stat.isFile() || stat.size > MAX_BYTES || (process.platform !== "win32" && (stat.mode & 0o077) !== 0))
    throw new Error("Unsafe cache.");
  const record = JSON.parse(await fs.readFile(target, "utf8")) as MergeBaseline;
  validate();
  if (
    record.version !== 1 ||
    record.identity !== identity(config) ||
    record.acceptedState !== acceptedState ||
    !Array.isArray(record.files) ||
    record.files.length > 16_384 ||
    record.files.some((file) => !eligible(file))
  )
    throw new Error("Invalid cache identity.");
  const plan = planFileMerge({ baseline: {}, local: record.files, remote: [], selectionCompatible: true });
  if (plan.kind !== "planned" || plan.conflicts.length) throw new Error("Invalid cache bytes.");
  return record;
}

export async function readMergeAncestors(config: AnySyncConfig, state: SyncState): Promise<SnapshotFile[] | undefined> {
  let record: MergeBaseline;
  try {
    await checkDirectory(config);
    record = await readBaselineRecord(config, baselinePath(config, state), syncStateFingerprint(state));
    for (const file of record.files) {
      if (
        state.lastFileHashes[file.path] !== file.sha256 ||
        createHash("sha256").update(Buffer.from(file.contentBase64, "base64")).digest("hex") !== file.sha256
      )
        throw new Error("Cache hash mismatch.");
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw new Error("Merge ancestor is invalid; preserve its private cache and review the conflict.");
  }
  return record.files;
}
/** A no-op must not skip seeding or repairing ancestors required by later merges. */
export async function hasCurrentMergeBaseline(config: AnySyncConfig, snapshot: Snapshot, state: SyncState) {
  try {
    const ancestors = await readMergeAncestors(config, state);
    if (!ancestors) return false;
    const hashes = new Map(ancestors.map((file) => [file.path, file.sha256]));
    return snapshot.files.every(
      (file) =>
        !(file.path === "settings.json" || config.mergeContent || (config.agentMode && isMergeTextPath(file.path))) ||
        !eligible(file) ||
        hashes.get(file.path) === file.sha256,
    );
  } catch {
    // Preserve the existing full path's validation and repair behavior for unknown evidence.
    return false;
  }
}

export async function readMergeAncestor(config: AnySyncConfig, state: SyncState, filePath: string) {
  const file = (await readMergeAncestors(config, state))?.find((file) => file.path === filePath);
  return file ? Buffer.from(file.contentBase64, "base64") : undefined;
}

/** Caller must hold the sync operation lock and retire the commit journal before pruning. */
export async function pruneMergeBaselines(config: AnySyncConfig, state: SyncState, validate: () => void) {
  validate();
  const keep = path.basename(baselinePath(config, state));
  let names: string[];
  try {
    await checkDirectory(config);
    validate();
    names = await fs.readdir(directory(config));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  for (const name of names) {
    validate();
    if (name === keep || !/^[a-f0-9]{64}\.json$/u.test(name)) continue;
    const target = path.join(directory(config), name);
    try {
      await readBaselineRecord(config, target, name.slice(0, -5), validate);
    } catch {
      validate();
      continue; // Unknown/corrupted evidence is not an owned pruning candidate.
    }
    validate();
    await fs.rm(target);
    validate();
  }
  await syncDirectory(directory(config));
  validate();
}
