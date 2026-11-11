import { constants, type Dirent } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { MAX_CORPUS_BYTES, MAX_FILE_BYTES, MAX_FILES, SETTINGS_FILE_NAME } from "./constants.js";

const IGNORED_DIRECTORIES = new Set([
  ".git",
  ".hg",
  ".svn",
  ".aws",
  ".gnupg",
  ".ssh",
  ".next",
  ".nuxt",
  ".turbo",
  ".venv",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "target",
  "vendor",
]);
const SENSITIVE_BASENAMES = new Set([
  ".git-credentials",
  ".netrc",
  ".npmrc",
  ".pypirc",
  "credentials",
  "credentials.json",
  "id_dsa",
  "id_ecdsa",
  "id_ed25519",
  "id_rsa",
  "secrets.json",
  "service-account.json",
  SETTINGS_FILE_NAME,
]);
const SENSITIVE_EXTENSIONS = new Set([".key", ".p12", ".pem", ".pfx"]);

export interface DiscoveredFile {
  path: string;
  absolutePath: string;
  size: number;
  mtimeNs: string;
  dev: string;
  ino: string;
}

export interface DiscoveryResult {
  root: string;
  workspacePrefix: string;
  files: DiscoveredFile[];
  skippedDirectories: number;
  skippedFiles: number;
  totalBytes: number;
}

export interface LoadedTextFile extends DiscoveredFile {
  text: string;
  lines: string[];
}

export interface StoredFileSnapshot {
  path: string;
  dev: string;
  ino: string;
  size: number;
  mtimeNs: string;
}

export type SearchFileStatus = "current" | "changed" | "absent" | "unavailable";

export class UnsupportedSearchFileError extends Error {}

export async function resolveSearchRoot(cwd: string, inputPath: string, signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted();
  const canonicalCwd = await realpath(cwd);
  signal?.throwIfAborted();
  const cleaned = inputPath.startsWith("@") ? inputPath.slice(1) : inputPath;
  if (!cleaned.trim()) throw new Error("jev_search path must not be empty");
  const candidate = resolve(canonicalCwd, cleaned);
  if (!isInside(canonicalCwd, candidate)) throw new Error("jev_search path must stay inside the current workspace");
  const canonicalRoot = await realpath(candidate);
  signal?.throwIfAborted();
  if (!isInside(canonicalCwd, canonicalRoot)) {
    throw new Error("jev_search path resolves outside the current workspace");
  }
  const stats = await lstat(canonicalRoot);
  if (!stats.isDirectory()) throw new Error("jev_search path must identify a directory");
  return canonicalRoot;
}

