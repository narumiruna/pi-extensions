import { randomUUID } from "node:crypto";
import {
	chmodSync,
	closeSync,
	constants,
	fchmodSync,
	fstatSync,
	linkSync,
	lstatSync,
	openSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import type { OAuthCredential } from "@earendil-works/pi-ai";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { type AccountProviderId, SUPPORTED_PROVIDER_IDS } from "./oauth.js";
import {
	type AccountStorageBackend,
	FileAccountStorageBackend,
	InMemoryAccountStorageBackend,
} from "./storage.js";

export const ACCOUNTS_FILE = "pi-accounts.json";
export const LEGACY_CODEX_ACCOUNTS_FILE = "pi-codex-accounts.json";
const OLDEST_CODEX_ACCOUNTS_FILE = "codex-accounts.json";
const ACCOUNT_NAME_RE = /^[A-Za-z0-9._-]{1,64}$/;
const MIGRATION_LOCK_TIMEOUT_MS = 30_000;
const MIGRATION_TEMP_STALE_MS = 30_000;

export type StoredOAuthCredential = OAuthCredential;

export type ProviderAccountsData = {
	active?: string;
	accounts: Record<string, StoredOAuthCredential>;
};

export type AccountsData = {
	version: 1;
	providers: Record<string, ProviderAccountsData>;
};

export class AccountStore {
	private operationTail: Promise<void> = Promise.resolve();

	constructor(private readonly backend: AccountStorageBackend = createDefaultBackend()) {}

	read(): AccountsData {
		return this.backend.withLock((current) => ({ result: parseAccountsData(current) }));
	}

	async readAsync(): Promise<AccountsData> {
		return this.backend.withLockAsync(async (current) => ({ result: parseAccountsData(current) }));
	}

	async write(data: AccountsData): Promise<void> {
		await this.updateAsync(async () => data);
	}

	async update(mutator: (data: AccountsData) => AccountsData): Promise<AccountsData> {
		return this.updateAsync(async (data) => mutator(data));
	}

	async updateAsync(mutator: (data: AccountsData) => Promise<AccountsData>): Promise<AccountsData> {
		return this.serialized(async () =>
			this.backend.withLockAsync(async (current) => {
				const next = await mutator(parseAccountsData(current));
				return { result: normalizeAccountsData(next), next: stringifyAccountsData(next) };
			}),
		);
	}

	async readProviderAsync(providerId: AccountProviderId): Promise<ProviderAccountsData> {
		const data = await this.readAsync();
		return cloneProviderState(data.providers[providerId]);
	}

	async updateProvider(
		providerId: AccountProviderId,
		mutator: (state: ProviderAccountsData) => ProviderAccountsData,
	): Promise<ProviderAccountsData> {
		return this.updateProviderAsync(providerId, async (state) => mutator(state));
	}

	async updateProviderAsync(
		providerId: AccountProviderId,
		mutator: (state: ProviderAccountsData) => Promise<ProviderAccountsData>,
	): Promise<ProviderAccountsData> {
		let updated = emptyProviderState();
		await this.updateAsync(async (data) => {
			updated = normalizeProviderState(
				await mutator(cloneProviderState(data.providers[providerId])),
			);
			return {
				...data,
				providers: defineOwn(data.providers, providerId, updated),
			};
		});
		return updated;
	}

	async writeRawForTest(raw: string): Promise<void> {
		await this.serialized(async () =>
			this.backend.withLockAsync(async () => ({ result: undefined, next: raw })),
		);
	}

	private async serialized<T>(operation: () => Promise<T>): Promise<T> {
		const previous = this.operationTail;
		let release: () => void = () => undefined;
		this.operationTail = new Promise<void>((resolve) => {
			release = resolve;
		});
		await previous;
		try {
			return await operation();
		} finally {
			release();
		}
	}
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

export function parseAccountsData(raw: string | undefined): AccountsData {
	if (!raw?.trim()) return emptyAccountsData();
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw) as unknown;
	} catch {
		throw new Error(`Invalid accounts JSON. Fix or remove ${ACCOUNTS_FILE}.`);
	}
	return normalizeAccountsData(parsed);
}

