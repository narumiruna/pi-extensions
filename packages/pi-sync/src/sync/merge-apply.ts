import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { agentDir } from "../snapshot/session-paths.js";
import { createSnapshot, snapshotTarget } from "../snapshot/snapshot.js";
import { preflightSnapshotApply, preflightSnapshotMutations } from "../snapshot/snapshot-apply.js";
import { assertCanonicalMutationTargets } from "../snapshot/snapshot-mutation-queues.js";
import { sessionStorageRoot } from "../snapshot/snapshot-paths.js";
import type { Snapshot, SnapshotOptions } from "../snapshot/snapshot-types.js";
import { syncDirectory } from "../state/json-file.js";
import { syncMutationParents } from "../state/mutation-directory-sync.js";
import { mergePathIdentity } from "./file-merge-planner.js";
import { fileHashMap } from "./sync-state.js";

/** Read-only filesystem applicability check before publishing a combined result. */
export async function preflightMergedTargets(
  before: Snapshot,
  after: Snapshot,
  options: SnapshotOptions,
  protectedTarget?: string,
) {
  const root = agentDir();
  const beforeHashes: Record<string, string> = Object.assign(Object.create(null), fileHashMap(before));
  const afterHashes: Record<string, string> = Object.assign(Object.create(null), fileHashMap(after));
  const paths = [...new Set([...Object.keys(beforeHashes), ...Object.keys(afterHashes)])].sort();
  const changed = new Set(paths.filter((item) => beforeHashes[item] !== afterHashes[item]));
  await assertCanonicalMergedTargets(root, changed, options);
  await assertDistinctMergedTargets(root, paths, changed, options, protectedTarget, new Set(Object.keys(afterHashes)));
  const removed = replacementPaths(
    new Set(paths.filter((item) => changed.has(item) && !afterHashes[item])),
    afterHashes,
  );
  const removedTargets = new Set([...removed].map((item) => snapshotTarget(root, item, options.sessionDir)));
  for (const relative of paths) {
    if (changed.has(relative)) await assertFilesystemTarget(root, relative, options, removedTargets, beforeHashes);
  }
  await assertCanonicalMutationTargets(
    [...changed].map((relative) => snapshotTarget(root, relative, options.sessionDir)),
    options,
  );
}

function replacementPaths(removed: Set<string>, afterHashes: Readonly<Record<string, string>>) {
  for (const relative of [...removed]) {
    let parent = path.posix.dirname(relative);
    while (parent !== ".") {
      if (afterHashes[parent]) {
        for (
          let directory = path.posix.dirname(relative);
          directory !== parent;
          directory = path.posix.dirname(directory)
        )
          removed.add(directory);
        removed.add(parent);
        break;
      }
      parent = path.posix.dirname(parent);
    }
  }
  return removed;
}

/** Snapshot collection canonicalizes top-level names, but merged journals own exact physical paths. */
async function assertCanonicalMergedTargets(root: string, changed: Iterable<string>, options: SnapshotOptions) {
  const topLevel = new Map(
    [...changed].filter((relative) => !relative.includes("/")).map((relative) => [relative.toLowerCase(), relative]),
  );
  if (topLevel.size === 0) return;
  options.signal?.throwIfAborted();
  options.validateMutation?.();
  let names: string[];
  try {
    names = await fs.readdir(root);
  } catch (error) {
    options.signal?.throwIfAborted();
    options.validateMutation?.();
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return;
  }
  options.signal?.throwIfAborted();
  options.validateMutation?.();
  for (const name of names) {
    const canonical = topLevel.get(name.toLowerCase());
    if (canonical !== undefined && name !== canonical)
      throw new Error(
        "Merged target has a noncanonical case variant; normalize selected top-level file spelling before retrying. Journal retained if already committed.",
      );
  }
}

