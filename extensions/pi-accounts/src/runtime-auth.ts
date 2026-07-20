import type { ModelAuth, OAuthCredential } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AccountProviderAdapter, AccountProviderId } from "./oauth.js";

export const RUNTIME_FAIL_CLOSED_API_KEY = "pi-accounts-auth-failed";
const REFRESH_SKEW_MS = 5 * 60 * 1000;

type RuntimeAuthStorage = {
	setRuntimeApiKey(provider: string, apiKey: string): void | Promise<void>;
	removeRuntimeApiKey(provider: string): void | Promise<void>;
};

type RuntimeOverrideState = {
	appliedApiKey?: string;
	generation: number;
	mayHaveOverride: boolean;
	operationTail: Promise<void>;
};

type RuntimeOverrideSnapshot = {
	target: RuntimeAuthStorage & object;
	state: RuntimeOverrideState;
	generation: number;
};

type RuntimeProviderConfig = Parameters<ExtensionAPI["registerProvider"]>[1];

type ProviderAccountState = {
	active?: string;
	accounts: Record<string, OAuthCredential>;
};

export type RuntimeAccountStore = {
	readProviderAsync(providerId: AccountProviderId): Promise<ProviderAccountState>;
	updateProviderAsync(
		providerId: AccountProviderId,
		mutator: (state: ProviderAccountState) => Promise<ProviderAccountState>,
	): Promise<ProviderAccountState>;
};

export type EnsureActiveProviderAuthResult =
	| { status: "inactive"; providerId: AccountProviderId }
	| { status: "active"; providerId: AccountProviderId; accountName: string }
	| { status: "error"; providerId: AccountProviderId; accountName: string; message: string };

export class RuntimeAuthCoordinator {
	private readonly controller: RuntimeApiKeyController;
	private readonly overlay: RuntimeProviderOverlay;
	private availableModelIds: ReadonlySet<string> | undefined;

	constructor(
		pi: ExtensionAPI,
		readonly provider: AccountProviderAdapter,
		private readonly failClosedApiKey = RUNTIME_FAIL_CLOSED_API_KEY,
	) {
		this.controller = new RuntimeApiKeyController(provider.id);
		this.overlay = new RuntimeProviderOverlay(pi, provider, failClosedApiKey);
	}

