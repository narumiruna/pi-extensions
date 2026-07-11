import { createHash, randomUUID } from "node:crypto";
import type { Dirent } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { agentDir, configuredSessionDir } from "./config.js";
import { isDeniedPath, posixJoin, safeJoin, toPosix } from "./paths.js";
export { isDeniedPath } from "./paths.js";
import type {
	Snapshot,
	SnapshotFile,
	SnapshotOptions,
	SyncConfig,
} from "./types.js";

const VERSION = 1;
const TOP_LEVEL_FILES = new Set(["settings.json", "keybindings.json", "models.json", "AGENTS.md", "APPEND_SYSTEM.md"]);
const TOP_LEVEL_DIRS = new Set(["skills", "prompts", "themes", "extensions"]);
const TOP_LEVEL_FILE_PATHS = new Map([...TOP_LEVEL_FILES].map((name) => [name.toLowerCase(), name]));
const TOP_LEVEL_FILE_NAMES = new Set(TOP_LEVEL_FILE_PATHS.keys());
const RESERVED_TOP_LEVEL_NAMES = new Set([...TOP_LEVEL_DIRS, "sessions"]);
const SECRET_PATTERNS = [
	/AWS_SECRET_ACCESS_KEY\s*[=:]\s*['"]?[A-Za-z0-9/+]{35,}/i,
	/(ANTHROPIC|OPENAI|GEMINI|GOOGLE|FIRECRAWL|GITHUB|CLOUDFLARE|R2|S3)_[A-Z0-9_]*(KEY|TOKEN|SECRET)\s*[=:]\s*['"]?[^\s'"]{12,}/i,
	/sk-ant-[A-Za-z0-9_-]{20,}/,
	/sk-[A-Za-z0-9]{20,}/,
	/gh[pousr]_[A-Za-z0-9_]{20,}/,
];

function expandHome(value: string) {
	if (value === "~") return process.env.HOME ?? value;
	if (value.startsWith("~/")) return path.join(process.env.HOME ?? "~", value.slice(2));
	return value;
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
				item === "" || item === "." || item === ".." || item.includes("/") || item.includes("\\") ||
				TOP_LEVEL_FILE_NAMES.has(lower) || isDeniedPath(item) || RESERVED_TOP_LEVEL_NAMES.has(lower) || seen.has(lower)
			) return false;
			seen.add(lower);
			return true;
		});
}

export function extraFilePathsByLower(value: unknown) {
	return new Map(normalizeExtraFiles(value).map((fileName) => [fileName.toLowerCase(), fileName]));
}

function selectTopLevelFileEntry(entries: Dirent[], fileName: string) {
	const exact = entries.find((entry) => entry.isFile() && entry.name === fileName);
	if (exact) return exact;
	const lower = fileName.toLowerCase();
	return entries
		.filter((entry) => entry.isFile() && entry.name.toLowerCase() === lower)
		.sort((left, right) => left.name.localeCompare(right.name))[0];
}

function sha256(value: Buffer) {
	return createHash("sha256").update(value).digest("hex");
}

function isSafeSnapshotPath(relativePath: string) {
	if (relativePath.includes("\\")) return false;
	const normalized = toPosix(relativePath);
	return Boolean(normalized) && normalized !== "." && normalized !== ".." && !normalized.startsWith("../") &&
		!path.posix.isAbsolute(normalized) && path.posix.normalize(normalized) === normalized && !isDeniedPath(normalized);
}

function snapshotsMatch(left: Snapshot, right: Snapshot) {
	const leftHashes = new Map(left.files.map((file) => [file.path, file.sha256]));
	const rightHashes = new Map(right.files.map((file) => [file.path, file.sha256]));
	return leftHashes.size === rightHashes.size &&
		[...leftHashes].every(([filePath, hash]) => rightHashes.get(filePath) === hash);
}

