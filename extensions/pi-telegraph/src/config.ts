import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const DEFAULT_SHORT_NAME = "pi-telegraph";
const CONFIG_FILE_NAME = "pi-telegraph.json";
const LOCK_FILE_NAME = `${CONFIG_FILE_NAME}.lock`;
const LOCK_WAIT_MS = 5_000;
const LOCK_RETRY_MS = 25;
const LOCK_STALE_MS = 60_000;
const KNOWN_FIELDS = new Set(["shortName", "authorName", "authorUrl", "accessToken"]);

export interface TelegraphConfig {
	shortName: string;
	authorName?: string;
	authorUrl?: string;
	accessToken?: string;
}

export interface LoadedTelegraphConfig {
	config: TelegraphConfig;
	path: string;
	exists: boolean;
}

export type TelegraphSetup = Pick<TelegraphConfig, "shortName" | "authorName" | "authorUrl">;

type FileIdentity = { dev: number; ino: number };
type Waiter = { resolve: () => void; reject: (error: unknown) => void; signal?: AbortSignal };

let inProcessLocked = false;
const inProcessWaiters: Waiter[] = [];

export function telegraphConfigPath() {
	return join(process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"), CONFIG_FILE_NAME);
}

export function normalizeTelegraphConfig(value: unknown): TelegraphConfig {
	if (!isPlainObject(value)) {
		throw new Error(`${CONFIG_FILE_NAME} must contain a JSON object.`);
	}
	const unknown = Object.keys(value).filter((key) => !KNOWN_FIELDS.has(key));
	if (unknown.length > 0) {
		throw new Error(`${CONFIG_FILE_NAME} contains unknown field(s): ${unknown.join(", ")}.`);
	}

	const shortName = requiredString(value.shortName ?? DEFAULT_SHORT_NAME, "shortName", 32);
	const authorName = optionalString(value.authorName, "authorName", 128);
	const authorUrl = optionalUrl(value.authorUrl, "authorUrl", 512);
	const accessToken = optionalString(value.accessToken, "accessToken", 4_096);
	if (accessToken?.startsWith("$") || accessToken?.startsWith("!")) {
		throw new Error(
			`${CONFIG_FILE_NAME} accessToken must be a literal token; interpolation and command syntax are not supported.`,
		);
	}

	return cleanObject({ shortName, authorName, authorUrl, accessToken });
}

export async function loadTelegraphConfig(
	filePath = telegraphConfigPath(),
): Promise<LoadedTelegraphConfig> {
	let before: Awaited<ReturnType<typeof lstat>>;
	try {
		before = await lstat(filePath);
	} catch (error) {
		if (isNodeError(error) && error.code === "ENOENT") {
			return { config: { shortName: DEFAULT_SHORT_NAME }, path: filePath, exists: false };
		}
		throw error;
	}
	assertRegularFile(before, filePath);
	await chmod(filePath, 0o600);
	const privateStats = await stat(filePath);
	if ((privateStats.mode & 0o777) !== 0o600) {
		throw new Error(`Refusing to load credentials: ${filePath} permissions are not 0600.`);
	}
	const contents = await readFile(filePath, "utf8");
	const after = await lstat(filePath);
	assertRegularFile(after, filePath);
	if (before.dev !== after.dev || before.ino !== after.ino) {
		throw new Error(`Refusing to load credentials: ${filePath} changed while it was being read.`);
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(contents) as unknown;
	} catch (error) {
		throw new Error(`Failed to parse ${filePath}: ${formatError(error)}`);
	}
	return { config: normalizeTelegraphConfig(parsed), path: filePath, exists: true };
}

export async function writeTelegraphConfig(
	config: TelegraphConfig,
	filePath = telegraphConfigPath(),
) {
	const normalized = normalizeTelegraphConfig(config);
	await ensureWritableConfigPath(filePath);
	await mkdir(dirname(filePath), { recursive: true, mode: 0o700 });
	const tempPath = join(dirname(filePath), `.${CONFIG_FILE_NAME}.${randomUUID()}.tmp`);
	try {
		await writeFile(tempPath, `${JSON.stringify(normalized, null, "\t")}\n`, {
			encoding: "utf8",
			flag: "wx",
			mode: 0o600,
		});
		await chmod(tempPath, 0o600);
		await ensureWritableConfigPath(filePath);
		await rename(tempPath, filePath);
		await chmod(filePath, 0o600);
		const written = await lstat(filePath);
		assertRegularFile(written, filePath);
		if ((written.mode & 0o777) !== 0o600) {
			throw new Error(`Failed to enforce 0600 permissions for ${filePath}.`);
		}
	} catch (error) {
		await rm(tempPath, { force: true }).catch(() => undefined);
		throw error;
	}
}

export async function saveTelegraphSetup(setup: TelegraphSetup) {
	const normalized = normalizeTelegraphConfig(setup);
	return withTelegraphConfigLock(undefined, async () => {
		const current = await loadTelegraphConfig();
		await writeTelegraphConfig({
			shortName: normalized.shortName,
			authorName: normalized.authorName,
			authorUrl: normalized.authorUrl,
			accessToken: current.config.accessToken,
		});
	});
}

export async function withTelegraphConfigLock<T>(
	signal: AbortSignal | undefined,
	callback: () => Promise<T>,
): Promise<T> {
	const releaseProcessLock = await acquireInProcessLock(signal);
	try {
		return await withCrossProcessLock(signal, callback);
	} finally {
		releaseProcessLock();
	}
}

async function withCrossProcessLock<T>(
	signal: AbortSignal | undefined,
	callback: () => Promise<T>,
): Promise<T> {
	const lockPath = join(dirname(telegraphConfigPath()), LOCK_FILE_NAME);
	await mkdir(dirname(lockPath), { recursive: true, mode: 0o700 });
	const started = Date.now();
	const id = randomUUID();
	let owned: FileIdentity | undefined;

	while (!owned) {
		throwIfAborted(signal);
		try {
			const handle = await open(lockPath, "wx", 0o600);
			try {
				await handle.writeFile(
					JSON.stringify({ id, pid: process.pid, startedAt: Date.now() }),
					"utf8",
				);
				await handle.chmod(0o600);
				const lockStats = await handle.stat();
				owned = { dev: lockStats.dev, ino: lockStats.ino };
			} finally {
				await handle.close();
			}
		} catch (error) {
			if (!isNodeError(error) || error.code !== "EEXIST") throw error;
			await removeStaleLock(lockPath);
			if (Date.now() - started >= LOCK_WAIT_MS) {
				throw new Error(
					`Timed out waiting for ${LOCK_FILE_NAME}; retry after the other Pi process finishes.`,
				);
			}
			await abortableDelay(LOCK_RETRY_MS, signal);
		}
	}

	try {
		throwIfAborted(signal);
		return await callback();
	} finally {
		await removeOwnedFile(lockPath, owned);
	}
}

async function acquireInProcessLock(signal?: AbortSignal): Promise<() => void> {
	throwIfAborted(signal);
	if (!inProcessLocked) {
		inProcessLocked = true;
		return releaseInProcessLock;
	}

	await new Promise<void>((resolve, reject) => {
		const waiter: Waiter = { resolve, reject, signal };
		const onAbort = () => {
			const index = inProcessWaiters.indexOf(waiter);
			if (index >= 0) inProcessWaiters.splice(index, 1);
			reject(abortReason(signal));
		};
		if (signal) signal.addEventListener("abort", onAbort, { once: true });
		waiter.resolve = () => {
			if (signal) signal.removeEventListener("abort", onAbort);
			resolve();
		};
		inProcessWaiters.push(waiter);
	});
	return releaseInProcessLock;
}

function releaseInProcessLock() {
	while (inProcessWaiters.length > 0) {
		const waiter = inProcessWaiters.shift();
		if (!waiter || waiter.signal?.aborted) continue;
		waiter.resolve();
		return;
	}
	inProcessLocked = false;
}

async function removeStaleLock(lockPath: string) {
	let lockStats: Awaited<ReturnType<typeof lstat>>;
	try {
		lockStats = await lstat(lockPath);
	} catch (error) {
		if (isNodeError(error) && error.code === "ENOENT") return;
		throw error;
	}
	assertRegularFile(lockStats, lockPath);

	let stale = Date.now() - lockStats.mtimeMs > LOCK_STALE_MS;
	try {
		const value = JSON.parse(await readFile(lockPath, "utf8")) as unknown;
		if (isPlainObject(value)) {
			const pid = value.pid;
			const startedAt = value.startedAt;
			if (typeof pid === "number" && Number.isInteger(pid) && pid > 0) {
				stale =
					!processExists(pid) ||
					(typeof startedAt === "number" && Date.now() - startedAt > LOCK_STALE_MS);
			}
		}
	} catch {
		// A concurrently created lock can be briefly incomplete; mtime-based staleness remains safe.
	}
	if (stale) {
		await removeOwnedFile(lockPath, { dev: lockStats.dev, ino: lockStats.ino });
	}
}

async function removeOwnedFile(filePath: string, identity: FileIdentity) {
	try {
		const current = await lstat(filePath);
		if (current.dev === identity.dev && current.ino === identity.ino) {
			await rm(filePath);
		}
	} catch (error) {
		if (!isNodeError(error) || error.code !== "ENOENT") throw error;
	}
}

async function ensureWritableConfigPath(filePath: string) {
	try {
		const current = await lstat(filePath);
		assertRegularFile(current, filePath);
	} catch (error) {
		if (isNodeError(error) && error.code === "ENOENT") return;
		throw error;
	}
}

function assertRegularFile(file: Awaited<ReturnType<typeof lstat>>, filePath: string) {
	if (file.isSymbolicLink()) throw new Error(`Refusing symbolic link config path: ${filePath}.`);
	if (!file.isFile()) throw new Error(`Config path must be a regular file: ${filePath}.`);
}

function requiredString(value: unknown, field: string, maxLength: number) {
	if (typeof value !== "string" || value.trim().length === 0) {
		throw new Error(`${CONFIG_FILE_NAME} ${field} must be a non-empty string.`);
	}
	const normalized = value.trim();
	if (hasControlCharacter(normalized)) {
		throw new Error(`${CONFIG_FILE_NAME} ${field} must not contain control characters.`);
	}
	if (Array.from(normalized).length > maxLength) {
		throw new Error(`${CONFIG_FILE_NAME} ${field} must be at most ${maxLength} characters.`);
	}
	return normalized;
}

function optionalString(value: unknown, field: string, maxLength: number) {
	if (value === undefined || value === "") return undefined;
	if (typeof value !== "string") {
		throw new Error(`${CONFIG_FILE_NAME} ${field} must be a string.`);
	}
	const normalized = value.trim();
	if (!normalized) return undefined;
	if (hasControlCharacter(normalized)) {
		throw new Error(`${CONFIG_FILE_NAME} ${field} must not contain control characters.`);
	}
	if (Array.from(normalized).length > maxLength) {
		throw new Error(`${CONFIG_FILE_NAME} ${field} must be at most ${maxLength} characters.`);
	}
	return normalized;
}

function optionalUrl(value: unknown, field: string, maxLength: number) {
	const normalized = optionalString(value, field, maxLength);
	if (!normalized) return undefined;
	let parsed: URL;
	try {
		parsed = new URL(normalized);
	} catch {
		throw new Error(`${CONFIG_FILE_NAME} ${field} must be an HTTP or HTTPS URL.`);
	}
	if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
		throw new Error(`${CONFIG_FILE_NAME} ${field} must be an HTTP or HTTPS URL.`);
	}
	return normalized;
}

