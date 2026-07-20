import {
	type AuthEvent,
	type AuthInteraction,
	type AuthPrompt,
	cleanupSessionResources,
	type ModelAuth,
	type OAuthCredential,
} from "@earendil-works/pi-ai";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

export const SUPPORTED_PROVIDER_IDS = ["anthropic", "github-copilot", "openai-codex"] as const;

export type AccountProviderId = (typeof SUPPORTED_PROVIDER_IDS)[number];

export interface ProviderOwnedOAuth {
	login(interaction: AuthInteraction): Promise<OAuthCredential>;
	refresh(credential: OAuthCredential, signal?: AbortSignal): Promise<OAuthCredential>;
	toAuth(credential: OAuthCredential): Promise<ModelAuth>;
}

export type AccountProviderAdapter = {
	id: AccountProviderId;
	displayName: string;
	oauth: ProviderOwnedOAuth;
	requiresApiKeyBridge: boolean;
	defaultModelId?: string;
	invalidateConnections?: (sessionId?: string) => unknown | Promise<unknown>;
};

type BuiltinProviderModule = {
	builtinProviders(): ReadonlyArray<{
		id: string;
		auth: { oauth?: ProviderOwnedOAuth };
	}>;
};

type ProviderModuleLoader = () => Promise<BuiltinProviderModule>;

const PROVIDERS_MODULE_ID = "@earendil-works/pi-ai/providers/all";
const oauthPromises = new Map<string, Promise<ProviderOwnedOAuth>>();

export function createBuiltinProviderAdapters(
	options: {
		closeCodexWebSockets?: (sessionId?: string) => unknown | Promise<unknown>;
		loader?: ProviderModuleLoader;
	} = {},
): AccountProviderAdapter[] {
	const loader = options.loader ?? defaultProviderModuleLoader;
	return [
		{
			id: "openai-codex",
			displayName: "OpenAI Codex",
			requiresApiKeyBridge: true,
			defaultModelId: "gpt-5.5",
			invalidateConnections: options.closeCodexWebSockets ?? cleanupSessionResources,
			oauth: createLazyProviderOwnedOAuth("openai-codex", loader),
		},
		{
			id: "anthropic",
			displayName: "Anthropic",
			requiresApiKeyBridge: false,
			oauth: createLazyProviderOwnedOAuth("anthropic", loader),
		},
		{
			id: "github-copilot",
			displayName: "GitHub Copilot",
			requiresApiKeyBridge: false,
			oauth: createLazyProviderOwnedOAuth("github-copilot", loader),
		},
	];
}

export function createOAuthInteraction(
	ctx: ExtensionCommandContext,
	providerName: string,
): AuthInteraction {
	return {
		signal: ctx.signal,
		prompt: async (prompt) => promptForOAuth(ctx, prompt),
		notify: (event) => notifyOAuthEvent(ctx, providerName, event),
	};
}

function createLazyProviderOwnedOAuth(
	providerId: AccountProviderId,
	loader: ProviderModuleLoader,
): ProviderOwnedOAuth {
	const load = () => loadProviderOwnedOAuth(providerId, loader);
	return {
		login: async (interaction) => (await load()).login(interaction),
		refresh: async (credential, signal) => (await load()).refresh(credential, signal),
		toAuth: async (credential) => (await load()).toAuth(credential),
	};
}

async function loadProviderOwnedOAuth(
	providerId: AccountProviderId,
	loader: ProviderModuleLoader,
): Promise<ProviderOwnedOAuth> {
	let promise = oauthPromises.get(providerId);
	if (!promise) {
		promise = loader().then((module) => {
			const oauth = module.builtinProviders().find((provider) => provider.id === providerId)
				?.auth.oauth;
			if (!oauth) throw new Error(`Pi's built-in ${providerId} OAuth provider is unavailable.`);
			return oauth;
		});
		oauthPromises.set(providerId, promise);
	}
	return promise;
}

async function defaultProviderModuleLoader(): Promise<BuiltinProviderModule> {
	return (await import(PROVIDERS_MODULE_ID)) as BuiltinProviderModule;
}

async function promptForOAuth(ctx: ExtensionCommandContext, prompt: AuthPrompt): Promise<string> {
	if (prompt.type === "select") {
		const selected = await ctx.ui.select(
			prompt.message,
			prompt.options.map((option) => option.label),
			{ signal: prompt.signal },
		);
		const id = prompt.options.find((option) => option.label === selected)?.id;
		if (id === undefined) throw new Error("Login cancelled");
		return id;
	}
	const value = await ctx.ui.input(prompt.message, prompt.placeholder ?? "", {
		signal: prompt.signal,
	});
	if (value === undefined) throw new Error("Login cancelled");
	return value;
}

function notifyOAuthEvent(
	ctx: ExtensionCommandContext,
	providerName: string,
	event: AuthEvent,
): void {
	switch (event.type) {
		case "info":
			ctx.ui.notify(
				[event.message, ...(event.links ?? []).map((link) => link.url)].join("\n"),
				"info",
			);
			break;
		case "auth_url":
			ctx.ui.notify(
				[`Open this URL to login to ${providerName}:`, event.url, event.instructions]
					.filter(Boolean)
					.join("\n"),
				"info",
			);
			break;
		case "device_code":
			ctx.ui.notify(
				[
					`Open this URL and enter the ${providerName} login code:`,
					event.verificationUri,
					`Code: ${event.userCode}`,
				].join("\n"),
				"info",
			);
			break;
		case "progress":
			ctx.ui.notify(event.message, "info");
			break;
	}
}
