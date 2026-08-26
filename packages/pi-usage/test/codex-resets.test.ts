import assert from "node:assert/strict";
import { test } from "vitest";
import { createMockContext } from "../../../test/support.js";
import { formatCodexResetOutcome } from "../src/codex-resets.js";
import {
	consumeCodexResetCredit,
	listCodexResetCredits,
	normalizeCodexResetCreditsPayload,
	type ResolvedUsageAuth,
	resolveCodexResetAuth,
} from "../src/index.js";

const activeCodexToken = codexAccessToken("account-123");

const codexModel = {
	id: "gpt-5.3-codex",
	name: "GPT-5.3 Codex",
	provider: "openai-codex",
	baseUrl: "https://chatgpt.com/backend-api",
};

function resolvedAuth(): ResolvedUsageAuth {
	return {
		apiKey: "active-token",
		headers: {
			Authorization: "Bearer active-token",
			"chatgpt-account-id": "account-123",
		},
		fingerprint: "fingerprint",
		secrets: ["active-token", "Bearer active-token", "account-123"],
		model: codexModel as never,
	};
}

test("Codex reset auth requires the current matching Pi OAuth account", async () => {
	const { ctx } = createMockContext({
		model: codexModel,
		modelRegistry: {
			getApiKeyAndHeaders: async () => ({ ok: true, apiKey: activeCodexToken }),
			getProviderAuth: async () => ({ auth: { apiKey: activeCodexToken } }),
			getAvailable: () => [codexModel],
			getAll: () => [codexModel],
		},
	});
	const credential = () => ({
		type: "oauth" as const,
		access: activeCodexToken,
		refresh: "refresh-token",
		expires: Date.now() + 60_000,
		accountId: "account-123",
	});

	const auth = await resolveCodexResetAuth(ctx, new Uint8Array(32), credential);
	assert.deepEqual(auth.headers, {
		Authorization: `Bearer ${activeCodexToken}`,
		"chatgpt-account-id": "account-123",
	});
	assert.ok(auth.secrets.includes("account-123"));

	const namedAuth = await resolveCodexResetAuth(
		ctx,
		new Uint8Array(32),
		() => ({ ...credential(), access: "default-token" }),
		() => ({ ok: true, candidates: [credential()] }),
	);
	assert.equal(namedAuth.headers["chatgpt-account-id"], "account-123");
	const duplicate = await resolveCodexResetAuth(
		ctx,
		new Uint8Array(32),
		() => undefined,
		() => ({ ok: true, candidates: [credential(), structuredClone(credential())] }),
	);
	assert.equal(duplicate.fingerprint, namedAuth.fingerprint);
	for (const candidates of [
		[credential(), { ...credential(), refresh: "another-refresh" }],
		[{ ...credential(), refresh: "another-refresh" }, credential()],
	]) {
		await assert.rejects(
			() =>
				resolveCodexResetAuth(
					ctx,
					new Uint8Array(32),
					() => undefined,
					() => ({
						ok: true,
						candidates,
					}),
				),
			/conflicting/iu,
		);
	}
	await assert.rejects(
		() =>
			resolveCodexResetAuth(
				ctx,
				new Uint8Array(32),
				() => undefined,
				() => ({
					ok: false,
				}),
			),
		/failed closed/iu,
	);
	await assert.rejects(
		() =>
			resolveCodexResetAuth(
				ctx,
				new Uint8Array(32),
				() => undefined,
				() => ({
					ok: true,
					candidates: [{ ...credential(), accountId: "another-account" }],
				}),
			),
		/account ID/iu,
	);

	await assert.rejects(
		() =>
			resolveCodexResetAuth(ctx, new Uint8Array(32), () => ({
				...credential(),
				access: "another-token",
			})),
		/does not match/iu,
	);
	await assert.rejects(
		() =>
			resolveCodexResetAuth(ctx, new Uint8Array(32), () => ({
				type: "api_key",
				key: "active-token",
			})),
		/OAuth/iu,
	);

	const { ctx: configuredOnly } = createMockContext({
		model: { ...codexModel, provider: "openrouter", baseUrl: "https://openrouter.ai/api/v1" },
		modelRegistry: {
			getProviderAuth: async () => ({ auth: { apiKey: "active-token" } }),
			getAvailable: () => [codexModel],
			getAll: () => [codexModel],
		},
	});
	await assert.rejects(
		() => resolveCodexResetAuth(configuredOnly, new Uint8Array(32), credential),
		/current.*Codex/iu,
	);
});

function codexAccessToken(accountId: string): string {
	const payload = Buffer.from(
		JSON.stringify({
			"https://api.openai.com/auth": { chatgpt_account_id: accountId },
		}),
	).toString("base64url");
	return `header.${payload}.signature`;
}

