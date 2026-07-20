import assert from "node:assert/strict";
import test from "node:test";
import { createMockContext, createMockPi } from "../../../test/support.js";
import accountsExtension, {
	ACCOUNTS_STATUS_KEY,
	AccountStore,
	completeAccountArguments,
	FAIL_CLOSED_API_KEY,
	parseAccountName,
	type StoredOAuthCredential,
} from "../src/accounts.js";
import {
	type AccountProviderAdapter,
	createBuiltinProviderAdapters,
	createOAuthInteraction,
} from "../src/oauth.js";
import { RuntimeAuthCoordinator } from "../src/runtime-auth.js";
import { InMemoryAccountStorageBackend } from "../src/storage.js";

const credential = (
	suffix: string,
	extra: Record<string, unknown> = {},
): StoredOAuthCredential => ({
	type: "oauth",
	access: `access-${suffix}`,
	refresh: `refresh-${suffix}`,
	expires: Date.now() + 60 * 60 * 1000,
	...extra,
});

function fakeProvider(
	id: AccountProviderAdapter["id"],
	options: {
		baseUrl?: string;
		headers?: Record<string, string>;
		requiresApiKeyBridge?: boolean;
	} = {},
): AccountProviderAdapter {
	return {
		id,
		displayName:
			id === "openai-codex" ? "OpenAI Codex" : id === "anthropic" ? "Anthropic" : "GitHub Copilot",
		requiresApiKeyBridge: options.requiresApiKeyBridge ?? id === "openai-codex",
		oauth: {
			async login() {
				return credential(
					`login-${id}`,
					id === "github-copilot" ? { availableModelIds: ["allowed"] } : {},
				);
			},
			async refresh(current) {
				return { ...current, access: `${current.access}-refreshed`, expires: Date.now() + 60_000 };
			},
			async toAuth(current) {
				return { apiKey: current.access, baseUrl: options.baseUrl, headers: options.headers };
			},
		},
	};
}

function runtimeHarness(mock: ReturnType<typeof createMockPi>) {
	const keys = new Map<string, string>();
	const models = [
		{ provider: "openai-codex", id: "codex", baseUrl: "https://codex.example" },
		{ provider: "anthropic", id: "claude", baseUrl: "https://anthropic.example" },
		{ provider: "github-copilot", id: "allowed", baseUrl: "https://default.copilot" },
		{ provider: "github-copilot", id: "blocked", baseUrl: "https://default.copilot" },
	];
	const runtime = {
		async setRuntimeApiKey(provider: string, key: string) {
			keys.set(provider, key);
		},
		async removeRuntimeApiKey(provider: string) {
			keys.delete(provider);
		},
	};
	const registry = {
		runtime,
		getRegisteredProviderConfig: (provider: string) => mock.providers.get(provider),
		getApiKeyForProvider: async (provider: string) => keys.get(provider),
		getAll: () =>
			models.map((model) => ({
				...model,
				name: model.id,
				api: "openai-responses",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 1000,
				maxTokens: 100,
			})),
		find(provider: string, id: string) {
			const model = models.find((item) => item.provider === provider && item.id === id);
			if (!model) return undefined;
			const config = mock.providers.get(provider) as
				| { baseUrl?: string; models?: Array<{ id: string }> }
				| undefined;
			if (config?.models && !config.models.some((item) => item.id === id)) return undefined;
			return { ...model, baseUrl: config?.baseUrl ?? model.baseUrl };
		},
		async getApiKeyAndHeaders(model: { provider: string }) {
			const config = mock.providers.get(model.provider) as
				| { headers?: Record<string, string> }
				| undefined;
			return { ok: true as const, apiKey: keys.get(model.provider), headers: config?.headers };
		},
	};
	return { keys, registry, runtime };
}

test("built-in provider adapters preserve each provider's complete OAuth auth shape", async () => {
	const adapters = createBuiltinProviderAdapters();
	const byId = new Map(adapters.map((adapter) => [adapter.id, adapter]));
	const base = credential("contract");

	assert.equal(typeof byId.get("openai-codex")?.invalidateConnections, "function");
	assert.deepEqual(await byId.get("openai-codex")?.oauth.toAuth(base), {
		apiKey: "access-contract",
	});
	assert.deepEqual(await byId.get("anthropic")?.oauth.toAuth(base), {
		apiKey: "access-contract",
	});
	const copilotCredential = credential("contract", {
		access: "tid=1;proxy-ep=proxy.business.githubcopilot.com;exp=1",
		enterpriseUrl: "github.example.com",
		availableModelIds: ["allowed"],
	});
	assert.deepEqual(await byId.get("github-copilot")?.oauth.toAuth(copilotCredential), {
		apiKey: copilotCredential.access,
		baseUrl: "https://api.business.githubcopilot.com",
	});
});

