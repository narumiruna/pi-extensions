import { chmodSync, closeSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import lockfile from "proper-lockfile";

const PRIVATE_FILE_WRITE_OPTIONS = { encoding: "utf8", mode: 0o600 } as const;
const DEFAULT_SYNC_LOCK_TIMEOUT_MS = 200;
const SYNC_LOCK_RETRY_INTERVAL_MS = 20;
const syncSleepState = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));

type StorageLockResult<T> = {
	result: T;
	next?: string;
};

export interface CodexAccountStorageBackend {
	withLock<T>(mutator: (current: string | undefined) => StorageLockResult<T>): T;
	withLockAsync<T>(
		mutator: (current: string | undefined) => Promise<StorageLockResult<T>>,
	): Promise<T>;
}

export class FileCodexAccountStorageBackend implements CodexAccountStorageBackend {
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
		mkdirSync(dirname(this.filePath), { recursive: true, mode: 0o700 });
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
				return lockfile.lockSync(this.filePath, { realpath: false });
			} catch (error) {
				if (!isNodeError(error) || error.code !== "ELOCKED") throw error;
				const remainingMs = deadline - Date.now();
				if (remainingMs <= 0) throw error;
				Atomics.wait(syncSleepState, 0, 0, Math.min(SYNC_LOCK_RETRY_INTERVAL_MS, remainingMs));
			}
		}
	}

	private writePrivate(contents: string): void {
		writeFileSync(this.filePath, contents, PRIVATE_FILE_WRITE_OPTIONS);
		chmodSync(this.filePath, 0o600);
	}
}

export class InMemoryCodexAccountStorageBackend implements CodexAccountStorageBackend {
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
