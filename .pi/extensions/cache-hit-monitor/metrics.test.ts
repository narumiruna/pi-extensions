import assert from "node:assert/strict";
import type { Api, AssistantMessage, Model, ModelCostRates } from "@earendil-works/pi-ai";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { test } from "vitest";
import {
	aggregateCacheSamples,
	collectCacheSamples,
	compareCacheSamples,
	createCacheMonitorView,
	createCacheSample,
	formatMonitorLines,
	sanitizeDisplayLabel,
} from "./metrics.js";

const RATES: ModelCostRates = {
	input: 10,
	output: 20,
	cacheRead: 1,
	cacheWrite: 20,
};
const MODEL: Model<Api> = {
	id: "test-model",
	name: "Test model",
	api: "openai-responses",
	provider: "test-provider",
	baseUrl: "https://example.test",
	reasoning: false,
	input: ["text"],
	cost: RATES,
	contextWindow: 200_000,
	maxTokens: 10_000,
};

function assistant(
	input: number,
	cacheRead: number,
	cacheWrite: number,
	overrides: Partial<AssistantMessage> = {},
): AssistantMessage {
	return {
		role: "assistant",
		api: "openai-responses",
		provider: "test-provider",
		model: "test-model",
		content: [],
		stopReason: "stop",
		timestamp: 1_000,
		usage: {
			input,
			output: 10,
			cacheRead,
			cacheWrite,
			totalTokens: input + cacheRead + cacheWrite + 10,
			cost: {
				input: (input * RATES.input) / 1_000_000,
				output: (10 * RATES.output) / 1_000_000,
				cacheRead: (cacheRead * RATES.cacheRead) / 1_000_000,
				cacheWrite: (cacheWrite * RATES.cacheWrite) / 1_000_000,
				total:
					(input * RATES.input +
						10 * RATES.output +
						cacheRead * RATES.cacheRead +
						cacheWrite * RATES.cacheWrite) /
					1_000_000,
			},
		},
		...overrides,
	};
}

function messageEntry(message: AssistantMessage): SessionEntry {
	return { type: "message", id: crypto.randomUUID(), parentId: null, message } as SessionEntry;
}

test("calculates hit rate, downward loss, re-billed tokens, and estimated cost impact", () => {
	const previous = createCacheSample(assistant(200, 800, 0), 0, MODEL);
	const current = createCacheSample(assistant(400, 600, 100, { timestamp: 3_500 }), 0, MODEL);
	assert.ok(previous);
	assert.ok(current);

	const comparison = compareCacheSamples(previous, current, 1);
	assert.ok(comparison);
	assert.equal(previous.hitRatePercent, 80);
	assert.ok(Math.abs(current.hitRatePercent - 54.545_454) < 0.000_01);
	assert.ok(Math.abs(comparison.hitRateDeltaPercent + 25.454_545) < 0.000_01);
	assert.ok(Math.abs(comparison.hitRateLossPercent - 25.454_545) < 0.000_01);
	assert.equal(comparison.reusablePrefixTokens, 1_000);
	assert.equal(comparison.rebilledTokens, 400);
	assert.equal(comparison.rebilledPercent, 40);
	assert.ok(Math.abs((comparison.estimatedMissPremium ?? 0) - 0.0044) < 0.000_000_1);
	assert.equal(comparison.promptTokenDelta, 100);
	assert.equal(comparison.cacheReadDelta, -200);
	assert.equal(comparison.requestStartGapMs, 2_500);
});

test("requires provider cache evidence and prices a confirmed zero-read miss", () => {
	const completeMiss = assistant(1_000, 0, 0, { timestamp: 2_000 });
	completeMiss.usage.cost = {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		total: 0,
	};
	assert.equal(createCacheSample(completeMiss, 0, MODEL), null);

	const tieredModel: Model<Api> = {
		...MODEL,
		cost: {
			...RATES,
			tiers: [
				{
					inputTokensAbove: 900,
					input: 20,
					output: 40,
					cacheRead: 2,
					cacheWrite: 30,
				},
			],
		},
	};
	const previous = createCacheSample(assistant(200, 800, 0), 0, tieredModel);
	const current = createCacheSample(completeMiss, 0, tieredModel, true);
	assert.ok(previous && current);
	assert.equal(current.hitRatePercent, 0);
	assert.equal(current.estimatedSavings, 0);
	assert.ok(Math.abs((current.cacheReadUnitCost ?? 0) - 0.000_002) < 0.000_000_001);
	assert.ok(
		Math.abs((compareCacheSamples(previous, current, 1)?.estimatedMissPremium ?? 0) - 0.018) <
			0.000_000_1,
	);
	const rendered = formatMonitorLines(createCacheMonitorView([previous, current]))
		.map(({ text }) => text)
		.join("\n");
	assert.match(rendered, /cache saved ~\$0\.0000/);
	assert.match(rendered, /miss premium ~\$0\.018/);
});

