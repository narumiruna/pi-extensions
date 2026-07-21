import assert from "node:assert/strict";
import test from "node:test";
import { createMockContext } from "../../../test/support.js";
import type { UsageReport } from "../src/index.js";
import {
	awaitWithDeadline,
	fingerprintResolvedAuth,
	queryProviderUsage,
	redactUsageError,
	resolveUsageAuth,
	runWithConcurrency,
	SUPPORTED_ADAPTERS,
	sanitizeDisplayText,
	UsageCache,
} from "../src/index.js";

const report: UsageReport = {
	providerId: "openrouter",
	providerName: "OpenRouter",
	capturedAt: 1,
	source: "openrouter-key",
	semantics: { kind: "api-key", label: "API-key spend limits" },
	buckets: [],
	metrics: [{ id: "usage-total", label: "All-time usage", value: 1, unit: "usd" }],
};

test("credential fingerprints are process-salted, deterministic, and do not expose secrets", () => {
	const auth = {
		apiKey: "sk-secret",
		headers: { Authorization: "Bearer header-secret", "X-Test": "value" },
	};
	const first = fingerprintResolvedAuth(auth, Buffer.alloc(32, 1));
	const same = fingerprintResolvedAuth(auth, Buffer.alloc(32, 1));
	const anotherProcess = fingerprintResolvedAuth(auth, Buffer.alloc(32, 2));
	const anotherAccount = fingerprintResolvedAuth({ apiKey: "different" }, Buffer.alloc(32, 1));

	assert.equal(first, same);
	assert.notEqual(first, anotherProcess);
	assert.notEqual(first, anotherAccount);
	assert.doesNotMatch(first, /secret/);
});

test("usage cache isolates identities, expires entries, and remains bounded", () => {
	const cache = new UsageCache(300_000, 4);
	cache.set("openrouter", "account-a", report, 1_000);

	assert.equal(cache.get("openrouter", "account-a", 1_001), report);
	assert.equal(cache.get("openrouter", "account-b", 1_001), undefined);
	assert.equal(cache.get("openai-codex", "account-a", 1_001), undefined);
	assert.equal(cache.get("openrouter", "account-a", 301_001), undefined);
	assert.equal(cache.size, 0);

	for (let index = 0; index < 10; index += 1) {
		cache.set("openrouter", `account-${index}`, report, 400_000 + index);
	}
	assert.equal(cache.size, 4);
	assert.equal(cache.get("openrouter", "account-0", 400_020), undefined);
	assert.equal(cache.get("openrouter", "account-9", 400_020), report);
	cache.clearProvider("openrouter");
	assert.equal(cache.size, 0);
});

test("bounded orchestration retains stable partial results and respects cancellation", async () => {
	let active = 0;
	let maximumActive = 0;
	const controller = new AbortController();
	const results = await runWithConcurrency(
		[1, 2, 3, 4],
		2,
		async (value) => {
			active += 1;
			maximumActive = Math.max(maximumActive, active);
			await new Promise<void>((resolve) => setTimeout(resolve, value === 1 ? 10 : 1));
			active -= 1;
			if (value === 3) throw new Error("provider failed");
			return value * 2;
		},
		controller.signal,
	);

	assert.equal(maximumActive, 2);
	assert.deepEqual(
		results.map((result) =>
			result.status === "fulfilled" ? ["ok", result.value] : ["error", result.reason.message],
		),
		[
			["ok", 2],
			["ok", 4],
			["error", "provider failed"],
			["ok", 8],
		],
	);

	controller.abort();
	await assert.rejects(
		() => runWithConcurrency([1], 2, async (value) => value, controller.signal),
		/aborted/i,
	);
});

test("end-to-end deadline bounds slow work and preserves caller cancellation", async () => {
	const never = new Promise<never>(() => undefined);
	const controller = new AbortController();
	await assert.rejects(
		() => awaitWithDeadline(never, controller.signal, 5, "resolving auth"),
		(error: unknown) => error instanceof Error && error.name === "TimeoutError",
	);

	const cancelled = new AbortController();
	const pending = awaitWithDeadline(never, cancelled.signal, 1_000, "resolving auth");
	cancelled.abort();
	await assert.rejects(
		() => pending,
		(error: unknown) => error instanceof Error && error.name === "AbortError",
	);
});

