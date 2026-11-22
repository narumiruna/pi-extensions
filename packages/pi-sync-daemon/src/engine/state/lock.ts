import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync, type Stats } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import lockfile from "proper-lockfile";
import { canonicalRootGuard } from "../../identity.js";
import type { CommandOptions } from "../commands/command-types.js";
import { type EngineContext as ExtensionCommandContext, getEngineRoot } from "../host.js";
import { throwIfAborted } from "../sync/signals.js";
import { LOCK_GUARD_STALE_MS, LOCK_GUARD_UPDATE_MS } from "./lock-policy.js";
import { LOCKFILE_FS_ADAPTER } from "./lockfile-fs.js";
import { stateDir } from "./state-directory.js";
import type { LockFile } from "./state-types.js";
import { ensureStateDir, lockPath } from "./sync-state-store.js";

const LOCK_STALE_MS = 30 * 60 * 1000;
const MAX_PROCESS_ID = 2_147_483_647;

interface Guard {
  release: () => Promise<void>;
  throwIfCompromised: () => void;
  isCompromised: () => boolean;
}

export type LockInspection = { status: "missing" } | { status: "unreadable" } | { status: "valid"; lock: LockFile };

const activeLock = new AsyncLocalStorage<{ path: string; contents: Buffer; active(): boolean }>();

