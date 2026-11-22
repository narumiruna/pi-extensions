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

const recordPrefix = "pi-sync-ignore-creation-v1\n";
const records = [
  Buffer.from(`${recordPrefix}${DEFAULT_IGNORE_RULES}`),
  Buffer.from(`${recordPrefix}/npm/\n/sessions/\n/auth.json\n/truth.json\n`),
] as const;
const noFollow = (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);
const openRead = constants.O_RDONLY | noFollow;
const openExisting = process.platform === "win32" ? constants.O_RDWR | noFollow : openRead;
const openExclusive = constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | noFollow;

export class AutomaticIgnoreCreationUnavailable extends Error {}

export async function checkAutomaticIgnoreCreation(root: string, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  root = path.resolve(root);
  const expected = await fs.lstat(root, { bigint: true });
  signal.throwIfAborted();
  assertRoot(root, expected);
  await checkCreationAccess(root);
  const { directory } = await openCreationDirectory(root, expected);
  try {
    signal.throwIfAborted();
    await syncCreationDirectory(directory);
    assertRoot(root, expected);
  } finally {
    await directory?.close();
    signal.throwIfAborted();
  }
}

function creationRecordToken(stat: BigIntStats): string {
  return `${ignoreFileIdentity(stat)}:${stat.size}:${stat.ctimeNs}:${stat.mtimeNs}`;
}

export async function readPendingIgnoreCreation(root: string, signal: AbortSignal) {
  signal.throwIfAborted();
  root = path.resolve(root);
  const initialRoot = await fs.lstat(root, { bigint: true });
  const checkRoot = () => {
    signal.throwIfAborted();
    assertRoot(root, initialRoot);
  };
  checkRoot();
  const target = path.join(root, DEFAULT_IGNORE_CREATION_RECORD);
  const prior = await fs.lstat(target, { bigint: true });
  assertOwned(prior, DEFAULT_IGNORE_CREATION_RECORD, true);
  const marker = await fs.open(target, openRead);
  try {
    const { stat, bytes } = await verifyCreationFile(marker, target, target, records, checkRoot, prior, false);
    return { token: creationRecordToken(stat), text: bytes.toString("utf8", recordPrefix.length) };
  } finally {
    await marker.close();
    signal.throwIfAborted();
  }
}

export async function initializeDefaultIgnoreSource(root: string, signal?: AbortSignal): Promise<IgnoreSource> {
  return (await prepareDefaultIgnoreSource(root, signal)).source;
}

