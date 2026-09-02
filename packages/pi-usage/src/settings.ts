import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, mkdir, open, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { isFireworksAccountId } from "./providers/fireworks.js";
import { isBoundedTargetId } from "./usage-targets.js";

export const USAGE_SETTINGS_FILE = "pi-usage.json";
export const MAX_USAGE_SETTINGS_BYTES = 64 * 1024;

export type OpenAIServiceTier = "default" | "priority" | "flex";

export interface UsageSettings {
	openaiServiceTier: OpenAIServiceTier;
	codexStatusResetCountdown: boolean;
	selectedTargets: Record<string, string>;
}

export const DEFAULT_USAGE_SETTINGS: Readonly<UsageSettings> = Object.freeze({
	openaiServiceTier: "default",
	codexStatusResetCountdown: true,
	selectedTargets: Object.freeze({}),
});

export interface UsageSettingsState {
	kind: "missing" | "loaded" | "invalid";
	path: string;
	settings: UsageSettings;
	document?: Record<string, unknown>;
	issue?: string;
}

export type UsageTargetPublicationCheck = () => Promise<void>;

export interface UsageSettingsRuntime {
	get(): Readonly<UsageSettingsState>;
	reload(signal?: AbortSignal): Promise<Readonly<UsageSettingsState>>;
	update(
		patch: Partial<UsageSettings>,
		signal?: AbortSignal,
	): Promise<Readonly<UsageSettingsState>>;
	updateSelectedTarget(
		providerId: string,
		targetId: string,
		signal?: AbortSignal,
		checkPublishedSelection?: UsageTargetPublicationCheck,
	): Promise<Readonly<UsageSettingsState>>;
	flush(): Promise<void>;
}

interface UsageSettingsFileOperations {
	rename: typeof rename;
	writeFile: typeof writeFile;
}

interface UsageSettingsRuntimeOptions {
	operations?: Partial<UsageSettingsFileOperations>;
	path?: string;
}

export function usageSettingsPath(): string {
	return join(getAgentDir(), USAGE_SETTINGS_FILE);
}

export function normalizeUsageSettings(value: unknown): UsageSettings | undefined {
	if (!isRecord(value)) return undefined;
	if (Object.hasOwn(value, "openaiServiceTier") && !isOpenAIServiceTier(value.openaiServiceTier)) {
		return undefined;
	}
	if (Object.hasOwn(value, "codexFastMode") && typeof value.codexFastMode !== "boolean") {
		return undefined;
	}
	if (
		Object.hasOwn(value, "codexStatusResetCountdown") &&
		typeof value.codexStatusResetCountdown !== "boolean"
	) {
		return undefined;
	}
	if (
		Object.hasOwn(value, "fireworksAccountId") &&
		!isFireworksAccountId(value.fireworksAccountId)
	) {
		return undefined;
	}
	const selectedTargets = normalizeSelectedTargets(value.selectedTargets);
	if (Object.hasOwn(value, "selectedTargets") && !selectedTargets) return undefined;
	const effectiveTargets = { ...(selectedTargets ?? {}) };
	if (!effectiveTargets.fireworks && isFireworksAccountId(value.fireworksAccountId)) {
		effectiveTargets.fireworks = value.fireworksAccountId;
	}
	return {
		openaiServiceTier: isOpenAIServiceTier(value.openaiServiceTier)
			? value.openaiServiceTier
			: value.codexFastMode === true
				? "priority"
				: DEFAULT_USAGE_SETTINGS.openaiServiceTier,
		codexStatusResetCountdown:
			typeof value.codexStatusResetCountdown === "boolean"
				? value.codexStatusResetCountdown
				: DEFAULT_USAGE_SETTINGS.codexStatusResetCountdown,
		selectedTargets: effectiveTargets,
	};
}

