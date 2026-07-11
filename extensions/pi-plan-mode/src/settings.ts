import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export const PLAN_MODE_SETTINGS_FILE = "pi-plan-mode.json";
export const PLAN_MODE_THINKING_LEVELS = [
	"inherit",
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
] as const;

export type PlanModeThinkingLevel = (typeof PLAN_MODE_THINKING_LEVELS)[number];
export type PlanModeFixedThinkingLevel = Exclude<PlanModeThinkingLevel, "inherit">;
export interface PlanModeSettings {
	thinkingLevel: PlanModeThinkingLevel;
}
export type PlanModeSettingsLoadResult =
	| { kind: "missing" }
	| { kind: "invalid"; reason: string }
	| { kind: "loaded"; settings: PlanModeSettings };

export function normalizePlanModeSettings(value: unknown): PlanModeSettings | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	const thinkingLevel = Object.hasOwn(value, "thinkingLevel")
		? Reflect.get(value, "thinkingLevel")
		: "inherit";
	return PLAN_MODE_THINKING_LEVELS.includes(thinkingLevel as PlanModeThinkingLevel)
		? { thinkingLevel: thinkingLevel as PlanModeThinkingLevel }
		: undefined;
}

export async function readPlanModeSettings(
	settingsPath = join(getAgentDir(), PLAN_MODE_SETTINGS_FILE),
): Promise<PlanModeSettingsLoadResult> {
	let contents: string;
	try {
		contents = await readFile(settingsPath, "utf8");
	} catch (error: unknown) {
		if (isNodeError(error) && error.code === "ENOENT") return { kind: "missing" };
		return { kind: "invalid", reason: formatError(error) };
	}
	try {
		const settings = normalizePlanModeSettings(JSON.parse(contents) as unknown);
		return settings
			? { kind: "loaded", settings }
			: { kind: "invalid", reason: "invalid settings shape" };
	} catch (error: unknown) {
		return { kind: "invalid", reason: formatError(error) };
	}
}

export function configuredThinkingLevel(
	settings: PlanModeSettings,
): PlanModeFixedThinkingLevel | undefined {
	return settings.thinkingLevel === "inherit" ? undefined : settings.thinkingLevel;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
	return error instanceof Error && "code" in error;
}

function formatError(error: unknown) {
	return error instanceof Error ? error.message : String(error);
}
