import assert from "node:assert/strict";
import { initTheme } from "@earendil-works/pi-coding-agent";
import {
	getKeybindings,
	KeybindingsManager,
	setKeybindings,
	TUI_KEYBINDINGS,
} from "@earendil-works/pi-tui";
import { test, vi } from "vitest";
import { createMockContext, createMockPi } from "../../../test/support.js";
import { OAUTH_CREDENTIAL_SOURCE_CHANNEL } from "../src/oauth-credential-source.js";
import type { UsageSettingsRuntime, UsageSettingsState } from "../src/settings.js";
import usageExtension from "../src/usage.js";
import { showUsageSettings } from "../src/usage-settings-ui.js";

initTheme("dark", false);

const openRouterModel = {
	id: "openai/gpt-4o",
	name: "GPT-4o",
	provider: "openrouter",
	baseUrl: "https://openrouter.ai/api/v1",
};
const codexToken = codexAccessToken("account-123");

const codexModel = {
	id: "gpt-5.3-codex",
	name: "GPT-5.3 Codex",
	provider: "openai-codex",
	baseUrl: "https://chatgpt.com/backend-api",
};

const xaiModel = {
	id: "grok-4.5",
	name: "Grok 4.5",
	provider: "xai",
	baseUrl: "https://api.x.ai/v1",
};

const zaiModel = {
	id: "glm-5.3",
	name: "GLM-5.3",
	provider: "zai",
	baseUrl: "https://api.z.ai/api/coding/paas/v4",
};

const kimiModel = {
	id: "kimi-k2",
	name: "Kimi K2",
	provider: "kimi-coding",
	baseUrl: "https://api.kimi.com/coding",
};

const deepSeekModel = {
	id: "deepseek-v4-pro",
	name: "DeepSeek V4 Pro",
	provider: "deepseek",
	baseUrl: "https://api.deepseek.com",
};

const miniMaxModel = {
	id: "MiniMax-M3",
	name: "MiniMax M3",
	provider: "minimax",
	baseUrl: "https://api.minimax.io/anthropic",
};

const fireworksModel = {
	id: "accounts/fireworks/models/kimi-k2p6",
	name: "Kimi K2.6",
	provider: "fireworks",
	baseUrl: "https://api.fireworks.ai/inference",
};

function testProviderDisplayName(provider: string): string {
	return (
		{
			"openai-codex": "OpenAI Codex",
			openrouter: "OpenRouter",
			deepseek: "DeepSeek",
			"kimi-coding": "Kimi For Coding",
			fireworks: "Fireworks",
			minimax: "MiniMax",
			xai: "xAI",
			zai: "Z.AI",
		}[provider] ?? provider
	);
}

function codexAccessToken(accountId: string): string {
	const payload = Buffer.from(
		JSON.stringify({
			"https://api.openai.com/auth": { chatgpt_account_id: accountId },
		}),
	).toString("base64url");
	return `header.${payload}.signature`;
}

function memorySettingsRuntime(
	options: {
		codexStatusResetCountdown?: boolean;
		fireworksAccountId?: string;
		selectedTargets?: Record<string, string>;
		document?: Record<string, unknown>;
		failUpdates?: boolean;
		kind?: UsageSettingsState["kind"];
		afterTargetWrite?: () => void;
	} = {},
): { runtime: UsageSettingsRuntime; state: () => UsageSettingsState } {
	const kind = options.kind ?? "loaded";
	let state: UsageSettingsState = {
		kind,
		path: "/tmp/pi-usage.json",
		settings: {
			codexFastMode: false,
			codexStatusResetCountdown: options.codexStatusResetCountdown ?? false,
			selectedTargets: {
				...(options.fireworksAccountId ? { fireworks: options.fireworksAccountId } : {}),
				...options.selectedTargets,
			},
		},
		...(kind === "invalid"
			? { issue: "invalid test settings" }
			: {
					document: {
						codexFastMode: false,
						selectedTargets: {
							...(options.fireworksAccountId ? { fireworks: options.fireworksAccountId } : {}),
							...options.selectedTargets,
						},
						...options.document,
					},
				}),
	};
	const runtime: UsageSettingsRuntime = {
		get: () => structuredClone(state),
		reload: async () => structuredClone(state),
		update: async (patch, signal) => {
			signal?.throwIfAborted();
			if (options.failUpdates) throw new Error("disk full");
			state = {
				...state,
				settings: { ...state.settings, ...patch },
				document: { ...state.document, ...patch },
			};
			return structuredClone(state);
		},
		updateSelectedTarget: async (providerId, targetId, signal, checkPublishedSelection) => {
			signal?.throwIfAborted();
			if (options.failUpdates) throw new Error("disk full");
			const selectedTargets = { ...state.settings.selectedTargets, [providerId]: targetId };
			const next = {
				...state,
				settings: { ...state.settings, selectedTargets },
				document: { ...state.document, selectedTargets },
			};
			options.afterTargetWrite?.();
			await checkPublishedSelection?.();
			signal?.throwIfAborted();
			state = next;
			return structuredClone(state);
		},
		flush: async () => undefined,
	};
	return { runtime, state: () => structuredClone(state) };
}

async function settle(): Promise<void> {
	await new Promise<void>((resolve) => setImmediate(resolve));
	await new Promise<void>((resolve) => setImmediate(resolve));
}

function usageFetch(input: string | URL | Request): Promise<Response> {
	const url = String(input);
	if (url.endsWith("/api/v1/key")) {
		return Promise.resolve(
			new Response(
				JSON.stringify({
					data: {
						label: "test-key",
						limit: 100,
						limit_remaining: 75,
						limit_reset: "monthly",
						usage: 25,
						usage_daily: 1,
						usage_weekly: 5,
						usage_monthly: 25,
					},
				}),
				{ status: 200 },
			),
		);
	}
	if (url.endsWith("/coding/v1/usages")) {
		return Promise.resolve(
			new Response(
				JSON.stringify({
					usage: { used: "40", limit: "1000" },
					limits: [
						{
							window: { duration: "300", timeUnit: "TIME_UNIT_MINUTE" },
							detail: { used: "1", limit: "100" },
						},
					],
				}),
				{ status: 200 },
			),
		);
	}
	if (url.endsWith("/user/balance")) {
		return Promise.resolve(
			new Response(
				JSON.stringify({
					is_available: true,
					balance_infos: [
						{
							currency: "USD",
							total_balance: "12.50",
							granted_balance: "2.50",
							topped_up_balance: "10.00",
						},
					],
				}),
				{ status: 200 },
			),
		);
	}
	return Promise.resolve(
		new Response(
			JSON.stringify({
				plan_type: "pro",
				rate_limit: { primary_window: { used_percent: 20, limit_window_seconds: 18_000 } },
			}),
			{ status: 200 },
		),
	);
}

test("pi-usage registers its usage and Fast commands with lifecycle hooks", () => {
	const mock = createMockPi();
	usageExtension(mock.pi);

	assert.ok(mock.commands.has("usage"));
	assert.ok(mock.commands.has("fast"));
	assert.equal(mock.commands.has("codex-status"), false);
	assert.equal(mock.commands.get("usage")?.getArgumentCompletions, undefined);
	assert.equal(mock.commands.get("fast")?.getArgumentCompletions, undefined);
	assert.deepEqual([...mock.events.keys()].sort(), [
		"before_provider_request",
		"message_end",
		"model_select",
		"session_shutdown",
		"session_start",
		"session_tree",
		"turn_start",
	]);
});

test("/usage automatically queries the current runtime account and shows state plus next actions", async (t) => {
	const originalFetch = globalThis.fetch;
	t.onTestFinished(() => {
		globalThis.fetch = originalFetch;
	});
	globalThis.fetch = usageFetch;

	const selections: Array<{ title: string; options: string[] }> = [];
	const mock = createMockPi();
	usageExtension(mock.pi);
	const command = mock.commands.get("usage");
	assert.ok(command);
	const { ctx, statuses } = createMockContext({
		hasUI: true,
		mode: "rpc",
		model: openRouterModel,
		select: async (title: string, options: string[]) => {
			selections.push({ title, options });
			return "Close";
		},
		modelRegistry: {
			getProviderAuth: async () => ({ auth: { apiKey: "openrouter-key" } }),
			getAvailable: () => [openRouterModel],
			getAll: () => [openRouterModel, codexModel],
			getProviderAuthStatus: (provider: string) => ({ configured: provider === "openrouter" }),
			getProviderDisplayName: testProviderDisplayName,
		},
	});

	await command.handler("", ctx);

	assert.equal(selections.length, 1);
	assert.match(selections[0]?.title ?? "", /OpenRouter Usage · Current/);
	assert.match(selections[0]?.title ?? "", /test-key/);
	assert.deepEqual(selections[0]?.options, [
		"Refresh current usage",
		"Settings",
		"View another configured provider…",
		"View all configured providers…",
		"Close",
	]);
	assert.equal(statuses.get("usage"), "openrouter $75.00 left");
});

test("current Codex usage can redeem a selected reset and refresh account state", async (t) => {
	const originalFetch = globalThis.fetch;
	t.onTestFinished(() => {
		globalThis.fetch = originalFetch;
	});
	let usageRequests = 0;
	const requests: Array<{ url: string; init?: RequestInit }> = [];
	globalThis.fetch = async (input, init) => {
		const url = String(input);
		requests.push({ url, init });
		if (url.endsWith("/wham/rate-limit-reset-credits/consume")) {
			return new Response(JSON.stringify({ code: "reset", windows_reset: 2 }), { status: 200 });
		}
		if (url.endsWith("/wham/rate-limit-reset-credits")) {
			return new Response(
				JSON.stringify({
					credits: [
						{
							id: "credit-123",
							reset_type: "codex_rate_limits",
							status: "available",
							granted_at: "2026-06-17T00:00:00Z",
							expires_at: "2026-09-17T00:00:00Z",
							title: "Weekly + 5h reset",
							description: "Reset both current windows.",
						},
					],
					available_count: 1,
				}),
				{ status: 200 },
			);
		}
		usageRequests += 1;
		return new Response(
			JSON.stringify({
				plan_type: "pro",
				rate_limit: {
					primary_window: {
						used_percent: usageRequests === 1 ? 80 : 0,
						limit_window_seconds: 18_000,
					},
				},
				rate_limit_reset_credits: { available_count: usageRequests === 1 ? 1 : 0 },
			}),
			{ status: 200 },
		);
	};

	const choices = ["Redeem usage limit reset…", "Weekly + 5h reset", "Yes, use reset", "Close"];
	const titles: string[] = [];
	const mock = createMockPi();
	mock.eventBus.on(OAUTH_CREDENTIAL_SOURCE_CHANNEL, (data) => {
		const request = data as {
			provider: string;
			offer(candidate: unknown): void;
		};
		if (request.provider !== "openai-codex") return;
		request.offer({
			type: "oauth",
			access: codexToken,
			refresh: "named-refresh-token",
			expires: Date.now() + 60_000,
			accountId: "account-123",
		});
	});
	usageExtension(mock.pi, {
		credentialReader: () => ({
			type: "oauth",
			access: "default-codex-token",
			refresh: "default-refresh-token",
			expires: Date.now() + 60_000,
			accountId: "default-account",
		}),
		createRedemptionId: () => "redeem-123",
	});
	const command = mock.commands.get("usage");
	assert.ok(command);
	const { ctx, statuses } = createMockContext({
		hasUI: true,
		mode: "rpc",
		model: codexModel,
		select: async (title: string, options: string[]) => {
			titles.push(title);
			const choice = choices.shift();
			assert.ok(choice === undefined || options.includes(choice), `${choice} not in ${options}`);
			return choice;
		},
		modelRegistry: {
			getApiKeyAndHeaders: async () => ({ ok: true, apiKey: codexToken }),
			getProviderAuth: async () => ({ auth: { apiKey: codexToken } }),
			getAvailable: () => [codexModel],
			getAll: () => [codexModel],
			getProviderAuthStatus: () => ({ configured: true }),
			getProviderDisplayName: testProviderDisplayName,
		},
	});

	await command.handler("", ctx);

	const consume = requests.find((request) => request.url.endsWith("/consume"));
	assert.ok(consume);
	assert.deepEqual(JSON.parse(String(consume.init?.body)), {
		redeem_request_id: "redeem-123",
		credit_id: "credit-123",
	});
	assert.equal(new Headers(consume.init?.headers).get("chatgpt-account-id"), "account-123");
	assert.ok(usageRequests >= 2);
	assert.equal(statuses.get("usage"), "codex 100% 5h");
	assert.match(titles.at(-1) ?? "", /Usage reset.*0 usage limit resets left/isu);
});

