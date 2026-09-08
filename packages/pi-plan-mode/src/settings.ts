import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { KeyId } from "@earendil-works/pi-tui";
import type { SafeSubcommands } from "./tool-policy.js";

export const PLAN_MODE_SETTINGS_FILE = "pi-plan-mode.json";
const LEGACY_PLAN_MODE_SETTINGS_FILE = "plan-mode.json";
const MAX_SETTINGS_BYTES = 64 * 1024;
export const PLAN_MODE_THINKING_LEVELS = [
	"inherit",
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
] as const;
export const IMPLEMENTATION_PLAN_RETENTIONS = [
	"clear-on-start",
	"clear-after-first-run",
	"keep",
] as const;
export const DEFAULT_PLAN_EXPORT_PATH = "PLAN.md";
const MODIFIERS = new Set(["ctrl", "shift", "alt", "super"]);
const BASE_KEYS = new Set([
	..."abcdefghijklmnopqrstuvwxyz0123456789",
	"`",
	"-",
	"=",
	"[",
	"]",
	"\\",
	";",
	"'",
	",",
	".",
	"/",
	"!",
	"@",
	"#",
	"$",
	"%",
	"^",
	"&",
	"*",
	"(",
	")",
	"_",
	"+",
	"|",
	"~",
	"{",
	"}",
	":",
	"<",
	">",
	"?",
	"escape",
	"esc",
	"enter",
	"return",
	"tab",
	"space",
	"backspace",
	"delete",
	"insert",
	"clear",
	"home",
	"end",
	"pageup",
	"pagedown",
	"up",
	"down",
	"left",
	"right",
	...Array.from({ length: 12 }, (_unused, index) => `f${index + 1}`),
]);
const MAX_PLAN_EXPORT_PATH_LENGTH = 4096;

export type PlanModeThinkingLevel = (typeof PLAN_MODE_THINKING_LEVELS)[number];
export type ImplementationPlanRetention = (typeof IMPLEMENTATION_PLAN_RETENTIONS)[number];
export type PlanModeFixedThinkingLevel = Exclude<PlanModeThinkingLevel, "inherit">;
export interface PlanModeSettings {
	thinkingLevel: PlanModeThinkingLevel;
	defaultPlanTools?: string[];
	implementationPlanRetention?: ImplementationPlanRetention;
	defaultPlanExportPath?: string;
	safeSubcommands?: SafeSubcommands;
	toggleShortcut?: KeyId;
}
export interface PlanModeSettingsPatch {
	thinkingLevel?: PlanModeThinkingLevel;
	defaultPlanTools?: readonly string[] | null;
	implementationPlanRetention?: ImplementationPlanRetention;
	defaultPlanExportPath?: string | null;
	toggleShortcut?: KeyId | null;
}
export interface UpdatePlanModeSettingsOptions {
	settingsPath?: string;
	legacySettingsPath?: string;
	signal?: AbortSignal;
	beforeRename?: (temporaryPath: string, settingsPath: string) => Promise<void>;
}
export type PlanModeSettingsLoadResult =
	| { kind: "missing"; notice?: string }
	| { kind: "invalid"; reason: string; notice?: string }
	| { kind: "loaded"; settings: PlanModeSettings; notice?: string };

type SettingsDocument = Record<string, unknown>;
type SettingsSnapshot = {
	result: PlanModeSettingsLoadResult;
	document?: SettingsDocument;
};

const mutationQueues = new Map<string, Promise<void>>();

export function planModeSettingsPath() {
	return join(getAgentDir(), PLAN_MODE_SETTINGS_FILE);
}

function legacyPlanModeSettingsPath() {
	return join(getAgentDir(), LEGACY_PLAN_MODE_SETTINGS_FILE);
}

export function normalizePlanModeSettings(value: unknown): PlanModeSettings | undefined {
	if (!isSettingsDocument(value)) return undefined;
	const thinkingLevel = Object.hasOwn(value, "thinkingLevel")
		? Reflect.get(value, "thinkingLevel")
		: "inherit";
	if (!PLAN_MODE_THINKING_LEVELS.includes(thinkingLevel as PlanModeThinkingLevel)) {
		return undefined;
	}
	const settings: PlanModeSettings = {
		thinkingLevel: thinkingLevel as PlanModeThinkingLevel,
	};
	if (Object.hasOwn(value, "defaultPlanTools")) {
		const defaultPlanTools = normalizeToolNames(Reflect.get(value, "defaultPlanTools"));
		if (!defaultPlanTools) return undefined;
		settings.defaultPlanTools = defaultPlanTools;
	}
	if (Object.hasOwn(value, "implementationPlanRetention")) {
		const implementationPlanRetention = Reflect.get(value, "implementationPlanRetention");
		if (
			!IMPLEMENTATION_PLAN_RETENTIONS.includes(
				implementationPlanRetention as ImplementationPlanRetention,
			)
		) {
			return undefined;
		}
		settings.implementationPlanRetention =
			implementationPlanRetention as ImplementationPlanRetention;
	}
	if (Object.hasOwn(value, "defaultPlanExportPath")) {
		const defaultPlanExportPath = normalizePlanExportPath(
			Reflect.get(value, "defaultPlanExportPath"),
		);
		if (!defaultPlanExportPath) return undefined;
		settings.defaultPlanExportPath = defaultPlanExportPath;
	}
	if (Object.hasOwn(value, "toggleShortcut")) {
		const toggleShortcut = normalizeKeyId(Reflect.get(value, "toggleShortcut"));
		if (!toggleShortcut) return undefined;
		settings.toggleShortcut = toggleShortcut;
	}
	if (Object.hasOwn(value, "safeSubcommands")) {
		const safeSubcommands = normalizeSafeSubcommands(Reflect.get(value, "safeSubcommands"));
		if (!safeSubcommands) return undefined;
		settings.safeSubcommands = safeSubcommands;
	}
	return settings;
}