export async function prepareDefaultIgnoreSource(
  root: string,
  signal?: AbortSignal,
  reviewedCreation?: string | null,
): Promise<{ source: IgnoreSource; created: boolean }> {
  signal?.throwIfAborted();
  root = path.resolve(root);
  try {
    const initialRoot = await fs.lstat(root, { bigint: true });
    const verifyRoot = () => assertRoot(root, initialRoot);
    const checkRoot = () => {
      signal?.throwIfAborted();
      verifyRoot();
    };
    checkRoot();
    const priorRecord = statAt(path.join(root, DEFAULT_IGNORE_CREATION_RECORD));
    if (
      reviewedCreation !== undefined &&
      reviewedCreation !== (priorRecord ? creationRecordToken(priorRecord) : null)
    ) {
      changed(DEFAULT_IGNORE_CREATION_RECORD);
    }
    if (!priorRecord) {
      const source = await readIgnoreSource(root, DEFAULT_IGNORE_FILENAME, signal);
      checkRoot();
      if (source.present) return { source, created: false };
    }
    await checkCreationAccess(root);
    const { directory, anchor } = await openCreationDirectory(root, initialRoot);
    try {
      checkRoot();
      const flushDirectory = await syncCreationDirectory(directory);
      checkRoot();
      const markerPath = path.join(anchor, DEFAULT_IGNORE_CREATION_RECORD);
      const target = path.join(anchor, DEFAULT_IGNORE_FILENAME);
      if (priorRecord) assertOwned(priorRecord, DEFAULT_IGNORE_CREATION_RECORD, true);
      else if (statAt(target)) changed(DEFAULT_IGNORE_FILENAME);
      const marker = await fs.open(markerPath, priorRecord ? openExisting : openExclusive, 0o600).catch((error) => {
        if (!priorRecord) checkCreationError(error);
        throw error;
      });
      try {
        const { stat: markerStat, bytes } = await verifyCreationFile(
          marker,
          markerPath,
          path.join(root, DEFAULT_IGNORE_CREATION_RECORD),
          records,
          priorRecord ? checkRoot : verifyRoot,
          priorRecord,
        );
        const starter = bytes.subarray(recordPrefix.length);
        await flushDirectory();
        checkRoot();
        assertCurrent(markerPath, markerStat);
        const priorFile = priorRecord ? statAt(target) : undefined;
        if (priorFile) assertOwned(priorFile, DEFAULT_IGNORE_FILENAME, false);
        const file = await fs.open(target, priorFile ? openExisting : openExclusive, 0o600).catch(async (cause) => {
          if (!priorRecord && (cause as NodeJS.ErrnoException).code === "EEXIST") {
            verifyRoot();
            assertCurrent(markerPath, markerStat);
            unlinkSync(markerPath);
            await flushDirectory();
          }
          throw cause;
        });
        try {
          const checkTargetRoot = priorFile ? checkRoot : verifyRoot;
          const { stat: fileStat } = await verifyCreationFile(
            file,
            target,
            path.join(root, DEFAULT_IGNORE_FILENAME),
            [starter],
            () => {
              checkTargetRoot();
              assertCurrent(markerPath, markerStat);
            },
            priorFile,
          );
          await flushDirectory();
          checkTargetRoot();
          assertCurrent(target, fileStat);
          assertCurrent(markerPath, markerStat);
          unlinkSync(markerPath);
          await flushDirectory();
          checkRoot();
          const source = await readIgnoreSource(root, DEFAULT_IGNORE_FILENAME, signal);
          checkRoot();
          if (source.identity !== ignoreFileIdentity(fileStat) || source.text !== starter.toString("utf8")) {
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
      await directory?.close();
      signal?.throwIfAborted();
    }
  } catch (cause) {
    signal?.throwIfAborted();
    if (cause instanceof AutomaticIgnoreCreationUnavailable) throw cause;
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

function checkCreationError(error: unknown) {
  if (["EACCES", "EPERM", "EROFS", "ENOTSUP", "EOPNOTSUPP"].includes((error as NodeJS.ErrnoException).code ?? "")) {
    throw new AutomaticIgnoreCreationUnavailable("the filesystem does not permit automatic creation", { cause: error });
  }
}

async function checkCreationAccess(root: string) {
  try {
    await fs.access(root, constants.W_OK);
  } catch (error) {
    checkCreationError(error);
    throw error;
  }
}

function assertRoot(root: string, expected: BigIntStats) {
  const current = lstatSync(root, { bigint: true });
  if (!current.isDirectory() || !sameIdentity(expected, current) || realpathSync(root) !== root) {
    throw new Error("the Pi agent directory is not canonical or changed during initialization");
  }
}

async function openCreationDirectory(root: string, expected: BigIntStats) {
  if (process.platform === "win32") return { anchor: root };
  const directory = await fs.open(root, openRead | (constants.O_DIRECTORY ?? 0));
  try {
    if (!sameIdentity(expected, await directory.stat({ bigint: true }))) changed("Pi agent directory");
    return { directory, anchor: (await directoryAnchor(directory, expected)) ?? root };
  } catch (error) {
    await directory.close();
    throw error;
  }
}

async function syncCreationDirectory(directory?: FileHandle): Promise<() => Promise<void>> {
  if (!directory) return async () => {};
  try {
    await directory.sync();
    return () => directory.sync();
  } catch (error) {
    if (
      ["EBADF", "EINVAL", "ENOSYS", "ENOTSUP", "EOPNOTSUPP", "EPERM"].includes(
        (error as NodeJS.ErrnoException).code ?? "",
      )
    ) {
      if (process.platform === "darwin") return async () => {};
      throw new AutomaticIgnoreCreationUnavailable("the filesystem does not support flushing the Pi agent directory");
    }
    throw error;
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
    (privateRecord && process.platform !== "win32" && (stat.mode & 0o077n) !== 0n)
  ) {
    throw new Error(`unsafe "${name}"; preserve it for manual recovery`);
  }
}

async function verifyCreationFile(
  handle: FileHandle,
  target: string,
  canonical: string,
  expected: readonly [Buffer, ...Buffer[]],
  checkRoot: () => void,
  prior: BigIntStats | undefined,
  persist = true,
) {
  const name = path.basename(target);
  const privateRecord = name === DEFAULT_IGNORE_CREATION_RECORD;
  const opened = await handle.stat({ bigint: true });
  assertOwned(opened, name, privateRecord);
  if (prior && !sameFile(prior, opened)) changed(name);
  checkRoot();
  if ((await fs.realpath(target)) !== canonical) throw new Error(`use the exact on-disk filename "${name}"`);
  checkRoot();
  assertCurrent(target, opened);
  if (!prior && persist) await handle.writeFile(expected[0]);
  const before = await handle.stat({ bigint: true });
  assertOwned(before, name, privateRecord);
  if (!(prior ? sameFile(opened, before) : sameIdentity(opened, before))) changed(name);
  checkRoot();
  assertCurrent(target, before);
  const observed = Buffer.alloc(Math.max(...expected.map((bytes) => bytes.length)) + 1);
  let count = 0;
  while (count < observed.length) {
    checkRoot();
    const { bytesRead } = await handle.read(observed, count, observed.length - count, count);
    if (bytesRead === 0) break;
    count += bytesRead;
  }
  const bytes = expected.find((candidate) => observed.subarray(0, count).equals(candidate));
  if (!bytes) {
    throw new Error(
      privateRecord
        ? `invalid creation record "${name}"; preserve it for manual recovery`
        : `unfinished creation of "${name}"; move the incomplete file outside the Pi agent directory or restore the full starter rules recorded in "${DEFAULT_IGNORE_CREATION_RECORD}", then retry confirmed setup or migration`,
    );
  }
  if (persist) await handle.sync();
  if (!sameFile(before, await handle.stat({ bigint: true }))) changed(name);
  checkRoot();
  assertCurrent(target, before);
  return { stat: before, bytes };
}
