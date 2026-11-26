import { createHash } from "node:crypto";
import nodeFs, { type BigIntStats, constants, type Stats } from "node:fs";
import fs, { type FileHandle } from "node:fs/promises";
import path from "node:path";
import { syncDirectory } from "../state/json-file.js";
import { mergePathIdentity } from "../sync/file-merge-planner.js";
import { MAX_AGENT_DIRECTORY_ENTRIES, MAX_AGENT_DIRECTORY_FILES } from "../sync/sync-policy.js";
import { MAX_AGENT_DIRECTORY_BYTES } from "./snapshot-bounds.js";
import { fileImage } from "./snapshot-transaction-plan.js";
import { isScopedIdentity, type TransactionEntry } from "./snapshot-transaction-policy.js";

export const MAX_TRANSACTION_JOURNAL_BYTES = 32 * 1024 * 1024;
const CHUNK_BYTES = 64 * 1024;

interface Guards {
  signal?: AbortSignal;
  validateMutation?: () => void;
}

interface ScopedDirectoryImage {
  kind: "directory";
  value: string;
  stat: BigIntStats;
  children: [string, ScopedNode][];
}

type ScopedNode = { kind: "file"; value: string; stat: BigIntStats } | ScopedDirectoryImage;
export type ScopedImage = { kind: "missing"; value: "missing" } | ScopedNode;

export async function scopedPathIdentity(target: string, guards: Guards) {
  validate(guards);
  const stat = await fs.lstat(target, { bigint: true });
  validate(guards);
  return scopedIdentity(stat);
}

export function scopedIdentity(stat: BigIntStats) {
  const identity = `${stat.dev}:${stat.ino}:${stat.birthtimeNs}`;
  if (!isScopedIdentity(identity)) changedImage();
  return identity;
}

export function installedVacancyIdentityMatches(image: ScopedImage, expected: string) {
  if (image.kind === "missing" || !isScopedIdentity(expected)) return false;
  if (scopedIdentity(image.stat) === expected) return true;
  if (process.platform !== "win32" || image.kind !== "file" || image.stat.ino === 0n) return false;
  const [device, inode] = expected.split(":");
  return image.stat.dev.toString() === device && image.stat.ino.toString() === inode;
}

export function stableScopedIdentity(target: string, stat: BigIntStats) {
  const identity = scopedIdentity(stat);
  if (stat.birthtimeNs > 0n) {
    if (stat.birthtimeNs !== stat.ctimeNs) return identity;
    if (["darwin", "freebsd", "netbsd", "win32"].includes(process.platform)) return identity;
    if (process.platform === "linux" || process.platform === "android") {
      const current = nodeFs.lstatSync(target, { bigint: true });
      if (!sameObservation(stat, current)) changedImage();
      for (let ancestor = target; ancestor !== path.dirname(ancestor); ) {
        ancestor = path.dirname(ancestor);
        const witness = nodeFs.lstatSync(ancestor, { bigint: true });
        if (!witness.isDirectory() || witness.dev !== stat.dev) break;
        if (witness.birthtimeNs > 0n && witness.birthtimeNs !== witness.ctimeNs) return identity;
      }
    }
  }
  throw new Error("Stable filesystem birth time is unavailable; preserve transaction evidence for reviewed recovery.");
}

function validate(guards: Guards) {
  guards.signal?.throwIfAborted();
  guards.validateMutation?.();
}

function changedImage(): never {
  throw new Error("Transaction image changed or is unsafe; preserve evidence for review.");
}

function sameIdentity(a: BigIntStats, b: BigIntStats) {
  return (
    a.dev === b.dev &&
    a.ino === b.ino &&
    a.mode === b.mode &&
    (a.birthtimeNs <= 0n || a.birthtimeNs === a.ctimeNs || a.birthtimeNs === b.birthtimeNs)
  );
}

function sameObservation(a: BigIntStats, b: BigIntStats) {
  return (
    sameIdentity(a, b) &&
    a.nlink === b.nlink &&
    a.size === b.size &&
    a.mtimeNs === b.mtimeNs &&
    a.ctimeNs === b.ctimeNs &&
    a.birthtimeNs === b.birthtimeNs
  );
}

