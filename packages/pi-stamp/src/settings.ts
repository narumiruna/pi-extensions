import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import {
	ASSISTANT_METADATA_MODES,
	canonicalizeLocale,
	canonicalizeTimeZone,
	DATE_CONTEXTS,
	DEFAULT_STAMP_SETTINGS,
	HOUR_CYCLES,
	RESPONSE_TIMING_MODES,
	type StampSettings,
} from "./format.js";

export const STAMP_SETTINGS_FILE = "pi-stamp.json";
export const MAX_STAMP_SETTINGS_BYTES = 64 * 1024;

export type StampSettingsField = keyof StampSettings;
export type StampSettingsSource = "built-in" | "user";
export type StampSettingsPatch = Partial<StampSettings>;

export interface NormalizedStampSettings {
	settings: StampSettings;
	sources: Record<StampSettingsField, StampSettingsSource>;
}

export interface StampSettingsIssue {
	kind: "invalid";
	message: string;
}

export interface StampSettingsState extends NormalizedStampSettings {
	issue?: StampSettingsIssue;
	canSave: boolean;
}

export type StampSettingsLoadResult =
	| (NormalizedStampSettings & {
			kind: "missing";
			path: string;
			document: Record<string, unknown>;
	  })
	| (NormalizedStampSettings & {
			kind: "loaded";
			path: string;
			document: Record<string, unknown>;
	  })
	| (NormalizedStampSettings & {
			kind: "invalid";
			path: string;
			issue: StampSettingsIssue;
	  });

export interface StampSettingsOperations {
	writeFile: typeof writeFile;
	rename: typeof rename;
}

export interface StampSettingsRuntime {
	get(): Readonly<StampSettingsState>;
	getPath(): string;
	reload(signal?: AbortSignal): Promise<Readonly<StampSettingsState>>;
	update(patch: StampSettingsPatch): Promise<Readonly<StampSettingsState>>;
	flush(): Promise<void>;
}

interface StampSettingsRuntimeOptions {
	path?: string | (() => string);
	operations?: Partial<StampSettingsOperations>;
}

const SETTING_FIELDS = [
	"hourCycle",
	"showSeconds",
	"dateContext",
	"locale",
	"timeZone",
	"responseTiming",
	"assistantMetadata",
	"showExactTimeline",
	"showThinkingLevel",
	"showCompactAbnormalOutcome",
	"showCostSinceUser",
	"toolStamps",
] as const satisfies readonly StampSettingsField[];
const SETTING_FIELD_SET = new Set<string>(SETTING_FIELDS);

export function stampSettingsFilePath(): string {
	return join(getAgentDir(), STAMP_SETTINGS_FILE);
}

export function normalizeStampSettingsDocument(
	value: unknown,
): NormalizedStampSettings | undefined {
	if (!isRecord(value)) return undefined;
	const settings: StampSettings = { ...DEFAULT_STAMP_SETTINGS };
	const sources = builtInSources();

	if (Object.hasOwn(value, "hourCycle")) {
		if (!HOUR_CYCLES.includes(value.hourCycle as StampSettings["hourCycle"])) return undefined;
		settings.hourCycle = value.hourCycle as StampSettings["hourCycle"];
		sources.hourCycle = "user";
	}
	if (Object.hasOwn(value, "showSeconds")) {
		if (typeof value.showSeconds !== "boolean") return undefined;
		settings.showSeconds = value.showSeconds;
		sources.showSeconds = "user";
	}
	if (Object.hasOwn(value, "dateContext")) {
		if (!DATE_CONTEXTS.includes(value.dateContext as StampSettings["dateContext"])) {
			return undefined;
		}
		settings.dateContext = value.dateContext as StampSettings["dateContext"];
		sources.dateContext = "user";
	}
	if (Object.hasOwn(value, "locale")) {
		if (typeof value.locale !== "string") return undefined;
		const locale = canonicalizeLocale(value.locale);
		if (!locale) return undefined;
		settings.locale = locale;
		sources.locale = "user";
	}
	if (Object.hasOwn(value, "timeZone")) {
		if (typeof value.timeZone !== "string") return undefined;
		const timeZone = canonicalizeTimeZone(value.timeZone);
		if (!timeZone) return undefined;
		settings.timeZone = timeZone;
		sources.timeZone = "user";
	}
	if (Object.hasOwn(value, "responseTiming")) {
		if (!RESPONSE_TIMING_MODES.includes(value.responseTiming as StampSettings["responseTiming"])) {
			return undefined;
		}
		settings.responseTiming = value.responseTiming as StampSettings["responseTiming"];
		sources.responseTiming = "user";
	}
	if (Object.hasOwn(value, "assistantMetadata")) {
		if (
			!ASSISTANT_METADATA_MODES.includes(
				value.assistantMetadata as StampSettings["assistantMetadata"],
			)
		) {
			return undefined;
		}
		settings.assistantMetadata = value.assistantMetadata as StampSettings["assistantMetadata"];
		sources.assistantMetadata = "user";
	}
	if (Object.hasOwn(value, "showExactTimeline")) {
		if (typeof value.showExactTimeline !== "boolean") return undefined;
		settings.showExactTimeline = value.showExactTimeline;
		sources.showExactTimeline = "user";
	}
	if (Object.hasOwn(value, "showThinkingLevel")) {
		if (typeof value.showThinkingLevel !== "boolean") return undefined;
		settings.showThinkingLevel = value.showThinkingLevel;
		sources.showThinkingLevel = "user";
	}
	if (Object.hasOwn(value, "showCompactAbnormalOutcome")) {
		if (typeof value.showCompactAbnormalOutcome !== "boolean") return undefined;
		settings.showCompactAbnormalOutcome = value.showCompactAbnormalOutcome;
		sources.showCompactAbnormalOutcome = "user";
	}
	if (Object.hasOwn(value, "showCostSinceUser")) {
		if (typeof value.showCostSinceUser !== "boolean") return undefined;
		settings.showCostSinceUser = value.showCostSinceUser;
		sources.showCostSinceUser = "user";
	}
	if (Object.hasOwn(value, "toolStamps")) {
		if (typeof value.toolStamps !== "boolean") return undefined;
		settings.toolStamps = value.toolStamps;
		sources.toolStamps = "user";
	}
	return { settings, sources };
}

