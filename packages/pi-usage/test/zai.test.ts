import assert from "node:assert/strict";
import { test, vi } from "vitest";
import { createMockContext, createMockPi } from "../../../test/support.js";
import { UsageUnsupportedError } from "../src/core.js";
import {
	formatUsageReport,
	formatUsageStatusline,
	normalizeZaiQuotaPayload,
	normalizeZaiSubscriptionPayload,
	queryProviderUsage,
	type ResolvedUsageAuth,
	resolveUsageAuth,
	SUPPORTED_ADAPTERS,
} from "../src/index.js";
import usageExtension from "../src/usage.js";

const ZAI_QUOTA_PAYLOAD = {
	code: 200,
	msg: "Success",
	success: true,
	data: {
		limits: [
			{
				type: "TIME_LIMIT",
				unit: 5,
				number: 1,
				usage: 4000,
				currentValue: 224,
				remaining: 3776,
				percentage: 5,
				nextResetTime: 1_772_615_765_983,
				usageDetails: [{ modelCode: "search-prime", usage: 67 }],
			},
			{
				type: "TOKENS_LIMIT",
				unit: 3,
				number: 5,
				percentage: 13,
				nextResetTime: 1_771_073_738_808,
			},
			{
				type: "TOKENS_LIMIT",
				unit: 6,
				usage: 500_000,
				currentValue: 120_000,
				percentage: 24,
				nextResetTime: 1_744_137_600_000,
			},
		],
		level: "lite",
	},
};

const ZAI_MODEL = {
	id: "glm-5.8",
	name: "GLM-5.8",
	provider: "zai",
	baseUrl: "https://api.z.ai/api/coding/paas/v4",
};

const ZAI_SUBSCRIPTION_PAYLOAD = {
	code: 200,
	success: true,
	data: [
		{
			id: "169359",
			customerId: "71321768207710758",
			productName: "GLM Coding Max",
			status: "VALID",
			autoRenew: 1,
			billingCycle: "monthly",
			nextRenewTime: "2026-02-12",
		},
	],
};

function zaiFetchStub(
	requests: Array<{ url: string; authorization: string | undefined }>,
	payloadFor: (url: string) => Response,
) {
	return async (input: string | URL | Request, init?: RequestInit) => {
		const headers = (init?.headers ?? {}) as Record<string, string>;
		const url = String(input);
		requests.push({ url, authorization: headers.Authorization });
		return payloadFor(url);
	};
}

const ZAI_ORIGINS = [
	["zai", "https://api.z.ai/api/coding/paas/v4"],
	["zai-coding-cn", "https://open.bigmodel.cn/api/coding/paas/v4"],
] as const;

function zaiUsageAuth(
	model: typeof ZAI_MODEL,
	authorization = "Bearer zai-secret-key",
): ResolvedUsageAuth {
	return {
		apiKey: "zai-secret-key",
		headers: { Authorization: authorization },
		fingerprint: "fingerprint",
		secrets: ["zai-secret-key", authorization],
		model: model as never,
	};
}