test("Codex reset confirmation defaults to cancellation and sends no mutation", async (t) => {
	const originalFetch = globalThis.fetch;
	t.onTestFinished(() => {
		globalThis.fetch = originalFetch;
	});
	let postRequests = 0;
	globalThis.fetch = async (input, init) => {
		const url = String(input);
		if (init?.method === "POST") postRequests += 1;
		if (url.endsWith("/wham/rate-limit-reset-credits")) {
			return new Response(JSON.stringify({ available_count: 1 }), { status: 200 });
		}
		return new Response(
			JSON.stringify({
				rate_limit: { primary_window: { used_percent: 80, limit_window_seconds: 18_000 } },
				rate_limit_reset_credits: { available_count: 1 },
			}),
			{ status: 200 },
		);
	};
	const choices: Array<string | undefined> = [
		"Redeem usage limit reset…",
		"Full reset",
		"No, go back",
		undefined,
		"Close",
	];
	const confirmationOptions: string[][] = [];
	const mock = createMockPi();
	usageExtension(mock.pi, {
		credentialReader: () => ({
			type: "oauth",
			access: codexToken,
			refresh: "refresh-token",
			expires: Date.now() + 60_000,
			accountId: "account-123",
		}),
		createRedemptionId: () => "must-not-be-used",
	});
	const command = mock.commands.get("usage");
	assert.ok(command);
	const { ctx } = createMockContext({
		hasUI: true,
		mode: "rpc",
		model: codexModel,
		select: async (title: string, options: string[]) => {
			if (title.includes("Use this reset?")) confirmationOptions.push(options);
			return choices.shift();
		},
		modelRegistry: {
			getApiKeyAndHeaders: async () => ({ ok: true, apiKey: codexToken }),
			getProviderAuth: async () => ({ auth: { apiKey: codexToken } }),
			getAvailable: () => [codexModel],
			getAll: () => [codexModel],
			getProviderAuthStatus: () => ({ configured: true }),
			getProviderDisplayName: testProviderDisplayName,
		},
	});

	await command.handler("", ctx);

	assert.deepEqual(confirmationOptions[0], ["No, go back", "Yes, use reset"]);
	assert.equal(postRequests, 0);
});

test("command arguments are rejected instead of becoming a hidden interface", async () => {
	const mock = createMockPi();
	usageExtension(mock.pi);
	const command = mock.commands.get("usage");
	assert.ok(command);
	let selected = false;
	const { ctx, notifications } = createMockContext({
		hasUI: true,
		mode: "rpc",
		model: openRouterModel,
		select: async () => {
			selected = true;
			return "Close";
		},
	});

	await command.handler("--all", ctx);

	assert.equal(selected, false);
	assert.match(notifications[0]?.message ?? "", /does not accept arguments/);
});

test("explicit all-provider query retains DeepSeek balance, Kimi, and partial failures", async (t) => {
	const originalFetch = globalThis.fetch;
	t.onTestFinished(() => {
		globalThis.fetch = originalFetch;
	});
	const deepSeekFetchedKeys: string[] = [];
	globalThis.fetch = async (input, init) => {
		if (String(input).endsWith("/user/balance")) {
			deepSeekFetchedKeys.push(new Headers(init?.headers).get("authorization") ?? "");
			return usageFetch(input);
		}
		if (String(input).endsWith("/api/v1/key") || String(input).endsWith("/coding/v1/usages")) {
			return usageFetch(input);
		}
		return new Response("backend unavailable", { status: 503, statusText: "Unavailable" });
	};

	const titles: string[] = [];
	const choices = ["View all configured providers…", "Close"];
	const configured = new Set(["openrouter", "openai-codex", "kimi-coding", "deepseek"]);
	let deepSeekAuthLookups = 0;
	const mock = createMockPi();
	usageExtension(mock.pi);
	const command = mock.commands.get("usage");
	assert.ok(command);
	const { ctx, statuses } = createMockContext({
		hasUI: true,
		mode: "rpc",
		model: openRouterModel,
		select: async (title: string) => {
			titles.push(title);
			return choices.shift();
		},
		modelRegistry: {
			getProviderAuth: async (provider: string) => {
				if (provider === "deepseek") deepSeekAuthLookups += 1;
				return {
					auth: {
						apiKey:
							provider === "deepseek" && deepSeekAuthLookups === 1
								? "deepseek-account-a"
								: `${provider}-key`,
						...(provider === "kimi-coding" ? { baseUrl: kimiModel.baseUrl } : {}),
					},
				};
			},
			getAvailable: () => [openRouterModel, codexModel, kimiModel, deepSeekModel],
			getAll: () => [openRouterModel, codexModel, kimiModel, deepSeekModel],
			getProviderAuthStatus: (provider: string) => ({
				configured: configured.has(provider),
				source: "stored",
			}),
			getProviderDisplayName: testProviderDisplayName,
		},
	});

	await command.handler("", ctx);

	assert.equal(titles.length, 2);
	assert.match(titles[1] ?? "", /OpenRouter Usage · Current/);
	assert.match(titles[1] ?? "", /OpenAI Codex · Configured/);
	assert.match(titles[1] ?? "", /Kimi For Coding Usage · Configured/);
	assert.match(titles[1] ?? "", /1 of 100 used · 99% left/);
	assert.match(titles[1] ?? "", /DeepSeek API Balance · Configured/);
	assert.match(titles[1] ?? "", /Total balance:\s+USD 12\.50/u);
	assert.deepEqual(deepSeekFetchedKeys, ["Bearer deepseek-key"]);
	assert.match(titles[1] ?? "", /query failed/i);
	assert.equal(statuses.get("usage"), "openrouter $75.00 left");
});

test("auth-unavailable target providers do not expose a no-op target action", async () => {
	const options: string[] = [];
	const mock = createMockPi();
	usageExtension(mock.pi, { settingsRuntime: memorySettingsRuntime().runtime });
	const command = mock.commands.get("usage");
	assert.ok(command);
	const { ctx } = createMockContext({
		hasUI: true,
		mode: "rpc",
		model: fireworksModel,
		select: async (_title: string, choices: string[]) => {
			options.push(...choices);
			return "Close";
		},
		modelRegistry: {
			getApiKeyAndHeaders: async () => ({ ok: false, error: "missing" }),
			getProviderAuth: async () => undefined,
			getAvailable: () => [fireworksModel],
			getAll: () => [fireworksModel],
			getProviderDisplayName: testProviderDisplayName,
		},
	});

	await command.handler("", ctx);

	assert.ok(options.includes("Close"));
	assert.ok(!options.some((option) => /^(Select|Change) account…$/u.test(option)));
});

test("View all renders unresolved target providers without opening a nested picker", async (t) => {
	const originalFetch = globalThis.fetch;
	t.onTestFinished(() => {
		globalThis.fetch = originalFetch;
	});
	const requests: string[] = [];
	globalThis.fetch = async (input) => {
		const url = String(input);
		requests.push(url);
		if (url.includes("/v1/accounts?")) {
			return new Response(
				JSON.stringify({ accounts: [{ name: "accounts/acme" }, { name: "accounts/beta" }] }),
				{ status: 200 },
			);
		}
		return usageFetch(input);
	};
	const choices = ["View all configured providers…", "Close"];
	const titles: string[] = [];
	const mock = createMockPi();
	usageExtension(mock.pi, { settingsRuntime: memorySettingsRuntime().runtime });
	const command = mock.commands.get("usage");
	assert.ok(command);
	const { ctx } = createMockContext({
		hasUI: true,
		mode: "rpc",
		model: openRouterModel,
		select: async (title: string) => {
			titles.push(title);
			return choices.shift();
		},
		modelRegistry: {
			getProviderAuth: async (providerId: string) => ({
				auth: {
					apiKey: `${providerId}-key`,
					...(providerId === "fireworks" ? { baseUrl: fireworksModel.baseUrl } : {}),
				},
			}),
			getAvailable: () => [openRouterModel, fireworksModel],
			getAll: () => [openRouterModel, fireworksModel],
			getProviderAuthStatus: () => ({ configured: true }),
			getProviderDisplayName: testProviderDisplayName,
		},
	});

	await command.handler("", ctx);

	assert.match(titles.at(-1) ?? "", /Fireworks · Configured\nSelection required/iu);
	assert.ok(!titles.some((title) => title.startsWith("Select account for Fireworks")));
	assert.equal(requests.filter((url) => url.includes("/billing/summary")).length, 0);
});

test("another-provider queries show only the selected provider and preserve current status", async (t) => {
	const originalFetch = globalThis.fetch;
	t.onTestFinished(() => {
		globalThis.fetch = originalFetch;
	});
	globalThis.fetch = usageFetch;
	const choices = ["View another configured provider…", "OpenAI Codex", "Close"];
	const titles: string[] = [];
	const mock = createMockPi();
	usageExtension(mock.pi);
	const command = mock.commands.get("usage");
	assert.ok(command);
	const { ctx, statuses } = createMockContext({
		hasUI: true,
		mode: "rpc",
		model: openRouterModel,
		select: async (title: string) => {
			titles.push(title);
			return choices.shift();
		},
		modelRegistry: {
			getProviderAuth: async (provider: string) => ({ auth: { apiKey: `${provider}-key` } }),
			getAvailable: () => [openRouterModel, codexModel],
			getAll: () => [openRouterModel, codexModel],
			getProviderAuthStatus: () => ({ configured: true }),
			getProviderDisplayName: testProviderDisplayName,
		},
	});

	await command.handler("", ctx);

	assert.match(titles.at(-1) ?? "", /OpenAI Codex Usage · Configured/);
	assert.doesNotMatch(titles.at(-1) ?? "", /OpenRouter Usage · Current/);
	assert.equal(statuses.get("usage"), "openrouter $75.00 left");
});

test("unsupported providers remain visible without publishing an error status", async () => {
	const mock = createMockPi();
	usageExtension(mock.pi);
	const command = mock.commands.get("usage");
	assert.ok(command);
	const unsupportedModel = {
		id: "claude",
		name: "Claude",
		provider: "anthropic",
		baseUrl: "https://api.anthropic.com",
	};
	let title = "";
	const { ctx, statuses } = createMockContext({
		hasUI: true,
		mode: "rpc",
		model: unsupportedModel,
		select: async (value: string) => {
			title = value;
			return "Close";
		},
		modelRegistry: {
			getProviderDisplayName: () => "Anthropic",
			getAvailable: () => [],
			getAll: () => [],
		},
	});

	await command.handler("", ctx);

	assert.match(title, /Unsupported/);
	assert.equal(statuses.get("usage"), undefined);
});

test("current auth appearance during a command is revalidated before display", async (t) => {
	const originalFetch = globalThis.fetch;
	t.onTestFinished(() => {
		globalThis.fetch = originalFetch;
	});
	globalThis.fetch = usageFetch;
	let authCalls = 0;
	let title = "";
	const mock = createMockPi();
	usageExtension(mock.pi);
	const command = mock.commands.get("usage");
	assert.ok(command);
	const { ctx } = createMockContext({
		hasUI: true,
		mode: "rpc",
		model: openRouterModel,
		select: async (value: string) => {
			title = value;
			return "Close";
		},
		modelRegistry: {
			getProviderAuth: async () => {
				authCalls += 1;
				return authCalls === 1 ? undefined : { auth: { apiKey: "openrouter-key" } };
			},
			getAvailable: () => [openRouterModel],
			getAll: () => [openRouterModel],
			getProviderAuthStatus: () => ({ configured: true }),
			getProviderDisplayName: testProviderDisplayName,
		},
	});

	await command.handler("", ctx);

	assert.match(title, /OpenRouter Usage · Current/);
	assert.match(title, /test-key/);
	assert.ok(authCalls >= 3);
});

