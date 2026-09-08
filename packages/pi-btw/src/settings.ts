import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import {
	BTW_SHORTCUT_ACTIONS,
	type BtwKeybindingOverrides,
	normalizeBtwKey,
} from "./keybindings.js";
import { BTW_THINKING_LEVELS, type BtwThinkingLevel } from "./side-thread.js";

export const BTW_SETTINGS_FILE = "pi-btw.json";
export const DEFAULT_FULLSCREEN_COPY_ON_SELECT = true;
export const DEFAULT_REMEMBER_THINKING_LEVEL_CHANGES = true;
const MAX_SETTINGS_BYTES = 64 * 1024;

export interface BtwSettings {
	keybindings?: BtwKeybindingOverrides;
	model?: string;
	thinkingLevel?: BtwThinkingLevel;
	rememberThinkingLevelChanges?: boolean;
	fullscreenCopyOnSelect?: boolean;
}

export type BtwSettingsLoadResult =
	| { kind: "missing" }
	| { kind: "invalid"; reason: string }
	| { kind: "loaded"; settings: BtwSettings };

export interface BtwSettingsPatch {
	keybindings?: BtwKeybindingOverrides;
	thinkingLevel?: BtwThinkingLevel;
	rememberThinkingLevelChanges?: boolean;
	fullscreenCopyOnSelect?: boolean;
}

export interface UpdateBtwSettingsOptions {
	/** Validate against the latest document inside the mutation queue, before applying the patch. */
	validateCurrent?: (settings: BtwSettings) => void;
	settingsPath?: string;
	signal?: AbortSignal;
	beforeRename?: (temporaryPath: string, settingsPath: string) => Promise<void>;
}

type SettingsDocument = Record<string, unknown>;

const mutationQueues = new Map<string, Promise<void>>();

export function btwSettingsPath(): string {
	return join(getAgentDir(), BTW_SETTINGS_FILE);
}

export function normalizeBtwSettings(value: unknown): BtwSettings | undefined {
	if (!isSettingsDocument(value)) return undefined;

	const settings: BtwSettings = {};
	if (Object.hasOwn(value, "keybindings")) {
		const keys = value.keybindings;
		if (!isSettingsDocument(keys)) return undefined;
		settings.keybindings = {};
		for (const action of BTW_SHORTCUT_ACTIONS) {
			if (!Object.hasOwn(keys, action)) continue;
			const key = normalizeBtwKey(keys[action]);
			if (!key) return undefined;
			settings.keybindings[action] = key;
		}
	}
	if (Object.hasOwn(value, "model")) {
		const model = Reflect.get(value, "model");
		if (typeof model !== "string" || !parseBtwModelReference(model)) return undefined;
		settings.model = model;
	}
	if (Object.hasOwn(value, "thinkingLevel")) {
		const thinkingLevel = Reflect.get(value, "thinkingLevel");
		if (!isBtwThinkingLevel(thinkingLevel)) return undefined;
		settings.thinkingLevel = thinkingLevel;
	}
	if (Object.hasOwn(value, "rememberThinkingLevelChanges")) {
		const remember = Reflect.get(value, "rememberThinkingLevelChanges");
		if (typeof remember !== "boolean") return undefined;
		settings.rememberThinkingLevelChanges = remember;
	}
	if (Object.hasOwn(value, "fullscreenCopyOnSelect")) {
		const copyOnSelect = Reflect.get(value, "fullscreenCopyOnSelect");
		if (typeof copyOnSelect !== "boolean") return undefined;
		settings.fullscreenCopyOnSelect = copyOnSelect;
	}
	return settings;
}

export function parseBtwModelReference(
	reference: string,
): { provider: string; modelId: string } | undefined {
	if (/[\s\p{Cc}]/u.test(reference)) return undefined;
	const separator = reference.indexOf("/");
	if (separator <= 0 || separator === reference.length - 1) return undefined;
	return { provider: reference.slice(0, separator), modelId: reference.slice(separator + 1) };
}

