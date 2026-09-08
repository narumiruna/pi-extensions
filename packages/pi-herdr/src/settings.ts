import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export const HERDR_SETTINGS_FILE = "pi-herdr.json";
const MAX_SETTINGS_BYTES = 64 * 1024;

export interface HerdrSettings {
	widget: boolean;
}

export type HerdrSettingsLoadResult =
	| { kind: "missing"; settings: HerdrSettings }
	| { kind: "invalid"; reason: string; settings: HerdrSettings }
	| { kind: "loaded"; settings: HerdrSettings };

export interface UpdateHerdrSettingsOptions {
	settingsPath?: string;
	beforeRename?: (temporaryPath: string, settingsPath: string) => Promise<void>;
}

type SettingsDocument = Record<string, unknown>;
const DEFAULT_SETTINGS: HerdrSettings = { widget: true };
const queues = new Map<string, Promise<void>>();

export function herdrSettingsPath(): string {
	return join(getAgentDir(), HERDR_SETTINGS_FILE);
}

export function normalizeHerdrSettings(value: unknown): HerdrSettings | undefined {
	if (!isRecord(value)) return undefined;
	if (Object.hasOwn(value, "widget") && typeof value.widget !== "boolean") {
		return undefined;
	}
	return {
		widget: typeof value.widget === "boolean" ? value.widget : DEFAULT_SETTINGS.widget,
	};
}

export function readHerdrSettings(
	settingsPath = herdrSettingsPath(),
): Promise<HerdrSettingsLoadResult> {
	return enqueue(settingsPath, async () => {
		let document: SettingsDocument;
		try {
			document = await readSettingsDocument(settingsPath);
		} catch (error) {
			if (isNodeError(error) && error.code === "ENOENT") {
				return { kind: "missing", settings: { ...DEFAULT_SETTINGS } };
			}
			return {
				kind: "invalid",
				reason: `${settingsPath}: ${safeError(error)}`,
				settings: { ...DEFAULT_SETTINGS },
			};
		}
		const settings = normalizeHerdrSettings(document);
		return settings
			? { kind: "loaded", settings }
			: {
					kind: "invalid",
					reason: `${settingsPath}: invalid settings shape`,
					settings: { ...DEFAULT_SETTINGS },
				};
	});
}

export function updateHerdrSettings(
	patch: Partial<HerdrSettings>,
	options: UpdateHerdrSettingsOptions = {},
): Promise<HerdrSettings> {
	const settingsPath = options.settingsPath ?? herdrSettingsPath();
	return enqueue(settingsPath, async () => {
		const current = await readDocumentForUpdate(settingsPath);
		const updated = { ...current, ...patch };
		const settings = normalizeHerdrSettings(updated);
		if (!settings) throw new Error(`Pi Herdr settings at ${settingsPath} have an invalid shape.`);
		await publishSettings(settingsPath, updated, options);
		return settings;
	});
}

export async function awaitHerdrSettingsWrites(settingsPath = herdrSettingsPath()): Promise<void> {
	await queues.get(settingsPath);
}

function enqueue<T>(path: string, operation: () => Promise<T>): Promise<T> {
	const previous = queues.get(path) ?? Promise.resolve();
	const result = previous.then(operation, operation);
	const settled = result.then(
		() => undefined,
		() => undefined,
	);
	queues.set(path, settled);
	void settled.finally(() => {
		if (queues.get(path) === settled) queues.delete(path);
	});
	return result;
}

async function readDocumentForUpdate(path: string): Promise<SettingsDocument> {
	try {
		const document = await readSettingsDocument(path);
		if (!normalizeHerdrSettings(document)) throw new Error("invalid settings shape");
		return document;
	} catch (error) {
		if (isNodeError(error) && error.code === "ENOENT") return {};
		throw new Error(`Pi Herdr settings at ${path} are invalid: ${safeError(error)}`);
	}
}

async function readSettingsDocument(path: string): Promise<SettingsDocument> {
	const pathStats = await lstat(path);
	if (pathStats.isSymbolicLink() || !pathStats.isFile()) {
		throw new Error("settings path is not a regular file");
	}
	if (pathStats.size > MAX_SETTINGS_BYTES) {
		throw new Error(`settings file exceeds ${MAX_SETTINGS_BYTES} bytes`);
	}
	const noFollow = constants.O_NOFOLLOW ?? 0;
	const handle = await open(path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0) | noFollow);
	try {
		const stats = await handle.stat();
		if (!stats.isFile() || stats.dev !== pathStats.dev || stats.ino !== pathStats.ino) {
			throw new Error("settings path changed while opening");
		}
		const buffer = Buffer.alloc(MAX_SETTINGS_BYTES + 1);
		let offset = 0;
		while (offset < buffer.length) {
			const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
			if (bytesRead === 0) break;
			offset += bytesRead;
		}
		if (offset > MAX_SETTINGS_BYTES) {
			throw new Error(`settings file exceeds ${MAX_SETTINGS_BYTES} bytes`);
		}
		let contents: string;
		try {
			contents = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
				buffer.subarray(0, offset),
			);
		} catch {
			throw new Error("settings file is not valid UTF-8");
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(contents) as unknown;
		} catch {
			throw new Error("invalid JSON");
		}
		if (!isRecord(parsed)) throw new Error("settings document must be a JSON object");
		return parsed;
	} finally {
		await handle.close();
	}
}

async function publishSettings(
	path: string,
	document: SettingsDocument,
	options: UpdateHerdrSettingsOptions,
): Promise<void> {
	const contents = `${JSON.stringify(document, null, 2)}\n`;
	if (Buffer.byteLength(contents) > MAX_SETTINGS_BYTES) {
		throw new Error(`Pi Herdr settings document exceeds ${MAX_SETTINGS_BYTES} bytes.`);
	}
	const directory = dirname(path);
	await mkdir(directory, { recursive: true });
	const temporaryPath = join(directory, `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
	try {
		await writeFile(temporaryPath, contents, { encoding: "utf8", flag: "wx", mode: 0o600 });
		await options.beforeRename?.(temporaryPath, path);
		await rename(temporaryPath, path);
	} catch (error) {
		await rm(temporaryPath, { force: true }).catch(() => undefined);
		throw error;
	}
}

function isRecord(value: unknown): value is SettingsDocument {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
	return error instanceof Error && "code" in error;
}

function safeError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
