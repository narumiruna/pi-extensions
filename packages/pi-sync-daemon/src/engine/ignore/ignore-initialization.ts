import { type BigIntStats, constants, lstatSync, realpathSync, unlinkSync } from "node:fs";
import fs, { type FileHandle } from "node:fs/promises";
import path from "node:path";
import {
  DEFAULT_IGNORE_CREATION_RECORD,
  DEFAULT_IGNORE_FILENAME,
  DEFAULT_IGNORE_RULES,
  type IgnoreSource,
  ignoreFileIdentity,
  readIgnoreSource,
  sameFile,
  sameIdentity,
} from "./ignore-source.js";

const starter = Buffer.from(DEFAULT_IGNORE_RULES);
const record = Buffer.from(`pi-sync-ignore-creation-v1\n${DEFAULT_IGNORE_RULES}`);
const noFollow = (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);
const openRead = constants.O_RDONLY | noFollow;
const openExclusive = constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | noFollow;

export async function initializeDefaultIgnoreSource(root: string, signal?: AbortSignal): Promise<IgnoreSource> {
  return (await prepareDefaultIgnoreSource(root, signal)).source;
}

export async function prepareDefaultIgnoreSource(
  root: string,
  signal?: AbortSignal,
): Promise<{ source: IgnoreSource; created: boolean }> {
  signal?.throwIfAborted();
  root = path.resolve(root);
  try {
    const initialRoot = await fs.lstat(root, { bigint: true });
    const assertRoot = () => {
      const current = lstatSync(root, { bigint: true });
      if (!current.isDirectory() || !sameIdentity(initialRoot, current) || realpathSync(root) !== root) {
        throw new Error("the Pi agent directory is not canonical or changed during initialization");
      }
    };
    const checkRoot = () => {
      signal?.throwIfAborted();
      assertRoot();
    };
    checkRoot();
    const priorRecord = statAt(path.join(root, DEFAULT_IGNORE_CREATION_RECORD));
    if (!priorRecord) {
      const source = await readIgnoreSource(root, DEFAULT_IGNORE_FILENAME, signal);
      checkRoot();
      if (source.present) return { source, created: false };
    }
    if (!constants.O_DIRECTORY || !constants.O_NOFOLLOW || !constants.O_NONBLOCK || process.platform === "win32") {
      throw new Error(
        "this platform does not support durable directory-relative creation; use an existing ignore file",
      );
    }
    const directory = await fs.open(root, openRead | constants.O_DIRECTORY);
    try {
      if (!sameIdentity(initialRoot, await directory.stat({ bigint: true }))) changed("Pi agent directory");
      const anchor = await directoryAnchor(directory, initialRoot);
      checkRoot();
      await directory.sync();
      checkRoot();
      const markerPath = path.join(anchor, DEFAULT_IGNORE_CREATION_RECORD);
      const target = path.join(anchor, DEFAULT_IGNORE_FILENAME);
      if (priorRecord) assertOwned(priorRecord, DEFAULT_IGNORE_CREATION_RECORD, true);
      else if (statAt(target)) changed(DEFAULT_IGNORE_FILENAME);
      const marker = await fs.open(markerPath, priorRecord ? openRead : openExclusive, 0o600);
      try {
        const markerStat = await flushAndVerify(
          marker,
          markerPath,
          path.join(root, DEFAULT_IGNORE_CREATION_RECORD),
          record,
          priorRecord ? checkRoot : assertRoot,
          priorRecord,
          true,
        );
        await directory.sync();
        checkRoot();
        assertCurrent(markerPath, markerStat);
        const priorFile = priorRecord ? statAt(target) : undefined;
        if (priorFile) assertOwned(priorFile, DEFAULT_IGNORE_FILENAME, false);
        const file = await fs.open(target, priorFile ? openRead : openExclusive, 0o600).catch(async (cause) => {
          if (!priorRecord && (cause as NodeJS.ErrnoException).code === "EEXIST") {
            assertRoot();
            assertCurrent(markerPath, markerStat);
            unlinkSync(markerPath);
            await directory.sync();
          }
          throw cause;
        });
        try {
          const checkTargetRoot = priorFile ? checkRoot : assertRoot;
          const fileStat = await flushAndVerify(
            file,
            target,
            path.join(root, DEFAULT_IGNORE_FILENAME),
            starter,
            () => {
              checkTargetRoot();
              assertCurrent(markerPath, markerStat);
            },
            priorFile,
          );
          await directory.sync();
          checkTargetRoot();
          assertCurrent(target, fileStat);
          assertCurrent(markerPath, markerStat);
          unlinkSync(markerPath);
          await directory.sync();
          checkRoot();
          const source = await readIgnoreSource(root, DEFAULT_IGNORE_FILENAME, signal);
          checkRoot();
          if (source.identity !== ignoreFileIdentity(fileStat) || source.text !== DEFAULT_IGNORE_RULES) {
            changed(DEFAULT_IGNORE_FILENAME);
          }
          return { source, created: priorFile === undefined };
        } finally {
          await file.close();
        }
      } finally {
        await marker.close();
      }
    } finally {
      await directory.close();
      signal?.throwIfAborted();
    }
  } catch (cause) {
    signal?.throwIfAborted();
    const code = (cause as NodeJS.ErrnoException).code;
    const detail =
      code === "EEXIST"
        ? "a file or creation record appeared concurrently; review the current files and retry"
        : code
          ? "could not safely create or flush the file"
          : (cause as Error).message;
    throw new Error(`Ignore file "${DEFAULT_IGNORE_FILENAME}" initialization: ${detail}.`, { cause });
  }
}

