import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { RemoteCompactionProtocolSetting } from "./model-api.js";

export const CODEX_COMPACT_SETTINGS_FILE = "pi-codex-compact.json";
export const MAX_SETTINGS_BYTES = 64 * 1024;

export interface CodexCompactSettings {
	enabled: boolean;
	protocol: RemoteCompactionProtocolSetting;
	requestTimeoutMs: number;
	maxRetries: number;
	replacementTokenBudget: number;
	notifyOnFallback: boolean;
}

export const DEFAULT_CODEX_COMPACT_SETTINGS: Readonly<CodexCompactSettings> = Object.freeze({
	enabled: true,
	protocol: "auto",
	requestTimeoutMs: 300_000,
	maxRetries: 2,
	replacementTokenBudget: 64_000,
	notifyOnFallback: true,
});

const LIMITS = Object.freeze({
	requestTimeoutMs: { minimum: 30_000, maximum: 600_000 },
	maxRetries: { minimum: 0, maximum: 2 },
	replacementTokenBudget: { minimum: 8_000, maximum: 128_000 },
});

export interface CodexCompactSettingsState {
	kind: "missing" | "loaded" | "invalid";
	path: string;
	settings: CodexCompactSettings;
	document?: Record<string, unknown>;
	issue?: string;
}

