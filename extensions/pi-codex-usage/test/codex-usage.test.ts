import assert from "node:assert/strict";
import test from "node:test";
import { createMockContext, createMockPi } from "../../../test/support.js";
import codexUsage, {
	type CodexUsageReport,
	completeCodexStatusArguments,
	formatCodexUsageReport,
	formatCodexUsageStatusline,
	isStaleExtensionContextError,
	normalizeAppServerResponse,
	normalizeBackendPayload,
	parseArgs,
} from "../src/codex-usage.js";

test("codex-usage registers command and statusline lifecycle hooks", () => {
	const mock = createMockPi();
	codexUsage(mock.pi);

	assert.ok(mock.commands.has("codex-status"));
	assert.equal(typeof mock.commands.get("codex-status")?.getArgumentCompletions, "function");
	assert.deepEqual([...mock.events.keys()].sort(), [
		"model_select",
		"session_shutdown",
		"session_start",
		"session_tree",
	]);
});

test("completeCodexStatusArguments suggests accepted options", () => {
	assert.deepEqual(
		completeCodexStatusArguments("")?.map((item) => item.label),
		["--refresh", "--no-statusline", "--clear-statusline", "--timeout"],
	);
	assert.deepEqual(
		completeCodexStatusArguments("--r")?.map((item) => item.value),
		["--refresh"],
	);
	assert.deepEqual(
		completeCodexStatusArguments("--timeout 2 --n")?.map((item) => item.value),
		["--timeout 2 --no-statusline"],
	);
	assert.deepEqual(
		completeCodexStatusArguments("--refresh --c")?.map((item) => item.value),
		["--refresh --clear-statusline"],
	);
	assert.equal(completeCodexStatusArguments("--timeout "), null);
	assert.equal(completeCodexStatusArguments("wat"), null);
});

test("parseArgs handles refresh, statusline, clear, and timeout options", () => {
	assert.deepEqual(parseArgs("--refresh --no-statusline --timeout 2"), {
		ok: true,
		value: { clearStatusline: false, refresh: true, statusline: false, timeoutMs: 2000 },
	});
	assert.deepEqual(parseArgs("--clear-statusline"), {
		ok: true,
		value: { clearStatusline: true, refresh: false, statusline: true, timeoutMs: 15000 },
	});
	assert.equal(parseArgs("--timeout 0").ok, false);
});

test("normalizeBackendPayload keeps primary and additional rate limits", () => {
	const report = normalizeBackendPayload(
		{
			plan_type: "pro_lite",
			rate_limit: {
				primary_window: { used_percent: 25, limit_window_seconds: 18000, reset_at: 1 },
			},
			credits: { has_credits: true, unlimited: false, balance: "12" },
			rate_limit_reset_credits: { available_count: 3 },
			additional_rate_limits: [
				{
					limit_name: "GPT-5.3 Codex Spark",
					metered_feature: "gpt-5.3-codex-spark",
					rate_limit: { primary_window: { used_percent: 10, limit_window_seconds: 18000 } },
				},
			],
		},
		1000,
		"pi-auth",
	);

	assert.equal(report.source, "pi-auth");
	assert.equal(report.planType, "pro_lite");
	assert.equal(report.snapshots.length, 2);
	assert.equal(report.snapshots[0]?.primary?.windowMinutes, 300);
	assert.equal(report.snapshots[1]?.limitId, "gpt-5.3-codex-spark");
	assert.deepEqual(report.resetCredits, { availableCount: 3 });
});

test("normalizeBackendPayload accepts a reset-credit-only usage response", () => {
	const report = normalizeBackendPayload(
		{
			plan_type: "plus",
			rate_limit_reset_credits: { available_count: "2" },
		},
		1500,
		"pi-auth",
	);

	assert.deepEqual(report.snapshots, []);
	assert.deepEqual(report.resetCredits, { availableCount: 2 });
	assert.match(formatCodexUsageReport(report), /Usage limit resets:\s+2 available/);
});

test("normalizeBackendPayload skips malformed optional additional rate limits", () => {
	const report = normalizeBackendPayload(
		{
			plan_type: "plus",
			rate_limit: { primary_window: { used_percent: 25 } },
			rate_limit_reset_credits: { available_count: 1 },
			additional_rate_limits: [null, { metered_feature: "broken", rate_limit: "not-an-object" }],
		},
		1750,
		"pi-auth",
	);

	assert.equal(report.snapshots.length, 1);
	assert.equal(report.snapshots[0]?.limitId, "codex");
	assert.deepEqual(report.resetCredits, { availableCount: 1 });
});

