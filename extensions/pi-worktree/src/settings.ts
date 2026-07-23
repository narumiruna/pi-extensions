import { lstat, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, posix, win32 } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export const SETTINGS_FILE = "pi-worktree.json";

export type WorktreeSettingsSource = "default" | "user";

export interface LoadedWorktreeSettings {
	kind: "missing" | "loaded" | "invalid";
	path: string;
	effectiveRoot: string;
	source: WorktreeSettingsSource;
	configuredRoot?: string;
	document?: Record<string, unknown>;
	warning?: string;
}

export interface WorktreeSettingsState {
	effectiveRoot: string;
	source: WorktreeSettingsSource;
	configuredRoot?: string;
	warning?: string;
	canSave: boolean;
}

export interface SettingsFileOperations {
	write(path: string, data: string): Promise<void>;
	rename(source: string, destination: string): Promise<void>;
}

export interface WorktreeSettingsRuntime {
	get(): Readonly<WorktreeSettingsState>;
	getPath(): string;
	reload(): Promise<Readonly<WorktreeSettingsState>>;
	save(configuredRoot: string | undefined): Promise<Readonly<WorktreeSettingsState>>;
}

interface RuntimeOptions {
	path?: string | (() => string);
	home?: string;
	platform?: NodeJS.Platform;
	operations?: Partial<SettingsFileOperations>;
}

const DEFAULT_FILE_OPERATIONS: SettingsFileOperations = {
	write: (path, data) =>
		writeFile(path, data, { encoding: "utf8", flag: "wx", mode: 0o600 }).then(() => undefined),
	rename,
};

export function settingsFilePath(): string {
	return join(getAgentDir(), SETTINGS_FILE);
}

export function defaultWorktreeRoot(
	home = homedir(),
	platform: NodeJS.Platform = process.platform,
): string {
	return platformPath(platform).join(home, ".worktrees");
}

export function resolveWorktreeRoot(
	value: string,
	home = homedir(),
	platform: NodeJS.Platform = process.platform,
): string {
	if (!value || value.includes("\0")) {
		throw new Error("worktreeRoot must be a non-empty path without NUL characters.");
	}
	if (hasShellVariableSyntax(value)) {
		throw new Error("worktreeRoot must not contain shell variable syntax.");
	}

	const path = platformPath(platform);
	let candidate = value;
	if (value === "~") {
		candidate = home;
	} else if (value.startsWith("~/") || (platform === "win32" && value.startsWith("~\\"))) {
		candidate = path.resolve(home, value.slice(2));
	} else if (value.startsWith("~")) {
		throw new Error("worktreeRoot supports only ~ itself or a path beginning with ~/.");
	}
	if (!path.isAbsolute(candidate)) {
		throw new Error("worktreeRoot must be an absolute path or begin with ~/.");
	}

	try {
		const normalized = path.normalize(candidate);
		if (!normalized || !path.isAbsolute(normalized)) {
			throw new Error("normalization did not produce an absolute path");
		}
		return normalized;
	} catch (error) {
		throw new Error(`worktreeRoot could not be normalized: ${formatError(error)}`);
	}
}

export async function loadWorktreeSettings(
	path = settingsFilePath(),
	home = homedir(),
	platform: NodeJS.Platform = process.platform,
): Promise<LoadedWorktreeSettings> {
	const fallback = defaultWorktreeRoot(home, platform);
	let text: string;
	try {
		const stats = await lstat(path);
		if (stats.isSymbolicLink()) return invalid(path, fallback, "symbolic links are not accepted");
		if (!stats.isFile()) return invalid(path, fallback, "settings path is not a regular file");
		text = await readFile(path, "utf8");
	} catch (error) {
		if (isNodeError(error) && error.code === "ENOENT") {
			return {
				kind: "missing",
				path,
				effectiveRoot: fallback,
				source: "default",
				document: {},
			};
		}
		return invalid(path, fallback, formatError(error));
	}

	try {
		const document = JSON.parse(text) as unknown;
		if (!isRecord(document)) return invalid(path, fallback, "the top level must be a JSON object");
		if (!Object.hasOwn(document, "worktreeRoot")) {
			return {
				kind: "loaded",
				path,
				effectiveRoot: fallback,
				source: "default",
				document,
			};
		}
		if (typeof document.worktreeRoot !== "string") {
			return invalid(path, fallback, "worktreeRoot must be a string");
		}
		const effectiveRoot = resolveWorktreeRoot(document.worktreeRoot, home, platform);
		return {
			kind: "loaded",
			path,
			effectiveRoot,
			source: "user",
			configuredRoot: document.worktreeRoot,
			document,
		};
	} catch (error) {
		return invalid(path, fallback, formatError(error));
	}
}