test("Codex reset details normalize safe available options in expiration order", () => {
	const availability = normalizeCodexResetCreditsPayload({
		credits: [
			{
				id: "credit-later",
				reset_type: "codex_rate_limits",
				status: "available",
				granted_at: "2026-06-18T00:00:00Z",
				expires_at: "2026-08-18T00:00:00Z",
				title: "Later\u001b[31m reset",
				description: "Reset\nweekly and 5h limits",
			},
			{
				id: "credit-used",
				reset_type: "codex_rate_limits",
				status: "redeemed",
				granted_at: "2026-06-17T00:00:00Z",
				expires_at: "2026-07-17T00:00:00Z",
			},
			{
				id: "credit-sooner",
				reset_type: "codex_rate_limits",
				status: "available",
				granted_at: "2026-06-17T00:00:00Z",
				expires_at: "2026-07-17T00:00:00Z",
			},
		],
		available_count: 2,
		total_earned_count: 4,
	});

	assert.equal(availability.availableCount, 2);
	assert.deepEqual(
		availability.options.map((option) => option.creditId),
		["credit-sooner", "credit-later"],
	);
	assert.equal(availability.options[0]?.title, "Full reset");
	assert.equal(availability.options[1]?.title, "Later reset");
	assert.equal(availability.options[1]?.description, "Reset weekly and 5h limits");
	assert.equal(availability.options[0]?.expiresAt, 1_784_246_400);

	const summaryOnly = normalizeCodexResetCreditsPayload({ available_count: 3 });
	assert.deepEqual(summaryOnly.options, [
		{
			title: "Full reset",
			description: "Reset your current usage limits.",
		},
	]);
	assert.throws(
		() => normalizeCodexResetCreditsPayload({ available_count: -1 }),
		/available_count/iu,
	);
});

test("Codex reset outcomes distinguish success, idempotency, and unavailable states", () => {
	assert.equal(
		formatCodexResetOutcome({ code: "reset", windowsReset: 2 }, 1),
		"Usage reset. You have 1 usage limit reset left.",
	);
	assert.equal(
		formatCodexResetOutcome({ code: "already_redeemed", windowsReset: 0 }, 0),
		"Usage reset was already completed. You have 0 usage limit resets left.",
	);
	assert.equal(
		formatCodexResetOutcome({ code: "nothing_to_reset", windowsReset: 0 }, 2),
		"Your usage does not need a reset right now.",
	);
	assert.equal(
		formatCodexResetOutcome({ code: "no_credit", windowsReset: 0 }, 0),
		"No usage limit resets are available.",
	);
});

test("Codex reset requests use exact ChatGPT paths, account headers, and payloads", async (t) => {
	const originalFetch = globalThis.fetch;
	t.onTestFinished(() => {
		globalThis.fetch = originalFetch;
	});
	const requests: Array<{ url: string; init?: RequestInit }> = [];
	globalThis.fetch = async (input, init) => {
		requests.push({ url: String(input), init });
		if (init?.method === "POST") {
			return new Response(JSON.stringify({ code: "reset", windows_reset: 2 }), { status: 200 });
		}
		return new Response(JSON.stringify({ credits: [], available_count: 0 }), { status: 200 });
	};
	const controller = new AbortController();

	const availability = await listCodexResetCredits(resolvedAuth(), controller.signal, 1_000);
	assert.equal(availability.availableCount, 0);
	const outcome = await consumeCodexResetCredit(
		resolvedAuth(),
		{ creditId: "credit-123", title: "Full reset", description: "Reset limits" },
		"redeem-123",
		controller.signal,
		1_000,
	);
	assert.deepEqual(outcome, { code: "reset", windowsReset: 2 });

	assert.equal(requests[0]?.url, "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits");
	assert.equal(requests[0]?.init?.method, "GET");
	assert.equal(
		requests[1]?.url,
		"https://chatgpt.com/backend-api/wham/rate-limit-reset-credits/consume",
	);
	assert.equal(requests[1]?.init?.method, "POST");
	assert.deepEqual(JSON.parse(String(requests[1]?.init?.body)), {
		redeem_request_id: "redeem-123",
		credit_id: "credit-123",
	});
	const headers = new Headers(requests[1]?.init?.headers);
	assert.equal(headers.get("authorization"), "Bearer active-token");
	assert.equal(headers.get("chatgpt-account-id"), "account-123");
	assert.equal(headers.get("content-type"), "application/json");
});

test("Codex reset consume recognizes every backend outcome and rejects unknown values", async (t) => {
	const originalFetch = globalThis.fetch;
	t.onTestFinished(() => {
		globalThis.fetch = originalFetch;
	});
	for (const code of ["reset", "nothing_to_reset", "no_credit", "already_redeemed"] as const) {
		globalThis.fetch = async () =>
			new Response(JSON.stringify({ code, windows_reset: 0 }), { status: 200 });
		const outcome = await consumeCodexResetCredit(
			resolvedAuth(),
			{ title: "Full reset", description: "Reset limits" },
			"same-logical-attempt",
			new AbortController().signal,
			1_000,
		);
		assert.equal(outcome.code, code);
	}

	globalThis.fetch = async () =>
		new Response(JSON.stringify({ code: "surprise", windows_reset: 0 }), { status: 200 });
	await assert.rejects(
		() =>
			consumeCodexResetCredit(
				resolvedAuth(),
				{ title: "Full reset", description: "Reset limits" },
				"redeem-unknown",
				new AbortController().signal,
				1_000,
			),
		/outcome|code/iu,
	);
});
