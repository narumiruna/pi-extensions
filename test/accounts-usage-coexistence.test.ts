import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { afterEach, test } from "vitest";
import accountsExtension, {
	AccountStore,
	type StoredOAuthCredential,
} from "../packages/pi-accounts/src/accounts.js";
import type { AccountProviderAdapter } from "../packages/pi-accounts/src/oauth.js";
import { OAUTH_CREDENTIAL_SOURCE_CHANNEL } from "../packages/pi-accounts/src/oauth-credential-source.js";
import { InMemoryAccountStorageBackend } from "../packages/pi-accounts/src/storage.js";
import usageExtension from "../packages/pi-usage/src/usage.js";
import { createMockContext, createMockPi } from "./support.js";

initTheme("dark", false);

const originalFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = originalFetch;
});

const copilotModel = {
	id: "gpt-5.4",
	name: "GPT-5.4",
	provider: "github-copilot",
	baseUrl: "https://api.individual.githubcopilot.com",
};

function credential(suffix: string): StoredOAuthCredential {
	return {
		type: "oauth",
		access: `runtime-${suffix}`,
		refresh: `github-${suffix}`,
		expires: Date.now() + 60 * 60 * 1000,
	};
}

function provider(id: AccountProviderAdapter["id"]): AccountProviderAdapter {
	return {
		id,
		displayName:
			id === "openai-codex" ? "OpenAI Codex" : id === "anthropic" ? "Anthropic" : "GitHub Copilot",
		requiresApiKeyBridge: id === "openai-codex",
		oauth: {
			async login() {
				return credential(id);
			},
			async refresh(current) {
				return current;
			},
			async toAuth(current) {
				return { apiKey: current.access };
			},
		},
	};
}

function runtimeRegistry(mock: ReturnType<typeof createMockPi>) {
	const keys = new Map<string, string>();
	const runtime = {
		async setRuntimeApiKey(providerId: string, apiKey: string) {
			keys.set(providerId, apiKey);
		},
		async removeRuntimeApiKey(providerId: string) {
			keys.delete(providerId);
		},
	};
	return {
		keys,
		registry: {
			runtime,
			getRegisteredProviderConfig: (providerId: string) => mock.providers.get(providerId),
			getApiKeyForProvider: async (providerId: string) => keys.get(providerId),
			getApiKeyAndHeaders: async (model: { provider: string }) => ({
				ok: true as const,
				apiKey: keys.get(model.provider),
			}),
			getProviderAuth: async (providerId: string) => {
				const apiKey = keys.get(providerId);
				return apiKey
					? {
							auth: {
								apiKey,
								...(providerId === "github-copilot" ? { baseUrl: copilotModel.baseUrl } : {}),
							},
						}
					: undefined;
			},
			getAvailable: () => [copilotModel],
			getAll: () => [copilotModel],
			getProviderAuthStatus: (providerId: string) => ({
				configured: keys.has(providerId),
			}),
			getProviderDisplayName: (providerId: string) => providerId,
			find: (providerId: string, modelId: string) =>
				providerId === copilotModel.provider && modelId === copilotModel.id
					? copilotModel
					: undefined,
		},
	};
}

async function createStore() {
	const store = new AccountStore(new InMemoryAccountStorageBackend());
	await store.write({
		version: 1,
		providers: {
			"github-copilot": {
				active: "first",
				accounts: { first: credential("first"), second: credential("second") },
			},
		},
	});
	return store;
}

function registerAccounts(mock: ReturnType<typeof createMockPi>, store: AccountStore) {
	const sessionStartIndex = mock.events.get("session_start")?.length ?? 0;
	const modelSelectIndex = mock.events.get("model_select")?.length ?? 0;
	accountsExtension(mock.pi, {
		store,
		providers: [provider("openai-codex"), provider("anthropic"), provider("github-copilot")],
	});
	return {
		sessionStart: mock.events.get("session_start")?.[sessionStartIndex],
		modelSelect: mock.events.get("model_select")?.[modelSelectIndex],
	};
}

function registerUsage(mock: ReturnType<typeof createMockPi>): void {
	usageExtension(mock.pi, {
		credentialReader: () => ({
			...credential("default"),
			access: "unrelated-default-runtime",
		}),
	});
}

function installUsageFetch(requests: Array<{ url: string; authorization: string | null }>): void {
	globalThis.fetch = async (input, init) => {
		const headers = new Headers(init?.headers);
		requests.push({ url: String(input), authorization: headers.get("authorization") });
		return new Response(
			JSON.stringify({
				quota_snapshots: {
					premium_interactions: { entitlement: 10, remaining: 7 },
				},
				login: "named-account",
			}),
			{ status: 200 },
		);
	};
}

