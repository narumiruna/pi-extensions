import assert from "node:assert/strict";
import test from "node:test";
import { createMockContext, createMockPi } from "../../../test/support.js";
import codexAccounts, {
	CODEX_ACCOUNTS_STATUS_KEY,
	CODEX_PROVIDER_ID,
	CodexAccountStore,
	completeStoredAccountArguments,
	DEFAULT_CODEX_MODEL_ID,
	DEFAULT_PI_LOGIN_LABEL,
	ensureActiveCodexAuth,
	FAIL_CLOSED_API_KEY,
	isOpenAICodexModel,
	parseAccountName,
} from "../src/codex-accounts.js";
import { InMemoryCodexAccountStorageBackend as InMemoryAuthStorageBackend } from "../src/storage.js";

const validCred = (suffix = "") => ({
	access: `access-${suffix}`,
	refresh: `refresh-${suffix}`,
	expires: Date.now() + 60 * 60 * 1000,
	accountId: `account-${suffix}`,
});

test("codex-accounts registers commands and lifecycle hooks", () => {
	const mock = createMockPi();
	codexAccounts(mock.pi, { store: new CodexAccountStore(new InMemoryAuthStorageBackend()) });

	assert.deepEqual([...mock.commands.keys()].sort(), [
		"codex-account",
		"codex-login",
		"codex-logout",
	]);
	assert.deepEqual([...mock.events.keys()].sort(), [
		"before_agent_start",
		"model_select",
		"session_shutdown",
		"session_start",
	]);
});

test("parseAccountName accepts small account labels and rejects unsafe names", () => {
	assert.equal(parseAccountName("  work-1_2.foo  ").ok, true);
	assert.equal(parseAccountName("two words").ok, false);
	assert.equal(parseAccountName("").ok, false);
	assert.equal(parseAccountName("../secret").ok, false);
	assert.equal(parseAccountName("a".repeat(65)).ok, false);
});

test("ensureActiveCodexAuth leaves normal Pi auth unchanged when no account override was applied", async () => {
	const store = new CodexAccountStore(new InMemoryAuthStorageBackend());
	const calls: string[] = [];
	const { ctx } = createMockContext({
		modelRegistry: {
			authStorage: {
				setRuntimeApiKey: (provider: string, key: string) => calls.push(`set:${provider}:${key}`),
				removeRuntimeApiKey: (provider: string) => calls.push(`remove:${provider}`),
			},
		},
	});

	const result = await ensureActiveCodexAuth(ctx, store);

	assert.deepEqual(result, { status: "inactive" });
	assert.deepEqual(calls, []);
});

test("ensureActiveCodexAuth applies active account access tokens", async () => {
	const store = new CodexAccountStore(new InMemoryAuthStorageBackend());
	await store.write({ active: "work", accounts: { work: validCred("work") } });
	const calls: string[] = [];
	const { ctx } = createMockContext({
		modelRegistry: {
			authStorage: {
				setRuntimeApiKey: (provider: string, key: string) => calls.push(`set:${provider}:${key}`),
				removeRuntimeApiKey: (provider: string) => calls.push(`remove:${provider}`),
			},
		},
	});

	const result = await ensureActiveCodexAuth(ctx, store);

	assert.deepEqual(result, { status: "active", accountName: "work" });
	assert.deepEqual(calls, [`set:${CODEX_PROVIDER_ID}:access-work`]);
});

test("missing-account cleanup preserves a concurrently selected account", async () => {
	const missingSnapshot = JSON.stringify({ active: "missing", accounts: {} });
	const currentSnapshot = JSON.stringify({ active: "home", accounts: { home: validCred("home") } });
	let raw = missingSnapshot;
	let replaceAfterRead = true;
	const backend = {
		withLock<T>(mutator: (current: string | undefined) => { result: T; next?: string }): T {
			const { result, next } = mutator(raw);
			if (next !== undefined) raw = next;
			return result;
		},
		async withLockAsync<T>(
			mutator: (current: string | undefined) => Promise<{ result: T; next?: string }>,
		): Promise<T> {
			const { result, next } = await mutator(raw);
			if (next !== undefined) raw = next;
			else if (replaceAfterRead) {
				replaceAfterRead = false;
				raw = currentSnapshot;
			}
			return result;
		},
	};
	const store = new CodexAccountStore(backend);
	const runtimeCalls: string[] = [];
	const { ctx } = createMockContext({
		modelRegistry: {
			authStorage: {
				setRuntimeApiKey: (provider: string, key: string) =>
					runtimeCalls.push(`set:${provider}:${key}`),
				removeRuntimeApiKey: (provider: string) => runtimeCalls.push(`remove:${provider}`),
			},
		},
	});

	const result = await ensureActiveCodexAuth(ctx, store, {
		oauthProvider: {
			async refreshToken() {
				throw new Error("unexpected refresh");
			},
			getApiKey: (credential) => credential.access,
		},
	});

	assert.deepEqual(result, { status: "active", accountName: "home" });
	assert.equal((await store.readAsync()).active, "home");
	assert.deepEqual(runtimeCalls, [`set:${CODEX_PROVIDER_ID}:access-home`]);
});

