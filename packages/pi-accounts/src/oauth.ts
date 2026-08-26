import {
	type AuthEvent,
	type AuthPrompt,
	cleanupSessionResources,
	type OAuthAuth,
	type OAuthCredential,
	type ProviderAuthInteraction,
} from "@earendil-works/pi-ai";
import {
	type ExtensionCommandContext,
	ExtensionSelectorComponent,
	LoginDialogComponent,
} from "@earendil-works/pi-coding-agent";

export const SUPPORTED_PROVIDER_IDS = ["anthropic", "github-copilot", "openai-codex"] as const;

export type AccountProviderId = (typeof SUPPORTED_PROVIDER_IDS)[number];

export type ProviderOwnedOAuth = Pick<OAuthAuth, "login" | "refresh" | "toAuth">;

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
	signal: AbortSignal,
): ProviderAuthInteraction {
	return {
		signal,
		prompt: async (prompt) => promptForOAuth(ctx, prompt, signal),
		notify: (event) => notifyOAuthEvent(ctx, providerName, event),
	};
}

export async function loginWithOAuthUI(
	ctx: ExtensionCommandContext,
	adapter: AccountProviderAdapter,
	signal: AbortSignal,
): Promise<OAuthCredential> {
	if (ctx.mode !== "tui") {
		return adapter.oauth.login(createOAuthInteraction(ctx, adapter.displayName, signal));
	}
	const result = await ctx.ui.custom<NativeOAuthLoginResult>((tui, _theme, _keybindings, done) => {
		const flow = new NativeOAuthLoginFlow(tui, adapter, signal, done);
		flow.start();
		return flow;
	});
	if (result.ok) return result.credential;
	throw result.error;
}

type NativeOAuthLoginResult =
	| { ok: true; credential: OAuthCredential }
	| { ok: false; error: unknown };

type NativeOAuthComponent = {
	render(width: number): string[];
	handleInput?(data: string): void;
	invalidate(): void;
	dispose?(): void;
	focused?: boolean;
};

class NativeOAuthLoginFlow {
	private readonly dialog: LoginDialogComponent;
	private readonly controller = new AbortController();
	private readonly signal: AbortSignal;
	private current: NativeOAuthComponent;
	private focusedState = false;
	private completed = false;

	constructor(
		private readonly tui: ConstructorParameters<typeof LoginDialogComponent>[0],
		private readonly adapter: AccountProviderAdapter,
		ownerSignal: AbortSignal,
		private readonly done: (result: NativeOAuthLoginResult) => void,
	) {
		this.dialog = new LoginDialogComponent(
			tui,
			adapter.id,
			() => this.controller.abort(),
			adapter.displayName,
		);
		this.current = this.dialog;
		this.signal = AbortSignal.any([ownerSignal, this.dialog.signal, this.controller.signal]);
	}

	get focused(): boolean {
		return this.focusedState;
	}

	set focused(value: boolean) {
		this.focusedState = value;
		setComponentFocus(this.current, value);
	}

	start(): void {
		if (this.signal.aborted) {
			this.finish({ ok: false, error: new Error("Login cancelled") });
			return;
		}
		const login = this.adapter.oauth.login({
			signal: this.signal,
			prompt: (prompt) => this.prompt(prompt),
			notify: (event) => this.notify(event),
		});
		void abortable(login, this.signal).then(
			(credential) => this.finish({ ok: true, credential }),
			(error) => this.finish({ ok: false, error }),
		);
	}

	render(width: number): string[] {
		return this.current.render(width);
	}

	handleInput(data: string): void {
		this.current.handleInput?.(data);
	}

	invalidate(): void {
		this.current.invalidate();
	}

	dispose(): void {
		this.controller.abort();
		if (this.current !== this.dialog) this.current.dispose?.();
	}

	private async prompt(prompt: AuthPrompt): Promise<string> {
		if (prompt.type === "select") return this.select(prompt);
		const response =
			prompt.type === "manual_code"
				? this.dialog.showManualInput(prompt.message)
				: this.dialog.showPrompt(prompt.message, prompt.placeholder);
		const signal = prompt.signal ? AbortSignal.any([this.signal, prompt.signal]) : this.signal;
		return abortable(response, signal);
	}

	private select(prompt: Extract<AuthPrompt, { type: "select" }>): Promise<string> {
		return new Promise((resolve, reject) => {
			let settled = false;
			const signal = prompt.signal ? AbortSignal.any([this.signal, prompt.signal]) : this.signal;
			const restore = () => {
				if (settled) return false;
				settled = true;
				signal.removeEventListener("abort", cancel);
				selector.dispose();
				this.show(this.dialog);
				return true;
			};
			const cancel = () => {
				if (!restore()) return;
				reject(new Error("Login cancelled"));
			};
			const selector = new ExtensionSelectorComponent(
				prompt.message,
				prompt.options.map((option) => option.label),
				(label) => {
					if (!restore()) return;
					const id = prompt.options.find((option) => option.label === label)?.id;
					if (id === undefined) reject(new Error("Login cancelled"));
					else resolve(id);
				},
				cancel,
				{ tui: this.tui },
			);
			if (signal.aborted) {
				cancel();
				return;
			}
			signal.addEventListener("abort", cancel, { once: true });
			this.show(selector);
		});
	}

	private notify(event: AuthEvent): void {
		if (this.completed) return;
		switch (event.type) {
			case "auth_url":
				this.dialog.showAuth(event.url, event.instructions);
				break;
			case "device_code":
				this.dialog.showDeviceCode(event);
				this.dialog.showWaiting("Waiting for authentication...");
				break;
			case "info":
				this.dialog.showInfo(event.message, event.links);
				break;
			case "progress":
				this.dialog.showProgress(event.message);
				break;
		}
	}

	private show(component: NativeOAuthComponent): void {
		setComponentFocus(this.current, false);
		this.current = component;
		setComponentFocus(this.current, this.focusedState);
		this.tui.requestRender();
	}

	private finish(result: NativeOAuthLoginResult): void {
		if (this.completed) return;
		this.completed = true;
		this.done(result);
	}
}

function setComponentFocus(component: NativeOAuthComponent, focused: boolean): void {
	if ("focused" in component) component.focused = focused;
}

async function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
	if (signal.aborted) throw new Error("Login cancelled");
	let onAbort: (() => void) | undefined;
	const aborted = new Promise<never>((_resolve, reject) => {
		onAbort = () => reject(new Error("Login cancelled"));
		signal.addEventListener("abort", onAbort, { once: true });
	});
	try {
		return await Promise.race([operation, aborted]);
	} finally {
		if (onAbort) signal.removeEventListener("abort", onAbort);
	}
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

async function promptForOAuth(
	ctx: ExtensionCommandContext,
	prompt: AuthPrompt,
	loginSignal: AbortSignal,
): Promise<string> {
	const signal = prompt.signal ? AbortSignal.any([loginSignal, prompt.signal]) : loginSignal;
	if (prompt.type === "select") {
		const selected = await ctx.ui.select(
			prompt.message,
			prompt.options.map((option) => option.label),
			{ signal },
		);
		const id = prompt.options.find((option) => option.label === selected)?.id;
		if (id === undefined) throw new Error("Login cancelled");
		return id;
	}
	const value = await ctx.ui.input(prompt.message, prompt.placeholder ?? "", { signal });
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