	async ensureActive(
		ctx: ExtensionContext,
		store: RuntimeAccountStore,
		now = Date.now(),
	): Promise<EnsureActiveProviderAuthResult> {
		const operation = this.overlay.beginOperation();
		const runtimeOverride = this.controller.begin(ctx);
		let state: ProviderAccountState;
		try {
			state = await store.readProviderAsync(this.provider.id);
		} catch (error) {
			return this.failClosed(ctx, operation, runtimeOverride, "unknown", error);
		}
		const active = state.active;
		if (!active) {
			this.availableModelIds = undefined;
			try {
				await this.controller.clear(ctx);
				this.overlay.remove(ctx, operation);
				return { status: "inactive", providerId: this.provider.id };
			} catch (error) {
				return this.failClosed(
					ctx,
					this.overlay.beginOperation(),
					this.controller.begin(ctx),
					"unknown",
					error,
				);
			}
		}

		let credential = getOwnCredential(state.accounts, active);
		if (!credential) {
			let current: ProviderAccountState;
			try {
				current = await store.updateProviderAsync(this.provider.id, async (latest) => {
					if (latest.active !== active || getOwnCredential(latest.accounts, active)) return latest;
					return { ...latest, active: undefined };
				});
			} catch (error) {
				return this.failClosed(ctx, operation, runtimeOverride, active, error);
			}
			if (current.active) return this.ensureActive(ctx, store, now);
			this.availableModelIds = undefined;
			await this.controller.clear(ctx);
			this.overlay.remove(ctx, operation);
			return { status: "inactive", providerId: this.provider.id };
		}

		if (credential.expires <= now + REFRESH_SKEW_MS) {
			let refreshError: unknown;
			let current = state;
			try {
				current = await store.updateProviderAsync(this.provider.id, async (latest) => {
					const latestCredential = getOwnCredential(latest.accounts, active);
					if (latest.active !== active || !latestCredential) return latest;
					credential = latestCredential;
					if (latestCredential.expires > now + REFRESH_SKEW_MS) return latest;
					try {
						const refreshed = await this.provider.oauth.refresh(latestCredential);
						credential = refreshed;
						return {
							...latest,
							accounts: defineOwn(latest.accounts, active, refreshed),
						};
					} catch (error) {
						refreshError = error;
						return latest;
					}
				});
			} catch (error) {
				refreshError = error;
				credential = getOwnCredential(current.accounts, active) ?? credential;
			}
			if (current.active !== active || !getOwnCredential(current.accounts, active)) {
				return this.ensureActive(ctx, store, now);
			}
			if (refreshError !== undefined) {
				const selection = await this.activeCredentialMatches(store, active, credential);
				if (selection.error !== undefined) {
					return this.failClosed(
						ctx,
						operation,
						runtimeOverride,
						active,
						selection.error,
						credential,
					);
				}
				if (!selection.matches) return this.ensureActive(ctx, store, now);
				return this.failClosed(ctx, operation, runtimeOverride, active, refreshError, credential);
			}
		}

		let auth: ModelAuth;
		try {
			auth = await this.provider.oauth.toAuth(credential);
			validateModelAuth(auth, this.provider.displayName);
		} catch (error) {
			const selection = await this.activeCredentialMatches(store, active, credential);
			if (selection.error !== undefined) {
				return this.failClosed(
					ctx,
					operation,
					runtimeOverride,
					active,
					selection.error,
					credential,
				);
			}
			if (!selection.matches) return this.ensureActive(ctx, store, now);
			return this.failClosed(ctx, operation, runtimeOverride, active, error, credential);
		}

		const selection = await this.activeCredentialMatches(store, active, credential);
		if (selection.error !== undefined) {
			return this.failClosed(ctx, operation, runtimeOverride, active, selection.error, credential);
		}
		if (!selection.matches) return this.ensureActive(ctx, store, now);

		try {
			const availableModelIds = readAvailableModelIds(credential);
			if (!this.overlay.apply(ctx, operation, auth, availableModelIds)) {
				return { status: "inactive", providerId: this.provider.id };
			}
			const applied = await this.controller.apply(ctx, runtimeOverride, auth.apiKey);
			if (applied === "stale") return { status: "inactive", providerId: this.provider.id };
			if (applied === "unavailable") {
				throw new Error(`Pi did not retain the runtime ${this.provider.displayName} credential.`);
			}
			await this.verifyOverlay(ctx, auth, availableModelIds);
			this.availableModelIds = availableModelIds ? new Set(availableModelIds) : undefined;
			return { status: "active", providerId: this.provider.id, accountName: active };
		} catch (error) {
			return this.failClosed(ctx, operation, runtimeOverride, active, error, credential);
		}
	}

	isModelAvailable(modelId: string): boolean {
		return !this.availableModelIds || this.availableModelIds.has(modelId);
	}

	async forceFailClosed(
		ctx: ExtensionContext,
		accountName: string,
		error: unknown,
		credential?: OAuthCredential,
	): Promise<EnsureActiveProviderAuthResult> {
		return this.failClosed(
			ctx,
			this.overlay.beginOperation(),
			this.controller.begin(ctx),
			accountName,
			error,
			credential,
		);
	}

	invalidate(ctx: ExtensionContext): void {
		this.overlay.beginOperation();
		this.controller.invalidate(ctx);
	}

	async clear(ctx: ExtensionContext): Promise<void> {
		const operation = this.overlay.beginOperation();
		this.availableModelIds = undefined;
		await this.controller.clear(ctx);
		this.overlay.remove(ctx, operation);
	}

	private async failClosed(
		ctx: ExtensionContext,
		operation: number,
		runtimeOverride: RuntimeOverrideSnapshot | undefined,
		accountName: string,
		error: unknown,
		credential?: OAuthCredential,
	): Promise<EnsureActiveProviderAuthResult> {
		let suffix = "";
		try {
			this.overlay.apply(
				ctx,
				operation,
				{},
				credential ? safelyReadAvailableModelIds(credential) : undefined,
			);
		} catch {
			suffix = " Pi could not apply the fail-closed provider overlay.";
		}
		try {
			const applied = await this.controller.apply(ctx, runtimeOverride, this.failClosedApiKey);
			if (applied === "stale") return { status: "inactive", providerId: this.provider.id };
			if (applied === "unavailable") suffix += " Pi did not accept the fail-closed credential.";
		} catch {
			suffix += " Pi could not apply the fail-closed credential; provider turns will be aborted.";
		}
		const availableModelIds = credential ? safelyReadAvailableModelIds(credential) : undefined;
		this.availableModelIds = availableModelIds ? new Set(availableModelIds) : undefined;
		return {
			status: "error",
			providerId: this.provider.id,
			accountName,
			message: `${credential ? redactCredentialError(error, credential) : redactTokenText(errorMessage(error))}${suffix}`,
		};
	}