async function lstat(target: string, guards: Guards): Promise<BigIntStats | undefined> {
  validate(guards);
  let stat: BigIntStats;
  try {
    stat = await fs.lstat(target, { bigint: true });
  } catch (error) {
    validate(guards);
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return undefined;
    throw error;
  }
  validate(guards);
  return stat;
}

async function recheck(target: string, original: BigIntStats, guards: Guards, identityOnly = false) {
  const current = await lstat(target, guards);
  if (!current || !(identityOnly ? sameIdentity : sameObservation)(original, current)) changedImage();
}

async function readStableFile(
  target: string,
  original: BigIntStats,
  guards: Guards,
  consume: (chunk: Buffer, offset: number) => void | Promise<void>,
) {
  validate(guards);
  const handle = await fs.open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const opened = await handle.stat({ bigint: true });
    validate(guards);
    if (!opened.isFile() || !sameObservation(original, opened)) changedImage();
    await recheck(target, original, guards);
    const size = Number(original.size);
    const buffer = Buffer.alloc(Math.min(CHUNK_BYTES, size));
    for (let offset = 0; offset < size; ) {
      validate(guards);
      const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, size - offset), offset);
      validate(guards);
      if (bytesRead === 0) changedImage();
      await consume(buffer.subarray(0, bytesRead), offset);
      offset += bytesRead;
    }
    if (!sameObservation(original, await handle.stat({ bigint: true }))) changedImage();
  } finally {
    await handle.close();
  }
  await recheck(target, original, guards);
}

export async function verifyUnchangedFile(target: string, content: Buffer, guards: Guards) {
  const stat = await lstat(target, guards);
  if (!stat?.isFile() || stat.nlink !== 1n || stat.size !== BigInt(content.length)) skippedPreimageChanged();
  await recheckUnchangedFile(target, stat, guards);
  await readStableFile(target, stat, guards, (chunk, offset) => {
    if (!chunk.equals(content.subarray(offset, offset + chunk.length))) skippedPreimageChanged();
  });
  return stat;
}

export async function recheckUnchangedFile(target: string, stat: BigIntStats, guards: Guards) {
  validate(guards);
  let canonical: string;
  try {
    canonical = await fs.realpath(target);
  } catch (error) {
    validate(guards);
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") skippedPreimageChanged();
    throw error;
  }
  validate(guards);
  if (canonical !== target) skippedPreimageChanged();
  const current = await lstat(target, guards);
  if (!current || !sameObservation(stat, current)) skippedPreimageChanged();
}

function skippedPreimageChanged(): never {
  throw new Error("Skipped file preimage changed before apply; snapshot installation refused.");
}

export async function readTransactionJournal(file: string, guards: Guards, maxBytes = MAX_TRANSACTION_JOURNAL_BYTES) {
  const stat = await lstat(file, guards);
  if (!stat) return undefined;
  if (!stat.isFile() || stat.nlink !== 1n || stat.size > maxBytes) changedImage();
  const content = Buffer.alloc(Number(stat.size));
  await readStableFile(file, stat, guards, (chunk, offset) => {
    chunk.copy(content, offset);
  });
  return content.toString("utf8");
}

