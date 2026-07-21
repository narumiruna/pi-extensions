import assert from "node:assert/strict";
import test from "node:test";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { createMockContext, createMockPi } from "../../../test/support.js";
import usageExtension from "../src/usage.js";

initTheme("dark", false);

const openRouterModel = {
	id: "openai/gpt-4o",
	name: "GPT-4o",
	provider: "openrouter",
	baseUrl: "https://openrouter.ai/api/v1",
};
const codexModel = {
	id: "gpt-5.3-codex",
	name: "GPT-5.3 Codex",
	provider: "openai-codex",
	baseUrl: "https://chatgpt.com/backend-api",
};

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

test("pi-usage registers one primary command, compatibility alias, and lifecycle hooks", () => {
	const mock = createMockPi();
	usageExtension(mock.pi);

	assert.ok(mock.commands.has("usage"));
	assert.ok(mock.commands.has("codex-status"));
	assert.equal(mock.commands.get("usage")?.getArgumentCompletions, undefined);
	assert.equal(mock.commands.get("codex-status")?.getArgumentCompletions, undefined);
	assert.deepEqual([...mock.events.keys()].sort(), [
		"model_select",
		"session_shutdown",
		"session_start",
		"session_tree",
		"turn_start",
	]);
});

test("/usage automatically queries the current runtime account and shows state plus next actions", async (t) => {
	const originalFetch = globalThis.fetch;
	t.after(() => {
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
			getProviderDisplayName: (provider: string) => provider,
		},
	});

	await command.handler("", ctx);

	assert.equal(selections.length, 1);
	assert.match(selections[0]?.title ?? "", /OpenRouter Usage · Current/);
	assert.match(selections[0]?.title ?? "", /test-key/);
	assert.deepEqual(selections[0]?.options, [
		"Refresh current usage",
		"View another configured provider…",
		"View all configured providers…",
		"Close",
	]);
	assert.equal(statuses.get("usage"), "openrouter $75.00 left");
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

test("explicit all-provider query labels current/configured and retains provider failures", async (t) => {
	const originalFetch = globalThis.fetch;
	t.after(() => {
		globalThis.fetch = originalFetch;
	});
	globalThis.fetch = async (input) => {
		if (String(input).endsWith("/api/v1/key")) return usageFetch(input);
		return new Response("backend unavailable", { status: 503, statusText: "Unavailable" });
	};

	const titles: string[] = [];
	const choices = ["View all configured providers…", "Close"];
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
			getProviderAuthStatus: () => ({ configured: true, source: "stored" }),
			getProviderDisplayName: (provider: string) => provider,
		},
	});

	await command.handler("", ctx);

	assert.equal(titles.length, 2);
	assert.match(titles[1] ?? "", /OpenRouter Usage · Current/);
	assert.match(titles[1] ?? "", /OpenAI Codex · Configured/);
	assert.match(titles[1] ?? "", /query failed/i);
	assert.equal(statuses.get("usage"), "openrouter $75.00 left");
});

test("another-provider queries remain configured and never replace current status", async (t) => {
	const originalFetch = globalThis.fetch;
	t.after(() => {
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
			getProviderDisplayName: (provider: string) => provider,
		},
	});

	await command.handler("", ctx);

	assert.match(titles.at(-1) ?? "", /OpenAI Codex Usage · Configured/);
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

test("automatic lifecycle refresh starts asynchronously", () => {
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
	assert.equal(result, undefined);
	mock.events.get("session_shutdown")?.[0]?.({}, ctx);
});

test("TUI usage queries can be cancelled with Escape", async () => {
	const mock = createMockPi();
	usageExtension(mock.pi);
	const command = mock.commands.get("usage");
	assert.ok(command);
	let selected = false;
	const { ctx } = createMockContext({
		hasUI: true,
		mode: "tui",
		model: openRouterModel,
		select: async () => {
			selected = true;
			return "Close";
		},
		custom: async (factory: unknown) =>
			new Promise<unknown>((resolve) => {
				if (typeof factory !== "function") return resolve(undefined);
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
	assert.equal(selected, false);
});

test("automatic provider failures back off instead of retrying every turn", async (t) => {
	const originalFetch = globalThis.fetch;
	t.after(() => {
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

	mock.events.get("session_start")?.[0]?.({}, ctx);
	await settle();
	mock.events.get("turn_start")?.[0]?.({}, ctx);
	await settle();
	mock.events.get("turn_start")?.[0]?.({}, ctx);
	await settle();
	assert.equal(fetches, 1);
});

test("a current command supersedes an older automatic query for the same provider", async (t) => {
	const originalFetch = globalThis.fetch;
	t.after(() => {
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
			getProviderDisplayName: (provider: string) => provider,
		},
	});

	mock.events.get("session_start")?.[0]?.({}, ctx);
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
	t.after(() => {
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
			getProviderDisplayName: (provider: string) => provider,
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
	t.after(() => {
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

	mock.events.get("session_start")?.[0]?.({}, startContext);
	await settle();
	assert.equal(statuses.get("usage"), "openrouter $75.00 left");
	mock.events.get("session_shutdown")?.[0]?.({}, shutdownContext);
	assert.equal(statuses.get("usage"), undefined);
});

test("a slow command cannot overwrite status after the selected model changes", async (t) => {
	const originalFetch = globalThis.fetch;
	t.after(() => {
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
			getProviderDisplayName: (provider: string) => provider,
		},
	});

	mock.events.get("session_start")?.[0]?.({}, ctx);
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
	t.after(() => {
		globalThis.fetch = originalFetch;
	});
	let activeKey = "account-a";
	let accountAQueries = 0;
	let fetches = 0;
	globalThis.fetch = async () => {
		fetches += 1;
		if (activeKey === "account-a") accountAQueries += 1;
		const remaining = activeKey === "account-a" ? (accountAQueries === 1 ? 75 : 20) : 40;
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
			getProviderDisplayName: (provider: string) => provider,
		},
	});

	mock.events.get("session_start")?.[0]?.({}, ctx);
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
});
