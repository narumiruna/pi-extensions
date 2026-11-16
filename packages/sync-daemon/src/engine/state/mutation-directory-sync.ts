import path from "node:path";
import { isPathInside } from "../paths.js";
import { mergePathIdentity } from "../sync/file-merge-planner.js";
import { syncDirectory } from "./json-file.js";

/** Persist created ancestor names as well as the immediate rename/delete directory. */
export async function syncMutationParents(
  targets: readonly string[],
  roots: readonly string[],
  options: { signal?: AbortSignal; validateMutation?: () => void } = {},
) {
  const directories = new Set<string>();
  for (const target of targets) {
    const root = roots.map((root) => path.resolve(root)).find((root) => isPathInside(root, target));
    if (!root) throw new Error("Unowned mutation directory.");
    for (let parent = path.dirname(target); ; parent = path.dirname(parent)) {
      directories.add(parent);
      if (mergePathIdentity(parent) === mergePathIdentity(root)) break;
      if (path.dirname(parent) === parent) throw new Error("Mutation directory escaped its owned root.");
    }
  }
  for (const directory of [...directories].sort((a, b) => b.length - a.length)) {
    options.signal?.throwIfAborted();
    options.validateMutation?.();
    try {
      await syncDirectory(directory);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
    }
    options.signal?.throwIfAborted();
    options.validateMutation?.();
  }
}
