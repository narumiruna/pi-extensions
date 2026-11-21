import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { RemoteHead } from "../backends/sync-backend.js";
import type { AnySyncConfig } from "../settings/settings-types.js";
import {
  assertRecoveryPolicy,
  IGNORE_POLICY_JOURNAL_VERSION,
  ignorePolicyValidator,
  ignoreSourceBinding,
  type TransactionJournalPolicy,
  validateJournalPolicy,
} from "../snapshot/snapshot-transaction-policy.js";
import { IGNORE_SNAPSHOT_VERSION, type Snapshot } from "../snapshot/snapshot-types.js";
import { readJsonIfExists, syncDirectory, writeJson } from "../state/json-file.js";
import { statePathForConfig, syncStateFingerprint } from "../state/sync-state-store.js";
import { normalizeSyncExclude } from "./exclude-policy.js";
import { planFileMerge } from "./file-merge-planner.js";
import {
  portableSnapshot,
  sameLocalFields,
  validatePortableSnapshot,
  validateSnapshotFieldPolicy,
} from "./local-fields.js";
import type { PartialProgress } from "./partial-progress.js";
import {
  configuredSnapshotPathMatcher,
  sameSnapshotSelection,
  syncDirectoryPolicyKey,
  validateSnapshotSelection,
} from "./sync-policy.js";
import { fileHashMap, sameHashes } from "./sync-state.js";

type MergeJournalPolicy =
  | { version: 1; ignoreSource?: never }
  | { version: 2; ignoreSource: NonNullable<TransactionJournalPolicy["ignoreSource"]> };

export type MergeJournal = MergeJournalPolicy & {
  identity: string;
  before: Snapshot;
  after: Snapshot;
  accepted?: Snapshot;
  progress?: PartialProgress;
  upload: Snapshot;
  expectedHead: RemoteHead;
  committedHead?: RemoteHead;
  /** No remote publication was attempted; a stale candidate can retire if local preimages remain intact. */
  applyOnly?: boolean;
  backup: string;
  stateIdentity: string;
  /** Effective collection/apply root; absent legacy evidence cannot authorize session recovery. */
  sessionRoot?: string;
  warnings?: string[];
};

export function mergeJournalPolicy(config: AnySyncConfig): MergeJournalPolicy {
  return config.ignorePolicy ? { version: 2, ignoreSource: ignoreSourceBinding(config.ignorePolicy) } : { version: 1 };
}

function ignoreRecoveryPolicy(journal: MergeJournal): TransactionJournalPolicy {
  return {
    version: IGNORE_POLICY_JOURNAL_VERSION,
    ignoreSource: journal.ignoreSource,
    selection: journal.upload.selection,
  };
}

export function assertMergeJournalPolicy(journal: MergeJournal, config: AnySyncConfig) {
  if (journal.version === 1 && !config.ignorePolicy && config.pathPolicy !== "ignore-file") return;
  if (journal.version !== 2)
    throw new Error("Pending merge lacks ignore-file policy evidence; preserve its journal for reviewed recovery.");
  assertRecoveryPolicy(ignoreRecoveryPolicy(journal), config);
  try {
    const identity: unknown = JSON.parse(journal.identity);
    if (
      !Array.isArray(identity) ||
      typeof identity[1] !== "string" ||
      journal.identity !== mergeJournalIdentity(config, identity[1])
    )
      throw new Error("Inconsistent merge identity.");
  } catch {
    throw new Error("Pending merge belongs to a different setup or local policy; preserve its journal.");
  }
  const configured = configuredSnapshotPathMatcher(config);
  for (const snapshot of [
    journal.before,
    journal.after,
    journal.accepted,
    journal.applyOnly ? undefined : journal.upload,
  ]) {
    if (snapshot?.files.some((file) => !configured(file.path)))
      throw new Error("Pending merge contains paths outside the current ignore-file policy; preserve its journal.");
  }
}

export function mergeJournalIdentity(config: AnySyncConfig, backendIdentity: string) {
  return JSON.stringify([
    config.setupName,
    backendIdentity,
    [...config.include].sort(),
    config.localFields ?? null,
    ...(config.scope === "agent-directory"
      ? [syncDirectoryPolicyKey(config)]
      : config.exclude === undefined
        ? []
        : ["exclude", normalizeSyncExclude(config.exclude).map((rule) => rule.toLowerCase())]),
  ]);
}

export function mergeJournalPath(config: AnySyncConfig) {
  return `${statePathForConfig(config)}.merge-journal.json`;
}