test("session start awaits settings before launching the automatic refresh", async () => {
	const mock = createMockPi();
	usageExtension(mock.pi);
	const never = new Promise<never>(() => undefined);
	const { ctx } = createMockContext({
		model: openRouterModel,
		modelRegistry: {
			getProviderAuth: () => never,
			getAvailable: () => [openRouterModel],
			getAll: () => [openRouterModel],
		},
	});

	const result = mock.events.get("session_start")?.[0]?.({}, ctx);
	assert.ok(result instanceof Promise);
	await result;
	mock.events.get("session_shutdown")?.[0]?.({}, ctx);
});

test("TUI usage queries complete through the loader before opening the menu", async (t) => {
	const originalFetch = globalThis.fetch;
	t.onTestFinished(() => {
		globalThis.fetch = originalFetch;
	});
	globalThis.fetch = usageFetch;
	const mock = createMockPi();
	usageExtension(mock.pi);
	const command = mock.commands.get("usage");
	assert.ok(command);
	let customCalls = 0;
	const { ctx } = createMockContext({
		hasUI: true,
		mode: "tui",
		model: openRouterModel,
		custom: async (factory: unknown) =>
			new Promise<unknown>((resolve) => {
				if (typeof factory !== "function") return resolve(undefined);
				customCalls += 1;
				let component: {
					dispose?(): void;
					handleInput(data: string): void;
					render(width: number): string[];
				};
				const done = (value: unknown) => {
					component.dispose?.();
					resolve(value);
				};
				component = (
					factory as (
						tui: { requestRender(): void },
						theme: { fg(_color: string, text: string): string },
						keybindings: object,
						done: (value: unknown) => void,
					) => typeof component
				)({ requestRender() {} }, { fg: (_color, text) => text }, {}, done);
				if (customCalls === 2) setImmediate(() => component.handleInput("\u0003"));
			}),
		modelRegistry: {
			getProviderAuth: async () => ({ auth: { apiKey: "openrouter-key" } }),
			getAvailable: () => [openRouterModel],
			getAll: () => [openRouterModel],
			getProviderAuthStatus: () => ({ configured: true }),
			getProviderDisplayName: testProviderDisplayName,
		},
	});

	await command.handler("", ctx);

	assert.equal(customCalls, 2);
});

test("a loader UI failure propagates once without an extra task notification", async () => {
	const mock = createMockPi();
	usageExtension(mock.pi);
	const command = mock.commands.get("usage");
	assert.ok(command);
	const { ctx, notifications } = createMockContext({
		hasUI: true,
		mode: "tui",
		model: openRouterModel,
		custom: async () => {
			throw new Error("loader UI failed");
		},
	});

	await assert.rejects(Promise.resolve(command.handler("", ctx)), /loader UI failed/u);
	assert.deepEqual(notifications, []);
});

test("TUI usage queries can be cancelled with Escape", async () => {
	const mock = createMockPi();
	usageExtension(mock.pi);
	const command = mock.commands.get("usage");
	assert.ok(command);
	let customCalls = 0;
	const { ctx } = createMockContext({
		hasUI: true,
		mode: "tui",
		model: openRouterModel,
		custom: async (factory: unknown) =>
			new Promise<unknown>((resolve) => {
				if (typeof factory !== "function") return resolve(undefined);
				customCalls += 1;
				let component: { dispose?(): void; handleInput(data: string): void };
				const done = (value: unknown) => {
					component.dispose?.();
					resolve(value);
				};
				component = (
					factory as (
						tui: { requestRender(): void },
						theme: { fg(_color: string, text: string): string },
						keybindings: object,
						done: (value: unknown) => void,
					) => { dispose?(): void; handleInput(data: string): void }
				)({ requestRender() {} }, { fg: (_color, text) => text }, {}, done);
				setImmediate(() => component.handleInput("\u001b"));
			}),
		modelRegistry: {
			getProviderAuth: () => new Promise<never>(() => undefined),
			getAvailable: () => [openRouterModel],
			getAll: () => [openRouterModel],
		},
	});

	await command.handler("", ctx);
	assert.equal(customCalls, 1);
});

test("session shutdown aborts usage action and provider selectors", async (t) => {
	const originalFetch = globalThis.fetch;
	t.onTestFinished(() => {
		globalThis.fetch = originalFetch;
	});
	globalThis.fetch = usageFetch;

	const dialogSignals: AbortSignal[] = [];
	let providerSelectorStarted: () => void = () => undefined;
	const providerSelectorReady = new Promise<void>((resolve) => {
		providerSelectorStarted = resolve;
	});
	const mock = createMockPi();
	usageExtension(mock.pi);
	const command = mock.commands.get("usage");
	assert.ok(command);
	const { ctx } = createMockContext({
		hasUI: true,
		mode: "rpc",
		model: openRouterModel,
		select: async (
			title: string,
			_options: string[],
			opts?: { signal?: AbortSignal },
		): Promise<string | undefined> => {
			assert.ok(opts?.signal);
			dialogSignals.push(opts.signal);
			if (!title.includes("Select a configured provider")) {
				return "View another configured provider…";
			}
			providerSelectorStarted();
			return new Promise((resolve) => {
				if (opts.signal?.aborted) resolve(undefined);
				else opts.signal?.addEventListener("abort", () => resolve(undefined), { once: true });
			});
		},
		modelRegistry: {
			getProviderAuth: async (provider: string) => ({ auth: { apiKey: `${provider}-key` } }),
			getAvailable: () => [openRouterModel, codexModel],
			getAll: () => [openRouterModel, codexModel],
			getProviderAuthStatus: () => ({ configured: true }),
			getProviderDisplayName: testProviderDisplayName,
		},
	});

	const pending = command.handler("", ctx);
	await providerSelectorReady;
	mock.events.get("session_shutdown")?.[0]?.({}, ctx);
	await pending;

	assert.equal(dialogSignals.length, 2);
	assert.equal(dialogSignals[0], dialogSignals[1]);
	assert.equal(dialogSignals[0]?.aborted, true);
});

test("current Kimi usage follows account changes and clears status on model replacement", async (t) => {
	const originalFetch = globalThis.fetch;
	t.onTestFinished(() => {
		globalThis.fetch = originalFetch;
	});
	let activeKey = "kimi-account-a";
	const fetchedKeys: string[] = [];
	globalThis.fetch = async (_input, init) => {
		const authorization = new Headers(init?.headers).get("authorization") ?? "";
		fetchedKeys.push(authorization);
		const used = activeKey === "kimi-account-a" ? "1" : "25";
		return new Response(
			JSON.stringify({
				usage: { used: "40", limit: "1000" },
				limits: [
					{
						window: { duration: 300, timeUnit: "TIME_UNIT_MINUTE" },
						detail: { used, limit: "100" },
					},
				],
			}),
			{ status: 200 },
		);
	};
	const mock = createMockPi();
	usageExtension(mock.pi);
	const command = mock.commands.get("usage");
	assert.ok(command);
	const titles: string[] = [];
	const { ctx, statuses } = createMockContext({
		hasUI: true,
		mode: "rpc",
		model: kimiModel,
		select: async (title: string) => {
			titles.push(title);
			return "Close";
		},
		modelRegistry: {
			getProviderAuth: async () => ({
				auth: { apiKey: activeKey, baseUrl: kimiModel.baseUrl },
			}),
			getAvailable: () => [kimiModel],
			getAll: () => [kimiModel],
			getProviderDisplayName: testProviderDisplayName,
		},
	});

	await mock.events.get("session_start")?.[0]?.({}, ctx);
	await settle();
	assert.equal(statuses.get("usage"), "kimi 99% 5h 96% wk");
	await command.handler("", ctx);
	assert.match(titles[0] ?? "", /Kimi For Coding Usage · Current/);
	assert.match(titles[0] ?? "", /1 of 100 used · 99% left/);

	activeKey = "kimi-account-b";
	mock.events.get("turn_start")?.[0]?.({}, ctx);
	await settle();
	assert.equal(statuses.get("usage"), "kimi 75% 5h 96% wk");
	assert.ok(fetchedKeys.includes("Bearer kimi-account-a"));
	assert.ok(fetchedKeys.includes("Bearer kimi-account-b"));

	mock.events.get("model_select")?.[0]?.(
		{
			model: {
				id: "other",
				name: "Other",
				provider: "unsupported",
				baseUrl: "https://example.test",
			},
		},
		ctx,
	);
	assert.equal(statuses.get("usage"), undefined);
	mock.events.get("session_shutdown")?.[0]?.({}, ctx);
	assert.equal(statuses.get("usage"), undefined);
});

test("current DeepSeek API balance follows account changes and clears status", async (t) => {
	const originalFetch = globalThis.fetch;
	t.onTestFinished(() => {
		globalThis.fetch = originalFetch;
	});
	let activeKey = "deepseek-account-a";
	const fetchedKeys: string[] = [];
	globalThis.fetch = async (_input, init) => {
		const authorization = new Headers(init?.headers).get("authorization") ?? "";
		fetchedKeys.push(authorization);
		const total = activeKey === "deepseek-account-a" ? "12.50" : "7.25";
		return new Response(
			JSON.stringify({
				is_available: true,
				balance_infos: [
					{
						currency: "USD",
						total_balance: total,
						granted_balance: "2.50",
						topped_up_balance: activeKey === "deepseek-account-a" ? "10.00" : "4.75",
					},
				],
			}),
			{ status: 200 },
		);
	};
	const mock = createMockPi();
	usageExtension(mock.pi);
	const command = mock.commands.get("usage");
	assert.ok(command);
	const titles: string[] = [];
	const { ctx, statuses } = createMockContext({
		hasUI: true,
		mode: "rpc",
		model: deepSeekModel,
		select: async (title: string) => {
			titles.push(title);
			return "Close";
		},
		modelRegistry: {
			getProviderAuth: async () => ({
				auth: { apiKey: activeKey, baseUrl: deepSeekModel.baseUrl },
			}),
			getAvailable: () => [deepSeekModel],
			getAll: () => [deepSeekModel],
		},
	});

	await mock.events.get("session_start")?.[0]?.({}, ctx);
	await settle();
	assert.equal(statuses.get("usage"), "deepseek USD 12.50");
	await command.handler("", ctx);
	assert.match(titles[0] ?? "", /DeepSeek API Balance · Current/u);
	assert.match(titles[0] ?? "", /Total balance:\s+USD 12\.50/u);

	activeKey = "deepseek-account-b";
	mock.events.get("turn_start")?.[0]?.({}, ctx);
	await settle();
	assert.equal(statuses.get("usage"), "deepseek USD 7.25");
	assert.ok(fetchedKeys.includes("Bearer deepseek-account-a"));
	assert.ok(fetchedKeys.includes("Bearer deepseek-account-b"));

	mock.events.get("model_select")?.[0]?.(
		{
			model: {
				id: "other",
				name: "Other",
				provider: "unsupported",
				baseUrl: "https://example.test",
			},
		},
		ctx,
	);
	assert.equal(statuses.get("usage"), undefined);
	mock.events.get("session_shutdown")?.[0]?.({}, ctx);
	assert.equal(statuses.get("usage"), undefined);
});

