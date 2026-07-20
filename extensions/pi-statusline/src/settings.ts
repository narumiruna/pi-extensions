import { randomUUID } from "node:crypto";
import {
	linkSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import {
	DENSITIES,
	PALETTE_NAMES,
	SEGMENT_NAMES,
	SEPARATOR_NAMES,
	type SegmentName,
	type StatuslineConfig,
} from "./types.js";

export const SETTINGS_FILE_NAME = "pi-statusline.json";
const LEGACY_SETTINGS_FILE_NAME = "pi-statusline-settings.json";

export const DEFAULT_EXTENSION_STATUS_ICONS: Record<string, string> = {
	"chrome-devtools": "🌐",
	"codex-usage": "📊",
	caffeinate: "💊",
	firecrawl: "🔥",
	"github-pr": "🔎",
	goal: "🎯",
	lsp: "🧰",
	"plan-mode": "📝",
	pisync: "🔄",
	subagents: "🧑‍🤝‍🧑",
	"unknown-error-retry": "🔁",
};

const DEFAULT_SEGMENTS: SegmentName[] = [
	"brand",
	"provider",
	"model",
	"thinking",
	"cwd",
	"branch",
	"tools",
	"context",
	"tokens",
	"cost",
	"time",
];

export const DEFAULT_STATUSLINE_CONFIG: StatuslineConfig = {
	palette: "tokyo-night",
	density: "compact",
	separator: "none",
	segments: DEFAULT_SEGMENTS,
	segmentText: {
		brand: { prefix: "", suffix: "" },
		provider: { prefix: "🔌 ", suffix: "" },
		model: { prefix: "🤖 ", suffix: "" },
		thinking: { prefix: "🧠 ", suffix: "" },
		cwd: { prefix: "📁 ", suffix: "" },
		branch: { prefix: "🌿 ", suffix: "" },
		tools: { prefix: "", suffix: "" },
		context: { prefix: "🪟 ctx ", suffix: "" },
		tokens: { prefix: "🔢 ", suffix: "" },
		cost: { prefix: "💸 $", suffix: "" },
		time: { prefix: "🕒 ", suffix: "" },
		turn: { prefix: "🔁 #", suffix: "" },
	},
	extensionStatusIcons: DEFAULT_EXTENSION_STATUS_ICONS,
};

export const DEFAULT_STATUSLINE_DOCUMENT = `${JSON.stringify(DEFAULT_STATUSLINE_CONFIG, null, "\t")}\n`;

export interface StatuslineConfigDiagnostic {
	severity: "warning" | "error";
	code: "unknown" | "invalid" | "parse" | "io";
	path: string;
	message: string;
}

export interface LoadedStatuslineSettings {
	config: StatuslineConfig;
	source: "built-in" | "user";
	settingsPath: string;
	rawDocument?: string;
	diagnostics: StatuslineConfigDiagnostic[];
}

interface InitialFileSystem {
	mkdirSync: typeof mkdirSync;
	writeFileSync: typeof writeFileSync;
	linkSync: typeof linkSync;
	rmSync: typeof rmSync;
}

interface AtomicFileSystem {
	mkdirSync: typeof mkdirSync;
	writeFileSync: typeof writeFileSync;
	renameSync: typeof renameSync;
	rmSync: typeof rmSync;
}

let pendingSettingsNotice: string | undefined;

export function settingsFilePath(agentDir = getAgentDir()): string {
	return join(agentDir, SETTINGS_FILE_NAME);
}

export function createDefaultConfig(): StatuslineConfig {
	return cloneConfig(DEFAULT_STATUSLINE_CONFIG);
}

export function normalizeStatuslineConfig(value: unknown): {
	config: StatuslineConfig;
	diagnostics: StatuslineConfigDiagnostic[];
} {
	const config = createDefaultConfig();
	const diagnostics: StatuslineConfigDiagnostic[] = [];
	if (!isRecord(value)) {
		return {
			config,
			diagnostics: [invalidDiagnostic("", "Settings must contain a JSON object", "error")],
		};
	}

	const knownRoot = new Set([
		"palette",
		"density",
		"separator",
		"segments",
		"segmentText",
		"extensionStatusIcons",
	]);
	for (const key of Object.keys(value)) {
		if (!knownRoot.has(key)) diagnostics.push(unknownDiagnostic(key));
	}

	normalizeEnum(value, "palette", PALETTE_NAMES, config, diagnostics);
	normalizeEnum(value, "density", DENSITIES, config, diagnostics);
	normalizeEnum(value, "separator", SEPARATOR_NAMES, config, diagnostics);

	if (value.segments !== undefined) {
		if (!Array.isArray(value.segments)) {
			diagnostics.push(invalidDiagnostic("segments", "Expected an array of segment names"));
		} else {
			const segments: SegmentName[] = [];
			const seen = new Set<SegmentName>();
			for (const [index, item] of value.segments.entries()) {
				const path = `segments[${index}]`;
				if (typeof item !== "string" || !isSegmentName(item)) {
					diagnostics.push(invalidDiagnostic(path, "Unknown or non-string segment name"));
					continue;
				}
				if (seen.has(item)) {
					diagnostics.push(invalidDiagnostic(path, `Duplicate segment ${JSON.stringify(item)}`));
					continue;
				}
				seen.add(item);
				segments.push(item);
			}
			config.segments = segments;
		}
	}

	if (value.segmentText !== undefined) {
		if (!isRecord(value.segmentText)) {
			diagnostics.push(invalidDiagnostic("segmentText", "Expected an object"));
		} else {
			for (const [name, presentation] of Object.entries(value.segmentText)) {
				const path = `segmentText.${name}`;
				if (!isSegmentName(name)) {
					diagnostics.push(unknownDiagnostic(path));
					continue;
				}
				if (!isRecord(presentation)) {
					diagnostics.push(invalidDiagnostic(path, "Expected an object"));
					continue;
				}
				for (const key of Object.keys(presentation)) {
					if (key !== "prefix" && key !== "suffix") {
						diagnostics.push(unknownDiagnostic(`${path}.${key}`));
					}
				}
				for (const field of ["prefix", "suffix"] as const) {
					const fieldValue = presentation[field];
					if (fieldValue === undefined) continue;
					if (typeof fieldValue !== "string") {
						diagnostics.push(invalidDiagnostic(`${path}.${field}`, "Expected a string"));
						continue;
					}
					config.segmentText[name][field] = fieldValue;
				}
			}
		}
	}

	if (value.extensionStatusIcons !== undefined) {
		if (!isRecord(value.extensionStatusIcons)) {
			diagnostics.push(invalidDiagnostic("extensionStatusIcons", "Expected an object"));
		} else {
			for (const [key, icon] of Object.entries(value.extensionStatusIcons)) {
				if (typeof icon !== "string") {
					diagnostics.push(invalidDiagnostic(`extensionStatusIcons.${key}`, "Expected a string"));
					continue;
				}
				config.extensionStatusIcons[key] = icon;
			}
		}
	}

	return { config, diagnostics };
}

export function loadStatuslineSettings(settingsPath: string): LoadedStatuslineSettings {
	let rawDocument: string;
	try {
		rawDocument = readFileSync(settingsPath, "utf8");
	} catch (error) {
		if (!pathExists(settingsPath)) {
			return builtInSettings(settingsPath);
		}
		return builtInSettings(settingsPath, [
			diagnostic("error", "io", "", `Unable to read settings: ${formatError(error)}`),
		]);
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(rawDocument);
	} catch (error) {
		return {
			...builtInSettings(settingsPath, [
				diagnostic("error", "parse", "", `Unable to parse JSON: ${formatError(error)}`),
			]),
			rawDocument,
		};
	}
	const normalized = normalizeStatuslineConfig(parsed);
	return {
		config: normalized.config,
		source: normalized.diagnostics.some((item) => item.severity === "error") ? "built-in" : "user",
		settingsPath,
		rawDocument,
		diagnostics: normalized.diagnostics,
	};
}

export function loadOrCreateStatuslineSettings(
	agentDir = getAgentDir(),
	overrides: Partial<InitialFileSystem> = {},
): LoadedStatuslineSettings {
	pendingSettingsNotice = undefined;
	const canonicalPath = settingsFilePath(agentDir);
	const legacyPath = join(agentDir, LEGACY_SETTINGS_FILE_NAME);
	if (pathExists(canonicalPath)) {
		if (pathExists(legacyPath)) {
			pendingSettingsNotice = `${LEGACY_SETTINGS_FILE_NAME} ignored because ${SETTINGS_FILE_NAME} takes precedence.`;
		}
		return loadStatuslineSettings(canonicalPath);
	}
	if (pathExists(legacyPath)) return migrateLegacySettings(canonicalPath, legacyPath);
	return createInitialSettings(canonicalPath, overrides);
}

function createInitialSettings(
	canonicalPath: string,
	overrides: Partial<InitialFileSystem>,
): LoadedStatuslineSettings {
	const fs = { mkdirSync, writeFileSync, linkSync, rmSync, ...overrides };
	const temporaryPath = temporarySettingsPath(canonicalPath);
	try {
		fs.mkdirSync(dirname(canonicalPath), { recursive: true });
		fs.writeFileSync(temporaryPath, DEFAULT_STATUSLINE_DOCUMENT, {
			encoding: "utf8",
			flag: "wx",
		});
		try {
			fs.linkSync(temporaryPath, canonicalPath);
		} catch (error) {
			if (isAlreadyExistsError(error)) return loadStatuslineSettings(canonicalPath);
			throw error;
		}
		return loadStatuslineSettings(canonicalPath);
	} catch (error) {
		return builtInSettings(canonicalPath, [
			diagnostic("warning", "io", "", `Unable to create default settings: ${formatError(error)}`),
		]);
	} finally {
		removeTemporaryFile(fs.rmSync, temporaryPath);
	}
}

function migrateLegacySettings(
	canonicalPath: string,
	legacyPath: string,
): LoadedStatuslineSettings {
	const legacy = loadStatuslineSettings(legacyPath);
	if (legacy.source !== "user" || legacy.rawDocument === undefined) {
		pendingSettingsNotice = `${LEGACY_SETTINGS_FILE_NAME} is invalid and was ignored.`;
		return legacy;
	}
	let identity: FileIdentity;
	try {
		identity = installFileExclusively(canonicalPath, legacy.rawDocument);
	} catch (error) {
		if (pathExists(canonicalPath)) {
			pendingSettingsNotice = `${LEGACY_SETTINGS_FILE_NAME} ignored because ${SETTINGS_FILE_NAME} was created concurrently.`;
			return loadStatuslineSettings(canonicalPath);
		}
		pendingSettingsNotice = `Statusline settings migration failed: ${formatError(error)}. The legacy file was used for this session.`;
		return legacy;
	}
	if (!fileContentsEqual(legacyPath, legacy.rawDocument)) {
		pendingSettingsNotice = removeFileIfIdentityMatches(canonicalPath, identity, legacy.rawDocument)
			? `${LEGACY_SETTINGS_FILE_NAME} changed during migration; the stale ${SETTINGS_FILE_NAME} snapshot was removed.`
			: `${LEGACY_SETTINGS_FILE_NAME} changed during migration, but ${SETTINGS_FILE_NAME} was replaced concurrently and takes precedence on the next load.`;
		return legacy;
	}
	try {
		rmSync(legacyPath);
		pendingSettingsNotice = `Statusline settings migrated from ${LEGACY_SETTINGS_FILE_NAME} to ${SETTINGS_FILE_NAME}.`;
	} catch (error) {
		pendingSettingsNotice = `Statusline settings migrated to ${SETTINGS_FILE_NAME}, but ${LEGACY_SETTINGS_FILE_NAME} could not be removed: ${formatError(error)}.`;
	}
	return loadStatuslineSettings(canonicalPath);
}

export function saveStatuslineSettingsDocument(
	settingsPath: string,
	rawDocument: string,
	overrides: Partial<AtomicFileSystem> = {},
): LoadedStatuslineSettings {
	let parsed: unknown;
	try {
		parsed = JSON.parse(rawDocument);
	} catch (error) {
		throw new Error(`Unable to parse JSON: ${formatError(error)}`);
	}
	const normalized = normalizeStatuslineConfig(parsed);
	const blocking = normalized.diagnostics.filter((item) => item.code !== "unknown");
	if (blocking.length > 0) {
		throw new Error(blocking.map((item) => `${item.path || "root"}: ${item.message}`).join("\n"));
	}

	const fs = { mkdirSync, writeFileSync, renameSync, rmSync, ...overrides };
	const temporaryPath = temporarySettingsPath(settingsPath);
	try {
		fs.mkdirSync(dirname(settingsPath), { recursive: true });
		fs.writeFileSync(temporaryPath, rawDocument, { encoding: "utf8", flag: "wx" });
		fs.renameSync(temporaryPath, settingsPath);
	} finally {
		removeTemporaryFile(fs.rmSync, temporaryPath);
	}
	return {
		config: normalized.config,
		source: "user",
		settingsPath,
		rawDocument,
		diagnostics: normalized.diagnostics,
	};
}

export function consumeStatuslineSettingsNotice(): string | undefined {
	const notice = pendingSettingsNotice;
	pendingSettingsNotice = undefined;
	return notice;
}

export function readStatuslineSettings(settingsPath?: string): StatuslineConfig {
	return settingsPath
		? loadStatuslineSettings(settingsPath).config
		: loadOrCreateStatuslineSettings().config;
}

export function normalizeStatuslineSettings(value: unknown): StatuslineConfig {
	return normalizeStatuslineConfig(value).config;
}

function normalizeEnum<
	K extends "palette" | "density" | "separator",
	T extends StatuslineConfig[K],
>(
	value: Record<string, unknown>,
	field: K,
	accepted: readonly T[],
	config: StatuslineConfig,
	diagnostics: StatuslineConfigDiagnostic[],
) {
	const candidate = value[field];
	if (candidate === undefined) return;
	if (typeof candidate !== "string" || !accepted.includes(candidate as T)) {
		diagnostics.push(
			invalidDiagnostic(field, `Expected one of: ${accepted.map(String).join(", ")}`),
		);
		return;
	}
	config[field] = candidate as StatuslineConfig[K];
}

function cloneConfig(config: StatuslineConfig): StatuslineConfig {
	return {
		...config,
		segments: [...config.segments],
		segmentText: Object.fromEntries(
			SEGMENT_NAMES.map((name) => [name, { ...config.segmentText[name] }]),
		) as StatuslineConfig["segmentText"],
		extensionStatusIcons: { ...config.extensionStatusIcons },
	};
}

function builtInSettings(
	settingsPath: string,
	diagnostics: StatuslineConfigDiagnostic[] = [],
): LoadedStatuslineSettings {
	return {
		config: createDefaultConfig(),
		source: "built-in",
		settingsPath,
		diagnostics,
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSegmentName(value: string): value is SegmentName {
	return (SEGMENT_NAMES as readonly string[]).includes(value);
}

function unknownDiagnostic(path: string): StatuslineConfigDiagnostic {
	return diagnostic("warning", "unknown", path, `Unknown setting ${JSON.stringify(path)}`);
}

function invalidDiagnostic(
	path: string,
	message: string,
	severity: StatuslineConfigDiagnostic["severity"] = "warning",
): StatuslineConfigDiagnostic {
	return diagnostic(severity, "invalid", path, message);
}

function diagnostic(
	severity: StatuslineConfigDiagnostic["severity"],
	code: StatuslineConfigDiagnostic["code"],
	path: string,
	message: string,
): StatuslineConfigDiagnostic {
	return { severity, code, path, message };
}

function temporarySettingsPath(settingsPath: string): string {
	return join(dirname(settingsPath), `.${SETTINGS_FILE_NAME}.${randomUUID()}.tmp`);
}

function removeTemporaryFile(remove: typeof rmSync, temporaryPath: string) {
	try {
		remove(temporaryPath, { force: true });
	} catch {
		// Best-effort cleanup must not replace the original operation result.
	}
}

type FileIdentity = { dev: number; ino: number };

function installFileExclusively(filePath: string, contents: string): FileIdentity {
	mkdirSync(dirname(filePath), { recursive: true });
	const temporaryPath = temporarySettingsPath(filePath);
	try {
		writeFileSync(temporaryPath, contents, { encoding: "utf8", flag: "wx" });
		const identity = lstatSync(temporaryPath);
		linkSync(temporaryPath, filePath);
		return { dev: identity.dev, ino: identity.ino };
	} finally {
		removeTemporaryFile(rmSync, temporaryPath);
	}
}

function removeFileIfIdentityMatches(
	filePath: string,
	expected: FileIdentity,
	expectedContents: string,
): boolean {
	try {
		const current = lstatSync(filePath);
		if (current.dev !== expected.dev || current.ino !== expected.ino) return false;
		if (readFileSync(filePath, "utf8") !== expectedContents) return false;
		rmSync(filePath);
		return true;
	} catch {
		return false;
	}
}

function fileContentsEqual(path: string, expected: string): boolean {
	try {
		return readFileSync(path, "utf8") === expected;
	} catch {
		return false;
	}
}

function pathExists(path: string): boolean {
	try {
		lstatSync(path);
		return true;
	} catch {
		return false;
	}
}

function isAlreadyExistsError(error: unknown): boolean {
	return error instanceof Error && "code" in error && error.code === "EEXIST";
}

function formatError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
