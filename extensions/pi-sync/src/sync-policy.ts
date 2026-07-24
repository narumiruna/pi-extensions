import path from "node:path";
import { isDeniedPath, toPosix } from "./paths.js";

export const DEFAULT_SYNC_FILES = [
	"settings.json",
	"keybindings.json",
	"models.json",
	"AGENTS.md",
	"APPEND_SYSTEM.md",
	"skills",
	"prompts",
	"themes",
	"extensions",
] as const;

export type BuiltInSyncFile = (typeof DEFAULT_SYNC_FILES)[number];

const BUILT_IN_BY_LOWER = new Map<string, BuiltInSyncFile>(
	DEFAULT_SYNC_FILES.map((fileName) => [fileName.toLowerCase(), fileName]),
);
const TOP_LEVEL_FILE_PATHS = new Map<string, string>(
	DEFAULT_SYNC_FILES.filter((fileName) => fileName.includes(".")).map((fileName) => [
		fileName.toLowerCase(),
		fileName,
	]),
);
const TOP_LEVEL_FILE_NAMES = new Set<string>(TOP_LEVEL_FILE_PATHS.keys());
const TOP_LEVEL_DIRS = new Set<string>(
	DEFAULT_SYNC_FILES.filter((fileName) => !fileName.includes(".")),
);
const RESERVED_TOP_LEVEL_NAMES = new Set<string>([...TOP_LEVEL_DIRS, "sessions"]);

export function normalizeSyncFiles(value: unknown): BuiltInSyncFile[] {
	if (value === undefined) return [...DEFAULT_SYNC_FILES];
	if (!Array.isArray(value)) throw new Error("syncFiles must be an array of built-in file names.");

	const result: BuiltInSyncFile[] = [];
	const seen = new Set<string>();
	for (const item of value) {
		if (typeof item !== "string") throw new Error("syncFiles items must be strings.");
		const canonical = BUILT_IN_BY_LOWER.get(item.trim().toLowerCase());
		if (!canonical) throw new Error(`Unknown syncFiles item: ${item}`);
		const lower = canonical.toLowerCase();
		if (seen.has(lower)) continue;
		seen.add(lower);
		result.push(canonical);
	}
	return result;
}

export function normalizeExtraFiles(value: unknown) {
	if (!Array.isArray(value)) return [];
	const seen = new Set<string>();
	return value
		.filter((item): item is string => typeof item === "string")
		.map((item) => item.trim())
		.filter((item) => {
			const lower = item.toLowerCase();
			if (
				item === "" ||
				item === "." ||
				item === ".." ||
				item.includes("/") ||
				item.includes("\\") ||
				TOP_LEVEL_FILE_NAMES.has(lower) ||
				isDeniedPath(item) ||
				RESERVED_TOP_LEVEL_NAMES.has(lower) ||
				seen.has(lower)
			) {
				return false;
			}
			seen.add(lower);
			return true;
		});
}

export function extraFilePathsByLower(value: unknown) {
	return new Map(normalizeExtraFiles(value).map((fileName) => [fileName.toLowerCase(), fileName]));
}

export function selectedSyncFileSet(value: unknown) {
	return new Set(normalizeSyncFiles(value));
}

export function isConfiguredSnapshotPath(
	relativePath: string,
	config: { syncFiles?: unknown; syncSessions: boolean },
	extraFiles: Set<string>,
) {
	const normalized = toPosix(relativePath);
	if (normalized.startsWith("sessions/")) return config.syncSessions;
	const selected = selectedSyncFileSet(config.syncFiles);
	if (!normalized.includes("/")) {
		const lower = normalized.toLowerCase();
		const builtIn = BUILT_IN_BY_LOWER.get(lower);
		return builtIn ? selected.has(builtIn) && !TOP_LEVEL_DIRS.has(builtIn) : extraFiles.has(lower);
	}
	const topLevel = normalized.slice(0, normalized.indexOf("/"));
	return selected.has(topLevel as BuiltInSyncFile) && TOP_LEVEL_DIRS.has(topLevel);
}

export function canonicalSnapshotPathForConfig(
	relativePath: string,
	extraFilePaths: Map<string, string>,
) {
	const normalized = toPosix(relativePath);
	if (normalized.includes("/")) return normalized;
	const lower = normalized.toLowerCase();
	return TOP_LEVEL_FILE_PATHS.get(lower) ?? extraFilePaths.get(lower) ?? normalized;
}

export function isPreservableUnmanagedSnapshotPath(relativePath: string) {
	const normalized = toPosix(relativePath);
	if (!normalized || isDeniedPath(normalized)) return false;
	if (normalized.startsWith("sessions/")) return normalized.endsWith(".jsonl");
	if (!normalized.includes("/")) {
		const lower = normalized.toLowerCase();
		return TOP_LEVEL_FILE_NAMES.has(lower) || !RESERVED_TOP_LEVEL_NAMES.has(lower);
	}
	return TOP_LEVEL_DIRS.has(normalized.slice(0, normalized.indexOf("/")));
}

export function isSafeExtraFileName(fileName: string) {
	return normalizeExtraFiles([fileName]).length === 1;
}

export function isBuiltInTopLevelFile(fileName: string) {
	return TOP_LEVEL_FILE_NAMES.has(path.posix.basename(fileName).toLowerCase());
}
