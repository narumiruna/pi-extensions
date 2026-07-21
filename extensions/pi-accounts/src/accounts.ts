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
	pi.registerCommand("accounts", accountCommand);

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
		description: "Open the interactive subscription account manager",
		handler: async (_args: string, ctx: ExtensionCommandContext) => {
			await showAccountsMenu(pi, ctx, store, adapters, syncProvider);
		},
	};
}

const LOGIN_ACTION = "Login new account";
const REMOVE_ACTION = "Remove account";
const SWITCH_PROVIDER_ACTION = "Switch provider account";
const SWITCH_ANOTHER_PROVIDER_ACTION = "Switch another provider’s account";

type ProviderMenuState = {
	id: AccountProviderId;
	adapter: AccountProviderAdapter;
	active: string | undefined;
	accounts: Record<string, StoredOAuthCredential>;
};

async function showAccountsMenu(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	store: AccountStore,
	adapters: Map<AccountProviderId, AccountProviderAdapter>,
	syncProvider: (
		providerId: AccountProviderId,
		ctx: ExtensionContext,
	) => Promise<EnsureActiveProviderAuthResult>,
): Promise<void> {
	if (!ctx.hasUI) {
		ctx.ui.notify("/accounts requires interactive UI.", "error");
		return;
	}
	const states = await readProviderMenuStates(store, adapters);
	const currentProviderId = toProviderId(ctx.model?.provider);
	const currentState = currentProviderId ? states.get(currentProviderId) : undefined;
	const hasAnyStoredAccount = [...states.values()].some((state) => accountNames(state).length > 0);
	const action = await ctx.ui.select(
		formatAccountsMenuTitle(ctx, states, hasAnyStoredAccount),
		buildAccountsMenuActions(states, currentState, hasAnyStoredAccount),
	);
	if (!action) return;
	if (action === LOGIN_ACTION) {
		await showLoginAccount(pi, ctx, store, adapters, syncProvider);
		return;
	}
	if (action === REMOVE_ACTION) {
		await showRemoveAccount(ctx, store, adapters, syncProvider);
		return;
	}
	if (currentState && action === switchCurrentProviderAction(currentState.adapter)) {
		await showSwitchProviderAccount(ctx, store, currentState.adapter, syncProvider);
		return;
	}
	if (action === SWITCH_ANOTHER_PROVIDER_ACTION || action === SWITCH_PROVIDER_ACTION) {
		const excludeProviderId =
			action === SWITCH_ANOTHER_PROVIDER_ACTION ? currentProviderId : undefined;
		const provider = await selectProviderWithAccounts(ctx, states, excludeProviderId);
		if (provider) await showSwitchProviderAccount(ctx, store, provider.adapter, syncProvider);
	}
}

async function readProviderMenuStates(
	store: AccountStore,
	adapters: Map<AccountProviderId, AccountProviderAdapter>,
): Promise<Map<AccountProviderId, ProviderMenuState>> {
	const states = new Map<AccountProviderId, ProviderMenuState>();
	for (const id of SUPPORTED_PROVIDER_IDS) {
		const state = await store.readProviderAsync(id);
		states.set(id, {
			id,
			adapter: requireAdapter(adapters, id),
			active: state.active,
			accounts: state.accounts,
		});
	}
	return states;
}

function formatAccountsMenuTitle(
	ctx: ExtensionCommandContext,
	states: Map<AccountProviderId, ProviderMenuState>,
	hasAnyStoredAccount: boolean,
): string {
	if (!hasAnyStoredAccount) return "Accounts\n\nNo saved accounts yet.\n\nWhat do you want to do?";
	const activeLines = sortedProviderStates(states).map(
		(state) => `  ${state.adapter.displayName}: ${state.active ?? "default"}`,
	);
	return [
		"Accounts",
		"",
		"Current model:",
		`  ${formatCurrentModel(ctx)}`,
		"",
		"Active accounts:",
		...activeLines,
		"",
		"What do you want to do?",
	].join("\n");
}