async function directoryAnchor(directory: FileHandle, expected: BigIntStats) {
  for (const base of ["/proc/self/fd", "/dev/fd"]) {
    const candidate = `${base}/${directory.fd}`;
    const observed = await fs.stat(`${candidate}/.`, { bigint: true }).catch((error: NodeJS.ErrnoException) => {
      if (["ENOENT", "ENOTDIR", "EACCES", "EPERM"].includes(error.code ?? "")) return undefined;
      throw error;
    });
    if (observed?.isDirectory() && sameIdentity(expected, observed)) return candidate;
  }
  throw new Error("directory-relative creation is unavailable; use an existing ignore file");
}

function statAt(target: string) {
  return lstatSync(target, { bigint: true, throwIfNoEntry: false });
}

function changed(name: string): never {
  throw new Error(`"${name}" changed during initialization; review the current files and retry`);
}

function assertCurrent(target: string, expected: BigIntStats) {
  const current = statAt(target);
  if (!current || !sameFile(expected, current)) changed(path.basename(target));
}

function assertOwned(stat: BigIntStats, name: string, privateRecord: boolean) {
  if (
    !stat.isFile() ||
    stat.nlink !== 1n ||
    (process.getuid && stat.uid !== BigInt(process.getuid())) ||
    (privateRecord && (stat.mode & 0o077n) !== 0n)
  ) {
    throw new Error(`unsafe "${name}"; preserve it for manual recovery`);
  }
}

async function flushAndVerify(
  handle: FileHandle,
  target: string,
  canonical: string,
  expected: Buffer,
  checkRoot: () => void,
  prior: BigIntStats | undefined,
  privateRecord = false,
) {
  const name = path.basename(target);
  const opened = await handle.stat({ bigint: true });
  assertOwned(opened, name, privateRecord);
  if (prior && !sameFile(prior, opened)) changed(name);
  checkRoot();
  if ((await fs.realpath(target)) !== canonical) throw new Error(`use the exact on-disk filename "${name}"`);
  checkRoot();
  assertCurrent(target, opened);
  if (!prior) await handle.writeFile(expected);
  const before = await handle.stat({ bigint: true });
  assertOwned(before, name, privateRecord);
  if (!(prior ? sameFile(opened, before) : sameIdentity(opened, before))) changed(name);
  checkRoot();
  assertCurrent(target, before);
  const observed = Buffer.alloc(expected.length + 1);
  let count = 0;
  while (count < observed.length) {
    checkRoot();
    const { bytesRead } = await handle.read(observed, count, observed.length - count, count);
    if (bytesRead === 0) break;
    count += bytesRead;
  }
  if (count !== expected.length || !observed.subarray(0, count).equals(expected)) {
    throw new Error(
      privateRecord
        ? `invalid creation record "${name}"; preserve it for manual recovery`
        : `unfinished creation of "${name}"; move the incomplete file outside the Pi agent directory or restore the full starter rules, then retry confirmed setup or migration`,
    );
  }
  await handle.sync();
  if (!sameFile(before, await handle.stat({ bigint: true }))) changed(name);
  checkRoot();
  assertCurrent(target, before);
  return before;
}
