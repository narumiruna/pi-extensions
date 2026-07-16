import { randomUUID } from "node:crypto";
import { access, link, lstat, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export const PLAN_MODE_SETTINGS_FILE = "pi-plan-mode.json";
const LEGACY_PLAN_MODE_SETTINGS_FILE = "plan-mode.json";
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

export type PlanModeThinkingLevel = (typeof PLAN_MODE_THINKING_LEVELS)[number];
export type PlanModeFixedThinkingLevel = Exclude<PlanModeThinkingLevel, "inherit">;
export interface PlanModeSettings {
	thinkingLevel: PlanModeThinkingLevel;
	defaultPlanTools?: string[];
}
export type PlanModeSettingsLoadResult =
	| { kind: "missing"; notice?: string }
	| { kind: "invalid"; reason: string; notice?: string }
	| { kind: "loaded"; settings: PlanModeSettings; notice?: string };

export function normalizePlanModeSettings(value: unknown): PlanModeSettings | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	const thinkingLevel = Object.hasOwn(value, "thinkingLevel")
		? Reflect.get(value, "thinkingLevel")
		: "inherit";
	if (!PLAN_MODE_THINKING_LEVELS.includes(thinkingLevel as PlanModeThinkingLevel)) {
		return undefined;
	}
	if (!Object.hasOwn(value, "defaultPlanTools")) {
		return { thinkingLevel: thinkingLevel as PlanModeThinkingLevel };
	}
	const defaultPlanTools = normalizeToolNames(Reflect.get(value, "defaultPlanTools"));
	return defaultPlanTools
		? { thinkingLevel: thinkingLevel as PlanModeThinkingLevel, defaultPlanTools }
		: undefined;
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

export async function readPlanModeSettings(
	settingsPath?: string,
): Promise<PlanModeSettingsLoadResult> {
	if (settingsPath) return readSettingsFile(settingsPath);
	const canonicalPath = join(getAgentDir(), PLAN_MODE_SETTINGS_FILE);
	const canonical = await readSettingsFile(canonicalPath);
	const legacyPath = join(getAgentDir(), LEGACY_PLAN_MODE_SETTINGS_FILE);
	if (canonical.kind !== "missing") {
		return (await exists(legacyPath))
			? {
					...canonical,
					notice: `${LEGACY_PLAN_MODE_SETTINGS_FILE} ignored because ${PLAN_MODE_SETTINGS_FILE} takes precedence.`,
				}
			: canonical;
	}

	const legacySnapshot = await readSettingsSnapshot(legacyPath);
	const legacy = legacySnapshot.result;
	const raced = await readSettingsFile(canonicalPath);
	if (raced.kind !== "missing") return raced;
	if (legacy.kind !== "loaded") return legacy;
	let installedIdentity: FileIdentity;
	try {
		installedIdentity = await installFileExclusively(canonicalPath, legacySnapshot.contents ?? "");
	} catch (error) {
		const created = await readSettingsFile(canonicalPath);
		if (created.kind !== "missing") {
			return {
				...created,
				notice: `${LEGACY_PLAN_MODE_SETTINGS_FILE} ignored because ${PLAN_MODE_SETTINGS_FILE} was created concurrently.`,
			};
		}
		return {
			...legacy,
			notice: `Plan-mode settings migration failed: ${formatError(error)}. The legacy file was used for this session.`,
		};
	}
	if (!(await fileContentsEqual(legacyPath, legacySnapshot.contents ?? ""))) {
		const removed = await removeFileIfIdentityMatches(
			canonicalPath,
			installedIdentity,
			legacySnapshot.contents ?? "",
		);
		return {
			...legacy,
			notice: removed
				? `${LEGACY_PLAN_MODE_SETTINGS_FILE} changed during migration; the stale ${PLAN_MODE_SETTINGS_FILE} snapshot was removed.`
				: `${LEGACY_PLAN_MODE_SETTINGS_FILE} changed during migration, but ${PLAN_MODE_SETTINGS_FILE} was replaced concurrently and takes precedence on the next load.`,
		};
	}
	try {
		await rm(legacyPath);
		return {
			...legacy,
			notice: `Plan-mode settings migrated from ${LEGACY_PLAN_MODE_SETTINGS_FILE} to ${PLAN_MODE_SETTINGS_FILE}.`,
		};
	} catch (error) {
		return {
			...legacy,
			notice: `Plan-mode settings migrated to ${PLAN_MODE_SETTINGS_FILE}, but ${LEGACY_PLAN_MODE_SETTINGS_FILE} could not be removed: ${formatError(error)}.`,
		};
	}
}

type FileIdentity = { dev: number; ino: number };

async function installFileExclusively(filePath: string, contents: string): Promise<FileIdentity> {
	const tempFile = join(dirname(filePath), `.${PLAN_MODE_SETTINGS_FILE}.${randomUUID()}.tmp`);
	try {
		await writeFile(tempFile, contents, { encoding: "utf8", flag: "wx" });
		const identity = await lstat(tempFile);
		await link(tempFile, filePath);
		return { dev: identity.dev, ino: identity.ino };
	} finally {
		await rm(tempFile, { force: true }).catch(() => undefined);
	}
}

async function removeFileIfIdentityMatches(
	filePath: string,
	expected: FileIdentity,
	expectedContents: string,
) {
	try {
		const current = await lstat(filePath);
		if (current.dev !== expected.dev || current.ino !== expected.ino) return false;
		if ((await readFile(filePath, "utf8")) !== expectedContents) return false;
		await rm(filePath);
		return true;
	} catch {
		return false;
	}
}

async function readSettingsFile(settingsPath: string): Promise<PlanModeSettingsLoadResult> {
	return (await readSettingsSnapshot(settingsPath)).result;
}

async function readSettingsSnapshot(settingsPath: string): Promise<{
	result: PlanModeSettingsLoadResult;
	contents?: string;
}> {
	let contents: string;
	try {
		contents = await readFile(settingsPath, "utf8");
	} catch (error: unknown) {
		if (isNodeError(error) && error.code === "ENOENT") return { result: { kind: "missing" } };
		return { result: { kind: "invalid", reason: formatError(error) } };
	}
	try {
		const settings = normalizePlanModeSettings(JSON.parse(contents) as unknown);
		return {
			contents,
			result: settings
				? { kind: "loaded", settings }
				: { kind: "invalid", reason: "invalid settings shape" },
		};
	} catch (error: unknown) {
		return { contents, result: { kind: "invalid", reason: formatError(error) } };
	}
}

export function configuredThinkingLevel(
	settings: PlanModeSettings,
): PlanModeFixedThinkingLevel | undefined {
	return settings.thinkingLevel === "inherit" ? undefined : settings.thinkingLevel;
}

async function fileContentsEqual(path: string, expected: string) {
	try {
		return (await readFile(path, "utf8")) === expected;
	} catch {
		return false;
	}
}

async function exists(path: string) {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
	return error instanceof Error && "code" in error;
}

function formatError(error: unknown) {
	return error instanceof Error ? error.message : String(error);
}
