import assert from "node:assert/strict";
import { test, vi } from "vitest";
import { createMockContext } from "../../../test/support.js";
import {
	formatUsageReport,
	formatUsageStatusline,
	miniMaxUsageKind,
	normalizeMiniMaxUsagePayload,
	queryProviderUsage,
	type ResolvedUsageAuth,
	resolveUsageAuth,
	SUPPORTED_ADAPTERS,
	type UsageProviderAdapter,
} from "../src/index.js";

const MODELS = {
	minimax: {
		id: "MiniMax-M3",
		name: "MiniMax M3",
		provider: "minimax",
		baseUrl: "https://api.minimax.io/anthropic",
	},
	"minimax-cn": {
		id: "MiniMax-M3",
		name: "MiniMax M3",
		provider: "minimax-cn",
		baseUrl: "https://api.minimaxi.com/anthropic",
	},
} as const;

type ProviderId = keyof typeof MODELS;

function miniMaxAdapter(providerId: ProviderId): UsageProviderAdapter {
	const candidate = SUPPORTED_ADAPTERS.find((adapter) => adapter.id === providerId);
	assert.ok(candidate);
	return candidate;
}

function miniMaxAuth(providerId: ProviderId, apiKey: string): ResolvedUsageAuth {
	return {
		apiKey,
		headers: { Authorization: `Bearer ${apiKey}` },
		fingerprint: "fingerprint",
		secrets: [apiKey, `Bearer ${apiKey}`],
		model: MODELS[providerId] as never,
	};
}

function quotaPayload() {
	return {
		base_resp: { status_code: 0, status_msg: "success" },
		model_remains: [
			{
				model_name: "MiniMax-M*",
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
				weekly_boost_permille: 1_500,
			},
		],
	};
}

function balancePayload() {
	return {
		base_resp: { status_code: 0, status_msg: "success" },
		available_amount: "98.00001",
		cash_balance: "-2.50",
		voucher_balance: "100.50001",
		credit_balance: "0",
		owed_amount: "2.50",
		balance_alert_switch: true,
		balance_alert_threshold: "10",
	};
}

test("MiniMax deterministically selects Token Plan or pay-as-you-go by first-party key prefix", () => {
	assert.equal(miniMaxUsageKind("sk-token-plan"), "token-plan");
	assert.equal(miniMaxUsageKind("oauth-looking-token"), "token-plan");
	assert.equal(miniMaxUsageKind("sk-api-secret"), "account-balance");
});

test("MiniMax Token Plan normalizes legacy and current count semantics", () => {
	const report = normalizeMiniMaxUsagePayload("minimax", "token-plan", quotaPayload(), 1_000);
	assert.equal(report.providerId, "minimax");
	assert.equal(report.source, "minimax-token-plan");
	assert.deepEqual(report.semantics, {
		kind: "consumer-subscription",
		label: "MiniMax Token Plan quota",
	});
	assert.deepEqual(report.buckets[0], {
		id: "minimax-m:interval",
		label: "Rolling window",
		groupId: "minimax-m",
		groupLabel: "MiniMax-M*",
		used: 1_272,
		remaining: 228,
		limit: 1_500,
		unit: "count",
		windowMinutes: 300,
		resetsAt: 1_800_018_000,
	});
	assert.deepEqual(report.buckets[1], {
		id: "minimax-m:weekly",
		label: "Weekly window",
		groupId: "minimax-m",
		groupLabel: "MiniMax-M*",
		used: 200,
		remaining: 800,
		limit: 1_000,
		unit: "count",
		windowMinutes: 10_080,
		resetsAt: 1_800_576_000,
	});
	const formatted = formatUsageReport(report, "current");
	assert.match(formatted, /^MiniMax Token Plan · Current/mu);
	assert.match(formatted, /Rolling window:\s+228 of 1500 left · 15%/u);
	assert.match(formatted, /Weekly window:\s+800 of 1000 left · 80%/u);
	assert.equal(formatUsageStatusline(report), "minimax 15% 5h 80% wk");
});

test("MiniMax Token Plan preserves unlimited windows and sanitizes model labels", () => {
	const payload = quotaPayload();
	payload.model_remains[0] = {
		...payload.model_remains[0],
		model_name: "MiniMax\u001b[31m\nUnlimited",
		current_interval_status: 3,
		current_weekly_status: 3,
	};
	const report = normalizeMiniMaxUsagePayload("minimax-cn", "token-plan", payload, 2_000);
	assert.equal(report.buckets[0]?.groupLabel, "MiniMax Unlimited");
	assert.equal(report.buckets[0]?.period, "unlimited");
	assert.match(formatUsageReport(report, "configured"), /Rolling window:\s+unlimited/u);
	assert.equal(formatUsageStatusline(report), "minimax cn unlimited 5h unlimited wk");
});

