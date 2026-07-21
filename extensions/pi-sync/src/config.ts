import { randomUUID } from "node:crypto";
import type { Dirent } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isDeniedPath, safeName } from "./paths.js";
import type { LockFile, PartialConfig, Snapshot, SyncConfig, SyncState } from "./types.js";

const VERSION = 1;
const DEFAULT_PROFILE = "default";
const DEFAULT_PREFIX = "pi-sync";
const DEFAULT_REGION = "auto";
const LOCK_STALE_MS = 30 * 60 * 1000;
const TOP_LEVEL_FILES = new Set(["settings.json", "keybindings.json", "models.json", "AGENTS.md", "APPEND_SYSTEM.md"]);
const TOP_LEVEL_FILE_NAMES = new Set([...TOP_LEVEL_FILES].map((name) => name.toLowerCase()));
const TOP_LEVEL_DIRS = new Set(["skills", "prompts", "themes", "extensions"]);
const RESERVED_TOP_LEVEL_NAMES = new Set([...TOP_LEVEL_DIRS, "sessions"]);

function trimSlashes(value: string) {
	return value.replace(/^\/+|\/+$/g, "");
}

function decodeBase64Strict(value: string, filePath: string) {
	if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value) || value.length % 4 !== 0) {
		throw new Error(`Invalid base64 content in snapshot file: ${filePath}`);
	}
	return Buffer.from(value, "base64");
}

function sessionDirFromContext(ctx: ExtensionCommandContext | ExtensionContext) {
	const manager = ctx.sessionManager as typeof ctx.sessionManager & {
		usesDefaultSessionDir?: () => boolean;
	};
	const usesDefaultSessionDir = manager.usesDefaultSessionDir;
	if (typeof usesDefaultSessionDir === "function" && usesDefaultSessionDir.call(manager)) {
		return undefined;
	}
	const getSessionDir = manager.getSessionDir;
	return typeof getSessionDir === "function"
		? (getSessionDir.call(manager) as string | undefined)
		: undefined;
}

export async function withLock<T>(command: string, fn: () => Promise<T>): Promise<T> {
	await ensureStateDir();
	const lock: LockFile = {
		id: randomUUID(),
		pid: process.pid,
		command,
		startedAt: new Date().toISOString(),
	};
	let handle: fs.FileHandle | undefined;
	try {
		// Acquire the lock, reclaiming an unreadable (zero-byte/truncated/corrupt)
		// lock file once. Such a file can never represent a real holder, so removing
		// it lets sync/push/pull/rollback self-heal after a crashed or interrupted run.
		for (let attempt = 0; ; attempt++) {
			try {
				handle = await fs.open(lockPath(), "wx");
				break;
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
				const current = await readLock();
				if (current && isStaleLock(current)) {
					throw new Error(`pi-sync lock is stale (pid ${current.pid}). Run /pisync unlock --stale, then retry.`);
				}
				if (current) {
					throw new Error(
						`pi-sync is already running (${current.command}, pid ${current.pid}, started ${current.startedAt}).`,
					);
				}
				if (attempt > 0) {
					throw new Error("pi-sync is already running.");
				}
				// Lock file exists but is unreadable: reclaim and retry.
				await fs.rm(lockPath(), { force: true });
			}
		}
		await handle.writeFile(JSON.stringify(lock, null, "\t"));
		await handle.close();
		handle = undefined;
		return await fn();
	} finally {
		await handle?.close();
		const current = await readLock();
		if (current?.id === lock.id) await fs.rm(lockPath(), { force: true });
	}
}

export async function loadConfigInternal(): Promise<SyncConfig> {
	const partial = await loadPartialConfig();
	const endpoint = partial.endpoint;
	const bucket = partial.bucket;
	const accessKeyId = partial.accessKeyId;
	const secretAccessKey = partial.secretAccessKey;
	const missing = [
		["endpoint", endpoint],
		["bucket", bucket],
		["accessKeyId", accessKeyId],
		["secretAccessKey", secretAccessKey],
	]
		.filter(([, value]) => !value)
		.map(([name]) => name);
	if (missing.length > 0) {
		throw new Error(`Missing pi-sync config: ${missing.join(", ")}. Run /pisync init or set PI_SYNC_* environment variables.`);
	}

	return {
		endpoint: endpoint!,
		bucket: bucket!,
		region: partial.region ?? DEFAULT_REGION,
		accessKeyId: accessKeyId!,
		secretAccessKey: secretAccessKey!,
		sessionToken: partial.sessionToken,
		profile: partial.profile ?? DEFAULT_PROFILE,
		prefix: trimSlashes(partial.prefix ?? DEFAULT_PREFIX),
		syncSessions: isExplicitlyEnabled(partial.syncSessions),
		extraFiles: normalizeExtraFiles(partial.extraFiles),
	};
}

