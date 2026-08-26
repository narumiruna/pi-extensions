import assert from "node:assert/strict";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { createTuiHarness } from "@narumitw/pi-tui-kit/testing";
import { test } from "vitest";
import { createMockContext, createMockPi } from "../../../test/support.js";
import usageExtension from "../src/usage.js";

initTheme("dark", false);

const codexModel = {
	id: "gpt-5.3-codex",
	name: "GPT-5.3 Codex",
	provider: "openai-codex",
	baseUrl: "https://chatgpt.com/backend-api",
};

const credential = (access = "codex-token") => ({
	type: "oauth",
	access: normalizeTestToken(access),
	refresh: "refresh-token",
	expires: Date.now() + 60_000,
	accountId: "account-123",
});

function usageResponse(resetCount: number): Response {
	return new Response(
		JSON.stringify({
			rate_limit: { primary_window: { used_percent: 80, limit_window_seconds: 18_000 } },
			rate_limit_reset_credits: { available_count: resetCount },
		}),
		{ status: 200 },
	);
}

function codexRegistry(activeToken: () => string) {
	return {
		getApiKeyAndHeaders: async () => ({
			ok: true as const,
			apiKey: normalizeTestToken(activeToken()),
		}),
		getProviderAuth: async () => ({ auth: { apiKey: normalizeTestToken(activeToken()) } }),
		getAvailable: () => [codexModel],
		getAll: () => [codexModel],
		getProviderAuthStatus: () => ({ configured: true }),
		getProviderDisplayName: (provider: string) => provider,
	};
}

function normalizeTestToken(value: string): string {
	return value.split(".").length === 3
		? value
		: codexAccessToken(value === "codex-token" ? "account-123" : value);
}

function codexAccessToken(accountId: string): string {
	const payload = Buffer.from(
		JSON.stringify({
			"https://api.openai.com/auth": { chatgpt_account_id: accountId },
		}),
	).toString("base64url");
	return `header.${payload}.signature`;
}

test("zero Codex reset availability is visible and cannot mutate", async (t) => {
	const originalFetch = globalThis.fetch;
	t.onTestFinished(() => {
		globalThis.fetch = originalFetch;
	});
	let posts = 0;
	globalThis.fetch = async (_input, init) => {
		if (init?.method === "POST") posts += 1;
		return usageResponse(0);
	};
	let rootOptions: string[] = [];
	const mock = createMockPi();
	usageExtension(mock.pi);
	const command = mock.commands.get("usage");
	assert.ok(command);
	const { ctx } = createMockContext({
		hasUI: true,
		mode: "rpc",
		model: codexModel,
		select: async (_title: string, options: string[]) => {
			rootOptions = options;
			return "Close";
		},
		modelRegistry: codexRegistry(() => "codex-token"),
	});

	await command.handler("", ctx);

	assert.ok(rootOptions.includes("Redeem usage limit reset…"));
	assert.ok(!rootOptions.some((option) => option.includes("(unavailable)")));
	assert.equal(posts, 0);
});

test("missing reset summary keeps the current Codex availability check reachable", async (t) => {
	const originalFetch = globalThis.fetch;
	t.onTestFinished(() => {
		globalThis.fetch = originalFetch;
	});
	let detailRequests = 0;
	globalThis.fetch = async (input) => {
		if (String(input).endsWith("/rate-limit-reset-credits")) {
			detailRequests += 1;
			return new Response(JSON.stringify({ available_count: 1 }), { status: 200 });
		}
		return new Response(
			JSON.stringify({
				rate_limit: { primary_window: { used_percent: 20, limit_window_seconds: 18_000 } },
			}),
			{ status: 200 },
		);
	};
	const choices: Array<string | undefined> = [
		"Redeem usage limit reset…",
		"Full reset",
		undefined,
		"Close",
	];
	const mock = createMockPi();
	usageExtension(mock.pi, { credentialReader: () => credential() });
	const command = mock.commands.get("usage");
	assert.ok(command);
	const { ctx } = createMockContext({
		hasUI: true,
		mode: "rpc",
		model: codexModel,
		select: async () => choices.shift(),
		modelRegistry: codexRegistry(() => "codex-token"),
	});

	await command.handler("", ctx);

	assert.equal(detailRequests, 1);
});