test("preserves input pricing for a fully cached request", () => {
	const tieredModel: Model<Api> = {
		...MODEL,
		cost: {
			...RATES,
			tiers: [
				{
					inputTokensAbove: 900,
					input: 20,
					output: 40,
					cacheRead: 2,
					cacheWrite: 30,
				},
			],
		},
	};
	const fullyCached = assistant(0, 1_000, 0);
	fullyCached.usage.cost = {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		total: 0,
	};

	const sample = createCacheSample(fullyCached, 0, tieredModel);
	assert.ok(sample);
	assert.deepEqual(fullyCached.usage.cost, {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		total: 0,
	});
	assert.ok(Math.abs((sample.inputUnitCost ?? 0) - 0.000_02) < 0.000_000_001);
	assert.ok(Math.abs((sample.promptCost ?? 0) - 0.002) < 0.000_000_001);
	assert.ok(Math.abs((sample.estimatedSavings ?? 0) - 0.018) < 0.000_000_001);
	const rendered = formatMonitorLines(createCacheMonitorView([sample]))
		.map(({ text }) => text)
		.join("\n");
	assert.match(rendered, /cache saved ~\$0\.018/);
	assert.match(rendered, /Session {2}1 req.*saved ~\$0\.018/);
});

test("uses weighted session totals and excludes cross-compaction comparisons", () => {
	const first = createCacheSample(assistant(200, 800, 0), 0, MODEL);
	const second = createCacheSample(assistant(400, 600, 100), 0, MODEL);
	const afterCompaction = createCacheSample(assistant(900, 100, 0), 1, MODEL);
	assert.ok(first && second && afterCompaction);

	const aggregate = aggregateCacheSamples([first, second, afterCompaction]);
	assert.equal(aggregate.requestCount, 3);
	assert.equal(aggregate.input, 1_500);
	assert.equal(aggregate.cacheRead, 1_500);
	assert.equal(aggregate.cacheWrite, 100);
	assert.ok(Math.abs((aggregate.hitRatePercent ?? 0) - (1_500 / 3_100) * 100) < 0.000_01);
	assert.equal(aggregate.rebilledTokens, 400);
	assert.ok(Math.abs((aggregate.estimatedMissPremium ?? 0) - 0.0044) < 0.000_000_1);
	assert.equal(compareCacheSamples(second, afterCompaction, 2), null);
});

test("marks a session premium unknown when any nonzero miss lacks pricing", () => {
	const first = createCacheSample(assistant(200, 800, 0), 0, MODEL);
	const unpricedMessage = assistant(400, 600, 100, { timestamp: 2_000 });
	unpricedMessage.usage.cost = {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		total: 0,
	};
	const unpriced = createCacheSample(unpricedMessage, 0);
	const priced = createCacheSample(assistant(500, 500, 0, { timestamp: 3_000 }), 0, MODEL);
	assert.ok(first && unpriced && priced);

	const aggregate = aggregateCacheSamples([first, unpriced, priced]);
	assert.ok(aggregate.rebilledTokens > 0);
	assert.equal(aggregate.estimatedMissPremium, null);
});