test("OAuth interaction preserves provider prompts, cancellation, and notifications", async () => {
	const { ctx, notifications } = createMockContext({
		hasUI: true,
		input: async () => undefined,
		select: async () => "Device login",
	});
	const interaction = createOAuthInteraction(ctx, "Example");
	assert.equal(
		await interaction.prompt({
			type: "select",
			message: "Method",
			options: [
				{ id: "browser", label: "Browser" },
				{ id: "device", label: "Device login" },
			],
		}),
		"device",
	);
	await assert.rejects(
		interaction.prompt({ type: "manual_code", message: "Code" }),
		/Login cancelled/,
	);
	interaction.notify({
		type: "device_code",
		userCode: "ABCD",
		verificationUri: "https://example.test/device",
	});
	assert.match(notifications.at(-1)?.message ?? "", /ABCD/);
});

test("accounts registers the generic command, compatibility aliases, and lifecycle hooks", () => {
	const mock = createMockPi();
	accountsExtension(mock.pi, {
		store: new AccountStore(new InMemoryAccountStorageBackend()),
		providers: [
			fakeProvider("openai-codex"),
			fakeProvider("anthropic"),
			fakeProvider("github-copilot"),
		],
	});

	assert.deepEqual([...mock.commands.keys()].sort(), [
		"account",
		"codex-account",
		"codex-login",
		"codex-logout",
	]);
	assert.deepEqual([...mock.events.keys()].sort(), [
		"before_agent_start",
		"model_select",
		"session_shutdown",
		"session_start",
		"turn_start",
	]);
});

test("account names and command completion are provider scoped", async () => {
	assert.equal(parseAccountName(" work-1 ").ok, true);
	assert.equal(parseAccountName("../secret").ok, false);
	const store = new AccountStore(new InMemoryAccountStorageBackend());
	await store.write({
		version: 1,
		providers: {
			anthropic: { accounts: { work: credential("work"), home: credential("home") } },
		},
	});

	assert.deepEqual(
		completeAccountArguments("switch anthropic ", store).map((item) => item.value),
		["default", "home", "work"],
	);
	assert.deepEqual(
		completeAccountArguments("login ", store).map((item) => item.value),
		["anthropic", "github-copilot", "openai-codex"],
	);
});

test("provider accounts activate independently and default clears only one provider", async () => {
	const store = new AccountStore(new InMemoryAccountStorageBackend());
	await store.write({
		version: 1,
		providers: {
			"openai-codex": { active: "personal", accounts: { personal: credential("codex") } },
			anthropic: { active: "work", accounts: { work: credential("claude") } },
		},
	});
	const mock = createMockPi();
	const providers = [
		fakeProvider("openai-codex"),
		fakeProvider("anthropic"),
		fakeProvider("github-copilot"),
	];
	accountsExtension(mock.pi, { store, providers });
	const { registry, keys } = runtimeHarness(mock);
	const { ctx, notifications } = createMockContext({
		model: { provider: "anthropic", id: "claude" },
		modelRegistry: registry,
	});

	await mock.events.get("session_start")?.[0]?.({}, ctx);
	assert.equal(keys.get("openai-codex"), "access-codex");
	assert.equal(keys.get("anthropic"), "access-claude");

	await mock.commands.get("account")?.handler("switch anthropic default", ctx);
	const data = await store.readAsync();
	assert.equal(data.providers.anthropic?.active, undefined);
	assert.equal(data.providers["openai-codex"]?.active, "personal");
	assert.equal(keys.has("anthropic"), false);
	assert.equal(keys.get("openai-codex"), "access-codex");
	assert.match(notifications.at(-1)?.message ?? "", /default Pi Anthropic login/);
});

test("Codex connections invalidate only when the applied account identity changes", async () => {
	const store = new AccountStore(new InMemoryAccountStorageBackend());
	await store.write({
		version: 1,
		providers: {
			"openai-codex": { active: "work", accounts: { work: credential("codex") } },
		},
	});
	const invalidations: Array<string | undefined> = [];
	const codex = fakeProvider("openai-codex");
	codex.invalidateConnections = (sessionId) => {
		invalidations.push(sessionId);
	};
	const mock = createMockPi();
	accountsExtension(mock.pi, {
		store,
		providers: [codex, fakeProvider("anthropic"), fakeProvider("github-copilot")],
	});
	const { registry } = runtimeHarness(mock);
	const { ctx } = createMockContext({
		model: { provider: "openai-codex", id: "codex" },
		modelRegistry: registry,
	});

	await mock.events.get("session_start")?.[0]?.({}, ctx);
	await mock.events.get("before_agent_start")?.[0]?.({}, ctx);
	assert.deepEqual(invalidations, ["test-session"]);
	await mock.commands.get("account")?.handler("switch openai-codex default", ctx);
	assert.deepEqual(invalidations, ["test-session", "test-session"]);
});