export async function discoverSearchFiles(
  cwd: string,
  inputPath: string,
  signal?: AbortSignal,
): Promise<DiscoveryResult> {
  const root = await resolveSearchRoot(cwd, inputPath, signal);
  const canonicalCwd = await realpath(cwd);
  signal?.throwIfAborted();
  const workspacePrefix = toPosix(relative(canonicalCwd, root));
  const agentDirectory = await canonicalAgentDirectory();
  signal?.throwIfAborted();
  if (agentDirectory && isInside(agentDirectory, root)) {
    throw new Error("jev_search path must not select the Pi agent directory");
  }
  const files: DiscoveredFile[] = [];
  const directories = [root];
  let skippedDirectories = 0;
  let skippedFiles = 0;
  let totalBytes = 0;

  for (let directoryIndex = 0; directoryIndex < directories.length; directoryIndex += 1) {
    signal?.throwIfAborted();
    const directory = directories[directoryIndex];
    if (!directory) break;
    let entries: Dirent<string>[];
    let before: Awaited<ReturnType<typeof lstat>>;
    try {
      const canonicalDirectory = await realpath(directory);
      signal?.throwIfAborted();
      if (canonicalDirectory !== directory || !isInside(root, canonicalDirectory)) {
        throw new Error("directory identity changed or escaped the search root");
      }
      before = await lstat(directory, { bigint: true });
      if (!before.isDirectory() || before.isSymbolicLink()) throw new Error("directory is not safe to traverse");
      entries = await readdir(directory, { withFileTypes: true });
      const after = await lstat(directory, { bigint: true });
      if (!after.isDirectory() || after.dev !== before.dev || after.ino !== before.ino) {
        throw new Error("directory identity changed while it was read");
      }
    } catch (error: unknown) {
      if (directory === root) throw new Error(`Cannot read search directory: ${formatError(error)}`);
      skippedDirectories += 1;
      continue;
    }
    entries.sort((left, right) => left.name.localeCompare(right.name));

    for (const entry of entries) {
      signal?.throwIfAborted();
      if (entry.name.includes("\0")) {
        skippedFiles += 1;
        continue;
      }
      const absolutePath = resolve(directory, entry.name);
      let stats: Awaited<ReturnType<typeof lstat>>;
      try {
        stats = await lstat(absolutePath, { bigint: true });
      } catch {
        skippedFiles += 1;
        continue;
      }
      if (stats.isSymbolicLink()) {
        if (entry.isDirectory()) skippedDirectories += 1;
        else skippedFiles += 1;
        continue;
      }
      if (stats.isDirectory()) {
        if (IGNORED_DIRECTORIES.has(entry.name) || (agentDirectory && isInside(agentDirectory, absolutePath))) {
          skippedDirectories += 1;
          continue;
        }
        directories.push(absolutePath);
        continue;
      }
      if (!stats.isFile() || isSensitiveFileName(entry.name)) {
        skippedFiles += 1;
        continue;
      }
      const size = Number(stats.size);
      if (!Number.isSafeInteger(size) || size > MAX_FILE_BYTES) {
        skippedFiles += 1;
        continue;
      }
      if (files.length >= MAX_FILES) {
        throw new Error(`Search directory exceeds the ${MAX_FILES}-file index limit; choose a narrower path`);
      }
      totalBytes += size;
      if (totalBytes > MAX_CORPUS_BYTES) {
        throw new Error(`Search directory exceeds the ${MAX_CORPUS_BYTES}-byte index limit; choose a narrower path`);
      }
      files.push({
        path: toPosix(relative(root, absolutePath)),
        absolutePath,
        size,
        mtimeNs: stats.mtimeNs.toString(),
        dev: stats.dev.toString(),
        ino: stats.ino.toString(),
      });
    }
  }

  files.sort((left, right) => left.path.localeCompare(right.path));
  return { root, workspacePrefix, files, skippedDirectories, skippedFiles, totalBytes };
}

export async function loadTextFile(file: DiscoveredFile, root: string, signal?: AbortSignal): Promise<LoadedTextFile> {
  signal?.throwIfAborted();
  if (isAbsolute(file.path) || !isInside(root, file.absolutePath)) {
    throw new Error(`Indexed path escaped the search root: ${file.path}`);
  }
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(
      file.absolutePath,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
    );
  } catch (error: unknown) {
    throw new Error(`Cannot safely open ${file.path}: ${formatError(error)}`);
  }

  try {
    const stats = await handle.stat({ bigint: true });
    signal?.throwIfAborted();
    if (!stats.isFile()) throw new Error(`${file.path} is not a regular file`);
    const canonicalPath = await realpath(file.absolutePath);
    signal?.throwIfAborted();
    const pathStats = await lstat(file.absolutePath, { bigint: true });
    if (
      canonicalPath !== file.absolutePath ||
      !isInside(root, canonicalPath) ||
      !pathStats.isFile() ||
      pathStats.isSymbolicLink() ||
      pathStats.dev !== stats.dev ||
      pathStats.ino !== stats.ino
    ) {
      throw new Error(`${file.path} changed path identity while it was being opened`);
    }
    if (
      stats.dev.toString() !== file.dev ||
      stats.ino.toString() !== file.ino ||
      stats.mtimeNs.toString() !== file.mtimeNs
    ) {
      throw new Error(`${file.path} changed while it was being opened`);
    }
    if (Number(stats.size) !== file.size || stats.size > BigInt(MAX_FILE_BYTES)) {
      throw new Error(`${file.path} changed size while it was being opened`);
    }

    const buffer = Buffer.alloc(file.size + 1);
    let offset = 0;
    while (offset < buffer.length) {
      signal?.throwIfAborted();
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset > MAX_FILE_BYTES || offset !== file.size) throw new Error(`${file.path} changed while it was read`);
    signal?.throwIfAborted();
    const [finalHandleStats, finalCanonicalPath, finalPathStats] = await Promise.all([
      handle.stat({ bigint: true }),
      realpath(file.absolutePath),
      lstat(file.absolutePath, { bigint: true }),
    ]);
    signal?.throwIfAborted();
    if (
      finalCanonicalPath !== file.absolutePath ||
      !isInside(root, finalCanonicalPath) ||
      !finalPathStats.isFile() ||
      finalPathStats.isSymbolicLink() ||
      finalPathStats.dev !== finalHandleStats.dev ||
      finalPathStats.ino !== finalHandleStats.ino ||
      finalPathStats.size !== finalHandleStats.size ||
      finalPathStats.mtimeNs !== finalHandleStats.mtimeNs ||
      finalHandleStats.dev !== stats.dev ||
      finalHandleStats.ino !== stats.ino ||
      finalHandleStats.size !== stats.size ||
      finalHandleStats.mtimeNs !== stats.mtimeNs
    ) {
      throw new Error(`${file.path} changed while it was read`);
    }
    const contents = buffer.subarray(0, offset);
    if (contents.includes(0)) throw new UnsupportedSearchFileError(`${file.path} appears to be binary`);
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(contents);
    } catch {
      throw new UnsupportedSearchFileError(`${file.path} is not valid UTF-8`);
    }
    text = text.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
    return { ...file, text, lines: text.split("\n") };
  } finally {
    await handle.close();
  }
}

