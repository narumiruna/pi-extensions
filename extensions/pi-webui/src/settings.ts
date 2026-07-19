import {
	link as linkFile,
	lstat,
	mkdir,
	readFile,
	rename,
	unlink,
	writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export const SETTINGS_FILE = "pi-webui.json";

export interface WebUISettings {
	startOnSessionStart: boolean;
}

export const DEFAULT_SETTINGS: Readonly<WebUISettings> = Object.freeze({
	startOnSessionStart: false,
});

export interface SettingsLoadResult {
	kind: "missing" | "loaded" | "invalid";
	path: string;
	settings: WebUISettings;
	source: "defaults" | "settings file";
	document?: Record<string, unknown>;
	warning?: string;
}

export interface SettingsFileOperations {
	write(path: string, data: string): Promise<void>;
	rename(source: string, destination: string): Promise<void>;
	link(source: string, destination: string): Promise<void>;
}

const DEFAULT_FILE_OPERATIONS: SettingsFileOperations = {
	write: (path, data) =>
		writeFile(path, data, { encoding: "utf8", flag: "wx", mode: 0o600 }).then(() => undefined),
	rename,
	link: linkFile,
};

export function settingsFilePath(): string {
	return join(getAgentDir(), SETTINGS_FILE);
}

export function normalizeSettings(value: unknown): WebUISettings | undefined {
	if (!isRecord(value)) return undefined;
	if (
		Object.hasOwn(value, "startOnSessionStart") &&
		typeof value.startOnSessionStart !== "boolean"
	) {
		return undefined;
	}
	return {
		startOnSessionStart:
			typeof value.startOnSessionStart === "boolean"
				? value.startOnSessionStart
				: DEFAULT_SETTINGS.startOnSessionStart,
	};
}

export async function loadSettings(path = settingsFilePath()): Promise<SettingsLoadResult> {
	let text: string;
	try {
		const stats = await lstat(path);
		if (stats.isSymbolicLink()) return invalid(path, "symbolic links are not accepted");
		if (!stats.isFile()) return invalid(path, "settings path is not a regular file");
		text = await readFile(path, "utf8");
	} catch (error) {
		if (isNodeError(error) && error.code === "ENOENT") {
			return {
				kind: "missing",
				path,
				settings: { ...DEFAULT_SETTINGS },
				source: "defaults",
				document: {},
			};
		}
		return invalid(path, formatError(error));
	}

	try {
		const document = JSON.parse(text) as unknown;
		if (!isRecord(document)) return invalid(path, "the top level must be a JSON object");
		const settings = normalizeSettings(document);
		if (!settings) return invalid(path, "startOnSessionStart must be a boolean");
		return { kind: "loaded", path, settings, source: "settings file", document };
	} catch (error) {
		return invalid(path, formatError(error));
	}
}

export async function saveSettings(
	settings: WebUISettings,
	document: Record<string, unknown>,
	path = settingsFilePath(),
	operations: Partial<SettingsFileOperations> = {},
): Promise<Record<string, unknown>> {
	const nextDocument = { ...document, startOnSessionStart: settings.startOnSessionStart };
	const directory = dirname(path);
	await mkdir(directory, { recursive: true });
	const temporaryPath = temporaryFilePath(path);
	try {
		await (operations.write ?? DEFAULT_FILE_OPERATIONS.write)(
			temporaryPath,
			`${JSON.stringify(nextDocument, null, 2)}\n`,
		);
		await (operations.rename ?? DEFAULT_FILE_OPERATIONS.rename)(temporaryPath, path);
		return nextDocument;
	} catch (error) {
		await unlink(temporaryPath).catch(() => undefined);
		throw error;
	}
}

export async function initializeSettings(
	path = settingsFilePath(),
	operations: Partial<SettingsFileOperations> = {},
): Promise<"created" | "exists"> {
	try {
		await lstat(path);
		return "exists";
	} catch (error) {
		if (!isNodeError(error) || error.code !== "ENOENT") throw error;
	}

	const directory = dirname(path);
	await mkdir(directory, { recursive: true });
	const temporaryPath = temporaryFilePath(path);
	try {
		await (operations.write ?? DEFAULT_FILE_OPERATIONS.write)(
			temporaryPath,
			`${JSON.stringify(DEFAULT_SETTINGS, null, 2)}\n`,
		);
		try {
			await (operations.link ?? DEFAULT_FILE_OPERATIONS.link)(temporaryPath, path);
		} catch (error) {
			if (isNodeError(error) && error.code === "EEXIST") return "exists";
			throw error;
		}
		return "created";
	} finally {
		await unlink(temporaryPath).catch(() => undefined);
	}
}

function invalid(path: string, reason: string): SettingsLoadResult {
	return {
		kind: "invalid",
		path,
		settings: { ...DEFAULT_SETTINGS },
		source: "defaults",
		warning: `${SETTINGS_FILE} ignored (${path}: ${reason}); using defaults without overwriting it.`,
	};
}

function temporaryFilePath(path: string): string {
	return `${path}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
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