function snapshotId() {
	return `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
}

export async function createSnapshot(
	profile: string,
	options: SnapshotOptions = {},
): Promise<Snapshot> {
	const syncSessions = Boolean(options.syncSessions);
	const files = await collectFiles(agentDir(), {
		syncSessions,
		sessionDir: options.sessionDir ?? (await configuredSessionDir()),
		extraFiles: options.extraFiles,
	});
	return {
		version: VERSION,
		id: snapshotId(),
		createdAt: new Date().toISOString(),
		machine: os.hostname(),
		profile,
		syncSessions,
		files,
	};
}

export async function collectFiles(
	root: string,
	options: SnapshotOptions = {},
): Promise<SnapshotFile[]> {
	const results: SnapshotFile[] = [];
	const entries = await fs.readdir(root, { withFileTypes: true });
	for (const entry of entries) {
		if (entry.isDirectory() && TOP_LEVEL_DIRS.has(entry.name)) {
			await collectDirectory(results, root, entry.name);
		}
	}
	for (const fileName of TOP_LEVEL_FILES) {
		const entry = selectTopLevelFileEntry(entries, fileName);
		if (entry) await addFile(results, root, entry.name, fileName);
	}
	for (const extraFileName of normalizeExtraFiles(options.extraFiles)) {
		const entry = selectTopLevelFileEntry(entries, extraFileName);
		if (entry) await addFile(results, root, entry.name, extraFileName);
	}
	if (options.syncSessions) {
		try {
			await collectDirectory(results, sessionStorageRoot(root, options.sessionDir), "", {
				sessionsOnly: true,
				virtualPrefix: "sessions",
			});
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
	}
	return results.sort((left, right) => left.path.localeCompare(right.path));
}

async function collectDirectory(
	results: SnapshotFile[],
	root: string,
	relativeDirectory: string,
	options: { sessionsOnly?: boolean; virtualPrefix?: string } = {},
) {
	const absoluteDirectory = path.join(root, relativeDirectory);
	for (const entry of await fs.readdir(absoluteDirectory, { withFileTypes: true })) {
		const relativePath = relativeDirectory ? posixJoin(relativeDirectory, entry.name) : entry.name;
		const snapshotPath = options.virtualPrefix
			? posixJoin(options.virtualPrefix, relativePath)
			: relativePath;
		if (isDeniedPath(snapshotPath)) continue;
		if (entry.isDirectory()) {
			await collectDirectory(results, root, relativePath, options);
		} else if (entry.isFile() && (!options.sessionsOnly || isSessionFilePath(snapshotPath))) {
			await addFile(results, root, relativePath, snapshotPath);
		}
	}
}

async function addFile(
	results: SnapshotFile[],
	root: string,
	relativePath: string,
	snapshotPath = relativePath,
) {
	if (!isSafeSnapshotPath(snapshotPath)) return;
	const absolutePath = safeJoin(root, relativePath);
	const content = await fs.readFile(absolutePath);
	results.push({ path: snapshotPath, contentBase64: content.toString("base64"), sha256: sha256(content) });
}

export function isSessionPath(relativePath: string) {
	return toPosix(relativePath).startsWith("sessions/");
}

export function isSessionFilePath(relativePath: string) {
	const normalized = toPosix(relativePath);
	return isSessionPath(normalized) && normalized.endsWith(".jsonl");
}

export function sessionStorageRoot(root: string, configuredSessionDir?: string) {
	return configuredSessionDir ? path.resolve(expandHome(configuredSessionDir)) : path.resolve(root, "sessions");
}

export function sessionSnapshotPathFromAbsolute(sessionFile: string, configuredSessionDir?: string) {
	const relativePath = toPosix(path.relative(sessionStorageRoot(agentDir(), configuredSessionDir), sessionFile));
	if (!relativePath || relativePath.startsWith("../") || path.posix.isAbsolute(relativePath)) {
		return undefined;
	}
	const snapshotPath = posixJoin("sessions", relativePath);
	return isSessionFilePath(snapshotPath) ? snapshotPath : undefined;
}

export function snapshotTarget(root: string, relativePath: string, configuredSessionDir?: string) {
	if (isSessionPath(relativePath)) {
		return safeJoin(sessionStorageRoot(root, configuredSessionDir), relativePath.slice("sessions/".length));
	}
	return safeJoin(root, relativePath);
}

function isPathInside(parent: string, child: string) {
	const relativePath = path.relative(parent, child);
	return relativePath === "" || (!relativePath.startsWith("..") && !path.isAbsolute(relativePath));
}

export function snapshotIncludesSessions(snapshot: Snapshot) {
	return snapshot.syncSessions === true || snapshot.files.some((file) => isSessionPath(file.path));
}

export function filterSnapshotForConfigPolicy(
	snapshot: Snapshot,
	config: Pick<SyncConfig, "syncSessions" | "extraFiles">,
	options: { regenerateId?: boolean } = {},
) {
	const extraFilePaths = extraFilePathsByLower(config.extraFiles);
	const extraFiles = new Set(extraFilePaths.keys());
	const filtered = {
		...snapshot,
		syncSessions: config.syncSessions ? snapshot.syncSessions : false,
		files: canonicalizeSnapshotFilesForConfig(snapshot.files, config, extraFiles, extraFilePaths),
	};
	if (!options.regenerateId || snapshotsMatch(snapshot, filtered)) return filtered;
	return {
		...filtered,
		id: snapshotId(),
		createdAt: new Date().toISOString(),
		machine: os.hostname(),
	};
}

export function isConfiguredSnapshotPath(
	relativePath: string,
	config: Pick<SyncConfig, "syncSessions">,
	extraFiles: Set<string>,
) {
	const normalized = toPosix(relativePath);
	if (isSessionPath(normalized)) return config.syncSessions;
	if (!normalized.includes("/")) {
		const lower = normalized.toLowerCase();
		return TOP_LEVEL_FILE_NAMES.has(lower) || extraFiles.has(lower);
	}
	return TOP_LEVEL_DIRS.has(normalized.slice(0, normalized.indexOf("/")));
}

function canonicalizeSnapshotFilesForConfig(
	files: SnapshotFile[],
	config: Pick<SyncConfig, "syncSessions">,
	extraFiles: Set<string>,
	extraFilePaths: Map<string, string>,
) {
	const configuredFiles: SnapshotFile[] = [];
	const extraCandidates = new Map<
		string,
		{ exact: boolean; file: SnapshotFile; originalPath: string }
	>();
	for (const file of files) {
		const normalized = toPosix(file.path);
		if (!isSafeSnapshotPath(file.path) || !isConfiguredSnapshotPath(normalized, config, extraFiles)) {
			continue;
		}
		const topLevelPath = canonicalTopLevelFilePath(normalized, extraFilePaths);
		if (!topLevelPath) {
			configuredFiles.push(normalized === file.path ? file : { ...file, path: normalized });
			continue;
		}
		const candidate = {
			exact: normalized === topLevelPath,
			file: { ...file, path: topLevelPath },
			originalPath: normalized,
		};
		const current = extraCandidates.get(topLevelPath.toLowerCase());
		if (!current || isPreferredExtraCandidate(candidate, current)) {
			extraCandidates.set(topLevelPath.toLowerCase(), candidate);
		}
	}
	return [
		...configuredFiles,
		...[...extraCandidates.values()].map((candidate) => candidate.file),
	].sort((left, right) => left.path.localeCompare(right.path));
}

function canonicalTopLevelFilePath(relativePath: string, extraFilePaths: Map<string, string>) {
	const normalized = toPosix(relativePath);
	if (normalized.includes("/")) return undefined;
	const lower = normalized.toLowerCase();
	return TOP_LEVEL_FILE_PATHS.get(lower) ?? extraFilePaths.get(lower);
}

export function canonicalSnapshotPathForConfig(relativePath: string, extraFilePaths: Map<string, string>) {
	return canonicalTopLevelFilePath(relativePath, extraFilePaths) ?? toPosix(relativePath);
}

function isPreferredExtraCandidate(
	left: { exact: boolean; originalPath: string },
	right: { exact: boolean; originalPath: string },
) {
	if (left.exact !== right.exact) return left.exact;
	return left.originalPath.localeCompare(right.originalPath) < 0;
}

export function snapshotWithoutSessions(snapshot: Snapshot) {
	const files = snapshot.files.filter((file) => !isSessionPath(file.path));
	if (files.length === snapshot.files.length && snapshot.syncSessions !== true) return snapshot;
	return {
		...snapshot,
		id: snapshotId(),
		createdAt: new Date().toISOString(),
		machine: os.hostname(),
		syncSessions: false,
		files,
	};
}

export function scanSnapshot(snapshot: Snapshot) {
	const findings: string[] = [];
	for (const file of snapshot.files) {
		const content = Buffer.from(file.contentBase64, "base64");
		if (content.includes(0)) continue;
		const text = content.toString("utf8");
		for (const pattern of SECRET_PATTERNS) {
			if (pattern.test(text)) {
				findings.push(file.path);
				break;
			}
		}
	}
	return findings;
}

export function mergeRemotePreservedFiles(
	local: Snapshot,
	remote: Snapshot,
	config: Pick<SyncConfig, "syncSessions" | "extraFiles">,
) {
	const withSessions = config.syncSessions ? local : mergeRemoteSessionFiles(local, remote);
	const paths = new Set(withSessions.files.map((file) => file.path));
	const pathNames = new Set(withSessions.files.map((file) => file.path.toLowerCase()));
	const extraFileNames = new Set(normalizeExtraFiles(config.extraFiles).map((file) => file.toLowerCase()));
	const seenRemoteExtraNames = new Set<string>();
	const remoteExtras = remote.files.filter((file) => {
		const normalized = toPosix(file.path);
		const lower = normalized.toLowerCase();
		if (
			paths.has(normalized) ||
			pathNames.has(lower) ||
			!isSafeSnapshotPath(file.path) ||
			normalized.includes("/") ||
			TOP_LEVEL_FILE_NAMES.has(lower) ||
			RESERVED_TOP_LEVEL_NAMES.has(lower) ||
			extraFileNames.has(lower) ||
			seenRemoteExtraNames.has(lower)
		) {
			return false;
		}
		seenRemoteExtraNames.add(lower);
		return true;
	});
	if (remoteExtras.length === 0) return withSessions;
	return {
		...withSessions,
		id: snapshotId(),
		createdAt: new Date().toISOString(),
		machine: os.hostname(),
		files: [...withSessions.files, ...remoteExtras].sort((left, right) =>
			left.path.localeCompare(right.path),
		),
	};
}

export function mergeRemoteSessionFiles(local: Snapshot, remote: Snapshot) {
	const remoteSessions = remote.files.filter((file) => {
		const normalized = toPosix(file.path);
		return isSessionFilePath(normalized) && isSafeSnapshotPath(file.path);
	});
	if (remoteSessions.length === 0 && !snapshotIncludesSessions(remote)) return local;
	return {
		...local,
		id: snapshotId(),
		createdAt: new Date().toISOString(),
		machine: os.hostname(),
		syncSessions: true,
		files: [...local.files.filter((file) => !isSessionPath(file.path)), ...remoteSessions].sort(
			(left, right) => left.path.localeCompare(right.path),
		),
	};
}