test("MiniMax statusline preserves mixed windows and selects the active model group", () => {
	const mixedPayload = quotaPayload();
	mixedPayload.model_remains[0] = {
		...mixedPayload.model_remains[0],
		current_interval_status: 3,
	};
	const mixed = normalizeMiniMaxUsagePayload("minimax", "token-plan", mixedPayload, 2_500);
	assert.equal(formatUsageStatusline(mixed), "minimax unlimited 5h 80% wk");

	const groupedPayload = quotaPayload();
	groupedPayload.model_remains = [
		{ ...groupedPayload.model_remains[0], model_name: "MiniMax-M2" },
		{
			...groupedPayload.model_remains[0],
			model_name: "MiniMax-M*",
			current_interval_usage_count: 1_200,
			current_weekly_usage_count: 600,
			current_weekly_remaining_percent: 60,
		},
	];
	const grouped = normalizeMiniMaxUsagePayload("minimax", "token-plan", groupedPayload, 2_600);
	assert.equal(formatUsageStatusline(grouped, MODELS.minimax), "minimax 80% 5h 60% wk");
	assert.equal(
		formatUsageStatusline(grouped, { ...MODELS.minimax, id: "Other-X", name: "Other X" }),
		undefined,
	);
});

test("MiniMax statusline prefers an exact model group over an earlier wildcard", () => {
	const overlappingPayload = quotaPayload();
	overlappingPayload.model_remains = [
		{
			...overlappingPayload.model_remains[0],
			current_interval_usage_count: 1_200,
			current_weekly_usage_count: 600,
			current_weekly_remaining_percent: 60,
		},
		{ ...overlappingPayload.model_remains[0], model_name: "MiniMax-M3" },
	];
	const overlapping = normalizeMiniMaxUsagePayload(
		"minimax",
		"token-plan",
		overlappingPayload,
		2_700,
	);
	assert.equal(formatUsageStatusline(overlapping, MODELS.minimax), "minimax 15% 5h 80% wk");
});

test("MiniMax pay-as-you-go keeps exact regional balance strings and debt components", () => {
	for (const [providerId, currency] of [
		["minimax", "USD"],
		["minimax-cn", "CNY"],
	] as const) {
		const report = normalizeMiniMaxUsagePayload(
			providerId,
			"account-balance",
			balancePayload(),
			3_000,
		);
		assert.equal(report.source, "minimax-account-balance");
		assert.deepEqual(
			report.metrics.map((metric) => [metric.id, metric.value, metric.currency]),
			[
				["available-balance", "98.00001", currency],
				["cash-balance", "-2.50", currency],
				["voucher-balance", "100.50001", currency],
				["credit-balance", "0", currency],
				["owed-amount", "2.50", currency],
			],
		);
		assert.match(
			formatUsageReport(report, "current"),
			/Available balance:\s+(?:USD|CNY) 98\.00001/u,
		);
		assert.equal(
			formatUsageStatusline(report),
			`${providerId === "minimax-cn" ? "minimax cn" : "minimax"} ${currency} 98.00001`,
		);
	}
});

test("MiniMax normalizers reject failed, malformed, or contradictory responses", () => {
	for (const [kind, payload] of [
		["token-plan", {}],
		["token-plan", { ...quotaPayload(), base_resp: { status_code: 1 } }],
		["token-plan", { ...quotaPayload(), model_remains: [] }],
		["token-plan", { ...quotaPayload(), model_remains: [null] }],
		[
			"token-plan",
			{
				...quotaPayload(),
				model_remains: [
					{ ...quotaPayload().model_remains[0], current_interval_usage_count: 2_000 },
				],
			},
		],
		[
			"token-plan",
			{
				...quotaPayload(),
				model_remains: [
					{ ...quotaPayload().model_remains[0], current_weekly_remaining_percent: 5 },
				],
			},
		],
		["account-balance", { ...balancePayload(), available_amount: "1e3" }],
		["account-balance", { ...balancePayload(), voucher_balance: "-1" }],
		["account-balance", { ...balancePayload(), cash_balance: 1 }],
	] as const) {
		assert.throws(
			() => normalizeMiniMaxUsagePayload("minimax", kind, payload, 0),
			/did not report success|no quota rows|not an object|inconsistent|not a valid amount/iu,
		);
	}
});