	private async activeCredentialMatches(
		store: RuntimeAccountStore,
		accountName: string,
		expected: OAuthCredential,
	): Promise<{ matches: boolean; error?: unknown }> {
		try {
			const latest = await store.readProviderAsync(this.provider.id);
			const current = getOwnCredential(latest.accounts, accountName);
			return {
				matches:
					latest.active === accountName &&
					current !== undefined &&
					JSON.stringify(current) === JSON.stringify(expected),
			};
		} catch (error) {
			return { matches: false, error };
		}
	}

	private async verifyOverlay(
		ctx: ExtensionContext,
		auth: ModelAuth,
		availableModelIds?: readonly string[],
	): Promise<void> {
		const registered = getRegisteredProviderConfig(ctx, this.provider.id);
		if (auth.baseUrl && registered?.baseUrl !== auth.baseUrl) {
			throw new Error(`Pi did not retain the runtime ${this.provider.displayName} endpoint.`);
		}
		if (auth.headers) {
			for (const [name, value] of Object.entries(auth.headers)) {
				if (value !== null && registered?.headers?.[name] !== value) {
					throw new Error(`Pi did not retain the runtime ${this.provider.displayName} headers.`);
				}
				if (value === null && registered?.headers && Object.hasOwn(registered.headers, name)) {
					throw new Error(`Pi did not remove the runtime ${this.provider.displayName} header.`);
				}
			}
		}
		const modelId = availableModelIds?.[0] ?? firstProviderModelId(ctx, this.provider.id);
		const model = modelId ? findProviderModel(ctx, this.provider.id, modelId) : undefined;
		if (model && auth.baseUrl && model.baseUrl !== auth.baseUrl) {
			throw new Error(`Pi did not apply the runtime ${this.provider.displayName} endpoint.`);
		}
		if (model && auth.headers) {
			const resolved = await getApiKeyAndHeaders(ctx, model);
			if (resolved?.ok === false) {
				throw new Error(`Pi could not resolve the runtime ${this.provider.displayName} headers.`);
			}
			for (const [name, value] of Object.entries(auth.headers)) {
				if (value !== null && resolved?.headers?.[name] !== value) {
					throw new Error(`Pi did not apply the runtime ${this.provider.displayName} headers.`);
				}
			}
		}
	}
}

class RuntimeProviderOverlay {
	private generation = 0;
	private owned = false;
	private previous: RuntimeProviderConfig | undefined;
	private applied: RuntimeProviderConfig | undefined;
	private baseModels: NonNullable<RuntimeProviderConfig["models"]> | undefined;

	constructor(
		private readonly pi: ExtensionAPI,
		private readonly provider: AccountProviderAdapter,
		private readonly fallbackApiKey: string,
	) {}

	beginOperation(): number {
		this.generation += 1;
		return this.generation;
	}

	apply(
		ctx: ExtensionContext,
		generation: number,
		auth: ModelAuth,
		availableModelIds?: readonly string[],
	): boolean {
		if (generation !== this.generation) return false;
		const needsOverlay =
			this.provider.requiresApiKeyBridge ||
			auth.baseUrl !== undefined ||
			(auth.headers !== undefined && Object.keys(auth.headers).length > 0) ||
			availableModelIds !== undefined;
		if (!needsOverlay) {
			if (this.owned) this.remove(ctx, generation);
			return true;
		}
		const current = getRegisteredProviderConfig(ctx, this.provider.id);
		if (this.owned && !shallowConfigEqual(current, this.applied)) {
			this.reset();
			throw new Error(
				`${this.provider.displayName} provider configuration changed while pi-accounts owned its auth overlay.`,
			);
		}
		if (!this.owned) {
			this.previous = current;
			this.baseModels = readProviderModels(ctx, this.provider.id);
		}

		const next = this.buildConfig(auth, availableModelIds);
		if (Object.keys(next).length === 0 && !this.owned) return true;
		this.replaceConfig(this.owned ? this.applied : current, next);
		this.owned = true;
		this.applied = next;
		return true;
	}

