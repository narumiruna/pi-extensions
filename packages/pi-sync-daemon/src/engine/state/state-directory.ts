import { lstatSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import lockfile from "proper-lockfile";
import { getEngineRoot as getAgentDir } from "../host.js";
import { LOCK_GUARD_STALE_MS } from "./lock-policy.js";
import { LOCKFILE_FS_ADAPTER } from "./lockfile-fs.js";

const CANONICAL_DIRECTORY_NAME = "pi-sync";
const LEGACY_DIRECTORY_NAME = ".pisync";
const MIGRATION_LOCK_NAME = ".pi-sync-state-migration.lock";
const MIGRATION_LOCK_STALE_MS = 30_000;
const MIGRATION_LOCK_UPDATE_MS = 10_000;

export type StateDirectoryPreparation =
  | { status: "ready" }
  | { status: "migrated"; message: string }
  | { status: "deferred"; message: string };

interface StateDirectoryGuard {
  release: () => Promise<void>;
  throwIfCompromised: () => void;
}

interface SharedStateDirectoryGuard {
  guard: Promise<StateDirectoryGuard>;
  users: number;
  closing?: Promise<void>;
}

const sharedStateDirectoryGuards = new Map<string, SharedStateDirectoryGuard>();

export function stateDir(root = getAgentDir()) {
  const roots = inspectStateRoots(root);
  return roots.legacy ? legacyStateDir(root) : canonicalStateDir(root);
}

export function legacyStateDir(root = getAgentDir()) {
  return path.join(root, LEGACY_DIRECTORY_NAME);
}

export function stateDirectoryMigrationNotice() {
  const roots = inspectStateRoots();
  if (!roots.legacy) return undefined;
  return "Legacy pi-sync state is still stored in .pisync. Close other Pi sessions, then run /sync migrate-state to move it to pi-sync/.";
}

export async function withStateDirectoryAccess<T>(fn: () => Promise<T>): Promise<T> {
  const roots = inspectStateRoots();
  if (!roots.legacy) return fn();
  return runWithStateDirectoryGuard(await acquireSharedStateDirectoryGuard(), fn);
}

export async function migrateLegacyStateDirectory(): Promise<StateDirectoryPreparation> {
  const initial = inspectStateRoots();
  if (initial.canonical || !initial.legacy) return { status: "ready" };

  let guard: StateDirectoryGuard;
  try {
    guard = await acquireStateDirectoryGuard();
  } catch (error) {
    if (!isLockHeldError(error)) throw error;
    return {
      status: "deferred",
      message:
        "pi-sync state migration was deferred because another state user is active. Close other Pi sessions and retry.",
    };
  }
  return runWithStateDirectoryGuard(guard, async () => {
    const roots = inspectStateRoots();
    if (roots.canonical || !roots.legacy) return { status: "ready" };

    const legacyLock = path.join(legacyStateDir(), "lock");
    const legacyGuardHeld = await lockfile.check(legacyLock, {
      fs: LOCKFILE_FS_ADAPTER,
      lockfilePath: `${legacyLock}.guard`,
      realpath: false,
      stale: LOCK_GUARD_STALE_MS,
    });
    // Idle continuous owners do not retain the exclusive migration guard.
    // A live renewable lease still prevents moving their private state root.
    const schedulerHeld = await lockfile.check(path.join(legacyStateDir(), "continuous", "scheduler"), {
      fs: LOCKFILE_FS_ADAPTER,
      realpath: false,
      stale: LOCK_GUARD_STALE_MS,
    });
    if (legacyGuardHeld || schedulerHeld || (await pathExists(legacyLock))) {
      return {
        status: "deferred",
        message:
          "pi-sync state migration was deferred because the legacy directory is busy. Close other Pi sessions, clear any confirmed stale sync lock, and retry.",
      };
    }
    guard.throwIfCompromised();
    await fs.rename(legacyStateDir(), canonicalStateDir());
    guard.throwIfCompromised();
    inspectStateRoots();
    return {
      status: "migrated",
      message: `Migrated pi-sync state from ${legacyStateDir()} to ${canonicalStateDir()}.`,
    };
  });
}

async function acquireSharedStateDirectoryGuard(): Promise<StateDirectoryGuard> {
  const key = migrationLockPath();
  for (;;) {
    let shared = sharedStateDirectoryGuards.get(key);
    if (shared?.closing) {
      await shared.closing;
      continue;
    }
    if (!shared) {
      shared = { guard: acquireStateDirectoryGuard(), users: 0 };
      sharedStateDirectoryGuards.set(key, shared);
    }
    shared.users += 1;
    let guard: StateDirectoryGuard;
    try {
      guard = await shared.guard;
    } catch (error) {
      if (sharedStateDirectoryGuards.get(key) === shared) {
        sharedStateDirectoryGuards.delete(key);
      }
      throw error;
    }
    let released = false;
    return {
      throwIfCompromised: guard.throwIfCompromised,
      release: async () => {
        if (released) return;
        released = true;
        shared.users -= 1;
        if (shared.users > 0) return;
        const closing = guard.release();
        shared.closing = closing;
        try {
          await closing;
        } finally {
          if (sharedStateDirectoryGuards.get(key) === shared) {
            sharedStateDirectoryGuards.delete(key);
          }
        }
      },
    };
  }
}

/** Protect path selection and a synchronous access outside the engine host. */
export async function withStateDirectoryGuardForRoot<T>(root: string, access: () => T): Promise<T> {
  return runWithStateDirectoryGuard(await acquireStateDirectoryGuard(root), async () => access());
}

async function acquireStateDirectoryGuard(root = getAgentDir()): Promise<StateDirectoryGuard> {
  let compromisedError: Error | undefined;
  const release = await lockfile.lock(root, {
    fs: LOCKFILE_FS_ADAPTER,
    lockfilePath: migrationLockPath(root),
    realpath: false,
    stale: MIGRATION_LOCK_STALE_MS,
    update: MIGRATION_LOCK_UPDATE_MS,
    retries: { retries: 20, minTimeout: 10, maxTimeout: 50 },
    onCompromised: (error) => {
      compromisedError = error;
    },
  });
  return {
    release,
    throwIfCompromised: () => {
      if (compromisedError) throw compromisedError;
    },
  };
}

async function runWithStateDirectoryGuard<T>(guard: StateDirectoryGuard, fn: () => Promise<T>) {
  let result: T | undefined;
  let failed = false;
  let failure: unknown;
  try {
    guard.throwIfCompromised();
    result = await fn();
    guard.throwIfCompromised();
  } catch (error) {
    failed = true;
    failure = error;
  }
  try {
    await guard.release();
  } catch (error) {
    if (!failed) {
      failed = true;
      failure = error;
    }
  }
  if (failed) throw failure;
  return result as T;
}

function isLockHeldError(error: unknown) {
  return (error as NodeJS.ErrnoException).code === "ELOCKED";
}

function canonicalStateDir(root = getAgentDir()) {
  return path.join(root, CANONICAL_DIRECTORY_NAME);
}

function migrationLockPath(root = getAgentDir()) {
  return path.join(root, MIGRATION_LOCK_NAME);
}

function inspectStateRoots(root = getAgentDir()) {
  const canonicalPath = canonicalStateDir(root);
  const legacyPath = legacyStateDir(root);
  const canonical = isDirectoryRoot(canonicalPath, "canonical");
  const legacy = isDirectoryRoot(legacyPath, "legacy");
  if (canonical && legacy) {
    throw new Error(
      `Both legacy ${legacyPath} and canonical ${canonicalPath} pi-sync state directories exist. Close all Pi sessions and reconcile the directories manually; pi-sync will not merge or delete either directory.`,
    );
  }
  return { canonical, legacy };
}

function isDirectoryRoot(directory: string, label: string) {
  try {
    const entry = lstatSync(directory);
    if (entry.isSymbolicLink()) {
      throw new Error(`Refusing to use ${label} pi-sync state directory symbolic link: ${directory}`);
    }
    if (!entry.isDirectory()) {
      throw new Error(`${label} pi-sync state path is not a directory: ${directory}`);
    }
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function pathExists(filePath: string) {
  try {
    await fs.lstat(filePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