test("ensureActiveCodexAuth supports and awaits Pi's model runtime auth overrides", async () => {
	const store = new CodexAccountStore(new InMemoryAuthStorageBackend());
	await store.write({ active: "work", accounts: { work: validCred("work") } });
	const calls: string[] = [];
	let releaseSet: (() => void) | undefined;
	const setBlocked = new Promise<void>((resolve) => {
		releaseSet = resolve;
	});
	const { ctx } = createMockContext({
		modelRegistry: {
			runtime: {
				async setRuntimeApiKey(provider: string, key: string) {
					calls.push(`start:${provider}:${key}`);
					await setBlocked;
					calls.push(`finish:${provider}:${key}`);
				},
				async removeRuntimeApiKey(provider: string) {
					calls.push(`remove:${provider}`);
				},
			},
		},
	});

	let settled = false;
	const auth = ensureActiveCodexAuth(ctx, store).finally(() => {
		settled = true;
	});
	await new Promise<void>((resolve) => setImmediate(resolve));

	assert.equal(settled, false);
	assert.deepEqual(calls, [`start:${CODEX_PROVIDER_ID}:access-work`]);
	releaseSet?.();
	assert.deepEqual(await auth, { status: "active", accountName: "work" });
	assert.deepEqual(calls, [
		`start:${CODEX_PROVIDER_ID}:access-work`,
		`finish:${CODEX_PROVIDER_ID}:access-work`,
	]);
});

test("account reset removes an async runtime override that is still being applied", async () => {
	const store = new CodexAccountStore(new InMemoryAuthStorageBackend());
	await store.write({ active: "work", accounts: { work: validCred("work") } });
	const mock = createMockPi();
	codexAccounts(mock.pi, { store });
	const command = mock.commands.get("codex-account");
	assert.ok(command);

	const calls: string[] = [];
	let releaseSet: (() => void) | undefined;
	const setBlocked = new Promise<void>((resolve) => {
		releaseSet = resolve;
	});
	let signalSetStarted: (() => void) | undefined;
	const setStarted = new Promise<void>((resolve) => {
		signalSetStarted = resolve;
	});
	const { ctx } = createMockContext({
		modelRegistry: {
			runtime: {
				async setRuntimeApiKey(provider: string, key: string) {
					calls.push(`start:${provider}:${key}`);
					signalSetStarted?.();
					await setBlocked;
					calls.push(`finish:${provider}:${key}`);
				},
				async removeRuntimeApiKey(provider: string) {
					calls.push(`remove:${provider}`);
				},
			},
		},
	});

	const startup = mock.events.get("session_start")?.[0]?.({}, ctx);
	await setStarted;
	const reset = command.handler("default", ctx);
	await new Promise<void>((resolve) => setImmediate(resolve));
	releaseSet?.();
	await Promise.all([startup, reset]);

	assert.equal((await store.readAsync()).active, undefined);
	assert.deepEqual(calls, [
		`start:${CODEX_PROVIDER_ID}:access-work`,
		`finish:${CODEX_PROVIDER_ID}:access-work`,
		`remove:${CODEX_PROVIDER_ID}`,
	]);
});