function normalizeToolNames(value: unknown) {
	if (
		!Array.isArray(value) ||
		!value.every((item): item is string => typeof item === "string" && item.trim().length > 0)
	) {
		return undefined;
	}
	return Array.from(new Set(value));
}

function normalizePlanExportPath(value: unknown) {
	if (typeof value !== "string") return undefined;
	const normalized = value.trim();
	if (
		!normalized ||
		normalized.length > MAX_PLAN_EXPORT_PATH_LENGTH ||
		!/[^@\s]/u.test(normalized) ||
		[...normalized].some((character) => {
			const codePoint = character.codePointAt(0) ?? 0;
			return codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f);
		})
	) {
		return undefined;
	}
	return normalized;
}

export function normalizeKeyId(value: unknown): KeyId | undefined {
	if (typeof value !== "string") return undefined;
	const normalized = value.trim().toLowerCase();
	const base = [...BASE_KEYS]
		.sort((left, right) => right.length - left.length)
		.find((candidate) => normalized === candidate || normalized.endsWith(`+${candidate}`));
	if (!base) return undefined;
	const prefix = normalized.slice(0, normalized.length - base.length);
	if (!prefix) return base as KeyId;
	if (/^f(?:[1-9]|1[0-2])$/.test(base) || !prefix.endsWith("+")) return undefined;
	const modifiers = prefix.slice(0, -1).split("+");
	if (
		modifiers.length === 0 ||
		modifiers.some((modifier) => !MODIFIERS.has(modifier)) ||
		new Set(modifiers).size !== modifiers.length
	) {
		return undefined;
	}
	return normalized as KeyId;
}

function normalizeSafeSubcommands(value: unknown): SafeSubcommands | undefined {
	if (!isSettingsDocument(value)) return undefined;
	const entries: Array<[string, string[]]> = [];
	for (const [command, subcommands] of Object.entries(value)) {
		const normalizedCommand = command.trim();
		if (
			!normalizedCommand ||
			!Array.isArray(subcommands) ||
			!subcommands.every(
				(item): item is string => typeof item === "string" && item.trim().length > 0,
			)
		) {
			return undefined;
		}
		const normalizedSubcommands = Array.from(
			new Set(subcommands.map((subcommand) => subcommand.trim())),
		);
		const existing = entries.find(([existingCommand]) => existingCommand === normalizedCommand);
		if (existing) existing[1] = Array.from(new Set([...existing[1], ...normalizedSubcommands]));
		else entries.push([normalizedCommand, normalizedSubcommands]);
	}
	return Object.fromEntries(entries);
}

export async function readPlanModeSettings(
	settingsPath?: string,
): Promise<PlanModeSettingsLoadResult> {
	if (settingsPath) {
		await awaitPlanModeSettingsWrites(settingsPath);
		return (await readSettingsSnapshot(settingsPath)).result;
	}
	const canonicalPath = planModeSettingsPath();
	await awaitPlanModeSettingsWrites(canonicalPath);
	const canonical = await readSettingsSnapshot(canonicalPath);
	const legacyPath = legacyPlanModeSettingsPath();
	if (canonical.result.kind !== "missing") {
		return (await pathExists(legacyPath))
			? {
					...canonical.result,
					notice: `${LEGACY_PLAN_MODE_SETTINGS_FILE} ignored because ${PLAN_MODE_SETTINGS_FILE} takes precedence.`,
				}
			: canonical.result;
	}

	const legacy = await readSettingsSnapshot(legacyPath);
	const raced = await readSettingsSnapshot(canonicalPath);
	if (raced.result.kind !== "missing") return raced.result;
	return legacy.result.kind === "loaded"
		? {
				...legacy.result,
				notice: `Using legacy ${LEGACY_PLAN_MODE_SETTINGS_FILE}; rename it to ${PLAN_MODE_SETTINGS_FILE}. The legacy file was not modified.`,
			}
		: legacy.result;
}

