import { createHash, createHmac, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { gunzip, gzip } from "node:zlib";
import { promisify } from "node:util";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";

const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);

const STATUS_KEY = "pisync";
const VERSION = 1;
const DEFAULT_PROFILE = "default";
const DEFAULT_PREFIX = "pi-sync";
const DEFAULT_REGION = "auto";
const LOCK_STALE_MS = 30 * 60 * 1000;

const TOP_LEVEL_FILES = new Set(["settings.json", "keybindings.json", "models.json", "AGENTS.md"]);
const TOP_LEVEL_DIRS = new Set(["skills", "prompts", "themes", "extensions"]);
const SECRET_PATTERNS = [
	/AWS_SECRET_ACCESS_KEY\s*[=:]\s*['\"]?[A-Za-z0-9/+]{35,}/i,
	/(ANTHROPIC|OPENAI|GEMINI|GOOGLE|FIRECRAWL|GITHUB|CLOUDFLARE|R2|S3)_[A-Z0-9_]*(KEY|TOKEN|SECRET)\s*[=:]\s*['\"]?[^\s'\"]{12,}/i,
	/sk-ant-[A-Za-z0-9_-]{20,}/,
	/sk-[A-Za-z0-9]{20,}/,
	/gh[pousr]_[A-Za-z0-9_]{20,}/,
];

interface SyncConfig {
	endpoint: string;
	bucket: string;
	region: string;
	accessKeyId: string;
	secretAccessKey: string;
	sessionToken?: string;
	profile: string;
	prefix: string;
}

interface PartialConfig {
	endpoint?: string;
	bucket?: string;
	region?: string;
	accessKeyId?: string;
	secretAccessKey?: string;
	sessionToken?: string;
	profile?: string;
	prefix?: string;
	autoSync?: boolean | string;
}

interface SnapshotFile {
	path: string;
	contentBase64: string;
	sha256: string;
}

interface Snapshot {
	version: number;
	id: string;
	createdAt: string;
	machine: string;
	profile: string;
	files: SnapshotFile[];
}

interface LatestPointer {
	version: number;
	profile: string;
	snapshot: string;
	sha256: string;
	createdAt: string;
	machine: string;
}

interface RemoteObject<T> {
	value?: T;
	etag?: string;
	missing: boolean;
}

interface SyncState {
	version: number;
	profile: string;
	lastAppliedSnapshot?: string;
	lastRemoteEtag?: string;
	lastFileHashes: Record<string, string>;
}

interface LockFile {
	id: string;
	pid: number;
	command: string;
	startedAt: string;
}

interface CommandOptions {
	yes: boolean;
	force: boolean;
	stale: boolean;
	silent: boolean;
	reload: boolean;
	auto: boolean;
	args: string[];
}

const AUTO_SYNC_OPTIONS: CommandOptions = {
	yes: true,
	force: false,
	stale: false,
	silent: true,
	reload: false,
	auto: true,
	args: [],
};

export default function sync(pi: ExtensionAPI) {
	pi.registerCommand("pisync", {
		description: "Sync Pi settings through Cloudflare R2 or S3-compatible storage",
		handler: async (args, ctx) => {
			await handleCommand(args, ctx);
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		ctx.ui.setStatus(STATUS_KEY, undefined);
		await autoSync(ctx);
	});

	pi.on("session_shutdown", (_event, ctx) => {
		ctx.ui.setStatus(STATUS_KEY, undefined);
	});
}

async function handleCommand(rawArgs: string, ctx: ExtensionCommandContext) {
	const [subcommand = "status", ...rest] = splitArgs(rawArgs);
	const options = parseOptions(rest);

	try {
		await ensureStateDir();

		switch (subcommand) {
			case "help":
				ctx.ui.notify(usage(), "info");
				return;
			case "init":
				await initConfig(ctx);
				return;
			case "config":
				await showConfig(ctx);
				return;
			case "status":
				await status(ctx);
				return;
			case "diff":
				await diff(ctx);
				return;
			case "doctor":
				await doctor(ctx);
				return;
			case "push":
				await withLock("push", () => push(ctx, options));
				return;
			case "pull":
				await withLock("pull", () => pull(ctx, options));
				return;
			case "sync":
				await withLock("sync", () => syncBoth(ctx, options));
				return;
			case "history":
				await history(ctx);
				return;
			case "rollback":
				await withLock("rollback", () => rollback(ctx, options));
				return;
			case "unlock":
				await unlock(ctx, options);
				return;
			default:
				ctx.ui.notify(`Unknown /pisync command: ${subcommand}\n\n${usage()}`, "warning");
		}
	} catch (error) {
		ctx.ui.setStatus(STATUS_KEY, undefined);
		ctx.ui.notify(errorMessage(error), "error");
	}
}

async function autoSync(ctx: ExtensionContext) {
	try {
		const partial = await loadPartialConfig();
		if (!isEnabled(partial.autoSync ?? process.env.PI_SYNC_AUTO_SYNC, true)) return;
		await ensureStateDir();
		await loadConfig();
		await withLock("auto-sync", () => syncBoth(ctx, AUTO_SYNC_OPTIONS));
	} catch (error) {
		if (isMissingConfigError(error)) return;
		ctx.ui.setStatus(STATUS_KEY, undefined);
		ctx.ui.notify(`pi-sync auto sync skipped: ${errorMessage(error)}`, "warning");
	}
}

async function initConfig(ctx: ExtensionCommandContext) {
	const configPath = localConfigPath();
	try {
		await fs.access(configPath, fsConstants.F_OK);
		ctx.ui.notify(`Config already exists: ${configPath}`, "info");
		return;
	} catch {
		// Create below.
	}

	const sample = {
		endpoint: "https://<account-id>.r2.cloudflarestorage.com",
		bucket: "pi-sync",
		region: DEFAULT_REGION,
		accessKeyId: "<access-key-id>",
		secretAccessKey: "<secret-access-key>",
		profile: DEFAULT_PROFILE,
		prefix: DEFAULT_PREFIX,
		autoSync: true,
	};
	await writeJson(configPath, sample);
	ctx.ui.notify(`Created ${configPath}. Fill in R2 credentials, then run /pisync doctor.`, "info");
}

async function showConfig(ctx: ExtensionCommandContext) {
	const partial = await loadPartialConfig();
	const warnings = sessionTokenWarnings(partial);
	ctx.ui.notify(
		[
			"pi-sync config:",
			`endpoint: ${partial.endpoint ?? "missing"}`,
			`bucket: ${partial.bucket ?? "missing"}`,
			`region: ${partial.region ?? DEFAULT_REGION}`,
			`accessKeyId: ${partial.accessKeyId ? redact(partial.accessKeyId) : "missing"}`,
			`secretAccessKey: ${partial.secretAccessKey ? "configured" : "missing"}`,
			`sessionToken: ${partial.sessionToken ? "configured" : "not configured"}`,
			`profile: ${partial.profile ?? DEFAULT_PROFILE}`,
			`prefix: ${partial.prefix ?? DEFAULT_PREFIX}`,
			`autoSync: ${isEnabled(partial.autoSync ?? process.env.PI_SYNC_AUTO_SYNC, true) ? "enabled" : "disabled"}`,
			`local config: ${localConfigPath()}`,
			...warnings,
		].join("\n"),
		warnings.length > 0 ? "warning" : "info",
	);
}

async function status(ctx: ExtensionCommandContext) {
	ctx.ui.setStatus(STATUS_KEY, "🔄 checking");
	const config = await loadConfig();
	const client = new S3Client(config);
	const local = await createSnapshot(config.profile);
	const state = await readState(config.profile);
	const latest = await client.getJson<LatestPointer>(latestKey(config));
	const localChanged = hasLocalChanges(local, state);

	let remoteText = "remote: empty";
	let remoteChanged = false;
	if (!latest.missing && latest.value) {
		remoteChanged = latest.value.snapshot !== state.lastAppliedSnapshot;
		remoteText = `remote: ${latest.value.snapshot} from ${latest.value.machine} at ${latest.value.createdAt}`;
	}

	ctx.ui.setStatus(STATUS_KEY, undefined);
	ctx.ui.notify(
		[
			`profile: ${config.profile}`,
			remoteText,
			`local files: ${local.files.length}`,
			`local changed since last sync: ${localChanged ? "yes" : "no"}`,
			`remote changed since last sync: ${remoteChanged ? "yes" : "no"}`,
		].join("\n"),
		localChanged || remoteChanged ? "warning" : "info",
	);
}

async function diff(ctx: ExtensionCommandContext) {
	ctx.ui.setStatus(STATUS_KEY, "🔄 diff");
	const config = await loadConfig();
	const client = new S3Client(config);
	const local = await createSnapshot(config.profile);
	const remote = await readRemoteSnapshot(client, config);
	ctx.ui.setStatus(STATUS_KEY, undefined);

	if (!remote) {
		ctx.ui.notify(formatSnapshotOnlyDiff("Remote is empty. Local push would upload", local), "info");
		return;
	}

	ctx.ui.notify(formatDiff(local, remote), "info");
}

async function doctor(ctx: ExtensionCommandContext) {
	const messages: string[] = [];
	let level: "info" | "warning" = "info";

	try {
		const config = await loadConfig();
		messages.push(`config: ok (${config.bucket}/${profilePrefix(config)})`);
		const warnings = sessionTokenWarnings(config);
		if (warnings.length > 0) {
			level = "warning";
			messages.push(...warnings);
		}
	} catch (error) {
		level = "warning";
		messages.push(`config: ${errorMessage(error)}`);
	}

	const local = await createSnapshot(DEFAULT_PROFILE);
	const secrets = scanSnapshot(local);
	if (secrets.length > 0) {
		level = "warning";
		messages.push("secret scan: possible secrets found:");
		messages.push(...secrets.map((secret) => `- ${secret}`));
	} else {
		messages.push(`secret scan: ok (${local.files.length} files checked)`);
	}

	const lock = await readLock();
	messages.push(lock ? `lock: held by pid ${lock.pid} since ${lock.startedAt}` : "lock: free");
	ctx.ui.notify(messages.join("\n"), level);
}

async function push(ctx: ExtensionCommandContext | ExtensionContext, options: CommandOptions) {
	ctx.ui.setStatus(STATUS_KEY, "🔄 pushing");
	const config = await loadConfig();
	const client = new S3Client(config);
	const state = await readState(config.profile);
	const local = await createSnapshot(config.profile);
	const secrets = scanSnapshot(local);
	if (secrets.length > 0) {
		throw new Error(`Refusing to push possible secrets:\n${secrets.map((s) => `- ${s}`).join("\n")}`);
	}

	const latest = await client.getJson<LatestPointer>(latestKey(config));
	if (remoteChangedSinceState(latest, state) && !options.force) {
		throw new Error("Remote changed since last sync. Run /pisync pull first or /pisync push --force.");
	}

	if (!options.yes && !(await ctx.ui.confirm("Push pi settings?", formatPushSummary(local, latest)))) {
		ctx.ui.setStatus(STATUS_KEY, undefined);
		ctx.ui.notify("Push cancelled.", "info");
		return;
	}

	const pointer = await uploadSnapshot(client, config, local, latest, options.force);
	await updateHistory(client, config, pointer);
	await writeState(config.profile, {
		version: VERSION,
		profile: config.profile,
		lastAppliedSnapshot: pointer.snapshot,
		lastRemoteEtag: undefined,
		lastFileHashes: fileHashMap(local),
	});
	ctx.ui.setStatus(STATUS_KEY, undefined);
	if (!options.silent) {
		ctx.ui.notify(`Pushed ${local.files.length} files as ${pointer.snapshot}.`, "info");
	}
}

async function pull(ctx: ExtensionCommandContext | ExtensionContext, options: CommandOptions) {
	ctx.ui.setStatus(STATUS_KEY, "🔄 pulling");
	const config = await loadConfig();
	const client = new S3Client(config);
	const state = await readState(config.profile);
	const local = await createSnapshot(config.profile);
	const remote = await readRemoteSnapshot(client, config);
	if (!remote) throw new Error("Remote is empty. Run /pisync push from a configured machine first.");

	const localChanged = hasLocalChanges(local, state);
	const remoteChanged = remote.id !== state.lastAppliedSnapshot;
	if (localChanged && remoteChanged && state.lastAppliedSnapshot && !options.force) {
		throw new Error("Both local and remote changed since last sync. Run /pisync diff, then choose /pisync pull --force or /pisync push --force.");
	}

	if (!options.yes && !(await ctx.ui.confirm("Pull pi settings?", formatDiff(local, remote)))) {
		ctx.ui.setStatus(STATUS_KEY, undefined);
		ctx.ui.notify("Pull cancelled.", "info");
		return;
	}

	const backup = await backupLocal(config.profile);
	await applySnapshot(remote);
	await writeState(config.profile, {
		version: VERSION,
		profile: config.profile,
		lastAppliedSnapshot: remote.id,
		lastRemoteEtag: undefined,
		lastFileHashes: fileHashMap(remote),
	});
	ctx.ui.setStatus(STATUS_KEY, undefined);
	if (!options.silent) {
		ctx.ui.notify(`Pulled ${remote.files.length} files from ${remote.id}. Backup: ${backup}`, "info");
	}
	if (options.reload) await maybeReload(ctx);
}

async function syncBoth(ctx: ExtensionCommandContext | ExtensionContext, options: CommandOptions) {
	const config = await loadConfig();
	const client = new S3Client(config);
	const state = await readState(config.profile);
	const local = await createSnapshot(config.profile);
	const remote = await readRemoteSnapshot(client, config);
	const localChanged = hasLocalChanges(local, state);
	const remoteChanged = remote ? remote.id !== state.lastAppliedSnapshot : false;
	const firstSync = !state.lastAppliedSnapshot;

	if (firstSync && remote && local.files.length > 0) {
		if (!sameHashes(fileHashMap(local), fileHashMap(remote))) {
			throw new Error("Remote settings exist and this machine has different local Pi settings. Run /pisync diff, then manually choose /pisync pull or /pisync push.");
		}
		await writeState(config.profile, {
			version: VERSION,
			profile: config.profile,
			lastAppliedSnapshot: remote.id,
			lastRemoteEtag: undefined,
			lastFileHashes: fileHashMap(remote),
		});
		if (!options.silent) ctx.ui.notify("pi-sync state initialized; local settings already match remote.", "info");
		return;
	}
	if (localChanged && remoteChanged && state.lastAppliedSnapshot) {
		throw new Error("Both local and remote changed. Run /pisync diff and resolve with push --force or pull --force.");
	}
	if (remoteChanged) {
		await pull(ctx, options);
		return;
	}
	if (localChanged || !remote) {
		await push(ctx, options);
		return;
	}
	if (!options.silent) ctx.ui.notify("pi-sync is already up to date.", "info");
}

async function history(ctx: ExtensionCommandContext) {
	const config = await loadConfig();
	const client = new S3Client(config);
	const remote = await client.getJson<{ snapshots?: LatestPointer[] }>(historyKey(config));
	if (remote.missing || !remote.value?.snapshots?.length) {
		ctx.ui.notify("No remote pi-sync history found.", "info");
		return;
	}

	ctx.ui.notify(
		remote.value.snapshots
			.slice(-20)
			.reverse()
			.map((item) => `${item.snapshot} ${item.createdAt} ${item.machine}`)
			.join("\n"),
		"info",
	);
}

async function rollback(ctx: ExtensionCommandContext, options: CommandOptions) {
	const target = options.args[0];
	if (!target) throw new Error("Usage: /pisync rollback <snapshot-id> [--yes]");

	const config = await loadConfig();
	const client = new S3Client(config);
	const snapshot = await client.getBuffer(snapshotKey(config, target));
	if (!snapshot.value) throw new Error(`Snapshot not found: ${target}`);
	const remote = await decodeSnapshot(snapshot.value);

	if (!options.yes && !(await ctx.ui.confirm("Rollback pi settings?", formatSnapshotOnlyDiff("Rollback would apply", remote)))) {
		ctx.ui.notify("Rollback cancelled.", "info");
		return;
	}

	const backup = await backupLocal(config.profile);
	await applySnapshot(remote);
	const pointer = pointerFor(config, remote, sha256(snapshot.value));
	await client.putJson(latestKey(config), pointer);
	await updateHistory(client, config, pointer);
	await writeState(config.profile, {
		version: VERSION,
		profile: config.profile,
		lastAppliedSnapshot: remote.id,
		lastRemoteEtag: undefined,
		lastFileHashes: fileHashMap(remote),
	});
	ctx.ui.notify(`Rolled back to ${remote.id}. Backup: ${backup}`, "info");
	await maybeReload(ctx);
}

async function unlock(ctx: ExtensionCommandContext, options: CommandOptions) {
	const lock = await readLock();
	if (!lock) {
		ctx.ui.notify("No pi-sync lock is present.", "info");
		return;
	}
	if (!options.stale && !isStaleLock(lock)) {
		ctx.ui.notify("Lock is not stale. Use /pisync unlock --stale only after verifying no sync is running.", "warning");
		return;
	}
	await fs.rm(lockPath(), { force: true });
	ctx.ui.notify("Removed stale pi-sync lock.", "info");
}

async function maybeReload(ctx: ExtensionCommandContext | ExtensionContext) {
	if (!("reload" in ctx)) return;
	if (ctx.hasUI && (await ctx.ui.confirm("Reload Pi resources now?", "This reloads extensions, skills, prompts, themes, and context files."))) {
		await ctx.reload();
	}
}

async function withLock<T>(command: string, fn: () => Promise<T>): Promise<T> {
	await ensureStateDir();
	const lock: LockFile = {
		id: randomUUID(),
		pid: process.pid,
		command,
		startedAt: new Date().toISOString(),
	};
	let handle: fs.FileHandle | undefined;
	try {
		handle = await fs.open(lockPath(), "wx");
		await handle.writeFile(JSON.stringify(lock, null, "\t"));
		await handle.close();
		handle = undefined;
		return await fn();
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EEXIST") {
			const current = await readLock();
			if (current && isStaleLock(current)) {
				throw new Error(`pi-sync lock is stale (pid ${current.pid}). Run /pisync unlock --stale, then retry.`);
			}
			throw new Error(`pi-sync is already running${current ? ` (${current.command}, pid ${current.pid}, started ${current.startedAt})` : ""}.`);
		}
		throw error;
	} finally {
		await handle?.close();
		const current = await readLock();
		if (current?.id === lock.id) await fs.rm(lockPath(), { force: true });
	}
}

async function loadConfig(): Promise<SyncConfig> {
	const partial = await loadPartialConfig();
	const endpoint = partial.endpoint;
	const bucket = partial.bucket;
	const accessKeyId = partial.accessKeyId;
	const secretAccessKey = partial.secretAccessKey;
	const missing = [
		["endpoint", endpoint],
		["bucket", bucket],
		["accessKeyId", accessKeyId],
		["secretAccessKey", secretAccessKey],
	]
		.filter(([, value]) => !value)
		.map(([name]) => name);
	if (missing.length > 0) {
		throw new Error(`Missing pi-sync config: ${missing.join(", ")}. Run /pisync init or set PI_SYNC_* environment variables.`);
	}

	return {
		endpoint: endpoint!,
		bucket: bucket!,
		region: partial.region ?? DEFAULT_REGION,
		accessKeyId: accessKeyId!,
		secretAccessKey: secretAccessKey!,
		sessionToken: partial.sessionToken,
		profile: partial.profile ?? DEFAULT_PROFILE,
		prefix: trimSlashes(partial.prefix ?? DEFAULT_PREFIX),
	};
}

async function loadPartialConfig(): Promise<PartialConfig> {
	const fileConfig = (await readJsonIfExists<PartialConfig>(localConfigPath())) ?? {};
	return {
		...fileConfig,
		endpoint: process.env.PI_SYNC_ENDPOINT ?? process.env.R2_ENDPOINT ?? fileConfig.endpoint,
		bucket: process.env.PI_SYNC_BUCKET ?? process.env.R2_BUCKET ?? fileConfig.bucket,
		region: process.env.PI_SYNC_REGION ?? process.env.AWS_REGION ?? fileConfig.region,
		accessKeyId: process.env.PI_SYNC_ACCESS_KEY_ID ?? process.env.AWS_ACCESS_KEY_ID ?? fileConfig.accessKeyId,
		secretAccessKey: process.env.PI_SYNC_SECRET_ACCESS_KEY ?? process.env.AWS_SECRET_ACCESS_KEY ?? fileConfig.secretAccessKey,
		sessionToken: selectSessionToken(fileConfig.sessionToken),
		profile: process.env.PI_SYNC_PROFILE ?? fileConfig.profile,
		prefix: process.env.PI_SYNC_PREFIX ?? fileConfig.prefix,
		autoSync: process.env.PI_SYNC_AUTO_SYNC ?? fileConfig.autoSync,
	};
}

async function createSnapshot(profile: string): Promise<Snapshot> {
	const files = await collectFiles(agentDir());
	return {
		version: VERSION,
		id: snapshotId(),
		createdAt: new Date().toISOString(),
		machine: os.hostname(),
		profile,
		files,
	};
}

async function collectFiles(root: string): Promise<SnapshotFile[]> {
	const results: SnapshotFile[] = [];
	for (const entry of await fs.readdir(root, { withFileTypes: true })) {
		if (entry.isFile() && TOP_LEVEL_FILES.has(entry.name)) {
			await addFile(results, root, entry.name);
		} else if (entry.isDirectory() && TOP_LEVEL_DIRS.has(entry.name)) {
			await collectDirectory(results, root, entry.name);
		}
	}
	return results.sort((left, right) => left.path.localeCompare(right.path));
}

async function collectDirectory(results: SnapshotFile[], root: string, relativeDirectory: string) {
	const absoluteDirectory = path.join(root, relativeDirectory);
	for (const entry of await fs.readdir(absoluteDirectory, { withFileTypes: true })) {
		const relativePath = posixJoin(relativeDirectory, entry.name);
		if (isDeniedPath(relativePath)) continue;
		if (entry.isDirectory()) {
			await collectDirectory(results, root, relativePath);
		} else if (entry.isFile()) {
			await addFile(results, root, relativePath);
		}
	}
}

async function addFile(results: SnapshotFile[], root: string, relativePath: string) {
	if (isDeniedPath(relativePath)) return;
	const absolutePath = safeJoin(root, relativePath);
	const content = await fs.readFile(absolutePath);
	results.push({ path: relativePath, contentBase64: content.toString("base64"), sha256: sha256(content) });
}

export function isDeniedPath(relativePath: string) {
	const normalized = toPosix(relativePath);
	const base = path.posix.basename(normalized).toLowerCase();
	return (
		normalized.includes("/node_modules/") ||
		normalized.includes("/.git/") ||
		normalized.includes("/.pisync/") ||
		base === ".env" ||
		base.startsWith(".env.") ||
		base.endsWith(".env") ||
		base.includes("secret") ||
		base.includes("token") ||
		base === "pi-sync.local.json"
	);
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

async function uploadSnapshot(
	client: S3Client,
	config: SyncConfig,
	snapshot: Snapshot,
	latest: RemoteObject<LatestPointer>,
	force: boolean,
) {
	const encoded = await encodeSnapshot(snapshot);
	const pointer = pointerFor(config, snapshot, sha256(encoded));
	await client.putBuffer(snapshotKey(config, snapshot.id), encoded, "application/gzip");
	const current = await client.getJson<LatestPointer>(latestKey(config));
	if (!force && remoteIdentity(current) !== remoteIdentity(latest)) {
		throw new Error("Remote changed while pushing. Run /pisync pull first, then retry.");
	}
	await client.putJson(latestKey(config), pointer);
	const verified = await client.getJson<LatestPointer>(latestKey(config));
	if (verified.value?.snapshot !== pointer.snapshot) {
		throw new Error("Remote latest changed immediately after push. Run /pisync status before continuing.");
	}
	return pointer;
}

async function readRemoteSnapshot(client: S3Client, config: SyncConfig) {
	const latest = await client.getJson<LatestPointer>(latestKey(config));
	if (latest.missing || !latest.value) return undefined;
	const object = await client.getBuffer(snapshotKey(config, latest.value.snapshot));
	if (!object.value) throw new Error(`Remote latest points to missing snapshot: ${latest.value.snapshot}`);
	if (sha256(object.value) !== latest.value.sha256) throw new Error("Remote snapshot checksum mismatch.");
	return decodeSnapshot(object.value);
}

async function encodeSnapshot(snapshot: Snapshot) {
	return gzipAsync(Buffer.from(JSON.stringify(snapshot), "utf8"));
}

async function decodeSnapshot(buffer: Buffer): Promise<Snapshot> {
	const decoded = await gunzipAsync(buffer);
	const parsed = JSON.parse(decoded.toString("utf8")) as Snapshot;
	if (parsed.version !== VERSION || !Array.isArray(parsed.files)) throw new Error("Unsupported snapshot format.");
	return parsed;
}

async function applySnapshot(snapshot: Snapshot) {
	const root = agentDir();
	const current = await createSnapshot(snapshot.profile);
	const plan = preflightSnapshotApply(root, snapshot, current);
	await preflightSnapshotMutations(root, plan);
	for (const target of plan.deletes) {
		await fs.rm(target, { force: true, recursive: true });
	}
	for (const item of plan.writes) {
		await fs.writeFile(item.target, item.content);
	}
}

export function preflightSnapshotApply(root: string, snapshot: Snapshot, current: Snapshot) {
	const seenPaths = new Set<string>();
	const remotePaths = new Set<string>();
	const writes: Array<{ target: string; content: Buffer }> = [];
	const deletes: string[] = [];

	for (const file of snapshot.files) {
		const normalized = toPosix(file.path);
		if (!normalized || normalized.startsWith("../") || path.posix.isAbsolute(normalized)) {
			throw new Error(`Unsafe path in snapshot: ${file.path}`);
		}
		if (seenPaths.has(normalized)) throw new Error(`Duplicate path in snapshot: ${normalized}`);
		seenPaths.add(normalized);
		remotePaths.add(normalized);

		const target = safeJoin(root, normalized);
		const content = decodeBase64Strict(file.contentBase64, normalized);
		if (sha256(content) !== file.sha256) throw new Error(`Checksum mismatch in snapshot file: ${normalized}`);
		writes.push({ target, content });
	}

	const deletePaths = new Set<string>();
	for (const file of current.files) {
		const normalized = toPosix(file.path);
		if (!remotePaths.has(normalized)) deletePaths.add(safeJoin(root, normalized));
		for (const remotePath of remotePaths) {
			if (normalized.startsWith(`${remotePath}/`)) deletePaths.add(safeJoin(root, remotePath));
		}
	}
	deletes.push(...deletePaths);

	return { writes, deletes };
}

function decodeBase64Strict(value: string, filePath: string) {
	if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value) || value.length % 4 !== 0) {
		throw new Error(`Invalid base64 content in snapshot file: ${filePath}`);
	}
	return Buffer.from(value, "base64");
}

async function backupLocal(profile: string) {
	const snapshot = await createSnapshot(profile);
	const backupDirectory = path.join(stateDir(), "backups");
	await fs.mkdir(backupDirectory, { recursive: true });
	const backupPath = path.join(backupDirectory, `${snapshot.id}.json.gz`);
	await fs.writeFile(backupPath, await encodeSnapshot(snapshot));
	return backupPath;
}

async function updateHistory(client: S3Client, config: SyncConfig, pointer: LatestPointer) {
	const object = await client.getJson<{ version: number; snapshots: LatestPointer[] }>(historyKey(config));
	const snapshots = object.value?.snapshots ?? [];
	const next = [
		...snapshots.filter((snapshot) => snapshot.snapshot !== pointer.snapshot),
		pointer,
	].slice(-100);
	await client.putJson(historyKey(config), { version: VERSION, snapshots: next });
}

function formatDiff(local: Snapshot, remote: Snapshot) {
	const localMap = fileHashMap(local);
	const remoteMap = fileHashMap(remote);
	const allPaths = [...new Set([...Object.keys(localMap), ...Object.keys(remoteMap)])].sort();
	const lines = [`local: ${local.files.length} files`, `remote: ${remote.id} (${remote.files.length} files)`, ""];
	let changed = 0;
	for (const filePath of allPaths) {
		if (!localMap[filePath]) {
			lines.push(`+ ${filePath}`);
			changed += 1;
		} else if (!remoteMap[filePath]) {
			lines.push(`- ${filePath}`);
			changed += 1;
		} else if (localMap[filePath] !== remoteMap[filePath]) {
			lines.push(`~ ${filePath}`);
			changed += 1;
		}
	}
	if (changed === 0) lines.push("No file differences.");
	return lines.join("\n");
}

function formatSnapshotOnlyDiff(title: string, snapshot: Snapshot) {
	return [`${title}: ${snapshot.id}`, ...snapshot.files.map((file) => `+ ${file.path}`)].join("\n");
}

function formatPushSummary(local: Snapshot, latest: RemoteObject<LatestPointer>) {
	return [
		`Upload ${local.files.length} files from ${agentDir()}.`,
		latest.value ? `Remote latest: ${latest.value.snapshot}` : "Remote latest: empty",
		"Possible secrets were scanned before this prompt.",
	].join("\n");
}

function hasLocalChanges(local: Snapshot, state: SyncState) {
	return !sameHashes(fileHashMap(local), state.lastFileHashes);
}

function remoteChangedSinceState(latest: RemoteObject<LatestPointer>, state: SyncState) {
	if (latest.missing) return Boolean(state.lastAppliedSnapshot);
	return latest.value?.snapshot !== state.lastAppliedSnapshot;
}

function remoteIdentity(remote: RemoteObject<LatestPointer>) {
	return remote.missing ? "missing" : (remote.value?.snapshot ?? "unknown");
}

function sameHashes(left: Record<string, string>, right: Record<string, string>) {
	const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
	for (const key of keys) {
		if (left[key] !== right[key]) return false;
	}
	return true;
}

function fileHashMap(snapshot: Snapshot) {
	return Object.fromEntries(snapshot.files.map((file) => [file.path, file.sha256]));
}

async function readState(profile: string): Promise<SyncState> {
	return (
		(await readJsonIfExists<SyncState>(statePath(profile))) ?? {
			version: VERSION,
			profile,
			lastFileHashes: {},
		}
	);
}

async function writeState(profile: string, state: SyncState) {
	await writeJson(statePath(profile), state);
}

class S3Client {
	private config: SyncConfig;
	private endpoint: URL;
	private omitSessionTokenAfterRejection = false;

	constructor(config: SyncConfig) {
		this.config = config;
		this.endpoint = new URL(config.endpoint);
	}

	async getJson<T>(key: string): Promise<RemoteObject<T>> {
		const object = await this.request("GET", key);
		if (object.status === 404) return { missing: true };
		if (!object.ok) throw new Error(`S3 GET failed (${object.status}): ${await object.text()}`);
		return { value: (await object.json()) as T, etag: normalizeEtag(object.headers.get("etag")), missing: false };
	}

	async getBuffer(key: string): Promise<RemoteObject<Buffer>> {
		const object = await this.request("GET", key);
		if (object.status === 404) return { missing: true };
		if (!object.ok) throw new Error(`S3 GET failed (${object.status}): ${await object.text()}`);
		return { value: Buffer.from(await object.arrayBuffer()), etag: normalizeEtag(object.headers.get("etag")), missing: false };
	}

	async putJson(key: string, value: unknown) {
		const body = Buffer.from(JSON.stringify(value, null, "\t"), "utf8");
		await this.putBuffer(key, body, "application/json");
	}

	async putBuffer(key: string, body: Buffer, contentType: string) {
		const headers: Record<string, string> = { "content-type": contentType };
		const response = await this.request("PUT", key, body, headers);
		if (!response.ok) throw new Error(`S3 PUT failed (${response.status}): ${await response.text()}`);
	}

	private async request(
		method: "GET" | "PUT",
		key: string,
		body?: Buffer,
		extraHeaders: Record<string, string> = {},
	) {
		const url = new URL(this.endpoint.toString());
		url.pathname = posixJoin(url.pathname, this.config.bucket, encodeKey(key));
		const send = async (sessionToken: string | undefined) => {
			const headers = await signedHeaders({
				method,
				url,
				body,
				extraHeaders,
				accessKeyId: this.config.accessKeyId,
				secretAccessKey: this.config.secretAccessKey,
				sessionToken,
				region: this.config.region,
			});
			return fetch(url, { method, headers, body: body ? new Uint8Array(body) : undefined });
		};
		const sessionToken = this.omitSessionTokenAfterRejection ? undefined : this.config.sessionToken;
		const response = await send(sessionToken);
		if (!(await this.shouldRetryWithoutSessionToken(response, sessionToken))) return response;

		const retry = await send(undefined);
		if (retry.ok || retry.status === 404) this.omitSessionTokenAfterRejection = true;
		return retry;
	}

	private async shouldRetryWithoutSessionToken(response: Response, sessionToken: string | undefined) {
		if (
			!sessionToken ||
			!isCloudflareR2Endpoint(this.config.endpoint) ||
			response.ok ||
			response.status !== 400
		) {
			return false;
		}
		return isSecurityTokenInvalidArgument(await response.clone().text());
	}
}

async function signedHeaders(input: {
	method: string;
	url: URL;
	body?: Buffer;
	extraHeaders: Record<string, string>;
	accessKeyId: string;
	secretAccessKey: string;
	sessionToken?: string;
	region: string;
}) {
	const now = new Date();
	const amzDate = iso8601Basic(now);
	const dateStamp = amzDate.slice(0, 8);
	const payloadHash = sha256(input.body ?? Buffer.alloc(0));
	const headers: Record<string, string> = {
		...lowercaseKeys(input.extraHeaders),
		host: input.url.host,
		"x-amz-content-sha256": payloadHash,
		"x-amz-date": amzDate,
	};
	if (input.sessionToken) headers["x-amz-security-token"] = input.sessionToken;
	const signedHeaderNames = Object.keys(headers).sort();
	const canonicalHeaders = signedHeaderNames.map((name) => `${name}:${headers[name]?.trim()}\n`).join("");
	const canonicalRequest = [
		input.method,
		input.url.pathname,
		input.url.searchParams.toString(),
		canonicalHeaders,
		signedHeaderNames.join(";"),
		payloadHash,
	].join("\n");
	const scope = `${dateStamp}/${input.region}/s3/aws4_request`;
	const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256(Buffer.from(canonicalRequest))].join("\n");
	const signingKey = hmac(
		hmac(hmac(hmac(Buffer.from(`AWS4${input.secretAccessKey}`), dateStamp), input.region), "s3"),
		"aws4_request",
	);
	const signature = createHmac("sha256", signingKey).update(stringToSign).digest("hex");
	return {
		...headers,
		authorization: `AWS4-HMAC-SHA256 Credential=${input.accessKeyId}/${scope}, SignedHeaders=${signedHeaderNames.join(";")}, Signature=${signature}`,
	};
}

