import assert from "node:assert/strict";
import { test, vi } from "vitest";
import { createMockContext } from "../../../test/support.js";
import {
	formatUsageReport,
	formatUsageStatusline,
	normalizeFireworksAccountsPayload,
	normalizeFireworksBillingSummaryPayload,
	queryProviderUsage,
	type ResolvedUsageAuth,
	resolveUsageAuth,
	resolveUsageTarget,
	SUPPORTED_ADAPTERS,
	type UsageProviderAdapter,
	type UsageQuerySettings,
} from "../src/index.js";

const FIREWORKS_MODEL = {
	id: "accounts/fireworks/models/kimi-k2p6",
	name: "Kimi K2.6",
	provider: "fireworks",
	baseUrl: "https://api.fireworks.ai/inference",
};

function fireworksAdapter(): UsageProviderAdapter {
	const candidate = SUPPORTED_ADAPTERS.find((adapter) => adapter.id === "fireworks");
	assert.ok(candidate);
	return candidate;
}

const adapter = fireworksAdapter();

function money(units: string, nanos: number): Record<string, unknown> {
	return { currencyCode: "USD", units, nanos };
}

function lineItem(
	series: string,
	totalCost: unknown,
	currencyCode = "USD",
): Record<string, unknown> {
	return { category: "Text Completion", series, totalCost, currencyCode };
}

function accountRow(slug: string): Record<string, unknown> {
	return { name: `accounts/${slug}` };
}

function fireworksAuth(secret = "fw-test-secret"): ResolvedUsageAuth {
	return {
		apiKey: secret,
		headers: { Authorization: `Bearer ${secret}` },
		fingerprint: "fingerprint",
		secrets: [secret, `Bearer ${secret}`],
		model: FIREWORKS_MODEL as never,
	};
}

async function queryFireworks(
	signal = new AbortController().signal,
	timeoutMs = 1_000,
	rememberedAccountId?: string,
) {
	const auth = fireworksAuth();
	const guard = async () => undefined;
	const target = await resolveUsageTarget(
		adapter,
		auth,
		rememberedAccountId,
		signal,
		timeoutMs,
		guard,
	);
	if (target.kind === "selection-required") throw new Error("Selection required");
	return queryProviderUsage(adapter, auth, signal, timeoutMs, guard, target.targetId);
}

test("Fireworks billing summary sums rated line items exactly per currency and series", () => {
	const report = normalizeFireworksBillingSummaryPayload(
		{
			lineItems: [
				{ category: "Serverless", series: "SERVERLESS", totalCost: money("12", 345_678_901) },
				{
					category: "Dedicated",
					series: "DEDICATED_DEPLOYMENT",
					totalCost: money("0", 750_000_000),
				},
				{
					category: "Training",
					series: "TRAINING",
					totalCost: { ...money("-1", -250_000_000), currencyCode: "USD" },
				},
				{
					category: "Audio",
					series: "SERVERLESS",
					totalCost: { currencyCode: "EUR", units: "0", nanos: 5 },
				},
			],
		},
		"acme",
		1_000,
	);

	assert.equal(report.providerId, "fireworks");
	assert.equal(report.providerName, "Fireworks");
	assert.equal(report.accountLabel, "acme");
	assert.equal(report.source, "fireworks-billing-summary");
	assert.deepEqual(report.semantics, { kind: "api-key", label: "Fireworks API spend" });
	assert.deepEqual(report.buckets, []);
	assert.deepEqual(
		report.metrics.map((metric) => [metric.id, metric.value, metric.currency]),
		[
			["usd-total", "11.845678901", "USD"],
			["usd-serverless", "12.345678901", "USD"],
			["usd-dedicated", "0.75", "USD"],
			["usd-training", "-1.25", "USD"],
			["eur-total", "0.000000005", "EUR"],
			["eur-serverless", "0.000000005", "EUR"],
		],
	);
	const formatted = formatUsageReport(report, "current");
	assert.match(formatted, /^Fireworks API Spend · Current/mu);
	assert.match(formatted, /Account: acme/u);
	assert.match(formatted, /Semantics: Fireworks API spend/u);
	assert.match(formatted, /Spend window:\s+Last 30 days \(rated\)/u);
	assert.match(formatted, /Total spend:\s+USD 11\.845678901/u);
	assert.match(formatted, /Serverless:\s+USD 12\.345678901/u);
	assert.match(formatted, /Dedicated deployments:\s+USD 0\.75/u);
	assert.match(formatted, /Training:\s+USD -1\.25/u);
	assert.ok(formatted.indexOf("USD rated spend:") < formatted.indexOf("EUR rated spend:"));
	assert.equal(formatUsageStatusline(report), "fireworks USD 11.845678901 · EUR 0.000000005");
});