test("Codex reset transport retries reuse the same redemption request ID", async (t) => {
	const originalFetch = globalThis.fetch;
	t.onTestFinished(() => {
		globalThis.fetch = originalFetch;
	});
	const bodies: unknown[] = [];
	let posts = 0;
	globalThis.fetch = async (input, init) => {
		const url = String(input);
		if (url.endsWith("/consume")) {
			posts += 1;
			bodies.push(JSON.parse(String(init?.body)));
			if (posts === 1) return new Response("uncertain", { status: 503 });
			return new Response(JSON.stringify({ code: "already_redeemed", windows_reset: 0 }), {
				status: 200,
			});
		}
		if (url.endsWith("/rate-limit-reset-credits")) {
			return new Response(JSON.stringify({ available_count: 1 }), { status: 200 });
		}
		return usageResponse(posts > 0 ? 0 : 1);
	};

	const choices = [
		"Redeem usage limit reset…",
		"Full reset",
		"Yes, use reset",
		"Try again",
		"Close",
	];
	const titles: string[] = [];
	const mock = createMockPi();
	usageExtension(mock.pi, {
		credentialReader: () => credential(),
		createRedemptionId: () => "one-logical-attempt",
	});
	const command = mock.commands.get("usage");
	assert.ok(command);
	const { ctx } = createMockContext({
		hasUI: true,
		mode: "rpc",
		model: codexModel,
		select: async (title: string) => {
			titles.push(title);
			return choices.shift();
		},
		modelRegistry: codexRegistry(() => "codex-token"),
	});

	await command.handler("", ctx);

	assert.equal(posts, 2);
	assert.deepEqual(bodies, [
		{ redeem_request_id: "one-logical-attempt" },
		{ redeem_request_id: "one-logical-attempt" },
	]);
	assert.ok(titles.some((title) => /same request/iu.test(title)));
	assert.match(titles.at(-1) ?? "", /already completed.*0 usage limit resets left/isu);
});

test("Codex reset revalidates the active account immediately before POST", async (t) => {
	const originalFetch = globalThis.fetch;
	t.onTestFinished(() => {
		globalThis.fetch = originalFetch;
	});
	let activeToken = "codex-token";
	let posts = 0;
	globalThis.fetch = async (input, init) => {
		const url = String(input);
		if (init?.method === "POST") posts += 1;
		if (url.endsWith("/rate-limit-reset-credits")) {
			return new Response(JSON.stringify({ available_count: 1 }), { status: 200 });
		}
		return usageResponse(1);
	};
	const choices: Array<string | undefined> = [
		"Redeem usage limit reset…",
		"Full reset",
		"Yes, use reset",
		"Back",
		undefined,
		"Close",
	];
	const titles: string[] = [];
	const mock = createMockPi();
	usageExtension(mock.pi, {
		credentialReader: () => credential(),
		createRedemptionId: () => "account-change-attempt",
	});
	const command = mock.commands.get("usage");
	assert.ok(command);
	const { ctx } = createMockContext({
		hasUI: true,
		mode: "rpc",
		model: codexModel,
		select: async (title: string) => {
			titles.push(title);
			const choice = choices.shift();
			if (choice === "Yes, use reset") activeToken = "different-account-token";
			return choice;
		},
		modelRegistry: codexRegistry(() => activeToken),
	});

	await command.handler("", ctx);

	assert.equal(posts, 0);
	assert.ok(titles.some((title) => /does not match|changed/iu.test(title)));
});

test("TUI reset confirmation is width-safe and external disposal aborts confirmed work", async (t) => {
	const originalFetch = globalThis.fetch;
	t.onTestFinished(() => {
		globalThis.fetch = originalFetch;
	});
	let resolveUsage: (response: Response) => void = () => undefined;
	const pendingUsage = new Promise<Response>((resolve) => {
		resolveUsage = resolve;
	});
	let resolveDetails: (response: Response) => void = () => undefined;
	const pendingDetails = new Promise<Response>((resolve) => {
		resolveDetails = resolve;
	});
	let postStarted: () => void = () => undefined;
	const postReady = new Promise<void>((resolve) => {
		postStarted = resolve;
	});
	let postAborted = false;
	globalThis.fetch = async (input, init) => {
		const url = String(input);
		if (url.endsWith("/consume")) {
			postStarted();
			return new Promise<Response>((_resolve, reject) => {
				const abort = () => {
					postAborted = true;
					reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
				};
				if (init?.signal?.aborted) abort();
				else init?.signal?.addEventListener("abort", abort, { once: true });
			});
		}
		if (url.endsWith("/rate-limit-reset-credits")) return pendingDetails;
		return pendingUsage;
	};

	const tui = createTuiHarness({ width: 32, rows: 18 });
	const mock = createMockPi();
	usageExtension(mock.pi, {
		credentialReader: () => credential(),
		createRedemptionId: () => "disposed-attempt",
	});
	const command = mock.commands.get("usage");
	assert.ok(command);
	const base = createMockContext({
		hasUI: true,
		mode: "tui",
		model: codexModel,
		modelRegistry: codexRegistry(() => "codex-token"),
	}).ctx as unknown as { ui: Record<string, unknown>; [key: string]: unknown };
	const ctx = { ...base, ui: { ...base.ui, custom: tui.custom } };
	const running = command.handler("", ctx as never);

	await tui.waitForOpen();
	const initialTask = tui.resultPromise;
	assert.match(tui.render().join("\n"), /Checking current usage/iu);
	resolveUsage(usageResponse(1));
	await initialTask;

	await tui.waitForOpen();
	const rootScreen = tui.resultPromise;
	assert.match(tui.render(32).join("\n"), /Provider usage/iu);
	tui.press("tui.select.down");
	tui.press("tui.select.confirm");
	await rootScreen;

	await tui.waitForOpen();
	const detailsTask = tui.resultPromise;
	assert.match(tui.render(32).join("\n"), /Checking usage limit resets/iu);
	resolveDetails(new Response(JSON.stringify({ available_count: 1 }), { status: 200 }));
	await detailsTask;

	await tui.waitForOpen();
	const pickerScreen = tui.resultPromise;
	assert.match(tui.render(32).join("\n"), /Full reset/iu);
	tui.press("tui.select.confirm");
	await pickerScreen;

	await tui.waitForOpen();
	const confirmationScreen = tui.resultPromise;
	const confirmation = tui.render(32);
	assert.match(confirmation.join("\n"), /No, go back/iu);
	for (const line of confirmation) assert.ok(visibleWidth(line) <= 32);
	tui.press("tui.select.down");
	tui.press("tui.select.confirm");
	await confirmationScreen;

	await tui.waitForOpen();
	assert.match(tui.render(32).join("\n"), /Resetting your usage/iu);
	await postReady;
	tui.dispose();
	await running;

	assert.equal(postAborted, true);
});