test("current Fireworks usage receives its guard and settings-backed account selector", async (t) => {
	const originalFetch = globalThis.fetch;
	t.onTestFinished(() => {
		globalThis.fetch = originalFetch;
	});
	const requests: string[] = [];
	globalThis.fetch = async (input) => {
		const url = String(input);
		requests.push(url);
		if (url.includes("/v1/accounts?")) {
			return new Response(
				JSON.stringify({ accounts: [{ name: "accounts/acme" }, { name: "accounts/beta" }] }),
				{ status: 200 },
			);
		}
		return new Response(
			JSON.stringify({
				lineItems: [
					{
						series: "SERVERLESS",
						totalCost: {
							currencyCode: "USD",
							units: url.includes("/accounts/beta/") ? "1" : "3",
							nanos: 0,
						},
					},
				],
			}),
			{ status: 200 },
		);
	};
	const settings = memorySettingsRuntime({ fireworksAccountId: "beta" });
	const mock = createMockPi();
	usageExtension(mock.pi, { settingsRuntime: settings.runtime });
	const { ctx, statuses } = createMockContext({
		model: fireworksModel,
		modelRegistry: {
			getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "fw-key" }),
			getProviderAuth: async () => ({
				auth: { apiKey: "fw-key", baseUrl: fireworksModel.baseUrl },
			}),
			getAvailable: () => [fireworksModel],
			getAll: () => [fireworksModel],
		},
	});

	await mock.events.get("session_start")?.[0]?.({}, ctx);
	await settle();
	await settle();

	assert.equal(statuses.get("usage"), "fireworks USD 1");
	await settings.runtime.updateSelectedTarget("fireworks", "acme");
	mock.events.get("turn_start")?.[0]?.({}, ctx);
	await settle();
	await settle();
	assert.equal(statuses.get("usage"), "fireworks USD 3");
	const billingRequests = requests.filter((url) => url.includes("/billing/summary"));
	assert.ok(billingRequests.some((url) => url.includes("/accounts/beta/billing/summary")));
	assert.ok(billingRequests.some((url) => url.includes("/accounts/acme/billing/summary")));
	mock.events.get("session_shutdown")?.[0]?.({}, ctx);
	assert.equal(statuses.get("usage"), undefined);
});

test("current unresolved Fireworks usage prompts once, persists, and re-queries fresh targets", async (t) => {
	const originalFetch = globalThis.fetch;
	t.onTestFinished(() => {
		globalThis.fetch = originalFetch;
	});
	const requests: string[] = [];
	globalThis.fetch = async (input) => {
		const url = String(input);
		requests.push(url);
		if (url.includes("/v1/accounts?")) {
			return new Response(
				JSON.stringify({ accounts: [{ name: "accounts/acme" }, { name: "accounts/beta" }] }),
				{ status: 200 },
			);
		}
		return new Response(
			JSON.stringify({
				lineItems: [
					{
						series: "SERVERLESS",
						totalCost: { currencyCode: "USD", units: "2", nanos: 0 },
					},
				],
			}),
			{ status: 200 },
		);
	};
	const settings = memorySettingsRuntime();
	const menuChoices = ["Select account…", "Close"];
	const titles: string[] = [];
	const selectedOptions: string[][] = [];
	const mock = createMockPi();
	usageExtension(mock.pi, { settingsRuntime: settings.runtime });
	const command = mock.commands.get("usage");
	assert.ok(command);
	const { ctx, statuses } = createMockContext({
		hasUI: true,
		mode: "rpc",
		model: fireworksModel,
		select: async (title: string, options: string[]) => {
			titles.push(title);
			selectedOptions.push(options);
			if (title.startsWith("Select account for Fireworks")) return "beta";
			return menuChoices.shift();
		},
		modelRegistry: {
			getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "fw-key" }),
			getProviderAuth: async () => ({
				auth: { apiKey: "fw-key", baseUrl: fireworksModel.baseUrl },
			}),
			getAvailable: () => [fireworksModel],
			getAll: () => [fireworksModel],
			getProviderDisplayName: testProviderDisplayName,
		},
	});

	await command.handler("", ctx);

	assert.equal(settings.state().settings.selectedTargets.fireworks, "beta");
	assert.equal(statuses.get("usage"), "fireworks USD 2");
	assert.equal(requests.filter((url) => url.includes("/v1/accounts?")).length, 4);
	const billingRequests = requests.filter((url) => url.includes("/billing/summary"));
	assert.equal(billingRequests.length, 1);
	assert.match(billingRequests[0] ?? "", /\/accounts\/beta\/billing\/summary/u);
	assert.ok(titles.some((title) => /Selection required/iu.test(title)));
	await command.handler("", ctx);
	assert.ok(selectedOptions.flat().some((option) => /Change account…/u.test(option)));
});

test("auth rotation while the target picker is open prevents stale selection persistence", async (t) => {
	const originalFetch = globalThis.fetch;
	t.onTestFinished(() => {
		globalThis.fetch = originalFetch;
	});
	let activeKey = "fw-a";
	const requests: Array<{ url: string; authorization: string }> = [];
	globalThis.fetch = async (input, init) => {
		const url = String(input);
		const authorization = new Headers(init?.headers).get("authorization") ?? "";
		requests.push({ url, authorization });
		if (url.includes("/v1/accounts?")) {
			const accounts =
				authorization === "Bearer fw-a"
					? [{ name: "accounts/acme" }, { name: "accounts/beta" }]
					: [{ name: "accounts/beta" }, { name: "accounts/gamma" }];
			return new Response(JSON.stringify({ accounts }), { status: 200 });
		}
		return new Response(JSON.stringify({ lineItems: [] }), { status: 200 });
	};
	const settings = memorySettingsRuntime();
	const mock = createMockPi();
	usageExtension(mock.pi, { settingsRuntime: settings.runtime });
	const command = mock.commands.get("usage");
	assert.ok(command);
	let rootSelections = 0;
	let resolveTarget!: (value: string) => void;
	let markTargetStarted: () => void = () => undefined;
	const targetStarted = new Promise<void>((resolve) => {
		markTargetStarted = resolve;
	});
	const { ctx, notifications } = createMockContext({
		hasUI: true,
		mode: "rpc",
		model: fireworksModel,
		select: async (title: string) => {
			if (title.startsWith("Select account for Fireworks")) {
				markTargetStarted();
				return new Promise<string>((resolve) => {
					resolveTarget = resolve;
				});
			}
			rootSelections += 1;
			return rootSelections === 1 ? "Select account…" : "Close";
		},
		modelRegistry: {
			getApiKeyAndHeaders: async () => ({ ok: true, apiKey: activeKey }),
			getProviderAuth: async () => ({ auth: { apiKey: activeKey } }),
			getAvailable: () => [fireworksModel],
			getAll: () => [fireworksModel],
			getProviderDisplayName: testProviderDisplayName,
		},
	});

	const pending = command.handler("", ctx);
	await targetStarted;
	activeKey = "fw-b";
	resolveTarget("beta");
	await pending;

	assert.deepEqual(settings.state().settings.selectedTargets, {});
	assert.equal(requests.filter((request) => request.url.includes("/billing/summary")).length, 0);
	assert.ok(requests.some((request) => request.authorization === "Bearer fw-a"));
	assert.ok(requests.some((request) => request.authorization === "Bearer fw-b"));
	assert.match(notifications.at(-1)?.message ?? "", /accounts changed; choose again/iu);
});

test("auth rotation during target settings publication rolls back the selection", async (t) => {
	const originalFetch = globalThis.fetch;
	t.onTestFinished(() => {
		globalThis.fetch = originalFetch;
	});
	let activeKey = "fw-a";
	const requests: Array<{ url: string; authorization: string }> = [];
	globalThis.fetch = async (input, init) => {
		const url = String(input);
		const authorization = new Headers(init?.headers).get("authorization") ?? "";
		requests.push({ url, authorization });
		if (url.includes("/v1/accounts?")) {
			return new Response(
				JSON.stringify({ accounts: [{ name: "accounts/acme" }, { name: "accounts/beta" }] }),
				{ status: 200 },
			);
		}
		return new Response(JSON.stringify({ lineItems: [] }), { status: 200 });
	};
	const settings = memorySettingsRuntime({
		afterTargetWrite: () => {
			activeKey = "fw-b";
		},
	});
	const mock = createMockPi();
	usageExtension(mock.pi, { settingsRuntime: settings.runtime });
	const command = mock.commands.get("usage");
	assert.ok(command);
	let rootSelections = 0;
	const { ctx, notifications } = createMockContext({
		hasUI: true,
		mode: "rpc",
		model: fireworksModel,
		select: async (title: string) => {
			if (title.startsWith("Select account for Fireworks")) return "beta";
			rootSelections += 1;
			return rootSelections === 1 ? "Select account…" : "Close";
		},
		modelRegistry: {
			getApiKeyAndHeaders: async () => ({ ok: true, apiKey: activeKey }),
			getProviderAuth: async () => ({ auth: { apiKey: activeKey } }),
			getAvailable: () => [fireworksModel],
			getAll: () => [fireworksModel],
			getProviderDisplayName: testProviderDisplayName,
		},
	});

	await command.handler("", ctx);

	assert.deepEqual(settings.state().settings.selectedTargets, {});
	assert.equal(requests.filter((request) => request.url.includes("/billing/summary")).length, 0);
	assert.ok(requests.some((request) => request.authorization === "Bearer fw-a"));
	assert.ok(requests.some((request) => request.authorization === "Bearer fw-b"));
	assert.match(notifications.at(-1)?.message ?? "", /accounts changed; choose again/iu);
});

test("cancelling the target picker leaves selection and billing untouched", async (t) => {
	const originalFetch = globalThis.fetch;
	t.onTestFinished(() => {
		globalThis.fetch = originalFetch;
	});
	const requests: string[] = [];
	globalThis.fetch = async (input) => {
		const url = String(input);
		requests.push(url);
		return new Response(
			JSON.stringify({ accounts: [{ name: "accounts/acme" }, { name: "accounts/beta" }] }),
			{ status: 200 },
		);
	};
	const settings = memorySettingsRuntime();
	const mock = createMockPi();
	usageExtension(mock.pi, { settingsRuntime: settings.runtime });
	const command = mock.commands.get("usage");
	assert.ok(command);
	let menuSelection = true;
	const { ctx } = createMockContext({
		hasUI: true,
		mode: "rpc",
		model: fireworksModel,
		select: async (title: string) => {
			if (title.startsWith("Select account for Fireworks")) return undefined;
			if (menuSelection) {
				menuSelection = false;
				return "Select account…";
			}
			return "Close";
		},
		modelRegistry: {
			getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "fw-key" }),
			getProviderAuth: async () => ({ auth: { apiKey: "fw-key" } }),
			getAvailable: () => [fireworksModel],
			getAll: () => [fireworksModel],
			getProviderDisplayName: testProviderDisplayName,
		},
	});

	await command.handler("", ctx);

	assert.deepEqual(settings.state().settings.selectedTargets, {});
	assert.equal(requests.filter((url) => url.includes("/billing/summary")).length, 0);
});