test("normalizeAppServerResponse merges duplicate snapshots by limit id", () => {
	const report = normalizeAppServerResponse(
		{
			rateLimits: { limitId: "codex", primary: { usedPercent: 40 }, planType: "team" },
			rateLimitsByLimitId: {
				codex: { limitId: "codex", secondary: { usedPercent: 20, windowDurationMins: 10080 } },
			},
			rateLimitResetCredits: {
				availableCount: 2,
				credits: [
					{
						id: "reset-1",
						resetType: "codexRateLimits",
						status: "available",
						grantedAt: 1_781_654_400,
						expiresAt: 1_784_246_400,
						title: "Full reset (Weekly + 5 hr)",
						description: "Ready to redeem",
					},
				],
			},
		},
		2000,
	);

	assert.equal(report.source, "codex-app-server");
	assert.equal(report.snapshots.length, 1);
	assert.equal(report.snapshots[0]?.primary?.usedPercent, 40);
	assert.equal(report.snapshots[0]?.secondary?.windowMinutes, 10080);
	assert.deepEqual(report.resetCredits, {
		availableCount: 2,
		credits: [
			{
				id: "reset-1",
				resetType: "codexRateLimits",
				status: "available",
				grantedAt: 1_781_654_400,
				expiresAt: 1_784_246_400,
				title: "Full reset (Weekly + 5 hr)",
				description: "Ready to redeem",
			},
		],
	});
});

test("normalizeAppServerResponse skips malformed optional buckets", () => {
	const malformedEntry = normalizeAppServerResponse(
		{
			rateLimits: { limitId: "codex", primary: { usedPercent: 40 } },
			rateLimitsByLimitId: {
				broken: "not-an-object",
			},
			rateLimitResetCredits: { availableCount: 1 },
		},
		2250,
	);
	const arrayInsteadOfMap = normalizeAppServerResponse(
		{
			rateLimits: { limitId: "codex", primary: { usedPercent: 40 } },
			rateLimitsByLimitId: [{ primary: { usedPercent: 10 } }],
		},
		2300,
	);

	assert.equal(malformedEntry.snapshots.length, 1);
	assert.equal(malformedEntry.snapshots[0]?.limitId, "codex");
	assert.deepEqual(malformedEntry.resetCredits, { availableCount: 1 });
	assert.equal(arrayInsteadOfMap.snapshots.length, 1);
});

test("normalizeAppServerResponse distinguishes empty from malformed reset-credit details", () => {
	const empty = normalizeAppServerResponse(
		{
			rateLimits: { limitId: "codex", primary: { usedPercent: 40 } },
			rateLimitResetCredits: { availableCount: 0, credits: [] },
		},
		2500,
	);
	const malformed = normalizeAppServerResponse(
		{
			rateLimits: { limitId: "codex", primary: { usedPercent: 40 } },
			rateLimitResetCredits: { availableCount: 2, credits: [null, { id: "" }] },
		},
		2750,
	);
	const capped = normalizeAppServerResponse(
		{
			rateLimits: { limitId: "codex", primary: { usedPercent: 40 } },
			rateLimitResetCredits: {
				availableCount: 1,
				credits: [{ id: "reset-1" }, { id: "reset-2" }],
			},
		},
		3000,
	);

	assert.deepEqual(empty.resetCredits, { availableCount: 0, credits: [] });
	assert.deepEqual(malformed.resetCredits, { availableCount: 2 });
	assert.deepEqual(capped.resetCredits, {
		availableCount: 1,
		credits: [{ id: "reset-1" }],
	});
});

test("normalizers keep required primary snapshots strict", () => {
	assert.throws(
		() =>
			normalizeBackendPayload(
				{
					rate_limit: "not-an-object",
					rate_limit_reset_credits: { available_count: 1 },
				},
				3250,
				"pi-auth",
			),
		/rate limit was not an object/,
	);
	assert.throws(
		() =>
			normalizeAppServerResponse(
				{
					rateLimits: "not-an-object",
					rateLimitResetCredits: { availableCount: 1 },
				},
				3500,
			),
		/app-server rate-limit snapshot was not an object/,
	);
});