test("connection invalidation failure replaces active Codex auth with fail-closed state", async () => {
	const store = new AccountStore(new InMemoryAccountStorageBackend());
	await store.write({
		version: 1,
		providers: {
			"openai-codex": { active: "work", accounts: { work: credential("codex") } },
		},
	});
	const codex = fakeProvider("openai-codex");
	codex.invalidateConnections = () => {
		throw new Error("socket cleanup failed");
	};
	const mock = createMockPi();
	accountsExtension(mock.pi, {
		store,
		providers: [codex, fakeProvider("anthropic"), fakeProvider("github-copilot")],
	});
	const { registry, keys } = runtimeHarness(mock);
	const { ctx, statuses } = createMockContext({
		model: { provider: "openai-codex", id: "codex" },
		modelRegistry: registry,
	});

	await mock.events.get("session_start")?.[0]?.({}, ctx);
	assert.equal(keys.get("openai-codex"), FAIL_CLOSED_API_KEY);
	assert.match(statuses.get(ACCOUNTS_STATUS_KEY) ?? "", /auth error/);
});

test("generic login stores the full provider-owned credential and activates it", async () => {
	const store = new AccountStore(new InMemoryAccountStorageBackend());
	const mock = createMockPi();
	accountsExtension(mock.pi, {
		store,
		providers: [
			fakeProvider("openai-codex"),
			fakeProvider("anthropic"),
			fakeProvider("github-copilot"),
		],
	});
	const { registry, keys } = runtimeHarness(mock);
	const { ctx } = createMockContext({
		hasUI: true,
		model: { provider: "github-copilot", id: "allowed" },
		modelRegistry: registry,
	});

	await mock.commands.get("account")?.handler("login github-copilot personal", ctx);
	const stored = (await store.readAsync()).providers["github-copilot"];
	assert.equal(stored?.active, "personal");
	assert.deepEqual(stored?.accounts.personal?.availableModelIds, ["allowed"]);
	assert.equal(keys.get("github-copilot"), "access-login-github-copilot");
});

test("providers without account-specific overlays leave existing registrations untouched", async () => {
	const store = new AccountStore(new InMemoryAccountStorageBackend());
	await store.write({
		version: 1,
		providers: {
			anthropic: { active: "work", accounts: { work: credential("claude") } },
		},
	});
	const mock = createMockPi();
	mock.rawPi.registerProvider("anthropic", { headers: { Existing: "yes" } });
	const registrationsBefore = mock.providerRegistrations.length;
	const coordinator = new RuntimeAuthCoordinator(mock.pi, fakeProvider("anthropic"));
	const { registry } = runtimeHarness(mock);
	const { ctx } = createMockContext({ modelRegistry: registry });

	assert.equal((await coordinator.ensureActive(ctx, store)).status, "active");
	assert.equal(mock.providerRegistrations.length, registrationsBefore);
	assert.deepEqual(mock.providers.get("anthropic"), { headers: { Existing: "yes" } });
});

test("GitHub Copilot activation applies its endpoint and available model projection, then restores config", async () => {
	const store = new AccountStore(new InMemoryAccountStorageBackend());
	await store.write({
		version: 1,
		providers: {
			"github-copilot": {
				active: "enterprise",
				accounts: {
					enterprise: credential("copilot", {
						enterpriseUrl: "github.example.com",
						availableModelIds: ["allowed"],
					}),
				},
			},
		},
	});
	const mock = createMockPi();
	mock.rawPi.registerProvider("github-copilot", { headers: { Existing: "yes" } });
	const provider = fakeProvider("github-copilot", {
		baseUrl: "https://copilot-api.github.example.com",
		headers: { Account: "enterprise" },
	});
	const coordinator = new RuntimeAuthCoordinator(mock.pi, provider);
	const { registry, keys } = runtimeHarness(mock);
	const { ctx } = createMockContext({ modelRegistry: registry });

	const result = await coordinator.ensureActive(ctx, store);
	assert.deepEqual(result, {
		status: "active",
		providerId: "github-copilot",
		accountName: "enterprise",
	});
	assert.equal(keys.get("github-copilot"), "access-copilot");
	const projected = mock.providers.get("github-copilot") as {
		headers: Record<string, string>;
		baseUrl: string;
		models: Array<{ id: string }>;
	};
	assert.deepEqual(projected.headers, { Existing: "yes", Account: "enterprise" });
	assert.equal(projected.baseUrl, "https://copilot-api.github.example.com");
	assert.deepEqual(
		projected.models.map((model) => model.id),
		["allowed"],
	);

	await store.updateProvider("github-copilot", (state) => ({ ...state, active: undefined }));
	await coordinator.ensureActive(ctx, store);
	assert.deepEqual(mock.providers.get("github-copilot"), { headers: { Existing: "yes" } });
	assert.equal(keys.has("github-copilot"), false);
});