export async function loadConfig(): Promise<SyncConfig> {
	return loadConfigInternal();
}

export async function loadPartialConfig(): Promise<PartialConfig> {
	const fileConfig = (await readJsonIfExists<PartialConfig>(localConfigPath())) ?? {};
	return {
		...fileConfig,
		endpoint: process.env.PI_SYNC_ENDPOINT ?? process.env.R2_ENDPOINT ?? fileConfig.endpoint,
		bucket: process.env.PI_SYNC_BUCKET ?? process.env.R2_BUCKET ?? fileConfig.bucket,
		region: process.env.PI_SYNC_REGION ?? process.env.AWS_REGION ?? fileConfig.region,
		accessKeyId: process.env.PI_SYNC_ACCESS_KEY_ID ?? process.env.AWS_ACCESS_KEY_ID ?? fileConfig.accessKeyId,
		secretAccessKey: process.env.PI_SYNC_SECRET_ACCESS_KEY ?? process.env.AWS_SECRET_ACCESS_KEY ?? fileConfig.secretAccessKey,
		sessionToken: selectSessionToken(fileConfig.sessionToken),
		profile: process.env.PI_SYNC_PROFILE ?? fileConfig.profile,
		prefix: process.env.PI_SYNC_PREFIX ?? fileConfig.prefix,
		autoSync: process.env.PI_SYNC_AUTO_SYNC ?? fileConfig.autoSync,
		syncSessions: process.env.PI_SYNC_SESSIONS ?? fileConfig.syncSessions,
		extraFiles: fileConfig.extraFiles,
	};
}

export async function configuredSessionDir() {
	const envSessionDir = normalizeOptionalString(process.env.PI_CODING_AGENT_SESSION_DIR);
	if (envSessionDir) return expandHome(envSessionDir);
	const settings = await readJsonIfExists<{ sessionDir?: string }>(path.join(agentDir(), "settings.json"));
	return settings?.sessionDir ? expandHome(settings.sessionDir) : undefined;
}

export async function sessionDirForApply(ctx: ExtensionCommandContext | ExtensionContext, snapshot: Snapshot) {
	const contextSessionDir = sessionDirFromContext(ctx);
	const envSessionDir = normalizeOptionalString(process.env.PI_CODING_AGENT_SESSION_DIR);
	if (envSessionDir) return contextSessionDir ?? expandHome(envSessionDir);

	const localSessionDir = await configuredSessionDir();
	if (contextSessionDir && path.resolve(contextSessionDir) !== path.resolve(localSessionDir ?? "")) {
		return contextSessionDir;
	}
	return sessionDirFromSnapshot(snapshot) ?? contextSessionDir;
}

function sessionDirFromSnapshot(snapshot: Snapshot) {
	const settingsFile = snapshot.files.find((file) => file.path === "settings.json");
	if (!settingsFile) return undefined;
	try {
		const settings = JSON.parse(
			decodeBase64Strict(settingsFile.contentBase64, settingsFile.path).toString("utf8"),
		) as { sessionDir?: string };
		return settings.sessionDir ? expandHome(settings.sessionDir) : undefined;
	} catch {
		return undefined;
	}
}

export async function readState(profile: string): Promise<SyncState> {
	return (
		(await readJsonIfExists<SyncState>(statePath(profile))) ?? {
			version: VERSION,
			profile,
			lastFileHashes: {},
		}
	);
}

export async function writeState(profile: string, state: SyncState) {
	await writeJson(statePath(profile), state);
}

export function agentDir() {
	const configured = normalizeOptionalString(process.env.PI_CODING_AGENT_DIR);
	return configured ? expandHome(configured) : path.join(os.homedir(), ".pi", "agent");
}

function expandHome(value: string) {
	return value === "~" || value.startsWith("~/")
		? path.join(os.homedir(), value.slice(2))
		: value;
}

export function stateDir() {
	return path.join(agentDir(), ".pisync");
}

export function localConfigPath() {
	return path.join(agentDir(), "pi-sync.local.json");
}

function statePath(profile: string) {
	return path.join(stateDir(), `${safeName(profile)}.state.json`);
}

export function lockPath() {
	return path.join(stateDir(), "lock");
}

export async function ensureStateDir() {
	await fs.mkdir(stateDir(), { recursive: true });
}