	remove(ctx: ExtensionContext, generation: number): void {
		if (generation !== this.generation || !this.owned) return;
		const current = getRegisteredProviderConfig(ctx, this.provider.id);
		if (!shallowConfigEqual(current, this.applied)) {
			this.reset();
			return;
		}
		this.pi.unregisterProvider(this.provider.id);
		if (this.previous && Object.keys(this.previous).length > 0) {
			this.pi.registerProvider(this.provider.id, this.previous);
		}
		this.reset();
	}

	private buildConfig(
		auth: ModelAuth,
		availableModelIds?: readonly string[],
	): RuntimeProviderConfig {
		const next: RuntimeProviderConfig = { ...(this.previous ?? {}) };
		if (this.provider.requiresApiKeyBridge) next.apiKey = this.fallbackApiKey;
		if (auth.baseUrl) next.baseUrl = auth.baseUrl;
		if (auth.headers) next.headers = mergeConfigHeaders(this.previous?.headers, auth.headers);
		if (availableModelIds) {
			const allowed = new Set(availableModelIds);
			next.models = (this.baseModels ?? [])
				.filter((model) => allowed.has(model.id))
				.map((model) => (auth.baseUrl ? { ...model, baseUrl: auth.baseUrl } : model));
		}
		return next;
	}

	private replaceConfig(
		fallback: RuntimeProviderConfig | undefined,
		next: RuntimeProviderConfig,
	): void {
		this.pi.unregisterProvider(this.provider.id);
		try {
			if (Object.keys(next).length > 0) this.pi.registerProvider(this.provider.id, next);
		} catch (error) {
			if (fallback && Object.keys(fallback).length > 0) {
				this.pi.registerProvider(this.provider.id, fallback);
			}
			throw error;
		}
	}

	private reset(): void {
		this.owned = false;
		this.previous = undefined;
		this.applied = undefined;
		this.baseModels = undefined;
	}
}

class RuntimeApiKeyController {
	private readonly states = new WeakMap<object, RuntimeOverrideState>();

	constructor(private readonly providerId: string) {}

	begin(ctx: ExtensionContext): RuntimeOverrideSnapshot | undefined {
		const target = getRuntimeAuthStorage(ctx);
		if (!target) return undefined;
		const state = this.getState(target);
		state.generation += 1;
		return { target, state, generation: state.generation };
	}

	async apply(
		ctx: ExtensionContext,
		snapshot: RuntimeOverrideSnapshot | undefined,
		apiKey: string,
	): Promise<"applied" | "stale" | "unavailable"> {
		if (!(await this.set(snapshot, apiKey))) return "stale";
		const matches = await this.matches(ctx, apiKey);
		if (matches !== false) return "applied";
		if (!(await this.set(snapshot, apiKey, true))) return "stale";
		return (await this.matches(ctx, apiKey)) === false ? "unavailable" : "applied";
	}

	invalidate(ctx: ExtensionContext): void {
		const target = getRuntimeAuthStorage(ctx);
		const state = target ? this.states.get(target) : undefined;
		if (state) state.generation += 1;
	}

	async clear(ctx: ExtensionContext): Promise<void> {
		const target = getRuntimeAuthStorage(ctx);
		if (!target) return;
		const state = this.states.get(target);
		if (!state) return;
		state.generation += 1;
		await enqueueMutation(state, async () => {
			if (!state.mayHaveOverride) return;
			await target.removeRuntimeApiKey(this.providerId);
			state.appliedApiKey = undefined;
			state.mayHaveOverride = false;
		});
	}

	private async matches(ctx: ExtensionContext, expected: string): Promise<boolean | undefined> {
		const registry = ctx.modelRegistry as unknown as {
			getApiKeyForProvider?: (provider: string) => Promise<string | undefined>;
		};
		if (typeof registry.getApiKeyForProvider !== "function") return undefined;
		try {
			return (await registry.getApiKeyForProvider(this.providerId)) === expected;
		} catch {
			return false;
		}
	}

	private async set(
		snapshot: RuntimeOverrideSnapshot | undefined,
		apiKey: string,
		force = false,
	): Promise<boolean> {
		if (!snapshot)
			throw new Error("This Pi version does not expose runtime provider authentication.");
		const { generation, state, target } = snapshot;
		return enqueueMutation(state, async () => {
			if (state.generation !== generation) return false;
			if (!force && state.appliedApiKey === apiKey) return true;
			state.appliedApiKey = undefined;
			state.mayHaveOverride = true;
			await target.setRuntimeApiKey(this.providerId, apiKey);
			state.appliedApiKey = apiKey;
			return state.generation === generation;
		});
	}