function hmac(key: Buffer, value: string) {
	return createHmac("sha256", key).update(value).digest();
}

function sha256(value: Buffer) {
	return createHash("sha256").update(value).digest("hex");
}

function latestKey(config: SyncConfig) {
	return posixJoin(profilePrefix(config), "latest.json");
}

function historyKey(config: SyncConfig) {
	return posixJoin(profilePrefix(config), "history.json");
}

function snapshotKey(config: SyncConfig, id: string) {
	return posixJoin(profilePrefix(config), "snapshots", `${id}.json.gz`);
}

function profilePrefix(config: SyncConfig) {
	return posixJoin(config.prefix, "profiles", config.profile);
}

function pointerFor(config: SyncConfig, snapshot: Snapshot, checksum: string): LatestPointer {
	return {
		version: VERSION,
		profile: config.profile,
		snapshot: snapshot.id,
		sha256: checksum,
		createdAt: snapshot.createdAt,
		machine: snapshot.machine,
	};
}

function agentDir() {
	return path.join(os.homedir(), ".pi", "agent");
}

function stateDir() {
	return path.join(agentDir(), ".pisync");
}

function localConfigPath() {
	return path.join(agentDir(), "pi-sync.local.json");
}

function statePath(profile: string) {
	return path.join(stateDir(), `${safeName(profile)}.state.json`);
}