test("Fireworks waits for settings reload and cancels a replaced reload before refreshing", async (t) => {
	const originalFetch = globalThis.fetch;
	t.onTestFinished(() => {
		globalThis.fetch = originalFetch;
	});
	const requests: string[] = [];
	globalThis.fetch = async (input) => {
		const url = String(input);
		requests.push(url);
		if (url.includes("/v1/accounts?")) {
			return new Response(
				JSON.stringify({ accounts: [{ name: "accounts/acme" }, { name: "accounts/beta" }] }),
				{ status: 200 },
			);
		}
		return new Response(
			JSON.stringify({
				lineItems: [
					{
						series: "SERVERLESS",
						totalCost: { currencyCode: "USD", units: "1", nanos: 0 },
					},
				],
			}),
			{ status: 200 },
		);
	};
	const settings = memorySettingsRuntime({ fireworksAccountId: "acme" });
	let reloads = 0;
	let markReloadStarted: () => void = () => undefined;
	const reloadStarted = new Promise<void>((resolve) => {
		markReloadStarted = resolve;
	});
	settings.runtime.reload = async (signal) => {
		reloads += 1;
		if (reloads === 1) {
			markReloadStarted();
			await new Promise<void>((_resolve, reject) => {
				signal?.addEventListener(
					"abort",
					() => reject(new DOMException("Settings reload aborted", "AbortError")),
					{ once: true },
				);
			});
		}
		return settings.runtime.updateSelectedTarget("fireworks", "beta", signal);
	};
	const mock = createMockPi();
	usageExtension(mock.pi, { settingsRuntime: settings.runtime });
	const { ctx, statuses } = createMockContext({
		model: fireworksModel,
		modelRegistry: {
			getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "fw-key" }),
			getProviderAuth: async () => ({
				auth: { apiKey: "fw-key", baseUrl: fireworksModel.baseUrl },
			}),
			getAvailable: () => [fireworksModel],
			getAll: () => [fireworksModel],
		},
	});
	const start = mock.events.get("session_start")?.[0];
	assert.ok(start);

	const replaced = Promise.resolve(start({}, ctx));
	await reloadStarted;
	assert.equal(requests.length, 0);
	const replacement = Promise.resolve(start({}, ctx));
	await Promise.all([replaced, replacement]);
	await settle();
	await settle();

	assert.equal(settings.state().settings.selectedTargets.fireworks, "beta");
	assert.equal(statuses.get("usage"), "fireworks USD 1");
	const billingRequests = requests.filter((url) => url.includes("/billing/summary"));
	assert.ok(billingRequests.length > 0);
	assert.ok(billingRequests.every((url) => url.includes("/accounts/beta/billing/summary")));
	mock.events.get("session_shutdown")?.[0]?.({}, ctx);
});

test("DeepSeek account rotation at the request boundary retries without querying the stale key", async (t) => {
	const originalFetch = globalThis.fetch;
	t.onTestFinished(() => {
		globalThis.fetch = originalFetch;
	});
	let authLookups = 0;
	const fetchedKeys: string[] = [];
	globalThis.fetch = async (_input, init) => {
		fetchedKeys.push(new Headers(init?.headers).get("authorization") ?? "");
		return new Response(
			JSON.stringify({
				is_available: true,
				balance_infos: [
					{
						currency: "USD",
						total_balance: "7.25",
						granted_balance: "2.50",
						topped_up_balance: "4.75",
					},
				],
			}),
			{ status: 200 },
		);
	};
	const mock = createMockPi();
	usageExtension(mock.pi);
	const { ctx, statuses } = createMockContext({
		model: deepSeekModel,
		modelRegistry: {
			getProviderAuth: async () => {
				authLookups += 1;
				return {
					auth: {
						apiKey: authLookups === 1 ? "deepseek-account-a" : "deepseek-account-b",
						baseUrl: deepSeekModel.baseUrl,
					},
				};
			},
			getAvailable: () => [deepSeekModel],
			getAll: () => [deepSeekModel],
		},
	});

	await mock.events.get("session_start")?.[0]?.({}, ctx);
	await settle();
	await settle();

	assert.ok(authLookups >= 5);
	assert.deepEqual(fetchedKeys, ["Bearer deepseek-account-b"]);
	assert.equal(statuses.get("usage"), "deepseek USD 7.25");
	mock.events.get("session_shutdown")?.[0]?.({}, ctx);
	assert.equal(statuses.get("usage"), undefined);
});

test("MiniMax account rotation at the request boundary retries without querying the stale key", async (t) => {
	const originalFetch = globalThis.fetch;
	t.onTestFinished(() => {
		globalThis.fetch = originalFetch;
	});
	let authLookups = 0;
	const fetchedKeys: string[] = [];
	globalThis.fetch = async (_input, init) => {
		fetchedKeys.push(new Headers(init?.headers).get("authorization") ?? "");
		return new Response(
			JSON.stringify({
				base_resp: { status_code: 0, status_msg: "success" },
				model_remains: [
					{
						model_name: "MiniMax-M3",
						start_time: 1_800_000_000_000,
						end_time: 1_800_018_000_000,
						current_interval_total_count: 1_500,
						current_interval_usage_count: 228,
						current_interval_status: 1,
						current_weekly_total_count: 1_000,
						current_weekly_usage_count: 200,
						current_weekly_remaining_percent: 80,
						current_weekly_status: 1,
						weekly_start_time: 1_799_971_200_000,
						weekly_end_time: 1_800_576_000_000,
					},
				],
			}),
			{ status: 200 },
		);
	};
	const mock = createMockPi();
	usageExtension(mock.pi);
	const { ctx, statuses } = createMockContext({
		model: miniMaxModel,
		modelRegistry: {
			getApiKeyAndHeaders: async () => {
				authLookups += 1;
				return {
					ok: true,
					apiKey: authLookups === 1 ? "minimax-account-a" : "minimax-account-b",
				};
			},
			getProviderAuth: async () => ({
				auth: { apiKey: "minimax-account-b", baseUrl: miniMaxModel.baseUrl },
			}),
			getAvailable: () => [miniMaxModel],
			getAll: () => [miniMaxModel],
		},
	});

	await mock.events.get("session_start")?.[0]?.({}, ctx);
	await settle();
	await settle();

	assert.ok(authLookups >= 5);
	assert.deepEqual(fetchedKeys, ["Bearer minimax-account-b"]);
	assert.equal(statuses.get("usage"), "minimax 15% 5h 80% wk");
	mock.events.get("session_shutdown")?.[0]?.({}, ctx);
	assert.equal(statuses.get("usage"), undefined);
});

test("MiniMax query-failed status chip includes the truncated error message", async (t) => {
	const originalFetch = globalThis.fetch;
	t.onTestFinished(() => {
		globalThis.fetch = originalFetch;
	});
	globalThis.fetch = async () =>
		new Response("nope", { status: 500, statusText: "Internal Server Error" });
	const mock = createMockPi();
	usageExtension(mock.pi);
	const { ctx, statuses } = createMockContext({
		model: miniMaxModel,
		modelRegistry: {
			getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "sk-cp-test" }),
			getProviderAuth: async () => ({
				auth: { apiKey: "sk-cp-test", baseUrl: miniMaxModel.baseUrl },
			}),
			getAvailable: () => [miniMaxModel],
			getAll: () => [miniMaxModel],
		},
	});

	await mock.events.get("session_start")?.[0]?.({}, ctx);
	await settle();
	await settle();

	const chip = statuses.get("usage");
	assert.equal(typeof chip, "string");
	assert.match(String(chip), /^usage err: MiniMax usage endpoint returned 500 /u);
	assert.ok(String(chip).length <= "usage err: ".length + 50);
	mock.events.get("session_shutdown")?.[0]?.({}, ctx);
	assert.equal(statuses.get("usage"), undefined);
});

test("DeepSeek session replacement aborts a stale balance request before publication", async (t) => {
	const originalFetch = globalThis.fetch;
	t.onTestFinished(() => {
		globalThis.fetch = originalFetch;
	});
	let activeKey = "deepseek-account-a";
	let requests = 0;
	let firstRequestSignal: AbortSignal | undefined;
	let firstRequestStarted: () => void = () => undefined;
	const firstRequestReady = new Promise<void>((resolve) => {
		firstRequestStarted = resolve;
	});
	globalThis.fetch = async (_input, init) => {
		requests += 1;
		if (requests === 1) {
			firstRequestSignal = init?.signal ?? undefined;
			firstRequestStarted();
			return new Response(new ReadableStream({ start() {} }), { status: 200 });
		}
		return new Response(
			JSON.stringify({
				is_available: true,
				balance_infos: [
					{
						currency: "USD",
						total_balance: "7.25",
						granted_balance: "2.50",
						topped_up_balance: "4.75",
					},
				],
			}),
			{ status: 200 },
		);
	};
	const mock = createMockPi();
	usageExtension(mock.pi);
	const { ctx, statuses } = createMockContext({
		model: deepSeekModel,
		modelRegistry: {
			getProviderAuth: async () => ({
				auth: { apiKey: activeKey, baseUrl: deepSeekModel.baseUrl },
			}),
			getAvailable: () => [deepSeekModel],
			getAll: () => [deepSeekModel],
		},
	});

	await mock.events.get("session_start")?.[0]?.({}, ctx);
	await firstRequestReady;
	activeKey = "deepseek-account-b";
	await mock.events.get("session_start")?.[0]?.({}, ctx);
	await settle();

	assert.equal(requests, 2);
	assert.equal(firstRequestSignal?.aborted, true);
	assert.equal(statuses.get("usage"), "deepseek USD 7.25");
	mock.events.get("session_shutdown")?.[0]?.({}, ctx);
	assert.equal(statuses.get("usage"), undefined);
});

test("Z.AI providers publish statusline usage and refresh through /usage", async (t) => {
	const originalFetch = globalThis.fetch;
	t.onTestFinished(() => {
		globalThis.fetch = originalFetch;
	});
	let fetches = 0;
	globalThis.fetch = async () => {
		fetches += 1;
		return new Response(
			JSON.stringify({
				data: {
					limits: [
						{ type: "CREDIT_LIMIT", unit: 3, percentage: 10 },
						{ type: "CREDIT_LIMIT", unit: 6, usage: 100, currentValue: 20 },
					],
					level: "lite",
				},
			}),
			{ status: 200 },
		);
	};
	const titles: string[] = [];
	const mock = createMockPi();
	usageExtension(mock.pi);
	const command = mock.commands.get("usage");
	assert.ok(command);
	const { ctx, statuses } = createMockContext({
		hasUI: true,
		mode: "rpc",
		model: zaiModel,
		select: async (title: string) => {
			titles.push(title);
			return "Close";
		},
		modelRegistry: {
			getProviderAuth: async () => ({ auth: { apiKey: "zai-key" } }),
			getAvailable: () => [zaiModel],
			getAll: () => [zaiModel],
			getProviderAuthStatus: () => ({ configured: true }),
			getProviderDisplayName: () => "Z.AI",
		},
	});

	await mock.events.get("session_start")?.[0]?.({}, ctx);
	await settle();
	assert.equal(fetches, 2);
	assert.equal(statuses.get("usage"), "zai 90% 5h 80% wk");

	mock.events.get("turn_start")?.[0]?.({}, ctx);
	await settle();
	assert.equal(fetches, 2);
	assert.equal(statuses.get("usage"), "zai 90% 5h 80% wk");

	await command.handler("", ctx);
	assert.equal(fetches, 2);
	assert.match(titles[0] ?? "", /5h window:\s+\[█{18}░{2}\] 90% left/);
	assert.equal(statuses.get("usage"), "zai 90% 5h 80% wk");
});

test("automatic provider failures back off instead of retrying every turn", async (t) => {
	const originalFetch = globalThis.fetch;
	t.onTestFinished(() => {
		globalThis.fetch = originalFetch;
	});
	let fetches = 0;
	globalThis.fetch = async () => {
		fetches += 1;
		return new Response("unavailable", { status: 503, statusText: "Unavailable" });
	};
	const mock = createMockPi();
	usageExtension(mock.pi);
	const { ctx } = createMockContext({
		model: openRouterModel,
		modelRegistry: {
			getProviderAuth: async () => ({ auth: { apiKey: "openrouter-key" } }),
			getAvailable: () => [openRouterModel],
			getAll: () => [openRouterModel],
		},
	});

	await mock.events.get("session_start")?.[0]?.({}, ctx);
	await settle();
	mock.events.get("turn_start")?.[0]?.({}, ctx);
	await settle();
	mock.events.get("turn_start")?.[0]?.({}, ctx);
	await settle();
	assert.equal(fetches, 1);
});

