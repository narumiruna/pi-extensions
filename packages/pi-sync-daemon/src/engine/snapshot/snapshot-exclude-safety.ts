import { lstatSync, type Stats } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { isPathInside, toPosix } from "../paths.js";
import { mergePathIdentity } from "../sync/file-merge-planner.js";
import {
  compileSyncPolicyExclude,
  compileSyncPolicyTraversal,
  configuredSnapshotPathMatcher,
  isIgnoreControlPath,
  type SyncSelectionConfig,
} from "../sync/sync-policy.js";
import { sessionStorageRoot } from "./snapshot-paths.js";
import type { DirectoryScope, EffectiveIgnorePolicy } from "./snapshot-types.js";

function directoryStat(absolute: string) {
  try {
    return lstatSync(absolute, { throwIfNoEntry: false });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOTDIR") throw error;
    return undefined;
  }
}

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
  return (
    samePortableName && path.dirname(left) !== left && sameDirectoryPrefix(path.dirname(left), path.dirname(right))
  );
}

export function agentDirectoryAnchor(root: string, boundary: string) {
  let anchor = path.dirname(path.resolve(root));
  while (!isPathInside(anchor, boundary)) {
    const parent = path.dirname(anchor);
    if (parent === anchor) return path.parse(boundary).root;
    anchor = parent;
  }
  return anchor;
}

export function agentDirectorySessionRoot(
  root: string,
  sessionDir?: string,
  ignorePolicy?: EffectiveIgnorePolicy,
  reservedIgnoreNames?: DirectoryScope["reservedIgnoreNames"],
) {
  const sessionRoot = sessionStorageRoot(root, sessionDir);
  if (physicalRelative(sessionRoot, root) !== undefined)
    throw new Error("Pi session storage overlaps the agent directory root.");
  const relative = physicalRelative(root, sessionRoot);
  if (relative !== undefined) {
    const logical = toPosix(relative);
    const canTraverse = compileSyncPolicyTraversal({ scope: "agent-directory", include: ["sessions"] });
    const reserved =
      ignorePolicy || reservedIgnoreNames
        ? new Set(
            [
              ...(ignorePolicy ? [ignorePolicy.filename, ...ignorePolicy.reservedNames] : []),
              ...(reservedIgnoreNames ?? []),
            ].map((name) => name.toLowerCase()),
          )
        : undefined;
    if (!canTraverse(logical) || (reserved && isIgnoreControlPath(logical, reserved)))
      throw new Error("Pi session storage overlaps protected agent files.");
  }
  return sessionRoot;
}

export function agentDirectoryPhysicalSessionPath(
  root: string,
  sessionDir?: string,
  ignorePolicy?: EffectiveIgnorePolicy,
  reservedIgnoreNames?: DirectoryScope["reservedIgnoreNames"],
) {
  const sessionRoot = agentDirectorySessionRoot(root, sessionDir, ignorePolicy, reservedIgnoreNames);
  const nested = physicalRelative(root, sessionRoot) !== undefined;
  return (relativePath: string) =>
    nested && physicalRelative(sessionRoot, path.resolve(root, relativePath)) !== undefined;
}

async function realpathWithMissingTail(target: string): Promise<string> {
  let ancestor = path.resolve(target);
  for (;;) {
    try {
      const resolved = await fs.realpath(ancestor);
      return path.resolve(resolved, path.relative(ancestor, target));
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      const parent = path.dirname(ancestor);
      if (parent === ancestor || (code !== "ENOENT" && code !== "ENOTDIR")) throw error;
      ancestor = parent;
    }
  }
}

export function reservedIgnoreTargetGuard(root: string, options: Pick<DirectoryScope, "reservedIgnoreNames">) {
  if (options.reservedIgnoreNames === undefined) return undefined;
  const reserved = new Set(options.reservedIgnoreNames);
  function check(agentRoot: string, target: string) {
    const relative = physicalRelative(agentRoot, target);
    if (
      physicalRelative(target, agentRoot) !== undefined ||
      (relative !== undefined && isIgnoreControlPath(toPosix(relative), reserved))
    )
      throw new Error("Transfer would access a protected ignore rule path or its ancestor.");
  }
  return async (target: string) => {
    check(root, target);
    const canonicalRoot = await realpathWithMissingTail(root);
    const canonicalTarget = await realpathWithMissingTail(target);
    check(canonicalRoot, canonicalTarget);
    return canonicalTarget;
  };
}

/** Metadata-only preflight: an ancestor replacement must not capture/remove excluded descendants. */
export async function assertUnexcludedTargets(
  root: string,
  targets: Iterable<string>,
  options: SyncSelectionConfig & { sessionDir?: string; signal?: AbortSignal; validateMutation?: () => void },
  { recursive = true }: { recursive?: boolean } = {},
) {
  const wholeDirectory = options.scope === "agent-directory";
  const guardReserved = reservedIgnoreTargetGuard(root, options);
  if (
    !wholeDirectory &&
    !guardReserved &&
    (options.exclude === undefined || (Array.isArray(options.exclude) && !options.exclude.length))
  )
    return;
  const excluded = compileSyncPolicyExclude(options);
  const sessionRoot = wholeDirectory
    ? agentDirectorySessionRoot(root, options.sessionDir, options.ignorePolicy, options.reservedIgnoreNames)
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
  function refuse(): never {
    throw new Error("Transfer would replace an excluded path or directory descendant; no replacement is authorized.");
  }
  async function visit(target: string): Promise<void> {
    validate();
    if (guardReserved) {
      await guardReserved(target);
      validate();
    }
    let logicalPath: string | undefined;
    let sessionPath: string | undefined;
    if (wholeDirectory) {
      if (physicalRelative(target, sessionRoot) !== undefined) refuse();
      const sessionRelative = physicalRelative(sessionRoot, target);
      if (sessionRelative !== undefined) {
        sessionPath = `sessions/${toPosix(sessionRelative)}`;
        logicalPath = sessionPath;
      } else {
        const relative = physicalRelative(root, target);
        if (!relative || /^sessions(?:\/|$)/iu.test(toPosix(relative))) refuse();
        logicalPath = toPosix(relative);
      }
      if (!options.ignorePolicy && excluded(logicalPath)) refuse();
    } else {
      const candidates: string[] = [];
      if (isPathInside(root, target)) candidates.push(toPosix(path.relative(root, target)));
      if (isPathInside(sessionRoot, target)) candidates.push(`sessions/${toPosix(path.relative(sessionRoot, target))}`);
      if (candidates.some((candidate) => excluded(candidate))) refuse();
    }
    let observed: Stats | undefined;
    try {
      observed = await fs.lstat(target);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") {
        validate();
        throw error;
      }
    }
    validate();
    if (options.ignorePolicy && logicalPath !== undefined && excluded(logicalPath, observed?.isDirectory())) refuse();
    if (!observed) return;
    const stat = observed;
    if (
      (wholeDirectory && !stat.isDirectory() && (!stat.isFile() || stat.nlink !== 1)) ||
      (guardReserved && stat.isFile() && stat.nlink !== 1)
    ) {
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
          break;
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
