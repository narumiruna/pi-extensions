import fs from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface ScopeTarget {
  /** Normalized absolute lexical path; do not apply tool input normalization again. */
  path: string;
  canonical: string;
}

export interface ResolvedScopeTarget extends ScopeTarget {
  exists: boolean;
}

// Mirrors Pi's installed utils/paths.js and tools/path-utils.js write/edit path.
// Do not trim, normalize Unicode composition, or use the read-only macOS fallbacks.
function normalizePath(input: string, toolPath: boolean): string {
  let normalized = toolPath ? input.replace(/[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g, " ") : input;
  if (toolPath && normalized.startsWith("@")) normalized = normalized.slice(1);
  if (
    process.platform === "win32" &&
    normalized.startsWith("/") &&
    !normalized.startsWith("//") &&
    !normalized.includes("\\")
  ) {
    const match = normalized.match(/^\/(?:mnt\/|cygdrive\/)?([a-z])(?:\/(.*))?$/i);
    if (match) normalized = `${match[1].toUpperCase()}:\\${match[2]?.replaceAll("/", "\\") ?? ""}`;
  }
  const home = homedir();
  if (normalized === "~") return home;
  if (normalized.startsWith("~/") || (process.platform === "win32" && normalized.startsWith("~\\"))) {
    return join(home, normalized.slice(2));
  }
  return /^file:\/\//.test(normalized) ? fileURLToPath(normalized) : normalized;
}

/** The lexical target used by built-in write/edit; this does not access the filesystem. */
export function resolveWritePath(raw: string, cwd: string): string {
  const normalized = normalizePath(raw, true);
  const base = normalizePath(cwd, false);
  return isAbsolute(normalized) ? resolve(normalized) : resolve(base, normalized);
}

// Await OS work to completion before reporting cancellation; do not leave detached I/O.
async function checked<T>(signal: AbortSignal | undefined, operation: () => Promise<T>): Promise<T> {
  signal?.throwIfAborted();
  try {
    return await operation();
  } finally {
    signal?.throwIfAborted();
  }
}

async function inspect(path: string, signal?: AbortSignal) {
  try {
    return await checked(signal, () => fs.lstat(path));
  } catch (error) {
    signal?.throwIfAborted();
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
}

/**
 * Resolve existing files, or a missing suffix below the nearest existing directory.
 * Symlinks may resolve to regular files/directories, but dangling links and hard-linked
 * files are rejected. Only ENOENT means missing; permission and other errors propagate.
 */
export async function resolveScopeTarget(
  raw: string,
  cwd: string,
  requirement: "existing" | "new" | "either",
  signal?: AbortSignal,
): Promise<ResolvedScopeTarget> {
  signal?.throwIfAborted();
  return resolveLexicalTarget(resolveWritePath(raw, cwd), requirement, signal);
}

async function resolveLexicalTarget(
  path: string,
  requirement: "existing" | "new" | "either",
  signal?: AbortSignal,
): Promise<ResolvedScopeTarget> {
  signal?.throwIfAborted();
  let ancestor = path;
  const suffix: string[] = [];
  let entry = await inspect(ancestor, signal);
  signal?.throwIfAborted();
  while (!entry) {
    const parent = dirname(ancestor);
    if (parent === ancestor) throw new Error(`No existing ancestor for scope target ${JSON.stringify(path)}.`);
    suffix.unshift(basename(ancestor));
    ancestor = parent;
    entry = await inspect(ancestor, signal);
    signal?.throwIfAborted();
  }

  // realpath must succeed even for symlinks: an ENOENT here is a dangling link,
  // not a missing target which write is permitted to create.
  const realAncestor = await checked(signal, () => fs.realpath(ancestor));
  const stats = await checked(signal, () => fs.stat(realAncestor));
  const exists = suffix.length === 0;
  if (exists) {
    if (!stats.isFile()) throw new Error(`Scope target must be a regular file: ${JSON.stringify(path)}.`);
    if (stats.nlink > 1) throw new Error(`Scope does not support hard-linked files: ${JSON.stringify(path)}.`);
  } else if (!stats.isDirectory()) {
    throw new Error(`Scope target parent must be a directory: ${JSON.stringify(ancestor)}.`);
  }
  if (requirement === "existing" && !exists) {
    throw new Error(`Scope target does not exist: ${JSON.stringify(path)}.`);
  }
  if (requirement === "new" && exists) {
    throw new Error(`Scope target already exists: ${JSON.stringify(path)}.`);
  }
  return { path, canonical: resolve(realAncestor, ...suffix), exists };
}

/** Exact canonical matching, with fresh checks of both the reservation and mutation. */
export async function assertScopeTarget(
  raw: string,
  cwd: string,
  targets: readonly ScopeTarget[],
  signal?: AbortSignal,
): Promise<void> {
  const candidate = await resolveScopeTarget(raw, cwd, "either", signal);
  signal?.throwIfAborted();
  const selected = targets.find((target) => target.canonical === candidate.canonical);
  if (!selected) throw new Error("Scope blocks this target: it is not an allowed file.");
  const refreshed = await resolveLexicalTarget(selected.path, "either", signal);
  signal?.throwIfAborted();
  if (refreshed.canonical !== selected.canonical) {
    throw new Error("Scope target changed since selection. Select the allowed files again.");
  }
  const rechecked = await resolveScopeTarget(raw, cwd, "either", signal);
  signal?.throwIfAborted();
  if (rechecked.canonical !== selected.canonical) {
    throw new Error("Scope mutation target changed during validation. Try again.");
  }
  // This is a trusted-extension guard, not race-free OS containment. Pi performs
  // the mutation later; another process can still change filesystem entries.
}
