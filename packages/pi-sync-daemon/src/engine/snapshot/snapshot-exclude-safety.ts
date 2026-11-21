import { lstatSync, type Stats } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { isPathInside, toPosix } from "../paths.js";
import { mergePathIdentity } from "../sync/file-merge-planner.js";
import {
  compileSyncPolicyExclude,
  compileSyncPolicyTraversal,
  configuredSnapshotPathMatcher,
  type SyncSelectionConfig,
} from "../sync/sync-policy.js";
import { sessionStorageRoot } from "./snapshot-paths.js";

function directoryStat(absolute: string) {
  try {
    return lstatSync(absolute, { throwIfNoEntry: false });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOTDIR") throw error;
    return undefined;
  }
}

/** Compare the directory prefix by filesystem identity, independently of portable snapshot names. */
function physicalRelative(root: string, target: string): string | undefined {
  root = path.resolve(root);
  target = path.resolve(target);
  if (target === root) return "";
  const prefix = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
  if (target.startsWith(prefix)) return target.slice(prefix.length);

  const rootDepth = root.slice(path.parse(root).root.length).split(path.sep).filter(Boolean).length;
  const targetVolume = path.parse(target).root;
  const parts = target.slice(targetVolume.length).split(path.sep).filter(Boolean);
  if (parts.length < rootDepth) return undefined;
  const ancestor = path.join(targetVolume, ...parts.slice(0, rootDepth));
  return sameDirectoryPrefix(root, ancestor) ? parts.slice(rootDepth).join(path.sep) : undefined;
}

function sameDirectoryPrefix(left: string, right: string): boolean {
  if (left === right) return true;
  const samePortableName = mergePathIdentity(left) === mergePathIdentity(right);
  // Windows can expose a short path name that does not share its long name's portable spelling.
  if (!samePortableName && process.platform !== "win32") return false;
  const boundary = directoryStat(left);
  const candidate = directoryStat(right);
  if (boundary || candidate)
    return Boolean(
      boundary?.isDirectory() &&
        candidate?.isDirectory() &&
        boundary.dev === candidate.dev &&
        boundary.ino === candidate.ino,
    );
  // Missing paths can still alias. Compare existing ancestors before reserving both spellings.
  return (
    samePortableName && path.dirname(left) !== left && sameDirectoryPrefix(path.dirname(left), path.dirname(right))
  );
}

/** Symlinks above both configured roots are part of the host path; below this anchor they are not. */
export function agentDirectoryAnchor(root: string, boundary: string) {
  let anchor = path.dirname(path.resolve(root));
  while (!isPathInside(anchor, boundary)) {
    const parent = path.dirname(anchor);
    if (parent === anchor) return path.parse(boundary).root;
    anchor = parent;
  }
  return anchor;
}

export function agentDirectorySessionRoot(root: string, sessionDir?: string) {
  const sessionRoot = sessionStorageRoot(root, sessionDir);
  if (physicalRelative(sessionRoot, root) !== undefined)
    throw new Error("Pi session storage overlaps the agent directory root.");
  const relative = physicalRelative(root, sessionRoot);
  if (relative !== undefined) {
    const canTraverse = compileSyncPolicyTraversal({ scope: "agent-directory", include: ["sessions"] });
    if (!canTraverse(toPosix(relative))) throw new Error("Pi session storage overlaps protected agent files.");
  }
  return sessionRoot;
}

/** A nested custom store belongs to virtual sessions, never to its physical name. */
export function agentDirectoryPhysicalSessionPath(root: string, sessionDir?: string) {
  const sessionRoot = agentDirectorySessionRoot(root, sessionDir);
  const nested = physicalRelative(root, sessionRoot) !== undefined;
  return (relativePath: string) =>
    nested && physicalRelative(sessionRoot, path.resolve(root, relativePath)) !== undefined;
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
  const configured = configuredSnapshotPathMatcher(options);
  let visited = 0;
  const validate = () => {
    options.signal?.throwIfAborted();
    options.validateMutation?.();
  };
  const reserveVisit = () => {
    validate();
    if (++visited > 16_384)
      throw new Error("Exclude safety preflight exceeds its path bound; review a smaller transfer.");
  };
  const refuse = () => {
    throw new Error("Transfer would replace an excluded path or directory descendant; no replacement is authorized.");
  };
  async function visit(target: string): Promise<void> {
    validate();
    let sessionPath: string | undefined;
    if (wholeDirectory) {
      if (physicalRelative(target, sessionRoot) !== undefined) refuse();
      const sessionRelative = physicalRelative(sessionRoot, target);
      if (sessionRelative !== undefined) {
        sessionPath = `sessions/${toPosix(sessionRelative)}`;
        if (excluded(sessionPath)) refuse();
      } else {
        const relative = physicalRelative(root, target);
        if (relative === undefined || /^sessions(?:\/|$)/iu.test(toPosix(relative)) || excluded(toPosix(relative)))
          refuse();
      }
    } else {
      const candidates: string[] = [];
      if (isPathInside(root, target)) candidates.push(toPosix(path.relative(root, target)));
      if (isPathInside(sessionRoot, target)) candidates.push(`sessions/${toPosix(path.relative(sessionRoot, target))}`);
      if (candidates.some(excluded)) refuse();
    }
    let stat: Stats;
    try {
      stat = await fs.lstat(target);
    } catch (error) {
      validate();
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
      return;
    }
    validate();
    if (wholeDirectory && !stat.isDirectory() && (!stat.isFile() || stat.nlink !== 1)) {
      throw new Error("Refusing an unsafe symlink, hard link, or special file during snapshot mutation.");
    }
    if (sessionPath && stat.isFile() && !configured(sessionPath)) refuse();
    if (!recursive || !stat.isDirectory()) return;
    const children: string[] = [];
    for await (const entry of await fs.opendir(target)) {
      reserveVisit();
      children.push(entry.name);
    }
    async function recheckDirectory() {
      if (!wholeDirectory) return;
      const current = await fs.lstat(target);
      validate();
      if (
        !current.isDirectory() ||
        current.dev !== stat.dev ||
        current.ino !== stat.ino ||
        current.ctimeMs !== stat.ctimeMs
      )
        refuse();
    }
    await recheckDirectory();
    for (const child of children) await visit(path.join(target, child));
    await recheckDirectory();
  }
  async function assertParents(target: string, includeTarget = false) {
    let parent = agentDirectoryAnchor(root, target);
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
  validate();
  if (wholeDirectory && options.sessionDir) await assertParents(sessionRoot, true);
  for (const target of new Set(targets)) {
    reserveVisit();
    if (
      wholeDirectory &&
      (physicalRelative(root, target) !== undefined || physicalRelative(sessionRoot, target) !== undefined)
    ) {
      await assertParents(target);
    }
    await visit(target);
  }
}
