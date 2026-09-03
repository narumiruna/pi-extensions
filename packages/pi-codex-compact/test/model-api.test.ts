import assert from "node:assert/strict";
import type { Api, Model } from "@earendil-works/pi-ai";
import { describe, test } from "vitest";
import { resolveCompactionRoute, usesResponsesCompactionApi } from "../src/model-api.js";

function model(api: Api, provider = "custom"): Model<Api> {
	return {
		id: "gpt-5.4",
		name: "GPT-5.4",
		api,
		provider,
		baseUrl: "https://example.test/v1",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 100_000,
		maxTokens: 10_000,
	};
}

describe("Responses compaction route selection", () => {
	test("auto preserves Codex V2 and uses unary compact for OpenAI and Azure", () => {
		assert.deepEqual(
			resolveCompactionRoute(model("openai-codex-responses"), {
				enabled: true,
				protocol: "auto",
			}),
			{ kind: "remote", protocol: "remote-v2", api: "openai-codex-responses" },
		);
		assert.deepEqual(
			resolveCompactionRoute(model("openai-responses"), {
				enabled: true,
				protocol: "auto",
			}),
			{ kind: "remote", protocol: "responses-compact", api: "openai-responses" },
		);
		assert.deepEqual(
			resolveCompactionRoute(model("azure-openai-responses"), {
				enabled: true,
				protocol: "auto",
			}),
			{ kind: "remote", protocol: "responses-compact", api: "azure-openai-responses" },
		);
	});

	test("forced protocols apply to every characterized Responses adapter", () => {
		for (const api of [
			"openai-codex-responses",
			"openai-responses",
			"azure-openai-responses",
		] as const) {
			assert.deepEqual(
				resolveCompactionRoute(model(api, "company-proxy"), {
					enabled: true,
					protocol: "remote-v2",
				}),
				{ kind: "remote", protocol: "remote-v2", api },
			);
			assert.deepEqual(
				resolveCompactionRoute(model(api, "company-proxy"), {
					enabled: true,
					protocol: "responses-compact",
				}),
				{ kind: "remote", protocol: "responses-compact", api },
			);
		}
	});

	test("disabled, missing, and unsupported models stay Pi native", () => {
		assert.deepEqual(
			resolveCompactionRoute(model("openai-responses"), {
				enabled: false,
				protocol: "auto",
			}),
			{ kind: "native", reason: "remote compaction is disabled" },
		);
		assert.deepEqual(resolveCompactionRoute(undefined, { enabled: true, protocol: "auto" }), {
			kind: "native",
			reason: "no active model",
		});
		assert.deepEqual(
			resolveCompactionRoute(model("anthropic-messages"), {
				enabled: true,
				protocol: "remote-v2",
			}),
			{
				kind: "native",
				reason: "API anthropic-messages does not support Responses compaction",
			},
		);
		assert.equal(usesResponsesCompactionApi(model("openai-responses")), true);
		assert.equal(usesResponsesCompactionApi(model("github-copilot")), false);
	});
});
