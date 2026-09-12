import { randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  lstatSync,
  mkdir,
  mkdirSync,
  openSync,
  readFileSync,
  realpath,
  realpathSync,
  renameSync,
  rmdir,
  rmdirSync,
  rmSync,
  stat,
  statSync,
  utimes,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import lockfile from "proper-lockfile";

const PRIVATE_FILE_WRITE_OPTIONS = { encoding: "utf8", mode: 0o600 } as const;
const DEFAULT_SYNC_LOCK_TIMEOUT_MS = 200;
const SYNC_LOCK_RETRY_INTERVAL_MS = 20;
const syncSleepState = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));

type LockfileFsAdapter = {
  mkdir: typeof mkdir;
  mkdirSync: typeof mkdirSync;
  realpath: typeof realpath;
  realpathSync: typeof realpathSync;
  rmdir: typeof rmdir;
  rmdirSync: typeof rmdirSync;
  stat: typeof stat;
  statSync: typeof statSync;
  utimes: typeof utimes;
  utimesSync: typeof utimesSync;
};

export function createLockfileFsAdapter(source: LockfileFsAdapter): LockfileFsAdapter {
  return {
    mkdir: source.mkdir,
    mkdirSync: source.mkdirSync,
    realpath: source.realpath,
    realpathSync: source.realpathSync,
    rmdir: source.rmdir,
    rmdirSync: source.rmdirSync,
    stat: source.stat,
    statSync: source.statSync,
    utimes: source.utimes,
    utimesSync: source.utimesSync,
  };
}

// proper-lockfile caches mtime precision as a non-configurable symbol on this object.
// Keep it plain and stable instead of exposing Bun's loader-proxied filesystem module.
const LOCKFILE_FS_ADAPTER = createLockfileFsAdapter({
  mkdir,
  mkdirSync,
  realpath,
  realpathSync,
  rmdir,
  rmdirSync,
  stat,
  statSync,
  utimes,
  utimesSync,
});

export type StorageLockResult<T> = {
  result: T;
  next?: string;
};

export interface AccountStorageBackend {
  read<T>(reader: (current: string | undefined) => T): T;
  readAsync<T>(reader: (current: string | undefined) => Promise<T>): Promise<T>;
  withLock<T>(mutator: (current: string | undefined) => StorageLockResult<T>): T;
  withLockAsync<T>(mutator: (current: string | undefined) => Promise<StorageLockResult<T>>): Promise<T>;
}

export class FileAccountStorageBackend implements AccountStorageBackend {
  constructor(
    private readonly filePath: string,
    private readonly options: { syncLockTimeoutMs?: number } = {},
  ) {}

  read<T>(reader: (current: string | undefined) => T): T {
    if (!this.fileOrLockExistsForRead()) return reader(undefined);
    let release: (() => void) | undefined;
    try {
      release = this.acquireLockSyncWithRetry();
      return reader(readPrivateRegularFileIfExists(this.filePath));
    } finally {
      release?.();
    }
  }

  async readAsync<T>(reader: (current: string | undefined) => Promise<T>): Promise<T> {
    if (!this.fileOrLockExistsForRead()) return reader(undefined);
    let release: (() => Promise<void>) | undefined;
    let compromisedError: Error | undefined;
    const throwIfCompromised = () => {
      if (compromisedError) throw compromisedError;
    };

    try {
      release = await this.acquireLockAsync((error) => {
        compromisedError = error;
      });
      throwIfCompromised();
      const result = await reader(readPrivateRegularFileIfExists(this.filePath));
      throwIfCompromised();
      return result;
    } finally {
      if (release) await release().catch(() => undefined);
    }
  }

  withLock<T>(mutator: (current: string | undefined) => StorageLockResult<T>): T {
    this.ensureParentDirectory();
    let release: (() => void) | undefined;
    try {
      release = this.acquireLockSyncWithRetry();
      const { result, next } = mutator(readPrivateRegularFileIfExists(this.filePath));
      if (next !== undefined) this.writePrivate(next);
      return result;
    } finally {
      release?.();
    }
  }