test("scheduled statusline refresh ignores stale extension contexts", async (t) => {
	// Node pairs clearTimeout with mocked setTimeout; clearTimeout is not a valid apis entry.
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const originalFetch = globalThis.fetch;
	t.after(() => {
		globalThis.fetch = originalFetch;
	});
	globalThis.fetch = async () =>
		new Response(
			JSON.stringify({
				plan_type: "pro_lite",
				rate_limit: { primary_window: { used_percent: 25 } },
			}),
			{ status: 200 },
		);

	const mock = createMockPi();
	codexUsage(mock.pi);
	const model = { id: "gpt-5.3-codex", name: "GPT-5.3 Codex", provider: "openai-codex" };
	const { ctx, statuses } = createMockContext({
		model,
		modelRegistry: {
			getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "test-token" }),
			getAvailable: () => [],
			getAll: () => [],
		},
	});

	mock.events.get("session_start")?.[0]?.({}, ctx);
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.equal(statuses.get("codex-usage"), "codex 75% 5h");

	let staleModelRegistryReads = 0;
	const staleError = new Error(
		"This extension ctx is stale after session replacement or reload. Do not use a captured pi or command ctx after ctx.newSession(), ctx.fork(), ctx.switchSession(), or ctx.reload().",
	);
	Object.defineProperty(ctx, "modelRegistry", {
		configurable: true,
		get() {
			staleModelRegistryReads += 1;
			throw staleError;
		},
	});

	t.mock.timers.tick(5 * 60 * 1000);
	await Promise.resolve();
	await Promise.resolve();
	assert.equal(staleModelRegistryReads, 1);
});

test("stale refresh errors do not cancel newer session refresh timers", async (t) => {
	// Node pairs clearTimeout with mocked setTimeout; clearTimeout is not a valid apis entry.
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const originalFetch = globalThis.fetch;
	t.after(() => {
		globalThis.fetch = originalFetch;
	});

	let fetches = 0;
	globalThis.fetch = async () => {
		fetches += 1;
		return new Response(
			JSON.stringify({
				plan_type: "pro_lite",
				rate_limit: { primary_window: { used_percent: fetches === 1 ? 25 : 50 } },
			}),
			{ status: 200 },
		);
	};

	const mock = createMockPi();
	codexUsage(mock.pi);
	const model = { id: "gpt-5.3-codex", name: "GPT-5.3 Codex", provider: "openai-codex" };
	let rejectOldAuth: (error: Error) => void = () => undefined;
	const oldAuth = new Promise<never>((_resolve, reject) => {
		rejectOldAuth = reject;
	});
	const staleError = new Error(
		"This extension ctx is stale after session replacement or reload. Do not use a captured pi or command ctx after ctx.newSession(), ctx.fork(), ctx.switchSession(), or ctx.reload().",
	);
	const { ctx: oldCtx } = createMockContext({
		model,
		modelRegistry: {
			getApiKeyAndHeaders: () => oldAuth,
			getAvailable: () => [],
			getAll: () => [],
		},
	});
	const { ctx: newCtx, statuses } = createMockContext({
		model,
		modelRegistry: {
			getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "test-token" }),
			getAvailable: () => [],
			getAll: () => [],
		},
	});

	mock.events.get("session_start")?.[0]?.({}, oldCtx);
	mock.events.get("session_start")?.[0]?.({}, newCtx);
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.equal(statuses.get("codex-usage"), "codex 75% 5h");

	rejectOldAuth(staleError);
	await Promise.resolve();
	await Promise.resolve();

	t.mock.timers.tick(5 * 60 * 1000);
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.equal(statuses.get("codex-usage"), "codex 50% 5h");
});

test("stale command statusline writes are ignored", async (t) => {
	const originalFetch = globalThis.fetch;
	t.after(() => {
		globalThis.fetch = originalFetch;
	});
	globalThis.fetch = async () =>
		new Response(
			JSON.stringify({
				plan_type: "pro_lite",
				rate_limit: { primary_window: { used_percent: 25 } },
			}),
			{ status: 200 },
		);

	const mock = createMockPi();
	codexUsage(mock.pi);
	const command = mock.commands.get("codex-status");
	assert.ok(command);
	const staleError = new Error("This extension ctx is stale after session replacement or reload.");
	const model = { id: "gpt-5.3-codex", name: "GPT-5.3 Codex", provider: "openai-codex" };
	const { ctx } = createMockContext({
		model,
		modelRegistry: {
			getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "test-token" }),
			getAvailable: () => [],
			getAll: () => [],
		},
		ui: {
			notify: () => undefined,
			setStatus: () => {
				throw staleError;
			},
		},
	});

	await command.handler("", ctx);
});