export function captureStartupReviewLock(): (() => boolean) | undefined {
  const owner = activeLock.getStore();
  if (!owner?.active()) return;
  const guardPath = `${owner.path}.guard`;
  const originalGuard = lstatSync(guardPath, { bigint: true, throwIfNoEntry: false });
  const originalLock = lstatSync(owner.path, { bigint: true, throwIfNoEntry: false });
  if (!originalGuard?.isDirectory() || !originalLock?.isFile()) return;
  const validate = () => {
    if (!owner.active() || owner.path !== lockPath()) return false;
    const guard = lstatSync(guardPath, { bigint: true, throwIfNoEntry: false });
    const candidate = lstatSync(owner.path, { bigint: true, throwIfNoEntry: false });
    if (
      !guard?.isDirectory() ||
      guard.dev !== originalGuard.dev ||
      guard.ino !== originalGuard.ino ||
      Number(guard.mtimeMs) < Date.now() - LOCK_GUARD_STALE_MS ||
      !candidate?.isFile() ||
      candidate.dev !== originalLock.dev ||
      candidate.ino !== originalLock.ino ||
      candidate.size !== BigInt(owner.contents.length)
    )
      return false;
    const fd = openSync(owner.path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    try {
      const opened = fstatSync(fd, { bigint: true });
      if (!opened.isFile() || opened.dev !== candidate.dev || opened.ino !== candidate.ino) return false;
      const current = Buffer.alloc(owner.contents.length + 1);
      let offset = 0;
      while (offset < current.length) {
        const count = readSync(fd, current, offset, current.length - offset, offset);
        if (!count) break;
        offset += count;
      }
      return current.subarray(0, offset).equals(owner.contents);
    } finally {
      closeSync(fd);
    }
  };
  return validate() ? validate : undefined;
}

export async function withLock<T>(
  command: string,
  fn: () => Promise<T>,
  options: { reclaimStale?: boolean } = {},
): Promise<T> {
  await ensureStateDir();
  const configuredRoot = getEngineRoot();
  const root = realpathSync(configuredRoot);
  const assertRoot = canonicalRootGuard(root);
  const directory = stateDir(root);
  const file = path.join(directory, "lock");
  const original = lstatSync(directory);
  const assertLocation = () => {
    assertRoot();
    if (realpathSync(configuredRoot) !== root || stateDir(root) !== directory)
      throw new Error("Pi Sync operation lock directory changed.");
    const current = lstatSync(directory);
    if (!current.isDirectory() || current.dev !== original.dev || current.ino !== original.ino)
      throw new Error("Pi Sync operation lock directory changed.");
  };
  assertLocation();
  const lock: LockFile = {
    id: randomUUID(),
    pid: process.pid,
    command,
    startedAt: new Date().toISOString(),
  };
  let guard: Guard | undefined;
  let written = false;
  let result: T | undefined;
  let failed = false;
  let failure: unknown;
  try {
    try {
      guard = await acquireGuard(file, assertLocation);
    } catch (error) {
      if (!isLockHeldError(error)) throw error;
      assertLocation();
      throw await describeHeldLock(file);
    }

    assertLocation();
    let inspection = await inspectLockAt(file);
    if (inspection.status === "valid" && isStaleLock(inspection.lock)) {
      if (!options.reclaimStale) {
        throw new Error(`pi-sync lock is stale (pid ${inspection.lock.pid}). Run /sync unlock --stale, then retry.`);
      }
      guard.throwIfCompromised();
      const rechecked = await inspectLockAt(file);
      if (rechecked.status !== "valid" || rechecked.lock.id !== inspection.lock.id || !isStaleLock(rechecked.lock)) {
        throw new Error("pi-sync lock changed while preparing transaction recovery; retry.");
      }
      assertLocation();
      guard.throwIfCompromised();
      await fs.rm(file, { force: true });
      inspection = { status: "missing" };
    }
    if (inspection.status === "valid") {
      throw Object.assign(
        new Error(
          `pi-sync is already running (${inspection.lock.command}, pid ${inspection.lock.pid}, started ${inspection.lock.startedAt}).`,
        ),
        { code: "ELOCKED" },
      );
    }
    if (inspection.status === "unreadable") {
      throw new Error(
        "pi-sync lock metadata is unreadable. Run /sync unlock --stale after verifying no sync is running.",
      );
    }

    assertLocation();
    guard.throwIfCompromised();
    const contents = Buffer.from(JSON.stringify(lock, null, "\t"));
    await fs.writeFile(file, contents, { flag: "wx" });
    written = true;
    guard.throwIfCompromised();
    const held = guard;
    let active = true;
    const ownsLock = () => {
      if (!active || held.isCompromised()) return false;
      try {
        assertLocation();
        return true;
      } catch {
        return false;
      }
    };
    try {
      result = await activeLock.run({ path: file, contents, active: ownsLock }, fn);
      guard.throwIfCompromised();
    } finally {
      active = false;
    }
  } catch (error) {
    failed = true;
    failure = error;
  }

  try {
    if (written && guard) {
      assertLocation();
      guard.throwIfCompromised();
      const current = await inspectLockAt(file);
      if (current.status === "valid" && current.lock.id === lock.id) {
        assertLocation();
        guard.throwIfCompromised();
        await fs.rm(file, { force: true });
      }
    }
  } catch (error) {
    if (!failed) {
      failed = true;
      failure = error;
    }
  }
  if (guard) {
    const releaseError = await releaseGuard(guard);
    if (releaseError && !failed) {
      failed = true;
      failure = releaseError;
    }
  }
  if (failed) throw failure;
  return result as T;
}

export async function inspectLock(): Promise<LockInspection> {
  return inspectLockAt(lockPath());
}

async function inspectLockAt(file: string): Promise<LockInspection> {
  try {
    const text = await fs.readFile(file, "utf8");
    if (text.trim().length === 0) return { status: "unreadable" };
    const parsed = JSON.parse(text) as unknown;
    return isLockFile(parsed) ? { status: "valid", lock: parsed } : { status: "unreadable" };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { status: "missing" };
    if (error instanceof SyntaxError) return { status: "unreadable" };
    throw error;
  }
}

export async function readLock(): Promise<LockFile | undefined> {
  const inspection = await inspectLock();
  return inspection.status === "valid" ? inspection.lock : undefined;
}

export async function lockFileExists(): Promise<boolean> {
  try {
    await fs.stat(lockPath());
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export function isLockGuardHeld() {
  return lockfile.check(lockPath(), {
    fs: LOCKFILE_FS_ADAPTER,
    lockfilePath: `${lockPath()}.guard`,
    realpath: false,
    stale: LOCK_GUARD_STALE_MS,
  });
}

export function isStaleLock(lock: LockFile) {
  try {
    process.kill(lock.pid, 0);
    return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return true;
    return Date.now() - Date.parse(lock.startedAt) > LOCK_STALE_MS;
  }
}

export async function unlock(ctx: ExtensionCommandContext, options: CommandOptions) {
  throwIfAborted(options.signal);
  await ensureStateDir();
  throwIfAborted(options.signal);
  let guard: Guard;
  try {
    guard = await acquireGuard();
  } catch (error) {
    if (!isLockHeldError(error)) throw error;
    ctx.ui.notify((await describeHeldLock()).message, "warning");
    return;
  }

  let failed = false;
  let failure: unknown;
  try {
    await unlockGuarded(ctx, options);
  } catch (error) {
    failed = true;
    failure = error;
  }
  const releaseError = await releaseGuard(guard);
  if (releaseError && !failed) {
    failed = true;
    failure = releaseError;
  }
  if (failed) throw failure;
}

async function unlockGuarded(ctx: ExtensionCommandContext, options: CommandOptions) {
  throwIfAborted(options.signal);
  let inspection = await inspectLock();
  throwIfAborted(options.signal);
  if (inspection.status === "missing") {
    ctx.ui.notify("No pi-sync lock is present.", "info");
    return;
  }
  if (inspection.status === "unreadable") {
    if (!options.stale) {
      ctx.ui.notify(
        "Pi-sync lock metadata is unreadable. Use /sync unlock --stale only after verifying no sync is running.",
        "warning",
      );
      return;
    }
    inspection = await inspectLock();
    throwIfAborted(options.signal);
    if (inspection.status === "unreadable") {
      // Legacy writers expose an empty file before writing owner metadata, so no
      // automatic test can prove this file is abandoned. The explicit --stale
      // flag is the user's confirmation that no legacy sync is still running.
      throwIfAborted(options.signal);
      await fs.rm(lockPath(), { force: true });
      if (!options.signal?.aborted) {
        ctx.ui.notify(
          "Removed unreadable pi-sync lock. No settings, files, sync state, or remote data were changed.",
          "info",
        );
      }
      return;
    }
    if (inspection.status === "missing") {
      ctx.ui.notify("No pi-sync lock is present.", "info");
      return;
    }
  }
  if (!isStaleLock(inspection.lock)) {
    ctx.ui.notify("Lock owner is still live; refusing to remove it.", "warning");
    return;
  }
  throwIfAborted(options.signal);
  await fs.rm(lockPath(), { force: true });
  if (!options.signal?.aborted) {
    ctx.ui.notify("Removed stale pi-sync lock. No settings, files, sync state, or remote data were changed.", "info");
  }
}

async function releaseGuard(guard: Guard) {
  try {
    await guard.release();
    return undefined;
  } catch (error) {
    return guard.isCompromised() ? undefined : error;
  }
}

function guardFilesystem(assertLocation: () => void) {
  const { mkdir, rmdir, rmdirSync, stat, utimes } = LOCKFILE_FS_ADAPTER;
  function check(callback: (error: NodeJS.ErrnoException) => void) {
    try {
      assertLocation();
      return true;
    } catch (error) {
      callback(error as NodeJS.ErrnoException);
      return false;
    }
  }
  return {
    ...LOCKFILE_FS_ADAPTER,
    mkdir: (file: string, callback: (error: NodeJS.ErrnoException | null) => void) => {
      if (check(callback)) mkdir(file, callback);
    },
    rmdir: (...args: Parameters<typeof rmdir>) => {
      if (check(args[1])) rmdir(...args);
    },
    rmdirSync: (...args: Parameters<typeof rmdirSync>) => {
      assertLocation();
      return rmdirSync(...args);
    },
    stat: (file: string, callback: (error: NodeJS.ErrnoException | null, stats?: Stats) => void) => {
      if (check(callback)) stat(file, callback);
    },
    utimes: (...args: Parameters<typeof utimes>) => {
      if (check(args[3])) utimes(...args);
    },
  };
}

async function acquireGuard(file = lockPath(), assertLocation?: () => void): Promise<Guard> {
  let compromisedError: Error | undefined;
  const release = await lockfile.lock(file, {
    fs: assertLocation ? guardFilesystem(assertLocation) : LOCKFILE_FS_ADAPTER,
    lockfilePath: `${file}.guard`,
    realpath: false,
    stale: LOCK_GUARD_STALE_MS,
    update: LOCK_GUARD_UPDATE_MS,
    onCompromised: (error) => {
      compromisedError = error;
    },
  });
  return {
    release,
    throwIfCompromised: () => {
      if (compromisedError) throw compromisedError;
    },
    isCompromised: () => compromisedError !== undefined,
  };
}

async function describeHeldLock(file = lockPath()) {
  const inspection = await inspectLockAt(file);
  const current = inspection.status === "valid" ? inspection.lock : undefined;
  if (current && isStaleLock(current)) {
    return new Error("pi-sync lock owner exited; retry shortly while the lock guard expires.");
  }
  if (current) {
    return Object.assign(
      new Error(`Pi-sync is currently running (${current.command}, pid ${current.pid}, started ${current.startedAt}).`),
      { code: "ELOCKED" },
    );
  }
  return Object.assign(
    new Error("Pi-sync is currently running (lock metadata is unreadable or still being written)."),
    { code: "ELOCKED" },
  );
}

function isLockHeldError(error: unknown) {
  return (error as NodeJS.ErrnoException).code === "ELOCKED";
}

function isLockFile(value: unknown): value is LockFile {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const lock = value as Partial<LockFile>;
  return (
    typeof lock.id === "string" &&
    lock.id.length > 0 &&
    Number.isInteger(lock.pid) &&
    (lock.pid ?? 0) > 0 &&
    (lock.pid ?? 0) <= MAX_PROCESS_ID &&
    typeof lock.command === "string" &&
    lock.command.length > 0 &&
    typeof lock.startedAt === "string" &&
    Number.isFinite(Date.parse(lock.startedAt))
  );
}
