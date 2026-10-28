import { randomUUID } from "node:crypto";
import { lstatSync, readFileSync, rmdirSync, type Stats, stat } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import lockfile from "proper-lockfile";
import { withLock } from "../state/lock.js";
import { LOCKFILE_FS_ADAPTER } from "../state/lockfile-fs.js";
import {
  continuousRoot,
  prepareContinuousRoot,
  readContinuousPrivate,
  writeContinuousPrivate,
} from "./continuous-storage.js";

const STALE_MS = 30_000;
const localLeases = new Set<string>();
const futureGuards = new Map<string, { identity: string; since: number }>();
interface Owner {
  version: 1;
  id: string;
  pid: number;
  binding: string;
}
export interface ContinuousLease {
  signal: AbortSignal;
  assert(): void;
  release(): Promise<void>;
}
function validOwner(value: unknown): value is Owner {
  if (!value || typeof value !== "object") return false;
  const owner = value as Owner;
  return (
    Object.keys(owner).sort().join(",") === "binding,id,pid,version" &&
    owner.version === 1 &&
    typeof owner.id === "string" &&
    /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u.test(owner.id) &&
    Number.isSafeInteger(owner.pid) &&
    owner.pid > 0 &&
    owner.pid <= 2147483647 &&
    typeof owner.binding === "string" &&
    /^[a-f0-9]{64}$/u.test(owner.binding)
  );
}