async function canonicalAgentDirectory(): Promise<string | undefined> {
  try {
    return await realpath(getAgentDir());
  } catch (error: unknown) {
    if (isNodeError(error) && error.code === "ENOENT") return undefined;
    throw error;
  }
}

export async function searchFileStatus(
  root: string,
  file: StoredFileSnapshot,
  signal?: AbortSignal,
): Promise<SearchFileStatus> {
  signal?.throwIfAborted();
  if (isAbsolute(file.path)) return "changed";
  const segments = file.path.split("/");
  if (segments.some((segment) => IGNORED_DIRECTORIES.has(segment)) || isSensitiveFileName(basename(file.path))) {
    return "changed";
  }
  const candidate = resolve(root, file.path);
  if (!isInside(root, candidate)) return "changed";

  try {
    const canonicalPath = await realpath(candidate);
    signal?.throwIfAborted();
    const stats = await lstat(candidate, { bigint: true });
    signal?.throwIfAborted();
    const agentDirectory = await canonicalAgentDirectory();
    signal?.throwIfAborted();
    const size = Number(stats.size);
    if (
      canonicalPath !== candidate ||
      !isInside(root, canonicalPath) ||
      (agentDirectory && isInside(agentDirectory, canonicalPath)) ||
      !stats.isFile() ||
      stats.isSymbolicLink() ||
      !Number.isSafeInteger(size) ||
      size > MAX_FILE_BYTES
    ) {
      return "changed";
    }
    return stats.dev.toString() === file.dev &&
      stats.ino.toString() === file.ino &&
      size === file.size &&
      stats.mtimeNs.toString() === file.mtimeNs
      ? "current"
      : "changed";
  } catch (error: unknown) {
    if (signal?.aborted) signal.throwIfAborted();
    return isNodeError(error) && error.code === "ENOENT" ? "absent" : "unavailable";
  }
}

export function isSensitiveFileName(name: string): boolean {
  const lower = name.toLowerCase();
  if (lower === ".env" || lower.startsWith(".env.")) return true;
  if (SENSITIVE_BASENAMES.has(lower)) return true;
  for (const extension of SENSITIVE_EXTENSIONS) {
    if (lower.endsWith(extension)) return true;
  }
  return lower.endsWith(".secret") || lower.endsWith(".secrets");
}

function isInside(root: string, candidate: string): boolean {
  const child = relative(root, candidate);
  return child === "" || (!isAbsolute(child) && child !== ".." && !child.startsWith(`..${sep}`));
}

function toPosix(path: string): string {
  return path.split(sep).join("/");
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