export function effectiveFullscreenCopyOnSelect(settings: BtwSettings): boolean {
	return settings.fullscreenCopyOnSelect ?? DEFAULT_FULLSCREEN_COPY_ON_SELECT;
}

export function effectiveRememberThinkingLevelChanges(settings: BtwSettings): boolean {
	return settings.rememberThinkingLevelChanges ?? DEFAULT_REMEMBER_THINKING_LEVEL_CHANGES;
}

export async function readBtwSettings(
	settingsPath = btwSettingsPath(),
): Promise<BtwSettingsLoadResult> {
	await awaitBtwSettingsWrites(settingsPath);
	return readBtwSettingsUncoordinated(settingsPath);
}

export function updateBtwSettings(
	patch: BtwSettingsPatch,
	options: UpdateBtwSettingsOptions = {},
): Promise<BtwSettings> {
	const settingsPath = options.settingsPath ?? btwSettingsPath();
	return enqueueMutation(settingsPath, async () => {
		options.signal?.throwIfAborted();
		const current = await readSettingsDocumentForUpdate(settingsPath);
		options.signal?.throwIfAborted();
		options.validateCurrent?.(normalizeBtwSettings(current) ?? {});
		const updated = applyBtwSettingsPatch(current, patch);
		const settings = normalizeBtwSettings(updated);
		if (!settings) throw invalidSettingsError(settingsPath, "invalid settings shape");
		await publishSettings(settingsPath, updated, options.signal, options.beforeRename);
		return settings;
	});
}

export async function awaitBtwSettingsWrites(settingsPath = btwSettingsPath()): Promise<void> {
	await mutationQueues.get(settingsPath);
}

function enqueueMutation<T>(settingsPath: string, mutation: () => Promise<T>): Promise<T> {
	const previous = mutationQueues.get(settingsPath) ?? Promise.resolve();
	const result = previous.then(mutation, mutation);
	const settled = result.then(
		() => undefined,
		() => undefined,
	);
	mutationQueues.set(settingsPath, settled);
	void settled.finally(() => {
		if (mutationQueues.get(settingsPath) === settled) mutationQueues.delete(settingsPath);
	});
	return result;
}

async function readBtwSettingsUncoordinated(settingsPath: string): Promise<BtwSettingsLoadResult> {
	let contents: string;
	try {
		contents = await readSettingsContents(settingsPath);
	} catch (error: unknown) {
		if (isNodeError(error) && error.code === "ENOENT") return { kind: "missing" };
		return { kind: "invalid", reason: `${settingsPath}: ${formatError(error)}` };
	}

	try {
		const settings = normalizeBtwSettings(JSON.parse(contents) as unknown);
		return settings
			? { kind: "loaded", settings }
			: { kind: "invalid", reason: `${settingsPath}: invalid settings shape` };
	} catch {
		return { kind: "invalid", reason: `${settingsPath}: invalid JSON` };
	}
}

async function readSettingsDocumentForUpdate(settingsPath: string): Promise<SettingsDocument> {
	let contents: string;
	try {
		contents = await readSettingsContents(settingsPath);
	} catch (error: unknown) {
		if (isNodeError(error) && error.code === "ENOENT") return {};
		throw invalidSettingsError(settingsPath, formatError(error));
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(contents) as unknown;
	} catch {
		throw invalidSettingsError(settingsPath, "invalid JSON");
	}
	if (!isSettingsDocument(parsed) || !normalizeBtwSettings(parsed)) {
		throw invalidSettingsError(settingsPath, "invalid settings shape");
	}
	return parsed;
}

