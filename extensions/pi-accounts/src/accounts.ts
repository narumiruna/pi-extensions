import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
	AccountStore,
	consumeMigrationNotice,
	defineOwn,
	defineOwnMap,
	getOwnCredential,
	normalizeStoredCredential,
	parseAccountName,
	type StoredOAuthCredential,
} from "./account-store.js";
import {
	type AccountProviderAdapter,
	type AccountProviderId,
	createBuiltinProviderAdapters,
	createOAuthInteraction,
	SUPPORTED_PROVIDER_IDS,
} from "./oauth.js";
import {
	type EnsureActiveProviderAuthResult,
	RUNTIME_FAIL_CLOSED_API_KEY,
	RuntimeAuthCoordinator,
	redactTokenText,
} from "./runtime-auth.js";

export {
	ACCOUNTS_FILE,
	AccountStore,
	type AccountsData,
	InMemoryAccountStorageBackend,
	LEGACY_CODEX_ACCOUNTS_FILE,
	migrateLegacyCodexAccountsFile,
	type ProviderAccountsData,
	parseAccountName,
	parseAccountsData,
	type StoredOAuthCredential,
} from "./account-store.js";

export const ACCOUNTS_STATUS_KEY = "accounts";
export const FAIL_CLOSED_API_KEY = RUNTIME_FAIL_CLOSED_API_KEY;
export const DEFAULT_PI_LOGIN_LABEL = "(default pi login)";

export type CommandArgumentCompletion = {
	value: string;
	label: string;
	description?: string;
};

export type AccountsDependencies = {
	store?: AccountStore;
	providers?: readonly AccountProviderAdapter[];
	closeCodexWebSockets?: (sessionId?: string) => unknown | Promise<unknown>;
};