export async function scopedTransactionImage(
  target: string,
  guards: Guards,
  copyTo?: string,
  checkPath?: (source: string) => Promise<void>,
  beforeCopyFile?: (handle: FileHandle) => Promise<void>,
): Promise<ScopedImage> {
  const stat = await lstat(target, guards);
  if (!stat) return { kind: "missing", value: "missing" };
  let entries = 1;
  let files = 0;
  let bytes = 0;
  async function visit(source: string, observed: BigIntStats, destination: string | undefined): Promise<ScopedNode> {
    if (checkPath) await checkPath(source);
    validate(guards);
    if (observed.isDirectory()) {
      const names: string[] = [];
      for await (const entry of await fs.opendir(source)) {
        validate(guards);
        if (++entries > MAX_AGENT_DIRECTORY_ENTRIES)
          throw new Error("Transaction image exceeds the agent-directory entry bound.");
        names.push(entry.name);
      }
      await recheck(source, observed, guards);
      if (destination) await fs.mkdir(destination, { mode: 0o700 });
      const children: [string, ScopedNode][] = [];
      for (const name of names.sort()) {
        const child = path.join(source, name);
        const stat = await lstat(child, guards);
        if (!stat) changedImage();
        children.push([name, await visit(child, stat, destination && path.join(destination, name))]);
      }
      if (destination) {
        validate(guards);
        await fs.chmod(destination, Number(observed.mode & 0o777n));
        validate(guards);
        await fs.utimes(destination, observed.atime, observed.mtime);
        validate(guards);
        await syncDirectory(destination);
      }
      await recheck(source, observed, guards);
      const rows = children.map(([name, child]) => [name, child.value]);
      const value = `directory:${createHash("sha256").update(JSON.stringify(rows)).digest("hex")}`;
      return { kind: "directory", value, stat: observed, children };
    }
    if (!observed.isFile() || observed.nlink !== 1n) changedImage();
    if (++files > MAX_AGENT_DIRECTORY_FILES)
      throw new Error("Transaction image exceeds the agent-directory file bound.");
    bytes += Number(observed.size);
    if (bytes > MAX_AGENT_DIRECTORY_BYTES) throw new Error("Transaction image exceeds the 64 MiB byte bound.");
    const hash = createHash("sha256");
    const copy = destination ? await fs.open(destination, "wx", 0o600) : undefined;
    try {
      if (copy && beforeCopyFile) {
        if (process.platform === "darwin") {
          validate(guards);
          await copy.utimes(observed.atime, observed.mtime);
          validate(guards);
          await copy.sync();
          validate(guards);
        }
        await beforeCopyFile(copy);
      }
      await readStableFile(source, observed, guards, async (chunk) => {
        hash.update(chunk);
        if (copy) await copy.writeFile(chunk);
      });
      if (copy) {
        validate(guards);
        await copy.chmod(Number(observed.mode & 0o777n));
        validate(guards);
        await copy.utimes(observed.atime, observed.mtime);
        validate(guards);
        await copy.sync();
      }
    } finally {
      await copy?.close();
    }
    validate(guards);
    return { kind: "file", value: `file:${hash.digest("hex")}`, stat: observed };
  }
  return visit(target, stat, copyTo);
}

export function ownedScopedSubset(image: ScopedImage, expected: ScopedImage): boolean {
  if (image.kind !== expected.kind) return false;
  if (image.kind !== "directory" || expected.kind !== "directory") return image.value === expected.value;
  const children = new Map(expected.children);
  return image.children.every(([name, child]) => {
    const original = children.get(name);
    return original !== undefined && ownedScopedSubset(child, original);
  });
}

export async function matchesScopedFilePrefix(
  source: string,
  original: ScopedImage,
  partial: ScopedImage,
  guards: Guards,
) {
  if (original.kind !== "file" || partial.kind !== "file" || partial.stat.size > original.stat.size) return false;
  const hash = createHash("sha256");
  const size = Number(partial.stat.size);
  await readStableFile(source, original.stat, guards, (chunk, offset) => {
    if (offset < size) hash.update(chunk.subarray(0, size - offset));
  });
  return partial.value === `file:${hash.digest("hex")}`;
}

export function scopedDescendant(image: ScopedImage, relative: string) {
  let node: ScopedImage | undefined = image;
  for (const name of relative ? relative.split(path.sep) : []) {
    if (node?.kind !== "directory") return;
    const directory: ScopedDirectoryImage = node;
    node = directory.children.find(([child]) => child === name)?.[1];
  }
  return node;
}

export async function recheckScopedImage(target: string, image: ScopedImage, guards: Guards) {
  if (image.kind !== "missing") await recheck(target, image.stat, guards);
  else if (await lstat(target, guards)) changedImage();
}

