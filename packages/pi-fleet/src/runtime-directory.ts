import { randomBytes } from "node:crypto";
import { chmod, lstat, mkdir, open, opendir, realpath, rename, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

export const MAX_UNIX_SOCKET_PATH_BYTES = 103;
export const MAX_MANIFEST_BYTES = 8 * 1024;
export const ORPHAN_GRACE_MS = 60_000;
export const MAX_RUNTIME_SCAN_ENTRIES = 512;
const SAFE_GROUP_ID = /^[a-f0-9]{32}$/u;
const SAFE_ENDPOINT_ID = /^[a-f0-9]{24}$/u;
const SAFE_SOCKET_NAME = /^([a-f0-9]{24})\.sock$/u;
const SAFE_MANIFEST_NAME = /^([a-f0-9]{24})\.json$/u;
const SAFE_TEMPORARY_NAME = /^\.([a-f0-9]{24})\.json\.[a-f0-9]{16}\.tmp$/u;
const SAFE_LAUNCHER_NAME = /^launch-[a-f0-9]{16}\.sh$/u;

export interface RuntimeDirectoryOptions {
  baseDirectory?: string;
}

export interface EndpointPaths {
  directory: string;
  endpointId: string;
  socketPath: string;
  manifestPath: string;
}

export interface RuntimeCleanupResult {
  removedSockets: number;
  removedTemporaryFiles: number;
  saturated: boolean;
}

export function defaultRuntimeBaseDirectory(): string {
  if (process.platform === "win32") {
    throw new Error("Pi Fleet local transport requires a POSIX platform");
  }
  const uid = typeof process.getuid === "function" ? process.getuid() : 0;
  if (process.platform === "darwin") return join("/tmp", `pi-fleet-${uid}`);
  const runtime = process.env.XDG_RUNTIME_DIR;
  if (
    runtime &&
    isAbsolute(runtime) &&
    Buffer.byteLength(join(runtime, "pi-fleet", "x".repeat(32), `${"x".repeat(24)}.sock`)) <= MAX_UNIX_SOCKET_PATH_BYTES
  ) {
    return join(runtime, "pi-fleet");
  }
  const systemTmp = resolve(tmpdir());
  const candidate = join(systemTmp, `pi-fleet-${uid}`);
  const socketCandidate = join(candidate, "x".repeat(32), `${"x".repeat(24)}.sock`);
  return Buffer.byteLength(socketCandidate) <= MAX_UNIX_SOCKET_PATH_BYTES ? candidate : join("/tmp", `pi-fleet-${uid}`);
}

export async function ensureGroupRuntimeDirectory(
  groupId: string,
  options: RuntimeDirectoryOptions = {},
): Promise<string> {
  if (!SAFE_GROUP_ID.test(groupId)) throw new Error("Pi Fleet runtime group id is invalid");
  const baseDirectory = resolve(options.baseDirectory ?? defaultRuntimeBaseDirectory());
  const directory = join(baseDirectory, groupId);
  const longestSocket = join(directory, `${"x".repeat(24)}.sock`);
  if (Buffer.byteLength(longestSocket) > MAX_UNIX_SOCKET_PATH_BYTES) {
    throw new Error("Pi Fleet runtime directory exceeds the Unix socket path limit");
  }
  await ensurePrivateDirectory(baseDirectory);
  await ensurePrivateDirectory(directory);
  return directory;
}

export function createEndpointPaths(directory: string, endpointId: string): EndpointPaths {
  if (!SAFE_ENDPOINT_ID.test(endpointId)) throw new Error("Pi Fleet endpoint id is invalid");
  const socketPath = join(directory, `${endpointId}.sock`);
  if (Buffer.byteLength(socketPath) > MAX_UNIX_SOCKET_PATH_BYTES) {
    throw new Error("Pi Fleet socket path exceeds the Unix path limit");
  }
  return {
    directory,
    endpointId,
    socketPath,
    manifestPath: join(directory, `${endpointId}.json`),
  };
}

export function randomEndpointId(): string {
  return randomBytes(12).toString("hex");
}

export async function publishManifest(manifestPath: string, manifest: object): Promise<void> {
  const parent = dirname(manifestPath);
  await assertPrivateDirectory(parent);
  assertOwnedPath(parent, manifestPath, ".json");
  const body = `${JSON.stringify(manifest)}\n`;
  if (Buffer.byteLength(body) > MAX_MANIFEST_BYTES) {
    throw new Error("Pi Fleet endpoint manifest is too large");
  }
  const temporaryPath = join(parent, `.${basename(manifestPath)}.${randomBytes(8).toString("hex")}.tmp`);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporaryPath, "wx", 0o600);
    await handle.writeFile(body, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporaryPath, manifestPath);
    await chmod(manifestPath, 0o600);
  } finally {
    await handle?.close().catch(() => undefined);
    await rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}