export async function loadStampSettings(
	path = stampSettingsFilePath(),
	signal?: AbortSignal,
): Promise<StampSettingsLoadResult> {
	let text: string;
	try {
		text = await readSettingsDocument(path, signal);
	} catch (error) {
		if (signal?.aborted) throw error;
		if (isNodeError(error) && error.code === "ENOENT") {
			return {
				kind: "missing",
				path,
				document: {},
				settings: { ...DEFAULT_STAMP_SETTINGS },
				sources: builtInSources(),
			};
		}
		return invalidLoad(path, formatError(error));
	}

	try {
		const document = JSON.parse(text) as unknown;
		const normalized = normalizeStampSettingsDocument(document);
		if (!normalized || !isRecord(document)) {
			return invalidLoad(path, "the document is malformed or contains an invalid setting");
		}
		return { kind: "loaded", path, document, ...normalized };
	} catch (error) {
		return invalidLoad(path, formatError(error));
	}
}

export function createStampSettingsRuntime(
	options: StampSettingsRuntimeOptions = {},
): StampSettingsRuntime {
	let resolvedPath: string | undefined;
	const getPath = () => {
		resolvedPath ??=
			typeof options.path === "function"
				? options.path()
				: (options.path ?? stampSettingsFilePath());
		return resolvedPath;
	};
	const operations: StampSettingsOperations = {
		writeFile,
		rename,
		...options.operations,
	};
	let state: StampSettingsState = {
		settings: { ...DEFAULT_STAMP_SETTINGS },
		sources: builtInSources(),
		canSave: true,
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
		get: () => freezeState(state),
		getPath,
		reload(signal) {
			return enqueue(async () => {
				const loaded = await loadStampSettings(getPath(), signal);
				if (loaded.kind === "invalid") {
					state = { ...state, issue: loaded.issue, canSave: false };
					return freezeState(state);
				}
				state = { settings: loaded.settings, sources: loaded.sources, canSave: true };
				return freezeState(state);
			});
		},
		update(patch) {
			return enqueue(async () => {
				const canonicalPatch = normalizePatch(patch);
				const latest = await loadStampSettings(getPath());
				if (latest.kind === "invalid") {
					state = { ...state, issue: latest.issue, canSave: false };
					throw new Error(`Cannot update malformed or invalid settings: ${latest.issue.message}`);
				}
				const document = { ...latest.document, ...canonicalPatch };
				const normalized = normalizeStampSettingsDocument(document);
				if (!normalized) throw new Error("Refusing to publish invalid pi-stamp settings.");
				await publishSettingsDocument(document, getPath(), operations);
				state = { ...normalized, canSave: true };
				return freezeState(state);
			});
		},
		async flush() {
			await queue;
		},
	};
}

function normalizePatch(patch: StampSettingsPatch): StampSettingsPatch {
	if (!isRecord(patch) || Object.keys(patch).some((key) => !SETTING_FIELD_SET.has(key))) {
		throw new Error("Refusing to update unknown pi-stamp settings.");
	}
	const normalized = normalizeStampSettingsDocument(patch);
	if (!normalized) throw new Error("Refusing to update invalid pi-stamp settings.");
	const canonical: StampSettingsPatch = {};
	for (const field of SETTING_FIELDS) {
		if (Object.hasOwn(patch, field)) {
			assignSetting(canonical, field, normalized.settings[field]);
		}
	}
	return canonical;
}