test("account reset during API-key conversion cannot restore a stale runtime override", async () => {
	const store = new CodexAccountStore(new InMemoryAuthStorageBackend());
	await store.write({ active: "work", accounts: { work: validCred("work") } });
	let releaseConversion: (() => void) | undefined;
	const conversionBlocked = new Promise<void>((resolve) => {
		releaseConversion = resolve;
	});
	let signalConversionStarted: (() => void) | undefined;
	const conversionStarted = new Promise<void>((resolve) => {
		signalConversionStarted = resolve;
	});
	const mock = createMockPi();
	codexAccounts(mock.pi, {
		store,
		oauthProvider: {
			async login() {
				throw new Error("unexpected login");
			},
			async refreshToken() {
				throw new Error("unexpected refresh");
			},
			async getApiKey(credential) {
				signalConversionStarted?.();
				await conversionBlocked;
				return credential.access;
			},
		},
	});
	const command = mock.commands.get("codex-account");
	assert.ok(command);
	const runtimeCalls: string[] = [];
	const { ctx } = createMockContext({
		modelRegistry: {
			authStorage: {
				setRuntimeApiKey: (provider: string, key: string) =>
					runtimeCalls.push(`set:${provider}:${key}`),
				removeRuntimeApiKey: (provider: string) => runtimeCalls.push(`remove:${provider}`),
			},
		},
	});

	const startup = mock.events.get("session_start")?.[0]?.({}, ctx);
	await conversionStarted;
	await command.handler("default", ctx);
	releaseConversion?.();
	await startup;

	assert.equal((await store.readAsync()).active, undefined);
	assert.deepEqual(runtimeCalls, []);
});

test("session shutdown during API-key conversion cannot restore a runtime override", async () => {
	const store = new CodexAccountStore(new InMemoryAuthStorageBackend());
	await store.write({ active: "work", accounts: { work: validCred("work") } });
	let releaseConversion: (() => void) | undefined;
	const conversionBlocked = new Promise<void>((resolve) => {
		releaseConversion = resolve;
	});
	let signalConversionStarted: (() => void) | undefined;
	const conversionStarted = new Promise<void>((resolve) => {
		signalConversionStarted = resolve;
	});
	const mock = createMockPi();
	codexAccounts(mock.pi, {
		store,
		oauthProvider: {
			async login() {
				throw new Error("unexpected login");
			},
			async refreshToken() {
				throw new Error("unexpected refresh");
			},
			async getApiKey(credential) {
				signalConversionStarted?.();
				await conversionBlocked;
				return credential.access;
			},
		},
	});
	const runtimeCalls: string[] = [];
	const { ctx, statuses } = createMockContext({
		model: { provider: CODEX_PROVIDER_ID },
		modelRegistry: {
			runtime: {
				setRuntimeApiKey: (provider: string, key: string) =>
					runtimeCalls.push(`set:${provider}:${key}`),
				removeRuntimeApiKey: (provider: string) => runtimeCalls.push(`remove:${provider}`),
			},
		},
	});

	const startup = mock.events.get("session_start")?.[0]?.({}, ctx);
	await conversionStarted;
	await mock.events.get("session_shutdown")?.[0]?.({}, ctx);
	releaseConversion?.();
	await startup;

	assert.deepEqual(runtimeCalls, []);
	assert.equal(statuses.get(CODEX_ACCOUNTS_STATUS_KEY), undefined);
});

test("a partially failed runtime setter remains removable", async () => {
	const store = new CodexAccountStore(new InMemoryAuthStorageBackend());
	await store.write({ active: "work", accounts: { work: validCred("work") } });
	const runtimeCalls: string[] = [];
	const { ctx } = createMockContext({
		modelRegistry: {
			runtime: {
				async setRuntimeApiKey(provider: string, key: string) {
					runtimeCalls.push(`set:${provider}:${key}`);
					throw new Error("model refresh failed after applying the key");
				},
				removeRuntimeApiKey(provider: string) {
					runtimeCalls.push(`remove:${provider}`);
				},
			},
		},
	});

	await assert.rejects(ensureActiveCodexAuth(ctx, store), /model refresh failed/);
	await store.update((data) => ({ ...data, active: undefined }));
	assert.deepEqual(await ensureActiveCodexAuth(ctx, store), { status: "inactive" });

	assert.deepEqual(runtimeCalls, [
		`set:${CODEX_PROVIDER_ID}:access-work`,
		`remove:${CODEX_PROVIDER_ID}`,
	]);
});