function formatCurrentModel(ctx: ExtensionCommandContext): string {
	if (!ctx.model) return "(none)";
	const providerId = toProviderId(ctx.model.provider);
	const providerName = providerId ? providerDisplayName(providerId) : ctx.model.provider;
	return `${providerName} / ${ctx.model.id}`;
}

function buildAccountsMenuActions(
	states: Map<AccountProviderId, ProviderMenuState>,
	currentState: ProviderMenuState | undefined,
	hasAnyStoredAccount: boolean,
): string[] {
	if (!hasAnyStoredAccount) return [LOGIN_ACTION];
	const currentHasAccounts = currentState ? accountNames(currentState).length > 0 : false;
	if (currentState && currentHasAccounts) {
		const actions = [
			switchCurrentProviderAction(currentState.adapter),
			LOGIN_ACTION,
			REMOVE_ACTION,
		];
		if (providerStatesWithAccounts(states, currentState.id).length > 0) {
			actions.push(SWITCH_ANOTHER_PROVIDER_ACTION);
		}
		return actions;
	}
	return [
		LOGIN_ACTION,
		currentState ? SWITCH_ANOTHER_PROVIDER_ACTION : SWITCH_PROVIDER_ACTION,
		REMOVE_ACTION,
	];
}

function switchCurrentProviderAction(adapter: AccountProviderAdapter): string {
	return `Switch ${adapter.displayName} account`;
}

async function showLoginAccount(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	store: AccountStore,
	adapters: Map<AccountProviderId, AccountProviderAdapter>,
	syncProvider: (
		providerId: AccountProviderId,
		ctx: ExtensionContext,
	) => Promise<EnsureActiveProviderAuthResult>,
): Promise<void> {
	const adapter = await selectProvider(
		ctx,
		sortedProviderStates(await readProviderMenuStates(store, adapters)),
	);
	if (!adapter) return;
	const name = await ctx.ui.input(`Name this ${adapter.displayName} account:`, "work");
	if (name === undefined) return;
	await loginAccount(pi, ctx, store, adapter, name, syncProvider);
}

async function showSwitchProviderAccount(
	ctx: ExtensionCommandContext,
	store: AccountStore,
	adapter: AccountProviderAdapter,
	syncProvider: (
		providerId: AccountProviderId,
		ctx: ExtensionContext,
	) => Promise<EnsureActiveProviderAuthResult>,
): Promise<void> {
	const state = await store.readProviderAsync(adapter.id);
	const options = switchAccountOptions(state.active, Object.keys(state.accounts));
	if (options.length <= 1) {
		ctx.ui.notify(`${adapter.displayName} has no saved accounts to switch.`, "info");
		return;
	}
	const selected = await ctx.ui.select(`Switch ${adapter.displayName} account:`, options);
	if (!selected) return;
	const accountName = stripActiveMarker(selected);
	if (accountName === (state.active ?? "default")) {
		ctx.ui.notify(`${adapter.displayName} account "${accountName}" is already active.`, "info");
		return;
	}
	await switchAccount(ctx, store, adapter, accountName, syncProvider);
}

async function selectProviderWithAccounts(
	ctx: ExtensionCommandContext,
	states: Map<AccountProviderId, ProviderMenuState>,
	excludeProviderId?: AccountProviderId,
): Promise<ProviderMenuState | undefined> {
	const candidates = providerStatesWithAccounts(states, excludeProviderId);
	const adapter = await selectProvider(ctx, candidates);
	return adapter ? candidates.find((state) => state.id === adapter.id) : undefined;
}

async function selectProvider(
	ctx: ExtensionCommandContext,
	states: readonly ProviderMenuState[],
): Promise<AccountProviderAdapter | undefined> {
	const labels = states.map((state) => state.adapter.displayName);
	const selected = await ctx.ui.select("Select provider:", labels);
	return states.find((state) => state.adapter.displayName === selected)?.adapter;
}

