import assert from "node:assert/strict";
import { test } from "vitest";
import {
	CODEX_PRIORITY_MODEL_IDS,
	correctOpenAIServiceTierMessageCost,
	OPENAI_FLEX_MODEL_IDS,
	openAIServiceTierStatusLabel,
	rewriteOpenAIServiceTierPayload,
	serviceTierAvailability,
	serviceTierRequestTier,
	serviceTierSupport,
} from "../src/openai-service-tier.js";

const model = (id = "gpt-5.4", overrides: Record<string, unknown> = {}) => ({
	id,
	name: id,
	api: "openai-codex-responses",
	provider: "openai-codex",
	baseUrl: "https://chatgpt.com/backend-api",
	reasoning: true,
	input: ["text"],
	cost: { input: 2.5, output: 15, cacheRead: 0.25, cacheWrite: 0 },
	contextWindow: 1_000_000,
	maxTokens: 128_000,
	...overrides,
});

const openAIModel = (id = "gpt-5.4", overrides: Record<string, unknown> = {}) =>
	model(id, {
		provider: "openai",
		api: "openai-responses",
		baseUrl: "https://api.openai.com/v1",
		...overrides,
	});

const usage = {
	input: 100,
	output: 20,
	cacheRead: 10,
	cacheWrite: 0,
	totalTokens: 130,
	cost: { input: 0.00025, output: 0.0003, cacheRead: 0.0000025, cacheWrite: 0, total: 0.0005525 },
};

test("the supported Codex priority model set is explicit", () => {
	assert.deepEqual([...CODEX_PRIORITY_MODEL_IDS].sort(), [
		"gpt-5.4",
		"gpt-5.5",
		"gpt-5.6-luna",
		"gpt-5.6-sol",
		"gpt-5.6-terra",
	]);
	assert.deepEqual(serviceTierSupport(model() as never), ["priority"]);
	assert.equal(serviceTierSupport(model("gpt-5.4-mini") as never).length, 0);
});

test("service-tier eligibility requires official OpenAI or Codex origins", () => {
	assert.deepEqual(serviceTierSupport(openAIModel() as never), ["priority", "flex"]);
	assert.ok(OPENAI_FLEX_MODEL_IDS.has("gpt-5.4"));
	assert.equal(serviceTierAvailability(model() as never, "priority").kind, "available");
	assert.equal(serviceTierAvailability(model() as never, "flex").kind, "unavailable");
	assert.equal(
		serviceTierSupport(
			openAIModel("gpt-5.4", { baseUrl: "https://proxy.example.test/v1" }) as never,
		).length,
		0,
	);
});

test("request rewriting uses the selected tier and leaves unsupported OpenAI models alone", () => {
	assert.equal(serviceTierRequestTier(model() as never, "priority"), "priority");
	assert.equal(serviceTierRequestTier(model() as never, "default"), "default");
	assert.equal(serviceTierRequestTier(model("gpt-5.4-mini") as never, "priority"), "default");
	assert.equal(serviceTierRequestTier(openAIModel("gpt-4") as never, "flex"), undefined);
	assert.deepEqual(
		rewriteOpenAIServiceTierPayload(
			{ model: "gpt-5.4", service_tier: "default" },
			openAIModel() as never,
			"flex",
		),
		{ model: "gpt-5.4", service_tier: "flex" },
	);
	assert.equal(
		rewriteOpenAIServiceTierPayload(
			{ model: "gpt-5.4" },
			openAIModel("gpt-5.4", { baseUrl: "https://proxy.example.test/v1" }) as never,
			"flex",
		),
		undefined,
	);
});

test("service-tier cost correction applies Flex discounts and Priority surcharges", () => {
	const flexMessage = { role: "assistant", provider: "openai", model: "gpt-5.4", usage };
	const correctedFlex = correctOpenAIServiceTierMessageCost(
		flexMessage,
		openAIModel() as never,
		"flex",
	) as { usage: typeof usage };
	assert.equal(correctedFlex.usage.cost.total, usage.cost.total * 0.5);
	assert.equal(flexMessage.usage.cost.total, usage.cost.total);
	assert.equal(
		correctOpenAIServiceTierMessageCost(correctedFlex, openAIModel() as never, "flex"),
		undefined,
	);

	const priorityMessage = { role: "assistant", provider: "openai-codex", model: "gpt-5.4", usage };
	const correctedPriority = correctOpenAIServiceTierMessageCost(
		priorityMessage,
		model() as never,
		"priority",
	) as { usage: typeof usage };
	assert.equal(correctedPriority.usage.cost.total, usage.cost.total * 2);
});

test("status labels show only effective Codex tiers", () => {
	assert.equal(
		openAIServiceTierStatusLabel("codex 80% 5h", model() as never, "priority"),
		"codex priority 80% 5h",
	);
	assert.equal(
		openAIServiceTierStatusLabel("codex 80% 5h", openAIModel() as never, "flex"),
		"codex 80% 5h",
	);
	assert.equal(
		openAIServiceTierStatusLabel("openrouter $10 left", model() as never, "priority"),
		"openrouter $10 left",
	);
});