export async function cleanupStaleRuntimeEntries(directory: string, now = Date.now()): Promise<RuntimeCleanupResult> {
  await assertPrivateDirectory(directory);
  const names = new Set<string>();
  let scanned = 0;
  let saturated = false;
  const handle = await opendir(directory);
  try {
    for await (const entry of handle) {
      if (scanned >= MAX_RUNTIME_SCAN_ENTRIES) {
        saturated = true;
        break;
      }
      scanned += 1;
      names.add(entry.name);
    }
  } finally {
    await handle.close().catch(() => undefined);
  }
  let removedSockets = 0;
  let removedTemporaryFiles = 0;
  for (const name of names) {
    const socketMatch = SAFE_SOCKET_NAME.exec(name);
    if (socketMatch) {
      const manifestPath = join(directory, `${socketMatch[1]}.json`);
      if (!(await pathExists(manifestPath))) {
        if (await removeStaleOwnedEntry(directory, name, "socket", now)) removedSockets += 1;
      }
      continue;
    }
    if (SAFE_TEMPORARY_NAME.test(name) || SAFE_LAUNCHER_NAME.test(name)) {
      if (await removeStaleOwnedEntry(directory, name, "file", now)) {
        removedTemporaryFiles += 1;
      }
    }
  }
  return { removedSockets, removedTemporaryFiles, saturated };
}

export async function removeOwnedEndpoint(paths: EndpointPaths): Promise<void> {
  for (const path of [paths.manifestPath, paths.socketPath]) {
    assertOwnedPath(paths.directory, path);
    await rm(path, { force: true }).catch(() => undefined);
  }
}

export function endpointIdFromManifestName(name: string): string | undefined {
  return SAFE_MANIFEST_NAME.exec(name)?.[1];
}

export function assertOwnedPath(parent: string, candidate: string, suffix?: string): void {
  const resolvedParent = resolve(parent);
  const resolvedCandidate = resolve(candidate);
  const rel = relative(resolvedParent, resolvedCandidate);
  if (!rel || rel === ".." || rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)) {
    throw new Error("Pi Fleet runtime path escapes its owner directory");
  }
  if (suffix && !basename(resolvedCandidate).endsWith(suffix)) {
    throw new Error("Pi Fleet runtime path has an invalid suffix");
  }
}

async function removeStaleOwnedEntry(
  directory: string,
  name: string,
  kind: "file" | "socket",
  now: number,
): Promise<boolean> {
  const path = join(directory, name);
  assertOwnedPath(directory, path);
  try {
    const first = await lstat(path, { bigint: true });
    assertOwner(Number(first.uid));
    if (kind === "file" ? !first.isFile() : !first.isSocket()) return false;
    if (now - Number(first.mtimeMs) < ORPHAN_GRACE_MS) return false;
    const current = await lstat(path, { bigint: true });
    if (
      current.dev !== first.dev ||
      current.ino !== first.ino ||
      current.mtimeMs !== first.mtimeMs ||
      (kind === "file" ? !current.isFile() : !current.isSocket())
    ) {
      return false;
    }
    await rm(path);
    return true;
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}

async function ensurePrivateDirectory(path: string): Promise<void> {
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink()) throw new Error("Pi Fleet runtime directory is a symbolic link");
    if (!info.isDirectory()) throw new Error("Pi Fleet runtime path is not a directory");
    assertOwner(info.uid);
    if ((info.mode & 0o777) !== 0o700) await chmod(path, 0o700);
    await assertPrivateDirectory(path);
  } catch (error) {
    if (!isMissing(error)) throw error;
    await mkdir(path, { recursive: true, mode: 0o700 });
    await chmod(path, 0o700);
    await assertPrivateDirectory(path);
  }
}

async function assertPrivateDirectory(path: string): Promise<void> {
  const info = await lstat(path);
  if (info.isSymbolicLink()) throw new Error("Pi Fleet runtime directory is a symbolic link");
  if (!info.isDirectory()) throw new Error("Pi Fleet runtime path is not a directory");
  assertOwner(info.uid);
  if ((info.mode & 0o777) !== 0o700) {
    throw new Error("Pi Fleet runtime directory permissions are not private");
  }
  const resolved = await realpath(path);
  const resolvedInfo = await stat(resolved);
  assertOwner(resolvedInfo.uid);
}

function assertOwner(uid: number): void {
  if (typeof process.getuid !== "function") return;
  if (uid !== process.getuid()) throw new Error("Pi Fleet runtime path is owned by another user");
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}

function isMissing(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}
