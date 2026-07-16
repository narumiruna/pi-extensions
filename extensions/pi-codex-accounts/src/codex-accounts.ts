import { randomUUID } from "node:crypto";
import {
	chmodSync,
	closeSync,
	linkSync,
	lstatSync,
	openSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import {
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
	getAgentDir,
} from "@earendil-works/pi-coding-agent";
import {
	type CodexOAuthCallbacks,
	type CodexOAuthProvider,
	type DeviceCodeInfo,
	getDefaultCodexOAuthProvider,
	type OAuthCredentials,
	type RefreshOnlyCodexOAuthProvider,
} from "./oauth.js";
import { type CodexAccountStorageBackend, FileCodexAccountStorageBackend } from "./storage.js";

export const CODEX_PROVIDER_ID = "openai-codex";
export const DEFAULT_CODEX_MODEL_ID = "gpt-5.5";
export const CODEX_ACCOUNTS_FILE = "pi-codex-accounts.json";
const LEGACY_CODEX_ACCOUNTS_FILE = "codex-accounts.json";
export const CODEX_ACCOUNTS_STATUS_KEY = "codex-accounts";
export const DEFAULT_PI_LOGIN_LABEL = "(default pi login)";
export const FAIL_CLOSED_API_KEY = "pi-codex-accounts-refresh-failed";

const REFRESH_SKEW_MS = 5 * 60 * 1000;
const MIGRATION_LOCK_TIMEOUT_MS = 30_000;
let pendingAccountsMigrationNotice: string | undefined;
const ACCOUNT_NAME_RE = /^[A-Za-z0-9._-]{1,64}$/;

type RuntimeAuthStorage = {
	setRuntimeApiKey(provider: string, apiKey: string): void | Promise<void>;
	removeRuntimeApiKey(provider: string): void | Promise<void>;
};

type RuntimeOverrideState = {
	appliedApiKey?: string;
	operationTail: Promise<void>;
};

const runtimeOverrideStates = new WeakMap<object, RuntimeOverrideState>();

export type StoredCodexCredential = {
	access: string;
	refresh: string;
	expires: number;
	accountId?: string;
};

export type CodexAccountsData = {
	active?: string;
	accounts: Record<string, StoredCodexCredential>;
};

export type EnsureActiveCodexAuthResult =
	| { status: "inactive" }
	| { status: "active"; accountName: string }
	| { status: "error"; accountName: string; message: string };

export type CommandArgumentCompletion = {
	value: string;
	label: string;
	description?: string;
};

export type CodexAccountsDependencies = {
	store?: CodexAccountStore;
	oauthProvider?: CodexOAuthProvider;
	closeWebSocketSessions?: (sessionId?: string) => unknown;
};

export class CodexAccountStore {
	private readonly backend: CodexAccountStorageBackend;
	private operationTail: Promise<void> = Promise.resolve();

	constructor(
		backend: CodexAccountStorageBackend = new FileCodexAccountStorageBackend(defaultAccountsPath()),
	) {
		this.backend = backend;
	}

	read(): CodexAccountsData {
		return this.backend.withLock((current) => ({ result: parseStoredData(current) }));
	}

	async readAsync(): Promise<CodexAccountsData> {
		return this.backend.withLockAsync(async (current) => ({ result: parseStoredData(current) }));
	}

	async write(data: CodexAccountsData): Promise<void> {
		await this.updateAsync(async () => data);
	}

	async update(
		mutator: (data: CodexAccountsData) => CodexAccountsData,
	): Promise<CodexAccountsData> {
		return this.updateAsync(async (data) => mutator(data));
	}

	async updateAsync(
		mutator: (data: CodexAccountsData) => Promise<CodexAccountsData>,
	): Promise<CodexAccountsData> {
		const previous = this.operationTail;
		let release: () => void = () => undefined;
		this.operationTail = new Promise<void>((resolve) => {
			release = resolve;
		});
		await previous;
		try {
			return await this.backend.withLockAsync(async (current) => {
				const nextData = await mutator(parseStoredData(current));
				return { result: nextData, next: stringifyStoredData(nextData) };
			});
		} finally {
			release();
		}
	}

	async writeRawForTest(raw: string): Promise<void> {
		await this.backend.withLockAsync(async () => ({ result: undefined, next: raw }));
	}
}

export default function codexAccounts(
	pi: ExtensionAPI,
	dependencies: CodexAccountsDependencies = {},
) {
	const store = dependencies.store ?? new CodexAccountStore();
	let migrationNotice = dependencies.store ? undefined : consumeAccountsMigrationNotice();
	const oauthProvider =
		dependencies.oauthProvider ?? getDefaultCodexOAuthProvider(CODEX_PROVIDER_ID);
	// Keep cleanup injectable until WebSocket controls are available through a loader-safe export.
	const closeWebSocketSessions = dependencies.closeWebSocketSessions ?? (() => undefined);
	let appliedAuthIdentity: string | undefined;
	let authIdentityInitialized = false;

	const sync = async (ctx: ExtensionContext, model = ctx.model) => {
		const result = await ensureActiveCodexAuth(ctx, store, { oauthProvider });
		const authIdentity = await getActiveAuthIdentity(store, result);
		if (!authIdentityInitialized || appliedAuthIdentity !== authIdentity) {
			await closeWebSocketSessions(ctx.sessionManager.getSessionId());
			authIdentityInitialized = true;
			appliedAuthIdentity = authIdentity;
		}
		updateStatus(ctx, result, model);
		return result;
	};

	pi.registerCommand("codex-login", {
		description: "Login to a named ChatGPT Codex subscription account",
		handler: async (args, ctx) => {
			const parsedName = parseAccountName(args);
			if (!parsedName.ok) {
				ctx.ui.notify(parsedName.error, "warning");
				return;
			}
			if (!ctx.hasUI) {
				ctx.ui.notify("/codex-login requires interactive UI", "error");
				return;
			}

			try {
				const credentials = await loginCodexAccount(parsedName.name, ctx, oauthProvider);
				await store.update((data) => ({
					active: parsedName.name,
					accounts: { ...data.accounts, [parsedName.name]: normalizeCredential(credentials) },
				}));
				const result = await sync(ctx);
				await selectDefaultCodexModelIfUnknown(pi, ctx);
				ctx.ui.notify(formatActivatedMessage("Logged in", parsedName.name, result), "info");
			} catch (error) {
				ctx.ui.notify(`Codex login failed: ${redactTokenText(errorMessage(error))}`, "error");
			}
		},
	});

	pi.registerCommand("codex-account", {
		description: "Switch active self-managed Codex account or return to default Pi login",
		getArgumentCompletions: (prefix) => completeStoredAccountArguments(prefix, store),
		handler: async (args, ctx) => {
			const trimmed = args.trim();
			if (!trimmed) {
				await showAccountSelector(ctx, store, sync);
				return;
			}

			if (isDefaultPiLoginArg(trimmed)) {
				await clearActiveAccount(ctx, store, sync);
				return;
			}

			const parsedName = parseAccountName(trimmed);
			if (!parsedName.ok) {
				ctx.ui.notify(parsedName.error, "warning");
				return;
			}
			await activateStoredAccount(ctx, store, parsedName.name, sync);
		},
	});

	pi.registerCommand("codex-logout", {
		description: "Remove a self-managed Codex account",
		getArgumentCompletions: (prefix) =>
			completeStoredAccountArguments(prefix, store, {
				includeDefault: false,
			}),
		handler: async (args, ctx) => {
			const parsedName = parseAccountName(args);
			if (!parsedName.ok) {
				ctx.ui.notify(parsedName.error, "warning");
				return;
			}

			let removed = false;
			let removedActive = false;
			await store.update((data) => {
				if (!data.accounts[parsedName.name]) return data;
				removed = true;
				removedActive = data.active === parsedName.name;
				const accounts = { ...data.accounts };
				delete accounts[parsedName.name];
				return { active: removedActive ? undefined : data.active, accounts };
			});
			if (!removed) {
				ctx.ui.notify(`Codex account "${parsedName.name}" was not found.`, "warning");
				return;
			}

			if (removedActive) await sync(ctx);
			ctx.ui.notify(`Removed Codex account "${parsedName.name}".`, "info");
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		if (migrationNotice) {
			ctx.ui.notify(migrationNotice, "warning");
			migrationNotice = undefined;
		}
		await sync(ctx);
	});

	pi.on("model_select", async (event, ctx) => {
		await sync(ctx, event.model);
	});

	pi.on("before_agent_start", async (_event, ctx) => {
		await sync(ctx);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		await clearRuntimeCodexAuth(ctx);
		setStatus(ctx, undefined);
	});
}

export function parseAccountName(
	input: string,
): { ok: true; name: string } | { ok: false; error: string } {
	const name = input.trim();
	if (!name) return { ok: false, error: "Account name is required." };
	if (!ACCOUNT_NAME_RE.test(name)) {
		return {
			ok: false,
			error:
				"Account names must be 1-64 characters using letters, numbers, dot, underscore, or hyphen.",
		};
	}
	return { ok: true, name };
}

export async function ensureActiveCodexAuth(
	ctx: ExtensionContext,
	store: CodexAccountStore,
	options: { oauthProvider?: RefreshOnlyCodexOAuthProvider; now?: number } = {},
): Promise<EnsureActiveCodexAuthResult> {
	const data = await store.readAsync();
	const active = data.active;
	if (!active) {
		await clearRuntimeCodexAuth(ctx);
		return { status: "inactive" };
	}

	let credential = data.accounts[active];
	if (!credential) {
		await store.update((current) => ({ ...current, active: undefined }));
		await clearRuntimeCodexAuth(ctx);
		return { status: "inactive" };
	}

	const oauthProvider = options.oauthProvider ?? getDefaultCodexOAuthProvider(CODEX_PROVIDER_ID);
	if (credential.expires <= (options.now ?? Date.now()) + REFRESH_SKEW_MS) {
		let refreshError: unknown;
		const current = await store.updateAsync(async (latest) => {
			if (latest.active !== active || !latest.accounts[active]) return latest;
			const latestCredential = latest.accounts[active];
			credential = latestCredential;
			if (latestCredential.expires > (options.now ?? Date.now()) + REFRESH_SKEW_MS) {
				return latest;
			}
			try {
				const refreshed = normalizeCredential(await oauthProvider.refreshToken(latestCredential));
				credential = refreshed;
				return {
					...latest,
					accounts: { ...latest.accounts, [active]: refreshed },
				};
			} catch (error) {
				refreshError = error;
				return latest;
			}
		});
		if (current.active !== active) {
			return ensureActiveCodexAuth(ctx, store, options);
		}
		if (refreshError !== undefined) {
			if (!(await activeCredentialMatches(store, active, credential))) {
				return ensureActiveCodexAuth(ctx, store, options);
			}
			await setRuntimeCodexApiKey(ctx, FAIL_CLOSED_API_KEY);
			return {
				status: "error",
				accountName: active,
				message: redactTokenText(errorMessage(refreshError)),
			};
		}
	}

	const apiKey = await oauthProvider.getApiKey(credential);
	if (!(await activeCredentialMatches(store, active, credential))) {
		return ensureActiveCodexAuth(ctx, store, options);
	}
	await setRuntimeCodexApiKey(ctx, apiKey);
	return { status: "active", accountName: active };
}

async function activeCredentialMatches(
	store: CodexAccountStore,
	accountName: string,
	expected: StoredCodexCredential,
): Promise<boolean> {
	const latest = await store.readAsync();
	const current = latest.accounts[accountName];
	return (
		latest.active === accountName &&
		current !== undefined &&
		current.access === expected.access &&
		current.refresh === expected.refresh &&
		current.expires === expected.expires &&
		current.accountId === expected.accountId
	);
}

export function completeStoredAccountArguments(
	argumentPrefix: string,
	store: CodexAccountStore,
	options: { includeDefault?: boolean } = {},
): CommandArgumentCompletion[] {
	const includeDefault = options.includeDefault ?? true;
	let names: string[] = [];
	try {
		names = Object.keys(store.read().accounts).sort();
	} catch {
		return [];
	}

	const items: CommandArgumentCompletion[] = includeDefault
		? [
				{
					value: "default",
					label: DEFAULT_PI_LOGIN_LABEL,
					description: "Use Pi's built-in Codex login",
				},
			]
		: [];
	for (const name of names) items.push({ value: name, label: name });

	const prefix = argumentPrefix.trim();
	return prefix ? items.filter((item) => item.value.startsWith(prefix)) : items;
}

export function isOpenAICodexModel(
	model: Pick<NonNullable<ExtensionContext["model"]>, "provider"> | undefined,
): boolean {
	return model?.provider === CODEX_PROVIDER_ID;
}

function defaultAccountsPath(): string {
	const agentDir = getAgentDir();
	const canonicalPath = join(agentDir, CODEX_ACCOUNTS_FILE);
	const legacyPath = join(agentDir, LEGACY_CODEX_ACCOUNTS_FILE);
	pendingAccountsMigrationNotice = undefined;

	if (pathEntryExists(canonicalPath)) {
		const notices: string[] = [];
		const permissionError = enforcePrivateFilePermissions(canonicalPath);
		if (permissionError) notices.push(permissionError);
		if (readableFileExists(canonicalPath)) {
			if (pathEntryExists(legacyPath)) {
				notices.push(
					`${LEGACY_CODEX_ACCOUNTS_FILE} ignored because ${CODEX_ACCOUNTS_FILE} takes precedence.`,
				);
			}
			pendingAccountsMigrationNotice = notices.length > 0 ? notices.join("\n") : undefined;
			return canonicalPath;
		}
		if (readableFileExists(legacyPath)) {
			const legacyPermissionError = enforcePrivateFilePermissions(legacyPath);
			if (legacyPermissionError) notices.push(legacyPermissionError);
			notices.push(
				`${CODEX_ACCOUNTS_FILE} is unusable; ${LEGACY_CODEX_ACCOUNTS_FILE} will be used for this session.`,
			);
			pendingAccountsMigrationNotice = notices.join("\n");
			return legacyPath;
		}
		pendingAccountsMigrationNotice = notices.length > 0 ? notices.join("\n") : undefined;
		return canonicalPath;
	}
	if (!pathEntryExists(legacyPath)) return canonicalPath;

	try {
		return new FileCodexAccountStorageBackend(legacyPath, {
			syncLockTimeoutMs: MIGRATION_LOCK_TIMEOUT_MS,
		}).withLock(() => {
			const contents = readFileSync(legacyPath, "utf8");
			const permissionError = enforcePrivateFilePermissions(legacyPath);
			if (permissionError) throw new Error(permissionError);
			let installedIdentity: FileIdentity;
			try {
				installedIdentity = installPrivateFileExclusively(canonicalPath, contents);
			} catch (error) {
				if (pathEntryExists(canonicalPath)) {
					pendingAccountsMigrationNotice = `${LEGACY_CODEX_ACCOUNTS_FILE} ignored because ${CODEX_ACCOUNTS_FILE} was created concurrently.`;
					return { result: canonicalPath };
				}
				throw error;
			}
			if (!fileContentsEqual(legacyPath, contents)) {
				if (removeFileIfIdentityMatches(canonicalPath, installedIdentity, contents)) {
					pendingAccountsMigrationNotice = `${LEGACY_CODEX_ACCOUNTS_FILE} changed during migration; the stale ${CODEX_ACCOUNTS_FILE} snapshot was removed and the legacy file will be used for this session.`;
					return { result: legacyPath };
				}
				pendingAccountsMigrationNotice = `${LEGACY_CODEX_ACCOUNTS_FILE} changed during migration, but ${CODEX_ACCOUNTS_FILE} was replaced concurrently and takes precedence.`;
				return { result: canonicalPath };
			}
			try {
				rmSync(legacyPath);
				pendingAccountsMigrationNotice = `Codex accounts migrated from ${LEGACY_CODEX_ACCOUNTS_FILE} to ${CODEX_ACCOUNTS_FILE}.`;
			} catch (error) {
				pendingAccountsMigrationNotice = `Codex accounts migrated to ${CODEX_ACCOUNTS_FILE}, but ${LEGACY_CODEX_ACCOUNTS_FILE} could not be removed: ${errorMessage(error)}.`;
			}
			return { result: canonicalPath };
		});
	} catch (error) {
		if (pathEntryExists(canonicalPath)) {
			pendingAccountsMigrationNotice = `${LEGACY_CODEX_ACCOUNTS_FILE} ignored because ${CODEX_ACCOUNTS_FILE} was created concurrently.`;
			return canonicalPath;
		}
		if (hasErrorCode(error, "ELOCKED")) throw error;
		pendingAccountsMigrationNotice = `Codex accounts migration failed: ${errorMessage(error)}. The legacy file will be used for this session.`;
		return legacyPath;
	}
}

function enforcePrivateFilePermissions(filePath: string): string | undefined {
	try {
		if (lstatSync(filePath).isDirectory()) {
			return `Codex accounts path is a directory and permissions were not changed: ${filePath}`;
		}
		chmodSync(filePath, 0o600);
		return undefined;
	} catch (error) {
		return `Failed to enforce 0600 permissions for ${filePath}: ${errorMessage(error)}`;
	}
}

type FileIdentity = { dev: number; ino: number };

function installPrivateFileExclusively(filePath: string, contents: string): FileIdentity {
	const tempFile = join(dirname(filePath), `.${CODEX_ACCOUNTS_FILE}.${randomUUID()}.tmp`);
	try {
		writeFileSync(tempFile, contents, { encoding: "utf8", flag: "wx", mode: 0o600 });
		chmodSync(tempFile, 0o600);
		const identity = lstatSync(tempFile);
		linkSync(tempFile, filePath);
		return { dev: identity.dev, ino: identity.ino };
	} finally {
		try {
			rmSync(tempFile, { force: true });
		} catch {
			// Preserve the migration result if best-effort temp cleanup fails.
		}
	}
}

function removeFileIfIdentityMatches(
	filePath: string,
	expected: FileIdentity,
	expectedContents: string,
) {
	try {
		const current = lstatSync(filePath);
		if (current.dev !== expected.dev || current.ino !== expected.ino) return false;
		if (readFileSync(filePath, "utf8") !== expectedContents) return false;
		rmSync(filePath);
		return true;
	} catch {
		return false;
	}
}

function fileContentsEqual(filePath: string, expected: string) {
	try {
		return readFileSync(filePath, "utf8") === expected;
	} catch {
		return false;
	}
}

function pathEntryExists(filePath: string): boolean {
	try {
		lstatSync(filePath);
		return true;
	} catch {
		return false;
	}
}

function readableFileExists(filePath: string): boolean {
	let descriptor: number | undefined;
	try {
		if (!statSync(filePath).isFile()) return false;
		descriptor = openSync(filePath, "r");
		return true;
	} catch {
		return false;
	} finally {
		if (descriptor !== undefined) closeSync(descriptor);
	}
}

function consumeAccountsMigrationNotice(): string | undefined {
	const notice = pendingAccountsMigrationNotice;
	pendingAccountsMigrationNotice = undefined;
	return notice;
}

function parseStoredData(raw: string | undefined): CodexAccountsData {
	if (!raw?.trim()) return { accounts: {} };

	let parsed: unknown;
	try {
		parsed = JSON.parse(raw) as unknown;
	} catch {
		throw new Error(`Invalid Codex accounts JSON. Fix or remove ${CODEX_ACCOUNTS_FILE}.`);
	}

	if (!isRecord(parsed)) throw new Error("Invalid Codex accounts data: expected an object.");
	const accounts = parseAccounts(parsed.accounts);
	const active = parseActiveAccount(parsed.active);
	return active ? { active, accounts } : { accounts };
}

function parseAccounts(rawAccounts: unknown): Record<string, StoredCodexCredential> {
	if (rawAccounts === undefined) return {};
	if (!isRecord(rawAccounts))
		throw new Error("Invalid Codex accounts data: accounts must be an object.");

	const accounts: Record<string, StoredCodexCredential> = {};
	for (const [name, rawCredential] of Object.entries(rawAccounts)) {
		const parsedName = parseAccountName(name);
		if (!parsedName.ok) throw new Error(`Invalid Codex accounts data: bad account name "${name}".`);
		accounts[name] = normalizeCredential(rawCredential, name);
	}
	return accounts;
}

function parseActiveAccount(rawActive: unknown): string | undefined {
	if (rawActive === undefined || rawActive === null) return undefined;
	if (typeof rawActive !== "string") {
		throw new Error("Invalid Codex accounts data: active must be a string.");
	}
	const parsed = parseAccountName(rawActive);
	if (!parsed.ok) throw new Error("Invalid Codex accounts data: active account name is invalid.");
	return parsed.name;
}

function stringifyStoredData(data: CodexAccountsData): string {
	return `${JSON.stringify(parseStoredData(JSON.stringify(data)), null, 2)}\n`;
}

function normalizeCredential(
	rawCredential: unknown,
	accountName = "account",
): StoredCodexCredential {
	if (!isRecord(rawCredential)) {
		throw new Error(`Invalid Codex accounts data: ${accountName} credential must be an object.`);
	}
	if (typeof rawCredential.access !== "string" || !rawCredential.access) {
		throw new Error(
			`Invalid Codex accounts data: ${accountName} credential is missing access token.`,
		);
	}
	if (typeof rawCredential.refresh !== "string" || !rawCredential.refresh) {
		throw new Error(
			`Invalid Codex accounts data: ${accountName} credential is missing refresh token.`,
		);
	}
	if (typeof rawCredential.expires !== "number" || !Number.isFinite(rawCredential.expires)) {
		throw new Error(
			`Invalid Codex accounts data: ${accountName} credential has invalid expiration.`,
		);
	}
	const accountId =
		typeof rawCredential.accountId === "string" ? rawCredential.accountId : undefined;
	return accountId
		? {
				access: rawCredential.access,
				refresh: rawCredential.refresh,
				expires: rawCredential.expires,
				accountId,
			}
		: {
				access: rawCredential.access,
				refresh: rawCredential.refresh,
				expires: rawCredential.expires,
			};
}

async function loginCodexAccount(
	name: string,
	ctx: ExtensionCommandContext,
	oauthProvider: CodexOAuthProvider,
): Promise<OAuthCredentials> {
	ctx.ui.notify(`Starting Codex login for "${name}".`, "info");
	const callbacks = {
		onAuth: (info: { url: string; instructions?: string }) => {
			ctx.ui.notify(formatAuthMessage(info.url, info.instructions), "info");
		},
		onDeviceCode: (info: DeviceCodeInfo) => {
			ctx.ui.notify(formatDeviceCodeMessage(info), "info");
		},
		onPrompt: async (prompt: { message: string; placeholder?: string; allowEmpty?: boolean }) => {
			const value = await ctx.ui.input(prompt.message, prompt.placeholder ?? "");
			if ((value === undefined || value === "") && !prompt.allowEmpty) {
				throw new Error("Login cancelled");
			}
			return value ?? "";
		},
		onProgress: (message: string) => ctx.ui.notify(message, "info"),
		onSelect: async (prompt: {
			message: string;
			options: Array<{ id: string; label: string }>;
		}) => {
			const selected = await ctx.ui.select(
				prompt.message,
				prompt.options.map((option) => option.label),
			);
			return prompt.options.find((option) => option.label === selected)?.id;
		},
		signal: ctx.signal,
	} as CodexOAuthCallbacks;

	return oauthProvider.login(callbacks);
}

function formatAuthMessage(url: string, instructions?: string): string {
	return ["Open this URL to login to Codex:", url, instructions].filter(Boolean).join("\n");
}

function formatDeviceCodeMessage(info: DeviceCodeInfo): string {
	return [
		"Open this URL and enter the Codex login code:",
		info.verificationUri,
		`Code: ${info.userCode}`,
	]
		.filter(Boolean)
		.join("\n");
}

async function showAccountSelector(
	ctx: ExtensionCommandContext,
	store: CodexAccountStore,
	sync: (ctx: ExtensionContext) => Promise<EnsureActiveCodexAuthResult>,
): Promise<void> {
	const data = await store.readAsync();
	const names = Object.keys(data.accounts).sort();
	if (!ctx.hasUI) {
		ctx.ui.notify(
			`Codex accounts: ${[DEFAULT_PI_LOGIN_LABEL, ...names].join(", ")}. Use /codex-account <name>.`,
			"info",
		);
		return;
	}

	const selected = await ctx.ui.select("Select Codex account:", [DEFAULT_PI_LOGIN_LABEL, ...names]);
	if (!selected) return;
	if (selected === DEFAULT_PI_LOGIN_LABEL) {
		await clearActiveAccount(ctx, store, sync);
		return;
	}
	await activateStoredAccount(ctx, store, selected, sync);
}

async function activateStoredAccount(
	ctx: ExtensionCommandContext,
	store: CodexAccountStore,
	name: string,
	sync: (ctx: ExtensionContext) => Promise<EnsureActiveCodexAuthResult>,
): Promise<void> {
	let activated = false;
	await store.update((data) => {
		if (!data.accounts[name]) return data;
		activated = true;
		return { ...data, active: name };
	});
	if (!activated) {
		ctx.ui.notify(`Codex account "${name}" was not found.`, "warning");
		return;
	}
	const result = await sync(ctx);
	ctx.ui.notify(
		formatActivatedMessage("Activated", name, result),
		result.status === "error" ? "error" : "info",
	);
}

async function clearActiveAccount(
	ctx: ExtensionCommandContext,
	store: CodexAccountStore,
	sync: (ctx: ExtensionContext) => Promise<EnsureActiveCodexAuthResult>,
): Promise<void> {
	await store.update((data) => ({ ...data, active: undefined }));
	await sync(ctx);
	ctx.ui.notify("Using default Pi Codex login.", "info");
}

function isDefaultPiLoginArg(arg: string): boolean {
	const normalized = arg.trim().toLowerCase();
	return (
		normalized === "default" || normalized === "--default" || normalized === DEFAULT_PI_LOGIN_LABEL
	);
}

async function selectDefaultCodexModelIfUnknown(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
): Promise<void> {
	if (!isUnknownModel(ctx.model)) return;
	const model = ctx.modelRegistry.find(CODEX_PROVIDER_ID, DEFAULT_CODEX_MODEL_ID);
	if (!model) {
		ctx.ui.notify(
			`Logged in, but ${CODEX_PROVIDER_ID}/${DEFAULT_CODEX_MODEL_ID} was not found.`,
			"warning",
		);
		return;
	}
	const ok = await pi.setModel(model);
	if (!ok) ctx.ui.notify(`Logged in, but selecting ${DEFAULT_CODEX_MODEL_ID} failed.`, "warning");
}

function isUnknownModel(model: NonNullable<ExtensionContext["model"]> | undefined): boolean {
	return model?.provider === "unknown" && model.id === "unknown" && model.api === "unknown";
}

function formatActivatedMessage(
	action: "Logged in" | "Activated",
	name: string,
	result: EnsureActiveCodexAuthResult,
): string {
	if (result.status === "error") {
		return `${action} Codex account "${name}", but refresh failed; Codex requests will fail closed: ${result.message}`;
	}
	return `${action} Codex account "${name}".`;
}

async function getActiveAuthIdentity(
	store: CodexAccountStore,
	result: EnsureActiveCodexAuthResult,
): Promise<string> {
	if (result.status === "inactive") return "default";
	if (result.status === "error") return `error:${result.accountName}`;
	const data = await store.readAsync();
	return `${result.accountName}:${data.accounts[result.accountName]?.access ?? "missing"}`;
}

function updateStatus(
	ctx: ExtensionContext,
	result: EnsureActiveCodexAuthResult,
	model = ctx.model,
): void {
	if (!isOpenAICodexModel(model)) {
		setStatus(ctx, undefined);
		return;
	}
	if (result.status === "active") {
		setStatus(ctx, `codex:${result.accountName}`);
		return;
	}
	if (result.status === "error") {
		setStatus(ctx, `codex:${result.accountName} auth error`);
		return;
	}
	setStatus(ctx, undefined);
}

function setStatus(ctx: ExtensionContext, value: string | undefined): void {
	try {
		ctx.ui.setStatus(CODEX_ACCOUNTS_STATUS_KEY, value);
	} catch (error) {
		if (!isStaleExtensionContextError(error)) throw error;
	}
}

async function setRuntimeCodexApiKey(ctx: ExtensionContext, apiKey: string): Promise<void> {
	const target = getRuntimeAuthStorage(ctx);
	if (!target) throw new Error("This Pi version does not expose runtime provider authentication.");
	const state = getRuntimeOverrideState(target);
	await enqueueRuntimeOverrideMutation(state, async () => {
		if (state.appliedApiKey === apiKey) return;
		await target.setRuntimeApiKey(CODEX_PROVIDER_ID, apiKey);
		state.appliedApiKey = apiKey;
	});
}

async function clearRuntimeCodexAuth(ctx: ExtensionContext): Promise<void> {
	const target = getRuntimeAuthStorage(ctx);
	if (!target) return;
	const state = runtimeOverrideStates.get(target);
	if (!state) return;
	await enqueueRuntimeOverrideMutation(state, async () => {
		if (state.appliedApiKey === undefined) return;
		await target.removeRuntimeApiKey(CODEX_PROVIDER_ID);
		state.appliedApiKey = undefined;
	});
}

function getRuntimeOverrideState(target: object): RuntimeOverrideState {
	let state = runtimeOverrideStates.get(target);
	if (!state) {
		state = { operationTail: Promise.resolve() };
		runtimeOverrideStates.set(target, state);
	}
	return state;
}

function enqueueRuntimeOverrideMutation(
	state: RuntimeOverrideState,
	mutate: () => Promise<void>,
): Promise<void> {
	const operation = state.operationTail.then(mutate);
	state.operationTail = operation.catch(() => undefined);
	return operation;
}

function getRuntimeAuthStorage(ctx: ExtensionContext): (RuntimeAuthStorage & object) | undefined {
	const registry = ctx.modelRegistry as unknown as {
		authStorage?: unknown;
		runtime?: unknown;
	};
	for (const candidate of [registry, registry.runtime, registry.authStorage]) {
		if (isRuntimeAuthStorage(candidate)) return candidate;
	}
	return undefined;
}

function isRuntimeAuthStorage(value: unknown): value is RuntimeAuthStorage & object {
	return (
		!!value &&
		typeof value === "object" &&
		"setRuntimeApiKey" in value &&
		typeof value.setRuntimeApiKey === "function" &&
		"removeRuntimeApiKey" in value &&
		typeof value.removeRuntimeApiKey === "function"
	);
}

function isStaleExtensionContextError(error: unknown): boolean {
	return (
		error instanceof Error &&
		error.message.includes("This extension ctx is stale after session replacement or reload")
	);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function hasErrorCode(error: unknown, code: string): boolean {
	return error instanceof Error && "code" in error && error.code === code;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function redactTokenText(text: string): string {
	return text
		.replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer <redacted>")
		.replace(/"access"\s*:\s*"[^"]+"/gi, '"access":"<redacted>"')
		.replace(/"refresh"\s*:\s*"[^"]+"/gi, '"refresh":"<redacted>"')
		.replace(/\b(access|refresh)[_-][A-Za-z0-9._~+/=-]+/gi, "$1-<redacted>");
}