export async function readLock() {
	return readJsonIfExists<LockFile>(lockPath());
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

export function isStaleLock(lock: LockFile) {
	if (!Number.isInteger(lock.pid) || lock.pid <= 0) return true;
	try {
		process.kill(lock.pid, 0);
		return false;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ESRCH") return true;
		return Date.now() - Date.parse(lock.startedAt) > LOCK_STALE_MS;
	}
}

async function readJsonIfExists<T>(filePath: string): Promise<T | undefined> {
	try {
		const text = await fs.readFile(filePath, "utf8");
		// Treat empty/whitespace files (e.g. a truncated or zero-byte lock) as absent.
		if (text.trim().length === 0) return undefined;
		return JSON.parse(text) as T;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		// Treat corrupt/unparseable files as absent so callers can self-heal
		// instead of crashing with a raw SyntaxError.
		if (error instanceof SyntaxError) return undefined;
		throw error;
	}
}

export async function writeJson(filePath: string, value: unknown) {
	await fs.mkdir(path.dirname(filePath), { recursive: true });
	await fs.writeFile(filePath, `${JSON.stringify(value, null, "\t")}\n`);
}

function selectSessionToken(fileSessionToken: string | undefined) {
	if (hasEnv("PI_SYNC_SESSION_TOKEN")) return normalizeOptionalString(process.env.PI_SYNC_SESSION_TOKEN);
	return normalizeOptionalString(process.env.AWS_SESSION_TOKEN) ?? normalizeOptionalString(fileSessionToken);
}

export function sessionTokenWarnings(config: { endpoint?: string; sessionToken?: string }) {
	if (!isCloudflareR2Endpoint(config.endpoint) || !config.sessionToken) return [];
	return [
		"session token: configured for Cloudflare R2; if R2 rejects X-Amz-Security-Token, pi-sync retries once without it. R2 static access keys usually do not need a session token.",
	];
}

export function syncSessionsWarnings(config: { syncSessions?: boolean }) {
	if (!config.syncSessions) return [];
	return [
		"sessions: enabled; Pi session JSONL can contain prompts, tool output, file paths, images, and secrets. Sync sessions only to storage you trust.",
	];
}

function isSecurityTokenInvalidArgument(text: string) {
	return (
		text.includes("<Code>InvalidArgument</Code>") &&
		text.includes("<Message>X-Amz-Security-Token</Message>")
	);
}

export function isCloudflareR2Endpoint(endpoint: string | undefined) {
	const value = endpoint?.trim();
	if (!value) return false;
	try {
		const hostname = new URL(value).hostname.toLowerCase();
		return hostname === "r2.cloudflarestorage.com" || hostname.endsWith(".r2.cloudflarestorage.com");
	} catch {
		return false;
	}
}

function normalizeOptionalString(value: string | undefined) {
	const normalized = value?.trim();
	return normalized ? normalized : undefined;
}

export function normalizeExtraFiles(value: unknown) {
	if (!Array.isArray(value)) return [];
	const seen = new Set<string>();
	return value
		.filter((item): item is string => typeof item === "string")
		.map((item) => item.trim())
		.filter((item) => {
			const lower = item.toLowerCase();
			if (
				item === "" ||
				item === "." ||
				item === ".." ||
				item.includes("/") ||
				item.includes("\\") ||
				TOP_LEVEL_FILE_NAMES.has(lower) ||
				isDeniedPath(item) ||
				RESERVED_TOP_LEVEL_NAMES.has(lower) ||
				seen.has(lower)
			) {
				return false;
			}
			seen.add(lower);
			return true;
		});
}

export function extraFilePathsByLower(value: unknown) {
	return new Map(normalizeExtraFiles(value).map((fileName) => [fileName.toLowerCase(), fileName]));
}

function selectTopLevelFileEntry(entries: Dirent[], fileName: string) {
	const exact = entries.find((entry) => entry.isFile() && entry.name === fileName);
	if (exact) return exact;
	const lower = fileName.toLowerCase();
	return entries
		.filter((entry) => entry.isFile() && entry.name.toLowerCase() === lower)
		.sort((left, right) => left.name.localeCompare(right.name))[0];
}

function hasEnv(name: string) {
	return Object.prototype.hasOwnProperty.call(process.env, name);
}

export function isEnabled(value: boolean | string | undefined, defaultValue: boolean) {
	if (value === undefined) return defaultValue;
	if (typeof value === "boolean") return value;
	return !["0", "false", "no", "off"].includes(value.trim().toLowerCase());
}

export function isExplicitlyEnabled(value: boolean | string | undefined) {
	if (typeof value === "boolean") return value;
	return ["1", "true", "yes", "on"].includes(value?.trim().toLowerCase() ?? "");
}

export function isMissingConfigError(error: unknown) {
	return error instanceof Error && error.message.startsWith("Missing pi-sync config:");
}

function errorMessage(error: unknown) {
	return error instanceof Error ? error.message : String(error);
}