/** Even an unchanged virtual alias must not describe different bytes for a changed physical file. */
async function assertDistinctMergedTargets(
  root: string,
  paths: string[],
  changed: ReadonlySet<string>,
  options: SnapshotOptions,
  protectedTarget?: string,
  finalPaths: ReadonlySet<string> = new Set(paths),
) {
  const protectedKey = protectedTarget
    ? mergePathIdentity(await resolvedTargetIdentity(path.resolve(protectedTarget), options))
    : undefined;
  options.signal?.throwIfAborted();
  options.validateMutation?.();
  const keys = new Map<string, string>();
  for (const relative of paths) {
    options.signal?.throwIfAborted();
    const target = snapshotTarget(root, relative, options.sessionDir);
    const key = mergePathIdentity(await resolvedTargetIdentity(target, options));
    options.signal?.throwIfAborted();
    options.validateMutation?.();
    const existing = keys.get(key);
    if (
      existing &&
      (mergePathIdentity(existing) !== mergePathIdentity(relative) ||
        (finalPaths.has(existing) && finalPaths.has(relative)))
    )
      throw new Error("Merged paths resolve to the same file; reviewed directional recovery is required.");
    if (key === protectedKey && changed.has(relative))
      throw new Error("A merged transfer targets the current session; review is required.");
    keys.set(key, relative);
  }
}

async function assertReviewedTree(directory: string, relative: string, beforeHashes: Readonly<Record<string, string>>) {
  for (const name of await fs.readdir(directory)) {
    const child = path.join(directory, name);
    const childRelative = `${relative}/${name}`;
    const stat = await fs.lstat(child);
    if (stat.isDirectory()) {
      await assertReviewedTree(child, childRelative, beforeHashes);
    } else if (
      stat.isFile() &&
      stat.nlink === 1 &&
      beforeHashes[childRelative] ===
        createHash("sha256")
          .update(await fs.readFile(child))
          .digest("hex")
    ) {
      continue;
    } else {
      throw new Error("Reviewed directory contains unknown or changed files; publication refused.");
    }
  }
}

function hasBlockingFileAncestor(target: string, files: ReadonlySet<string>) {
  for (let parent = path.dirname(target); parent !== path.dirname(parent); parent = path.dirname(parent))
    if (files.has(parent)) return true;
  return false;
}

async function resolvedTargetIdentity(target: string, options: SnapshotOptions) {
  // Resolve the nearest existing ancestor too: roots may alias even when a target is absent.
  let ancestor = target;
  while (true) {
    options.signal?.throwIfAborted();
    try {
      const resolved = await fs.realpath(ancestor);
      return path.resolve(resolved, path.relative(ancestor, target));
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
      const parent = path.dirname(ancestor);
      if (parent === ancestor) return target;
      ancestor = parent;
    }
  }
}

async function assertFilesystemTarget(
  root: string,
  relative: string,
  options: SnapshotOptions,
  removedTargets: ReadonlySet<string> = new Set(),
  beforeHashes?: Readonly<Record<string, string>>,
) {
  const target = snapshotTarget(root, relative, options.sessionDir);
  const boundary =
    relative.startsWith("sessions/") && options.sessionDir
      ? path.resolve(sessionStorageRoot(root, options.sessionDir))
      : path.resolve(root);
  for (
    let parent = path.dirname(target);
    mergePathIdentity(parent) !== mergePathIdentity(boundary);
    parent = path.dirname(parent)
  ) {
    options.signal?.throwIfAborted();
    if (path.dirname(parent) === parent) throw new Error("Unowned merged target.");
    try {
      const stat = await fs.lstat(parent);
      if (
        (!stat.isDirectory() || stat.isSymbolicLink()) &&
        !(stat.isFile() && stat.nlink === 1 && removedTargets.has(parent))
      )
        throw new Error("Unsafe merge filesystem layout; review the selected paths before transfer.");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") throw error;
    }
  }
  options.signal?.throwIfAborted();
  try {
    const stat = await fs.lstat(target);
    if ((!stat.isFile() && !removedTargets.has(target)) || (stat.isFile() && stat.nlink > 1))
      throw new Error("Merge target is non-regular or hard-linked; review a directional operation before transfer.");
    if (stat.isDirectory() && beforeHashes) await assertReviewedTree(target, relative, beforeHashes);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT" && !(code === "ENOTDIR" && removedTargets.size > 0)) throw error;
  }
}