export default function accountsExtension(
	pi: ExtensionAPI,
	dependencies: AccountsDependencies = {},
): void {
	const store = dependencies.store ?? new AccountStore();
	let migrationNotice = dependencies.store ? undefined : consumeMigrationNotice();
	const providers = [
		...(dependencies.providers ??
			createBuiltinProviderAdapters({ closeCodexWebSockets: dependencies.closeCodexWebSockets })),
	];
	validateProviderSet(providers);
	const adapters = new Map(providers.map((provider) => [provider.id, provider]));
	const coordinators = new Map(
		providers.map((provider) => [provider.id, new RuntimeAuthCoordinator(pi, provider)]),
	);
	const results = new Map<AccountProviderId, EnsureActiveProviderAuthResult>();
	const appliedIdentities = new Map<AccountProviderId, string>();
	const abortProviders = new Set<AccountProviderId>();
	const syncTasks = new Map<AccountProviderId, Promise<EnsureActiveProviderAuthResult>>();

	const syncProvider = (
		providerId: AccountProviderId,
		ctx: ExtensionContext,
		model = ctx.model,
	): Promise<EnsureActiveProviderAuthResult> => {
		let task!: Promise<EnsureActiveProviderAuthResult>;
		task = (async () => {
			const adapter = requireAdapter(adapters, providerId);
			const coordinator = coordinators.get(providerId);
			if (!coordinator) throw new Error(`Missing runtime coordinator for ${providerId}.`);
			let result = await coordinator.ensureActive(ctx, store);
			let latest = syncTasks.get(providerId);
			if (latest && latest !== task) return latest;
			try {
				const identity = await authIdentity(store, result);
				latest = syncTasks.get(providerId);
				if (latest && latest !== task) return latest;
				const previousIdentity = appliedIdentities.get(providerId);
				const shouldInvalidate =
					previousIdentity !== identity &&
					!(previousIdentity === undefined && identity === "default");
				if (shouldInvalidate) {
					await adapter.invalidateConnections?.(ctx.sessionManager.getSessionId());
					latest = syncTasks.get(providerId);
					if (latest && latest !== task) return latest;
				}
				appliedIdentities.set(providerId, identity);
			} catch (error) {
				latest = syncTasks.get(providerId);
				if (latest && latest !== task) return latest;
				const credential = await selectedCredential(store, providerId, result);
				latest = syncTasks.get(providerId);
				if (latest && latest !== task) return latest;
				result = await coordinator.forceFailClosed(
					ctx,
					result.status === "inactive" ? "unknown" : result.accountName,
					error,
					credential,
				);
			}
			latest = syncTasks.get(providerId);
			if (latest && latest !== task) return latest;
			results.set(providerId, result);
			updateStatus(ctx, results, model);
			return result;
		})();
		syncTasks.set(providerId, task);
		return task;
	};

	const syncAll = async (ctx: ExtensionContext): Promise<void> => {
		for (const provider of providers) {
			const result = await syncProvider(provider.id, ctx);
			if (result.status === "error") {
				ctx.ui.notify(
					`${provider.displayName} account "${result.accountName}" failed closed: ${result.message}`,
					"error",
				);
			}
		}
		updateStatus(ctx, results);
	};

	const accountCommand = createAccountCommand(pi, store, adapters, syncProvider);
	pi.registerCommand("account", accountCommand);
	registerCodexCompatibilityCommands(pi, store, adapters, syncProvider);

	pi.on("session_start", async (_event, ctx) => {
		if (migrationNotice) {
			ctx.ui.notify(migrationNotice, "warning");
			migrationNotice = undefined;
		}
		await syncAll(ctx);
	});

	pi.on("model_select", async (event, ctx) => {
		const providerId = toProviderId(event.model.provider);
		if (providerId) await syncProvider(providerId, ctx, event.model);
		else updateStatus(ctx, results, event.model);
	});

	pi.on("before_agent_start", async (_event, ctx) => {
		abortProviders.clear();
		const providerId = toProviderId(ctx.model?.provider);
		if (!providerId) return;
		try {
			const result = await syncProvider(providerId, ctx);
			const coordinator = coordinators.get(providerId);
			if (result.status === "error") abortProviders.add(providerId);
			if (
				result.status === "active" &&
				ctx.model &&
				coordinator &&
				!coordinator.isModelAvailable(ctx.model.id)
			) {
				abortProviders.add(providerId);
				ctx.ui.notify(
					`${requireAdapter(adapters, providerId).displayName} model ${ctx.model.id} is not available to account "${result.accountName}".`,
					"error",
				);
			}
		} catch (error) {
			abortProviders.add(providerId);
			throw error;
		}
	});

	pi.on("turn_start", (_event, ctx) => {
		const providerId = toProviderId(ctx.model?.provider);
		if (!providerId || !abortProviders.has(providerId)) return;
		abortProviders.delete(providerId);
		ctx.abort();
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		abortProviders.clear();
		await Promise.allSettled(
			[...coordinators.values()].map(async (coordinator) => {
				coordinator.invalidate(ctx);
				await coordinator.clear(ctx);
			}),
		);
		setStatus(ctx, undefined);
	});
}

function createAccountCommand(
	pi: ExtensionAPI,
	store: AccountStore,
	adapters: Map<AccountProviderId, AccountProviderAdapter>,
	syncProvider: (
		providerId: AccountProviderId,
		ctx: ExtensionContext,
	) => Promise<EnsureActiveProviderAuthResult>,
) {
	return {
		description: "Manage named subscription OAuth accounts",
		getArgumentCompletions: (prefix: string) => completeAccountArguments(prefix, store),
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const [subcommand, providerArg, ...rest] = splitArguments(args);
			if (subcommand === "list") {
				const providerId = providerArg ? parseProviderId(providerArg) : undefined;
				if (providerArg && !providerId) return notifyUnsupportedProvider(ctx, providerArg);
				await listAccounts(ctx, store, adapters, providerId);
				return;
			}
			if (!subcommand || !["login", "switch", "remove"].includes(subcommand)) {
				ctx.ui.notify(
					"Usage: /account list [provider] | login <provider> <name> | switch <provider> [name] | remove <provider> <name>",
					"warning",
				);
				return;
			}
			const providerId = providerArg ? parseProviderId(providerArg) : undefined;
			if (!providerId) return notifyUnsupportedProvider(ctx, providerArg ?? "");
			const adapter = requireAdapter(adapters, providerId);
			const nameArg = rest.join(" ").trim();
			if (subcommand === "login") {
				await loginAccount(pi, ctx, store, adapter, nameArg, syncProvider);
				return;
			}
			if (subcommand === "switch") {
				await switchAccount(ctx, store, adapter, nameArg, syncProvider);
				return;
			}
			await removeAccount(ctx, store, adapter, nameArg, syncProvider);
		},
	};
}

