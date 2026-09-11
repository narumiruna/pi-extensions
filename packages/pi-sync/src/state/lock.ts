import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import lockfile from "proper-lockfile";
import type { CommandOptions } from "../commands/command-types.js";
import { LOCK_GUARD_STALE_MS, LOCK_GUARD_UPDATE_MS } from "./lock-policy.js";
import { LOCKFILE_FS_ADAPTER } from "./lockfile-fs.js";
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

export async function withLock<T>(
  command: string,
  fn: () => Promise<T>,
  options: { reclaimStale?: boolean } = {},
): Promise<T> {
  await ensureStateDir();
  const lock: LockFile = {
    id: randomUUID(),
    pid: process.pid,
    command,
    startedAt: new Date().toISOString(),
  };
  let guard: Guard | undefined;
  let result: T | undefined;
  let failed = false;
  let failure: unknown;
  try {
    try {
      guard = await acquireGuard();
    } catch (error) {
      if (!isLockHeldError(error)) throw error;
      throw await describeHeldLock();
    }

    let inspection = await inspectLock();
    if (inspection.status === "valid" && isStaleLock(inspection.lock)) {
      if (!options.reclaimStale) {
        throw new Error(`pi-sync lock is stale (pid ${inspection.lock.pid}). Run /sync unlock --stale, then retry.`);
      }
      guard.throwIfCompromised();
      const rechecked = await inspectLock();
      if (rechecked.status !== "valid" || rechecked.lock.id !== inspection.lock.id || !isStaleLock(rechecked.lock)) {
        throw new Error("pi-sync lock changed while preparing transaction recovery; retry.");
      }
      await fs.rm(lockPath(), { force: true });
      inspection = { status: "missing" };
    }
    if (inspection.status === "valid") {
      throw new Error(
        `pi-sync is already running (${inspection.lock.command}, pid ${inspection.lock.pid}, started ${inspection.lock.startedAt}).`,
      );
    }
    if (inspection.status === "unreadable") {
      throw new Error(
        "pi-sync lock metadata is unreadable. Run /sync unlock --stale after verifying no sync is running.",
      );
    }

    await fs.writeFile(lockPath(), JSON.stringify(lock, null, "\t"), { flag: "wx" });
    guard.throwIfCompromised();
    result = await fn();
    guard.throwIfCompromised();
  } catch (error) {
    failed = true;
    failure = error;
  }

  try {
    const current = await readLock();
    if (current?.id === lock.id) await fs.rm(lockPath(), { force: true });
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
  try {
    const text = await fs.readFile(lockPath(), "utf8");
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

function throwIfAborted(signal?: AbortSignal) {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error ? signal.reason : new DOMException("The operation was aborted", "AbortError");
}

async function releaseGuard(guard: Guard) {
  try {
    await guard.release();
    return undefined;
  } catch (error) {
    return guard.isCompromised() ? undefined : error;
  }
}

async function acquireGuard(): Promise<Guard> {
  let compromisedError: Error | undefined;
  const release = await lockfile.lock(lockPath(), {
    fs: LOCKFILE_FS_ADAPTER,
    lockfilePath: `${lockPath()}.guard`,
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

async function describeHeldLock() {
  const current = await readLock();
  if (current && isStaleLock(current)) {
    return new Error("pi-sync lock owner exited; retry shortly while the lock guard expires.");
  }
  if (current) {
    return new Error(
      `Pi-sync is currently running (${current.command}, pid ${current.pid}, started ${current.startedAt}).`,
    );
  }
  return new Error("Pi-sync is currently running (lock metadata is unreadable or still being written).");
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