test("runtime auth rejects proxy origins and forwards only adapter-approved headers", async () => {
	const adapter = SUPPORTED_ADAPTERS.find((candidate) => candidate.id === "openrouter");
	assert.ok(adapter);
	const proxyModel = {
		id: "proxy-model",
		name: "Proxy",
		provider: "openrouter",
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
	await assert.rejects(
		() => resolveUsageAuth(proxyContext, adapter),
		/custom.*base URL|official/iu,
	);

	const officialModel = { ...proxyModel, baseUrl: "https://openrouter.ai/api/v1" };
	const { ctx: effectiveProxyContext } = createMockContext({
		model: officialModel,
		modelRegistry: {
			getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "current-model-key" }),
			getProviderAuth: async () => ({
				auth: { apiKey: "proxy-key", baseUrl: "https://proxy.example.test/v1" },
			}),
			getAvailable: () => [officialModel],
			getAll: () => [officialModel],
		},
	});
	await assert.rejects(
		() => resolveUsageAuth(effectiveProxyContext, adapter),
		/proxy-resolved.*official/iu,
	);

	const { ctx: officialContext } = createMockContext({
		model: officialModel,
		modelRegistry: {
			getProviderAuth: async () => ({
				auth: {
					apiKey: "official-key",
					headers: { "X-Proxy-Secret": "must-not-leak", "X-Title": "private-title" },
				},
			}),
			getAvailable: () => [officialModel],
			getAll: () => [officialModel],
		},
	});
	const auth = await resolveUsageAuth(officialContext, adapter);
	assert.deepEqual(auth?.headers, { Authorization: "Bearer official-key" });

	const { ctx: modelScopedContext } = createMockContext({
		model: officialModel,
		modelRegistry: {
			getApiKeyAndHeaders: async () => ({
				ok: true,
				apiKey: "provider-default-key",
				headers: {
					Authorization: "Bearer current-model-key",
					"X-Model-Secret": "must-not-leak",
				},
			}),
			getProviderAuth: async () => ({ auth: { apiKey: "provider-default-key" } }),
			getAvailable: () => [officialModel],
			getAll: () => [officialModel],
		},
	});
	const modelScopedAuth = await resolveUsageAuth(modelScopedContext, adapter);
	assert.deepEqual(modelScopedAuth?.headers, { Authorization: "Bearer current-model-key" });
	assert.ok(modelScopedAuth?.secrets.includes("Bearer current-model-key"));
	assert.ok(!modelScopedAuth?.secrets.includes("must-not-leak"));

	const { ctx: modelKeyContext } = createMockContext({
		model: officialModel,
		modelRegistry: {
			getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "current-model-key" }),
			getProviderAuth: async () => ({ auth: { apiKey: "provider-default-key" } }),
			getAvailable: () => [officialModel],
			getAll: () => [officialModel],
		},
	});
	const modelKeyAuth = await resolveUsageAuth(modelKeyContext, adapter);
	assert.deepEqual(modelKeyAuth?.headers, { Authorization: "Bearer current-model-key" });
});

test("provider cancellation preserves AbortError identity", async () => {
	const abort = Object.assign(new Error("cancelled"), { name: "AbortError" });
	const adapter = {
		id: "test",
		displayName: "Test",
		semantics: { kind: "api-key" as const, label: "Test" },
		query: async () => {
			throw abort;
		},
	};
	const controller = new AbortController();
	await assert.rejects(
		() =>
			queryProviderUsage(
				adapter,
				{
					headers: { Authorization: "Bearer secret" },
					fingerprint: "fingerprint",
					secrets: ["secret"],
					model: {} as never,
				},
				controller.signal,
				10,
			),
		(error: unknown) => error instanceof Error && error.name === "AbortError",
	);
});

test("display sanitization strips terminal escapes, controls, and excessive text", () => {
	const sanitized = sanitizeDisplayText(
		"safe\u001b]8;;https://evil.test\u0007link\u001b]8;;\u0007\nnext",
		20,
	);
	assert.equal(sanitized, "safelink next");
	assert.equal(sanitizeDisplayText("x".repeat(100), 10), "xxxxxxxxx…");
});

test("provider response reads are byte-bounded", async (t) => {
	const originalFetch = globalThis.fetch;
	t.after(() => {
		globalThis.fetch = originalFetch;
	});
	const adapter = SUPPORTED_ADAPTERS.find((candidate) => candidate.id === "openrouter");
	assert.ok(adapter);
	const auth = {
		headers: { Authorization: "Bearer secret" },
		fingerprint: "fingerprint",
		secrets: ["secret"],
		model: { ...report, baseUrl: "https://openrouter.ai/api/v1" } as never,
	};
	globalThis.fetch = async () => new Response("x".repeat(70_000), { status: 200 });
	await assert.rejects(
		() => queryProviderUsage(adapter, auth, new AbortController().signal, 1_000),
		/exceeded.*bytes|too large/iu,
	);

	globalThis.fetch = async () => new Response("x".repeat(70_000), { status: 500 });
	await assert.rejects(
		() => queryProviderUsage(adapter, auth, new AbortController().signal, 1_000),
		(error: unknown) =>
			error instanceof Error && error.message.length < 1_000 && /returned 500/.test(error.message),
	);
});

test("usage error redaction removes exact runtime auth and common token fields", () => {
	const redacted = redactUsageError(
		'Bearer common-token {"access_token":"json-token"} sk-secret header-secret',
		["sk-secret", "header-secret"],
	);
	assert.doesNotMatch(redacted, /common-token|json-token|sk-secret|header-secret/);
	assert.match(redacted, /<redacted>/);
});
