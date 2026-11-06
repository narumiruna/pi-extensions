import fs from "node:fs/promises";
import path from "node:path";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";

type MutationGuards = { signal?: AbortSignal; validateMutation?: () => void };

function assertCurrent(options: MutationGuards) {
  options.validateMutation?.();
  options.signal?.throwIfAborted();
}

function isMissing(error: unknown) {
  const code = (error as NodeJS.ErrnoException).code;
  return code === "ENOENT" || code === "ENOTDIR";
}

async function targetMissing(target: string, options: MutationGuards) {
  assertCurrent(options);
  try {
    await fs.lstat(target);
    assertCurrent(options);
    return false;
  } catch (error) {
    assertCurrent(options);
    if (!isMissing(error)) throw error;
    return true;
  }
}

async function queueKey(target: string, options: MutationGuards) {
  assertCurrent(options);
  try {
    const key = await fs.realpath(target);
    assertCurrent(options);
    return key;
  } catch (error) {
    assertCurrent(options);
    if (!isMissing(error)) throw error;
    return path.resolve(target);
  }
}

/** Resolve missing descendants too, including descendants of a file scheduled for removal. */
async function assertCanonicalParent(target: string, options: MutationGuards) {
  const parent = path.dirname(path.resolve(target));
  const suffix: string[] = [];
  for (let current = parent; ; current = path.dirname(current)) {
    assertCurrent(options);
    let canonical: string;
    try {
      canonical = await fs.realpath(current);
    } catch (error) {
      assertCurrent(options);
      if (!isMissing(error) || path.dirname(current) === current) throw error;
      suffix.unshift(path.basename(current));
      continue;
    }
    assertCurrent(options);
    // Pi queues existing paths by realpath and missing paths by lexical resolve.
    // Its public API cannot reserve a missing alias key while that alias exists,
    // or report a key that changes during registration. Refuse aliased parents
    // before mutation rather than risk a non-reentrant queue or overwrite a writer.
    if (path.join(canonical, ...suffix) !== parent)
      throw new Error(
        "Snapshot mutation through an aliased parent is unsafe; use the canonical agent/session path. Transaction evidence retained for review.",
      );
    return;
  }
}

export async function assertCanonicalMutationTargets(targets: readonly string[], options: MutationGuards) {
  for (const target of targets) await assertCanonicalParent(target, options);
}

export async function withTargetQueues<T>(
  targets: readonly string[],
  options: MutationGuards,
  action: (heldKeys: ReadonlySet<string>) => Promise<T>,
): Promise<T> {
  // Check the whole group before reserving any key or changing live files.
  await assertCanonicalMutationTargets(targets, options);
  const keys = new Set<string>();
  const missing = new Set<string>();
  for (const target of targets) {
    if (await targetMissing(target, options)) missing.add(target);
    const key = await queueKey(target, options);
    if (keys.has(key)) throw new Error("Transaction targets alias the same file.");
    keys.add(key);
  }
  const ordered = [...keys].sort();
  async function acquire(index: number): Promise<T> {
    assertCurrent(options);
    const key = ordered[index];
    // Pass the resolved key, not an alias whose lookup can select a different key.
    if (key) return withFileMutationQueue(key, () => acquire(index + 1));
    for (const target of targets) {
      await assertCanonicalParent(target, options);
      if (missing.has(target) && !(await targetMissing(target, options)))
        throw new Error("Missing transaction target appeared during queue acquisition; review is required.");
      if (!keys.has(await queueKey(target, options)))
        throw new Error("Transaction queue identity changed; review is required.");
    }
    assertCurrent(options);
    return action(keys);
  }
  return acquire(0);
}

export async function withMissingTargetQueues<T>(
  targets: readonly string[],
  heldKeys: ReadonlySet<string>,
  options: MutationGuards,
  action: (heldKeys: ReadonlySet<string>) => Promise<T>,
): Promise<T> {
  const unique = [...new Set(targets)];
  const requireAbsent = async () => {
    for (const target of unique) {
      await assertCanonicalParent(target, options);
      if (!(await targetMissing(target, options)))
        throw new Error("Snapshot target changed before destination queue reservation; evidence retained.");
    }
  };
  // Canonical parents make each missing key equal to the intended installed key.
  // Retain the old physical key and exclude it from these non-reentrant queues.
  const keys = unique
    .map((target) => path.resolve(target))
    .filter((key) => !heldKeys.has(key))
    .sort();
  await requireAbsent();
  const combined = new Set([...heldKeys, ...keys]);
  async function acquire(index: number): Promise<T> {
    assertCurrent(options);
    const key = keys[index];
    if (key) return withFileMutationQueue(key, () => acquire(index + 1));
    // A writer registered in the removal gap must finish before this check.
    // Even recognizable pre/postimages belong to that writer, not this transaction.
    await requireAbsent();
    assertCurrent(options);
    return action(combined);
  }
  return acquire(0);
}
