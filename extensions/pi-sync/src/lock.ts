import { randomUUID } from "node:crypto";
import {
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
} from "node:fs";
import fs from "node:fs/promises";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import lockfile from "proper-lockfile";
import { ensureStateDir, lockPath } from "./config.js";
import type { CommandOptions, LockFile } from "./types.js";

const LOCK_STALE_MS = 30 * 60 * 1000;
const LOCK_WRITE_GRACE_MS = 5_000;
const GUARD_STALE_MS = 30_000;
const GUARD_UPDATE_MS = 10_000;
const MAX_PROCESS_ID = 2_147_483_647;

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

const LOCKFILE_FS_ADAPTER: LockfileFsAdapter = {
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
};

interface Guard {
	release: () => Promise<void>;
	throwIfCompromised: () => void;
	isCompromised: () => boolean;
}

export async function withLock<T>(command: string, fn: () => Promise<T>): Promise<T> {
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

		const current = await readLock();
		if (current && isStaleLock(current)) {
			throw new Error(
				`pi-sync lock is stale (pid ${current.pid}). Run /pisync unlock --stale, then retry.`,
			);
		}
		if (current) {
			throw new Error(
				`pi-sync is already running (${current.command}, pid ${current.pid}, started ${current.startedAt}).`,
			);
		}

		const recovery = await reclaimUnreadableLock();
		if (recovery === "fresh") {
			throw new Error("pi-sync is already running (lock metadata is still being written).");
		}
		if (recovery === "changed") {
			throw new Error("pi-sync is already running (lock changed while being inspected).");
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

export async function readLock(): Promise<LockFile | undefined> {
	try {
		const text = await fs.readFile(lockPath(), "utf8");
		if (text.trim().length === 0) return undefined;
		const parsed = JSON.parse(text) as unknown;
		return isLockFile(parsed) ? parsed : undefined;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		if (error instanceof SyntaxError) return undefined;
		throw error;
	}
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

export async function reclaimUnreadableLock(force = false) {
	if (await readLock()) return "changed" as const;
	try {
		const unreadable = await fs.stat(lockPath());
		if (!force && Date.now() - unreadable.mtimeMs < LOCK_WRITE_GRACE_MS) {
			return "fresh" as const;
		}
		await fs.rm(lockPath());
		return "removed" as const;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing" as const;
		throw error;
	}
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
	await ensureStateDir();
	let guard: Guard;
	try {
		guard = await acquireGuard();
	} catch (error) {
		if (!isLockHeldError(error)) throw error;
		ctx.ui.notify("Pi-sync is currently running; retry unlock after it finishes.", "warning");
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
	const lock = await readLock();
	if (!lock) {
		const recovery = await reclaimUnreadableLock(options.stale);
		if (recovery === "removed") {
			ctx.ui.notify("Removed unreadable pi-sync lock.", "info");
			return;
		}
		if (recovery === "fresh") {
			ctx.ui.notify(
				"Lock metadata may still be initializing. Retry shortly, or use /pisync unlock --stale after verifying no sync is running.",
				"warning",
			);
			return;
		}
		if (recovery === "changed") {
			ctx.ui.notify("Pi-sync lock changed while being inspected; retry the command.", "warning");
			return;
		}
		ctx.ui.notify("No pi-sync lock is present.", "info");
		return;
	}
	if (!options.stale && !isStaleLock(lock)) {
		ctx.ui.notify(
			"Lock is not stale. Use /pisync unlock --stale only after verifying no sync is running.",
			"warning",
		);
		return;
	}
	await fs.rm(lockPath(), { force: true });
	ctx.ui.notify("Removed stale pi-sync lock.", "info");
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
		stale: GUARD_STALE_MS,
		update: GUARD_UPDATE_MS,
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
			`pi-sync is already running (${current.command}, pid ${current.pid}, started ${current.startedAt}).`,
		);
	}
	return new Error("pi-sync is already running (lock metadata is still being written).");
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