test("reconstructs cache epochs and includes summarization usage in session totals", () => {
	const summaryMessage = assistant(100, 900, 0);
	const entries = [
		messageEntry(assistant(200, 800, 0)),
		{
			type: "compaction",
			id: "compact",
			parentId: null,
			usage: summaryMessage.usage,
		},
		{
			type: "branch_summary",
			id: "branch-summary",
			parentId: null,
			usage: summaryMessage.usage,
		},
		messageEntry(assistant(900, 100, 0, { timestamp: 2_000 })),
	] as SessionEntry[];
	const restored = collectCacheSamples(entries, () => MODEL);

	assert.equal(restored.currentEpoch, 2);
	assert.equal(restored.summaryRecords.length, 2);
	assert.deepEqual(
		restored.samples.map(({ epoch, hitRatePercent }) => [epoch, hitRatePercent]),
		[
			[0, 80],
			[2, 10],
		],
	);
	const view = createCacheMonitorView(restored.samples, undefined, {
		activeEpoch: restored.currentEpoch,
		summaryRecords: restored.summaryRecords,
	});
	assert.equal(view.comparison, null);
	assert.equal(view.session.requestCount, 4);
	assert.equal(view.session.input, 1_300);
	assert.equal(view.session.cacheRead, 2_700);
	assert.ok(Math.abs((view.session.promptCost ?? 0) - 0.0157) < 0.000_000_1);
	assert.ok(Math.abs((view.session.estimatedSavings ?? 0) - 0.0243) < 0.000_000_1);
});

test("retains summary usage when cache accounting is unavailable", () => {
	const summaryMessage = assistant(1_000, 0, 0);
	const restored = collectCacheSamples([
		{
			type: "compaction",
			id: "compact",
			parentId: null,
			usage: summaryMessage.usage,
		},
		{
			type: "branch_summary",
			id: "branch-summary",
			parentId: null,
			usage: summaryMessage.usage,
		},
	] as SessionEntry[]);

	assert.equal(restored.currentEpoch, 2);
	assert.equal(restored.summaryRecords.length, 2);
	assert.ok(restored.summaryRecords.every(({ hitRatePercent }) => hitRatePercent === null));
	const view = createCacheMonitorView([], undefined, {
		summaryRecords: restored.summaryRecords,
	});
	assert.equal(view.session.requestCount, 2);
	assert.equal(view.session.input, 2_000);
	assert.equal(view.session.promptTokens, 2_000);
	assert.equal(view.session.hitRatePercent, null);
	assert.ok(Math.abs((view.session.promptCost ?? 0) - 0.02) < 0.000_000_001);
	assert.equal(view.session.estimatedSavings, null);
	const rendered = formatMonitorLines(view)
		.map(({ text }) => text)
		.join("\n");
	assert.match(rendered, /summary usage only/);
	assert.match(rendered, /Session {2}2 req.*hit n\/a.*uncached 2k.*cost \$0\.020.*saved ~n\/a/);
});

test("does not reconstruct all-zero usage as a miss without provider evidence", () => {
	const supportedProviderMiss = assistant(1_000, 0, 0, {
		provider: "test-provider",
		timestamp: 2_000,
	});
	const unsupportedProviderUsage = assistant(1_000, 0, 0, {
		provider: "other-provider",
		timestamp: 3_000,
	});
	const restored = collectCacheSamples(
		[
			messageEntry(assistant(200, 800, 0)),
			messageEntry(supportedProviderMiss),
			messageEntry(unsupportedProviderUsage),
		],
		() => MODEL,
	);

	assert.deepEqual(
		restored.samples.map(({ provider, hitRatePercent }) => [provider, hitRatePercent]),
		[
			["test-provider", 80],
			["test-provider", 0],
		],
	);
});

test("renders session totals when a branch contains only summary usage", () => {
	const summaryMessage = assistant(100, 900, 0);
	const restored = collectCacheSamples([
		{
			type: "branch_summary",
			id: "branch-summary",
			parentId: null,
			usage: summaryMessage.usage,
		},
	] as SessionEntry[]);
	const lines = formatMonitorLines(
		createCacheMonitorView([], undefined, { summaryRecords: restored.summaryRecords }),
	).map(({ text }) => text);

	assert.match(lines[0] ?? "", /summary usage only/);
	assert.match(lines[1] ?? "", /Session {2}1 req.*hit 90\.0%.*read 900.*uncached 100/);
	assert.match(lines[2] ?? "", /Latest request metrics are unavailable/);
});

test("suppresses a pre-boundary comparison until the active epoch receives usage", () => {
	const first = createCacheSample(assistant(200, 800, 0), 0, MODEL);
	const second = createCacheSample(assistant(400, 600, 0, { timestamp: 2_000 }), 0, MODEL);
	assert.ok(first && second);

	assert.ok(createCacheMonitorView([first, second], undefined, { activeEpoch: 0 }).comparison);
	assert.equal(
		createCacheMonitorView([first, second], undefined, { activeEpoch: 1 }).comparison,
		null,
	);
});