test("ensureActiveCodexAuth refreshes near-expired active accounts", async () => {
	const store = new CodexAccountStore(new InMemoryAuthStorageBackend());
	await store.write({
		active: "work",
		accounts: { work: { access: "old", refresh: "refresh-old", expires: Date.now() - 1 } },
	});
	const calls: string[] = [];
	const { ctx } = createMockContext({
		modelRegistry: {
			authStorage: {
				setRuntimeApiKey: (provider: string, key: string) => calls.push(`set:${provider}:${key}`),
				removeRuntimeApiKey: (provider: string) => calls.push(`remove:${provider}`),
			},
		},
	});

	const result = await ensureActiveCodexAuth(ctx, store, {
		oauthProvider: {
			async refreshToken() {
				return validCred("new");
			},
			getApiKey: (credential) => credential.access,
		},
	});

	assert.deepEqual(result, { status: "active", accountName: "work" });
	assert.deepEqual(calls, [`set:${CODEX_PROVIDER_ID}:access-new`]);
	assert.equal((await store.readAsync()).accounts.work?.access, "access-new");
});

test("concurrent auth checks refresh an expiring account only once", async () => {
	const store = new CodexAccountStore(new InMemoryAuthStorageBackend());
	await store.write({
		active: "work",
		accounts: { work: { access: "old", refresh: "refresh-old", expires: 0 } },
	});
	let refreshCalls = 0;
	const oauthProvider = {
		async refreshToken() {
			refreshCalls += 1;
			await Promise.resolve();
			return validCred("new");
		},
		getApiKey: (credential: { access: string }) => credential.access,
	};
	const runtimeKeys: string[] = [];
	const { ctx } = createMockContext({
		modelRegistry: {
			authStorage: {
				setRuntimeApiKey: (_provider: string, key: string) => runtimeKeys.push(key),
				removeRuntimeApiKey: () => undefined,
			},
		},
	});

	await Promise.all([
		ensureActiveCodexAuth(ctx, store, { oauthProvider }),
		ensureActiveCodexAuth(ctx, store, { oauthProvider }),
	]);

	assert.equal(refreshCalls, 1);
	assert.deepEqual(runtimeKeys, ["access-new"]);
});

test("ensureActiveCodexAuth fails closed when active account refresh fails", async () => {
	const store = new CodexAccountStore(new InMemoryAuthStorageBackend());
	await store.write({
		active: "work",
		accounts: { work: { access: "old", refresh: "refresh-old", expires: Date.now() - 1 } },
	});
	const calls: string[] = [];
	const { ctx } = createMockContext({
		modelRegistry: {
			authStorage: {
				setRuntimeApiKey: (provider: string, key: string) => calls.push(`set:${provider}:${key}`),
				removeRuntimeApiKey: (provider: string) => calls.push(`remove:${provider}`),
			},
		},
	});

	const result = await ensureActiveCodexAuth(ctx, store, {
		oauthProvider: {
			async refreshToken() {
				throw new Error("network down");
			},
			getApiKey: (credential) => credential.access,
		},
	});

	assert.equal(result.status, "error");
	assert.deepEqual(calls, [`set:${CODEX_PROVIDER_ID}:${FAIL_CLOSED_API_KEY}`]);
});

test("ensureActiveCodexAuth fails closed and redacts API-key conversion errors", async () => {
	const store = new CodexAccountStore(new InMemoryAuthStorageBackend());
	const credential = {
		access: "opaque-access-secret",
		refresh: "opaque-refresh-secret",
		expires: Date.now() + 60 * 60 * 1000,
	};
	await store.write({ active: "work", accounts: { work: credential } });
	const runtimeCalls: string[] = [];
	const { ctx } = createMockContext({
		modelRegistry: {
			authStorage: {
				setRuntimeApiKey: (provider: string, key: string) =>
					runtimeCalls.push(`set:${provider}:${key}`),
				removeRuntimeApiKey: () => undefined,
			},
		},
	});

	const result = await ensureActiveCodexAuth(ctx, store, {
		oauthProvider: {
			async refreshToken() {
				throw new Error("unexpected refresh");
			},
			getApiKey() {
				throw new Error(`conversion failed for ${credential.access} / ${credential.refresh}`);
			},
		},
	});

	assert.equal(result.status, "error");
	if (result.status !== "error") assert.fail("expected an auth error");
	assert.doesNotMatch(result.message, /opaque-(access|refresh)-secret/);
	assert.deepEqual(runtimeCalls, [`set:${CODEX_PROVIDER_ID}:${FAIL_CLOSED_API_KEY}`]);
});

