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

export type LockInspection =
	| { status: "missing" }
	| { status: "unreadable" }
	| { status: "valid"; lock: LockFile };

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

		const inspection = await inspectLock();
		if (inspection.status === "valid" && isStaleLock(inspection.lock)) {
			throw new Error(
				`pi-sync lock is stale (pid ${inspection.lock.pid}). Run /pisync unlock --stale, then retry.`,
			);
		}
		if (inspection.status === "valid") {
			throw new Error(
				`pi-sync is already running (${inspection.lock.command}, pid ${inspection.lock.pid}, started ${inspection.lock.startedAt}).`,
			);
		}
		if (inspection.status === "unreadable") {
			throw new Error(
				"pi-sync lock metadata is unreadable. Run /pisync unlock --stale after verifying no sync is running.",
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
		stale: GUARD_STALE_MS,
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
	await ensureStateDir();
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
	let inspection = await inspectLock();
	if (inspection.status === "missing") {
		ctx.ui.notify("No pi-sync lock is present.", "info");
		return;
	}
	if (inspection.status === "unreadable") {
		if (!options.stale) {
			ctx.ui.notify(
				"Pi-sync lock metadata is unreadable. Use /pisync unlock --stale only after verifying no sync is running.",
				"warning",
			);
			return;
		}
		inspection = await inspectLock();
		if (inspection.status === "unreadable") {
			// Legacy writers expose an empty file before writing owner metadata, so no
			// automatic test can prove this file is abandoned. The explicit --stale
			// flag is the user's confirmation that no legacy sync is still running.
			await fs.rm(lockPath(), { force: true });
			ctx.ui.notify("Removed unreadable pi-sync lock.", "info");
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
			`Pi-sync is currently running (${current.command}, pid ${current.pid}, started ${current.startedAt}).`,
		);
	}
	return new Error(
		"Pi-sync is currently running (lock metadata is unreadable or still being written).",
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