test("Copilot account switches rebuild model filtering from the complete pre-overlay catalog", async () => {
	const store = new AccountStore(new InMemoryAccountStorageBackend());
	await store.write({
		version: 1,
		providers: {
			"github-copilot": {
				active: "first",
				accounts: {
					first: credential("first", { availableModelIds: ["allowed"] }),
					second: credential("second", { availableModelIds: ["blocked"] }),
				},
			},
		},
	});
	const mock = createMockPi();
	const provider = fakeProvider("github-copilot", { baseUrl: "https://api.copilot.example" });
	const coordinator = new RuntimeAuthCoordinator(mock.pi, provider);
	const { registry } = runtimeHarness(mock);
	const { ctx } = createMockContext({ modelRegistry: registry });

	await coordinator.ensureActive(ctx, store);
	assert.deepEqual(
		(mock.providers.get("github-copilot") as { models: Array<{ id: string }> }).models.map(
			(model) => model.id,
		),
		["allowed"],
	);
	await store.updateProvider("github-copilot", (state) => ({ ...state, active: "second" }));
	await coordinator.ensureActive(ctx, store);
	assert.deepEqual(
		(mock.providers.get("github-copilot") as { models: Array<{ id: string }> }).models.map(
			(model) => model.id,
		),
		["blocked"],
	);
});

test("unsafe provider endpoints and malformed model metadata fail closed", async () => {
	for (const mode of ["endpoint", "models"] as const) {
		const store = new AccountStore(new InMemoryAccountStorageBackend());
		await store.write({
			version: 1,
			providers: {
				"github-copilot": {
					active: "work",
					accounts: {
						work: credential("copilot", {
							...(mode === "models" ? { availableModelIds: [1] } : {}),
						}),
					},
				},
			},
		});
		const provider = fakeProvider("github-copilot", {
			baseUrl: mode === "endpoint" ? "http://token-stealer.invalid" : undefined,
		});
		const mock = createMockPi();
		const coordinator = new RuntimeAuthCoordinator(mock.pi, provider);
		const { registry, keys } = runtimeHarness(mock);
		const { ctx } = createMockContext({ modelRegistry: registry });

		assert.equal((await coordinator.ensureActive(ctx, store)).status, "error");
		assert.equal(keys.get("github-copilot"), FAIL_CLOSED_API_KEY);
	}
});

test("invalid refreshed credentials fail closed instead of escaping storage validation", async () => {
	const store = new AccountStore(new InMemoryAccountStorageBackend());
	await store.write({
		version: 1,
		providers: {
			anthropic: {
				active: "work",
				accounts: { work: { ...credential("expired"), expires: 1 } },
			},
		},
	});
	const provider = fakeProvider("anthropic");
	provider.oauth.refresh = async () => ({
		type: "oauth",
		access: "",
		refresh: "rotated-secret",
		expires: Date.now() + 60_000,
	});
	const mock = createMockPi();
	const coordinator = new RuntimeAuthCoordinator(mock.pi, provider);
	const { registry, keys } = runtimeHarness(mock);
	const { ctx } = createMockContext({ modelRegistry: registry });

	const result = await coordinator.ensureActive(ctx, store);
	assert.equal(result.status, "error");
	assert.equal(keys.get("anthropic"), FAIL_CLOSED_API_KEY);
	assert.equal(
		(await store.readProviderAsync("anthropic")).accounts.work?.access,
		"access-expired",
	);
});

test("fail-closed runtime keys are attempted even when a provider overlay is rejected", async () => {
	const store = new AccountStore(new InMemoryAccountStorageBackend());
	await store.write({
		version: 1,
		providers: {
			"openai-codex": {
				active: "work",
				accounts: { work: credential("codex") },
			},
		},
	});
	const mock = createMockPi();
	const pi = {
		...mock.rawPi,
		registerProvider() {
			throw new Error("overlay rejected");
		},
	} as never;
	const coordinator = new RuntimeAuthCoordinator(pi, fakeProvider("openai-codex"));
	const { registry, keys } = runtimeHarness(mock);
	const { ctx } = createMockContext({ modelRegistry: registry });

	const result = await coordinator.ensureActive(ctx, store);
	assert.equal(result.status, "error");
	assert.equal(keys.get("openai-codex"), FAIL_CLOSED_API_KEY);
});