test("codex-login rejects the reserved default account name", async () => {
	const store = new CodexAccountStore(new InMemoryAuthStorageBackend());
	let loginCalls = 0;
	const mock = createMockPi();
	codexAccounts(mock.pi, {
		store,
		oauthProvider: {
			async login() {
				loginCalls += 1;
				return validCred("default");
			},
			async refreshToken() {
				throw new Error("unexpected refresh");
			},
			getApiKey: (credential) => credential.access,
		},
	});
	const command = mock.commands.get("codex-login");
	assert.ok(command);
	const { ctx, notifications } = createMockContext({ hasUI: true });

	await command.handler("DEFAULT", ctx);

	assert.equal(loginCalls, 0);
	assert.deepEqual(await store.readAsync(), { accounts: {} });
	assert.match(notifications.at(-1)?.message ?? "", /reserved/i);
});

test("codex-login stores credentials, activates the account, and does not change non-unknown models", async () => {
	const store = new CodexAccountStore(new InMemoryAuthStorageBackend());
	const mock = createMockPi();
	codexAccounts(mock.pi, {
		store,
		oauthProvider: {
			async login() {
				return validCred("work");
			},
			async refreshToken() {
				throw new Error("unexpected refresh");
			},
			getApiKey: (credential) => credential.access,
		},
	});
	const command = mock.commands.get("codex-login");
	assert.ok(command);
	const runtimeCalls: string[] = [];
	const { ctx, notifications } = createMockContext({
		hasUI: true,
		model: { provider: "anthropic", id: "claude", api: "anthropic-messages" },
		modelRegistry: {
			authStorage: {
				setRuntimeApiKey: (provider: string, key: string) =>
					runtimeCalls.push(`set:${provider}:${key}`),
				removeRuntimeApiKey: (provider: string) => runtimeCalls.push(`remove:${provider}`),
			},
		},
	});

	await command.handler("work", ctx);

	assert.equal((await store.readAsync()).active, "work");
	assert.deepEqual(runtimeCalls, [`set:${CODEX_PROVIDER_ID}:access-work`]);
	assert.equal(mock.setModels.length, 0);
	assert.match(notifications.at(-1)?.message ?? "", /Logged in Codex account "work"/);
});

test("codex-login forwards per-prompt abort signals to UI dialogs", async () => {
	const store = new CodexAccountStore(new InMemoryAuthStorageBackend());
	const promptController = new AbortController();
	let inputSignal: AbortSignal | undefined;
	const mock = createMockPi();
	codexAccounts(mock.pi, {
		store,
		oauthProvider: {
			async login(callbacks) {
				const code = await callbacks.onPrompt({
					message: "Paste the authorization code",
					placeholder: "code#state",
					signal: promptController.signal,
				});
				assert.equal(code, "manual-code");
				return validCred("work");
			},
			async refreshToken() {
				throw new Error("unexpected refresh");
			},
			getApiKey: (credential) => credential.access,
		},
	});
	const command = mock.commands.get("codex-login");
	assert.ok(command);
	const { ctx } = createMockContext({
		hasUI: true,
		input: async (_title: string, _placeholder: string, options?: { signal?: AbortSignal }) => {
			inputSignal = options?.signal;
			return "manual-code";
		},
		model: { provider: "anthropic", id: "claude", api: "anthropic-messages" },
		modelRegistry: {
			authStorage: {
				setRuntimeApiKey: () => undefined,
				removeRuntimeApiKey: () => undefined,
			},
		},
	});

	await command.handler("work", ctx);

	assert.equal(inputSignal, promptController.signal);
});

