import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export const SETTINGS_FILE = "pi-image-drop.json";
const MIB = 1024 * 1024;

export interface ImageDropSettings {
	maxImages: number;
	maxImageBytes: number;
	maxBatchBytes: number;
	maxImagePixels: number;
}

export const DEFAULT_SETTINGS: Readonly<ImageDropSettings> = Object.freeze({
	maxImages: 8,
	maxImageBytes: 10 * MIB,
	maxBatchBytes: 40 * MIB,
	maxImagePixels: 50_000_000,
});

export const HARD_LIMITS: Readonly<ImageDropSettings> = Object.freeze({
	maxImages: 32,
	maxImageBytes: 50 * MIB,
	maxBatchBytes: 200 * MIB,
	maxImagePixels: 100_000_000,
});

const SETTING_KEYS = new Set<keyof ImageDropSettings>([
	"maxImages",
	"maxImageBytes",
	"maxBatchBytes",
	"maxImagePixels",
]);

export type SettingsLoadResult =
	| { kind: "missing"; settings: ImageDropSettings }
	| { kind: "loaded"; settings: ImageDropSettings; warning?: string }
	| { kind: "invalid"; settings: ImageDropSettings; warning: string };

export function normalizeSettings(value: unknown): ImageDropSettings | undefined {
	if (!isRecord(value) || Object.keys(value).some((key) => !SETTING_KEYS.has(key as never))) {
		return undefined;
	}
	const settings: ImageDropSettings = { ...DEFAULT_SETTINGS };
	for (const key of SETTING_KEYS) {
		if (!Object.hasOwn(value, key)) continue;
		const candidate = Reflect.get(value, key);
		if (
			typeof candidate !== "number" ||
			!Number.isSafeInteger(candidate) ||
			candidate <= 0 ||
			candidate > HARD_LIMITS[key]
		) {
			return undefined;
		}
		settings[key] = candidate;
	}
	if (settings.maxImageBytes > settings.maxBatchBytes) return undefined;
	return settings;
}

export async function loadSettings(
	path = join(getAgentDir(), SETTINGS_FILE),
): Promise<SettingsLoadResult> {
	let text: string;
	try {
		const stats = await lstat(path);
		if (stats.isSymbolicLink()) return invalid(path, "symbolic links are not accepted");
		if (!stats.isFile()) return invalid(path, "settings path is not a regular file");
		text = await readFile(path, "utf8");
	} catch (error) {
		if (isNodeError(error) && error.code === "ENOENT") {
			return { kind: "missing", settings: { ...DEFAULT_SETTINGS } };
		}
		return invalid(path, formatError(error));
	}

	try {
		const settings = normalizeSettings(JSON.parse(text) as unknown);
		if (!settings) return invalid(path, "invalid settings shape or value");
		const raised = (Object.keys(DEFAULT_SETTINGS) as Array<keyof ImageDropSettings>).filter(
			(key) => settings[key] > DEFAULT_SETTINGS[key],
		);
		return {
			kind: "loaded",
			settings,
			warning:
				raised.length > 0
					? `${SETTINGS_FILE} raises ${raised.join(", ")} above the safe defaults; large provider requests may fail.`
					: undefined,
		};
	} catch (error) {
		return invalid(path, formatError(error));
	}
}

function invalid(path: string, reason: string): SettingsLoadResult {
	return {
		kind: "invalid",
		settings: { ...DEFAULT_SETTINGS },
		warning: `${SETTINGS_FILE} ignored (${path}: ${reason}); using safe defaults.`,
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
	return error instanceof Error && "code" in error;
}

function formatError(error: unknown) {
	return error instanceof Error ? error.message : String(error);
}