export interface CodexCompactSettingsRuntime {
	get(): Readonly<CodexCompactSettingsState>;
	reload(signal?: AbortSignal): Promise<Readonly<CodexCompactSettingsState>>;
	update(
		patch: Partial<CodexCompactSettings>,
		signal?: AbortSignal,
	): Promise<Readonly<CodexCompactSettingsState>>;
	flush(): Promise<void>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validInteger(value: unknown, minimum: number, maximum: number): value is number {
	return (
		typeof value === "number" && Number.isSafeInteger(value) && value >= minimum && value <= maximum
	);
}

export function normalizeCodexCompactSettings(value: unknown): CodexCompactSettings | undefined {
	if (!isRecord(value)) return undefined;
	if (Object.hasOwn(value, "enabled") && typeof value.enabled !== "boolean") return undefined;
	if (
		Object.hasOwn(value, "protocol") &&
		value.protocol !== "auto" &&
		value.protocol !== "remote-v2" &&
		value.protocol !== "responses-compact"
	) {
		return undefined;
	}
	if (Object.hasOwn(value, "notifyOnFallback") && typeof value.notifyOnFallback !== "boolean") {
		return undefined;
	}
	for (const [field, limits] of Object.entries(LIMITS) as Array<
		[keyof typeof LIMITS, { minimum: number; maximum: number }]
	>) {
		if (
			Object.hasOwn(value, field) &&
			!validInteger(value[field], limits.minimum, limits.maximum)
		) {
			return undefined;
		}
	}
	return {
		enabled:
			typeof value.enabled === "boolean" ? value.enabled : DEFAULT_CODEX_COMPACT_SETTINGS.enabled,
		protocol:
			value.protocol === "remote-v2" || value.protocol === "responses-compact"
				? value.protocol
				: DEFAULT_CODEX_COMPACT_SETTINGS.protocol,
		requestTimeoutMs:
			typeof value.requestTimeoutMs === "number"
				? value.requestTimeoutMs
				: DEFAULT_CODEX_COMPACT_SETTINGS.requestTimeoutMs,
		maxRetries:
			typeof value.maxRetries === "number"
				? value.maxRetries
				: DEFAULT_CODEX_COMPACT_SETTINGS.maxRetries,
		replacementTokenBudget:
			typeof value.replacementTokenBudget === "number"
				? value.replacementTokenBudget
				: DEFAULT_CODEX_COMPACT_SETTINGS.replacementTokenBudget,
		notifyOnFallback:
			typeof value.notifyOnFallback === "boolean"
				? value.notifyOnFallback
				: DEFAULT_CODEX_COMPACT_SETTINGS.notifyOnFallback,
	};
}

export function codexCompactSettingsPath(): string {
	return join(getAgentDir(), CODEX_COMPACT_SETTINGS_FILE);
}

function aborted(signal?: AbortSignal): void {
	if (signal?.aborted) throw new DOMException("Settings operation aborted", "AbortError");
}

export async function loadCodexCompactSettings(
	path = codexCompactSettingsPath(),
	signal?: AbortSignal,
): Promise<CodexCompactSettingsState> {
	aborted(signal);
	try {
		const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
		let text: string;
		try {
			const stats = await handle.stat();
			aborted(signal);
			if (!stats.isFile()) throw new Error("settings path is not a regular file");
			if (stats.size > MAX_SETTINGS_BYTES) throw new Error("settings file exceeds 64 KiB");
			text = await handle.readFile("utf8");
		} finally {
			await handle.close();
		}
		aborted(signal);
		const document = JSON.parse(text) as unknown;
		const settings = normalizeCodexCompactSettings(document);
		if (!settings || !isRecord(document)) throw new Error("invalid settings shape or bounds");
		return { kind: "loaded", path, settings, document };
	} catch (error) {
		if (signal?.aborted) throw error;
		if (isNodeError(error) && error.code === "ENOENT") {
			return {
				kind: "missing",
				path,
				settings: { ...DEFAULT_CODEX_COMPACT_SETTINGS },
				document: {},
			};
		}
		return {
			kind: "invalid",
			path,
			settings: { ...DEFAULT_CODEX_COMPACT_SETTINGS },
			issue:
				isNodeError(error) && error.code === "ELOOP"
					? "symbolic links are not accepted"
					: error instanceof Error
						? error.message
						: String(error),
		};
	}
}

async function savePatch(
	path: string,
	patch: Partial<CodexCompactSettings>,
	signal?: AbortSignal,
): Promise<CodexCompactSettingsState> {
	const latest = await loadCodexCompactSettings(path, signal);
	if (latest.kind === "invalid") {
		throw new Error(
			"Cannot overwrite an invalid pi-codex-compact.json; repair it and reload first",
		);
	}
	const document = { ...latest.document, ...patch };
	const settings = normalizeCodexCompactSettings(document);
	if (!settings) throw new Error("Refusing to save invalid Codex compaction settings");
	const temporaryPath = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
	await mkdir(dirname(path), { recursive: true });
	aborted(signal);
	try {
		await writeFile(temporaryPath, `${JSON.stringify(document, null, 2)}\n`, {
			encoding: "utf8",
			flag: "wx",
			mode: 0o600,
		});
		aborted(signal);
		const current = await loadCodexCompactSettings(path, signal);
		if (
			current.kind === "invalid" ||
			current.kind !== latest.kind ||
			JSON.stringify(current.document) !== JSON.stringify(latest.document)
		) {
			throw new Error("pi-codex-compact.json changed while saving; reopen settings and retry");
		}
		await rename(temporaryPath, path);
	} finally {
		await rm(temporaryPath, { force: true }).catch(() => undefined);
	}
	return { kind: "loaded", path, settings, document };
}

export function createCodexCompactSettingsRuntime(
	path = codexCompactSettingsPath(),
): CodexCompactSettingsRuntime {
	let state: CodexCompactSettingsState = {
		kind: "missing",
		path,
		settings: { ...DEFAULT_CODEX_COMPACT_SETTINGS },
		document: {},
	};
	let queue = Promise.resolve();
	const enqueue = <T>(operation: () => Promise<T>): Promise<T> => {
		const result = queue.then(operation, operation);
		queue = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	};
	return {
		get: () => structuredClone(state),
		reload: (signal) =>
			enqueue(async () => {
				state = await loadCodexCompactSettings(path, signal);
				return structuredClone(state);
			}),
		update: (patch, signal) =>
			enqueue(async () => {
				state = await savePatch(path, patch, signal);
				return structuredClone(state);
			}),
		flush: () => queue,
	};
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
	return error instanceof Error && "code" in error;
}