function normalizeAccountsData(value: unknown): AccountsData {
	if (!isRecord(value)) throw new Error("Invalid accounts data: expected an object.");
	if (value.version !== 1) throw new Error("Invalid accounts data: version must be 1.");
	if (!isRecord(value.providers))
		throw new Error("Invalid accounts data: providers must be an object.");
	const providers = Object.create(null) as Record<string, ProviderAccountsData>;
	for (const [providerId, state] of Object.entries(value.providers)) {
		if (!isAccountProviderId(providerId)) {
			throw new Error(`Invalid accounts data: unsupported provider "${providerId}".`);
		}
		Object.defineProperty(providers, providerId, {
			configurable: true,
			enumerable: true,
			value: normalizeProviderState(state),
			writable: true,
		});
	}
	return { version: 1, providers };
}

function normalizeProviderState(value: unknown): ProviderAccountsData {
	if (!isRecord(value)) throw new Error("Invalid accounts data: provider state must be an object.");
	const active = parseActiveAccount(value.active);
	if (!isRecord(value.accounts))
		throw new Error("Invalid accounts data: accounts must be an object.");
	const accounts = Object.create(null) as Record<string, StoredOAuthCredential>;
	for (const [name, credential] of Object.entries(value.accounts)) {
		const parsedName = parseAccountName(name);
		if (!parsedName.ok) throw new Error(`Invalid accounts data: bad account name "${name}".`);
		Object.defineProperty(accounts, name, {
			configurable: true,
			enumerable: true,
			value: normalizeStoredCredential(credential, name),
			writable: true,
		});
	}
	return active ? { active, accounts } : { accounts };
}

export function normalizeStoredCredential(
	value: unknown,
	accountName: string,
): StoredOAuthCredential {
	const cloned = cloneJsonValue(value, new Set(), `${accountName} credential`);
	if (!isRecord(cloned)) {
		throw new Error(`Invalid accounts data: ${accountName} credential must be an object.`);
	}
	if (cloned.type !== undefined && cloned.type !== "oauth") {
		throw new Error(`Invalid accounts data: ${accountName} credential type must be oauth.`);
	}
	if (typeof cloned.access !== "string" || !cloned.access) {
		throw new Error(`Invalid accounts data: ${accountName} credential is missing access token.`);
	}
	if (typeof cloned.refresh !== "string" || !cloned.refresh) {
		throw new Error(`Invalid accounts data: ${accountName} credential is missing refresh token.`);
	}
	if (typeof cloned.expires !== "number" || !Number.isFinite(cloned.expires)) {
		throw new Error(`Invalid accounts data: ${accountName} credential has invalid expiration.`);
	}
	Object.defineProperty(cloned, "type", {
		configurable: true,
		enumerable: true,
		value: "oauth",
		writable: true,
	});
	return cloned as StoredOAuthCredential;
}

function cloneJsonValue(value: unknown, seen: Set<object>, path: string): unknown {
	if (value === null || typeof value === "string" || typeof value === "boolean") return value;
	if (typeof value === "number") {
		if (Number.isFinite(value)) return value;
		throw new Error(`Invalid accounts data: ${path} is not JSON-safe.`);
	}
	if (typeof value !== "object") {
		throw new Error(`Invalid accounts data: ${path} is not JSON-safe.`);
	}
	if (seen.has(value)) throw new Error(`Invalid accounts data: ${path} is not JSON-safe.`);
	seen.add(value);
	try {
		if (Array.isArray(value)) {
			return value.map((entry, index) => cloneJsonValue(entry, seen, `${path}[${index}]`));
		}
		const prototype = Object.getPrototypeOf(value);
		if (prototype !== Object.prototype && prototype !== null) {
			throw new Error(`Invalid accounts data: ${path} is not JSON-safe.`);
		}
		const result = Object.create(null) as Record<string, unknown>;
		for (const key of Object.keys(value)) {
			const entry = (value as Record<string, unknown>)[key];
			if (entry === undefined) continue;
			Object.defineProperty(result, key, {
				configurable: true,
				enumerable: true,
				value: cloneJsonValue(entry, seen, `${path}.${key}`),
				writable: true,
			});
		}
		return result;
	} finally {
		seen.delete(value);
	}
}

function stringifyAccountsData(data: AccountsData): string {
	return `${JSON.stringify(normalizeAccountsData(data), null, 2)}\n`;
}

export type MigrationResult = {
	status: "missing" | "canonical" | "migrated";
	notice?: string;
};