function registerCodexCompatibilityCommands(
	pi: ExtensionAPI,
	store: AccountStore,
	adapters: Map<AccountProviderId, AccountProviderAdapter>,
	syncProvider: (
		providerId: AccountProviderId,
		ctx: ExtensionContext,
	) => Promise<EnsureActiveProviderAuthResult>,
): void {
	const adapter = requireAdapter(adapters, "openai-codex");
	pi.registerCommand("codex-login", {
		description: "Compatibility alias for /account login openai-codex",
		handler: async (args, ctx) => loginAccount(pi, ctx, store, adapter, args, syncProvider),
	});
	pi.registerCommand("codex-account", {
		description: "Compatibility alias for /account switch openai-codex",
		getArgumentCompletions: (prefix) =>
			completeProviderAccounts(prefix, store, "openai-codex", true),
		handler: async (args, ctx) => switchAccount(ctx, store, adapter, args, syncProvider),
	});
	pi.registerCommand("codex-logout", {
		description: "Compatibility alias for /account remove openai-codex",
		getArgumentCompletions: (prefix) =>
			completeProviderAccounts(prefix, store, "openai-codex", false),
		handler: async (args, ctx) => removeAccount(ctx, store, adapter, args, syncProvider),
	});
}

async function loginAccount(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	store: AccountStore,
	adapter: AccountProviderAdapter,
	nameArg: string,
	syncProvider: (
		providerId: AccountProviderId,
		ctx: ExtensionContext,
	) => Promise<EnsureActiveProviderAuthResult>,
): Promise<void> {
	const parsed = parseAccountName(nameArg);
	if (!parsed.ok) return ctx.ui.notify(parsed.error, "warning");
	if (isDefaultPiLoginArg(parsed.name)) {
		ctx.ui.notify('"default" is reserved for Pi\'s built-in login.', "warning");
		return;
	}
	if (!ctx.hasUI) {
		ctx.ui.notify("Account login requires interactive UI.", "error");
		return;
	}
	ctx.ui.notify(`Starting ${adapter.displayName} login for "${parsed.name}".`, "info");
	try {
		const credential = normalizeStoredCredential(
			await adapter.oauth.login(createOAuthInteraction(ctx, adapter.displayName)),
			parsed.name,
		);
		await store.updateProvider(adapter.id, (state) => ({
			active: parsed.name,
			accounts: defineOwn(state.accounts, parsed.name, credential),
		}));
		const result = await syncProvider(adapter.id, ctx);
		await selectDefaultModelIfUnknown(pi, ctx, adapter);
		ctx.ui.notify(
			formatActivationMessage("Logged in", adapter, parsed.name, result),
			result.status === "active" ? "info" : "error",
		);
	} catch (error) {
		ctx.ui.notify(
			`${adapter.displayName} login failed: ${redactTokenText(errorMessage(error))}`,
			"error",
		);
	}
}