async function readSettingsContents(settingsPath: string): Promise<string> {
	const flags = constants.O_RDONLY | (constants.O_NONBLOCK ?? 0);
	const handle = await open(settingsPath, flags);
	try {
		const descriptorStats = await handle.stat();
		if (!descriptorStats.isFile()) throw new Error("settings path is not a regular file");
		if (descriptorStats.size > MAX_SETTINGS_BYTES) {
			throw new Error(`settings file exceeds ${MAX_SETTINGS_BYTES} bytes`);
		}

		const buffer = Buffer.alloc(MAX_SETTINGS_BYTES + 1);
		let offset = 0;
		while (offset < buffer.byteLength) {
			const { bytesRead } = await handle.read(buffer, offset, buffer.byteLength - offset, offset);
			if (bytesRead === 0) break;
			offset += bytesRead;
		}
		if (offset > MAX_SETTINGS_BYTES) {
			throw new Error(`settings file exceeds ${MAX_SETTINGS_BYTES} bytes`);
		}
		try {
			return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
				buffer.subarray(0, offset),
			);
		} catch {
			throw new Error("settings file is not valid UTF-8");
		}
	} finally {
		await handle.close();
	}
}

async function publishSettings(
	settingsPath: string,
	document: SettingsDocument,
	signal?: AbortSignal,
	beforeRename?: (temporaryPath: string, settingsPath: string) => Promise<void>,
): Promise<void> {
	signal?.throwIfAborted();
	const contents = `${JSON.stringify(document, null, 2)}\n`;
	if (Buffer.byteLength(contents, "utf8") > MAX_SETTINGS_BYTES) {
		throw new Error(`settings document exceeds ${MAX_SETTINGS_BYTES} bytes`);
	}
	const directory = dirname(settingsPath);
	await mkdir(directory, { recursive: true });
	signal?.throwIfAborted();
	const temporaryPath = join(
		directory,
		`.${basename(settingsPath)}.${process.pid}.${randomUUID()}.tmp`,
	);
	try {
		await writeFile(temporaryPath, contents, {
			encoding: "utf8",
			flag: "wx",
			mode: 0o600,
			signal,
		});
		await beforeRename?.(temporaryPath, settingsPath);
		signal?.throwIfAborted();
		await rename(temporaryPath, settingsPath);
	} catch (error) {
		await rm(temporaryPath, { force: true }).catch(() => undefined);
		throw error;
	}
}

function applyBtwSettingsPatch(
	current: SettingsDocument,
	patch: BtwSettingsPatch,
): SettingsDocument {
	const updated: SettingsDocument = { ...current };
	if (patch.keybindings) {
		const keys = isSettingsDocument(current.keybindings) ? { ...current.keybindings } : {};
		for (const action of BTW_SHORTCUT_ACTIONS) {
			if (!Object.hasOwn(patch.keybindings, action)) continue;
			if (patch.keybindings[action] === undefined) delete keys[action];
			else keys[action] = patch.keybindings[action];
		}
		if (Object.keys(keys).length) updated.keybindings = keys;
		else delete updated.keybindings;
	}
	if (Object.hasOwn(patch, "thinkingLevel")) {
		if (patch.thinkingLevel === undefined) delete updated.thinkingLevel;
		else updated.thinkingLevel = patch.thinkingLevel;
	}
	if (Object.hasOwn(patch, "rememberThinkingLevelChanges")) {
		updated.rememberThinkingLevelChanges = patch.rememberThinkingLevelChanges;
	}
	if (Object.hasOwn(patch, "fullscreenCopyOnSelect")) {
		if (patch.fullscreenCopyOnSelect === undefined) delete updated.fullscreenCopyOnSelect;
		else updated.fullscreenCopyOnSelect = patch.fullscreenCopyOnSelect;
	}
	return updated;
}

function isSettingsDocument(value: unknown): value is SettingsDocument {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isBtwThinkingLevel(value: unknown): value is BtwThinkingLevel {
	return BTW_THINKING_LEVELS.includes(value as BtwThinkingLevel);
}

function invalidSettingsError(settingsPath: string, reason: string): Error {
	return new Error(`pi-btw settings at ${settingsPath} are invalid: ${reason}`);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
	return error instanceof Error && "code" in error;
}

function formatError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