export async function saveWorktreeSettings(
	document: Record<string, unknown>,
	configuredRoot: string | undefined,
	path = settingsFilePath(),
	operations: Partial<SettingsFileOperations> = {},
): Promise<Record<string, unknown>> {
	const nextDocument = { ...document };
	if (configuredRoot === undefined) delete nextDocument.worktreeRoot;
	else nextDocument.worktreeRoot = configuredRoot;

	await mkdir(dirname(path), { recursive: true });
	const temporaryPath = temporaryFilePath(path);
	try {
		await (operations.write ?? DEFAULT_FILE_OPERATIONS.write)(
			temporaryPath,
			`${JSON.stringify(nextDocument, null, 2)}\n`,
		);
		await (operations.rename ?? DEFAULT_FILE_OPERATIONS.rename)(temporaryPath, path);
		return nextDocument;
	} catch (error) {
		await unlink(temporaryPath).catch(() => undefined);
		throw error;
	}
}

export function createWorktreeSettingsRuntime(
	options: RuntimeOptions = {},
): WorktreeSettingsRuntime {
	const home = options.home ?? homedir();
	const platform = options.platform ?? process.platform;
	let resolvedPath: string | undefined;
	const getPath = () => {
		resolvedPath ??=
			typeof options.path === "function" ? options.path() : (options.path ?? settingsFilePath());
		return resolvedPath;
	};
	let document: Record<string, unknown> = {};
	let operationQueue = Promise.resolve();
	const enqueue = <T>(operation: () => Promise<T>): Promise<T> => {
		const result = operationQueue.then(operation, operation);
		operationQueue = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	};
	let state: WorktreeSettingsState = {
		effectiveRoot: defaultWorktreeRoot(home, platform),
		source: "default",
		canSave: true,
	};

	return {
		get: () => Object.freeze({ ...state }),
		getPath,
		reload() {
			return enqueue(async () => {
				const loaded = await loadWorktreeSettings(getPath(), home, platform);
				if (loaded.kind === "invalid") {
					state = { ...state, warning: loaded.warning, canSave: false };
					return Object.freeze({ ...state });
				}
				document = loaded.document ?? {};
				state = stateFromLoaded(loaded);
				return Object.freeze({ ...state });
			});
		},
		save(configuredRoot) {
			return enqueue(async () => {
				if (!state.canSave) {
					throw new Error(`Fix the pi-worktree settings file at ${getPath()} before changing it.`);
				}
				const effectiveRoot =
					configuredRoot === undefined
						? defaultWorktreeRoot(home, platform)
						: resolveWorktreeRoot(configuredRoot, home, platform);
				const nextDocument = await saveWorktreeSettings(
					document,
					configuredRoot,
					getPath(),
					options.operations,
				);
				document = nextDocument;
				state = {
					effectiveRoot,
					source: configuredRoot === undefined ? "default" : "user",
					...(configuredRoot === undefined ? {} : { configuredRoot }),
					canSave: true,
				};
				return Object.freeze({ ...state });
			});
		},
	};
}

function stateFromLoaded(loaded: LoadedWorktreeSettings): WorktreeSettingsState {
	return {
		effectiveRoot: loaded.effectiveRoot,
		source: loaded.source,
		...(loaded.configuredRoot === undefined ? {} : { configuredRoot: loaded.configuredRoot }),
		...(loaded.warning === undefined ? {} : { warning: loaded.warning }),
		canSave: true,
	};
}

function invalid(path: string, fallback: string, reason: string): LoadedWorktreeSettings {
	return {
		kind: "invalid",
		path,
		effectiveRoot: fallback,
		source: "default",
		warning: `${SETTINGS_FILE} ignored (${path}: ${reason}); using the safe default or last valid root without overwriting the file.`,
	};
}

function platformPath(platform: NodeJS.Platform): typeof posix | typeof win32 {
	return platform === "win32" ? win32 : posix;
}

function hasShellVariableSyntax(value: string): boolean {
	return /\$|%[^%]+%/u.test(value);
}

function temporaryFilePath(path: string): string {
	return `${path}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
	return error instanceof Error && "code" in error;
}

function formatError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