async function switchAccount(
	ctx: ExtensionCommandContext,
	store: AccountStore,
	adapter: AccountProviderAdapter,
	nameArg: string,
	syncProvider: (
		providerId: AccountProviderId,
		ctx: ExtensionContext,
	) => Promise<EnsureActiveProviderAuthResult>,
): Promise<void> {
	let name = nameArg.trim();
	if (!name) {
		const state = await store.readProviderAsync(adapter.id);
		const names = Object.keys(state.accounts).sort();
		if (!ctx.hasUI) {
			ctx.ui.notify(
				`${adapter.displayName} accounts: ${[DEFAULT_PI_LOGIN_LABEL, ...names].join(", ")}. Use /account switch ${adapter.id} <name>.`,
				"info",
			);
			return;
		}
		const selected = await ctx.ui.select(`Select ${adapter.displayName} account:`, [
			DEFAULT_PI_LOGIN_LABEL,
			...names,
		]);
		if (!selected) return;
		name = selected;
	}
	if (isDefaultPiLoginArg(name)) {
		await store.updateProvider(adapter.id, (state) => ({ ...state, active: undefined }));
		const result = await syncProvider(adapter.id, ctx);
		if (result.status === "error") {
			ctx.ui.notify(
				`Could not restore default Pi ${adapter.displayName} login; requests will fail closed: ${result.message}`,
				"error",
			);
			return;
		}
		ctx.ui.notify(`Using default Pi ${adapter.displayName} login.`, "info");
		return;
	}
	const parsed = parseAccountName(name);
	if (!parsed.ok) return ctx.ui.notify(parsed.error, "warning");
	let found = false;
	await store.updateProvider(adapter.id, (state) => {
		if (!getOwnCredential(state.accounts, parsed.name)) return state;
		found = true;
		return { ...state, active: parsed.name };
	});
	if (!found) {
		ctx.ui.notify(`${adapter.displayName} account "${parsed.name}" was not found.`, "warning");
		return;
	}
	const result = await syncProvider(adapter.id, ctx);
	ctx.ui.notify(
		formatActivationMessage("Activated", adapter, parsed.name, result),
		result.status === "active" ? "info" : "error",
	);
}

async function removeAccount(
	ctx: ExtensionCommandContext,
	store: AccountStore,
	adapter: AccountProviderAdapter,
	nameArg: string,
	syncProvider: (
		providerId: AccountProviderId,
		ctx: ExtensionContext,
	) => Promise<EnsureActiveProviderAuthResult>,
): Promise<void> {
	const parsed = parseAccountName(nameArg);
	if (!parsed.ok) return ctx.ui.notify(parsed.error, "warning");
	let removed = false;
	let removedActive = false;
	await store.updateProvider(adapter.id, (state) => {
		if (!getOwnCredential(state.accounts, parsed.name)) return state;
		removed = true;
		removedActive = state.active === parsed.name;
		const accounts = defineOwnMap(state.accounts);
		delete accounts[parsed.name];
		return { active: removedActive ? undefined : state.active, accounts };
	});
	if (!removed) {
		ctx.ui.notify(`${adapter.displayName} account "${parsed.name}" was not found.`, "warning");
		return;
	}
	if (removedActive) {
		const result = await syncProvider(adapter.id, ctx);
		if (result.status === "error") {
			ctx.ui.notify(
				`Removed ${adapter.displayName} account "${parsed.name}", but default auth restoration failed closed: ${result.message}`,
				"error",
			);
			return;
		}
	}
	ctx.ui.notify(`Removed ${adapter.displayName} account "${parsed.name}".`, "info");
}

async function listAccounts(
	ctx: ExtensionCommandContext,
	store: AccountStore,
	adapters: Map<AccountProviderId, AccountProviderAdapter>,
	providerId?: AccountProviderId,
): Promise<void> {
	const ids = providerId ? [providerId] : SUPPORTED_PROVIDER_IDS;
	const lines: string[] = [];
	for (const id of ids) {
		const state = await store.readProviderAsync(id);
		const names = Object.keys(state.accounts).sort();
		const rendered = names.length
			? names.map((name) => (name === state.active ? `${name} (active)` : name)).join(", ")
			: "(none)";
		lines.push(`${requireAdapter(adapters, id).displayName}: ${rendered}`);
	}
	ctx.ui.notify(lines.join("\n"), "info");
}