async function showRemoveAccount(
	ctx: ExtensionCommandContext,
	store: AccountStore,
	adapters: Map<AccountProviderId, AccountProviderAdapter>,
	syncProvider: (
		providerId: AccountProviderId,
		ctx: ExtensionContext,
	) => Promise<EnsureActiveProviderAuthResult>,
): Promise<void> {
	const states = await readProviderMenuStates(store, adapters);
	const options = removeAccountOptions(states, toProviderId(ctx.model?.provider));
	if (options.length === 0) {
		ctx.ui.notify("No saved accounts to remove.", "info");
		return;
	}
	const selected = await ctx.ui.select(
		"Remove account:",
		options.map((option) => option.label),
	);
	const option = options.find((item) => item.label === selected);
	if (!option) return;
	const confirmed = await ctx.ui.confirm(
		"Remove account",
		`Remove ${option.adapter.displayName} account "${option.accountName}"?`,
	);
	if (!confirmed) return;
	await removeAccount(ctx, store, option.adapter, option.accountName, syncProvider);
}

function sortedProviderStates(
	states: Map<AccountProviderId, ProviderMenuState>,
): ProviderMenuState[];
function sortedProviderStates(states: readonly ProviderMenuState[]): ProviderMenuState[];
function sortedProviderStates(
	states: Map<AccountProviderId, ProviderMenuState> | readonly ProviderMenuState[],
): ProviderMenuState[] {
	const values = Array.isArray(states) ? [...states] : [...states.values()];
	return values.sort((left, right) =>
		left.adapter.displayName.localeCompare(right.adapter.displayName),
	);
}

function providerStatesWithAccounts(
	states: Map<AccountProviderId, ProviderMenuState>,
	excludeProviderId?: AccountProviderId,
): ProviderMenuState[] {
	return sortedProviderStates(states).filter(
		(state) => state.id !== excludeProviderId && accountNames(state).length > 0,
	);
}

function accountNames(state: ProviderMenuState): string[] {
	return Object.keys(state.accounts).sort();
}

function switchAccountOptions(activeName: string | undefined, names: string[]): string[] {
	const active = activeName ?? "default";
	const sortedNames = [...names].sort();
	const options = [formatSwitchAccountOption(active, true)];
	for (const name of sortedNames) {
		if (name !== active) options.push(formatSwitchAccountOption(name, false));
	}
	if (active !== "default") options.push(formatSwitchAccountOption("default", false));
	return options;
}

function formatSwitchAccountOption(name: string, active: boolean): string {
	return active ? `✓ ${name}` : name;
}

function stripActiveMarker(value: string): string {
	return value.replace(/^✓\s+/, "");
}

function removeAccountOptions(
	states: Map<AccountProviderId, ProviderMenuState>,
	currentProviderId?: AccountProviderId,
): Array<{ label: string; adapter: AccountProviderAdapter; accountName: string }> {
	const providerStates = providerStatesWithAccounts(states);
	if (currentProviderId) {
		const currentIndex = providerStates.findIndex((state) => state.id === currentProviderId);
		if (currentIndex > 0) {
			const [current] = providerStates.splice(currentIndex, 1);
			if (current) providerStates.unshift(current);
		}
	}
	return providerStates.flatMap((state) =>
		accountNames(state).map((accountName) => ({
			label: `${state.adapter.displayName} · ${accountName}`,
			adapter: state.adapter,
			accountName,
		})),
	);
}

function providerDisplayName(providerId: AccountProviderId): string {
	switch (providerId) {
		case "anthropic":
			return "Anthropic";
		case "github-copilot":
			return "GitHub Copilot";
		case "openai-codex":
			return "OpenAI Codex";
	}
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
	const state = await store.readProviderAsync(adapter.id);
	if (getOwnCredential(state.accounts, parsed.name)) {
		const confirmed = await ctx.ui.confirm(
			"Replace account",
			`${adapter.displayName} account "${parsed.name}" already exists. Replace it?`,
		);
		if (!confirmed) return;
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
				`${adapter.displayName} accounts: ${[DEFAULT_PI_LOGIN_LABEL, ...names].join(", ")}. Use /accounts in interactive mode to switch accounts.`,
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

function toProviderId(value: string | undefined): AccountProviderId | undefined {
	return value && isAccountProviderId(value) ? value : undefined;
}

function isAccountProviderId(value: string): value is AccountProviderId {
	return (SUPPORTED_PROVIDER_IDS as readonly string[]).includes(value);
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