test("a current command supersedes an older automatic query for the same provider", async (t) => {
	const originalFetch = globalThis.fetch;
	t.onTestFinished(() => {
		globalThis.fetch = originalFetch;
	});
	let activeKey = "account-a";
	let fetches = 0;
	let resolveOldFetch: (response: Response) => void = () => undefined;
	const oldFetch = new Promise<Response>((resolve) => {
		resolveOldFetch = resolve;
	});
	const response = (label: string, remaining: number) =>
		new Response(
			JSON.stringify({
				data: {
					label,
					limit: 100,
					limit_remaining: remaining,
					usage: 100 - remaining,
				},
			}),
			{ status: 200 },
		);
	globalThis.fetch = async () => {
		fetches += 1;
		return fetches === 1 ? oldFetch : response("account-b", 40);
	};
	const mock = createMockPi();
	usageExtension(mock.pi);
	const command = mock.commands.get("usage");
	assert.ok(command);
	const { ctx, statuses } = createMockContext({
		hasUI: true,
		mode: "rpc",
		model: openRouterModel,
		select: async () => "Close",
		modelRegistry: {
			getProviderAuth: async () => ({ auth: { apiKey: activeKey } }),
			getAvailable: () => [openRouterModel],
			getAll: () => [openRouterModel],
			getProviderAuthStatus: () => ({ configured: true }),
			getProviderDisplayName: testProviderDisplayName,
		},
	});

	await mock.events.get("session_start")?.[0]?.({}, ctx);
	while (fetches < 1) await settle();
	activeKey = "account-b";
	await command.handler("", ctx);
	assert.equal(statuses.get("usage"), "openrouter $40.00 left");

	resolveOldFetch(response("account-a", 75));
	await settle();
	assert.equal(statuses.get("usage"), "openrouter $40.00 left");
});

test("cross-provider results revalidate which account is Current before display", async (t) => {
	const originalFetch = globalThis.fetch;
	t.onTestFinished(() => {
		globalThis.fetch = originalFetch;
	});
	let codexFetches = 0;
	let resolveCodex: (response: Response) => void = () => undefined;
	const codexResponse = new Promise<Response>((resolve) => {
		resolveCodex = resolve;
	});
	globalThis.fetch = async (input) => {
		if (String(input).endsWith("/api/v1/key")) return usageFetch(input);
		codexFetches += 1;
		return codexFetches === 1 ? codexResponse : usageFetch(input);
	};
	const choices = ["View another configured provider…", "OpenAI Codex", "Close"];
	const titles: string[] = [];
	const mock = createMockPi();
	usageExtension(mock.pi);
	const command = mock.commands.get("usage");
	assert.ok(command);
	const { ctx } = createMockContext({
		hasUI: true,
		mode: "rpc",
		model: openRouterModel,
		select: async (title: string) => {
			titles.push(title);
			return choices.shift();
		},
		modelRegistry: {
			getProviderAuth: async (provider: string) => ({ auth: { apiKey: `${provider}-key` } }),
			getAvailable: () => [openRouterModel, codexModel],
			getAll: () => [openRouterModel, codexModel],
			getProviderAuthStatus: () => ({ configured: true }),
			getProviderDisplayName: testProviderDisplayName,
		},
	});

	const pending = command.handler("", ctx);
	while (codexFetches < 1) await settle();
	Object.assign(ctx, { model: codexModel });
	resolveCodex(await usageFetch("https://chatgpt.com/backend-api/wham/usage"));
	await pending;

	assert.match(titles.at(-1) ?? "", /OpenAI Codex Usage · Current/);
	assert.doesNotMatch(titles.at(-1) ?? "", /OpenRouter Usage · Current/);
});

test("session shutdown clears status through the shutdown context", async (t) => {
	const originalFetch = globalThis.fetch;
	t.onTestFinished(() => {
		globalThis.fetch = originalFetch;
	});
	globalThis.fetch = usageFetch;
	const statuses = new Map<string, string | undefined>();
	const ui = {
		notify() {},
		setStatus(key: string, value: string | undefined) {
			statuses.set(key, value);
		},
	};
	const registry = {
		getProviderAuth: async () => ({ auth: { apiKey: "openrouter-key" } }),
		getAvailable: () => [openRouterModel],
		getAll: () => [openRouterModel],
	};
	const mock = createMockPi();
	usageExtension(mock.pi);
	const { ctx: startContext } = createMockContext({
		model: openRouterModel,
		ui,
		modelRegistry: registry,
	});
	const { ctx: shutdownContext } = createMockContext({
		model: openRouterModel,
		ui,
		modelRegistry: registry,
	});

	await mock.events.get("session_start")?.[0]?.({}, startContext);
	await settle();
	assert.equal(statuses.get("usage"), "openrouter $75.00 left");
	mock.events.get("session_shutdown")?.[0]?.({}, shutdownContext);
	assert.equal(statuses.get("usage"), undefined);
});

test("Codex reset countdown repaints locally and stops across replacement and shutdown", async (t) => {
	const originalFetch = globalThis.fetch;
	vi.useFakeTimers();
	t.onTestFinished(() => {
		globalThis.fetch = originalFetch;
		vi.useRealTimers();
	});
	const now = Date.parse("2026-08-29T00:00:00Z");
	vi.setSystemTime(now);
	let fetches = 0;
	globalThis.fetch = async () => {
		fetches += 1;
		return new Response(
			JSON.stringify({
				rate_limit: {
					primary_window: {
						used_percent: 20,
						limit_window_seconds: 18_000,
						reset_at: (now + 150_000) / 1_000,
					},
				},
			}),
			{ status: 200 },
		);
	};
	const settings = memorySettingsRuntime({ codexStatusResetCountdown: true });
	const mock = createMockPi();
	usageExtension(mock.pi, { settingsRuntime: settings.runtime });
	const { ctx, statuses } = createMockContext({
		model: codexModel,
		modelRegistry: {
			getProviderAuth: async () => ({ auth: { apiKey: codexToken } }),
			getAvailable: () => [codexModel],
			getAll: () => [codexModel],
			getProviderAuthStatus: () => ({ configured: true }),
			getProviderDisplayName: testProviderDisplayName,
		},
	});

	await mock.events.get("session_start")?.[0]?.({}, ctx);
	await vi.advanceTimersByTimeAsync(0);
	assert.equal(statuses.get("usage"), "codex 80% ↻ 3m");
	assert.equal(fetches, 1);

	await vi.advanceTimersByTimeAsync(60_000);
	assert.equal(statuses.get("usage"), "codex 80% ↻ 2m");
	assert.equal(fetches, 1);

	Object.assign(ctx, { model: undefined });
	await mock.events.get("session_start")?.[0]?.({}, ctx);
	await vi.advanceTimersByTimeAsync(60_000);
	assert.equal(statuses.get("usage"), undefined);
	assert.equal(fetches, 1);

	Object.assign(ctx, { model: codexModel });
	mock.events.get("model_select")?.[0]?.({ model: codexModel }, ctx);
	await vi.advanceTimersByTimeAsync(0);
	assert.equal(statuses.get("usage"), "codex 80% ↻ 1m");
	assert.equal(fetches, 2);

	mock.events.get("session_shutdown")?.[0]?.({}, ctx);
	assert.equal(statuses.get("usage"), undefined);
	await vi.advanceTimersByTimeAsync(60_000);
	assert.equal(statuses.get("usage"), undefined);
	assert.equal(fetches, 2);
});

test("Codex reset countdown ignores a stale extension context", async (t) => {
	const originalFetch = globalThis.fetch;
	vi.useFakeTimers();
	t.onTestFinished(() => {
		globalThis.fetch = originalFetch;
		vi.useRealTimers();
	});
	const now = Date.parse("2026-08-29T00:00:00Z");
	vi.setSystemTime(now);
	let fetches = 0;
	globalThis.fetch = async () => {
		fetches += 1;
		return new Response(
			JSON.stringify({
				rate_limit: {
					primary_window: {
						used_percent: 20,
						limit_window_seconds: 18_000,
						reset_at: (now + 150_000) / 1_000,
					},
				},
			}),
			{ status: 200 },
		);
	};
	const settings = memorySettingsRuntime({ codexStatusResetCountdown: true });
	const mock = createMockPi();
	usageExtension(mock.pi, { settingsRuntime: settings.runtime });
	const { ctx, statuses } = createMockContext({
		model: codexModel,
		modelRegistry: {
			getProviderAuth: async () => ({ auth: { apiKey: codexToken } }),
			getAvailable: () => [codexModel],
			getAll: () => [codexModel],
			getProviderAuthStatus: () => ({ configured: true }),
			getProviderDisplayName: testProviderDisplayName,
		},
	});

	await mock.events.get("session_start")?.[0]?.({}, ctx);
	await vi.advanceTimersByTimeAsync(0);
	assert.equal(statuses.get("usage"), "codex 80% ↻ 3m");
	assert.equal(fetches, 1);

	const staleError = new Error(
		"This extension ctx is stale after session replacement or reload. Do not use a captured pi or command ctx after ctx.newSession(), ctx.fork(), ctx.switchSession(), or ctx.reload().",
	);
	let staleModelReads = 0;
	let staleUiReads = 0;
	Object.defineProperties(ctx, {
		model: {
			configurable: true,
			get() {
				staleModelReads += 1;
				throw staleError;
			},
		},
		ui: {
			configurable: true,
			get() {
				staleUiReads += 1;
				throw staleError;
			},
		},
	});

	await vi.advanceTimersByTimeAsync(60_000);
	assert.equal(staleModelReads, 0);
	assert.equal(staleUiReads, 1);
	assert.equal(statuses.get("usage"), "codex 80% ↻ 3m");
	assert.equal(fetches, 1);

	await vi.advanceTimersByTimeAsync(60_000);
	assert.equal(staleModelReads, 0);
	assert.equal(staleUiReads, 1);
	assert.equal(fetches, 1);
});

test("a slow command cannot overwrite status after the selected model changes", async (t) => {
	const originalFetch = globalThis.fetch;
	t.onTestFinished(() => {
		globalThis.fetch = originalFetch;
	});
	let openRouterFetches = 0;
	let resolveSlowFetch: (response: Response) => void = () => undefined;
	const slowFetch = new Promise<Response>((resolve) => {
		resolveSlowFetch = resolve;
	});
	globalThis.fetch = async (input) => {
		if (String(input).endsWith("/api/v1/key")) {
			openRouterFetches += 1;
			if (openRouterFetches === 1) return usageFetch(input);
			return slowFetch;
		}
		return usageFetch(input);
	};

	const choices = ["Refresh current usage", "Close"];
	const mock = createMockPi();
	usageExtension(mock.pi);
	const command = mock.commands.get("usage");
	assert.ok(command);
	const { ctx, statuses } = createMockContext({
		hasUI: true,
		mode: "rpc",
		model: openRouterModel,
		select: async () => choices.shift(),
		modelRegistry: {
			getProviderAuth: async (provider: string) => ({ auth: { apiKey: `${provider}-key` } }),
			getAvailable: () => [openRouterModel, codexModel],
			getAll: () => [openRouterModel, codexModel],
			getProviderAuthStatus: () => ({ configured: true }),
			getProviderDisplayName: testProviderDisplayName,
		},
	});

	await mock.events.get("session_start")?.[0]?.({}, ctx);
	await settle();
	const commandPromise = command.handler("", ctx);
	while (openRouterFetches < 2) await settle();
	Object.assign(ctx, { model: codexModel });
	mock.events.get("model_select")?.[0]?.({ model: codexModel }, ctx);
	await settle();
	assert.equal(statuses.get("usage"), "codex 80% 5h");

	resolveSlowFetch(await usageFetch("https://openrouter.ai/api/v1/key"));
	await commandPromise;
	assert.equal(statuses.get("usage"), "codex 80% 5h");
});