export async function readMergeJournal(config: AnySyncConfig): Promise<MergeJournal | undefined> {
  let journal: MergeJournal | undefined;
  try {
    const stat = await fs.lstat(mergeJournalPath(config));
    if (!stat.isFile() || stat.size > 384 * 1024 * 1024) throw new Error("Unsafe or oversized journal.");
    journal = await readJsonIfExists<MergeJournal>(mergeJournalPath(config));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    // A JSON parser error may quote sensitive journal contents; do not retain it in a public error.
    throw new Error("Cannot read the private merge journal; preserve it and review recovery.");
  }
  if (journal === undefined) return;
  if (
    !journal ||
    (journal.version !== 1 && journal.version !== 2) ||
    (journal.version === 1 && journal.ignoreSource !== undefined) ||
    typeof journal.identity !== "string" ||
    typeof journal.backup !== "string" ||
    typeof journal.stateIdentity !== "string" ||
    (journal.applyOnly !== undefined &&
      (journal.applyOnly !== true ||
        !journal.committedHead ||
        journal.committedHead.revision !== journal.expectedHead?.revision ||
        journal.committedHead.snapshotId !== journal.expectedHead?.snapshotId ||
        journal.upload?.id !== journal.expectedHead?.snapshotId)) ||
    (journal.sessionRoot !== undefined &&
      (typeof journal.sessionRoot !== "string" ||
        !path.isAbsolute(journal.sessionRoot) ||
        path.resolve(journal.sessionRoot) !== journal.sessionRoot)) ||
    (journal.warnings !== undefined &&
      (!Array.isArray(journal.warnings) ||
        journal.warnings.length > 64 ||
        journal.warnings.some((item) => typeof item !== "string"))) ||
    !journal.expectedHead ||
    typeof journal.expectedHead.revision !== "string" ||
    !journal.before ||
    !journal.after ||
    !journal.upload ||
    !Array.isArray(journal.before.files) ||
    !Array.isArray(journal.after.files) ||
    !Array.isArray(journal.upload.files)
  )
    throw new Error("Unsupported or damaged merge journal; preserve it and review recovery before syncing.");
  // Verify every path and byte, including the unmanaged remote files retained for publication.
  try {
    if (journal.version === 2) {
      validateJournalPolicy(ignoreRecoveryPolicy(journal));
      if (
        [journal.expectedHead.selection, journal.committedHead?.selection].some(
          (selection) => selection !== undefined && !sameSnapshotSelection(selection, journal.upload.selection),
        )
      )
        throw new Error("Inconsistent merge head policy.");
    }
    const pinnedPaths = new Set(journal.progress?.groups.flatMap((group) => group.paths) ?? []);
    for (const snapshot of [
      journal.before,
      journal.after,
      journal.upload,
      ...(journal.accepted ? [journal.accepted] : []),
    ]) {
      validateSnapshotFieldPolicy(snapshot);
      validateSnapshotSelection(snapshot);
      if (
        (journal.version === 2
          ? snapshot.version !== IGNORE_SNAPSHOT_VERSION ||
            !sameSnapshotSelection(snapshot.selection, journal.upload.selection)
          : ![1, 2, 3, 4, 5].includes(snapshot.version)) ||
        typeof snapshot.id !== "string" ||
        typeof snapshot.profile !== "string" ||
        snapshot.files.length > 16_384 ||
        snapshot.files.reduce(
          (bytes, file) =>
            bytes + (typeof file?.contentBase64 === "string" ? file.contentBase64.length * 0.75 : Infinity),
          0,
        ) >
          64 * 1024 * 1024
      )
        throw new Error("Invalid journal input.");
      if (snapshot.selection?.scope) {
        const configured = configuredSnapshotPathMatcher(snapshot.selection);
        if (snapshot.files.some((file) => typeof file?.path !== "string" || !configured(file.path)))
          throw new Error("Journal retains paths outside its recorded directory policy.");
      }
      const plan = planFileMerge({ baseline: {}, local: snapshot.files, remote: [], selectionCompatible: true });
      if (
        plan.kind !== "planned" ||
        plan.conflicts.some((conflict) => conflict.reason !== "path-collision" || !pinnedPaths.has(conflict.path))
      )
        throw new Error("Invalid journal collision group.");
    }
    validatePortableSnapshot(journal.upload);
    if (journal.upload.version >= 2 && !journal.accepted)
      throw new Error("Portable merge journal requires an explicit accepted projection.");
    if (journal.accepted) validatePortableSnapshot(journal.accepted);
  } catch {
    throw new Error("Invalid merge journal paths, metadata, or bytes; preserve evidence for review.");
  }
  // Integrity is intrinsic to the recorded transaction, not the user's current recovery policy.
  // completeJournal separately checks that the recorded policy matches the current setup.
  try {
    if (
      journal.accepted &&
      (!sameLocalFields(journal.accepted.localFields, journal.upload.localFields) ||
        !sameHashes(
          fileHashMap(portableSnapshot(journal.after, journal.upload.localFields)),
          fileHashMap(portableSnapshot(journal.accepted, journal.upload.localFields)),
        ))
    )
      throw new Error("Projection mismatch.");
  } catch {
    throw new Error("Invalid accepted merge projection; preserve journal evidence.");
  }
  if (journal.progress) {
    const known = new Set([
      ...Object.keys(journal.progress.previous?.lastFileHashes ?? {}),
      ...[...journal.before.files, ...journal.after.files, ...journal.upload.files].map((file) => file.path),
    ]);
    const progress = journal.progress;
    if (
      !config.partialSync ||
      !progress.previous ||
      syncStateFingerprint(progress.previous) !== journal.stateIdentity ||
      !Array.isArray(progress.groups) ||
      progress.groups.length > 16_384 ||
      progress.groups.some(
        (group) =>
          !Array.isArray(group.paths) ||
          !group.paths.length ||
          group.paths.length > 16_384 ||
          group.paths.some((filePath) => !known.has(filePath)) ||
          !/^[a-f0-9-]{36}$/u.test(group.artifact),
      )
    )
      throw new Error("Invalid partial acceptance metadata; preserve journal evidence.");
  }
  if (journal.progress) {
    const before = fileHashMap(journal.before);
    const after = fileHashMap(journal.after);
    const { readConflictArtifact } = await import("./conflict-artifacts.js");
    const backendIdentity = (JSON.parse(journal.identity) as unknown[])[1];
    if (typeof backendIdentity !== "string") throw new Error("Invalid partial backend identity.");
    const byArtifact = new Map<string, typeof journal.progress.groups>();
    for (const group of journal.progress.groups) {
      const groups = byArtifact.get(group.artifact) ?? [];
      groups.push(group);
      byArtifact.set(group.artifact, groups);
    }
    for (const [token, groups] of byArtifact) {
      const artifact = await readConflictArtifact(config, backendIdentity, token);
      const retainedGroups = new Set(artifact.groups.map((group) => JSON.stringify(group.paths)));
      const remote = fileHashMap(artifact.remote);
      const upload = fileHashMap(journal.upload);
      for (const group of groups) {
        if (!retainedGroups.has(JSON.stringify(group.paths)))
          throw new Error("Partial group does not match retained artifact evidence.");
        for (const filePath of group.paths)
          if (
            before[filePath] !== after[filePath] ||
            remote[filePath] !== upload[filePath] ||
            journal.progress.previous.lastFileHashes[filePath] !== artifact.state.lastFileHashes[filePath]
          )
            throw new Error("Withheld version changed in journal; preserve evidence.");
      }
    }
  }
  return journal;
}