export function completeAccountArguments(
	argumentPrefix: string,
	store: AccountStore,
): CommandArgumentCompletion[] {
	const hasTrailingSpace = /\s$/.test(argumentPrefix);
	const tokens = splitArguments(argumentPrefix);
	if (hasTrailingSpace) tokens.push("");
	if (tokens.length <= 1) {
		return filterCompletions(
			["list", "login", "switch", "remove"].map((value) => ({ value, label: value })),
			tokens[0] ?? "",
		);
	}
	const subcommand = tokens[0];
	if (!["list", "login", "switch", "remove"].includes(subcommand)) return [];
	if (tokens.length === 2) {
		return prefixCompletionValues(
			subcommand,
			filterCompletions(
				SUPPORTED_PROVIDER_IDS.map((id) => ({ value: id, label: id })),
				tokens[1] ?? "",
			),
		);
	}
	if ((subcommand === "switch" || subcommand === "remove") && tokens.length === 3) {
		const providerId = parseProviderId(tokens[1] ?? "");
		return providerId
			? prefixCompletionValues(
					`${subcommand} ${providerId}`,
					completeProviderAccounts(tokens[2] ?? "", store, providerId, subcommand === "switch"),
				)
			: [];
	}
	return [];
}

function completeProviderAccounts(
	prefix: string,
	store: AccountStore,
	providerId: AccountProviderId,
	includeDefault: boolean,
): CommandArgumentCompletion[] {
	let names: string[] = [];
	try {
		names = Object.keys(store.read().providers[providerId]?.accounts ?? {}).sort();
	} catch {
		return [];
	}
	const items: CommandArgumentCompletion[] = includeDefault
		? [{ value: "default", label: DEFAULT_PI_LOGIN_LABEL, description: "Use Pi's built-in login" }]
		: [];
	for (const name of names) items.push({ value: name, label: name });
	return filterCompletions(items, prefix.trim());
}

function validateProviderSet(providers: readonly AccountProviderAdapter[]): void {
	const ids = new Set<AccountProviderId>();
	for (const provider of providers) {
		if (ids.has(provider.id)) throw new Error(`Duplicate account provider: ${provider.id}`);
		ids.add(provider.id);
	}
	for (const id of SUPPORTED_PROVIDER_IDS) {
		if (!ids.has(id)) throw new Error(`Missing required account provider: ${id}`);
	}
}

function requireAdapter(
	adapters: Map<AccountProviderId, AccountProviderAdapter>,
	providerId: AccountProviderId,
): AccountProviderAdapter {
	const adapter = adapters.get(providerId);
	if (!adapter) throw new Error(`Unsupported account provider: ${providerId}`);
	return adapter;
}

function parseProviderId(value: string): AccountProviderId | undefined {
	return isAccountProviderId(value) ? value : undefined;
}

function toProviderId(value: string | undefined): AccountProviderId | undefined {
	return value && isAccountProviderId(value) ? value : undefined;
}

function isAccountProviderId(value: string): value is AccountProviderId {
	return (SUPPORTED_PROVIDER_IDS as readonly string[]).includes(value);
}

function notifyUnsupportedProvider(ctx: ExtensionCommandContext, provider: string): void {
	ctx.ui.notify(
		`Unsupported account provider "${provider || "(missing)"}". Supported providers: ${SUPPORTED_PROVIDER_IDS.join(", ")}.`,
		"warning",
	);
}

function splitArguments(value: string): string[] {
	return value.trim() ? value.trim().split(/\s+/) : [];
}

function filterCompletions(
	items: CommandArgumentCompletion[],
	prefix: string,
): CommandArgumentCompletion[] {
	return prefix ? items.filter((item) => item.value.startsWith(prefix)) : items;
}

