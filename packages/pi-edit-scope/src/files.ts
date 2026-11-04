import type { Dir, Dirent } from "node:fs";
import fs from "node:fs/promises";
import { resolve } from "node:path";

/** Internal discovery limits, not settings; exceeding any limit fails the whole scan. */
export const MAX_SCOPE_FILES = 5_000;
export const MAX_SCOPE_ENTRIES = 20_000;
/** cwd is depth zero; directories through depth 64 are scanned. */
export const MAX_SCOPE_DEPTH = 64;

/** Exact directory names skipped at every depth; .gitignore is not read. */
export const SCOPE_EXCLUDED_DIRECTORIES: readonly string[] = Object.freeze([
  ".git",
  ".hg",
  ".svn",
  "node_modules",
  ".venv",
  "venv",
  "__pycache__",
  "build",
  "coverage",
  "dist",
  "target",
  ".next",
]);
const excludedDirectories = new Set(SCOPE_EXCLUDED_DIRECTORIES);

function scanError(action: string, path: string, cause: unknown): Error {
  const code = cause && typeof cause === "object" && "code" in cause ? ` (${String(cause.code)})` : "";
  return new Error(`Scope cannot ${action} ${JSON.stringify(path)}${code}. Check access and retry.`, { cause });
}

async function closeDirectory(handle: Dir, path: string, signal?: AbortSignal): Promise<void> {
  try {
    await handle.close();
  } catch (error) {
    signal?.throwIfAborted();
    throw scanError("close directory", path, error);
  }
  signal?.throwIfAborted();
}

/**
 * Return normalized absolute lexical paths beneath cwd. Skip symlink entries and
 * nonregular files. Hidden entries still count toward the work cap. No writes,
 * .gitignore processing, or partial results. A symlink used as cwd is permitted.
 */
export async function discoverScopeFiles(
  cwd: string,
  showHiddenFiles: boolean,
  signal?: AbortSignal,
): Promise<string[]> {
  const files: string[] = [];
  let entryCount = 0;

  async function visit(directory: string, depth: number): Promise<void> {
    signal?.throwIfAborted();
    if (depth > MAX_SCOPE_DEPTH) {
      throw new Error(`Scope scan exceeds depth ${MAX_SCOPE_DEPTH}. Open a narrower working directory.`);
    }
    let handle: Awaited<ReturnType<typeof fs.opendir>>;
    try {
      handle = await fs.opendir(directory);
    } catch (error) {
      signal?.throwIfAborted();
      throw scanError("open directory", directory, error);
    }
    // Own the handle before checking cancellation, including an abort during open.
    try {
      signal?.throwIfAborted();
      while (true) {
        let entry: Dirent | null;
        try {
          entry = await handle.read();
        } catch (error) {
          signal?.throwIfAborted();
          throw scanError("read directory", directory, error);
        }
        signal?.throwIfAborted();
        if (!entry) break;
        entryCount += 1;
        if (entryCount > MAX_SCOPE_ENTRIES) {
          throw new Error(`Scope scan exceeds ${MAX_SCOPE_ENTRIES} entries. Open a narrower working directory.`);
        }
        if (entry.isSymbolicLink() || (!showHiddenFiles && entry.name.startsWith("."))) continue;
        if (entry.isDirectory() && excludedDirectories.has(entry.name)) continue;
        const path = resolve(directory, entry.name);
        let stats: Awaited<ReturnType<typeof fs.lstat>>;
        try {
          stats = await fs.lstat(path);
        } catch (error) {
          signal?.throwIfAborted();
          throw scanError("inspect entry", path, error);
        }
        signal?.throwIfAborted();
        // Recheck metadata so a previously observed directory symlink is not followed.
        if (stats.isSymbolicLink()) continue;
        if (stats.isDirectory()) {
          if (!excludedDirectories.has(entry.name)) await visit(path, depth + 1);
          signal?.throwIfAborted();
        } else if (stats.isFile()) {
          files.push(path);
          if (files.length > MAX_SCOPE_FILES) {
            throw new Error(`Scope scan exceeds ${MAX_SCOPE_FILES} files. Open a narrower working directory.`);
          }
        }
      }
    } finally {
      // Always drain close, even on cancellation or read failure. Do not race I/O
      // against an abort event and leave directory handles owned by a stale flow.
      await closeDirectory(handle, directory, signal);
    }
  }

  signal?.throwIfAborted();
  await visit(resolve(cwd), 0);
  signal?.throwIfAborted();
  return files.sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
}