test("keeps raw model identities for comparison and sanitizes only rendered labels", () => {
	const sharedPrefix = "x".repeat(70);
	const previous = createCacheSample(
		assistant(200, 800, 0, { provider: `${sharedPrefix}a` }),
		0,
		MODEL,
	);
	const current = createCacheSample(
		assistant(200, 800, 0, { provider: `${sharedPrefix}b`, timestamp: 2_000 }),
		0,
		MODEL,
	);
	assert.ok(previous && current);

	assert.notEqual(previous.provider, current.provider);
	assert.equal(sanitizeDisplayLabel(previous.provider), sanitizeDisplayLabel(current.provider));
	assert.equal(compareCacheSamples(previous, current, 1)?.modelChanged, true);
});

test("uses model rates when reported prompt-cost components are unavailable", () => {
	const message = assistant(200, 800, 100);
	message.usage.cost = {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		total: 0,
	};

	const sample = createCacheSample(message, 0, MODEL);
	assert.ok(sample);
	assert.ok(Math.abs((sample.promptCost ?? 0) - 0.0048) < 0.000_000_1);
});

test("applies Pi pricing tiers and one-hour cache-write rates to fallbacks", () => {
	const tieredModel: Model<Api> = {
		...MODEL,
		cost: {
			...RATES,
			tiers: [
				{
					inputTokensAbove: 1_000,
					input: 20,
					output: 40,
					cacheRead: 2,
					cacheWrite: 30,
				},
			],
		},
	};
	const previousMessage = assistant(200, 1_000, 0);
	previousMessage.usage.cost = {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		total: 0,
	};
	const currentMessage = assistant(200, 800, 200, { timestamp: 2_000 });
	currentMessage.usage.cacheWrite1h = 100;
	currentMessage.usage.cost = {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		total: 0,
	};

	const previous = createCacheSample(previousMessage, 0, tieredModel);
	const current = createCacheSample(currentMessage, 0, tieredModel);
	assert.ok(previous && current);
	assert.deepEqual(currentMessage.usage.cost, {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		total: 0,
	});
	assert.ok(Math.abs((current.promptCost ?? 0) - 0.0126) < 0.000_000_1);
	assert.ok(Math.abs((current.estimatedSavings ?? 0) - 0.0144) < 0.000_000_1);
	assert.ok(
		Math.abs((compareCacheSamples(previous, current, 1)?.estimatedMissPremium ?? 0) - 0.0102) <
			0.000_000_1,
	);
});

test("formats a detailed live report with both rate and token loss", () => {
	const previous = createCacheSample(assistant(200, 800, 0), 0, MODEL);
	const current = createCacheSample(assistant(400, 600, 100, { timestamp: 3_500 }), 0, MODEL);
	assert.ok(previous && current);
	const lines = formatMonitorLines(createCacheMonitorView([previous], current)).map(
		({ text }) => text,
	);

	assert.match(lines[0] ?? "", /Prompt cache · LIVE · request #2/);
	assert.match(lines[1] ?? "", /hit 54\.5%.*Δ -25\.5 pp.*loss 25\.5 pp.*uncached 36\.4%/);
	assert.match(lines[2] ?? "", /prompt 1\.1k.*read 600.*write 100.*uncached 400/);
	assert.match(
		lines[3] ?? "",
		/eligible 1k.*re-billed 400 \(40\.0%\).*read Δ -200.*start gap 2\.5s/,
	);
	assert.match(lines[4] ?? "", /cache saved ~\$0\.0054.*miss premium ~\$0\.0044/);
	assert.match(lines[5] ?? "", /Session {2}2 req.*re-billed 400/);
	assert.match(lines[6] ?? "", /80\.0% → 54\.5%/);
	assert.match(lines[7] ?? "", /re-billed=max/);
});

test("sanitizes terminal controls and bounds provider/model labels", () => {
	assert.equal(sanitizeDisplayLabel("\u001b]8;;bad\u0007provider\n\u202emodel"), "provider model");
	assert.equal(sanitizeDisplayLabel("\u001b\u0007"), "unknown");
	assert.equal(sanitizeDisplayLabel("x".repeat(80)), `${"x".repeat(60)}…`);
});
