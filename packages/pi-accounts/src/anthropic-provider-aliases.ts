import type { OAuthCredential } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type AccountStore, defineOwn, getOwnCredential } from "./account-store.js";
import type { AccountProviderAdapter } from "./oauth.js";

const PREFIX = "anthropic-";
const REFRESH_SKEW_MS = 5 * 60 * 1000;
const PLACEHOLDER_API_KEY = "pi-anthropic-account-provider-pending";

type ProviderModel = {
	id: string;
	name?: string;
	api?: "anthropic-messages";
	reasoning?: boolean;
	thinkingLevelMap?: Record<string, string | null>;
	input?: ("text" | "image")[];
	cost?: { input: number; output: number; cacheRead: number; cacheWrite: number };
	contextWindow?: number;
	maxTokens?: number;
	compat?: Record<string, unknown>;
};

/** Register a stable /model provider for every saved named Anthropic account. */
export function registerAnthropicProviderAliases(
	pi: ExtensionAPI,
	store: AccountStore,
	provider: AccountProviderAdapter,
): void {
	let models: ProviderModel[] = [];
	let aliases = new Set<string>();

	const sync = async (ctx: ExtensionContext): Promise<void> => {
		const state = await store.readProviderAsync("anthropic");
		models = readAnthropicModels(ctx);
		const nextAliases = new Set(Object.keys(state.accounts).map((name) => `${PREFIX}${name}`));
		for (const alias of aliases) if (!nextAliases.has(alias)) pi.unregisterProvider(alias);
		for (const alias of nextAliases) registerAlias(pi, alias, models, PLACEHOLDER_API_KEY);
		aliases = nextAliases;
	};

	pi.on("session_start", async (_event, ctx) => {
		try {
			await sync(ctx);
		} catch (error) {
			ctx.ui.notify(`Anthropic account aliases were not loaded: ${message(error)}`, "warning");
		}
	});

	pi.on("before_agent_start", async (_event, ctx) => {
		const alias = ctx.model?.provider;
		if (!alias?.startsWith(PREFIX)) return;
		const accountName = alias.slice(PREFIX.length);
		try {
			let credential = await namedCredential(store, accountName);
			if (credential.expires <= Date.now() + REFRESH_SKEW_MS) {
				credential = await refreshNamedCredential(store, provider, accountName);
			}
			registerAlias(
				pi,
				alias,
				models.length > 0 ? models : readAnthropicModels(ctx),
				credential.access,
			);
		} catch (error) {
			ctx.ui.notify(
				`Anthropic account "${accountName}" is unavailable: ${message(error)}`,
				"error",
			);
			ctx.abort();
		}
	});

	pi.registerCommand("anthropic-account-providers", {
		description: "Refresh named Anthropic account providers shown by /model",
		handler: async (_args, ctx) => {
			await sync(ctx);
			ctx.ui.notify(
				aliases.size
					? `Registered: ${[...aliases].sort().join(", ")}`
					: "No named Anthropic accounts found.",
				"info",
			);
		},
	});
}

function registerAlias(
	pi: ExtensionAPI,
	id: string,
	models: ProviderModel[],
	apiKey: string,
): void {
	pi.unregisterProvider(id);
	pi.registerProvider(id, {
		name: id,
		baseUrl: "https://api.anthropic.com",
		api: "anthropic-messages",
		apiKey,
		// These are cloned from Pi's resolved native Anthropic catalogue. The
		// runtime registry's model shape is intentionally richer than the legacy
		// registerProvider config type, but every retained field is supported.
		models: models as never,
	});
}

function readAnthropicModels(ctx: ExtensionContext): ProviderModel[] {
	return ctx.modelRegistry
		.getAvailable()
		.filter((model) => model.provider === "anthropic")
		.map(({ provider: _provider, baseUrl: _baseUrl, ...model }) => ({ ...model }) as ProviderModel);
}

async function namedCredential(store: AccountStore, accountName: string): Promise<OAuthCredential> {
	const state = await store.readProviderAsync("anthropic");
	const credential = getOwnCredential(state.accounts, accountName);
	if (!credential) throw new Error("Named account no longer exists.");
	return credential;
}

async function refreshNamedCredential(
	store: AccountStore,
	provider: AccountProviderAdapter,
	accountName: string,
): Promise<OAuthCredential> {
	let refreshed: OAuthCredential | undefined;
	await store.updateProviderAsync("anthropic", async (state) => {
		const current = getOwnCredential(state.accounts, accountName);
		if (!current) throw new Error("Named account was removed while refreshing.");
		if (current.expires > Date.now() + REFRESH_SKEW_MS) {
			refreshed = current;
			return state;
		}
		refreshed = await provider.oauth.refresh(current);
		return { ...state, accounts: defineOwn(state.accounts, accountName, refreshed) };
	});
	if (!refreshed) throw new Error("Named account refresh did not return a credential.");
	return refreshed;
}

function message(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