export async function migrateLegacyCodexAccountsFile(
	legacyPath: string,
	canonicalPath: string,
): Promise<MigrationResult> {
	cleanupStaleMigrationTemps(canonicalPath);
	if (pathEntryExists(canonicalPath)) {
		validateCanonicalAccountsFile(canonicalPath);
		return { status: "canonical" };
	}
	if (!pathEntryExists(legacyPath)) return { status: "missing" };
	enforcePrivateRegularFile(legacyPath);
	const backend = new FileAccountStorageBackend(legacyPath, {
		syncLockTimeoutMs: MIGRATION_LOCK_TIMEOUT_MS,
	});
	return backend.withLockAsync<MigrationResult>(async (raw) => {
		if (pathEntryExists(canonicalPath)) {
			validateCanonicalAccountsFile(canonicalPath);
			return { result: { status: "canonical" as const } };
		}
		const migrated = migrateReleasedCodexData(raw);
		const contents = stringifyAccountsData(migrated);
		try {
			installPrivateFileExclusively(canonicalPath, contents);
		} catch (error) {
			if (hasErrorCode(error, "EEXIST")) {
				validateCanonicalAccountsFile(canonicalPath);
				return { result: { status: "canonical" as const } };
			}
			throw error;
		}
		enforcePrivateRegularFile(legacyPath);
		return {
			result: {
				status: "migrated" as const,
				notice: `${LEGACY_CODEX_ACCOUNTS_FILE} was copied into ${ACCOUNTS_FILE}. The private legacy file was retained for rollback but may become stale after OAuth refresh; do not load both extensions together.`,
			},
		};
	});
}

function migrateReleasedCodexData(raw: string | undefined): AccountsData {
	if (!raw?.trim()) return emptyAccountsData();
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw) as unknown;
	} catch {
		throw new Error(`Invalid legacy Codex accounts JSON in ${LEGACY_CODEX_ACCOUNTS_FILE}.`);
	}
	if (!isRecord(parsed) || !isRecord(parsed.accounts)) {
		throw new Error("Invalid legacy Codex accounts data.");
	}
	const state = normalizeProviderState({ active: parsed.active, accounts: parsed.accounts });
	return {
		version: 1,
		providers: defineOwn(
			Object.create(null) as Record<string, ProviderAccountsData>,
			"openai-codex",
			state,
		),
	};
}

let pendingMigrationNotice: string | undefined;

function createDefaultBackend(): AccountStorageBackend {
	const agentDir = getAgentDir();
	const canonical = join(agentDir, ACCOUNTS_FILE);
	const legacyCandidates = [
		join(agentDir, LEGACY_CODEX_ACCOUNTS_FILE),
		join(agentDir, OLDEST_CODEX_ACCOUNTS_FILE),
	];
	pendingMigrationNotice = undefined;
	for (const legacy of legacyCandidates) {
		if (!pathEntryExists(legacy) && !pathEntryExists(canonical)) continue;
		const result = migrateLegacyCodexAccountsFileSync(legacy, canonical);
		if (result.notice) pendingMigrationNotice = result.notice;
		if (result.status !== "missing") break;
	}
	return new FileAccountStorageBackend(canonical);
}

function migrateLegacyCodexAccountsFileSync(
	legacyPath: string,
	canonicalPath: string,
): MigrationResult {
	cleanupStaleMigrationTemps(canonicalPath);
	if (pathEntryExists(canonicalPath)) {
		validateCanonicalAccountsFile(canonicalPath);
		return { status: "canonical" };
	}
	if (!pathEntryExists(legacyPath)) return { status: "missing" };
	enforcePrivateRegularFile(legacyPath);
	return new FileAccountStorageBackend(legacyPath, {
		syncLockTimeoutMs: MIGRATION_LOCK_TIMEOUT_MS,
	}).withLock<MigrationResult>((raw) => {
		if (pathEntryExists(canonicalPath)) {
			validateCanonicalAccountsFile(canonicalPath);
			return { result: { status: "canonical" as const } };
		}
		const contents = stringifyAccountsData(migrateReleasedCodexData(raw));
		try {
			installPrivateFileExclusively(canonicalPath, contents);
		} catch (error) {
			if (hasErrorCode(error, "EEXIST")) {
				validateCanonicalAccountsFile(canonicalPath);
				return { result: { status: "canonical" as const } };
			}
			throw error;
		}
		enforcePrivateRegularFile(legacyPath);
		return {
			result: {
				status: "migrated" as const,
				notice: `${legacyPath.endsWith(OLDEST_CODEX_ACCOUNTS_FILE) ? OLDEST_CODEX_ACCOUNTS_FILE : LEGACY_CODEX_ACCOUNTS_FILE} was copied into ${ACCOUNTS_FILE}. The private legacy file was retained for rollback but may become stale after OAuth refresh; do not load both extensions together.`,
			},
		};
	});
}