export async function loadUsageSettings(
	path = usageSettingsPath(),
	signal?: AbortSignal,
): Promise<UsageSettingsState> {
	throwIfAborted(signal);
	try {
		const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
		let text: string;
		try {
			const stats = await handle.stat();
			throwIfAborted(signal);
			if (!stats.isFile()) throw new Error("settings path is not a regular file");
			if (stats.size > MAX_USAGE_SETTINGS_BYTES) {
				throw new Error("settings file exceeds 64 KiB");
			}
			text = await handle.readFile("utf8");
		} finally {
			await handle.close();
		}
		throwIfAborted(signal);
		const document = JSON.parse(text) as unknown;
		const settings = normalizeUsageSettings(document);
		if (!settings || !isRecord(document)) throw new Error("invalid settings shape");
		return { kind: "loaded", path, settings, document };
	} catch (error) {
		if (signal?.aborted) throw error;
		if (isNodeError(error) && error.code === "ENOENT") {
			return {
				kind: "missing",
				path,
				settings: { ...DEFAULT_USAGE_SETTINGS },
				document: {},
			};
		}
		return {
			kind: "invalid",
			path,
			settings: { ...DEFAULT_USAGE_SETTINGS },
			issue:
				isNodeError(error) && error.code === "ELOOP"
					? "symbolic links are not accepted"
					: error instanceof Error
						? error.message
						: String(error),
		};
	}
}

export function createUsageSettingsRuntime(
	options: UsageSettingsRuntimeOptions | string = {},
): UsageSettingsRuntime {
	const path = typeof options === "string" ? options : (options.path ?? usageSettingsPath());
	const operations: UsageSettingsFileOperations = {
		rename,
		writeFile,
		...(typeof options === "string" ? undefined : options.operations),
	};
	let state: UsageSettingsState = {
		kind: "missing",
		path,
		settings: { ...DEFAULT_USAGE_SETTINGS },
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
				const loaded = await loadUsageSettings(path, signal);
				state = loaded;
				return structuredClone(state);
			}),
		update: (patch, signal) =>
			enqueue(async () => {
				const saved = await saveUsageSettingsPatch(path, patch, operations, signal);
				state = saved;
				return structuredClone(state);
			}),
		updateSelectedTarget: (providerId, targetId, signal, checkPublishedSelection) =>
			enqueue(async () => {
				const transaction = await saveUsageTargetSelection(
					path,
					providerId,
					targetId,
					operations,
					signal,
				);
				try {
					await checkPublishedSelection?.();
					throwIfAborted(signal);
				} catch (error) {
					try {
						await restoreUsageSettingsState(
							path,
							transaction.saved,
							transaction.previous,
							operations,
						);
						state = transaction.previous;
					} catch (rollbackError) {
						state = await loadUsageSettings(path);
						throw new AggregateError(
							[error, rollbackError],
							"Target selection changed after publication and pi-usage.json rollback failed",
						);
					}
					throw error;
				}
				state = transaction.saved;
				return structuredClone(state);
			}),
		flush: () => queue,
	};
}

async function saveUsageSettingsPatch(
	path: string,
	patch: Partial<UsageSettings>,
	operations: UsageSettingsFileOperations,
	signal?: AbortSignal,
): Promise<UsageSettingsState> {
	return saveUsageSettingsDocument(
		path,
		(document) => {
			if (Object.hasOwn(patch, "openaiServiceTier")) delete document.codexFastMode;
			for (const [key, value] of Object.entries(patch)) {
				if (value === undefined) delete document[key];
				else document[key] = value;
			}
		},
		operations,
		signal,
	);
}

async function saveUsageTargetSelection(
	path: string,
	providerId: string,
	targetId: string,
	operations: UsageSettingsFileOperations,
	signal?: AbortSignal,
): Promise<{ saved: UsageSettingsState; previous: UsageSettingsState }> {
	if (!isProviderId(providerId) || !isBoundedTargetId(targetId)) {
		throw new Error("Refusing to save an invalid usage target selection");
	}
	const previous = await loadUsageSettings(path, signal);
	const saved = await saveUsageSettingsDocument(
		path,
		(document) => {
			document.selectedTargets = {
				...(normalizeSelectedTargets(document.selectedTargets) ?? {}),
				[providerId]: targetId,
			};
			if (providerId === "fireworks") delete document.fireworksAccountId;
		},
		operations,
		signal,
		previous,
	);
	return { saved, previous };
}