export async function removeScopedImage(target: string, image: ScopedImage, guards: Guards) {
  if (image.kind === "missing") return;
  async function remove(target: string, node: ScopedNode): Promise<void> {
    await recheck(target, node.stat, guards);
    if (node.kind === "file") {
      const observed = await scopedTransactionImage(target, guards);
      if (observed.kind !== "file" || !sameObservation(node.stat, observed.stat) || observed.value !== node.value)
        changedImage();
      validate(guards);
      await fs.unlink(target);
      return;
    }
    for (const [name, child] of node.children) await remove(path.join(target, name), child);
    await recheck(target, node.stat, guards, true);
    validate(guards);
    await fs.rmdir(target);
  }
  await remove(target, image);
}

export async function legacyImage(target: string, durable = false): Promise<string> {
  const stat = await lstat(target, {});
  if (!stat) return "missing";
  if (stat.isSymbolicLink()) return `symlink:${await fs.readlink(target)}`;
  if (stat.isFile()) {
    const content = await fs.readFile(target);
    if (durable) {
      const handle = await fs.open(target, process.platform === "win32" ? "r+" : "r");
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
    }
    return fileImage(content);
  }
  if (!stat.isDirectory()) throw new Error("Unsupported transaction image.");
  const entries = [];
  for (const name of (await fs.readdir(target)).sort())
    entries.push([name, await legacyImage(path.join(target, name), durable)]);
  if (durable) await syncDirectory(target);
  return `directory:${createHash("sha256").update(JSON.stringify(entries)).digest("hex")}`;
}

type PostFiles = NonNullable<TransactionEntry["postFiles"]>;

function postTreePaths(files: PostFiles, key: (relative: string) => string) {
  const expected = new Map(files.map((file) => [key(file.relative), file.image]));
  const prefixes = new Set<string>();
  for (const relative of expected.keys()) {
    for (
      let parent = path.dirname(relative);
      parent !== "." && parent !== path.dirname(parent);
      parent = path.dirname(parent)
    )
      prefixes.add(parent);
  }
  return { expected, prefixes };
}

export function ownedScopedPostTree(image: ScopedImage, files: PostFiles, requireComplete: boolean) {
  if (image.kind !== "directory" || !files.length) return false;
  const { expected, prefixes } = postTreePaths(files, (relative) => relative);
  if (expected.size !== files.length) return false;
  const seen = new Set<string>();
  let seenFiles = 0;
  function visit(directory: ScopedDirectoryImage, parent: string): boolean {
    for (const [name, child] of directory.children) {
      const relative = path.join(parent, name);
      if (seen.has(relative)) return false;
      seen.add(relative);
      if (child.kind === "directory") {
        if (!prefixes.has(relative) || !visit(child, relative)) return false;
      } else {
        if (expected.get(relative) !== child.value) return false;
        seenFiles++;
      }
    }
    return true;
  }
  return visit(image, "") && (!requireComplete || seenFiles === expected.size);
}

export async function ownedLegacyPostTree(target: string, files: PostFiles, requireComplete: boolean) {
  if (!files.length) return false;
  const { expected, prefixes } = postTreePaths(files, mergePathIdentity);
  const seen = new Set<string>();
  async function visit(directory: string): Promise<boolean> {
    let stat: Stats;
    try {
      stat = await fs.lstat(directory);
    } catch {
      return false;
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) return false;
    for (const name of await fs.readdir(directory)) {
      const child = path.join(directory, name);
      const relative = mergePathIdentity(path.relative(target, child));
      const stat = await fs.lstat(child);
      if (stat.isDirectory() && !stat.isSymbolicLink()) {
        if (!prefixes.has(relative) || !(await visit(child))) return false;
      } else {
        if (expected.get(relative) !== (await legacyImage(child))) return false;
        seen.add(relative);
      }
    }
    return true;
  }
  return (await visit(target)) && (!requireComplete || [...expected.keys()].every((key) => seen.has(key)));
}