export function updatePlanModeSettings(
	patch: PlanModeSettingsPatch,
	options: UpdatePlanModeSettingsOptions = {},
): Promise<PlanModeSettings> {
	const settingsPath = options.settingsPath ?? planModeSettingsPath();
	const legacySettingsPath =
		options.legacySettingsPath ?? (options.settingsPath ? undefined : legacyPlanModeSettingsPath());
	return enqueueMutation(settingsPath, async () => {
		options.signal?.throwIfAborted();
		const current = await readSettingsDocumentForUpdate(settingsPath, legacySettingsPath);
		const updated: SettingsDocument = { ...current };
		if (patch.thinkingLevel !== undefined) updated.thinkingLevel = patch.thinkingLevel;
		if (patch.defaultPlanTools === null) delete updated.defaultPlanTools;
		else if (patch.defaultPlanTools !== undefined) {
			updated.defaultPlanTools = [...patch.defaultPlanTools];
		}
		if (patch.implementationPlanRetention !== undefined) {
			updated.implementationPlanRetention = patch.implementationPlanRetention;
		}
		if (patch.defaultPlanExportPath === null) delete updated.defaultPlanExportPath;
		else if (patch.defaultPlanExportPath !== undefined) {
			updated.defaultPlanExportPath = patch.defaultPlanExportPath;
		}
		if (patch.toggleShortcut === null) delete updated.toggleShortcut;
		else if (patch.toggleShortcut !== undefined) {
			updated.toggleShortcut = patch.toggleShortcut;
		}
		const settings = normalizePlanModeSettings(updated);
		if (!settings) throw invalidSettingsError(settingsPath, "invalid settings shape");
		await publishSettings(settingsPath, updated, options.signal, options.beforeRename);
		return settings;
	});
}

export async function awaitPlanModeSettingsWrites(
	settingsPath = planModeSettingsPath(),
): Promise<void> {
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

async function readSettingsDocumentForUpdate(
	settingsPath: string,
	legacySettingsPath: string | undefined,
): Promise<SettingsDocument> {
	const canonical = await readSettingsSnapshot(settingsPath);
	if (canonical.result.kind === "loaded") return canonical.document ?? {};
	if (canonical.result.kind === "invalid") {
		throw invalidSettingsError(settingsPath, canonical.result.reason);
	}
	if (!legacySettingsPath) return {};

	const legacy = await readSettingsSnapshot(legacySettingsPath);
	const raced = await readSettingsSnapshot(settingsPath);
	if (raced.result.kind === "loaded") return raced.document ?? {};
	if (raced.result.kind === "invalid") {
		throw invalidSettingsError(settingsPath, raced.result.reason);
	}
	if (legacy.result.kind === "invalid") {
		throw invalidSettingsError(legacySettingsPath, legacy.result.reason);
	}
	return legacy.document ?? {};
}

async function readSettingsSnapshot(settingsPath: string): Promise<SettingsSnapshot> {
	let contents: string;
	try {
		contents = await readSettingsContents(settingsPath);
	} catch (error: unknown) {
		if (isNodeError(error) && error.code === "ENOENT") return { result: { kind: "missing" } };
		return { result: { kind: "invalid", reason: safeReadError(error) } };
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(contents) as unknown;
	} catch {
		return { result: { kind: "invalid", reason: "invalid JSON" } };
	}
	const settings = normalizePlanModeSettings(parsed);
	if (!settings || !isSettingsDocument(parsed)) {
		return { result: { kind: "invalid", reason: "invalid settings shape" } };
	}
	return { document: parsed, result: { kind: "loaded", settings } };
}

async function readSettingsContents(settingsPath: string): Promise<string> {
	const flags = constants.O_RDONLY | (constants.O_NONBLOCK ?? 0) | (constants.O_NOFOLLOW ?? 0);
	const handle = await open(settingsPath, flags);
	try {
		const stats = await handle.stat();
		if (!stats.isFile()) throw new Error("settings path is not a regular file");
		if (stats.size > MAX_SETTINGS_BYTES) {
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
	} finally {
		await rm(temporaryPath, { force: true }).catch(() => undefined);
	}
}

function isSettingsDocument(value: unknown): value is SettingsDocument {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function pathExists(path: string) {
	try {
		const handle = await open(path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
		await handle.close();
		return true;
	} catch (error: unknown) {
		return !(isNodeError(error) && error.code === "ENOENT");
	}
}

function invalidSettingsError(settingsPath: string, reason: string) {
	return new Error(`pi-plan-mode settings at ${settingsPath} are invalid: ${reason}`);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
	return error instanceof Error && "code" in error;
}

function safeReadError(error: unknown) {
	if (isNodeError(error) && error.code === "ELOOP") return "settings path is not a regular file";
	return error instanceof Error ? error.message : String(error);
}

export function configuredThinkingLevel(
	settings: PlanModeSettings,
): PlanModeFixedThinkingLevel | undefined {
	return settings.thinkingLevel === "inherit" ? undefined : settings.thinkingLevel;
}

export function configuredImplementationPlanRetention(
	settings: PlanModeSettings,
): ImplementationPlanRetention {
	return settings.implementationPlanRetention ?? "clear-on-start";
}

export function configuredPlanExportPath(settings: PlanModeSettings) {
	return settings.defaultPlanExportPath ?? DEFAULT_PLAN_EXPORT_PATH;
}

export function configuredPlanModeToggleShortcut(settings: PlanModeSettings): KeyId | undefined {
	return settings.toggleShortcut;
}