test("statusline follows runtime auth changes and clears for unsupported selected providers", async (t) => {
	const originalFetch = globalThis.fetch;
	t.onTestFinished(() => {
		globalThis.fetch = originalFetch;
	});
	let activeKey = "account-a";
	let accountAQueries = 0;
	let fetches = 0;
	globalThis.fetch = async () => {
		fetches += 1;
		if (activeKey === "account-a") accountAQueries += 1;
		const remaining =
			activeKey === "account-a"
				? accountAQueries === 1
					? 75
					: accountAQueries === 2
						? 20
						: accountAQueries === 3
							? 10
							: 5
				: 40;
		return new Response(
			JSON.stringify({
				data: {
					label: activeKey,
					limit: 100,
					limit_remaining: remaining,
					limit_reset: "monthly",
					usage: 100 - remaining,
					usage_daily: 1,
					usage_weekly: 5,
					usage_monthly: 25,
				},
			}),
			{ status: 200 },
		);
	};

	const mock = createMockPi();
	usageExtension(mock.pi);
	const { ctx, statuses } = createMockContext({
		model: openRouterModel,
		modelRegistry: {
			getProviderAuth: async () => ({ auth: { apiKey: activeKey } }),
			getAvailable: () => [openRouterModel],
			getAll: () => [openRouterModel],
			getProviderAuthStatus: () => ({ configured: true }),
			getProviderDisplayName: testProviderDisplayName,
		},
	});

	await mock.events.get("session_start")?.[0]?.({}, ctx);
	await settle();
	assert.equal(statuses.get("usage"), "openrouter $75.00 left");

	activeKey = "account-b";
	mock.events.get("turn_start")?.[0]?.({}, ctx);
	await settle();
	assert.equal(statuses.get("usage"), "openrouter $40.00 left");

	activeKey = "account-a";
	mock.events.get("turn_start")?.[0]?.({}, ctx);
	await settle();
	assert.equal(statuses.get("usage"), "openrouter $20.00 left");
	assert.equal(fetches, 3);

	mock.events.get("model_select")?.[0]?.(
		{
			model: {
				id: "x",
				name: "X",
				provider: "unsupported",
				baseUrl: "https://example.test",
			},
		},
		ctx,
	);
	assert.equal(statuses.get("usage"), undefined);

	mock.events.get("model_select")?.[0]?.({ model: openRouterModel }, ctx);
	await settle();
	assert.equal(statuses.get("usage"), "openrouter $10.00 left");
	assert.equal(fetches, 4);

	const proxyModel = { ...openRouterModel, baseUrl: "https://proxy.example.test/v1" };
	Object.assign(ctx, { model: proxyModel });
	mock.events.get("model_select")?.[0]?.({ model: proxyModel }, ctx);
	await settle();
	assert.equal(statuses.get("usage"), "auth unavailable");

	Object.assign(ctx, { model: openRouterModel });
	mock.events.get("model_select")?.[0]?.({ model: openRouterModel }, ctx);
	await settle();
	assert.equal(statuses.get("usage"), "openrouter $5.00 left");
	assert.equal(fetches, 5);
});

test("a retired xAI setting cannot disable explicit usage or publish status", async (t) => {
	const originalFetch = globalThis.fetch;
	t.onTestFinished(() => {
		globalThis.fetch = originalFetch;
	});
	const requests: string[] = [];
	globalThis.fetch = async (input) => {
		requests.push(String(input));
		return requests.length === 1
			? new Response(JSON.stringify({ userId: "fixture-user", subscriptionTier: "SuperGrok" }), {
					status: 200,
				})
			: new Response(
					JSON.stringify({
						config: {
							creditUsagePercent: 25,
							currentPeriod: { type: "USAGE_PERIOD_TYPE_WEEKLY" },
						},
					}),
					{ status: 200 },
				);
	};
	const settings = memorySettingsRuntime({ document: { xaiUsage: false } });
	const credential = {
		type: "oauth",
		access: "xai-access",
		refresh: "xai-refresh",
		expires: Date.now() + 60_000,
	};
	const mock = createMockPi();
	usageExtension(mock.pi, {
		settingsRuntime: settings.runtime,
		credentialReader: () => credential,
	});
	const command = mock.commands.get("usage");
	assert.ok(command);
	let title = "";
	const { ctx, statuses } = createMockContext({
		hasUI: true,
		mode: "rpc",
		model: xaiModel,
		select: async (value: string) => {
			title = value;
			return "Close";
		},
		modelRegistry: {
			getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "xai-access" }),
			getProviderAuth: async () => ({ auth: { apiKey: "xai-access" } }),
			getAvailable: () => [xaiModel],
			getAll: () => [xaiModel],
			getProviderAuthStatus: () => ({ configured: true }),
			getProviderDisplayName: () => "xAI",
		},
	});

	await mock.events.get("session_start")?.[0]?.({}, ctx);
	await settle();
	assert.equal(requests.length, 0);
	await command.handler("", ctx);

	assert.deepEqual(requests, [
		"https://cli-chat-proxy.grok.com/v1/user?include=subscription",
		"https://cli-chat-proxy.grok.com/v1/billing?format=credits",
	]);
	assert.match(title, /Included allowance:\s+\[█{15}░{5}\] 75% left · Weekly/);
	assert.match(title, /Plan tier:\s+SuperGrok/);
	assert.equal(statuses.get("usage"), undefined);
});

test("xAI account changes after identity prevent billing and stale publication", async (t) => {
	const originalFetch = globalThis.fetch;
	t.onTestFinished(() => {
		globalThis.fetch = originalFetch;
	});
	let activeAccess = "xai-access-a";
	let fetches = 0;
	globalThis.fetch = async () => {
		fetches += 1;
		activeAccess = "xai-access-b";
		return new Response(JSON.stringify({ userId: "fixture-user" }), { status: 200 });
	};
	const settings = memorySettingsRuntime();
	const mock = createMockPi();
	usageExtension(mock.pi, {
		settingsRuntime: settings.runtime,
		credentialReader: () => ({
			type: "oauth",
			access: activeAccess,
			refresh: `refresh-${activeAccess}`,
			expires: Date.now() + 60_000,
		}),
	});
	const command = mock.commands.get("usage");
	assert.ok(command);
	let menus = 0;
	const { ctx, statuses } = createMockContext({
		hasUI: true,
		mode: "rpc",
		model: xaiModel,
		select: async () => {
			menus += 1;
			return "Close";
		},
		modelRegistry: {
			getApiKeyAndHeaders: async () => ({ ok: true, apiKey: activeAccess }),
			getProviderAuth: async () => ({ auth: { apiKey: activeAccess } }),
			getAvailable: () => [xaiModel],
			getAll: () => [xaiModel],
			getProviderAuthStatus: () => ({ configured: true }),
			getProviderDisplayName: () => "xAI",
		},
	});

	await command.handler("", ctx);

	assert.equal(fetches, 1);
	assert.equal(menus, 0);
	assert.equal(statuses.get("usage"), undefined);
});

test("xAI account changes after the final adapter guard prevent configured publication", async (t) => {
	const originalFetch = globalThis.fetch;
	t.onTestFinished(() => {
		globalThis.fetch = originalFetch;
	});
	let activeAccess = "xai-access-a";
	let credentialReads = 0;
	const requests: string[] = [];
	globalThis.fetch = async (input) => {
		const url = String(input);
		requests.push(url);
		if (url.endsWith("/api/v1/key")) return usageFetch(input);
		if (url.includes("/user?")) {
			return new Response(JSON.stringify({ userId: "fixture-user" }), { status: 200 });
		}
		return new Response(JSON.stringify({ config: { creditUsagePercent: 10 } }), {
			status: 200,
		});
	};
	const settings = memorySettingsRuntime();
	const choices = ["View another configured provider…", "xAI"];
	const titles: string[] = [];
	const mock = createMockPi();
	usageExtension(mock.pi, {
		settingsRuntime: settings.runtime,
		credentialReader: (provider) => {
			if (provider !== "xai") return undefined;
			credentialReads += 1;
			const access = activeAccess;
			if (credentialReads === 5) {
				queueMicrotask(() => {
					activeAccess = "xai-access-b";
				});
			}
			return {
				type: "oauth",
				access,
				refresh: `refresh-${access}`,
				expires: Date.now() + 60_000,
			};
		},
	});
	const command = mock.commands.get("usage");
	assert.ok(command);
	const { ctx, statuses } = createMockContext({
		hasUI: true,
		mode: "rpc",
		model: openRouterModel,
		select: async (title: string) => {
			titles.push(title);
			return choices.shift();
		},
		modelRegistry: {
			getProviderAuth: async (provider: string) => ({
				auth: { apiKey: provider === "xai" ? activeAccess : "openrouter-key" },
			}),
			getAvailable: () => [openRouterModel, xaiModel],
			getAll: () => [openRouterModel, xaiModel],
			getProviderAuthStatus: () => ({ configured: true }),
			getProviderDisplayName: testProviderDisplayName,
		},
	});

	await command.handler("", ctx);

	assert.equal(credentialReads, 6);
	assert.equal(requests.filter((url) => url.includes("cli-chat-proxy")).length, 2);
	assert.equal(
		titles.some((title) => /xAI Usage · Configured/u.test(title)),
		false,
	);
	assert.equal(statuses.get("usage"), "openrouter $75.00 left");
});

test("xAI appears as a configured provider without changing current status", async (t) => {
	const originalFetch = globalThis.fetch;
	t.onTestFinished(() => {
		globalThis.fetch = originalFetch;
	});
	const requests: string[] = [];
	globalThis.fetch = async (input) => {
		const url = String(input);
		requests.push(url);
		if (url.endsWith("/api/v1/key")) return usageFetch(input);
		if (url.includes("/user?")) {
			return new Response(JSON.stringify({ userId: "fixture-user" }), { status: 200 });
		}
		return new Response(JSON.stringify({ config: { creditUsagePercent: 10 } }), {
			status: 200,
		});
	};
	const settings = memorySettingsRuntime();
	const choices = ["View another configured provider…", "xAI", "Close"];
	const titles: string[] = [];
	const mock = createMockPi();
	usageExtension(mock.pi, {
		settingsRuntime: settings.runtime,
		credentialReader: (provider) =>
			provider === "xai"
				? {
						type: "oauth",
						access: "xai-access",
						refresh: "xai-refresh",
						expires: Date.now() + 60_000,
					}
				: undefined,
	});
	const command = mock.commands.get("usage");
	assert.ok(command);
	const { ctx, statuses } = createMockContext({
		hasUI: true,
		mode: "rpc",
		model: openRouterModel,
		select: async (title: string) => {
			titles.push(title);
			return choices.shift();
		},
		modelRegistry: {
			getProviderAuth: async (provider: string) => ({
				auth: { apiKey: provider === "xai" ? "xai-access" : "openrouter-key" },
			}),
			getAvailable: () => [openRouterModel, xaiModel],
			getAll: () => [openRouterModel, xaiModel],
			getProviderAuthStatus: () => ({ configured: true }),
			getProviderDisplayName: testProviderDisplayName,
		},
	});

	await command.handler("", ctx);

	assert.match(titles.at(-1) ?? "", /xAI Usage · Configured/);
	assert.match(titles.at(-1) ?? "", /Included allowance:\s+\[█{18}░{2}\] 90% left/);
	assert.equal(statuses.get("usage"), "openrouter $75.00 left");
	assert.equal(requests.filter((url) => url.includes("cli-chat-proxy")).length, 2);
});

test("the Settings menu action gives RPC mode the active manual settings path", async (t) => {
	const originalFetch = globalThis.fetch;
	t.onTestFinished(() => {
		globalThis.fetch = originalFetch;
	});
	globalThis.fetch = usageFetch;
	const settings = memorySettingsRuntime();
	const choices = ["Settings", "Close"];
	const mock = createMockPi();
	usageExtension(mock.pi, { settingsRuntime: settings.runtime });
	const command = mock.commands.get("usage");
	assert.ok(command);
	const { ctx, notifications } = createMockContext({
		hasUI: true,
		mode: "rpc",
		model: openRouterModel,
		select: async () => choices.shift(),
		modelRegistry: {
			getProviderAuth: async () => ({ auth: { apiKey: "openrouter-key" } }),
			getAvailable: () => [openRouterModel],
			getAll: () => [openRouterModel],
			getProviderAuthStatus: () => ({ configured: true }),
			getProviderDisplayName: testProviderDisplayName,
		},
	});

	await command.handler("", ctx);

	assert.match(notifications[0]?.message ?? "", /Edit settings manually: \/tmp\/pi-usage\.json/);
});