test("codex-login selects the default Codex model only from unknown/unknown", async () => {
	const store = new CodexAccountStore(new InMemoryAuthStorageBackend());
	const mock = createMockPi();
	codexAccounts(mock.pi, {
		store,
		oauthProvider: {
			async login() {
				return validCred("work");
			},
			async refreshToken() {
				throw new Error("unexpected refresh");
			},
			getApiKey: (credential) => credential.access,
		},
	});
	const command = mock.commands.get("codex-login");
	assert.ok(command);
	const codexModel = { provider: CODEX_PROVIDER_ID, id: DEFAULT_CODEX_MODEL_ID };
	const findCalls: string[] = [];
	const { ctx } = createMockContext({
		hasUI: true,
		model: { provider: "unknown", id: "unknown", api: "unknown" },
		modelRegistry: {
			find: (provider: string, id: string) => {
				findCalls.push(`${provider}/${id}`);
				return codexModel;
			},
			authStorage: {
				setRuntimeApiKey: () => undefined,
				removeRuntimeApiKey: () => undefined,
			},
		},
	});

	await command.handler("work", ctx);

	assert.deepEqual(findCalls, [`${CODEX_PROVIDER_ID}/${DEFAULT_CODEX_MODEL_ID}`]);
	assert.deepEqual(mock.setModels, [codexModel]);
});

test("codex-login warns when the default Codex model is unavailable", async () => {
	const store = new CodexAccountStore(new InMemoryAuthStorageBackend());
	const mock = createMockPi();
	codexAccounts(mock.pi, {
		store,
		oauthProvider: {
			async login() {
				return validCred("work");
			},
			async refreshToken() {
				throw new Error("unexpected refresh");
			},
			getApiKey: (credential) => credential.access,
		},
	});
	const command = mock.commands.get("codex-login");
	assert.ok(command);
	const { ctx, notifications } = createMockContext({
		hasUI: true,
		model: { provider: "unknown", id: "unknown", api: "unknown" },
		modelRegistry: {
			find: () => undefined,
			authStorage: {
				setRuntimeApiKey: () => undefined,
				removeRuntimeApiKey: () => undefined,
			},
		},
	});

	await command.handler("work", ctx);

	assert.equal(mock.setModels.length, 0);
	assert.ok(notifications.some((item) => item.message.includes("was not found")));
});

test("codex-login warns when selecting the default Codex model fails", async () => {
	const store = new CodexAccountStore(new InMemoryAuthStorageBackend());
	const mock = createMockPi();
	mock.rawPi.setModel = async (model: unknown) => {
		mock.setModels.push(model);
		return false;
	};
	codexAccounts(mock.pi, {
		store,
		oauthProvider: {
			async login() {
				return validCred("work");
			},
			async refreshToken() {
				throw new Error("unexpected refresh");
			},
			getApiKey: (credential) => credential.access,
		},
	});
	const command = mock.commands.get("codex-login");
	assert.ok(command);
	const codexModel = { provider: CODEX_PROVIDER_ID, id: DEFAULT_CODEX_MODEL_ID };
	const { ctx, notifications } = createMockContext({
		hasUI: true,
		model: { provider: "unknown", id: "unknown", api: "unknown" },
		modelRegistry: {
			find: () => codexModel,
			authStorage: {
				setRuntimeApiKey: () => undefined,
				removeRuntimeApiKey: () => undefined,
			},
		},
	});

	await command.handler("work", ctx);

	assert.deepEqual(mock.setModels, [codexModel]);
	assert.ok(notifications.some((item) => item.message.includes("selecting gpt-5.5 failed")));
});

test("codex-account can switch accounts or return to default Pi login", async () => {
	const store = new CodexAccountStore(new InMemoryAuthStorageBackend());
	await store.write({
		active: "work",
		accounts: { work: validCred("work"), home: validCred("home") },
	});
	const mock = createMockPi();
	codexAccounts(mock.pi, { store });
	const command = mock.commands.get("codex-account");
	assert.ok(command);
	const runtimeCalls: string[] = [];
	const { ctx } = createMockContext({
		modelRegistry: {
			authStorage: {
				setRuntimeApiKey: (provider: string, key: string) =>
					runtimeCalls.push(`set:${provider}:${key}`),
				removeRuntimeApiKey: (provider: string) => runtimeCalls.push(`remove:${provider}`),
			},
		},
	});

	await command.handler("home", ctx);
	assert.equal((await store.readAsync()).active, "home");
	assert.deepEqual(runtimeCalls.at(-1), `set:${CODEX_PROVIDER_ID}:access-home`);

	await command.handler("default", ctx);
	assert.equal((await store.readAsync()).active, undefined);
	assert.deepEqual(runtimeCalls.at(-1), `remove:${CODEX_PROVIDER_ID}`);
});

