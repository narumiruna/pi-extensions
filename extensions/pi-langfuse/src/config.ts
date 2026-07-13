import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const CONFIG_FILE_NAME = "pi-langfuse.json";
export const DEFAULT_BASE_URL = "https://us.cloud.langfuse.com";

export interface LangfuseConfig {
	publicKey: string;
	secretKey: string;
	baseUrl: string;
	environment?: string;
	release?: string;
	captureContent: boolean;
}

export type LangfuseConfigResult =
	| { ok: true; config: LangfuseConfig; path: string; warnings: string[] }
	| { ok: false; path: string; warnings: string[]; reason: string };

export function langfuseConfigPath(): string {
	return join(process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"), CONFIG_FILE_NAME);
}

export async function writeLangfuseConfig(
	config: LangfuseConfig,
	path = langfuseConfigPath(),
): Promise<LangfuseConfig> {
	const normalized = normalizeLangfuseConfig(config);
	if (!normalized.ok) throw new Error(normalized.reason);

	await mkdir(dirname(path), { recursive: true, mode: 0o700 });
	const tempPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
	try {
		await writeFile(tempPath, `${JSON.stringify(normalized.config, null, 2)}\n`, {
			encoding: "utf8",
			mode: 0o600,
		});
		await chmod(tempPath, 0o600);
		await rename(tempPath, path);
		await chmod(path, 0o600);
		return normalized.config;
	} catch (error) {
		await rm(tempPath, { force: true }).catch(() => undefined);
		throw error;
	}
}

export async function loadLangfuseConfig(
	path = langfuseConfigPath(),
): Promise<LangfuseConfigResult> {
	const warnings: string[] = [];
	const permissionFailure = await ensurePrivatePermissions(path, warnings);
	if (permissionFailure) {
		return {
			ok: false,
			path,
			warnings,
			reason: `Refusing to load credentials: ${permissionFailure}`,
		};
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(await readFile(path, "utf8"));
	} catch (error) {
		if (isNodeError(error) && error.code === "ENOENT") {
			return { ok: false, path, warnings, reason: `Configuration file not found: ${path}` };
		}
		return {
			ok: false,
			path,
			warnings,
			reason: `Failed to read ${path}: ${formatError(error)}`,
		};
	}

	const normalized = normalizeLangfuseConfig(parsed);
	if (!normalized.ok) return { ok: false, path, warnings, reason: normalized.reason };
	return { ok: true, config: normalized.config, path, warnings };
}

export function normalizeLangfuseConfig(
	value: unknown,
): { ok: true; config: LangfuseConfig } | { ok: false; reason: string } {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return { ok: false, reason: "pi-langfuse.json must contain a JSON object." };
	}
	const input = value as Record<string, unknown>;
	const publicKey = normalizeString(input.publicKey);
	const secretKey = normalizeString(input.secretKey);
	if (!publicKey) {
		return { ok: false, reason: "pi-langfuse.json requires a literal publicKey string." };
	}
	if (!secretKey) {
		return { ok: false, reason: "pi-langfuse.json requires a literal secretKey string." };
	}
	if (isInterpolation(publicKey)) {
		return {
			ok: false,
			reason:
				"pi-langfuse.json publicKey must be literal; environment and command interpolation are not supported.",
		};
	}
	if (isInterpolation(secretKey)) {
		return {
			ok: false,
			reason:
				"pi-langfuse.json secretKey must be literal; environment and command interpolation are not supported.",
		};
	}

	const rawBaseUrl =
		input.baseUrl === undefined ? DEFAULT_BASE_URL : normalizeString(input.baseUrl);
	if (!rawBaseUrl) {
		return { ok: false, reason: "pi-langfuse.json baseUrl must be a non-empty string." };
	}
	const baseUrl = normalizeBaseUrl(rawBaseUrl);
	if (!baseUrl) {
		return {
			ok: false,
			reason:
				"pi-langfuse.json baseUrl must use HTTP or HTTPS without credentials, a query, or a fragment.",
		};
	}

	if (input.captureContent !== undefined && typeof input.captureContent !== "boolean") {
		return { ok: false, reason: "pi-langfuse.json captureContent must be a boolean." };
	}
	const environment = optionalString(input.environment, "environment");
	if (!environment.ok) return environment;
	const release = optionalString(input.release, "release");
	if (!release.ok) return release;

	return {
		ok: true,
		config: {
			publicKey,
			secretKey,
			baseUrl,
			...(environment.value ? { environment: environment.value } : {}),
			...(release.value ? { release: release.value } : {}),
			captureContent: input.captureContent ?? true,
		},
	};
}

async function ensurePrivatePermissions(
	path: string,
	warnings: string[],
): Promise<string | undefined> {
	try {
		const file = await stat(path);
		if ((file.mode & 0o777) !== 0o600) {
			await chmod(path, 0o600);
			const repaired = await stat(path);
			if ((repaired.mode & 0o777) !== 0o600) {
				throw new Error(`permissions remained ${(repaired.mode & 0o777).toString(8)}`);
			}
			warnings.push(`Restricted ${path} permissions to 0600.`);
		}
	} catch (error) {
		if (isNodeError(error) && error.code === "ENOENT") return undefined;
		const failure = `Failed to enforce 0600 permissions for ${path}: ${formatError(error)}`;
		warnings.push(failure);
		return failure;
	}
	return undefined;
}

function normalizeBaseUrl(value: string): string | undefined {
	try {
		const url = new URL(value);
		if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
		if (url.username || url.password || url.search || url.hash) return undefined;
		return url.toString().replace(/\/+$/, "");
	} catch {
		return undefined;
	}
}

function optionalString(
	value: unknown,
	name: string,
): { ok: true; value?: string } | { ok: false; reason: string } {
	if (value === undefined) return { ok: true };
	const normalized = normalizeString(value);
	return normalized
		? { ok: true, value: normalized }
		: { ok: false, reason: `pi-langfuse.json ${name} must be a non-empty string.` };
}

function normalizeString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function isInterpolation(value: string): boolean {
	return value.startsWith("$") || value.startsWith("!");
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
	return error instanceof Error && "code" in error;
}

function formatError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