function lockPath() {
	return path.join(stateDir(), "lock");
}

async function ensureStateDir() {
	await fs.mkdir(stateDir(), { recursive: true });
}

async function readLock() {
	return readJsonIfExists<LockFile>(lockPath());
}

function isStaleLock(lock: LockFile) {
	if (!Number.isInteger(lock.pid) || lock.pid <= 0) return true;
	try {
		process.kill(lock.pid, 0);
		return false;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ESRCH") return true;
		return Date.now() - Date.parse(lock.startedAt) > LOCK_STALE_MS;
	}
}

async function readJsonIfExists<T>(filePath: string): Promise<T | undefined> {
	try {
		return JSON.parse(await fs.readFile(filePath, "utf8")) as T;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}

async function writeJson(filePath: string, value: unknown) {
	await fs.mkdir(path.dirname(filePath), { recursive: true });
	await fs.writeFile(filePath, `${JSON.stringify(value, null, "\t")}\n`);
}

async function preflightSnapshotMutations(
	root: string,
	plan: { deletes: string[]; writes: Array<{ target: string; content: Buffer }> },
) {
	const deletePaths = new Set(plan.deletes);
	for (const target of plan.deletes) {
		await assertNoSymlinkParents(root, target);
	}
	for (const item of plan.writes) {
		await prepareSnapshotWrite(root, item.target, deletePaths);
	}
}

async function prepareSnapshotWrite(root: string, target: string, deletePaths: Set<string>) {
	await ensureSafeDirectory(root, path.dirname(target));
	try {
		const stat = await fs.lstat(target);
		if (stat.isSymbolicLink()) throw new Error(`Refusing to overwrite symlink during snapshot apply: ${target}`);
		if (stat.isDirectory() && !deletePaths.has(target)) {
			throw new Error(`Refusing to overwrite directory during snapshot apply: ${target}`);
		}
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
}

async function ensureSafeDirectory(root: string, directory: string) {
	assertWithinRoot(root, directory);
	const rootPath = path.resolve(root);
	const relative = path.relative(rootPath, path.resolve(directory));
	let current = rootPath;
	for (const part of relative.split(path.sep).filter(Boolean)) {
		current = path.join(current, part);
		try {
			const stat = await fs.lstat(current);
			if (stat.isSymbolicLink()) throw new Error(`Refusing to follow symlink during snapshot apply: ${current}`);
			if (!stat.isDirectory()) throw new Error(`Snapshot path parent is not a directory: ${current}`);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			await fs.mkdir(current);
		}
	}
}

async function assertNoSymlinkParents(root: string, target: string) {
	assertWithinRoot(root, target);
	const rootPath = path.resolve(root);
	const relative = path.relative(rootPath, path.resolve(target));
	let current = rootPath;
	const parts = relative.split(path.sep).filter(Boolean);
	for (const part of parts.slice(0, -1)) {
		current = path.join(current, part);
		try {
			const stat = await fs.lstat(current);
			if (stat.isSymbolicLink()) throw new Error(`Refusing to follow symlink during snapshot apply: ${current}`);
			if (!stat.isDirectory()) throw new Error(`Snapshot path parent is not a directory: ${current}`);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
			throw error;
		}
	}
}

export function safeJoin(root: string, relativePath: string) {
	const target = path.resolve(root, relativePath);
	assertWithinRoot(root, target, relativePath);
	return target;
}

function assertWithinRoot(root: string, target: string, label = target) {
	const resolvedRoot = path.resolve(root);
	const resolvedTarget = path.resolve(target);
	if (resolvedTarget !== resolvedRoot && !resolvedTarget.startsWith(`${resolvedRoot}${path.sep}`)) {
		throw new Error(`Unsafe path in snapshot: ${label}`);
	}
}

export function splitArgs(input: string) {
	return input.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g)?.map((arg) => arg.replace(/^['"]|['"]$/g, "")) ?? [];
}

export function parseOptions(args: string[]): CommandOptions {
	return {
		yes: args.includes("--yes") || args.includes("-y"),
		force: args.includes("--force"),
		stale: args.includes("--stale"),
		silent: false,
		reload: true,
		auto: false,
		args: args.filter((arg) => !arg.startsWith("-")),
	};
}

function usage() {
	return [
		"Usage: /pisync <command>",
		"Commands: init, config, status, diff, doctor, push, pull, sync, history, rollback <snapshot>, unlock --stale",
		"Config: set PI_SYNC_ENDPOINT, PI_SYNC_BUCKET, PI_SYNC_ACCESS_KEY_ID, PI_SYNC_SECRET_ACCESS_KEY, optional PI_SYNC_SESSION_TOKEN (ignored for R2)/region/profile/prefix, or edit ~/.pi/agent/pi-sync.local.json.",
	].join("\n");
}

function snapshotId() {
	return `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
}

function iso8601Basic(date: Date) {
	return date.toISOString().replace(/[:-]|\.\d{3}/g, "");
}

export function encodeKey(key: string) {
	return key.split("/").map(encodeURIComponent).join("/");
}

export function posixJoin(...parts: string[]) {
	return parts.map((part) => trimSlashes(part)).filter(Boolean).join("/");
}

function toPosix(value: string) {
	return value.split(path.sep).join("/");
}

function trimSlashes(value: string) {
	return value.replace(/^\/+|\/+$/g, "");
}

export function safeName(value: string) {
	return value.replace(/[^A-Za-z0-9._-]/g, "_");
}

function lowercaseKeys(value: Record<string, string>) {
	return Object.fromEntries(Object.entries(value).map(([key, item]) => [key.toLowerCase(), item]));
}

function normalizeEtag(value: string | null) {
	return value ?? undefined;
}

function redact(value: string) {
	return value.length <= 8 ? "configured" : `${value.slice(0, 4)}…${value.slice(-4)}`;
}

function selectSessionToken(fileSessionToken: string | undefined) {
	if (hasEnv("PI_SYNC_SESSION_TOKEN")) return normalizeOptionalString(process.env.PI_SYNC_SESSION_TOKEN);
	return normalizeOptionalString(process.env.AWS_SESSION_TOKEN) ?? normalizeOptionalString(fileSessionToken);
}

export function sessionTokenWarnings(config: { endpoint?: string; sessionToken?: string }) {
	if (!isCloudflareR2Endpoint(config.endpoint) || !config.sessionToken) return [];
	return [
		"session token: configured for Cloudflare R2; if R2 rejects X-Amz-Security-Token, pi-sync retries once without it. R2 static access keys usually do not need a session token.",
	];
}

function isSecurityTokenInvalidArgument(text: string) {
	return (
		text.includes("<Code>InvalidArgument</Code>") &&
		text.includes("<Message>X-Amz-Security-Token</Message>")
	);
}

export function isCloudflareR2Endpoint(endpoint: string | undefined) {
	const value = endpoint?.trim();
	if (!value) return false;
	try {
		const hostname = new URL(value).hostname.toLowerCase();
		return hostname === "r2.cloudflarestorage.com" || hostname.endsWith(".r2.cloudflarestorage.com");
	} catch {
		return false;
	}
}

function normalizeOptionalString(value: string | undefined) {
	const normalized = value?.trim();
	return normalized ? normalized : undefined;
}

function hasEnv(name: string) {
	return Object.prototype.hasOwnProperty.call(process.env, name);
}

export function isEnabled(value: boolean | string | undefined, defaultValue: boolean) {
	if (value === undefined) return defaultValue;
	if (typeof value === "boolean") return value;
	return !["0", "false", "no", "off"].includes(value.trim().toLowerCase());
}

function isMissingConfigError(error: unknown) {
	return error instanceof Error && error.message.startsWith("Missing pi-sync config:");
}

function errorMessage(error: unknown) {
	return error instanceof Error ? error.message : String(error);
}