function assignSetting<K extends StampSettingsField>(
	settings: StampSettingsPatch,
	field: K,
	value: StampSettings[K],
): void {
	settings[field] = value;
}

async function publishSettingsDocument(
	document: Record<string, unknown>,
	path: string,
	operations: StampSettingsOperations,
): Promise<void> {
	const contents = `${JSON.stringify(document, null, "\t")}\n`;
	if (Buffer.byteLength(contents, "utf8") > MAX_STAMP_SETTINGS_BYTES) {
		throw new Error(`settings document exceeds ${MAX_STAMP_SETTINGS_BYTES} bytes`);
	}
	await mkdir(dirname(path), { recursive: true });
	const temporaryPath = join(
		dirname(path),
		`.${basename(path)}.${process.pid}.${randomUUID()}.tmp`,
	);
	try {
		await operations.writeFile(temporaryPath, contents, {
			encoding: "utf8",
			flag: "wx",
			mode: 0o600,
		});
		await operations.rename(temporaryPath, path);
	} finally {
		await rm(temporaryPath, { force: true }).catch(() => undefined);
	}
}

async function readSettingsDocument(path: string, signal?: AbortSignal): Promise<string> {
	if (signal?.aborted) throw signal.reason;
	const flags = constants.O_RDONLY | (constants.O_NONBLOCK ?? 0) | (constants.O_NOFOLLOW ?? 0);
	const opening = open(path, flags);
	const handle = await abortable(opening, signal).catch((error) => {
		if (signal?.aborted) void opening.then((opened) => opened.close()).catch(() => undefined);
		throw error;
	});
	try {
		const [descriptorStats, pathStats] = await Promise.all([
			abortable(handle.stat(), signal),
			abortable(lstat(path), signal),
		]);
		if (pathStats.isSymbolicLink()) throw new Error("symbolic links are not accepted");
		if (!descriptorStats.isFile() || !pathStats.isFile()) {
			throw new Error("settings path is not a regular file");
		}
		if (descriptorStats.dev !== pathStats.dev || descriptorStats.ino !== pathStats.ino) {
			throw new Error("settings path changed while it was being opened");
		}
		if (descriptorStats.size > MAX_STAMP_SETTINGS_BYTES) {
			throw new Error(`settings file exceeds ${MAX_STAMP_SETTINGS_BYTES} bytes`);
		}
		const buffer = Buffer.alloc(MAX_STAMP_SETTINGS_BYTES + 1);
		let offset = 0;
		while (offset < buffer.length) {
			const result = await abortable(
				handle.read(buffer, offset, buffer.length - offset, offset),
				signal,
			);
			if (result.bytesRead === 0) break;
			offset += result.bytesRead;
		}
		if (offset > MAX_STAMP_SETTINGS_BYTES) {
			throw new Error(`settings file exceeds ${MAX_STAMP_SETTINGS_BYTES} bytes`);
		}
		return buffer.subarray(0, offset).toString("utf8");
	} finally {
		const closing = handle.close();
		if (signal?.aborted) void closing.catch(() => undefined);
		else await closing;
	}
}

function abortable<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
	if (!signal) return operation;
	if (signal.aborted) return Promise.reject(signal.reason);
	return new Promise((resolve, reject) => {
		const onAbort = () => reject(signal.reason);
		signal.addEventListener("abort", onAbort, { once: true });
		void operation.then(
			(value) => {
				signal.removeEventListener("abort", onAbort);
				resolve(value);
			},
			(error: unknown) => {
				signal.removeEventListener("abort", onAbort);
				reject(error);
			},
		);
	});
}

function invalidLoad(path: string, reason: string): StampSettingsLoadResult {
	return {
		kind: "invalid",
		path,
		settings: { ...DEFAULT_STAMP_SETTINGS },
		sources: builtInSources(),
		issue: { kind: "invalid", message: `${STAMP_SETTINGS_FILE} ignored (${path}: ${reason})` },
	};
}

function builtInSources(): Record<StampSettingsField, StampSettingsSource> {
	return {
		hourCycle: "built-in",
		showSeconds: "built-in",
		dateContext: "built-in",
		locale: "built-in",
		timeZone: "built-in",
		responseTiming: "built-in",
		assistantMetadata: "built-in",
		showExactTimeline: "built-in",
		showThinkingLevel: "built-in",
		showCompactAbnormalOutcome: "built-in",
		showCostSinceUser: "built-in",
		toolStamps: "built-in",
	};
}

function freezeState(state: StampSettingsState): Readonly<StampSettingsState> {
	return Object.freeze({
		...state,
		settings: Object.freeze({ ...state.settings }),
		sources: Object.freeze({ ...state.sources }),
	});
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
	return error instanceof Error && "code" in error;
}

function formatError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