test("Fireworks billing summary accepts empty rated line items without inventing quota semantics", () => {
	const report = normalizeFireworksBillingSummaryPayload({ lineItems: [] }, "acme", 2_000);

	assert.equal(report.providerId, "fireworks");
	assert.deepEqual(report.metrics, []);
	assert.deepEqual(report.notes, [
		"Rated line items may differ from the final invoice once credits or adjustments are applied.",
		"Fireworks returned no rated line items for the last 30 days.",
	]);
	assert.equal(formatUsageStatusline(report), "fireworks no rated usage");
	assert.doesNotMatch(formatUsageReport(report, "configured"), /quota|reset|remaining/iu);
});

test("Fireworks billing summary rejects malformed, ambiguous, or hostile payloads", () => {
	const invalid: [Record<string, unknown>, RegExp][] = [
		[{ lineItems: "nope" }, /lineItems was not an array/iu],
		[{ lineItems: [null] }, /line item was not an object/iu],
		[{ lineItems: [{ category: "x" }] }, /total cost.*money object/iu],
		[
			{
				lineItems: [
					{ category: "Serverless", totalCost: { currencyCode: "usd", units: "1", nanos: 0 } },
				],
			},
			/currency was not an ISO 4217/iu,
		],
		[
			{
				lineItems: [{ category: "Serverless", series: 5, totalCost: money("1", 0) }],
			},
			/series was invalid/iu,
		],
		[
			{
				lineItems: [
					{
						category: "Serverless",
						series: "SERVERLESS",
						totalCost: { ...money("1", 0), currencyCode: "EU" },
					},
				],
			},
			/ISO 4217/iu,
		],
		[
			{
				lineItems: [
					{
						...lineItem("SERVERLESS", money("1", 0)),
						totalCost: { ...money("1", 0), units: "1e3" },
					},
				],
			},
			/whole units was not a bounded integer/iu,
		],
		[
			{
				lineItems: [
					{
						series: "SERVERLESS",
						totalCost: { ...money("0", 0), units: "9223372036854775808" },
					},
				],
			},
			/whole units exceeded the int64 range/iu,
		],
		[
			{
				lineItems: [
					{
						series: "SERVERLESS",
						totalCost: { ...money("0", 0), units: "-9223372036854775809" },
					},
				],
			},
			/whole units exceeded the int64 range/iu,
		],
		[
			{ lineItems: [{ series: "SERVERLESS", totalCost: { ...money("1", 0), nanos: 1.5 } }] },
			/nano units was not a bounded integer/iu,
		],
		[
			{
				lineItems: [
					{ series: "SERVERLESS", totalCost: { ...money("0", 0), nanos: 1_000_000_000 } },
				],
			},
			/nano units exceeded the Money range/iu,
		],
		[
			{
				lineItems: [
					{ series: "SERVERLESS", totalCost: { ...money("0", 0), nanos: -1_000_000_000 } },
				],
			},
			/nano units exceeded the Money range/iu,
		],
		[
			{
				lineItems: [
					{
						series: "SERVERLESS",
						totalCost: { currencyCode: "USD", units: "-1", nanos: 750_000_000 },
					},
				],
			},
			/mixed unit and nano signs/iu,
		],
		[
			{
				lineItems: [
					{ series: "SERVERLESS", totalCost: { ...money("1", 0), currencyCode: "EURO" } },
				],
			},
			/currency was not an ISO 4217/iu,
		],
	];
	for (const [payload, pattern] of invalid) {
		assert.throws(() => normalizeFireworksBillingSummaryPayload(payload, "acme", 0), pattern);
	}
});