async function saveUsageSettingsDocument(
	path: string,
	mutate: (document: Record<string, unknown>) => void,
	operations: UsageSettingsFileOperations,
	signal?: AbortSignal,
	expected?: UsageSettingsState,
): Promise<UsageSettingsState> {
	const latest = await loadUsageSettings(path, signal);
	if (latest.kind === "invalid") {
		throw new Error("Cannot overwrite an invalid pi-usage.json; repair it and reload first");
	}
	if (expected && !sameUsageSettingsDocument(latest, expected)) {
		throw new Error("pi-usage.json changed while saving; retry the action");
	}
	const document = { ...latest.document };
	mutate(document);
	const settings = normalizeUsageSettings(document);
	if (!settings) throw new Error("Refusing to save invalid pi-usage settings");
	const directory = dirname(path);
	const temporaryPath = join(directory, `.${basename(path)}.${randomUUID()}.tmp`);
	await mkdir(directory, { recursive: true, mode: 0o700 });
	throwIfAborted(signal);
	try {
		await operations.writeFile(temporaryPath, `${JSON.stringify(document, null, 2)}\n`, {
			encoding: "utf8",
			flag: "wx",
			mode: 0o600,
		});
		if (process.platform !== "win32") await chmodPrivate(temporaryPath);
		throwIfAborted(signal);
		const current = await loadUsageSettings(path, signal);
		if (
			current.kind === "invalid" ||
			current.kind !== latest.kind ||
			JSON.stringify(current.document) !== JSON.stringify(latest.document)
		) {
			throw new Error("pi-usage.json changed while saving; retry the action");
		}
		throwIfAborted(signal);
		await operations.rename(temporaryPath, path);
	} finally {
		await rm(temporaryPath, { force: true }).catch(() => undefined);
	}
	return { kind: "loaded", path, settings, document };
}

async function restoreUsageSettingsState(
	path: string,
	published: UsageSettingsState,
	previous: UsageSettingsState,
	operations: UsageSettingsFileOperations,
): Promise<void> {
	if (previous.kind === "missing") {
		const current = await loadUsageSettings(path);
		if (!sameUsageSettingsDocument(current, published)) {
			throw new Error("pi-usage.json changed before target selection rollback");
		}
		await rm(path);
		return;
	}
	if (previous.kind !== "loaded" || !previous.document) {
		throw new Error("Cannot restore invalid prior pi-usage.json settings");
	}
	await saveUsageSettingsDocument(
		path,
		(document) => {
			for (const key of Object.keys(document)) delete document[key];
			Object.assign(document, previous.document);
		},
		operations,
		undefined,
		published,
	);
}

function sameUsageSettingsDocument(
	left: Pick<UsageSettingsState, "kind" | "document">,
	right: Pick<UsageSettingsState, "kind" | "document">,
): boolean {
	return (
		left.kind === right.kind && JSON.stringify(left.document) === JSON.stringify(right.document)
	);
}

function isOpenAIServiceTier(value: unknown): value is OpenAIServiceTier {
	return value === "default" || value === "priority" || value === "flex";
}

async function chmodPrivate(path: string): Promise<void> {
	await chmod(path, 0o600);
}

function throwIfAborted(signal?: AbortSignal): void {
	if (signal?.aborted) throw new DOMException("Settings operation aborted", "AbortError");
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
	return error instanceof Error && "code" in error;
}

function normalizeSelectedTargets(value: unknown): Record<string, string> | undefined {
	if (value === undefined) return {};
	if (!isRecord(value)) return undefined;
	const targets: Record<string, string> = {};
	for (const [providerId, targetId] of Object.entries(value)) {
		if (!isProviderId(providerId) || !isBoundedTargetId(targetId)) return undefined;
		targets[providerId] = targetId;
	}
	return targets;
}

function isProviderId(value: string): boolean {
	return /^[A-Za-z0-9][A-Za-z0-9._~-]{0,127}$/u.test(value);
}