test("MiniMax Token Plan renders percent-based buckets when total is zero but percent is valid", () => {
	// The general row in the user's API has total=0 / usage=0 but reports
	// meaningful *_remaining_percent values (the API uses percent as the canonical
	// indicator for Token Plan rows). It must NOT be skipped and must render with
	// unit="percent".
	const base = quotaPayload().model_remains[0];
	const payload = {
		base_resp: { status_code: 0, status_msg: "success" },
		model_remains: [
			{
				...base,
				model_name: "general",
				current_interval_total_count: 0,
				current_interval_usage_count: 0,
				current_interval_remaining_percent: 38,
				current_weekly_total_count: 0,
				current_weekly_usage_count: 0,
				current_weekly_remaining_percent: 32,
			},
			{
				...base,
				model_name: "video",
				current_interval_total_count: 5,
				current_interval_usage_count: 0,
				current_interval_remaining_percent: 100,
				current_weekly_total_count: 35,
				current_weekly_usage_count: 2,
				current_weekly_remaining_percent: 94,
			},
		],
	};
	const report = normalizeMiniMaxUsagePayload("minimax", "token-plan", payload, 1_000);
	// Both rows render: 4 buckets total (2 per row).
	assert.equal(report.buckets.length, 4);
	const general = report.buckets.filter((b) => b.groupLabel === "general");
	const video = report.buckets.filter((b) => b.groupLabel === "video");
	assert.equal(general.length, 2);
	assert.equal(video.length, 2);
	const generalInterval = general.find((b) => b.label === "Rolling window");
	const generalWeekly = general.find((b) => b.label === "Weekly window");
	assert.equal(generalInterval?.unit, "percent");
	assert.equal(generalInterval?.remaining, 38);
	assert.equal(generalInterval?.used, 62);
	assert.equal(generalInterval?.limit, 0);
	assert.equal(generalWeekly?.unit, "percent");
	assert.equal(generalWeekly?.remaining, 32);
	assert.equal(generalWeekly?.used, 68);
	assert.equal(generalWeekly?.limit, 0);
});

test("MiniMax Token Plan percent-only buckets render with percent and resets, not 'unavailable'", () => {
	const base = quotaPayload().model_remains[0];
	const payload = {
		base_resp: { status_code: 0, status_msg: "success" },
		model_remains: [
			{
				...base,
				model_name: "general",
				current_interval_total_count: 0,
				current_interval_usage_count: 0,
				current_interval_remaining_percent: 38,
				current_weekly_total_count: 0,
				current_weekly_usage_count: 0,
				current_weekly_remaining_percent: 32,
			},
		],
	};
	const report = normalizeMiniMaxUsagePayload("minimax", "token-plan", payload, 1_000);
	const formatted = formatUsageReport(report, "current");
	assert.doesNotMatch(formatted, /unavailable/iu);
	assert.match(formatted, /Rolling window:\s+38% remaining/iu);
	assert.match(formatted, /Weekly window:\s+32% remaining/iu);
	assert.match(formatted, /\(resets [^)]+\)/u);
});

test("MiniMax Token Plan rejects rows with zero total and no usable percent", () => {
	const base = quotaPayload().model_remains[0];
	const payload = {
		base_resp: { status_code: 0, status_msg: "success" },
		model_remains: [
			{
				...base,
				model_name: "general",
				current_interval_total_count: 0,
				current_interval_usage_count: 0,
				current_interval_remaining_percent: undefined,
				current_weekly_total_count: 0,
				current_weekly_usage_count: 0,
				current_weekly_remaining_percent: undefined,
			},
		],
	};
	// We strip the undefined percent fields via JSON serialization; the API never
	// returns them as undefined, but the production code defends against it.
	const cleaned = JSON.parse(JSON.stringify(payload));
	assert.throws(
		() => normalizeMiniMaxUsagePayload("minimax", "token-plan", cleaned, 0),
		/no quota and no percent/iu,
	);
});

