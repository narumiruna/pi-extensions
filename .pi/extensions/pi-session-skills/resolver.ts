import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import {
	chmod,
	lstat,
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	realpath,
	rename,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import { loadSkills, type Skill, withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import type { ParsedSkillSource } from "./source-parser.js";

const CACHE_VERSION = 1;
const GIT_TIMEOUT_MS = 300_000;
const MAX_GIT_OUTPUT_CHARS = 32_000;
const MAX_DISCOVERY_DEPTH = 8;
const MAX_DISCOVERED_SKILLS = 500;
const SKIPPED_DISCOVERY_DIRECTORIES = new Set([
	".git",
	"node_modules",
	"dist",
	"build",
	"__pycache__",
]);

export interface ResolvedSkillTransaction {
	commit(): Promise<void>;
	rollback(): Promise<void>;
}

export interface ResolvedSessionSkill {
	name: string;
	path: string;
	source: string;
	selector?: string;
	cacheHit: boolean;
	previousName?: string;
	transaction?: ResolvedSkillTransaction;
}

export interface ResolveSessionSkillOptions {
	source: ParsedSkillSource;
	selector?: string;
	refresh?: boolean;
	signal?: AbortSignal;
}

export interface SkillResolverLike {
	resolve(options: ResolveSessionSkillOptions): Promise<ResolvedSessionSkill>;
	getCacheRoot(): string;
}

export type CloneRepository = (
	repository: string,
	target: string,
	ref: string | undefined,
	signal: AbortSignal | undefined,
) => Promise<void>;

interface CacheMetadata {
	version: number;
	name: string;
	source: string;
	selector?: string;
	createdAt: string;
}

interface CacheIndex {
	version: number;
	entry: string;
}

interface CurrentCacheEntry {
	index: CacheIndex;
	result: ResolvedSessionSkill;
}

export class SessionSkillResolver implements SkillResolverLike {
	readonly #cacheRoot: string;
	readonly #cloneRepository: CloneRepository;

	constructor(options: { cacheRoot?: string; cloneRepository?: CloneRepository } = {}) {
		this.#cacheRoot = resolve(options.cacheRoot ?? defaultCacheRoot());
		this.#cloneRepository = options.cloneRepository ?? runGitClone;
	}

	getCacheRoot(): string {
		return this.#cacheRoot;
	}

	async resolve(options: ResolveSessionSkillOptions): Promise<ResolvedSessionSkill> {
		options.signal?.throwIfAborted();
		const key = cacheKey(options.source, options.selector);
		const entryPath = join(this.#cacheRoot, "entries", key);
		return withFileMutationQueue(entryPath, () => this.#resolveEntry(options, key, entryPath));
	}

	async #resolveEntry(
		options: ResolveSessionSkillOptions,
		key: string,
		entryRoot: string,
	): Promise<ResolvedSessionSkill> {
		options.signal?.throwIfAborted();
		const current = await this.#readCachedEntry(entryRoot, options);
		options.signal?.throwIfAborted();
		if (!options.refresh && current) return current.result;

		await mkdir(join(this.#cacheRoot, "staging"), { recursive: true, mode: 0o700 });
		options.signal?.throwIfAborted();
		await mkdir(join(entryRoot, "versions"), { recursive: true, mode: 0o700 });
		options.signal?.throwIfAborted();
		const stagingPath = await mkdtemp(join(this.#cacheRoot, "staging", `${key}-`));
		options.signal?.throwIfAborted();
		try {
			const sourcePath = await this.#materializeSource(options.source, stagingPath, options.signal);
			options.signal?.throwIfAborted();
			const selected = await selectSkill(
				sourcePath,
				options.selector,
				this.#cacheRoot,
				options.source.kind === "local" ? this.#cacheRoot : undefined,
				options.signal,
			);
			options.signal?.throwIfAborted();

			const candidateEntry = join(stagingPath, "entry");
			const candidateSkill = join(candidateEntry, "skill");
			const excludedCopyRoot =
				options.source.kind === "local" ? await realpath(this.#cacheRoot) : undefined;
			options.signal?.throwIfAborted();
			await mkdir(candidateEntry, { recursive: true, mode: 0o700 });
			options.signal?.throwIfAborted();
			await copySkillTree(selected.baseDir, candidateSkill, excludedCopyRoot, options.signal);
			options.signal?.throwIfAborted();
			await chmod(candidateEntry, 0o700);
			options.signal?.throwIfAborted();
			const metadata: CacheMetadata = {
				version: CACHE_VERSION,
				name: selected.name,
				source: options.source.original,
				selector: options.selector,
				createdAt: new Date().toISOString(),
			};
			await writeFile(join(candidateEntry, "metadata.json"), JSON.stringify(metadata, null, 2), {
				encoding: "utf8",
				mode: 0o600,
			});
			options.signal?.throwIfAborted();
			validateMaterializedSkill(candidateSkill, selected.name, this.#cacheRoot);
			options.signal?.throwIfAborted();

			const entry = randomUUID();
			const versionPath = join(entryRoot, "versions", entry);
			await rename(candidateEntry, versionPath);
			const transaction = createCacheTransaction(entryRoot, entry, current?.index);
			if (options.signal?.aborted) {
				await rm(versionPath, { recursive: true, force: true });
				options.signal.throwIfAborted();
			}
			return {
				name: selected.name,
				path: join(versionPath, "skill"),
				source: options.source.original,
				selector: options.selector,
				cacheHit: false,
				previousName: current?.result.name,
				transaction,
			};
		} finally {
			await rm(stagingPath, { recursive: true, force: true });
		}
	}

	async #materializeSource(
		source: ParsedSkillSource,
		stagingPath: string,
		signal: AbortSignal | undefined,
	): Promise<string> {
		if (source.kind === "local") {
			let localPath: string;
			try {
				localPath = await realpath(source.localPath);
			} catch {
				throw new Error(`Local skill source does not exist: ${source.localPath}`);
			}
			signal?.throwIfAborted();
			const sourceStat = await stat(localPath);
			signal?.throwIfAborted();
			if (!sourceStat.isDirectory() && !sourceStat.isFile()) {
				throw new Error(`Local skill source is not a file or directory: ${source.localPath}`);
			}
			return localPath;
		}

		const repositoryPath = join(stagingPath, "repository");
		try {
			await this.#cloneRepository(source.repository, repositoryPath, source.ref, signal);
		} catch (error) {
			if (!source.sshFallback || !(error instanceof GitCommandError) || !error.isAuthFailure) {
				throw error;
			}
			await rm(repositoryPath, { recursive: true, force: true });
			signal?.throwIfAborted();
			await this.#cloneRepository(source.sshFallback, repositoryPath, source.ref, signal);
		}
		signal?.throwIfAborted();
		const requestedPath = source.subpath ? join(repositoryPath, source.subpath) : repositoryPath;
		assertPathInside(repositoryPath, requestedPath);
		let resolvedPath: string;
		try {
			resolvedPath = await realpath(requestedPath);
		} catch {
			throw new Error(`Repository subpath does not exist: ${source.subpath}`);
		}
		signal?.throwIfAborted();
		const repositoryRoot = await realpath(repositoryPath);
		signal?.throwIfAborted();
		assertPathInside(repositoryRoot, resolvedPath);
		return resolvedPath;
	}

	async #readCachedEntry(
		entryRoot: string,
		options: ResolveSessionSkillOptions,
	): Promise<CurrentCacheEntry | undefined> {
		try {
			const index = JSON.parse(
				await readFile(join(entryRoot, "current.json"), "utf8"),
			) as CacheIndex;
			options.signal?.throwIfAborted();
			if (index.version !== CACHE_VERSION || !isCacheEntryName(index.entry)) return undefined;
			const versionPath = join(entryRoot, "versions", index.entry);
			assertPathInside(join(entryRoot, "versions"), versionPath);
			const metadata = JSON.parse(
				await readFile(join(versionPath, "metadata.json"), "utf8"),
			) as CacheMetadata;
			options.signal?.throwIfAborted();
			if (
				metadata.version !== CACHE_VERSION ||
				typeof metadata.name !== "string" ||
				metadata.source !== options.source.original ||
				metadata.selector !== options.selector
			) {
				return undefined;
			}
			const skillPath = join(versionPath, "skill");
			validateMaterializedSkill(skillPath, metadata.name, this.#cacheRoot);
			options.signal?.throwIfAborted();
			return {
				index,
				result: {
					name: metadata.name,
					path: skillPath,
					source: metadata.source,
					selector: metadata.selector,
					cacheHit: true,
				},
			};
		} catch {
			options.signal?.throwIfAborted();
			return undefined;
		}
	}
}

export class GitCommandError extends Error {
	readonly output: string;
	readonly isAuthFailure: boolean;

	constructor(message: string, output: string) {
		super(message);
		this.name = "GitCommandError";
		this.output = output;
		this.isAuthFailure =
			/authentication failed|could not read username|permission denied|repository not found|403|saml sso/iu.test(
				output,
			);
	}
}

export async function runGitClone(
	repository: string,
	target: string,
	ref: string | undefined,
	signal: AbortSignal | undefined,
): Promise<void> {
	if (ref && isCommitHash(ref)) {
		await runGitCommand(["init", target], signal);
		signal?.throwIfAborted();
		await runGitCommand(["-C", target, "remote", "add", "origin", repository], signal);
		signal?.throwIfAborted();
		await runGitCommand(["-C", target, "fetch", "--depth", "1", "origin", ref], signal);
		signal?.throwIfAborted();
		await runGitCommand(["-C", target, "checkout", "--detach", "FETCH_HEAD"], signal);
		return;
	}

	const args = ["clone", "--depth", "1"];
	if (ref) args.push("--branch", ref);
	args.push("--", repository, target);
	await runGitCommand(args, signal);
}

async function runGitCommand(args: string[], signal: AbortSignal | undefined): Promise<void> {
	if (signal?.aborted) throw new Error("Skill resolution cancelled.");
	await new Promise<void>((resolvePromise, rejectPromise) => {
		const detached = process.platform !== "win32";
		const child = spawn("git", args, {
			detached,
			env: {
				...process.env,
				GIT_TERMINAL_PROMPT: "0",
				GIT_LFS_SKIP_SMUDGE: "1",
				GCM_INTERACTIVE: "Never",
				GIT_SSH_COMMAND: `${process.env.GIT_SSH_COMMAND ?? "ssh"} -o BatchMode=yes`,
			},
			stdio: ["ignore", "pipe", "pipe"],
		});
		let output = "";
		let timedOut = false;
		let settled = false;
		let terminationRequested = false;
		let killTimer: NodeJS.Timeout | undefined;

		const appendOutput = (chunk: Buffer) => {
			output = `${output}${chunk.toString("utf8")}`.slice(-MAX_GIT_OUTPUT_CHARS);
		};
		child.stdout?.on("data", appendOutput);
		child.stderr?.on("data", appendOutput);

		const killWindowsTree = () => {
			if (!child.pid) {
				child.kill("SIGTERM");
				return;
			}
			const killer = spawn("taskkill", windowsProcessTreeKillArguments(child.pid), {
				stdio: "ignore",
				windowsHide: true,
			});
			killer.once("error", () => child.kill("SIGTERM"));
			killer.once("close", (code) => {
				if (code !== 0 && child.exitCode === null) child.kill("SIGTERM");
			});
		};
		const terminate = () => {
			if (terminationRequested || child.exitCode !== null || child.signalCode !== null) return;
			terminationRequested = true;
			try {
				if (process.platform === "win32") killWindowsTree();
				else if (detached && child.pid) process.kill(-child.pid, "SIGTERM");
				else child.kill("SIGTERM");
			} catch {
				child.kill("SIGTERM");
			}
			killTimer = setTimeout(() => {
				try {
					if (process.platform === "win32") killWindowsTree();
					else if (detached && child.pid) process.kill(-child.pid, "SIGKILL");
					else child.kill("SIGKILL");
				} catch {
					// The process already exited.
				}
			}, 1_000);
			killTimer.unref();
		};
		const onAbort = () => terminate();
		const timeout = setTimeout(() => {
			timedOut = true;
			terminate();
		}, GIT_TIMEOUT_MS);
		timeout.unref();
		signal?.addEventListener("abort", onAbort, { once: true });
		if (signal?.aborted) terminate();

		const finish = (callback: () => void) => {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			if (killTimer) clearTimeout(killTimer);
			signal?.removeEventListener("abort", onAbort);
			callback();
		};

		child.on("error", (error) => {
			finish(() => {
				if ((error as NodeJS.ErrnoException).code === "ENOENT") {
					rejectPromise(new Error("Git is required to load remote session skills."));
				} else rejectPromise(error);
			});
		});
		child.on("close", (code) => {
			finish(() => {
				if (signal?.aborted) rejectPromise(new Error("Skill resolution cancelled."));
				else if (timedOut) rejectPromise(new Error("Git command timed out after 300 seconds."));
				else if (code === 0) resolvePromise();
				else
					rejectPromise(new GitCommandError(`Git command failed with exit code ${code}.`, output));
			});
		});
	});
}

export function windowsProcessTreeKillArguments(pid: number): string[] {
	return ["/PID", String(pid), "/T", "/F"];
}

function isCommitHash(ref: string): boolean {
	return /^[0-9a-f]{40}$/iu.test(ref);
}

export function defaultCacheRoot(
	environment: NodeJS.ProcessEnv = process.env,
	userHome: string = homedir(),
): string {
	const xdg = environment.XDG_CACHE_HOME;
	if (xdg && isAbsolute(xdg)) return join(xdg, "pi", "session-skills");
	if (process.platform === "win32" && environment.LOCALAPPDATA) {
		return join(environment.LOCALAPPDATA, "pi", "session-skills");
	}
	return join(userHome, ".cache", "pi", "session-skills");
}

export function isPathInside(root: string, candidate: string): boolean {
	const pathFromRoot = relative(resolve(root), resolve(candidate));
	return pathFromRoot === "" || (!pathFromRoot.startsWith(`..${sep}`) && pathFromRoot !== "..");
}

async function selectSkill(
	sourcePath: string,
	selector: string | undefined,
	cacheRoot: string,
	excludedRoot: string | undefined,
	signal: AbortSignal | undefined,
): Promise<Skill> {
	const skillPaths = await discoverSkillPaths(sourcePath, excludedRoot, signal);
	signal?.throwIfAborted();
	const loaded = loadSkills({
		cwd: dirname(sourcePath),
		agentDir: cacheRoot,
		skillPaths: skillPaths,
		includeDefaults: false,
	});
	const collisionNames = loaded.diagnostics.flatMap((diagnostic) =>
		diagnostic.type === "collision" && diagnostic.collision ? [diagnostic.collision.name] : [],
	);
	if (collisionNames.length > 0) {
		throw new Error(`Skill source contains duplicate names: ${collisionNames.join(", ")}`);
	}
	const skills = selector
		? loaded.skills.filter((skill) => skill.name.toLowerCase() === selector.toLowerCase())
		: loaded.skills;
	if (skills.length === 1) {
		const sourceStat = await stat(sourcePath);
		signal?.throwIfAborted();
		const sourceRoot = await realpath(sourceStat.isDirectory() ? sourcePath : dirname(sourcePath));
		signal?.throwIfAborted();
		const skillRoot = await realpath(skills[0].baseDir);
		signal?.throwIfAborted();
		assertPathInside(sourceRoot, skillRoot);
		return { ...skills[0], baseDir: skillRoot };
	}
	const names = loaded.skills.map((skill) => skill.name).sort();
	if (skills.length === 0 && selector) {
		throw new Error(
			`No skill named "${selector}" was found.${names.length ? ` Available: ${names.join(", ")}` : ""}`,
		);
	}
	if (loaded.skills.length === 0) {
		const diagnostics = loaded.diagnostics.map((diagnostic) => diagnostic.message).join("; ");
		throw new Error(`No valid skills were found.${diagnostics ? ` ${diagnostics}` : ""}`);
	}
	throw new Error(
		`This source contains multiple skills. Use --skill with one of: ${names.join(", ")}`,
	);
}

async function discoverSkillPaths(
	sourcePath: string,
	excludedRoot: string | undefined,
	signal: AbortSignal | undefined,
): Promise<string[]> {
	const discovered: string[] = [];
	const canonicalExcludedRoot = excludedRoot ? await realpath(excludedRoot) : undefined;
	signal?.throwIfAborted();
	const walk = async (current: string, depth: number): Promise<void> => {
		signal?.throwIfAborted();
		if (canonicalExcludedRoot && isPathInside(canonicalExcludedRoot, current)) return;
		const currentStat = await lstat(current);
		signal?.throwIfAborted();
		if (currentStat.isSymbolicLink())
			throw new Error(`Skill source contains a symbolic link: ${current}`);
		if (currentStat.isFile()) {
			if (basename(current) === "SKILL.md") discovered.push(current);
			return;
		}
		if (!currentStat.isDirectory() || depth > MAX_DISCOVERY_DEPTH) return;
		const rootSkill = join(current, "SKILL.md");
		let rootSkillStat: Awaited<ReturnType<typeof lstat>> | undefined;
		try {
			rootSkillStat = await lstat(rootSkill);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
		signal?.throwIfAborted();
		if (rootSkillStat?.isSymbolicLink()) {
			throw new Error(`Skill source contains a symbolic link: ${rootSkill}`);
		}
		if (rootSkillStat?.isFile()) {
			discovered.push(rootSkill);
			return;
		}
		const entries = await readdir(current, { withFileTypes: true });
		signal?.throwIfAborted();
		entries.sort((left, right) => left.name.localeCompare(right.name));
		for (const entry of entries) {
			if (!entry.isDirectory() || SKIPPED_DISCOVERY_DIRECTORIES.has(entry.name)) continue;
			if (discovered.length >= MAX_DISCOVERED_SKILLS) {
				throw new Error(`Skill source exceeds the ${MAX_DISCOVERED_SKILLS}-skill discovery limit.`);
			}
			await walk(join(current, entry.name), depth + 1);
		}
	};
	await walk(sourcePath, 0);
	signal?.throwIfAborted();
	return discovered;
}

function validateMaterializedSkill(path: string, expectedName: string, cacheRoot: string): void {
	const loaded = loadSkills({
		cwd: dirname(path),
		agentDir: cacheRoot,
		skillPaths: [path],
		includeDefaults: false,
	});
	if (loaded.skills.length !== 1 || loaded.skills[0].name !== expectedName) {
		throw new Error(`Cached skill validation failed for ${expectedName}.`);
	}
}

async function copySkillTree(
	source: string,
	destination: string,
	excludedRoot: string | undefined,
	signal: AbortSignal | undefined,
): Promise<void> {
	signal?.throwIfAborted();
	if (excludedRoot && isPathInside(excludedRoot, source)) return;
	const sourceStat = await lstat(source);
	signal?.throwIfAborted();
	if (sourceStat.isSymbolicLink()) throw new Error(`Skill contains a symbolic link: ${source}`);
	if (sourceStat.isDirectory()) {
		const sourceMode = sourceStat.mode & 0o777;
		await mkdir(destination, { mode: sourceMode | 0o700 });
		signal?.throwIfAborted();
		const entries = await readdir(source, { withFileTypes: true });
		signal?.throwIfAborted();
		for (const entry of entries) {
			if (entry.name === ".git") continue;
			await copySkillTree(
				join(source, entry.name),
				join(destination, entry.name),
				excludedRoot,
				signal,
			);
		}
		await chmod(destination, sourceMode);
		signal?.throwIfAborted();
		return;
	}
	if (!sourceStat.isFile()) throw new Error(`Skill contains an unsupported file type: ${source}`);
	await pipeline(
		createReadStream(source),
		createWriteStream(destination, { mode: sourceStat.mode }),
		{
			signal,
		},
	);
	await chmod(destination, sourceStat.mode & 0o777);
	signal?.throwIfAborted();
}

function assertPathInside(root: string, candidate: string): void {
	if (!isPathInside(root, candidate))
		throw new Error("Skill source path escapes its repository root.");
}

function createCacheTransaction(
	entryRoot: string,
	entry: string,
	previousIndex: CacheIndex | undefined,
): ResolvedSkillTransaction {
	let state: "pending" | "committed" | "rolled-back" = "pending";
	const versionPath = join(entryRoot, "versions", entry);
	return {
		async commit() {
			if (state === "committed") return;
			if (state === "rolled-back")
				throw new Error("Cannot commit a rolled-back skill cache entry.");
			await withFileMutationQueue(entryRoot, () =>
				writeCacheIndex(entryRoot, { version: CACHE_VERSION, entry }),
			);
			state = "committed";
		},
		async rollback() {
			if (state === "rolled-back") return;
			await withFileMutationQueue(entryRoot, async () => {
				const current = await readCacheIndex(entryRoot);
				if (state === "committed" && current?.entry === entry) {
					await writeCacheIndex(entryRoot, previousIndex);
				}
				await rm(versionPath, { recursive: true, force: true });
			});
			state = "rolled-back";
		},
	};
}

async function readCacheIndex(entryRoot: string): Promise<CacheIndex | undefined> {
	try {
		const index = JSON.parse(await readFile(join(entryRoot, "current.json"), "utf8")) as CacheIndex;
		return index.version === CACHE_VERSION && isCacheEntryName(index.entry) ? index : undefined;
	} catch {
		return undefined;
	}
}

async function writeCacheIndex(entryRoot: string, index: CacheIndex | undefined): Promise<void> {
	const indexPath = join(entryRoot, "current.json");
	if (!index) {
		await rm(indexPath, { force: true });
		return;
	}
	const temporaryPath = join(entryRoot, `.current-${randomUUID()}.json`);
	try {
		await writeFile(temporaryPath, JSON.stringify(index, null, 2), {
			encoding: "utf8",
			mode: 0o600,
		});
		await rename(temporaryPath, indexPath);
	} finally {
		await rm(temporaryPath, { force: true });
	}
}

function isCacheEntryName(value: unknown): value is string {
	return typeof value === "string" && /^[0-9a-f-]{36}$/iu.test(value);
}

function cacheKey(source: ParsedSkillSource, selector: string | undefined): string {
	const identity =
		source.kind === "local"
			? { kind: source.kind, original: source.original, path: source.localPath, selector }
			: {
					kind: source.kind,
					original: source.original,
					repository: source.repository,
					ref: source.ref,
					subpath: source.subpath,
					selector,
				};
	return createHash("sha256").update(JSON.stringify(identity)).digest("hex");
}
