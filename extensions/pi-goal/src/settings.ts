import { randomUUID } from "node:crypto";
import { linkSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export const GOAL_SETTINGS_FILE = "pi-goal.json";
export const GOAL_TOOL_VISIBILITIES = ["always", "after-first-goal"] as const;

export type GoalToolVisibility = (typeof GOAL_TOOL_VISIBILITIES)[number];
export type ContinuationLimit = number | null;

export interface GoalSettings {
	toolVisibility: GoalToolVisibility;
	experimental: {
		goals: boolean;
	};
	continuationLimits: {
		automaticTurns: ContinuationLimit;
		noProgressTurns: ContinuationLimit;
	};
}

export const DEFAULT_GOAL_SETTINGS: GoalSettings = {
	toolVisibility: "always",
	experimental: { goals: false },
	continuationLimits: { automaticTurns: 25, noProgressTurns: 3 },
};

export const DEFAULT_GOAL_SETTINGS_DOCUMENT = `${JSON.stringify(DEFAULT_GOAL_SETTINGS, null, 2)}\n`;

export type GoalSettingsLoadResult =
	| { kind: "missing" }
	| { kind: "invalid"; reason: string }
	| { kind: "loaded"; settings: GoalSettings };

export type GoalSettingsInitializationResult =
	| Exclude<GoalSettingsLoadResult, { kind: "missing" }>
	| { kind: "create-failed"; reason: string };

interface GoalSettingsInitializationFileSystem {
	mkdirSync: typeof mkdirSync;
	writeFileSync: typeof writeFileSync;
	linkSync: typeof linkSync;
	rmSync: typeof rmSync;
}

export function normalizeGoalSettings(value: unknown): GoalSettings | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	const toolVisibility = Object.hasOwn(value, "toolVisibility")
		? Reflect.get(value, "toolVisibility")
		: DEFAULT_GOAL_SETTINGS.toolVisibility;
	if (!GOAL_TOOL_VISIBILITIES.includes(toolVisibility as GoalToolVisibility)) return undefined;

	const experimentalValue = Object.hasOwn(value, "experimental")
		? Reflect.get(value, "experimental")
		: undefined;
	if (
		experimentalValue !== undefined &&
		(typeof experimentalValue !== "object" ||
			experimentalValue === null ||
			Array.isArray(experimentalValue))
	) {
		return undefined;
	}
	const goals =
		experimentalValue && Object.hasOwn(experimentalValue, "goals")
			? Reflect.get(experimentalValue, "goals")
			: DEFAULT_GOAL_SETTINGS.experimental.goals;
	if (typeof goals !== "boolean") return undefined;

	const continuationLimitsValue = Object.hasOwn(value, "continuationLimits")
		? Reflect.get(value, "continuationLimits")
		: undefined;
	if (
		continuationLimitsValue !== undefined &&
		(typeof continuationLimitsValue !== "object" ||
			continuationLimitsValue === null ||
			Array.isArray(continuationLimitsValue))
	) {
		return undefined;
	}
	const automaticTurns = continuationLimitsValue
		? normalizeContinuationLimit(
				Reflect.get(continuationLimitsValue, "automaticTurns"),
				DEFAULT_GOAL_SETTINGS.continuationLimits.automaticTurns,
			)
		: DEFAULT_GOAL_SETTINGS.continuationLimits.automaticTurns;
	const noProgressTurns = continuationLimitsValue
		? normalizeContinuationLimit(
				Reflect.get(continuationLimitsValue, "noProgressTurns"),
				DEFAULT_GOAL_SETTINGS.continuationLimits.noProgressTurns,
			)
		: DEFAULT_GOAL_SETTINGS.continuationLimits.noProgressTurns;
	if (automaticTurns === undefined || noProgressTurns === undefined) return undefined;

	return {
		toolVisibility: toolVisibility as GoalToolVisibility,
		experimental: { goals },
		continuationLimits: { automaticTurns, noProgressTurns },
	};
}

function normalizeContinuationLimit(
	value: unknown,
	fallback: ContinuationLimit,
): ContinuationLimit | undefined {
	if (value === undefined) return fallback;
	if (value === null) return null;
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

export function loadOrCreateGoalSettings(
	settingsPath = join(getAgentDir(), GOAL_SETTINGS_FILE),
	overrides: Partial<GoalSettingsInitializationFileSystem> = {},
): GoalSettingsInitializationResult {
	const loaded = readGoalSettings(settingsPath);
	if (loaded.kind !== "missing") return loaded;

	const fs = { mkdirSync, writeFileSync, linkSync, rmSync, ...overrides };
	const temporaryPath = join(
		dirname(settingsPath),
		`.${basename(settingsPath)}.${randomUUID()}.tmp`,
	);
	try {
		fs.mkdirSync(dirname(settingsPath), { recursive: true });
		fs.writeFileSync(temporaryPath, DEFAULT_GOAL_SETTINGS_DOCUMENT, {
			encoding: "utf8",
			flag: "wx",
		});
		try {
			fs.linkSync(temporaryPath, settingsPath);
		} catch (error) {
			if (!isAlreadyExistsError(error)) throw error;
		}

		const published = readGoalSettings(settingsPath);
		return published.kind === "missing"
			? {
					kind: "create-failed",
					reason: `${settingsPath}: settings file disappeared during initialization`,
				}
			: published;
	} catch (error) {
		return {
			kind: "create-failed",
			reason: `${settingsPath}: ${formatError(error)}`,
		};
	} finally {
		try {
			fs.rmSync(temporaryPath, { force: true });
		} catch {
			// Best-effort cleanup must not replace the initialization result.
		}
	}
}

export function readGoalSettings(
	settingsPath = join(getAgentDir(), GOAL_SETTINGS_FILE),
): GoalSettingsLoadResult {
	let contents: string;
	try {
		contents = readFileSync(settingsPath, "utf8");
	} catch (error: unknown) {
		if (isNodeError(error) && error.code === "ENOENT") return { kind: "missing" };
		return { kind: "invalid", reason: `${settingsPath}: ${formatError(error)}` };
	}

	try {
		const settings = normalizeGoalSettings(JSON.parse(contents) as unknown);
		return settings
			? { kind: "loaded", settings }
			: { kind: "invalid", reason: `${settingsPath}: invalid settings shape` };
	} catch (error: unknown) {
		return { kind: "invalid", reason: `${settingsPath}: ${formatError(error)}` };
	}
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
	return error instanceof Error && "code" in error;
}

function isAlreadyExistsError(error: unknown): boolean {
	return isNodeError(error) && error.code === "EEXIST";
}

function formatError(error: unknown) {
	return error instanceof Error ? error.message : String(error);
}