test("Fireworks account discovery normalizes and validates the documented listing", () => {
	assert.deepEqual(
		normalizeFireworksAccountsPayload({
			accounts: [{ name: "accounts/acme" }, { name: "accounts/b.io" }],
		}),
		["acme", "b.io"],
	);
	const invalid: [Record<string, unknown>, RegExp][] = [
		[{}, /did not contain an accounts array/iu],
		[{ accounts: "acme" }, /did not contain an accounts array/iu],
		[{ accounts: [null] }, /row was not an object/iu],
		[{ accounts: [{ displayName: "Acme" }] }, /omitted the account resource name/iu],
		[{ accounts: [{ name: "accounts/../secrets" }] }, /unsafe account resource name/iu],
		[{ accounts: [{ name: "accounts/acme/deployments/x" }] }, /unsafe account resource name/iu],
		[{ accounts: [{ name: "accounts/acme" }, { name: "accounts/acme" }] }, /repeated acme/iu],
	];
	for (const [payload, pattern] of invalid) {
		assert.throws(() => normalizeFireworksAccountsPayload(payload), pattern);
	}
});

test("Fireworks runtime auth accepts only official model and resolved-auth origins", async () => {
	const { ctx: officialContext } = createMockContext({
		model: FIREWORKS_MODEL,
		modelRegistry: {
			getApiKeyAndHeaders: async () => ({
				ok: true,
				headers: {
					Authorization: "Bearer fw-current-key",
					"X-Private": "must-not-send",
				},
			}),
			getProviderAuth: async () => ({ auth: { apiKey: "provider-key" } }),
			getAvailable: () => [FIREWORKS_MODEL],
			getAll: () => [FIREWORKS_MODEL],
		},
	});
	const auth = await resolveUsageAuth(officialContext, adapter);
	assert.deepEqual(auth?.headers, { Authorization: "Bearer fw-current-key" });
	assert.equal(auth?.auth?.apiKey, "provider-key");
	assert.ok(auth?.secrets.includes("must-not-send"));

	const fetchMock = vi.spyOn(globalThis, "fetch");
	try {
		for (const [modelBaseUrl, authBaseUrl, pattern] of [
			["https://proxy.example.test/inference", undefined, /custom.*official/iu],
			[FIREWORKS_MODEL.baseUrl, "https://proxy.example.test/v1", /proxy-resolved.*official/iu],
		] as const) {
			const model = { ...FIREWORKS_MODEL, baseUrl: modelBaseUrl };
			const { ctx } = createMockContext({
				model,
				modelRegistry: {
					getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "must-not-send" }),
					getProviderAuth: async () => ({
						auth: {
							apiKey: "must-not-send",
							...(authBaseUrl ? { baseUrl: authBaseUrl } : {}),
						},
					}),
					getAvailable: () => [model],
					getAll: () => [model],
				},
			});
			await assert.rejects(() => resolveUsageAuth(ctx, adapter), pattern);
		}
		assert.equal(fetchMock.mock.calls.length, 0);
	} finally {
		fetchMock.mockRestore();
	}
});