test("MiniMax Token Plan keeps mixed rows where one window is zero-total and the other has counts", () => {
	const base = quotaPayload().model_remains[0];
	const payload = {
		base_resp: { status_code: 0, status_msg: "success" },
		model_remains: [
			{
				...base,
				model_name: "general",
				current_interval_total_count: 0,
				current_interval_usage_count: 0,
				current_interval_remaining_percent: 0,
				current_weekly_total_count: 1000,
				current_weekly_usage_count: 200,
				current_weekly_remaining_percent: 80,
			},
		],
	};
	const report = normalizeMiniMaxUsagePayload("minimax", "token-plan", payload, 1_000);
	assert.equal(report.buckets.length, 2);
	const interval = report.buckets.find((b) => b.label === "Rolling window");
	const weekly = report.buckets.find((b) => b.label === "Weekly window");
	// Rolling: percent-based (percent=0 → 100% used).
	assert.equal(interval?.unit, "percent");
	assert.equal(interval?.remaining, 0);
	assert.equal(interval?.used, 100);
	// Weekly: count-based.
	assert.equal(weekly?.unit, "count");
	assert.equal(weekly?.limit, 1000);
	assert.equal(weekly?.used, 200);
	assert.equal(weekly?.remaining, 800);
});

test("MiniMax runtime auth accepts only its matching official region", async () => {
	const fetchMock = vi.spyOn(globalThis, "fetch");
	try {
		for (const providerId of ["minimax", "minimax-cn"] as const) {
			const model = MODELS[providerId];
			const adapter = miniMaxAdapter(providerId);
			const { ctx } = createMockContext({
				model,
				modelRegistry: {
					getApiKeyAndHeaders: async () => ({ ok: true, apiKey: `${providerId}-key` }),
					getProviderAuth: async () => ({ auth: { apiKey: "provider-key" } }),
					getAvailable: () => [model],
					getAll: () => [model],
				},
			});
			const auth = await resolveUsageAuth(ctx, adapter);
			assert.deepEqual(auth?.headers, { Authorization: `Bearer ${providerId}-key` });

			for (const [modelBaseUrl, authBaseUrl, pattern] of [
				["https://proxy.example.test/anthropic", undefined, /custom.*official/iu],
				[model.baseUrl, "https://proxy.example.test/v1", /proxy-resolved.*official/iu],
			] as const) {
				const rejectedModel = { ...model, baseUrl: modelBaseUrl };
				const { ctx: rejectedContext } = createMockContext({
					model: rejectedModel,
					modelRegistry: {
						getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "must-not-send" }),
						getProviderAuth: async () => ({
							auth: {
								apiKey: "must-not-send",
								...(authBaseUrl ? { baseUrl: authBaseUrl } : {}),
							},
						}),
						getAvailable: () => [rejectedModel],
						getAll: () => [rejectedModel],
					},
				});
				await assert.rejects(() => resolveUsageAuth(rejectedContext, adapter), pattern);
			}
		}
		assert.equal(fetchMock.mock.calls.length, 0);
	} finally {
		fetchMock.mockRestore();
	}
});

test("MiniMax reads current model auth after provider validation when the key rotates", async () => {
	for (const providerId of ["minimax", "minimax-cn"] as const) {
		const model = MODELS[providerId];
		let activeKey = `stale-${providerId}-key`;
		const { ctx } = createMockContext({
			model,
			modelRegistry: {
				getApiKeyAndHeaders: async () => {
					const resolvedKey = activeKey;
					await Promise.resolve();
					return { ok: true, apiKey: resolvedKey };
				},
				getProviderAuth: async () => {
					activeKey = `current-${providerId}-key`;
					return { auth: { apiKey: activeKey, baseUrl: model.baseUrl } };
				},
				getAvailable: () => [model],
				getAll: () => [model],
			},
		});

		const auth = await resolveUsageAuth(ctx, miniMaxAdapter(providerId));
		assert.deepEqual(auth?.headers, { Authorization: `Bearer current-${providerId}-key` });
		assert.ok(!auth?.secrets.includes(`stale-${providerId}-key`));
	}
});

test("MiniMax endpoint selection follows the Bearer credential actually sent", async () => {
	const requests: string[] = [];
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: string | URL | Request) => {
			const url = String(input);
			requests.push(url);
			const body = url.endsWith("/account/query_balance") ? balancePayload() : quotaPayload();
			return new Response(JSON.stringify(body), { status: 200 });
		}),
	);
	try {
		for (const [apiKey, bearer, expectedPath] of [
			["sk-api-stale", "token-plan-active", "/v1/token_plan/remains"],
			["token-plan-stale", "sk-api-active", "/account/query_balance"],
		] as const) {
			const auth = miniMaxAuth("minimax", apiKey);
			auth.headers.Authorization = `Bearer ${bearer}`;
			await queryProviderUsage(
				miniMaxAdapter("minimax"),
				auth,
				new AbortController().signal,
				1_000,
				async () => undefined,
			);
			assert.ok(requests.at(-1)?.endsWith(expectedPath));
		}
		assert.equal(requests.length, 2);
	} finally {
		vi.unstubAllGlobals();
	}
});

