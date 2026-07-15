import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export const GOAL_SETTINGS_FILE = "pi-goal.json";
export const GOAL_TOOL_VISIBILITIES = ["always", "after-first-goal"] as const;

export type GoalToolVisibility = (typeof GOAL_TOOL_VISIBILITIES)[number];

export interface GoalSettings {
	toolVisibility: GoalToolVisibility;
}

export const DEFAULT_GOAL_SETTINGS: GoalSettings = { toolVisibility: "always" };

export type GoalSettingsLoadResult =
	| { kind: "missing" }
	| { kind: "invalid"; reason: string }
	| { kind: "loaded"; settings: GoalSettings };

export function normalizeGoalSettings(value: unknown): GoalSettings | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	const toolVisibility = Object.hasOwn(value, "toolVisibility")
		? Reflect.get(value, "toolVisibility")
		: DEFAULT_GOAL_SETTINGS.toolVisibility;
	if (!GOAL_TOOL_VISIBILITIES.includes(toolVisibility as GoalToolVisibility)) return undefined;
	return { toolVisibility: toolVisibility as GoalToolVisibility };
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

function formatError(error: unknown) {
	return error instanceof Error ? error.message : String(error);
}