test("Z.AI adapter normalizes 5h, weekly, and MCP monthly windows", () => {
	const report = normalizeZaiQuotaPayload("zai", "Z.AI", ZAI_QUOTA_PAYLOAD, 500);

	assert.equal(report.providerId, "zai");
	assert.equal(report.providerName, "Z.AI");
	assert.equal(report.source, "zai-quota");
	assert.deepEqual(report.semantics, {
		kind: "consumer-subscription",
		label: "GLM Coding Plan usage",
	});
	assert.equal(report.buckets.length, 3);

	const fiveHour = report.buckets.find((bucket) => bucket.id === "five-hour");
	assert.deepEqual(fiveHour, {
		id: "five-hour",
		label: "5h window",
		used: 13,
		remaining: 87,
		limit: 100,
		unit: "percent",
		windowMinutes: 300,
		resetsAt: 1_771_073_738,
	});

	const weekly = report.buckets.find((bucket) => bucket.id === "weekly");
	assert.deepEqual(weekly, {
		id: "weekly",
		label: "Weekly window",
		used: 120_000,
		remaining: 380_000,
		limit: 500_000,
		unit: "count",
		windowMinutes: 10_080,
		resetsAt: 1_744_137_600,
	});

	const mcpMonthly = report.buckets.find((bucket) => bucket.id === "mcp-monthly");
	assert.deepEqual(mcpMonthly, {
		id: "mcp-monthly",
		label: "MCP monthly allowance",
		used: 224,
		remaining: 3_776,
		limit: 4_000,
		unit: "count",
		resetsAt: 1_772_615_765,
	});

	assert.deepEqual(report.metrics, [
		{ id: "mcp-search-prime", label: "search-prime", value: 67, unit: "count" },
	]);
	assert.deepEqual(report.notes, ["Plan: lite"]);
	const rendered = formatUsageReport(report, "current");
	assert.match(rendered, /Z\.AI Usage · Current/);
	assert.match(rendered, /GLM Coding Plan usage/);
	assert.match(rendered, /MCP monthly allowance:\s+224 of 4000 used · 3776 left \(resets /);
	assert.match(rendered, /5h window:\s+\[█{17}░{3}\] 87% left \(resets /);
	assert.match(rendered, /Weekly window:\s+120000 of 500000 used · 380000 left \(resets /);
	assert.match(rendered, /search-prime:\s+67/);
	assert.equal(formatUsageStatusline(report), "zai 87% 5h 76% wk");
});

test("Z.AI adapter keeps percentage-only 5h windows displayable without weekly data", () => {
	const report = normalizeZaiQuotaPayload(
		"zai-coding-cn",
		"Z.AI Coding CN",
		{
			data: {
				limits: [
					{ type: "TOKENS_LIMIT", unit: 3, percentage: 40, nextResetTime: 1_744_137_600_499 },
					{ type: "TOKENS_LIMIT", unit: 6 },
					{ type: "TIME_LIMIT", currentValue: 10 },
				],
			},
		},
		600,
	);

	assert.equal(report.providerId, "zai-coding-cn");
	assert.equal(report.providerName, "Z.AI Coding CN");
	assert.equal(report.buckets.length, 1);
	assert.deepEqual(report.buckets[0], {
		id: "five-hour",
		label: "5h window",
		used: 40,
		remaining: 60,
		limit: 100,
		unit: "percent",
		windowMinutes: 300,
		resetsAt: 1_744_137_600,
	});
	assert.equal(report.notes, undefined);
	assert.equal(report.metrics.length, 0);
	assert.equal(formatUsageStatusline(report), "zai 60% 5h");
});

test("Z.AI adapter shows percentage-only weekly windows as percent buckets", () => {
	const report = normalizeZaiQuotaPayload(
		"zai",
		"Z.AI",
		{
			data: {
				limits: [
					{ type: "TIME_LIMIT", unit: 5, usage: 100, currentValue: 0, percentage: 0 },
					{ type: "TOKENS_LIMIT", unit: 3, usage: null, currentValue: null, percentage: 22 },
					{ type: "TOKENS_LIMIT", unit: 6, usage: null, currentValue: null, percentage: 10 },
				],
			},
		},
		700,
	);

	assert.deepEqual(
		report.buckets.map((bucket) => [bucket.id, bucket.unit, bucket.remaining]),
		[
			["mcp-monthly", "count", 100],
			["five-hour", "percent", 78],
			["weekly", "percent", 90],
		],
	);
	const weekly = report.buckets.find((bucket) => bucket.id === "weekly");
	assert.equal(weekly?.windowMinutes, 10_080);
});

test("Z.AI adapter accepts current credit-limit and mixed rollout window names", () => {
	for (const types of [
		["CREDIT_LIMIT", "CREDIT_LIMIT"],
		["TOKENS_LIMIT", "CREDIT_LIMIT"],
	] as const) {
		const report = normalizeZaiQuotaPayload(
			"zai",
			"Z.AI",
			{
				data: {
					limits: [
						{ type: types[0], unit: 3, percentage: 42 },
						{ type: types[1], unit: 6, percentage: 15 },
					],
				},
			},
			800,
		);

		assert.deepEqual(
			report.buckets.map((bucket) => [bucket.id, bucket.used, bucket.remaining]),
			[
				["five-hour", 42, 58],
				["weekly", 15, 85],
			],
		);
	}
});

test("Z.AI adapter derives window length and label from the payload window number", () => {
	const report = normalizeZaiQuotaPayload(
		"zai",
		"Z.AI",
		{
			data: {
				limits: [
					{
						type: "CREDIT_LIMIT",
						unit: 3,
						number: 1,
						percentage: 10,
						nextResetTime: 1_744_137_600_000,
					},
					{ type: "CREDIT_LIMIT", unit: 3, percentage: 20 },
					{ type: "CREDIT_LIMIT", unit: 6, number: 2, usage: 100, currentValue: 40 },
				],
			},
		},
		900,
	);

	assert.deepEqual(
		report.buckets.map((bucket) => [bucket.label, bucket.windowMinutes]),
		[
			["1h window", 60],
			["5h window", 300],
			["Weekly window", 20_160],
		],
	);
});

test("Z.AI adapter rejects malformed or empty quota responses", () => {
	assert.throws(() => normalizeZaiQuotaPayload("zai", "Z.AI", {}, 0), /not an object/);
	assert.throws(
		() => normalizeZaiQuotaPayload("zai", "Z.AI", { data: { limits: [] } }, 0),
		/no displayable usage data/,
	);
	assert.throws(
		() => normalizeZaiQuotaPayload("zai", "Z.AI", { data: { limits: "broken" } }, 0),
		/no displayable usage data/,
	);
});

test("Z.AI only classifies the explicit no-plan response as unsupported", () => {
	const noPlan = { code: 500, success: false, msg: "当前用户不存在coding plan" };
	for (const data of [undefined, null]) {
		assert.throws(
			() => normalizeZaiQuotaPayload("zai", "Z.AI", { ...noPlan, data }, 0),
			(error: unknown) =>
				error instanceof UsageUnsupportedError &&
				error.message === "No GLM Coding Plan on this Z.AI credential; API usage is not metered.",
		);
	}
	for (const payload of [
		{},
		{ data: [] },
		{ ...noPlan, data: [] },
		{ ...noPlan, data: "broken" },
		{ ...noPlan, data: false },
		{ ...noPlan, data: 0 },
		{ ...noPlan, data: {} },
		{ ...noPlan, code: undefined },
		{ ...noPlan, code: "500" },
		{ ...noPlan, code: 401 },
		{ ...noPlan, success: undefined },
		{ ...noPlan, success: true },
		{ ...noPlan, success: "false" },
		{ ...noPlan, msg: undefined },
		{ ...noPlan, msg: "Internal server error" },
		{ ...noPlan, msg: `${noPlan.msg} extra details` },
	]) {
		assert.throws(
			() => normalizeZaiQuotaPayload("zai", "Z.AI", payload, 0),
			(error: unknown) => error instanceof Error && !(error instanceof UsageUnsupportedError),
			JSON.stringify(payload),
		);
	}
});

test("Z.AI quota errors do not echo credentials across message truncation boundaries", async () => {
	const secret = "s".repeat(100);
	try {
		for (const [providerId, baseUrl] of ZAI_ORIGINS) {
			const adapter = SUPPORTED_ADAPTERS.find((candidate) => candidate.id === providerId);
			assert.ok(adapter);
			const auth = zaiUsageAuth({ ...ZAI_MODEL, provider: providerId, baseUrl }, secret);
			for (const msg of [secret, `当前用户不存在coding plan ${secret}`, `Invalid key: ${secret}`]) {
				vi.stubGlobal(
					"fetch",
					zaiFetchStub(
						[],
						() => new Response(JSON.stringify({ code: 500, success: false, msg }), { status: 200 }),
					),
				);
				await assert.rejects(
					() =>
						queryProviderUsage(adapter, auth, new AbortController().signal, 5_000, async () => {}),
					(error: unknown) => {
						assert.ok(error instanceof Error);
						assert.equal(error.message, "Z.AI quota response data was not an object.");
						assert.ok(!error.message.includes(secret.slice(0, 20)));
						assert.ok(!(error instanceof UsageUnsupportedError));
						return true;
					},
				);
			}
		}
	} finally {
		vi.unstubAllGlobals();
	}
});

test("Z.AI adapters query the official quota and plan endpoints with the raw API key", async () => {
	const requests: Array<{ url: string; authorization: string | undefined }> = [];
	vi.stubGlobal(
		"fetch",
		zaiFetchStub(
			requests,
			(url) =>
				new Response(
					JSON.stringify(
						url.endsWith("/subscription/list") ? ZAI_SUBSCRIPTION_PAYLOAD : ZAI_QUOTA_PAYLOAD,
					),
					{ status: 200 },
				),
		),
	);
	try {
		for (const [providerId, baseUrl] of ZAI_ORIGINS) {
			requests.length = 0;
			const adapter = SUPPORTED_ADAPTERS.find((candidate) => candidate.id === providerId);
			assert.ok(adapter);
			const report = await adapter.query(
				zaiUsageAuth({ ...ZAI_MODEL, provider: providerId, baseUrl }),
				new AbortController().signal,
				5_000,
				async () => {},
			);
			assert.equal(report.providerId, providerId);
			assert.deepEqual(report.notes, ["Plan: GLM Coding Max · renews 2026-02-12"]);

			assert.deepEqual(
				requests.map((request) => request.url),
				[
					`${new URL(baseUrl).origin}/api/monitor/usage/quota/limit`,
					`${new URL(baseUrl).origin}/api/biz/subscription/list`,
				],
			);
			assert.deepEqual(
				requests.map((request) => request.authorization),
				["zai-secret-key", "zai-secret-key"],
			);
		}
	} finally {
		vi.unstubAllGlobals();
	}
});

test("Z.AI adapters revalidate the request boundary between quota and plan requests", async () => {
	vi.stubGlobal(
		"fetch",
		zaiFetchStub(
			[],
			(url) =>
				new Response(
					JSON.stringify(
						url.endsWith("/subscription/list") ? ZAI_SUBSCRIPTION_PAYLOAD : ZAI_QUOTA_PAYLOAD,
					),
					{ status: 200 },
				),
		),
	);
	try {
		const adapter = SUPPORTED_ADAPTERS.find((candidate) => candidate.id === "zai");
		assert.ok(adapter);
		let guardCalls = 0;
		await queryProviderUsage(
			adapter,
			zaiUsageAuth(ZAI_MODEL),
			new AbortController().signal,
			5_000,
			async () => {
				guardCalls += 1;
			},
		);
		assert.equal(guardCalls, 2);
	} finally {
		vi.unstubAllGlobals();
	}
});

test("Z.AI adapter keeps the quota report when the plan endpoint fails", async () => {
	const requested: string[] = [];
	vi.stubGlobal(
		"fetch",
		zaiFetchStub([], (url) => {
			requested.push(url);
			if (url.endsWith("/subscription/list")) return new Response("boom", { status: 500 });
			return new Response(JSON.stringify(ZAI_QUOTA_PAYLOAD), { status: 200 });
		}),
	);
	try {
		const adapter = SUPPORTED_ADAPTERS.find((candidate) => candidate.id === "zai");
		assert.ok(adapter);
		const report = await queryProviderUsage(
			adapter,
			zaiUsageAuth(ZAI_MODEL),
			new AbortController().signal,
			5_000,
			async () => {},
		);
		assert.deepEqual(requested, [
			"https://api.z.ai/api/monitor/usage/quota/limit",
			"https://api.z.ai/api/biz/subscription/list",
		]);
		assert.deepEqual(report.notes, ["Plan: lite"]);
	} finally {
		vi.unstubAllGlobals();
	}
});

test("Z.AI adapter propagates cancellation from the plan endpoint", async () => {
	vi.stubGlobal(
		"fetch",
		zaiFetchStub([], (url) => {
			if (url.endsWith("/subscription/list")) {
				throw Object.assign(new Error("aborted"), { name: "AbortError" });
			}
			return new Response(JSON.stringify(ZAI_QUOTA_PAYLOAD), { status: 200 });
		}),
	);
	try {
		const adapter = SUPPORTED_ADAPTERS.find((candidate) => candidate.id === "zai");
		assert.ok(adapter);
		await assert.rejects(
			() =>
				adapter.query(zaiUsageAuth(ZAI_MODEL), new AbortController().signal, 5_000, async () => {}),
			(error: unknown) => (error as Error).name === "AbortError",
		);
	} finally {
		vi.unstubAllGlobals();
	}
});

test("Z.AI subscription normalizer extracts the plan name and renewal date", () => {
	assert.deepEqual(
		normalizeZaiSubscriptionPayload({
			code: 200,
			data: [
				{ status: "INVALID" },
				{ productName: "GLM Coding Max", nextRenewTime: "2026-02-12 16:55:13" },
			],
		}),
		{ name: "GLM Coding Max", renewsAt: "2026-02-12" },
	);
	assert.deepEqual(
		normalizeZaiSubscriptionPayload({
			data: [{ productName: "GLM Coding Pro", nextRenewTime: 1_771_073_738_808 }],
		}),
		{ name: "GLM Coding Pro", renewsAt: new Date(1_771_073_738_808).toISOString().slice(0, 10) },
	);
	assert.deepEqual(
		normalizeZaiSubscriptionPayload({ data: [{ productName: "GLM Coding Lite" }] }),
		{
			name: "GLM Coding Lite",
		},
	);
	assert.equal(normalizeZaiSubscriptionPayload({ data: [{ status: "VALID" }] }), undefined);
	assert.equal(normalizeZaiSubscriptionPayload({ data: [] }), undefined);
	assert.equal(normalizeZaiSubscriptionPayload({ data: "broken" }), undefined);
	assert.equal(normalizeZaiSubscriptionPayload({}), undefined);
});

test("Z.AI subscription normalizer prefers the current valid product over history", () => {
	assert.deepEqual(
		normalizeZaiSubscriptionPayload({
			code: 200,
			success: true,
			data: [
				{
					productName: "GLM Coding Lite",
					status: "EXPIRED",
					inCurrentPeriod: false,
					nextRenewTime: "2026-01-01",
				},
				{
					productName: "GLM Coding Pro",
					status: "VALID",
					inCurrentPeriod: 1,
					nextRenewTime: "2026-12-01",
				},
			],
		}),
		{ name: "GLM Coding Pro", renewsAt: "2026-12-01" },
	);
	assert.equal(
		normalizeZaiSubscriptionPayload({
			data: [{ productName: "GLM Coding Lite", status: "EXPIRED", inCurrentPeriod: false }],
		}),
		undefined,
	);
	assert.equal(
		normalizeZaiSubscriptionPayload({
			data: [{ productName: "GLM Coding Pro", status: "VALID", inCurrentPeriod: false }],
		}),
		undefined,
	);
	assert.equal(
		normalizeZaiSubscriptionPayload({
			code: 500,
			success: false,
			data: [{ productName: "GLM Coding Lite", status: "VALID" }],
		}),
		undefined,
	);
});

test("Z.AI adapters send an already unprefixed authorization unchanged", async () => {
	const requests: Array<{ url: string; authorization: string | undefined }> = [];
	vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
		const headers = (init?.headers ?? {}) as Record<string, string>;
		requests.push({ url: String(input), authorization: headers.Authorization });
		return new Response(JSON.stringify(ZAI_QUOTA_PAYLOAD), { status: 200 });
	});
	try {
		const adapter = SUPPORTED_ADAPTERS.find((candidate) => candidate.id === "zai");
		assert.ok(adapter);
		await adapter.query(
			zaiUsageAuth(ZAI_MODEL, "raw-zai-key"),
			new AbortController().signal,
			5_000,
			async () => {},
		);
		assert.deepEqual(
			requests.map((request) => request.url),
			[
				"https://api.z.ai/api/monitor/usage/quota/limit",
				"https://api.z.ai/api/biz/subscription/list",
			],
		);
		assert.deepEqual(
			requests.map((request) => request.authorization),
			["raw-zai-key", "raw-zai-key"],
		);
	} finally {
		vi.unstubAllGlobals();
	}
});

test("Z.AI adapters fail when the model base URL is unavailable", async () => {
	const adapter = SUPPORTED_ADAPTERS.find((candidate) => candidate.id === "zai");
	assert.ok(adapter);
	await assert.rejects(
		() =>
			adapter.query(
				zaiUsageAuth({ ...ZAI_MODEL, baseUrl: "" }),
				new AbortController().signal,
				5_000,
				async () => {},
			),
		/base URL is unavailable/,
	);
});

test("Z.AI usage resolves only official origins", async () => {
	const proxyModel = {
		id: "glm-5.8",
		name: "GLM-5.8",
		provider: "zai",
		baseUrl: "https://proxy.example.test/v1",
	};
	const { ctx: proxyContext } = createMockContext({
		model: proxyModel,
		modelRegistry: {
			getProviderAuth: async () => ({ auth: { apiKey: "proxy-key" } }),
			getAvailable: () => [proxyModel],
			getAll: () => [proxyModel],
		},
	});
	const zaiAdapter = SUPPORTED_ADAPTERS.find((candidate) => candidate.id === "zai");
	assert.ok(zaiAdapter);
	await assert.rejects(
		() => resolveUsageAuth(proxyContext, zaiAdapter),
		/custom.*base URL|official/iu,
	);

	for (const [providerId, baseUrl] of ZAI_ORIGINS) {
		const adapter = SUPPORTED_ADAPTERS.find((candidate) => candidate.id === providerId);
		assert.ok(adapter);
		const model = { ...proxyModel, provider: providerId, baseUrl };
		const { ctx } = createMockContext({
			model,
			modelRegistry: {
				getProviderAuth: async () => ({ auth: { apiKey: "official-key", baseUrl } }),
				getAvailable: () => [model],
				getAll: () => [model],
			},
		});
		const auth = await resolveUsageAuth(ctx, adapter);
		assert.deepEqual(auth?.headers, { Authorization: "Bearer official-key" });
	}
});

test("malformed Z.AI quota responses keep the error chip and scheduled recovery", async () => {
	vi.useFakeTimers();
	const mock = createMockPi();
	usageExtension(mock.pi);
	const { ctx, statuses } = createMockContext({
		model: ZAI_MODEL,
		modelRegistry: {
			getProviderAuth: async () => ({ auth: { apiKey: "zai-secret-key" } }),
			getAvailable: () => [ZAI_MODEL],
			getAll: () => [ZAI_MODEL],
			getProviderAuthStatus: () => ({ configured: true }),
			getProviderDisplayName: () => "Z.AI",
		},
	});
	let quotaPayload: object = {};
	vi.stubGlobal(
		"fetch",
		zaiFetchStub(
			[],
			(url) =>
				new Response(
					JSON.stringify(
						url.endsWith("/subscription/list") ? ZAI_SUBSCRIPTION_PAYLOAD : quotaPayload,
					),
					{ status: 200 },
				),
		),
	);
	try {
		await mock.events.get("session_start")?.[0]?.({}, ctx);
		await vi.advanceTimersByTimeAsync(0);
		assert.equal(statuses.get("usage"), "usage err: Z.AI quota response data was not an object.");
		quotaPayload = ZAI_QUOTA_PAYLOAD;
		await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
		assert.equal(statuses.get("usage"), "zai 87% 5h 76% wk");
	} finally {
		await mock.events.get("session_shutdown")?.[0]?.({}, ctx);
		vi.unstubAllGlobals();
		vi.useRealTimers();
	}
});

// Both API and coding plan credentials use the same coding base URL, so the no-plan answer is the
// only signal that a credential carries no subscription.
test("a Z.AI credential with no coding plan leaves the statusline empty", async () => {
	const noCodingPlan = { code: 500, msg: "当前用户不存在coding plan", success: false };
	vi.stubGlobal(
		"fetch",
		zaiFetchStub([], () => new Response(JSON.stringify(noCodingPlan), { status: 200 })),
	);
	try {
		const mock = createMockPi();
		usageExtension(mock.pi);
		const { ctx, statuses } = createMockContext({
			model: ZAI_MODEL,
			modelRegistry: {
				getProviderAuth: async () => ({ auth: { apiKey: "zai-secret-key" } }),
				getAvailable: () => [ZAI_MODEL],
				getAll: () => [ZAI_MODEL],
				getProviderAuthStatus: () => ({ configured: true }),
				getProviderDisplayName: () => "Z.AI",
			},
		});

		await mock.events.get("session_start")?.[0]?.({}, ctx);
		for (let index = 0; index < 8; index += 1) {
			await new Promise<void>((resolve) => setImmediate(resolve));
		}

		assert.equal(statuses.get("usage"), undefined);
	} finally {
		vi.unstubAllGlobals();
	}
});

// The verdict does not change on retry, so it is throttled like a failure instead of re-querying
// the quota and plan endpoints on every turn.
test("an unsupported Z.AI credential is throttled instead of re-queried each turn", async () => {
	const noCodingPlan = { code: 500, msg: "当前用户不存在coding plan", success: false };
	const requests: Array<{ url: string; authorization: string | undefined }> = [];
	vi.stubGlobal(
		"fetch",
		zaiFetchStub(requests, () => new Response(JSON.stringify(noCodingPlan), { status: 200 })),
	);
	try {
		const mock = createMockPi();
		usageExtension(mock.pi);
		const { ctx, statuses } = createMockContext({
			model: ZAI_MODEL,
			modelRegistry: {
				getProviderAuth: async () => ({ auth: { apiKey: "zai-secret-key" } }),
				getAvailable: () => [ZAI_MODEL],
				getAll: () => [ZAI_MODEL],
				getProviderAuthStatus: () => ({ configured: true }),
				getProviderDisplayName: () => "Z.AI",
			},
		});

		await mock.events.get("session_start")?.[0]?.({}, ctx);
		for (let turn = 0; turn < 3; turn += 1) {
			await mock.events.get("turn_start")?.[0]?.({}, ctx);
			for (let index = 0; index < 8; index += 1) {
				await new Promise<void>((resolve) => setImmediate(resolve));
			}
		}

		assert.equal(statuses.get("usage"), undefined);
		assert.deepEqual(
			requests.map((request) => request.url),
			[
				"https://api.z.ai/api/monitor/usage/quota/limit",
				"https://api.z.ai/api/biz/subscription/list",
			],
		);
	} finally {
		vi.unstubAllGlobals();
	}
});