test("the TUI SettingsList describes and applies usage preferences immediately", async (t) => {
	const settings = memorySettingsRuntime();
	const rendered: string[][] = [];
	const applied = new Set<string>();
	const controller = new AbortController();
	const previousKeybindings = getKeybindings();
	const remappedKeybindings = new KeybindingsManager(TUI_KEYBINDINGS, {
		"tui.select.down": "j",
		"tui.select.confirm": "x",
		"tui.select.cancel": "q",
	});
	setKeybindings(remappedKeybindings);
	t.onTestFinished(() => setKeybindings(previousKeybindings));
	const { ctx } = createMockContext({
		hasUI: true,
		mode: "tui",
		custom: async (factory: unknown) =>
			new Promise<boolean>((resolve) => {
				let component: {
					dispose?(): void;
					handleInput(data: string): void;
					render(width: number): string[];
				};
				const done = (value: boolean) => {
					component.dispose?.();
					resolve(value);
				};
				component = (
					factory as (
						tui: { requestRender(): void },
						theme: {
							bold(text: string): string;
							fg(_color: string, text: string): string;
						},
						keybindings: object,
						done: (value: boolean) => void,
					) => typeof component
				)(
					{ requestRender: () => rendered.push(component.render(100)) },
					{ bold: (text) => text, fg: (_color, text) => text },
					remappedKeybindings,
					done,
				);
				rendered.push(component.render(100));
				component.handleInput("x");
				setImmediate(() => {
					component.handleInput("j");
					component.handleInput("x");
					setImmediate(() => component.handleInput("q"));
				});
			}),
	});

	const changed = await showUsageSettings(
		ctx,
		settings.runtime,
		controller.signal,
		() => true,
		(id) => applied.add(id),
	);

	assert.equal(changed, true);
	assert.equal(settings.state().settings.codexFastMode, true);
	assert.equal(settings.state().settings.codexStatusResetCountdown, true);
	assert.deepEqual(applied, new Set(["codexFastMode", "codexStatusResetCountdown"]));
	const renderedSettings = rendered.map((lines) => lines.join("\n"));
	assert.ok(
		renderedSettings.some((frame) =>
			/Show time remaining until each Codex usage limit resets/.test(frame),
		),
	);
	assert.ok(renderedSettings.some((frame) => /Use faster Codex routing/.test(frame)));
	assert.doesNotMatch(renderedSettings.join("\n"), /Fireworks account/u);
	assert.doesNotMatch(renderedSettings.join("\n"), /xAI|warning|undocumented|experimental/iu);
});

test("Ctrl+C hard-cancels Settings before conflicting configurable actions", async (t) => {
	const settings = memorySettingsRuntime();
	let applied = 0;
	const previousKeybindings = getKeybindings();
	const conflictingKeybindings = new KeybindingsManager(TUI_KEYBINDINGS, {
		"tui.select.confirm": "ctrl+c",
		"tui.select.cancel": "q",
	});
	setKeybindings(conflictingKeybindings);
	t.onTestFinished(() => setKeybindings(previousKeybindings));
	const { ctx } = createMockContext({
		hasUI: true,
		mode: "tui",
		custom: async (factory: unknown) =>
			new Promise<boolean>((resolve) => {
				let component: {
					dispose?(): void;
					handleInput(data: string): void;
					render(width: number): string[];
				};
				const done = (value: boolean) => {
					component.dispose?.();
					resolve(value);
				};
				component = (
					factory as (
						tui: { requestRender(): void },
						theme: {
							bold(text: string): string;
							fg(_color: string, text: string): string;
						},
						keybindings: object,
						done: (value: boolean) => void,
					) => typeof component
				)(
					{ requestRender() {} },
					{ bold: (text) => text, fg: (_color, text) => text },
					conflictingKeybindings,
					done,
				);
				component.handleInput("\u0003");
				component.handleInput("q");
			}),
	});

	const changed = await showUsageSettings(
		ctx,
		settings.runtime,
		new AbortController().signal,
		() => true,
		() => {
			applied += 1;
		},
	);

	assert.equal(changed, false);
	assert.deepEqual(settings.state().settings, {
		codexFastMode: false,
		codexStatusResetCountdown: false,
		selectedTargets: {},
	});
	assert.equal(applied, 0);
});

test("settings cancellation aborts a stalled save and closes without awaiting it", async (t) => {
	const previousKeybindings = getKeybindings();
	const remappedKeybindings = new KeybindingsManager(TUI_KEYBINDINGS, {
		"tui.select.cancel": "q",
	});
	setKeybindings(remappedKeybindings);
	t.onTestFinished(() => setKeybindings(previousKeybindings));

	for (const cancellation of ["ctrl+c", "configured cancel", "parent abort"] as const) {
		const settings = memorySettingsRuntime();
		let markStarted: () => void = () => undefined;
		const started = new Promise<void>((resolve) => {
			markStarted = resolve;
		});
		let markAborted: () => void = () => undefined;
		const aborted = new Promise<void>((resolve) => {
			markAborted = resolve;
		});
		settings.runtime.update = async (_patch, signal) => {
			markStarted();
			if (signal?.aborted) markAborted();
			else signal?.addEventListener("abort", markAborted, { once: true });
			return new Promise<UsageSettingsState>(() => undefined);
		};
		const parentController = new AbortController();
		let markReady: (component: {
			handleInput(data: string): void;
			render(width: number): string[];
		}) => void = () => undefined;
		const ready = new Promise<{
			handleInput(data: string): void;
			render(width: number): string[];
		}>((resolve) => {
			markReady = resolve;
		});
		const { ctx } = createMockContext({
			hasUI: true,
			mode: "tui",
			custom: async (factory: unknown) =>
				new Promise<boolean>((resolve) => {
					let component: {
						dispose?(): void;
						handleInput(data: string): void;
						render(width: number): string[];
					};
					const done = (value: boolean) => {
						component.dispose?.();
						resolve(value);
					};
					component = (
						factory as (
							tui: { requestRender(): void },
							theme: {
								bold(text: string): string;
								fg(_color: string, text: string): string;
							},
							keybindings: object,
							done: (value: boolean) => void,
						) => typeof component
					)(
						{ requestRender() {} },
						{ bold: (text) => text, fg: (_color, text) => text },
						remappedKeybindings,
						done,
					);
					markReady(component);
				}),
		});

		const pending = showUsageSettings(
			ctx,
			settings.runtime,
			parentController.signal,
			() => true,
			() => assert.fail("an aborted save must not apply"),
		);
		const component = await ready;
		component.handleInput("\u001b[B");
		component.handleInput("\r");
		await started;
		if (cancellation === "ctrl+c") component.handleInput("\u0003");
		else if (cancellation === "configured cancel") component.handleInput("q");
		else parentController.abort();

		assert.equal(await pending, false, cancellation);
		await aborted;
		assert.equal(settings.state().settings.codexStatusResetCountdown, false, cancellation);
	}
});

test("a durable settings save still applies lifecycle cleanup when disposal wins the await", async () => {
	const settings = memorySettingsRuntime();
	const controller = new AbortController();
	const update = settings.runtime.update;
	settings.runtime.update = async (patch, signal) => {
		const state = await update(patch, signal);
		controller.abort();
		return state;
	};
	let applied = 0;
	const { ctx } = createMockContext({
		hasUI: true,
		mode: "tui",
		custom: async (factory: unknown) =>
			new Promise<boolean>((resolve) => {
				let component: {
					dispose?(): void;
					handleInput(data: string): void;
					render(width: number): string[];
				};
				const done = (value: boolean) => {
					component.dispose?.();
					resolve(value);
				};
				component = (
					factory as (
						tui: { requestRender(): void },
						theme: {
							bold(text: string): string;
							fg(_color: string, text: string): string;
						},
						keybindings: object,
						done: (value: boolean) => void,
					) => typeof component
				)(
					{ requestRender() {} },
					{ bold: (text) => text, fg: (_color, text) => text },
					{ matches: () => false },
					done,
				);
				component.handleInput("\u001b[B");
				component.handleInput("\r");
			}),
	});

	await showUsageSettings(
		ctx,
		settings.runtime,
		controller.signal,
		() => true,
		(id) => {
			if (id === "codexStatusResetCountdown") applied += 1;
		},
	);

	assert.equal(settings.state().settings.codexStatusResetCountdown, true);
	assert.equal(applied, 1);
});

test("the TUI SettingsList rolls back its displayed and effective value after save failure", async () => {
	const settings = memorySettingsRuntime({ failUpdates: true });
	let latest: string[] = [];
	const { ctx, notifications } = createMockContext({
		hasUI: true,
		mode: "tui",
		custom: async (factory: unknown) =>
			new Promise<boolean>((resolve) => {
				let component: {
					dispose?(): void;
					handleInput(data: string): void;
					render(width: number): string[];
				};
				const done = (value: boolean) => {
					latest = component.render(100);
					component.dispose?.();
					resolve(value);
				};
				component = (
					factory as (
						tui: { requestRender(): void },
						theme: {
							bold(text: string): string;
							fg(_color: string, text: string): string;
						},
						keybindings: object,
						done: (value: boolean) => void,
					) => typeof component
				)(
					{ requestRender: () => (latest = component.render(100)) },
					{ bold: (text) => text, fg: (_color, text) => text },
					{ matches: () => false },
					done,
				);
				component.handleInput("\u001b[B");
				component.handleInput("\r");
				setImmediate(() => component.handleInput("\u0003"));
			}),
	});

	const changed = await showUsageSettings(
		ctx,
		settings.runtime,
		new AbortController().signal,
		() => true,
		() => assert.fail("failed writes must not apply"),
	);

	assert.equal(changed, false);
	assert.equal(settings.state().settings.codexStatusResetCountdown, false);
	assert.match(notifications[0]?.message ?? "", /disk full/);
	assert.match(latest.join("\n"), /Codex reset countdown.*Off/su);
});

test("shutdown cancels an explicit xAI identity body before billing or status publication", async (t) => {
	const originalFetch = globalThis.fetch;
	t.onTestFinished(() => {
		globalThis.fetch = originalFetch;
	});
	let fetches = 0;
	let identityStarted: () => void = () => undefined;
	const started = new Promise<void>((resolve) => {
		identityStarted = resolve;
	});
	globalThis.fetch = async () => {
		fetches += 1;
		identityStarted();
		return new Response(new ReadableStream({ start() {} }), { status: 200 });
	};
	const settings = memorySettingsRuntime();
	const credential = {
		type: "oauth",
		access: "xai-access",
		refresh: "xai-refresh",
		expires: Date.now() + 60_000,
	};
	const mock = createMockPi();
	usageExtension(mock.pi, {
		settingsRuntime: settings.runtime,
		credentialReader: () => credential,
	});
	const command = mock.commands.get("usage");
	assert.ok(command);
	const { ctx, statuses } = createMockContext({
		hasUI: true,
		mode: "rpc",
		model: xaiModel,
		select: async () => "Close",
		modelRegistry: {
			getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "xai-access" }),
			getProviderAuth: async () => ({ auth: { apiKey: "xai-access" } }),
			getAvailable: () => [xaiModel],
			getAll: () => [xaiModel],
			getProviderAuthStatus: () => ({ configured: true }),
			getProviderDisplayName: () => "xAI",
		},
	});

	await mock.events.get("session_start")?.[0]?.({}, ctx);
	const pending = command.handler("", ctx);
	await started;
	mock.events.get("session_shutdown")?.[0]?.({}, ctx);
	await pending;

	assert.equal(fetches, 1);
	assert.equal(statuses.get("usage"), undefined);
});
