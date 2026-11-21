import fs from "node:fs/promises";
import path from "node:path";
import { isPathInside, toPosix } from "../paths.js";
import { mergePathIdentity } from "../sync/file-merge-planner.js";
import { compileSyncPolicyExclude, compileSyncPolicyTraversal, type SyncSelectionConfig } from "../sync/sync-policy.js";
import { sessionStorageRoot } from "./snapshot-paths.js";

function inside(root: string, target: string) {
  const relative = path.relative(mergePathIdentity(root), mergePathIdentity(target));
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

/** Symlinks above both configured roots are part of the host path; below this anchor they are not. */
export function agentDirectoryAnchor(root: string, boundary: string) {
  let anchor = path.dirname(path.resolve(root));
  while (!inside(anchor, boundary)) {
    const parent = path.dirname(anchor);
    if (parent === anchor) return path.parse(boundary).root;
    anchor = parent;
  }
  return anchor;
}

export function agentDirectorySessionRoot(root: string, sessionDir?: string) {
  const sessionRoot = sessionStorageRoot(root, sessionDir);
  if (inside(sessionRoot, root)) throw new Error("Pi session storage overlaps the agent directory root.");
  if (inside(root, sessionRoot)) {
    const relative = toPosix(path.relative(root, sessionRoot));
    const canTraverse = compileSyncPolicyTraversal({ scope: "agent-directory", include: ["sessions"] });
    if (!canTraverse(relative)) throw new Error("Pi session storage overlaps protected agent files.");
  }
  return sessionRoot;
}

/** A nested custom store belongs to virtual sessions, never to its physical name. */
export function agentDirectoryPhysicalSessionPath(root: string, sessionDir?: string) {
  const sessionRoot = agentDirectorySessionRoot(root, sessionDir);
  return (relativePath: string) => inside(root, sessionRoot) && inside(sessionRoot, path.resolve(root, relativePath));
}

/** Metadata-only preflight: an ancestor replacement must not capture/remove excluded descendants. */
export async function assertUnexcludedTargets(
  root: string,
  targets: Iterable<string>,
  options: SyncSelectionConfig & { sessionDir?: string; signal?: AbortSignal; validateMutation?: () => void },
  { recursive = true }: { recursive?: boolean } = {},
) {
  const wholeDirectory = options.scope === "agent-directory";
  if (!wholeDirectory && (options.exclude === undefined || (Array.isArray(options.exclude) && !options.exclude.length)))
    return;
  const excluded = compileSyncPolicyExclude(options);
  const sessionRoot = wholeDirectory
    ? agentDirectorySessionRoot(root, options.sessionDir)
    : sessionStorageRoot(root, options.sessionDir);
  const defaultRoot = sessionStorageRoot(root);
  let visited = 0;
  const validate = () => {
    options.signal?.throwIfAborted();
    options.validateMutation?.();
  };
  async function visit(target: string): Promise<void> {
    validate();
    if (++visited > 16_384)
      throw new Error("Exclude safety preflight exceeds its path bound; review a smaller transfer.");
    const refuse = () => {
      throw new Error("Transfer would replace an excluded path or directory descendant; no replacement is authorized.");
    };
    if (wholeDirectory) {
      if (inside(target, sessionRoot)) refuse();
      if (inside(sessionRoot, target)) {
        const relative = toPosix(path.relative(sessionRoot, target));
        if (excluded(`sessions/${relative}`)) refuse();
      } else if (
        !inside(root, target) ||
        inside(defaultRoot, target) ||
        excluded(toPosix(path.relative(root, target)))
      ) {
        refuse();
      }
    } else {
      const candidates: string[] = [];
      if (isPathInside(root, target)) candidates.push(toPosix(path.relative(root, target)));
      if (isPathInside(sessionRoot, target)) candidates.push(`sessions/${toPosix(path.relative(sessionRoot, target))}`);
      if (candidates.some(excluded)) refuse();
    }
    try {
      const stat = await fs.lstat(target);
      validate();
      if (wholeDirectory && !stat.isDirectory() && (!stat.isFile() || stat.nlink !== 1)) {
        throw new Error("Refusing an unsafe symlink, hard link, or special file during snapshot mutation.");
      }
      if (!recursive || !stat.isDirectory()) return;
      const directory = await fs.opendir(target);
      for await (const entry of directory) await visit(path.join(target, entry.name));
    } catch (error) {
      validate();
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
    }
  }
  async function assertParents(target: string, boundary: string, includeTarget = false) {
    let parent = agentDirectoryAnchor(root, boundary);
    const parts = path.relative(parent, target).split(path.sep);
    if (!includeTarget) parts.pop();
    for (const part of parts) {
      parent = path.join(parent, part);
      validate();
      try {
        const stat = await fs.lstat(parent);
        validate();
        if (stat.isSymbolicLink()) throw new Error("Refusing to follow symlink during snapshot mutation.");
        if (!stat.isDirectory()) {
          if (includeTarget) throw new Error("Pi session storage is not a directory.");
          break; // A reviewed file ancestor may be replaced first.
        }
      } catch (error) {
        validate();
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
        break;
      }
    }
  }
  if (wholeDirectory && options.sessionDir) await assertParents(sessionRoot, sessionRoot, true);
  for (const target of new Set(targets)) {
    if (wholeDirectory && (inside(root, target) || inside(sessionRoot, target))) {
      await assertParents(target, inside(root, target) ? root : sessionRoot);
    }
    await visit(target);
  }
}