test("MiniMax transport selects one fixed endpoint without credential probing", async () => {
	const requests: Array<{ url: string; init?: RequestInit }> = [];
	const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
		requests.push({ url: String(input), init });
		const body = String(input).endsWith("/account/query_balance")
			? balancePayload()
			: quotaPayload();
		return new Response(JSON.stringify(body), { status: 200 });
	});
	vi.stubGlobal("fetch", fetchMock);
	try {
		for (const [providerId, apiKey, expectedUrl] of [
			["minimax", "sk-token-plan", "https://api.minimax.io/v1/token_plan/remains"],
			["minimax", "sk-api-secret", "https://api.minimax.io/account/query_balance"],
			["minimax-cn", "sk-token-plan", "https://api.minimaxi.com/v1/token_plan/remains"],
			["minimax-cn", "sk-api-secret", "https://api.minimaxi.com/account/query_balance"],
		] as const) {
			let guardCalls = 0;
			await queryProviderUsage(
				miniMaxAdapter(providerId),
				miniMaxAuth(providerId, apiKey),
				new AbortController().signal,
				1_000,
				async () => {
					guardCalls += 1;
				},
			);
			assert.equal(guardCalls, 2);
			const request = requests.at(-1);
			assert.equal(request?.url, expectedUrl);
			assert.equal(request?.init?.redirect, "error");
			assert.deepEqual(request?.init?.headers, {
				Authorization: `Bearer ${apiKey}`,
				"User-Agent": "pi-usage",
			});
		}
		assert.equal(requests.length, 4);
	} finally {
		vi.unstubAllGlobals();
	}
});

test("MiniMax transport requires revalidation and handles redirects, bounds, and redaction", async () => {
	const adapter = miniMaxAdapter("minimax");
	const auth = miniMaxAuth("minimax", "sk-token-plan");
	const fetchMock = vi.fn(
		async () => new Response(JSON.stringify(quotaPayload()), { status: 200 }),
	);
	vi.stubGlobal("fetch", fetchMock);
	try {
		await assert.rejects(
			() => queryProviderUsage(adapter, auth, new AbortController().signal, 1_000),
			/request-boundary revalidation/iu,
		);
		assert.equal(fetchMock.mock.calls.length, 0);

		const redirected = new Response(JSON.stringify(quotaPayload()), { status: 200 });
		Object.defineProperty(redirected, "redirected", { value: true });
		fetchMock.mockResolvedValueOnce(redirected);
		await assert.rejects(
			() =>
				queryProviderUsage(
					adapter,
					auth,
					new AbortController().signal,
					1_000,
					async () => undefined,
				),
			/refused a redirected response/iu,
		);
		fetchMock.mockResolvedValueOnce(new Response("x".repeat(70_000), { status: 200 }));
		await assert.rejects(
			() =>
				queryProviderUsage(
					adapter,
					auth,
					new AbortController().signal,
					1_000,
					async () => undefined,
				),
			/exceeded.*bytes/iu,
		);
		fetchMock.mockResolvedValueOnce(
			new Response("Bearer sk-token-plan failed\u001b[31m", {
				status: 401,
				statusText: "Denied",
			}),
		);
		await assert.rejects(
			() =>
				queryProviderUsage(
					adapter,
					auth,
					new AbortController().signal,
					1_000,
					async () => undefined,
				),
			(error: unknown) =>
				error instanceof Error &&
				error.message.includes("401") &&
				!error.message.includes("sk-token-plan") &&
				!error.message.includes("\u001b"),
		);

		fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(quotaPayload()), { status: 200 }));
		let guardCalls = 0;
		await assert.rejects(
			() =>
				queryProviderUsage(adapter, auth, new AbortController().signal, 1_000, async () => {
					guardCalls += 1;
					if (guardCalls === 2) {
						throw Object.assign(new Error("stale auth"), { name: "AbortError" });
					}
				}),
			(error: unknown) => error instanceof Error && error.name === "AbortError",
		);
	} finally {
		vi.unstubAllGlobals();
	}
});
