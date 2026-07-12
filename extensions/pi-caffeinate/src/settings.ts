import { constants } from "node:fs";
import { access, link, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import process from "node:process";

const NEW_SETTINGS_FILE = "pi-caffeinate.json";
const LEGACY_SETTINGS_FILE = "pi-caffeinate-settings.json";

export type CaffeinateMode = "sleep" | "display";

export interface CaffeinateSettings {
	mode: CaffeinateMode;
	quiet: boolean;
	updatedAt: number;
}

export type SettingsLoadResult =
	| { kind: "missing"; notice?: string }
	| { kind: "invalid"; reason: string; notice?: string }
	| { kind: "loaded"; settings: CaffeinateSettings; notice?: string };

type SettingsMigrationResult = {
	kind: "migrated" | "failed";
	notice: string;
};

export async function loadSettings(): Promise<SettingsLoadResult> {
	const newPath = settingsFilePath();
	const newSettings = await readSettingsFile(newPath);
	if (newSettings.kind !== "missing") return withLegacyIgnoredNotice(newSettings);

	const legacyPath = legacySettingsFilePath();
	const legacySettings = await readSettingsFile(legacyPath);
	const concurrentlyCreatedSettings = await readSettingsFile(newPath);
	if (concurrentlyCreatedSettings.kind !== "missing") {
		return withLegacyIgnoredNotice(concurrentlyCreatedSettings);
	}
	if (legacySettings.kind === "missing") return { kind: "missing" };
	if (legacySettings.kind === "invalid") return legacySettings;

	const migration = await migrateLegacySettings(legacyPath);
	if (migration.kind === "failed") {
		const settingsCreatedDuringMigration = await readSettingsFile(newPath);
		if (settingsCreatedDuringMigration.kind !== "missing") {
			return withLegacyIgnoredNotice(settingsCreatedDuringMigration);
		}
	}
	return { ...legacySettings, notice: migration.notice };
}

async function readSettingsFile(filePath: string): Promise<SettingsLoadResult> {
	let text: string;
	try {
		text = await readFile(filePath, "utf8");
	} catch (error) {
		if (isNodeError(error) && error.code === "ENOENT") return { kind: "missing" };
		return { kind: "invalid", reason: `${filePath}: ${formatError(error)}` };
	}
	try {
		const settings = normalizeCaffeinateSettings(JSON.parse(text) as unknown);
		if (settings) return { kind: "loaded", settings };
		return {
			kind: "invalid",
			reason: `${filePath}: expected { "mode": "sleep" | "display", optional "quiet": boolean }`,
		};
	} catch (error) {
		return { kind: "invalid", reason: `${filePath}: ${formatError(error)}` };
	}
}

async function withLegacyIgnoredNotice(settings: SettingsLoadResult): Promise<SettingsLoadResult> {
	if (!(await fileExists(legacySettingsFilePath()))) return settings;
	return {
		...settings,
		notice: `pi-caffeinate legacy settings ignored: ${legacySettingsFilePath()} exists, but ${settingsFilePath()} takes precedence. Delete ${LEGACY_SETTINGS_FILE} after confirming your settings.`,
	};
}

async function migrateLegacySettings(legacyPath: string): Promise<SettingsMigrationResult> {
	const newPath = settingsFilePath();
	try {
		await link(legacyPath, newPath);
	} catch (error) {
		return {
			kind: "failed",
			notice: `pi-caffeinate legacy settings migration failed: could not migrate ${legacyPath} to ${newPath}: ${formatError(error)}. The legacy file was used for this session; future saves will write ${NEW_SETTINGS_FILE}.`,
		};
	}
	try {
		await rm(legacyPath, { force: true });
	} catch (error) {
		return {
			kind: "migrated",
			notice: `pi-caffeinate settings migrated from ${legacyPath} to ${newPath}, but the legacy file could not be removed: ${formatError(error)}. Delete ${LEGACY_SETTINGS_FILE} after confirming your settings.`,
		};
	}
	return {
		kind: "migrated",
		notice: `pi-caffeinate settings migrated from ${legacyPath} to ${newPath}. ${LEGACY_SETTINGS_FILE} is deprecated and will be removed in a future major release.`,
	};
}

async function fileExists(filePath: string) {
	try {
		await access(filePath, constants.F_OK);
		return true;
	} catch {
		return false;
	}
}

export function normalizeCaffeinateSettings(value: unknown): CaffeinateSettings | undefined {
	if (!value || typeof value !== "object") return undefined;
	const settings = value as { mode?: unknown; quiet?: unknown; updatedAt?: unknown };
	if (!isCaffeinateMode(settings.mode)) return undefined;
	if (settings.quiet !== undefined && typeof settings.quiet !== "boolean") return undefined;
	if (settings.updatedAt !== undefined && typeof settings.updatedAt !== "number") return undefined;
	return { mode: settings.mode, quiet: settings.quiet ?? false, updatedAt: settings.updatedAt ?? 0 };
}

function isCaffeinateMode(value: unknown): value is CaffeinateMode {
	return value === "sleep" || value === "display";
}

export async function saveSettings(settings: CaffeinateSettings) {
	const filePath = settingsFilePath();
	await mkdir(dirname(filePath), { recursive: true });
	const tempFile = `${filePath}.${process.pid}.${Date.now()}.tmp`;
	try {
		await writeFile(tempFile, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
		await rename(tempFile, filePath);
	} catch (error) {
		await rm(tempFile, { force: true }).catch(() => undefined);
		throw error;
	}
}

export function settingsFilePath() {
	return join(agentDir(), NEW_SETTINGS_FILE);
}

function legacySettingsFilePath() {
	return join(agentDir(), LEGACY_SETTINGS_FILE);
}

function agentDir() {
	return process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
	return error instanceof Error && "code" in error;
}

function formatError(error: unknown) {
	return error instanceof Error ? error.message : String(error);
}