test("Fireworks transport revalidates before network access and counts it against its deadline", async () => {
	const fetchMock = vi.spyOn(globalThis, "fetch");
	try {
		await assert.rejects(
			() => queryProviderUsage(adapter, fireworksAuth(), new AbortController().signal, 1_000),
			/request-boundary revalidation/iu,
		);
		await assert.rejects(
			() =>
				queryProviderUsage(
					adapter,
					fireworksAuth(),
					new AbortController().signal,
					5,
					() => new Promise<void>((resolve) => setTimeout(resolve, 10)),
					"acme",
				),
			/timed out.*fetching fireworks rated spend/iu,
		);
		assert.equal(fetchMock.mock.calls.length, 0);
	} finally {
		fetchMock.mockRestore();
	}
});

function summaryResponse(): Response {
	return new Response(
		JSON.stringify({
			lineItems: [{ category: "Serverless", series: "SERVERLESS", totalCost: money("1", 0) }],
		}),
		{ status: 200 },
	);
}

test("Fireworks transport auto-selects a single account and queries only the fixed endpoints", async () => {
	const requests: Array<{ url: string; init?: RequestInit }> = [];
	const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
		requests.push({ url: String(input), init });
		if (requests.length === 1) {
			return new Response(JSON.stringify({ accounts: [accountRow("acme")] }), { status: 200 });
		}
		return summaryResponse();
	});
	const nowMock = vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-08-30T12:34:56Z"));
	vi.stubGlobal("fetch", fetchMock);
	try {
		const report = await queryFireworks();
		assert.equal(report.providerId, "fireworks");
		assert.equal(report.accountLabel, "acme");
		assert.equal(requests.length, 2);
		assert.equal(requests[0]?.url, "https://api.fireworks.ai/v1/accounts?pageSize=200");
		assert.equal(
			requests[1]?.url,
			"https://api.fireworks.ai/v1/accounts/acme/billing/summary?startTime=2026-08-01T00%3A00%3A00Z&endTime=2026-08-31T00%3A00%3A00Z",
		);
		assert.equal(requests[1]?.init?.method, "GET");
		assert.equal(requests[1]?.init?.redirect, "error");
		assert.deepEqual(requests[1]?.init?.headers, {
			Authorization: "Bearer fw-test-secret",
			"User-Agent": "pi-usage",
		});

		const redirected = summaryResponse();
		Object.defineProperty(redirected, "redirected", { value: true });
		fetchMock.mockResolvedValueOnce(redirected);
		await assert.rejects(() => queryFireworks(), /refused a redirected response/iu);
	} finally {
		nowMock.mockRestore();
		vi.unstubAllGlobals();
	}
});

test("Fireworks target discovery aborts its owned request when the flow is cancelled", async () => {
	const controller = new AbortController();
	let requestSignal: AbortSignal | undefined;
	let markStarted: () => void = () => undefined;
	const started = new Promise<void>((resolve) => {
		markStarted = resolve;
	});
	const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
		requestSignal = init?.signal ?? undefined;
		markStarted();
		return new Promise<Response>((_resolve, reject) => {
			requestSignal?.addEventListener(
				"abort",
				() => reject(new DOMException("aborted", "AbortError")),
				{ once: true },
			);
		});
	});
	vi.stubGlobal("fetch", fetchMock);
	try {
		const pending = adapter.targets?.list(
			fireworksAuth(),
			controller.signal,
			1_000,
			async () => undefined,
		);
		assert.ok(pending);
		await started;
		controller.abort();
		await assert.rejects(pending, (error: unknown) => {
			return error instanceof Error && error.name === "AbortError";
		});
		assert.equal(requestSignal?.aborted, true);
	} finally {
		vi.unstubAllGlobals();
	}
});