test("refresh and auth derivation failures fail closed, redact secrets, and abort only the affected provider", async () => {
	const store = new AccountStore(new InMemoryAccountStorageBackend());
	await store.write({
		version: 1,
		providers: {
			anthropic: { active: "work", accounts: { work: credential("secret") } },
		},
	});
	const failing = fakeProvider("anthropic");
	failing.oauth.toAuth = async (current) => {
		throw new Error(`bad ${current.access} and ${current.refresh}`);
	};
	const mock = createMockPi();
	accountsExtension(mock.pi, {
		store,
		providers: [fakeProvider("openai-codex"), failing, fakeProvider("github-copilot")],
	});
	const { registry, keys } = runtimeHarness(mock);
	let aborts = 0;
	const { ctx, statuses } = createMockContext({
		model: { provider: "anthropic", id: "claude" },
		modelRegistry: registry,
		abort: () => {
			aborts += 1;
		},
	});

	await mock.events.get("before_agent_start")?.[0]?.({}, ctx);
	assert.equal(keys.get("anthropic"), FAIL_CLOSED_API_KEY);
	assert.match(statuses.get(ACCOUNTS_STATUS_KEY) ?? "", /auth error/);
	assert.doesNotMatch(statuses.get(ACCOUNTS_STATUS_KEY) ?? "", /access-secret|refresh-secret/);
	await mock.events.get("turn_start")?.[0]?.({}, ctx);
	assert.equal(aborts, 1);

	const other = createMockContext({
		model: { provider: "openai-codex", id: "codex" },
		modelRegistry: registry,
		abort: () => {
			aborts += 1;
		},
	}).ctx;
	await mock.events.get("turn_start")?.[0]?.({}, other);
	assert.equal(aborts, 1);
});

test("account reset during OAuth conversion cannot restore a stale runtime override", async () => {
	const store = new AccountStore(new InMemoryAccountStorageBackend());
	await store.write({
		version: 1,
		providers: {
			anthropic: { active: "work", accounts: { work: credential("claude") } },
		},
	});
	let releaseConversion: (() => void) | undefined;
	const conversionBlocked = new Promise<void>((resolve) => {
		releaseConversion = resolve;
	});
	let signalConversion: (() => void) | undefined;
	const conversionStarted = new Promise<void>((resolve) => {
		signalConversion = resolve;
	});
	const anthropic = fakeProvider("anthropic");
	anthropic.oauth.toAuth = async (current) => {
		signalConversion?.();
		await conversionBlocked;
		return { apiKey: current.access };
	};
	const mock = createMockPi();
	accountsExtension(mock.pi, {
		store,
		providers: [fakeProvider("openai-codex"), anthropic, fakeProvider("github-copilot")],
	});
	const { registry, keys } = runtimeHarness(mock);
	const { ctx } = createMockContext({
		model: { provider: "anthropic", id: "claude" },
		modelRegistry: registry,
	});

	const startup = mock.events.get("session_start")?.[0]?.({}, ctx);
	await conversionStarted;
	const reset = mock.commands.get("account")?.handler("switch anthropic default", ctx);
	releaseConversion?.();
	await Promise.all([startup, reset]);
	assert.equal((await store.readProviderAsync("anthropic")).active, undefined);
	assert.equal(keys.has("anthropic"), false);
});

test("Codex compatibility aliases write the generic provider state", async () => {
	const store = new AccountStore(new InMemoryAccountStorageBackend());
	const mock = createMockPi();
	accountsExtension(mock.pi, {
		store,
		providers: [
			fakeProvider("openai-codex"),
			fakeProvider("anthropic"),
			fakeProvider("github-copilot"),
		],
	});
	const { registry } = runtimeHarness(mock);
	const { ctx } = createMockContext({ hasUI: true, modelRegistry: registry });

	await mock.commands.get("codex-login")?.handler("work", ctx);
	assert.equal((await store.readAsync()).providers["openai-codex"]?.active, "work");
	await mock.commands.get("codex-account")?.handler("default", ctx);
	assert.equal((await store.readAsync()).providers["openai-codex"]?.active, undefined);
	await mock.commands.get("codex-logout")?.handler("work", ctx);
	assert.equal((await store.readAsync()).providers["openai-codex"]?.accounts.work, undefined);
});
