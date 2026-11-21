import { createHash } from "node:crypto";
import { constants, type Stats } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { syncDirectory } from "../state/json-file.js";
import { mergePathIdentity } from "../sync/file-merge-planner.js";
import { MAX_AGENT_DIRECTORY_ENTRIES, MAX_AGENT_DIRECTORY_FILES } from "../sync/sync-policy.js";
import { MAX_AGENT_DIRECTORY_BYTES } from "./snapshot-bounds.js";
import { fileImage } from "./snapshot-transaction-plan.js";
import type { TransactionEntry } from "./snapshot-transaction-policy.js";

export const MAX_TRANSACTION_JOURNAL_BYTES = 32 * 1024 * 1024;
const CHUNK_BYTES = 64 * 1024;

interface Guards {
  signal?: AbortSignal;
  validateMutation?: () => void;
}

interface ScopedDirectoryImage {
  kind: "directory";
  value: string;
  stat: Stats;
  children: [string, ScopedNode][];
}

type ScopedNode = { kind: "file"; value: string; stat: Stats } | ScopedDirectoryImage;
export type ScopedImage = { kind: "missing"; value: "missing" } | ScopedNode;

function validate(guards: Guards) {
  guards.signal?.throwIfAborted();
  guards.validateMutation?.();
}

function changedImage(): never {
  throw new Error("Transaction image changed or is unsafe; preserve evidence for review.");
}

function sameIdentity(a: Stats, b: Stats) {
  return a.dev === b.dev && a.ino === b.ino && a.mode === b.mode;
}

function sameObservation(a: Stats, b: Stats) {
  return (
    sameIdentity(a, b) && a.nlink === b.nlink && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs
  );
}

async function lstat(target: string, guards: Guards): Promise<Stats | undefined> {
  validate(guards);
  let stat: Stats;
  try {
    stat = await fs.lstat(target);
  } catch (error) {
    validate(guards);
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return undefined;
    throw error;
  }
  validate(guards);
  return stat;
}

async function recheck(target: string, original: Stats, guards: Guards, identityOnly = false) {
  const current = await lstat(target, guards);
  if (!current || !(identityOnly ? sameIdentity : sameObservation)(original, current)) changedImage();
}

async function readStableFile(
  target: string,
  original: Stats,
  guards: Guards,
  consume: (chunk: Buffer, offset: number) => void | Promise<void>,
) {
  validate(guards);
  const handle = await fs.open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const opened = await handle.stat();
    validate(guards);
    if (!opened.isFile() || !sameObservation(original, opened)) changedImage();
    // On filesystems/platforms without O_NOFOLLOW, no bytes are read until the descriptor
    // matches the observed regular path and the pathname is checked again.
    await recheck(target, original, guards);
    const buffer = Buffer.alloc(Math.min(CHUNK_BYTES, original.size));
    for (let offset = 0; offset < original.size; ) {
      validate(guards);
      const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, original.size - offset), offset);
      validate(guards);
      if (bytesRead === 0) changedImage();
      await consume(buffer.subarray(0, bytesRead), offset);
      offset += bytesRead;
    }
    // A file that grows never increases the read budget, and is not accepted as its original prefix.
    if (!sameObservation(original, await handle.stat())) changedImage();
  } finally {
    await handle.close();
  }
  await recheck(target, original, guards);
}

/** Journal policy is not known until parsing; apply the serialized bound before and during the read. */
export async function readTransactionJournal(file: string, guards: Guards) {
  const stat = await lstat(file, guards);
  if (!stat) return undefined;
  if (!stat.isFile() || stat.nlink !== 1 || stat.size > MAX_TRANSACTION_JOURNAL_BYTES) changedImage();
  const content = Buffer.alloc(stat.size);
  await readStableFile(file, stat, guards, (chunk, offset) => {
    chunk.copy(content, offset);
  });
  return content.toString("utf8");
}

/** Hash only stable, bounded regular files. An optional exclusive copy uses these same verified bytes. */
export async function scopedTransactionImage(
  target: string,
  guards: Guards,
  copyTo?: string,
  checkPath?: (source: string) => Promise<void>,
): Promise<ScopedImage> {
  const stat = await lstat(target, guards);
  if (!stat) return { kind: "missing", value: "missing" };
  let entries = 1;
  let files = 0;
  let bytes = 0;
  async function visit(source: string, observed: Stats, destination: string | undefined): Promise<ScopedNode> {
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
        await fs.chmod(destination, observed.mode & 0o777);
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
    if (!observed.isFile() || observed.nlink !== 1) changedImage();
    if (++files > MAX_AGENT_DIRECTORY_FILES)
      throw new Error("Transaction image exceeds the agent-directory file bound.");
    bytes += observed.size;
    if (bytes > MAX_AGENT_DIRECTORY_BYTES) throw new Error("Transaction image exceeds the 64 MiB byte bound.");
    const hash = createHash("sha256");
    const copy = destination ? await fs.open(destination, "wx", 0o600) : undefined;
    try {
      await readStableFile(source, observed, guards, async (chunk) => {
        hash.update(chunk);
        if (copy) await copy.writeFile(chunk);
      });
      if (copy) {
        validate(guards);
        await copy.chmod(observed.mode & 0o777);
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

/** Remove only leaves in an authorized image; the kernel must find each directory empty. */
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
    // Our own removals changed directory metadata. Do not re-enumerate and adopt new children.
    await recheck(target, node.stat, guards, true);
    validate(guards);
    await fs.rmdir(target);
  }
  await remove(target, image);
}

/** Preserve the image format and symlink handling of older, non-scoped journals. */
export async function legacyImage(target: string, durable = false): Promise<string> {
  const stat = await lstat(target, {});
  if (!stat) return "missing";
  if (stat.isSymbolicLink()) return `symlink:${await fs.readlink(target)}`;
  if (stat.isFile()) {
    const content = await fs.readFile(target);
    if (durable) {
      // Keep POSIX read-only backup permissions; Windows flushing requires write access.
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