test("Fireworks billing window uses the current UTC date after account discovery", async () => {
	let now = Date.parse("2026-08-30T23:59:59.900Z");
	const nowMock = vi.spyOn(Date, "now").mockImplementation(() => now);
	const requests: string[] = [];
	const fetchMock = vi.fn(async (input: string | URL | Request) => {
		requests.push(String(input));
		if (requests.length === 1) {
			now = Date.parse("2026-08-31T00:00:00.100Z");
			return new Response(JSON.stringify({ accounts: [accountRow("acme")] }), { status: 200 });
		}
		return summaryResponse();
	});
	vi.stubGlobal("fetch", fetchMock);
	try {
		await queryFireworks();
		assert.equal(
			requests[1],
			"https://api.fireworks.ai/v1/accounts/acme/billing/summary?startTime=2026-08-02T00%3A00%3A00Z&endTime=2026-09-01T00%3A00%3A00Z",
		);
	} finally {
		nowMock.mockRestore();
		vi.unstubAllGlobals();
	}
});

test("Fireworks transport shares one deadline across account pages", async () => {
	vi.useFakeTimers();
	vi.setSystemTime(0);
	let page = 0;
	const fetchMock = vi.fn(async () => {
		await new Promise<void>((resolve) => setTimeout(resolve, 8));
		page += 1;
		return new Response(
			JSON.stringify(
				page === 1
					? { accounts: [accountRow("acme")], nextPageToken: "token-1" }
					: { accounts: [accountRow("beta")] },
			),
			{ status: 200 },
		);
	});
	vi.stubGlobal("fetch", fetchMock);
	try {
		const rejection = assert.rejects(
			queryFireworks(new AbortController().signal, 10),
			/timed out after .* while fetching usage/iu,
		);
		await vi.advanceTimersByTimeAsync(16);
		await rejection;
		assert.equal(fetchMock.mock.calls.length, 2);
	} finally {
		vi.unstubAllGlobals();
		vi.useRealTimers();
	}
});

test("Fireworks target discovery completes pagination before using a remembered account", async () => {
	const requests: string[] = [];
	const fetchMock = vi.fn(async (input: string | URL | Request) => {
		requests.push(String(input));
		if (requests.length === 1) {
			return new Response(
				JSON.stringify({ accounts: [accountRow("acme")], nextPageToken: "still-more" }),
				{ status: 200 },
			);
		}
		if (requests.length === 2) {
			return new Response(JSON.stringify({ accounts: [accountRow("beta")] }), { status: 200 });
		}
		return summaryResponse();
	});
	vi.stubGlobal("fetch", fetchMock);
	try {
		const report = await queryFireworks(new AbortController().signal, 1_000, "acme");
		assert.equal(report.accountLabel, "acme");
		assert.equal(requests.length, 3);
		assert.match(requests[2] ?? "", /\/v1\/accounts\/acme\/billing\/summary\?/u);
	} finally {
		vi.unstubAllGlobals();
	}
});

test("Fireworks transport follows opaque pagination tokens across account pages", async () => {
	const requests: string[] = [];
	const fetchMock = vi.fn(async (input: string | URL | Request) => {
		requests.push(String(input));
		if (requests.length === 1) {
			return new Response(
				JSON.stringify({ accounts: [accountRow("acme")], nextPageToken: "token+/=" }),
				{ status: 200 },
			);
		}
		if (requests.length === 2) {
			return new Response(JSON.stringify({ accounts: [accountRow("bold")] }), { status: 200 });
		}
		return summaryResponse();
	});
	vi.stubGlobal("fetch", fetchMock);
	try {
		const report = await queryFireworks(new AbortController().signal, 1_000, "bold");
		assert.equal(report.accountLabel, "bold");
		assert.equal(requests.length, 3);
		assert.equal(requests[0], "https://api.fireworks.ai/v1/accounts?pageSize=200");
		assert.equal(
			requests[1],
			"https://api.fireworks.ai/v1/accounts?pageSize=200&pageToken=token%2B%2F%3D",
		);
		assert.match(requests[2] ?? "", /\/v1\/accounts\/bold\/billing\/summary\?/u);
	} finally {
		vi.unstubAllGlobals();
	}
});