test("codex-account default does not let an in-flight refresh restore the previous account", async () => {
	const store = new CodexAccountStore(new InMemoryAuthStorageBackend());
	await store.write({
		active: "work",
		accounts: {
			work: { ...validCred("work"), expires: 0 },
			home: validCred("home"),
		},
	});
	let releaseRefresh: (() => void) | undefined;
	const refreshStarted = new Promise<void>((resolve) => {
		releaseRefresh = resolve;
	});
	let signalRefreshStarted: (() => void) | undefined;
	const refreshEntered = new Promise<void>((resolve) => {
		signalRefreshStarted = resolve;
	});
	const mock = createMockPi();
	codexAccounts(mock.pi, {
		store,
		oauthProvider: {
			async login() {
				throw new Error("unexpected login");
			},
			async refreshToken() {
				signalRefreshStarted?.();
				await refreshStarted;
				return validCred("work-refreshed");
			},
			getApiKey: (credential) => credential.access,
		},
	});
	const command = mock.commands.get("codex-account");
	assert.ok(command);
	const runtimeCalls: string[] = [];
	const { ctx } = createMockContext({
		modelRegistry: {
			authStorage: {
				setRuntimeApiKey: (provider: string, key: string) =>
					runtimeCalls.push(`set:${provider}:${key}`),
				removeRuntimeApiKey: (provider: string) => runtimeCalls.push(`remove:${provider}`),
			},
		},
	});

	const startup = mock.events.get("session_start")?.[0]?.({}, ctx);
	await refreshEntered;
	const switching = command.handler("default", ctx);
	releaseRefresh?.();
	await Promise.all([startup, switching]);

	assert.equal((await store.readAsync()).active, undefined);
	assert.equal(runtimeCalls.at(-1), `remove:${CODEX_PROVIDER_ID}`);
});

test("codex-account selector includes default Pi login", async () => {
	const store = new CodexAccountStore(new InMemoryAuthStorageBackend());
	await store.write({ active: "work", accounts: { work: validCred("work") } });
	const mock = createMockPi();
	codexAccounts(mock.pi, { store });
	const command = mock.commands.get("codex-account");
	assert.ok(command);
	const seenOptions: string[][] = [];
	const { ctx } = createMockContext({
		hasUI: true,
		select: async (_message: string, options: string[]) => {
			seenOptions.push(options);
			return DEFAULT_PI_LOGIN_LABEL;
		},
		modelRegistry: {
			authStorage: {
				setRuntimeApiKey: () => undefined,
				removeRuntimeApiKey: () => undefined,
			},
		},
	});

	await command.handler("", ctx);
	assert.deepEqual(seenOptions, [[DEFAULT_PI_LOGIN_LABEL, "work"]]);
	assert.equal((await store.readAsync()).active, undefined);
});

test("codex-logout deletes accounts and clears active runtime auth", async () => {
	const store = new CodexAccountStore(new InMemoryAuthStorageBackend());
	await store.write({
		active: "work",
		accounts: { work: validCred("work"), home: validCred("home") },
	});
	const mock = createMockPi();
	codexAccounts(mock.pi, { store });
	const command = mock.commands.get("codex-logout");
	assert.ok(command);
	const runtimeCalls: string[] = [];
	const { ctx } = createMockContext({
		modelRegistry: {
			authStorage: {
				setRuntimeApiKey: (provider: string, key: string) =>
					runtimeCalls.push(`set:${provider}:${key}`),
				removeRuntimeApiKey: (provider: string) => runtimeCalls.push(`remove:${provider}`),
			},
		},
	});

	await mock.events.get("session_start")?.[0]?.({}, ctx);
	runtimeCalls.length = 0;
	await command.handler("home", ctx);
	let data = await store.readAsync();
	assert.equal(data.active, "work");
	assert.equal(data.accounts.home, undefined);
	assert.equal(runtimeCalls.length, 0);

	await command.handler("work", ctx);
	data = await store.readAsync();
	assert.equal(data.active, undefined);
	assert.equal(data.accounts.work, undefined);
	assert.deepEqual(runtimeCalls.at(-1), `remove:${CODEX_PROVIDER_ID}`);
});

