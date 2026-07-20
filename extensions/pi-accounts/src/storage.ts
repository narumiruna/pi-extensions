import { randomUUID } from "node:crypto";
import {
	chmodSync,
	closeSync,
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
	withLock<T>(mutator: (current: string | undefined) => StorageLockResult<T>): T;
	withLockAsync<T>(
		mutator: (current: string | undefined) => Promise<StorageLockResult<T>>,
	): Promise<T>;
}

export class FileAccountStorageBackend implements AccountStorageBackend {
	constructor(
		private readonly filePath: string,
		private readonly options: { syncLockTimeoutMs?: number } = {},
	) {}

	withLock<T>(mutator: (current: string | undefined) => StorageLockResult<T>): T {
		this.ensureFileExists();
		let release: (() => void) | undefined;
		try {
			release = this.acquireLockSyncWithRetry();
			const { result, next } = mutator(readFileSync(this.filePath, "utf8"));
			if (next !== undefined) this.writePrivate(next);
			return result;
		} finally {
			release?.();
		}
	}

	async withLockAsync<T>(
		mutator: (current: string | undefined) => Promise<StorageLockResult<T>>,
	): Promise<T> {
		this.ensureFileExists();
		let release: (() => Promise<void>) | undefined;
		let compromisedError: Error | undefined;
		const throwIfCompromised = () => {
			if (compromisedError) throw compromisedError;
		};

		try {
			release = await lockfile.lock(this.filePath, {
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
				onCompromised: (error) => {
					compromisedError = error;
				},
			});
			throwIfCompromised();
			const { result, next } = await mutator(readFileSync(this.filePath, "utf8"));
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

	private ensureFileExists(): void {
		const parent = dirname(this.filePath);
		mkdirSync(parent, { recursive: true, mode: 0o700 });
		chmodSync(parent, 0o700);
		let descriptor: number | undefined;
		try {
			descriptor = openSync(this.filePath, "wx", 0o600);
			writeFileSync(descriptor, "", PRIVATE_FILE_WRITE_OPTIONS);
		} catch (error) {
			if (!isNodeError(error) || error.code !== "EEXIST") throw error;
		} finally {
			if (descriptor !== undefined) closeSync(descriptor);
		}
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

export class InMemoryAccountStorageBackend implements AccountStorageBackend {
	private value: string | undefined;

	withLock<T>(mutator: (current: string | undefined) => StorageLockResult<T>): T {
		const { result, next } = mutator(this.value);
		if (next !== undefined) this.value = next;
		return result;
	}

	async withLockAsync<T>(
		mutator: (current: string | undefined) => Promise<StorageLockResult<T>>,
	): Promise<T> {
		const { result, next } = await mutator(this.value);
		if (next !== undefined) this.value = next;
		return result;
	}
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
	return error instanceof Error;
}