/** Advisory only: never authority for a transfer or lease takeover. */
export async function continuousLeaseOwner(binding: string): Promise<string> {
  const owner = await readContinuousPrivate("owner.json");
  if (owner === undefined) return "Local scheduler lease: not observed; waiting for an eligible session";
  if (!validOwner(owner)) throw new Error("Invalid continuous sync owner");
  try {
    const guard = await fs.lstat(path.join(continuousRoot(), "scheduler.lock"));
    if (guard.isDirectory() && !guard.isSymbolicLink() && Date.now() - guard.mtimeMs <= STALE_MS)
      return `Local scheduler lease: observed for pid ${owner.pid}; ${owner.binding === binding ? "this can be another session" : "another setup; this setup is standby"}`;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return "Local scheduler lease: not observed; waiting for an eligible session";
}

/** Caller holds state-directory access during acquisition; the renewable guard prevents live migration. */
export async function acquireContinuousLease(binding: string): Promise<ContinuousLease | undefined> {
  await prepareContinuousRoot();
  const file = path.join(continuousRoot(), "scheduler");
  const guardPath = `${file}.lock`;
  if (localLeases.has(file)) return undefined;
  const previousOwner = await readContinuousPrivate("owner.json");
  if (previousOwner !== undefined && !validOwner(previousOwner))
    throw new Error("Invalid continuous sync owner; evidence retained.");
  if (localLeases.has(file)) return undefined;
  localLeases.add(file);
  const acquiredAt = performance.now();
  const ownerPath = path.join(continuousRoot(), "owner.json");
  const controller = new AbortController();
  const owner: Owner = { version: 1, id: randomUUID(), pid: process.pid, binding };
  let identity: { dev: number; ino: number } | undefined;
  let published = false;
  // proper-lockfile also uses rmdirSync at process exit. Fence both cleanup paths.
  const removeGuard = (target: string) => {
    if (identity) {
      const current = lstatSync(target);
      if (current.dev !== identity.dev || current.ino !== identity.ino) return;
    }
    let current: unknown;
    try {
      const record = lstatSync(ownerPath);
      if (
        !record.isFile() ||
        record.isSymbolicLink() ||
        record.nlink !== 1 ||
        record.size > 4096 ||
        (process.platform !== "win32" && record.mode & 0o077)
      )
        return;
      current = JSON.parse(readFileSync(ownerPath, "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (published && current === undefined) return;
    if (
      current !== undefined &&
      (!validOwner(current) ||
        (current.id !== owner.id && (published || current.id !== (previousOwner as Owner | undefined)?.id)))
    )
      return;
    rmdirSync(target);
  };
  const adapter = {
    ...LOCKFILE_FS_ADAPTER,
    stat: (target: string, callback: (error: NodeJS.ErrnoException | null, value?: Stats) => void) =>
      stat(target, (error, value) => {
        if (!error && value.mtimeMs > Date.now() + STALE_MS) {
          const identity = `${value.dev}:${value.ino}:${value.mtimeMs}`;
          const previous = futureGuards.get(target);
          if (!previous || previous.identity !== identity)
            futureGuards.set(target, { identity, since: performance.now() });
          else if (performance.now() - previous.since > STALE_MS) value.mtime = new Date(Date.now() - STALE_MS - 1);
        } else futureGuards.delete(target);
        callback(error, value);
      }),
    rmdirSync: removeGuard,
    rmdir: (target: string, callback: (error?: NodeJS.ErrnoException | null) => void) => {
      try {
        removeGuard(target);
        callback();
      } catch (error) {
        callback(error as NodeJS.ErrnoException);
      }
    },
  };
  let compromised = false;
  let unlock: () => Promise<void>;
  try {
    unlock = await lockfile.lock(file, {
      fs: adapter,
      realpath: false,
      stale: STALE_MS,
      update: 10_000,
      retries: 0,
      onCompromised: () => {
        compromised = true;
        controller.abort(new DOMException("Continuous sync ownership lost", "AbortError"));
      },
    });
  } catch (error) {
    localLeases.delete(file);
    if ((error as NodeJS.ErrnoException).code === "ELOCKED") return undefined;
    throw error;
  }
  let released = false;
  const release = async () => {
    if (released) return;
    released = true;
    controller.abort(new DOMException("Continuous sync owner released", "AbortError"));
    try {
      if (!compromised) await unlock();
    } finally {
      localLeases.delete(file);
      futureGuards.delete(guardPath);
    }
  };
  try {
    identity = await fs.lstat(guardPath);
    await withLock("continuous-owner", async () => {
      const previous = await readContinuousPrivate("owner.json");
      if (previous !== undefined && !validOwner(previous))
        throw new Error("Invalid continuous sync owner; evidence retained.");
      if (
        (previous as Owner | undefined)?.id !== (previousOwner as Owner | undefined)?.id ||
        performance.now() - acquiredAt > STALE_MS
      )
        throw new Error("Continuous lease generation changed before publication.");
      const current = lstatSync(guardPath);
      if (controller.signal.aborted || current.dev !== identity?.dev || current.ino !== identity.ino)
        throw new Error("Continuous lease changed before publication.");
      await writeContinuousPrivate("owner.json", owner);
      published = true;
    });
    const assert = () => {
      controller.signal.throwIfAborted();
      try {
        const root = lstatSync(continuousRoot());
        if (!root.isDirectory() || root.isSymbolicLink() || (process.platform !== "win32" && root.mode & 0o077))
          throw new Error("Unsafe lease root");
        const stat = lstatSync(guardPath);
        if (
          stat.isSymbolicLink() ||
          !stat.isDirectory() ||
          stat.dev !== identity?.dev ||
          stat.ino !== identity.ino ||
          Date.now() - stat.mtimeMs > STALE_MS
        )
          throw new Error("Lease guard changed");
        const record = lstatSync(ownerPath);
        if (
          !record.isFile() ||
          record.isSymbolicLink() ||
          record.nlink !== 1 ||
          record.size > 4096 ||
          (process.platform !== "win32" && record.mode & 0o077)
        )
          throw new Error("Unsafe owner record");
        const value: unknown = JSON.parse(readFileSync(ownerPath, "utf8"));
        if (!validOwner(value) || value.id !== owner.id || value.binding !== binding || value.pid !== process.pid)
          throw new Error("Lease owner changed");
      } catch {
        controller.abort(new DOMException("Continuous sync ownership lost", "AbortError"));
        controller.signal.throwIfAborted();
      }
    };
    assert();
    return { signal: controller.signal, assert, release };
  } catch (error) {
    await release();
    throw error;
  }
}