test("logging out another account does not overwrite an in-flight token refresh", async () => {
	const store = new CodexAccountStore(new InMemoryAuthStorageBackend());
	await store.write({
		active: "work",
		accounts: {
			work: { ...validCred("work"), expires: 0 },
			home: validCred("home"),
		},
	});
	let releaseRefresh: (() => void) | undefined;
	const refreshBlocked = new Promise<void>((resolve) => {
		releaseRefresh = resolve;
	});
	let signalRefreshStarted: (() => void) | undefined;
	const refreshStarted = new Promise<void>((resolve) => {
		signalRefreshStarted = resolve;
	});
	const mock = createMockPi();
	codexAccounts(mock.pi, {
		store,
		oauthProvider: {
			async login() {
				throw new Error("unexpected login");
			},
			async refreshToken() {
				signalRefreshStarted?.();
				await refreshBlocked;
				return validCred("refreshed");
			},
			getApiKey: (credential) => credential.access,
		},
		closeWebSocketSessions: () => undefined,
	});
	const { ctx } = createMockContext({
		modelRegistry: {
			authStorage: {
				setRuntimeApiKey: () => undefined,
				removeRuntimeApiKey: () => undefined,
			},
		},
	});

	const startup = mock.events.get("session_start")?.[0]?.({}, ctx);
	await refreshStarted;
	const command = mock.commands.get("codex-logout");
	assert.ok(command);
	const logout = command.handler("home", ctx);
	releaseRefresh?.();
	await Promise.all([startup, logout]);

	const data = await store.readAsync();
	assert.equal(data.accounts.home, undefined);
	assert.equal(data.accounts.work?.access, "access-refreshed");
});

test("account changes close cached Codex WebSockets while unchanged compaction checks do not", async () => {
	const store = new CodexAccountStore(new InMemoryAuthStorageBackend());
	await store.write({
		active: "work",
		accounts: { work: validCred("work"), home: validCred("home") },
	});
	const closedSessions: Array<string | undefined> = [];
	const mock = createMockPi();
	codexAccounts(mock.pi, {
		store,
		closeWebSocketSessions: (sessionId) => closedSessions.push(sessionId),
	});
	const { ctx } = createMockContext({
		modelRegistry: {
			authStorage: {
				setRuntimeApiKey: () => undefined,
				removeRuntimeApiKey: () => undefined,
			},
		},
	});

	await mock.events.get("session_start")?.[0]?.({}, ctx);
	await mock.events.get("before_agent_start")?.[0]?.({}, ctx);
	assert.equal(closedSessions.length, 1);

	const command = mock.commands.get("codex-account");
	assert.ok(command);
	await command.handler("home", ctx);
	assert.equal(closedSessions.length, 2);
});

test("status is visible only while the selected model is openai-codex", async () => {
	const store = new CodexAccountStore(new InMemoryAuthStorageBackend());
	await store.write({ active: "work", accounts: { work: validCred("work") } });
	const mock = createMockPi();
	codexAccounts(mock.pi, { store });
	const runtimeAuth = { setRuntimeApiKey: () => undefined, removeRuntimeApiKey: () => undefined };
	const { ctx, statuses } = createMockContext({
		model: { provider: "openai-codex", id: "gpt-5.5" },
		modelRegistry: { authStorage: runtimeAuth },
	});

	await mock.events.get("session_start")?.[0]?.({}, ctx);
	assert.equal(statuses.get(CODEX_ACCOUNTS_STATUS_KEY), "codex:work");

	await mock.events.get("model_select")?.[0]?.(
		{ model: { provider: "anthropic", id: "claude" } },
		ctx,
	);
	assert.equal(statuses.get(CODEX_ACCOUNTS_STATUS_KEY), undefined);
});

test("completeStoredAccountArguments suggests stored accounts and default", async () => {
	const store = new CodexAccountStore(new InMemoryAuthStorageBackend());
	await store.write({
		active: "work",
		accounts: { work: validCred("work"), home: validCred("home") },
	});

	assert.deepEqual(
		completeStoredAccountArguments("", store).map((item) => item.value),
		["default", "home", "work"],
	);
	assert.deepEqual(
		completeStoredAccountArguments("h", store).map((item) => item.value),
		["home"],
	);
});

test("isOpenAICodexModel checks provider only", () => {
	assert.equal(isOpenAICodexModel({ provider: "openai-codex" }), true);
	assert.equal(isOpenAICodexModel({ provider: "openai" }), false);
});