test("queryProviderUsage preserves legacy Fireworks settings and auto-selection", async () => {
	const requests: string[] = [];
	const fetchMock = vi.fn(async (input: string | URL | Request) => {
		const url = String(input);
		requests.push(url);
		return url.includes("/v1/accounts?")
			? new Response(JSON.stringify({ accounts: [accountRow("acme")] }), { status: 200 })
			: summaryResponse();
	});
	vi.stubGlobal("fetch", fetchMock);
	try {
		const legacySettings: UsageQuerySettings = { fireworksAccountId: "acme" };
		for (const settings of [legacySettings, undefined]) {
			const report = await queryProviderUsage(
				adapter,
				fireworksAuth(),
				new AbortController().signal,
				1_000,
				async () => undefined,
				settings,
			);
			assert.equal(report.accountLabel, "acme");
		}
		assert.equal(requests.filter((url) => url.includes("/v1/accounts?")).length, 2);
		assert.equal(requests.filter((url) => url.includes("/billing/summary")).length, 2);
		assert.ok(
			requests
				.filter((url) => url.includes("/billing/summary"))
				.every((url) => /\/v1\/accounts\/acme\/billing\/summary\?/u.test(url)),
		);
	} finally {
		vi.unstubAllGlobals();
	}
});

test("Fireworks target discovery returns unresolved choices and query validates exact slugs", async () => {
	const fetchMock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => {
		return new Response(JSON.stringify({ accounts: [accountRow("acme"), accountRow("beta")] }), {
			status: 200,
		});
	});
	vi.stubGlobal("fetch", fetchMock);
	try {
		const auth = fireworksAuth();
		const unresolved = await resolveUsageTarget(
			adapter,
			auth,
			undefined,
			new AbortController().signal,
			1_000,
			async () => undefined,
		);
		assert.deepEqual(unresolved, {
			kind: "selection-required",
			choices: [
				{ id: "acme", label: "acme" },
				{ id: "beta", label: "beta" },
			],
		});
		await assert.rejects(
			() =>
				queryProviderUsage(
					adapter,
					auth,
					new AbortController().signal,
					1_000,
					async () => undefined,
					"../other",
				),
			/safe selected account slug/iu,
		);
		const stale = await resolveUsageTarget(
			adapter,
			auth,
			"hidden-account",
			new AbortController().signal,
			1_000,
			async () => undefined,
		);
		assert.equal(stale.kind, "selection-required");
	} finally {
		vi.unstubAllGlobals();
	}
});

test("Fireworks transport rejects invalid page tokens and bounds bodies, JSON, and errors", async () => {
	const fetchMock = vi.fn(
		async () =>
			new Response(
				JSON.stringify({ accounts: [accountRow("acme")], nextPageToken: "x".repeat(513) }),
				{
					status: 200,
				},
			),
	);
	vi.stubGlobal("fetch", fetchMock);
	try {
		await assert.rejects(() => queryFireworks(), /invalid page token/iu);

		fetchMock.mockResolvedValueOnce(
			new Response(JSON.stringify({ accounts: [accountRow("acme")] }), { status: 200 }),
		);
		fetchMock.mockResolvedValueOnce(new Response("x".repeat(70_000), { status: 200 }));
		await assert.rejects(() => queryFireworks(), /exceeded.*bytes/iu);

		fetchMock.mockResolvedValueOnce(
			new Response(JSON.stringify({ accounts: [accountRow("acme")] }), { status: 200 }),
		);
		fetchMock.mockResolvedValueOnce(new Response("{broken", { status: 200 }));
		await assert.rejects(() => queryFireworks(), /invalid JSON/iu);

		fetchMock.mockResolvedValueOnce(
			new Response("Bearer fw-test-secret failed\u001b[31m", { status: 401, statusText: "Denied" }),
		);
		await assert.rejects(
			() => queryFireworks(),
			(error: unknown) =>
				error instanceof Error &&
				error.message.includes("401") &&
				!error.message.includes("fw-test-secret") &&
				!error.message.includes("\u001b"),
		);
	} finally {
		vi.unstubAllGlobals();
	}
});
