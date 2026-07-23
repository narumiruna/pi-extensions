import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { safeName } from "./paths.js";
import { DEFAULT_SYNC_FILES, normalizeExtraFiles, normalizeSyncFiles } from "./sync-policy.js";
import type { PartialConfig, Snapshot, SyncConfig, SyncState } from "./types.js";

export { extraFilePathsByLower, normalizeExtraFiles, normalizeSyncFiles } from "./sync-policy.js";

const VERSION = 1;
const DEFAULT_PROFILE = "default";
const DEFAULT_PREFIX = "pi-sync";
const DEFAULT_REGION = "auto";

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
		throw new Error(
			`Missing pi-sync config: ${missing.join(", ")}. Run /sync init or set PI_SYNC_* environment variables.`,
		);
	}
	if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) {
		throw new Error("Missing pi-sync config after validation.");
	}

	return {
		endpoint,
		bucket,
		region: partial.region ?? DEFAULT_REGION,
		accessKeyId,
		secretAccessKey,
		sessionToken: partial.sessionToken,
		profile: partial.profile ?? DEFAULT_PROFILE,
		prefix: trimSlashes(partial.prefix ?? DEFAULT_PREFIX),
		syncFiles: normalizeSyncFiles(partial.syncFiles),
		syncSessions: isExplicitlyEnabled(partial.syncSessions),
		extraFiles: normalizeExtraFiles(partial.extraFiles),
	};
}

export async function loadConfig(): Promise<SyncConfig> {
	return loadConfigInternal();
}

export async function loadPartialConfig(): Promise<PartialConfig> {
	const fileConfig = ((await readLocalConfigObject()) ?? {}) as PartialConfig;
	return {
		...fileConfig,
		endpoint: process.env.PI_SYNC_ENDPOINT ?? process.env.R2_ENDPOINT ?? fileConfig.endpoint,
		bucket: process.env.PI_SYNC_BUCKET ?? process.env.R2_BUCKET ?? fileConfig.bucket,
		region: process.env.PI_SYNC_REGION ?? process.env.AWS_REGION ?? fileConfig.region,
		accessKeyId:
			process.env.PI_SYNC_ACCESS_KEY_ID ?? process.env.AWS_ACCESS_KEY_ID ?? fileConfig.accessKeyId,
		secretAccessKey:
			process.env.PI_SYNC_SECRET_ACCESS_KEY ??
			process.env.AWS_SECRET_ACCESS_KEY ??
			fileConfig.secretAccessKey,
		sessionToken: selectSessionToken(fileConfig.sessionToken),
		profile: process.env.PI_SYNC_PROFILE ?? fileConfig.profile,
		prefix: process.env.PI_SYNC_PREFIX ?? fileConfig.prefix,
		autoSync: process.env.PI_SYNC_AUTO_SYNC ?? fileConfig.autoSync,
		syncFiles: fileConfig.syncFiles,
		syncSessions: process.env.PI_SYNC_SESSIONS ?? fileConfig.syncSessions,
		extraFiles: fileConfig.extraFiles,
	};
}

export async function configuredSessionDir() {
	const envSessionDir = normalizeOptionalString(process.env.PI_CODING_AGENT_SESSION_DIR);
	if (envSessionDir) return expandHome(envSessionDir);
	const settings = await readJsonIfExists<{ sessionDir?: string }>(
		path.join(agentDir(), "settings.json"),
	);
	return settings?.sessionDir ? expandHome(settings.sessionDir) : undefined;
}