test("stale command query failures are ignored", async () => {
	const mock = createMockPi();
	codexUsage(mock.pi);
	const command = mock.commands.get("codex-status");
	assert.ok(command);
	const staleError = new Error("This extension ctx is stale after session replacement or reload.");
	const model = { id: "gpt-5.3-codex", name: "GPT-5.3 Codex", provider: "openai-codex" };
	const { ctx } = createMockContext({
		model,
		modelRegistry: {
			getApiKeyAndHeaders: async () => {
				throw staleError;
			},
			getAvailable: () => [],
			getAll: () => [],
		},
	});

	await command.handler("", ctx);
});

test("stale command statusline writes do not cancel newer session refresh timers", async (t) => {
	// Node pairs clearTimeout with mocked setTimeout; clearTimeout is not a valid apis entry.
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const originalFetch = globalThis.fetch;
	t.after(() => {
		globalThis.fetch = originalFetch;
	});

	let fetches = 0;
	globalThis.fetch = async () => {
		fetches += 1;
		return new Response(
			JSON.stringify({
				plan_type: "pro_lite",
				rate_limit: { primary_window: { used_percent: fetches === 1 ? 25 : 50 } },
			}),
			{ status: 200 },
		);
	};

	const mock = createMockPi();
	codexUsage(mock.pi);
	const command = mock.commands.get("codex-status");
	assert.ok(command);
	const model = { id: "gpt-5.3-codex", name: "GPT-5.3 Codex", provider: "openai-codex" };
	const { ctx: newCtx, statuses } = createMockContext({
		model,
		modelRegistry: {
			getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "test-token" }),
			getAvailable: () => [],
			getAll: () => [],
		},
	});

	mock.events.get("session_start")?.[0]?.({}, newCtx);
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.equal(statuses.get("codex-usage"), "codex 75% 5h");

	const staleError = new Error(
		"This extension ctx is stale after session replacement or reload. Do not use a captured pi or command ctx after ctx.newSession(), ctx.fork(), ctx.switchSession(), or ctx.reload().",
	);
	const { ctx: staleCtx } = createMockContext({
		model,
		ui: {
			notify: () => undefined,
			setStatus: () => {
				throw staleError;
			},
		},
	});

	await command.handler("", staleCtx);
	t.mock.timers.tick(5 * 60 * 1000);
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.equal(statuses.get("codex-usage"), "codex 50% 5h");
});

test("isStaleExtensionContextError recognizes Pi stale-context failures", () => {
	assert.equal(
		isStaleExtensionContextError(
			new Error("This extension ctx is stale after session replacement or reload."),
		),
		true,
	);
	assert.equal(isStaleExtensionContextError(new Error("network failed")), false);
});

test("formatters label a primary weekly window from its reported duration", () => {
	const report: CodexUsageReport = {
		source: "pi-auth",
		capturedAt: 0,
		snapshots: [
			{
				limitId: "codex",
				primary: { usedPercent: 16, windowMinutes: 10_080 },
			},
		],
	};

	assert.match(formatCodexUsageReport(report), /Weekly limit:/);
	assert.doesNotMatch(formatCodexUsageReport(report), /5h limit:/);
	assert.equal(formatCodexUsageStatusline(report), "codex 84% wk");
});

test("formatters render report text and model-specific statusline buckets", () => {
	const report: CodexUsageReport = {
		source: "pi-auth",
		capturedAt: 0,
		resetCredits: { availableCount: 2 },
		snapshots: [
			{ limitId: "codex", primary: { usedPercent: 60 }, secondary: { usedPercent: 80 } },
			{ limitId: "gpt-5.3-codex-spark", primary: { usedPercent: 10 } },
		],
	};

	assert.match(formatCodexUsageReport(report), /5h limit:/);
	assert.match(formatCodexUsageReport(report), /Usage limit resets:\s+2 available/);
	assert.equal(
		formatCodexUsageStatusline(report, {
			id: "gpt-5.3-codex-spark",
			name: "GPT-5.3 Codex Spark",
			provider: "openai-codex",
		}),
		"codex spark 90% 5h",
	);
	assert.equal(formatCodexUsageStatusline(report), "codex 40% 5h 20% wk");
});