	private getState(target: object): RuntimeOverrideState {
		let state = this.states.get(target);
		if (!state) {
			state = { generation: 0, mayHaveOverride: false, operationTail: Promise.resolve() };
			this.states.set(target, state);
		}
		return state;
	}
}

function readProviderModels(
	ctx: ExtensionContext,
	providerId: string,
): NonNullable<RuntimeProviderConfig["models"]> {
	const registry = ctx.modelRegistry as unknown as {
		getAll?: () => readonly Record<string, unknown>[];
	};
	const models = typeof registry.getAll === "function" ? registry.getAll() : [];
	return models
		.filter((model) => model.provider === providerId && typeof model.id === "string")
		.map((model) => ({
			id: String(model.id),
			name: typeof model.name === "string" ? model.name : String(model.id),
			...(typeof model.api === "string" ? { api: model.api as never } : {}),
			...(typeof model.baseUrl === "string" ? { baseUrl: model.baseUrl } : {}),
			reasoning: model.reasoning === true,
			...(model.thinkingLevelMap ? { thinkingLevelMap: model.thinkingLevelMap as never } : {}),
			input: Array.isArray(model.input) ? (model.input as ("text" | "image")[]) : ["text"],
			cost: (model.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }) as never,
			contextWindow: typeof model.contextWindow === "number" ? model.contextWindow : 0,
			maxTokens: typeof model.maxTokens === "number" ? model.maxTokens : 0,
			...(model.headers ? { headers: model.headers as Record<string, string> } : {}),
			...(model.compat ? { compat: model.compat as never } : {}),
		}));
}

function mergeConfigHeaders(
	previous: Record<string, string> | undefined,
	headers: Record<string, string | null>,
): Record<string, string> {
	const result = { ...(previous ?? {}) };
	for (const [name, value] of Object.entries(headers)) {
		if (value === null) delete result[name];
		else result[name] = value;
	}
	return result;
}

function validateModelAuth(
	auth: unknown,
	providerName: string,
): asserts auth is ModelAuth & { apiKey: string } {
	if (!isRecord(auth)) throw new Error(`${providerName} OAuth returned invalid request auth.`);
	if (typeof auth.apiKey !== "string" || !auth.apiKey) {
		throw new Error(`${providerName} OAuth returned no API key.`);
	}
	if (auth.baseUrl !== undefined) {
		if (typeof auth.baseUrl !== "string") {
			throw new Error(`${providerName} OAuth returned an invalid endpoint.`);
		}
		let endpoint: URL;
		try {
			endpoint = new URL(auth.baseUrl);
		} catch {
			throw new Error(`${providerName} OAuth returned an invalid endpoint.`);
		}
		if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password) {
			throw new Error(`${providerName} OAuth returned an unsafe endpoint.`);
		}
	}
	if (auth.headers !== undefined) {
		if (!isRecord(auth.headers)) {
			throw new Error(`${providerName} OAuth returned invalid headers.`);
		}
		for (const [name, value] of Object.entries(auth.headers)) {
			if (!name || /[\r\n]/.test(name) || (value !== null && typeof value !== "string")) {
				throw new Error(`${providerName} OAuth returned invalid headers.`);
			}
			if (typeof value === "string" && /[\r\n]/.test(value)) {
				throw new Error(`${providerName} OAuth returned invalid headers.`);
			}
		}
	}
}

function readAvailableModelIds(credential: OAuthCredential): string[] | undefined {
	if (!Object.hasOwn(credential, "availableModelIds")) return undefined;
	const value = credential.availableModelIds;
	if (
		!Array.isArray(value) ||
		value.length > 1_000 ||
		!value.every((id) => typeof id === "string" && id.length > 0 && id.length <= 256)
	) {
		throw new Error("OAuth credential has invalid availableModelIds metadata.");
	}
	return [...new Set(value)];
}

function safelyReadAvailableModelIds(credential: OAuthCredential): string[] | undefined {
	try {
		return readAvailableModelIds(credential);
	} catch {
		return undefined;
	}
}

function firstProviderModelId(ctx: ExtensionContext, providerId: string): string | undefined {
	return readProviderModels(ctx, providerId)[0]?.id;
}

