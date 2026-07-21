import * as piAiOAuth from "@earendil-works/pi-ai/oauth";

export type DeviceCodeInfo = {
	userCode: string;
	verificationUri: string;
	intervalSeconds?: number;
	expiresInSeconds?: number;
};

export type OAuthCredentials = piAiOAuth.OAuthCredentials;
type OAuthLoginCallbacks = piAiOAuth.OAuthLoginCallbacks;
export type CodexOAuthPrompt = Parameters<OAuthLoginCallbacks["onPrompt"]>[0] & {
	signal?: AbortSignal;
};
export type CodexOAuthSelectPrompt = Parameters<OAuthLoginCallbacks["onSelect"]>[0] & {
	signal?: AbortSignal;
};
interface ProviderOwnedOAuthPrompt {
	message: string;
	options?: ReadonlyArray<{ id: string; label: string }>;
	placeholder?: string;
	signal?: AbortSignal;
	type: string;
}

type ProviderOwnedOAuthNotification =
	| { type: "info"; message: string; links?: ReadonlyArray<{ url: string }> }
	| { type: "auth_url"; url: string; instructions?: string }
	| ({ type: "device_code" } & DeviceCodeInfo)
	| { type: "progress"; message: string };

type OAuthCredential = OAuthCredentials & { type: "oauth" };

interface ProviderOwnedOAuth {
	login(options: {
		signal?: AbortSignal;
		prompt(prompt: ProviderOwnedOAuthPrompt): Promise<string>;
		notify(event: ProviderOwnedOAuthNotification): void;
	}): Promise<OAuthCredentials>;
	refresh(credentials: OAuthCredential): Promise<OAuthCredentials>;
	toAuth(credentials: OAuthCredential): Promise<{ apiKey?: string }>;
}

interface BuiltinProviderModule {
	builtinProviders(): ReadonlyArray<{
		id: string;
		auth: { oauth?: ProviderOwnedOAuth };
	}>;
}

const PROVIDERS_MODULE_ID = "@earendil-works/pi-ai/providers/all";

export type CodexOAuthCallbacks = Omit<
	OAuthLoginCallbacks,
	"onManualCodeInput" | "onPrompt" | "onSelect"
> & {
	onDeviceCode?: (info: DeviceCodeInfo) => void;
	onManualCodeInput?: (signal?: AbortSignal) => Promise<string>;
	onPrompt: (prompt: CodexOAuthPrompt) => Promise<string>;
	onSelect: (prompt: CodexOAuthSelectPrompt) => Promise<string | undefined>;
};

export type CodexOAuthProvider = {
	login(callbacks: CodexOAuthCallbacks): Promise<OAuthCredentials>;
	refreshToken(credentials: OAuthCredentials): Promise<OAuthCredentials>;
	getApiKey(credentials: OAuthCredentials): string | Promise<string>;
};

export type RefreshOnlyCodexOAuthProvider = Pick<CodexOAuthProvider, "refreshToken" | "getApiKey">;

let defaultCodexOAuthProvider: CodexOAuthProvider | undefined;
let providerOwnedOAuthPromise: Promise<ProviderOwnedOAuth> | undefined;

export function getDefaultCodexOAuthProvider(providerId: string): CodexOAuthProvider {
	if (defaultCodexOAuthProvider) return defaultCodexOAuthProvider;
	const legacyProvider = (piAiOAuth as unknown as { openaiCodexOAuthProvider?: CodexOAuthProvider })
		.openaiCodexOAuthProvider;
	defaultCodexOAuthProvider = legacyProvider ?? createProviderOwnedCodexOAuthAdapter(providerId);
	return defaultCodexOAuthProvider;
}

function createProviderOwnedCodexOAuthAdapter(providerId: string): CodexOAuthProvider {
	return {
		login: async (callbacks) => {
			const oauth = await loadProviderOwnedCodexOAuth(providerId);
			return oauth.login({
				signal: callbacks.signal,
				prompt: async (prompt) => {
					if (prompt.type === "select") {
						const selected = await callbacks.onSelect({
							message: prompt.message,
							options: (prompt.options ?? []).map(({ id, label }) => ({ id, label })),
							signal: prompt.signal,
						});
						if (selected === undefined) throw new Error("Login cancelled");
						return selected;
					}
					if (prompt.type === "manual_code" && callbacks.onManualCodeInput) {
						return callbacks.onManualCodeInput(prompt.signal);
					}
					return callbacks.onPrompt({
						message: prompt.message,
						placeholder: prompt.placeholder,
						signal: prompt.signal,
					});
				},
				notify: (event) => {
					if ((event as { type: string }).type === "info") {
						const info = event as unknown as {
							message: string;
							links?: ReadonlyArray<{ url: string }>;
						};
						callbacks.onProgress?.(
							[info.message, ...(info.links ?? []).map((link) => link.url)].join("\n"),
						);
						return;
					}
					switch (event.type) {
						case "auth_url":
							callbacks.onAuth({ url: event.url, instructions: event.instructions });
							break;
						case "device_code":
							callbacks.onDeviceCode?.(event);
							break;
						case "progress":
							callbacks.onProgress?.(event.message);
							break;
					}
				},
			});
		},
		refreshToken: async (credentials) => {
			const oauth = await loadProviderOwnedCodexOAuth(providerId);
			return oauth.refresh(asOAuthCredential(credentials));
		},
		getApiKey: async (credentials) => {
			const oauth = await loadProviderOwnedCodexOAuth(providerId);
			const auth = await oauth.toAuth(asOAuthCredential(credentials));
			if (!auth.apiKey)
				throw new Error("Pi's built-in OpenAI Codex OAuth provider returned no access token.");
			return auth.apiKey;
		},
	};
}

function loadProviderOwnedCodexOAuth(providerId: string): Promise<ProviderOwnedOAuth> {
	providerOwnedOAuthPromise ??= import(PROVIDERS_MODULE_ID).then((module: unknown) => {
		const { builtinProviders } = module as BuiltinProviderModule;
		const oauth = builtinProviders().find((provider) => provider.id === providerId)?.auth.oauth;
		if (!oauth) throw new Error("Pi's built-in OpenAI Codex OAuth provider is unavailable.");
		return oauth;
	});
	return providerOwnedOAuthPromise;
}

function asOAuthCredential(credentials: OAuthCredentials) {
	return { ...credentials, type: "oauth" as const };
}