test("session replacement aborts a confirmed Codex reset request", async (t) => {
	const originalFetch = globalThis.fetch;
	t.onTestFinished(() => {
		globalThis.fetch = originalFetch;
	});
	let postStarted: () => void = () => undefined;
	const postReady = new Promise<void>((resolve) => {
		postStarted = resolve;
	});
	let finishPost: (response: Response) => void = () => undefined;
	let postAborted = false;
	globalThis.fetch = async (input, init) => {
		const url = String(input);
		if (url.endsWith("/consume")) {
			postStarted();
			return new Promise<Response>((resolve, reject) => {
				finishPost = resolve;
				const abort = () => {
					postAborted = true;
					reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
				};
				if (init?.signal?.aborted) abort();
				else init?.signal?.addEventListener("abort", abort, { once: true });
			});
		}
		if (url.endsWith("/rate-limit-reset-credits")) {
			return new Response(JSON.stringify({ available_count: 1 }), { status: 200 });
		}
		return usageResponse(1);
	};

	const choices = ["Redeem usage limit reset…", "Full reset", "Yes, use reset"];
	const mock = createMockPi();
	usageExtension(mock.pi, {
		credentialReader: () => credential(),
		createRedemptionId: () => "replacement-attempt",
	});
	const command = mock.commands.get("usage");
	assert.ok(command);
	const { ctx } = createMockContext({
		hasUI: true,
		mode: "rpc",
		model: codexModel,
		select: async () => choices.shift(),
		modelRegistry: codexRegistry(() => "codex-token"),
	});

	const pending = command.handler("", ctx);
	await postReady;
	mock.events.get("session_start")?.[0]?.({}, ctx);
	await new Promise<void>((resolve) => setImmediate(resolve));
	if (!postAborted) {
		finishPost(new Response(JSON.stringify({ code: "reset", windows_reset: 2 }), { status: 200 }));
	}
	await pending;

	assert.equal(postAborted, true);
});

test("session shutdown aborts a confirmed Codex reset request", async (t) => {
	const originalFetch = globalThis.fetch;
	t.onTestFinished(() => {
		globalThis.fetch = originalFetch;
	});
	let postStarted: () => void = () => undefined;
	const postReady = new Promise<void>((resolve) => {
		postStarted = resolve;
	});
	let postAborted = false;
	globalThis.fetch = async (input, init) => {
		const url = String(input);
		if (url.endsWith("/consume")) {
			postStarted();
			return new Promise<Response>((_resolve, reject) => {
				const abort = () => {
					postAborted = true;
					reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
				};
				if (init?.signal?.aborted) abort();
				else init?.signal?.addEventListener("abort", abort, { once: true });
			});
		}
		if (url.endsWith("/rate-limit-reset-credits")) {
			return new Response(JSON.stringify({ available_count: 1 }), { status: 200 });
		}
		return usageResponse(1);
	};

	const choices = ["Redeem usage limit reset…", "Full reset", "Yes, use reset"];
	const mock = createMockPi();
	usageExtension(mock.pi, {
		credentialReader: () => credential(),
		createRedemptionId: () => "shutdown-attempt",
	});
	const command = mock.commands.get("usage");
	assert.ok(command);
	const { ctx } = createMockContext({
		hasUI: true,
		mode: "rpc",
		model: codexModel,
		select: async () => choices.shift(),
		modelRegistry: codexRegistry(() => "codex-token"),
	});

	const pending = command.handler("", ctx);
	await postReady;
	mock.events.get("session_shutdown")?.[0]?.({}, ctx);
	await pending;

	assert.equal(postAborted, true);
});
