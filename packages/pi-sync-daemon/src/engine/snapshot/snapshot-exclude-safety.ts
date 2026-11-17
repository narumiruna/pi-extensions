import fs from "node:fs/promises";
import path from "node:path";
import { isPathInside, toPosix } from "../paths.js";
import { compileSyncExclude } from "../sync/exclude-policy.js";
import { sessionStorageRoot } from "./snapshot-paths.js";

/** Metadata-only preflight: an ancestor replacement must not capture/remove excluded descendants. */
export async function assertUnexcludedTargets(
  root: string,
  targets: Iterable<string>,
  options: { exclude?: readonly string[]; sessionDir?: string; signal?: AbortSignal; validateMutation?: () => void },
) {
  if (!options.exclude?.length) return;
  const excluded = compileSyncExclude(options.exclude);
  const sessionRoot = sessionStorageRoot(root, options.sessionDir);
  let visited = 0;
  const validate = () => {
    options.signal?.throwIfAborted();
    options.validateMutation?.();
  };
  async function visit(target: string): Promise<void> {
    validate();
    if (++visited > 16_384)
      throw new Error("Exclude safety preflight exceeds its path bound; review a smaller transfer.");
    const candidates: string[] = [];
    if (isPathInside(root, target)) candidates.push(toPosix(path.relative(root, target)));
    if (isPathInside(sessionRoot, target)) candidates.push(`sessions/${toPosix(path.relative(sessionRoot, target))}`);
    if (candidates.some(excluded))
      throw new Error("Transfer would replace an excluded path or directory descendant; no replacement is authorized.");
    try {
      const stat = await fs.lstat(target);
      validate();
      if (!stat.isDirectory() || stat.isSymbolicLink()) return;
      const names = await fs.readdir(target);
      validate();
      for (const name of names) await visit(path.join(target, name));
    } catch (error) {
      validate();
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
    }
  }
  for (const target of new Set(targets)) await visit(target);
}