  async withLockAsync<T>(mutator: (current: string | undefined) => Promise<StorageLockResult<T>>): Promise<T> {
    this.ensureParentDirectory();
    let release: (() => Promise<void>) | undefined;
    let compromisedError: Error | undefined;
    const throwIfCompromised = () => {
      if (compromisedError) throw compromisedError;
    };

    try {
      release = await this.acquireLockAsync((error) => {
        compromisedError = error;
      });
      throwIfCompromised();
      const { result, next } = await mutator(readPrivateRegularFileIfExists(this.filePath));
      throwIfCompromised();
      if (next !== undefined) this.writePrivate(next);
      throwIfCompromised();
      return result;
    } finally {
      if (release) {
        try {
          await release();
        } catch {
          // A compromised lock may already have been removed by another process.
        }
      }
    }
  }

  private fileOrLockExistsForRead(): boolean {
    if (pathEntryExists(this.filePath)) return true;
    if (pathEntryExists(`${this.filePath}.lock`)) return true;
    // Close the publication race between checking the file and its lock.
    return pathEntryExists(this.filePath);
  }

  private ensureParentDirectory(): void {
    const parent = dirname(this.filePath);
    mkdirSync(parent, { recursive: true, mode: 0o700 });
    chmodSync(parent, 0o700);
  }

  private acquireLockAsync(onCompromised: (error: Error) => void) {
    return lockfile.lock(this.filePath, {
      fs: LOCKFILE_FS_ADAPTER,
      realpath: false,
      retries: {
        retries: 10,
        factor: 2,
        minTimeout: 100,
        maxTimeout: 10_000,
        randomize: true,
      },
      stale: 30_000,
      onCompromised,
    });
  }

  private acquireLockSyncWithRetry(): () => void {
    const timeoutMs = this.options.syncLockTimeoutMs ?? DEFAULT_SYNC_LOCK_TIMEOUT_MS;
    const deadline = Date.now() + timeoutMs;
    while (true) {
      try {
        return lockfile.lockSync(this.filePath, {
          fs: LOCKFILE_FS_ADAPTER,
          realpath: false,
        });
      } catch (error) {
        if (!isNodeError(error) || error.code !== "ELOCKED") throw error;
        const remainingMs = deadline - Date.now();
        if (remainingMs <= 0) throw error;
        Atomics.wait(syncSleepState, 0, 0, Math.min(SYNC_LOCK_RETRY_INTERVAL_MS, remainingMs));
      }
    }
  }

  private writePrivate(contents: string): void {
    const tempPath = `${this.filePath}.${randomUUID()}.tmp`;
    try {
      writeFileSync(tempPath, contents, {
        ...PRIVATE_FILE_WRITE_OPTIONS,
        flag: "wx",
      });
      chmodSync(tempPath, 0o600);
      renameSync(tempPath, this.filePath);
      chmodSync(this.filePath, 0o600);
    } finally {
      rmSync(tempPath, { force: true });
    }
  }
}

function readPrivateRegularFileIfExists(filePath: string): string | undefined {
  return pathEntryExists(filePath) ? readPrivateRegularFile(filePath) : undefined;
}

function pathEntryExists(filePath: string): boolean {
  try {
    lstatSync(filePath);
    return true;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return false;
    throw error;
  }
}

function readPrivateRegularFile(filePath: string): string {
  const info = lstatSync(filePath);
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new Error(`Accounts path must be a regular file: ${filePath}`);
  }
  let descriptor: number | undefined;
  try {
    descriptor = openSync(filePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    if (!fstatSync(descriptor).isFile()) {
      throw new Error(`Accounts path must be a regular file: ${filePath}`);
    }
    fchmodSync(descriptor, 0o600);
    return readFileSync(descriptor, "utf8");
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

export class InMemoryAccountStorageBackend implements AccountStorageBackend {
  private value: string | undefined;

  read<T>(reader: (current: string | undefined) => T): T {
    return reader(this.value);
  }

  readAsync<T>(reader: (current: string | undefined) => Promise<T>): Promise<T> {
    return reader(this.value);
  }

  withLock<T>(mutator: (current: string | undefined) => StorageLockResult<T>): T {
    const { result, next } = mutator(this.value);
    if (next !== undefined) this.value = next;
    return result;
  }

  async withLockAsync<T>(mutator: (current: string | undefined) => Promise<StorageLockResult<T>>): Promise<T> {
    const { result, next } = await mutator(this.value);
    if (next !== undefined) this.value = next;
    return result;
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error;
}