/** Roll forward only while each target is still its reviewed preimage or committed postimage. */
export async function applyMergedSnapshot(
  before: Snapshot,
  after: Snapshot,
  protectedPaths: Set<string>,
  options: SnapshotOptions,
  validate: () => Promise<void>,
  protectedTarget?: string,
) {
  const root = agentDir();
  const beforeHashes: Record<string, string> = Object.assign(Object.create(null), fileHashMap(before));
  const afterHashes: Record<string, string> = Object.assign(Object.create(null), fileHashMap(after));
  const paths = [...new Set([...Object.keys(beforeHashes), ...Object.keys(afterHashes)])].sort();
  const replacements = replacementPaths(
    new Set(paths.filter((item) => beforeHashes[item] && !afterHashes[item])),
    afterHashes,
  );
  const intermediateDirectories = [...replacements].filter((item) => !beforeHashes[item] && !afterHashes[item]);
  const changed = [
    ...new Set([...paths.filter((item) => beforeHashes[item] !== afterHashes[item]), ...intermediateDirectories]),
  ].sort();
  const protectedKeys = new Set([...protectedPaths].map(mergePathIdentity));
  if (changed.some((item) => protectedKeys.has(mergePathIdentity(item)))) {
    throw new Error("A merged transfer targets the current session; review is required.");
  }
  // Exact file queues, not a directory pseudo-lock: Pi edit/write tools use these keys.
  const targets = changed.map((item) => snapshotTarget(root, item, options.sessionDir));
  const relativeByTarget = new Map(targets.map((target, index) => [target, changed[index]]));
  const targetSet = new Set(targets);
  await assertDistinctMergedTargets(
    root,
    paths,
    new Set(changed),
    options,
    protectedTarget,
    new Set(Object.keys(afterHashes)),
  );
  await assertCanonicalMutationTargets(targets, options);
  // Existing case aliases share Pi's non-reentrant realpath queue. Reserve the
  // missing destination separately only after deleting its reviewed preimage.
  const targetsByQueue = new Map<string, string[]>();
  const queueTargets: string[] = [];
  const deferredTargets: string[] = [];
  for (const target of targets) {
    let key = path.resolve(target);
    try {
      key = await fs.realpath(target);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
    }
    options.signal?.throwIfAborted();
    options.validateMutation?.();
    const aliases = targetsByQueue.get(key) ?? [];
    aliases.push(target);
    targetsByQueue.set(key, aliases);
  }
  for (const [key, aliases] of targetsByQueue) {
    queueTargets.push(key);
    if (aliases.length > 1) deferredTargets.push(...aliases.filter((target) => path.resolve(target) !== key));
  }
  async function acquire(index: number): Promise<void> {
    const target = queueTargets[index];
    if (target) return withFileMutationQueue(target, () => acquire(index + 1));
    await validate();
    await assertCanonicalMergedTargets(root, changed, options);
    await validate();
    const current = await createSnapshot(before.profile, options);
    const currentHashes: Record<string, string> = Object.assign(Object.create(null), fileHashMap(current));
    const blockingFiles = new Set(
      paths
        .filter(
          (relative) =>
            (beforeHashes[relative] && !afterHashes[relative]) ||
            (afterHashes[relative] && currentHashes[relative] === afterHashes[relative]),
        )
        .map((relative) => snapshotTarget(root, relative, options.sessionDir)),
    );
    for (const item of changed) {
      if (currentHashes[item] !== beforeHashes[item] && currentHashes[item] !== afterHashes[item]) {
        throw new Error(
          "Local content changed during merged transfer; journal retained for review. No newer bytes were replaced.",
        );
      }
      const target = snapshotTarget(root, item, options.sessionDir);
      try {
        const stat = await fs.lstat(target);
        if ((!stat.isFile() && !stat.isDirectory()) || (stat.isFile() && stat.nlink > 1))
          throw new Error("Merged transfer target is no longer an independent regular file.");
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "ENOENT" && !(code === "ENOTDIR" && hasBlockingFileAncestor(target, blockingFiles))) throw error;
      }
    }
    const plan = preflightSnapshotApply(root, after, current, options);
    plan.writes = plan.writes.filter((item) => targetSet.has(item.target));
    plan.deletes = plan.deletes.filter((target) => targetSet.has(target));
    await preflightSnapshotMutations(root, plan, options.sessionDir, options);
    const deletedTargets = new Set(plan.deletes);
    for (const relative of intermediateDirectories) {
      for (let parent = path.posix.dirname(relative); parent !== "."; parent = path.posix.dirname(parent)) {
        if (afterHashes[parent] && deletedTargets.has(snapshotTarget(root, parent, options.sessionDir))) {
          plan.deletes.push(snapshotTarget(root, relative, options.sessionDir));
          break;
        }
      }
    }
    // A parent must remain until every reviewed leaf and intermediate directory is gone.
    plan.deletes.sort(
      (left, right) => right.split(path.sep).length - left.split(path.sep).length || left.localeCompare(right),
    );
    const removed = replacementPaths(
      new Set(paths.filter((relative) => deletedTargets.has(snapshotTarget(root, relative, options.sessionDir)))),
      afterHashes,
    );
    const removedTargets = new Set([...removed].map((item) => snapshotTarget(root, item, options.sessionDir)));
    await assertCanonicalMergedTargets(root, changed, options);
    await validate();
    const revalidateTarget = async (target: string) => {
      await validate();
      const relative = relativeByTarget.get(target);
      if (!relative) throw new Error("Unowned merge target.");
      await assertFilesystemTarget(root, relative, options, removedTargets, currentHashes);
      await validate();
      let hash: string | undefined;
      try {
        const stat = await fs.lstat(target);
        if (stat.isDirectory() && removed.has(relative)) {
          if ((await fs.readdir(target)).length)
            throw new Error("Reviewed directory has remaining contents; journal retained for review.");
        } else {
          if (!stat.isFile() || stat.nlink > 1)
            throw new Error("Merged transfer target is no longer an independent regular file.");
          hash = createHash("sha256")
            .update(await fs.readFile(target))
            .digest("hex");
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      options.signal?.throwIfAborted();
      options.validateMutation?.();
      if (hash !== beforeHashes[relative] && hash !== afterHashes[relative])
        throw new Error("Local content changed at the apply boundary; journal retained, newer bytes untouched.");
    };
    for (const target of plan.deletes) {
      await revalidateTarget(target);
      try {
        const stat = await fs.lstat(target);
        await validate();
        if (stat.isDirectory())
          await fs.rmdir(target); // Only an empty, reviewed directory may be replaced.
        else await fs.rm(target, { force: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      await syncDirectory(path.dirname(target));
    }
    const requireAbsentDestinations = async () => {
      await validate();
      for (const target of deferredTargets) {
        try {
          await fs.lstat(target);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          continue;
        }
        throw new Error("Case replacement destination changed before queue reservation; journal retained for review.");
      }
      await validate();
    };
    async function acquireDestinations(index: number): Promise<void> {
      const target = deferredTargets[index];
      if (target) return withFileMutationQueue(target, () => acquireDestinations(index + 1));
      // Writers registered after deletion must finish first; never accept their
      // bytes as our own, even if they match a recognizable pre/postimage.
      await requireAbsentDestinations();
      await writeTargets();
    }
    await requireAbsentDestinations();
    await acquireDestinations(0);
    async function writeTargets() {
      for (const item of plan.writes) {
        await validate();
        const relative = relativeByTarget.get(item.target);
        if (!relative) throw new Error("Unowned merge write target.");
        await assertFilesystemTarget(root, relative, options, new Set());
        await fs.mkdir(path.dirname(item.target), { recursive: true });
        const temporary = path.join(path.dirname(item.target), `.pi-sync.json.${randomUUID()}.apply`);
        let mode = 0o600;
        try {
          mode = (await fs.stat(item.target)).mode & 0o777;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        try {
          const handle = await fs.open(temporary, "wx", mode);
          try {
            await handle.writeFile(item.content);
            await handle.sync();
          } finally {
            await handle.close();
          }
          await revalidateTarget(item.target);
          await fs.rename(temporary, item.target);
          await syncDirectory(path.dirname(item.target));
        } finally {
          await fs.rm(temporary, { force: true });
        }
      }
      await syncMutationParents(
        targets,
        [root, ...(options.sessionDir ? [sessionStorageRoot(root, options.sessionDir)] : [])],
        options,
      );
      await validate();
    }
  }
  await acquire(0);
}
