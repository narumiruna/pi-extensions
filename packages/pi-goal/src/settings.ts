import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
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
	rpc: {
		enabled: boolean;
	};
	continuationLimits: {
		automaticTurns: ContinuationLimit;
		noProgressTurns: ContinuationLimit;
		minIntervalMs: number;
	};
}

export const DEFAULT_GOAL_SETTINGS: GoalSettings = {
	toolVisibility: "always",
	experimental: { goals: false },
	rpc: { enabled: false },
	continuationLimits: { automaticTurns: 25, noProgressTurns: 3, minIntervalMs: 0 },
};

export type GoalSettingsLoadResult =
	| { kind: "missing" }
	| { kind: "invalid"; reason: string }
	| { kind: "loaded"; settings: GoalSettings };

export type GoalSettingsLoadIssue = Extract<GoalSettingsLoadResult, { kind: "invalid" }>;

interface GoalSettingsSaveFileSystem {
	mkdirSync: typeof mkdirSync;
	writeFileSync: typeof writeFileSync;
	renameSync: typeof renameSync;
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

	const rpcValue = Object.hasOwn(value, "rpc") ? Reflect.get(value, "rpc") : undefined;
	if (
		rpcValue !== undefined &&
		(typeof rpcValue !== "object" || rpcValue === null || Array.isArray(rpcValue))
	) {
		return undefined;
	}
	const rpcEnabled =
		rpcValue && Object.hasOwn(rpcValue, "enabled")
			? Reflect.get(rpcValue, "enabled")
			: DEFAULT_GOAL_SETTINGS.rpc.enabled;
	if (typeof rpcEnabled !== "boolean") return undefined;

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
	const minIntervalMs = continuationLimitsValue
		? normalizeNonNegativeSafeInteger(
				Reflect.get(continuationLimitsValue, "minIntervalMs"),
				DEFAULT_GOAL_SETTINGS.continuationLimits.minIntervalMs,
			)
		: DEFAULT_GOAL_SETTINGS.continuationLimits.minIntervalMs;
	if (
		automaticTurns === undefined ||
		noProgressTurns === undefined ||
		minIntervalMs === undefined
	) {
		return undefined;
	}

	return {
		toolVisibility: toolVisibility as GoalToolVisibility,
		experimental: { goals },
		rpc: { enabled: rpcEnabled },
		continuationLimits: { automaticTurns, noProgressTurns, minIntervalMs },
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

function normalizeNonNegativeSafeInteger(value: unknown, fallback: number) {
	if (value === undefined) return fallback;
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
		? value
		: undefined;
}

export function saveGoalSettings(
	settings: GoalSettings,
	settingsPath = join(getAgentDir(), GOAL_SETTINGS_FILE),
	overrides: Partial<GoalSettingsSaveFileSystem> = {},
) {
	const normalized = normalizeGoalSettings(settings);
	if (!normalized) throw new Error("Refusing to save invalid pi-goal settings.");

	let raw: Record<string, unknown> = {};
	try {
		const contents = readFileSync(settingsPath, "utf8");
		const parsed = JSON.parse(contents) as unknown;
		if (!normalizeGoalSettings(parsed)) {
			throw new Error(`${settingsPath}: invalid settings shape`);
		}
		raw = ownRecord(parsed) ?? {};
	} catch (error) {
		if (!isNodeError(error) || error.code !== "ENOENT") {
			throw new Error(`Cannot save invalid settings file: ${formatError(error)}`);
		}
	}

	const experimental = ownRecord(raw.experimental) ?? {};
	const rpc = ownRecord(raw.rpc) ?? {};
	const continuationLimits = ownRecord(raw.continuationLimits) ?? {};
	const document = `${JSON.stringify(
		{
			...raw,
			toolVisibility: normalized.toolVisibility,
			experimental: { ...experimental, goals: normalized.experimental.goals },
			rpc: { ...rpc, enabled: normalized.rpc.enabled },
			continuationLimits: {
				...continuationLimits,
				automaticTurns: normalized.continuationLimits.automaticTurns,
				noProgressTurns: normalized.continuationLimits.noProgressTurns,
				minIntervalMs: normalized.continuationLimits.minIntervalMs,
			},
		},
		null,
		2,
	)}\n`;
	const fs = { mkdirSync, writeFileSync, renameSync, rmSync, ...overrides };
	const temporaryPath = join(
		dirname(settingsPath),
		`.${basename(settingsPath)}.${randomUUID()}.tmp`,
	);
	try {
		fs.mkdirSync(dirname(settingsPath), { recursive: true });
		fs.writeFileSync(temporaryPath, document, { encoding: "utf8", flag: "wx" });
		fs.renameSync(temporaryPath, settingsPath);
	} finally {
		try {
			fs.rmSync(temporaryPath, { force: true });
		} catch {
			// Best-effort cleanup must not replace the save result.
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

function ownRecord(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
	return error instanceof Error && "code" in error;
}

function formatError(error: unknown) {
	return error instanceof Error ? error.message : String(error);
}