function prefixCompletionValues(
	prefix: string,
	items: CommandArgumentCompletion[],
): CommandArgumentCompletion[] {
	return items.map((item) => ({ ...item, value: `${prefix} ${item.value}` }));
}

function isDefaultPiLoginArg(value: string): boolean {
	const normalized = value.trim().toLowerCase();
	return (
		normalized === "default" || normalized === "--default" || normalized === DEFAULT_PI_LOGIN_LABEL
	);
}

function formatActivationMessage(
	action: "Logged in" | "Activated",
	adapter: AccountProviderAdapter,
	name: string,
	result: EnsureActiveProviderAuthResult,
): string {
	if (
		result.status !== "inactive" &&
		result.accountName !== "unknown" &&
		result.accountName !== name
	) {
		return `${action} ${adapter.displayName} account "${name}" was superseded by "${result.accountName}" before activation.`;
	}
	if (result.status === "error") {
		return `${action} ${adapter.displayName} account "${name}", but authentication failed; requests will fail closed: ${result.message}`;
	}
	if (result.status === "inactive") {
		return `${action} ${adapter.displayName} account "${name}" was superseded before activation.`;
	}
	return `${action} ${adapter.displayName} account "${name}".`;
}

async function selectedCredential(
	store: AccountStore,
	providerId: AccountProviderId,
	result: EnsureActiveProviderAuthResult,
): Promise<StoredOAuthCredential | undefined> {
	if (result.status === "inactive") return undefined;
	try {
		const state = await store.readProviderAsync(providerId);
		return getOwnCredential(state.accounts, result.accountName);
	} catch {
		return undefined;
	}
}

async function authIdentity(
	store: AccountStore,
	result: EnsureActiveProviderAuthResult,
): Promise<string> {
	if (result.status === "inactive") return "default";
	if (result.status === "error") return `error:${result.accountName}`;
	const state = await store.readProviderAsync(result.providerId);
	return `${result.accountName}:${getOwnCredential(state.accounts, result.accountName)?.access ?? "missing"}`;
}

function updateStatus(
	ctx: ExtensionContext,
	results: Map<AccountProviderId, EnsureActiveProviderAuthResult>,
	model = ctx.model,
): void {
	const providerId = toProviderId(model?.provider);
	const result = providerId ? results.get(providerId) : undefined;
	if (!result || result.status === "inactive") {
		setStatus(ctx, undefined);
		return;
	}
	if (result.status === "active") {
		setStatus(ctx, `account:${result.accountName}`);
		return;
	}
	setStatus(ctx, `account:${result.accountName} auth error`);
}

function setStatus(ctx: ExtensionContext, value: string | undefined): void {
	try {
		ctx.ui.setStatus(ACCOUNTS_STATUS_KEY, value);
	} catch (error) {
		if (!isStaleContextError(error)) throw error;
	}
}

async function selectDefaultModelIfUnknown(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	adapter: AccountProviderAdapter,
): Promise<void> {
	if (!adapter.defaultModelId || !isUnknownModel(ctx.model)) return;
	const model = ctx.modelRegistry.find(adapter.id, adapter.defaultModelId);
	if (!model) {
		ctx.ui.notify(
			`Logged in, but ${adapter.id}/${adapter.defaultModelId} was not found.`,
			"warning",
		);
		return;
	}
	if (!(await pi.setModel(model))) {
		ctx.ui.notify(`Logged in, but selecting ${adapter.defaultModelId} failed.`, "warning");
	}
}

function isUnknownModel(model: NonNullable<ExtensionContext["model"]> | undefined): boolean {
	return model?.provider === "unknown" && model.id === "unknown" && model.api === "unknown";
}

function isStaleContextError(error: unknown): boolean {
	return (
		error instanceof Error &&
		error.message.includes("This extension ctx is stale after session replacement or reload")
	);
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