function cleanupStaleMigrationTemps(canonicalPath: string): void {
	const parent = dirname(canonicalPath);
	const prefix = `.${basename(canonicalPath)}.`;
	let names: string[];
	try {
		names = readdirSync(parent);
	} catch (error) {
		if (hasErrorCode(error, "ENOENT")) return;
		throw error;
	}
	for (const name of names) {
		if (!name.startsWith(prefix) || !name.endsWith(".tmp")) continue;
		const candidate = join(parent, name);
		try {
			const info = lstatSync(candidate);
			if (Date.now() - info.mtimeMs >= MIGRATION_TEMP_STALE_MS) rmSync(candidate, { force: true });
		} catch (error) {
			if (!hasErrorCode(error, "ENOENT")) throw error;
		}
	}
}

function installPrivateFileExclusively(filePath: string, contents: string): void {
	const temp = join(dirname(filePath), `.${basename(filePath)}.${randomUUID()}.tmp`);
	try {
		writeFileSync(temp, contents, { encoding: "utf8", flag: "wx", mode: 0o600 });
		chmodSync(temp, 0o600);
		linkSync(temp, filePath);
		chmodSync(filePath, 0o600);
	} finally {
		rmSync(temp, { force: true });
	}
}

function validateCanonicalAccountsFile(filePath: string): void {
	parseAccountsData(readPrivateRegularFile(filePath));
}

function enforcePrivateRegularFile(filePath: string): void {
	readPrivateRegularFile(filePath);
}

function readPrivateRegularFile(filePath: string): string {
	const info = lstatSync(filePath);
	if (!info.isFile() || info.isSymbolicLink()) {
		throw new Error(`Accounts path must be a regular file: ${filePath}`);
	}
	let descriptor: number | undefined;
	try {
		descriptor = openSync(filePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
		if (!fstatSync(descriptor).isFile()) {
			throw new Error(`Accounts path must be a regular file: ${filePath}`);
		}
		fchmodSync(descriptor, 0o600);
		return readFileSync(descriptor, "utf8");
	} finally {
		if (descriptor !== undefined) closeSync(descriptor);
	}
}

function pathEntryExists(filePath: string): boolean {
	try {
		lstatSync(filePath);
		return true;
	} catch (error) {
		if (hasErrorCode(error, "ENOENT")) return false;
		throw error;
	}
}

export function consumeMigrationNotice(): string | undefined {
	const notice = pendingMigrationNotice;
	pendingMigrationNotice = undefined;
	return notice;
}

function emptyAccountsData(): AccountsData {
	return { version: 1, providers: Object.create(null) as Record<string, ProviderAccountsData> };
}

function emptyProviderState(): ProviderAccountsData {
	return { accounts: Object.create(null) as Record<string, StoredOAuthCredential> };
}

function cloneProviderState(state: ProviderAccountsData | undefined): ProviderAccountsData {
	if (!state) return emptyProviderState();
	return state.active
		? { active: state.active, accounts: defineOwnMap(state.accounts) }
		: { accounts: defineOwnMap(state.accounts) };
}

export function defineOwnMap<T>(source: Record<string, T>): Record<string, T> {
	return Object.assign(Object.create(null), source) as Record<string, T>;
}

export function defineOwn<T>(source: Record<string, T>, name: string, value: T): Record<string, T> {
	const next = defineOwnMap(source);
	Object.defineProperty(next, name, {
		configurable: true,
		enumerable: true,
		value,
		writable: true,
	});
	return next;
}

export function getOwnCredential(
	accounts: Record<string, StoredOAuthCredential>,
	name: string,
): StoredOAuthCredential | undefined {
	return Object.hasOwn(accounts, name) ? accounts[name] : undefined;
}

function parseActiveAccount(value: unknown): string | undefined {
	if (value === undefined || value === null) return undefined;
	if (typeof value !== "string") throw new Error("Invalid accounts data: active must be a string.");
	const parsed = parseAccountName(value);
	if (!parsed.ok) throw new Error("Invalid accounts data: active account name is invalid.");
	return parsed.name;
}

function isAccountProviderId(value: string): value is AccountProviderId {
	return (SUPPORTED_PROVIDER_IDS as readonly string[]).includes(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function hasErrorCode(error: unknown, code: string): boolean {
	return error instanceof Error && "code" in error && error.code === code;
}

export { InMemoryAccountStorageBackend };