function findProviderModel(
	ctx: ExtensionContext,
	providerId: string,
	modelId: string,
): { provider: string; id: string; baseUrl?: string } | undefined {
	const registry = ctx.modelRegistry as unknown as {
		find?: (
			provider: string,
			id: string,
		) => { provider: string; id: string; baseUrl?: string } | undefined;
	};
	return typeof registry.find === "function" ? registry.find(providerId, modelId) : undefined;
}

async function getApiKeyAndHeaders(
	ctx: ExtensionContext,
	model: { provider: string; id: string; baseUrl?: string },
): Promise<
	| { ok: true; apiKey?: string; headers?: Record<string, string> }
	| { ok: false; error: string }
	| undefined
> {
	const registry = ctx.modelRegistry as unknown as {
		getApiKeyAndHeaders?: (
			candidate: unknown,
		) => Promise<
			{ ok: true; apiKey?: string; headers?: Record<string, string> } | { ok: false; error: string }
		>;
	};
	return typeof registry.getApiKeyAndHeaders === "function"
		? registry.getApiKeyAndHeaders(model)
		: undefined;
}

function defineOwn(
	accounts: Record<string, OAuthCredential>,
	name: string,
	credential: OAuthCredential,
): Record<string, OAuthCredential> {
	const next = Object.assign(Object.create(null), accounts) as Record<string, OAuthCredential>;
	Object.defineProperty(next, name, {
		configurable: true,
		enumerable: true,
		value: credential,
		writable: true,
	});
	return next;
}

function getOwnCredential(
	accounts: Record<string, OAuthCredential>,
	name: string,
): OAuthCredential | undefined {
	return Object.hasOwn(accounts, name) ? accounts[name] : undefined;
}

function getRegisteredProviderConfig(
	ctx: ExtensionContext,
	providerId: string,
): RuntimeProviderConfig | undefined {
	const registry = ctx.modelRegistry as unknown as {
		getRegisteredProviderConfig?: (provider: string) => RuntimeProviderConfig | undefined;
		registeredProviders?: Map<string, RuntimeProviderConfig>;
	};
	if (typeof registry.getRegisteredProviderConfig === "function") {
		return registry.getRegisteredProviderConfig(providerId);
	}
	return registry.registeredProviders instanceof Map
		? registry.registeredProviders.get(providerId)
		: undefined;
}

function shallowConfigEqual(
	left: RuntimeProviderConfig | undefined,
	right: RuntimeProviderConfig | undefined,
): boolean {
	if (left === right) return true;
	if (!left || !right) return !left && !right;
	const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
	for (const key of keys) {
		if (
			!Object.is(
				(left as unknown as Record<string, unknown>)[key],
				(right as unknown as Record<string, unknown>)[key],
			)
		)
			return false;
	}
	return true;
}

function enqueueMutation<T>(state: RuntimeOverrideState, mutate: () => Promise<T>): Promise<T> {
	const operation = state.operationTail.then(mutate);
	state.operationTail = operation.then(
		() => undefined,
		() => undefined,
	);
	return operation;
}

function getRuntimeAuthStorage(ctx: ExtensionContext): (RuntimeAuthStorage & object) | undefined {
	const registry = ctx.modelRegistry as unknown as { authStorage?: unknown; runtime?: unknown };
	for (const candidate of [registry, registry.runtime, registry.authStorage]) {
		if (isRuntimeAuthStorage(candidate)) return candidate;
	}
	return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
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

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function redactCredentialError(error: unknown, credential: OAuthCredential): string {
	return redactTokenText(error instanceof Error ? error.message : String(error), [
		credential.access,
		credential.refresh,
	]);
}

export function redactTokenText(text: string, exactSecrets: readonly string[] = []): string {
	const secrets = [...new Set(exactSecrets.filter(Boolean))].sort((a, b) => b.length - a.length);
	const exact = secrets.length
		? new RegExp(secrets.map((secret) => escapeRegExp(secret)).join("|"), "g")
		: undefined;
	return (exact ? text.replace(exact, "<redacted>") : text)
		.replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer <redacted>")
		.replace(
			/"(access|refresh|access_token|refresh_token|token)"\s*:\s*"[^"]+"/gi,
			'"$1":"<redacted>"',
		)
		.replace(/\b(access|refresh)[_-][A-Za-z0-9._~+/=-]+/gi, "$1-<redacted>");
}

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