export async function writeMergeJournal(config: AnySyncConfig, journal: MergeJournal) {
  await writeJson(mergeJournalPath(config), journal, { maxBytes: 384 * 1024 * 1024 });
}

export async function clearMergeJournal(config: AnySyncConfig) {
  await fs.rm(mergeJournalPath(config), { force: true });
  await syncDirectory(path.dirname(mergeJournalPath(config)));
}

export async function retireMergeJournal(config: AnySyncConfig) {
  const journal = await readMergeJournal(config);
  if (!journal) return;
  assertMergeJournalPolicy(journal, config);
  const validateIgnore = ignorePolicyValidator(config);
  if (validateIgnore) await validateIgnore();
  const file = mergeJournalPath(config);
  await fs.rename(file, `${file}.${randomUUID()}.resolved`);
  await syncDirectory(path.dirname(file));
}

export async function requireNoMergeJournal(config: AnySyncConfig, options: { force?: boolean } = {}) {
  const journal = await readMergeJournal(config);
  if (!journal) return;
  assertMergeJournalPolicy(journal, config);
  const validateIgnore = ignorePolicyValidator(config);
  if (validateIgnore) await validateIgnore();
  if (!options.force) {
    throw new Error(
      "A merged transfer needs recovery. Run /sync sync to reconcile it. If newer local edits or remote revisions prevent recovery, review /sync diff and explicitly choose push --force or pull --force; the selected directional result will archive the old journal, not restore old bytes. Keep its backup; do not downgrade while recovery is pending.",
    );
  }
}