export async function sessionDirForApply(
	ctx: ExtensionCommandContext | ExtensionContext,
	snapshot: Snapshot,
) {
	const contextSessionDir = sessionDirFromContext(ctx);
	const envSessionDir = normalizeOptionalString(process.env.PI_CODING_AGENT_SESSION_DIR);
	if (envSessionDir) return contextSessionDir ?? expandHome(envSessionDir);

	const localSessionDir = await configuredSessionDir();
	if (
		contextSessionDir &&
		path.resolve(contextSessionDir) !== path.resolve(localSessionDir ?? "")
	) {
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
	return value === "~" || value.startsWith("~/") ? path.join(os.homedir(), value.slice(2)) : value;
}

export function stateDir() {
	return path.join(agentDir(), ".pisync");
}

export function localConfigPath() {
	return path.join(agentDir(), "pi-sync.local.json");
}

export function localConfigTemplate(): Record<string, unknown> {
	return {
		endpoint: "https://<account-id>.r2.cloudflarestorage.com",
		bucket: "pi-sync",
		region: DEFAULT_REGION,
		accessKeyId: "<access-key-id>",
		secretAccessKey: "<secret-access-key>",
		profile: DEFAULT_PROFILE,
		prefix: DEFAULT_PREFIX,
		autoSync: true,
		syncFiles: [...DEFAULT_SYNC_FILES],
		syncSessions: false,
		extraFiles: [],
	};
}

export async function readLocalConfigObject(): Promise<Record<string, unknown> | undefined> {
	const configPath = localConfigPath();
	try {
		const stat = await fs.lstat(configPath);
		if (stat.isSymbolicLink())
			throw new Error(`Refusing to read symlinked pi-sync config: ${configPath}`);
		if (!stat.isFile()) throw new Error(`pi-sync config is not a regular file: ${configPath}`);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
	const parsed = JSON.parse(await fs.readFile(configPath, "utf8")) as unknown;
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error(`pi-sync config must contain a JSON object: ${configPath}`);
	}
	return parsed as Record<string, unknown>;
}

export async function updateLocalConfig(
	update: (current: Record<string, unknown>) => Record<string, unknown>,
) {
	const current = (await readLocalConfigObject()) ?? localConfigTemplate();
	const next = update({ ...current });
	await writeLocalConfigObject(next);
	return next;
}

export async function writeLocalConfigObject(value: Record<string, unknown>) {
	const configPath = localConfigPath();
	await fs.mkdir(path.dirname(configPath), { recursive: true });
	try {
		const stat = await fs.lstat(configPath);
		if (stat.isSymbolicLink())
			throw new Error(`Refusing to overwrite symlinked pi-sync config: ${configPath}`);
		if (!stat.isFile()) throw new Error(`pi-sync config is not a regular file: ${configPath}`);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}

	const temporaryPath = path.join(
		path.dirname(configPath),
		`.${path.basename(configPath)}.${process.pid}.${randomUUID()}.tmp`,
	);
	let handle: fs.FileHandle | undefined;
	try {
		handle = await fs.open(temporaryPath, "wx", 0o600);
		await handle.writeFile(`${JSON.stringify(value, null, "\t")}\n`, "utf8");
		if (process.platform !== "win32") await handle.chmod(0o600);
		await handle.sync();
		await handle.close();
		handle = undefined;
		await fs.rename(temporaryPath, configPath);
	} catch (error) {
		await handle?.close().catch(() => undefined);
		await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
		throw error;
	}
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

async function readJsonIfExists<T>(filePath: string): Promise<T | undefined> {
	try {
		return JSON.parse(await fs.readFile(filePath, "utf8")) as T;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}

export async function writeJson(filePath: string, value: unknown) {
	await fs.mkdir(path.dirname(filePath), { recursive: true });
	await fs.writeFile(filePath, `${JSON.stringify(value, null, "\t")}\n`);
}

function selectSessionToken(fileSessionToken: string | undefined) {
	if (hasEnv("PI_SYNC_SESSION_TOKEN"))
		return normalizeOptionalString(process.env.PI_SYNC_SESSION_TOKEN);
	return (
		normalizeOptionalString(process.env.AWS_SESSION_TOKEN) ??
		normalizeOptionalString(fileSessionToken)
	);
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

export function isCloudflareR2Endpoint(endpoint: string | undefined) {
	const value = endpoint?.trim();
	if (!value) return false;
	try {
		const hostname = new URL(value).hostname.toLowerCase();
		return (
			hostname === "r2.cloudflarestorage.com" || hostname.endsWith(".r2.cloudflarestorage.com")
		);
	} catch {
		return false;
	}
}

function normalizeOptionalString(value: string | undefined) {
	const normalized = value?.trim();
	return normalized ? normalized : undefined;
}

function hasEnv(name: string) {
	return Object.hasOwn(process.env, name);
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