test.each(["accounts-first", "usage-first"] as const)(
	"source extensions coexist in %s order across named usage and account switching",
	async (order) => {
		const requests: Array<{ url: string; authorization: string | null }> = [];
		installUsageFetch(requests);
		const store = await createStore();
		const mock = createMockPi();
		let accountHooks: ReturnType<typeof registerAccounts>;
		if (order === "accounts-first") {
			accountHooks = registerAccounts(mock, store);
			registerUsage(mock);
		} else {
			registerUsage(mock);
			accountHooks = registerAccounts(mock, store);
		}
		const { keys, registry } = runtimeRegistry(mock);
		const titles: string[] = [];
		const { ctx } = createMockContext({
			hasUI: true,
			mode: "rpc",
			model: copilotModel,
			modelRegistry: registry,
			select: async (title: string) => {
				titles.push(title);
				return "Close";
			},
		});

		await accountHooks.sessionStart?.({}, ctx);
		await mock.commands.get("usage")?.handler("", ctx);
		assert.equal(requests.length, 1);
		assert.deepEqual(requests[0], {
			url: "https://api.github.com/copilot_internal/user",
			authorization: "Bearer github-first",
		});
		assert.match(titles.at(-1) ?? "", /named-account/iu);

		await store.updateProvider("github-copilot", (state) => ({ ...state, active: "second" }));
		await accountHooks.modelSelect?.({ model: copilotModel }, ctx);
		await mock.commands.get("usage")?.handler("", ctx);
		assert.equal(requests.length, 2);
		assert.equal(requests[1]?.authorization, "Bearer github-second");

		keys.set("github-copilot", "runtime-with-no-matching-oauth");
		await mock.commands.get("usage")?.handler("", ctx);
		assert.equal(requests.length, 2);
		assert.match(titles.at(-1) ?? "", /Authentication unavailable/iu);
	},
);

test("built generated entries complete a representative named-account usage boundary", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-accounts-usage-generated-"));
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	const previousFetch = globalThis.fetch;
	process.env.PI_CODING_AGENT_DIR = join(root, "agent");
	const requests: Array<{ url: string; authorization: string | null }> = [];
	installUsageFetch(requests);
	try {
		const [{ default: generatedAccounts }, { default: generatedUsage }] = await Promise.all([
			import("../packages/pi-accounts/dist/index.js"),
			import("../packages/pi-usage/dist/index.js"),
		]);
		const store = await createStore();
		const mock = createMockPi();
		const sessionStartIndex = mock.events.get("session_start")?.length ?? 0;
		generatedAccounts(mock.pi, {
			store,
			providers: [provider("openai-codex"), provider("anthropic"), provider("github-copilot")],
		});
		const accountSessionStart = mock.events.get("session_start")?.[sessionStartIndex];
		generatedUsage(mock.pi, {
			credentialReader: () => ({
				...credential("default"),
				access: "unrelated-default-runtime",
			}),
		});
		const { registry } = runtimeRegistry(mock);
		const { ctx } = createMockContext({
			hasUI: true,
			mode: "rpc",
			model: copilotModel,
			modelRegistry: registry,
			select: async () => "Close",
		});

		await accountSessionStart?.({}, ctx);
		await mock.commands.get("usage")?.handler("", ctx);
		assert.deepEqual(requests, [
			{
				url: "https://api.github.com/copilot_internal/user",
				authorization: "Bearer github-first",
			},
		]);
	} finally {
		globalThis.fetch = previousFetch;
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		rmSync(root, { force: true, recursive: true });
	}
});

test.each(["conflict-first", "conflict-last"] as const)(
	"conflicting matching credential fails closed with %s listener order",
	async (order) => {
		let requests = 0;
		globalThis.fetch = async () => {
			requests += 1;
			return new Response("{}", { status: 200 });
		};
		const store = await createStore();
		const mock = createMockPi();
		const registerConflict = () => {
			mock.eventBus.on(OAUTH_CREDENTIAL_SOURCE_CHANNEL, (data) => {
				const request = data as {
					session: object;
					provider: string;
					offer(candidate: unknown): void;
				};
				if (request.provider !== "github-copilot") return;
				request.offer({ ...credential("first"), refresh: "conflicting-refresh" });
			});
		};
		if (order === "conflict-first") registerConflict();
		registerAccounts(mock, store);
		registerUsage(mock);
		if (order === "conflict-last") registerConflict();
		const { registry } = runtimeRegistry(mock);
		const { ctx } = createMockContext({
			hasUI: true,
			mode: "rpc",
			model: copilotModel,
			modelRegistry: registry,
			select: async () => "Close",
		});

		await mock.events.get("session_start")?.[0]?.({}, ctx);
		await mock.commands.get("usage")?.handler("", ctx);
		assert.equal(requests, 0);
	},
);