function processExists(pid: number) {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return isNodeError(error) && error.code !== "ESRCH";
	}
}

function abortableDelay(ms: number, signal?: AbortSignal) {
	throwIfAborted(signal);
	return new Promise<void>((resolve, reject) => {
		const finish = () => {
			if (signal) signal.removeEventListener("abort", onAbort);
			resolve();
		};
		const timer = setTimeout(finish, ms);
		const onAbort = () => {
			clearTimeout(timer);
			if (signal) signal.removeEventListener("abort", onAbort);
			reject(abortReason(signal));
		};
		if (signal) signal.addEventListener("abort", onAbort, { once: true });
	});
}

function throwIfAborted(signal?: AbortSignal) {
	if (signal?.aborted) throw abortReason(signal);
}

function abortReason(signal?: AbortSignal) {
	return signal?.reason instanceof Error ? signal.reason : new Error("Operation aborted.");
}

function hasControlCharacter(value: string) {
	for (let index = 0; index < value.length; index += 1) {
		const code = value.charCodeAt(index);
		if (code <= 0x1f || code === 0x7f) return true;
	}
	return false;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

function cleanObject<T extends Record<string, unknown>>(value: T) {
	return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as T;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
	return error instanceof Error && "code" in error;
}

function formatError(error: unknown) {
	return error instanceof Error ? error.message : String(error);
}
