import assert from "node:assert/strict";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import { type Api, createAssistantMessageEventStream, type Model, type Usage } from "@earendil-works/pi-ai";
import type { CompactionResult } from "@earendil-works/pi-coding-agent";
import { test } from "vitest";
import { createMockContext } from "../../../test/support.js";
import type { HistoryUnit, HistoryUnitSource } from "../src/history-units.js";
import { type PiCompactionPreparation, type PiNativeCompactor, summarizeWithPiNativeCompact } from "../src/summary.js";

const model = {
  provider: "provider",
  api: "openai-responses",
  id: "active-model",
  maxTokens: 8_000,
  reasoning: true,
} as Model<Api>;

const usage: Usage = {
  input: 10,
  output: 4,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 14,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function unit(index = 0, content = "selected fact", source: HistoryUnitSource = "history"): HistoryUnit {
  return {
    id: `unit-${index}`,
    order: index,
    kind: "assistant-text",
    source,
    label: "Assistant",
    content,
  };
}

function preparation(): PiCompactionPreparation {
  return {
    firstKeptEntryId: "kept",
    messagesToSummarize: [],
    turnPrefixMessages: [],
    isSplitTurn: false,
    tokensBefore: 12_345,
    previousSummary: "Earlier compressed work",
    fileOps: {
      read: new Set(["src/read.ts"]),
      written: new Set<string>(),
      edited: new Set(["src/changed.ts"]),
    },
    settings: { enabled: true, reserveTokens: 10_000, keepRecentTokens: 20_000 },
  };
}

type SummaryOptions = Parameters<typeof summarizeWithPiNativeCompact>[1];

function summaryOptions(overrides: Partial<SummaryOptions> = {}): SummaryOptions {
  return {
    model,
    thinkingLevel: "high",
    selectedUnits: [unit()],
    preparation: preparation(),
    customInstructions: "Focus on the parser",
    signal: new AbortController().signal,
    isCurrent: () => true,
    ...overrides,
  };
}

function compactResult(summary = "Pi-native compact summary"): CompactionResult {
  return {
    summary,
    firstKeptEntryId: "kept",
    tokensBefore: 12_345,
    usage,
    details: { readFiles: ["src/read.ts"], modifiedFiles: ["src/changed.ts"] },
  };
}

function provider(streamSimple: StreamFn = () => ({}) as never) {
  return { streamSimple };
}

test("passes only JEV-selected context through Pi's resolved provider and native compact function", async () => {
  let observed: Parameters<PiNativeCompactor>[0] | undefined;
  let streamedModel: Model<Api> | undefined;
  const providerStreamResult = {};
  const { ctx } = createMockContext({
    model,
    modelRegistry: {
      async getApiKeyAndHeaders(currentModel: unknown) {
        assert.equal(currentModel, model);
        return {
          ok: true,
          apiKey: "provider-key",
          headers: { "x-provider": "header", "x-removed": null },
          baseUrl: "https://resolved.example/v1",
          env: { PROVIDER_MODE: "test" },
        };
      },
      getProvider(providerId: string) {
        assert.equal(providerId, model.provider);
        return provider((requestModel) => {
          streamedModel = requestModel;
          return providerStreamResult as never;
        });
      },
    },
  });
  const runCompact: PiNativeCompactor = async (request) => {
    observed = request;
    assert.equal(request.streamFn(request.model, {} as never), providerStreamResult);
    return compactResult();
  };

  const result = await summarizeWithPiNativeCompact(
    ctx,
    summaryOptions({
      selectedUnits: [unit(0, "selected history"), unit(1, "selected turn prefix", "turn-prefix")],
    }),
    runCompact,
  );

  assert.equal(observed?.model.id, model.id);
  assert.equal(observed?.model.baseUrl, "https://resolved.example/v1");
  assert.equal(streamedModel, observed?.model);
  assert.equal(observed?.thinkingLevel, "high");
  assert.equal(observed?.customInstructions, "Focus on the parser");
  assert.equal(observed?.apiKey, "provider-key");
  assert.deepEqual(observed?.headers, { "x-provider": "header" });
  assert.deepEqual(observed?.env, { PROVIDER_MODE: "test" });
  const nativePreparation = observed?.preparation;
  assert.equal(nativePreparation?.firstKeptEntryId, "kept");
  assert.equal(nativePreparation?.tokensBefore, 12_345);
  assert.equal(nativePreparation?.previousSummary, "Earlier compressed work");
  assert.equal(nativePreparation?.settings.reserveTokens, 10_000);
  assert.equal(nativePreparation?.isSplitTurn, true);
  assert.equal(nativePreparation?.messagesToSummarize.length, 1);
  assert.equal(nativePreparation?.turnPrefixMessages.length, 1);
  assert.match(JSON.stringify(nativePreparation?.messagesToSummarize), /selected history/u);
  assert.doesNotMatch(JSON.stringify(nativePreparation?.messagesToSummarize), /selected turn prefix/u);
  assert.match(JSON.stringify(nativePreparation?.turnPrefixMessages), /selected turn prefix/u);
  assert.deepEqual(result, { text: "Pi-native compact summary", usage });
});

test("the default native compact path consumes the resolved provider stream", async () => {
  let streamCalls = 0;
  const { ctx } = createMockContext({
    modelRegistry: {
      async getApiKeyAndHeaders() {
        return { ok: true, apiKey: "provider-key", baseUrl: "https://resolved.example/v1" };
      },
      getProvider: () =>
        provider((requestModel, context, options) => {
          streamCalls += 1;
          assert.equal(requestModel.baseUrl, "https://resolved.example/v1");
          assert.equal(options?.apiKey, "provider-key");
          assert.match(JSON.stringify(context.messages), /selected fact/u);
          const stream = createAssistantMessageEventStream();
          stream.end({
            role: "assistant",
            content: [{ type: "text", text: "summary from composed provider" }],
            api: requestModel.api,
            provider: requestModel.provider,
            model: requestModel.id,
            usage,
            stopReason: "stop",
            timestamp: 1,
          });
          return stream;
        }),
    },
  });

  const result = await summarizeWithPiNativeCompact(ctx, summaryOptions());
  assert.equal(streamCalls, 1);
  assert.match(result.text, /summary from composed provider/u);
});

test("prefix-only selection explicitly carries the previous summary through native compact", async () => {
  const prompts: string[] = [];
  const { ctx } = createMockContext({
    modelRegistry: {
      async getApiKeyAndHeaders() {
        return { ok: true };
      },
      getProvider: () =>
        provider((requestModel, context) => {
          prompts.push(JSON.stringify(context.messages));
          const stream = createAssistantMessageEventStream();
          stream.end({
            role: "assistant",
            content: [
              { type: "text", text: prompts.length === 1 ? "preserved prior summary" : "selected prefix summary" },
            ],
            api: requestModel.api,
            provider: requestModel.provider,
            model: requestModel.id,
            usage,
            stopReason: "stop",
            timestamp: 1,
          });
          return stream;
        }),
    },
  });

  const result = await summarizeWithPiNativeCompact(
    ctx,
    summaryOptions({
      selectedUnits: [unit(0, "selected turn prefix", "turn-prefix")],
      customInstructions: undefined,
    }),
  );
  assert.equal(prompts.length, 2);
  assert.match(prompts[0] ?? "", /Earlier compressed work/u);
  assert.match(prompts[1] ?? "", /selected turn prefix/u);
  assert.match(result.text, /preserved prior summary/u);
  assert.match(result.text, /selected prefix summary/u);
});

test("prefix-only custom instructions apply to selected context on initial compaction", async () => {
  const prompts: string[] = [];
  const { ctx } = createMockContext({
    modelRegistry: {
      async getApiKeyAndHeaders() {
        return { ok: true };
      },
      getProvider: () =>
        provider((requestModel, context) => {
          prompts.push(JSON.stringify(context.messages));
          const stream = createAssistantMessageEventStream();
          stream.end({
            role: "assistant",
            content: [{ type: "text", text: "instruction-aware prefix summary" }],
            api: requestModel.api,
            provider: requestModel.provider,
            model: requestModel.id,
            usage,
            stopReason: "stop",
            timestamp: 1,
          });
          return stream;
        }),
    },
  });

  const result = await summarizeWithPiNativeCompact(
    ctx,
    summaryOptions({
      selectedUnits: [unit(0, "selected initial prefix", "turn-prefix")],
      preparation: { ...preparation(), previousSummary: undefined },
      customInstructions: "Focus on unresolved parser work",
    }),
  );

  assert.equal(prompts.length, 1);
  assert.match(prompts[0] ?? "", /selected initial prefix/u);
  assert.match(prompts[0] ?? "", /Focus on unresolved parser work/u);
  assert.match(result.text, /instruction-aware prefix summary/u);
});

test("empty selections without custom instructions reuse the prior summary", async () => {
  let authCalls = 0;
  let compactCalls = 0;
  const { ctx } = createMockContext({
    modelRegistry: {
      async getApiKeyAndHeaders() {
        authCalls += 1;
        return { ok: true };
      },
    },
  });

  const result = await summarizeWithPiNativeCompact(
    ctx,
    summaryOptions({ selectedUnits: [], customInstructions: undefined }),
    async () => {
      compactCalls += 1;
      return compactResult();
    },
  );
  assert.deepEqual(result, { text: "Earlier compressed work" });
  assert.equal(authCalls, 0);
  assert.equal(compactCalls, 0);
});

test("empty selections with custom instructions still invoke Pi compact", async () => {
  let observed: Parameters<PiNativeCompactor>[0] | undefined;
  const { ctx } = createMockContext({
    modelRegistry: {
      async getApiKeyAndHeaders() {
        return { ok: true };
      },
      getProvider: () => provider(),
    },
  });

  await summarizeWithPiNativeCompact(
    ctx,
    summaryOptions({ selectedUnits: [], customInstructions: "Focus on unresolved work" }),
    async (request) => {
      observed = request;
      return compactResult("empty-context summary");
    },
  );
  assert.deepEqual(observed?.preparation.messagesToSummarize, []);
  assert.deepEqual(observed?.preparation.turnPrefixMessages, []);
  assert.equal(observed?.preparation.isSplitTurn, false);
  assert.equal(observed?.customInstructions, "Focus on unresolved work");
});

test("forwarded previous summaries count toward the compact-input byte bound", async () => {
  let compactCalls = 0;
  const { ctx } = createMockContext();
  await assert.rejects(
    summarizeWithPiNativeCompact(
      ctx,
      summaryOptions({ preparation: { ...preparation(), previousSummary: "x".repeat(512 * 1024) } }),
      async () => {
        compactCalls += 1;
        return compactResult();
      },
    ),
    /Selected history exceeds the 512 KiB/u,
  );
  assert.equal(compactCalls, 0);
});

test("custom instructions count toward the compact-input byte bound", async () => {
  let authCalls = 0;
  let compactCalls = 0;
  const { ctx } = createMockContext({
    modelRegistry: {
      async getApiKeyAndHeaders() {
        authCalls += 1;
        return { ok: true };
      },
    },
  });
  await assert.rejects(
    summarizeWithPiNativeCompact(
      ctx,
      summaryOptions({ selectedUnits: [], customInstructions: "é".repeat(300 * 1024) }),
      async () => {
        compactCalls += 1;
        return compactResult();
      },
    ),
    /Selected history exceeds the 512 KiB/u,
  );
  assert.equal(authCalls, 0);
  assert.equal(compactCalls, 0);
});

test("selected input must fit the active model compaction budget", async () => {
  let authCalls = 0;
  let compactCalls = 0;
  const { ctx } = createMockContext({
    modelRegistry: {
      async getApiKeyAndHeaders() {
        authCalls += 1;
        return { ok: true };
      },
    },
  });
  await assert.rejects(
    summarizeWithPiNativeCompact(
      ctx,
      summaryOptions({
        model: { ...model, contextWindow: 256 } as Model<Api>,
        selectedUnits: [unit(0, "x".repeat(800))],
        preparation: {
          ...preparation(),
          settings: { enabled: true, reserveTokens: 64, keepRecentTokens: 64 },
        },
      }),
      async () => {
        compactCalls += 1;
        return compactResult();
      },
    ),
    /active model compaction input budget/u,
  );
  assert.equal(authCalls, 0);
  assert.equal(compactCalls, 0);
});

test("authentication failures do not start Pi compact", async () => {
  let compactCalls = 0;
  const { ctx } = createMockContext({
    modelRegistry: {
      async getApiKeyAndHeaders() {
        return { ok: false, error: "provider auth missing" };
      },
    },
  });
  await assert.rejects(
    summarizeWithPiNativeCompact(ctx, summaryOptions(), async () => {
      compactCalls += 1;
      return compactResult();
    }),
    /provider auth missing/u,
  );
  assert.equal(compactCalls, 0);
});

test("a missing active provider does not start Pi compact", async () => {
  let compactCalls = 0;
  const { ctx } = createMockContext({
    modelRegistry: {
      async getApiKeyAndHeaders() {
        return { ok: true };
      },
      getProvider: () => undefined,
    },
  });
  await assert.rejects(
    summarizeWithPiNativeCompact(ctx, summaryOptions(), async () => {
      compactCalls += 1;
      return compactResult();
    }),
    /resolve the active model provider/u,
  );
  assert.equal(compactCalls, 0);
});

test("stale ownership after authentication prevents Pi compact", async () => {
  let current = true;
  let compactCalls = 0;
  const { ctx } = createMockContext({
    modelRegistry: {
      async getApiKeyAndHeaders() {
        current = false;
        return { ok: true };
      },
    },
  });
  await assert.rejects(
    summarizeWithPiNativeCompact(ctx, summaryOptions({ isCurrent: () => current }), async () => {
      compactCalls += 1;
      return compactResult();
    }),
    /ownership changed/u,
  );
  assert.equal(compactCalls, 0);
});

test("Pi compact failures and cancellation remain observable", async () => {
  const { ctx } = createMockContext({
    modelRegistry: {
      async getApiKeyAndHeaders() {
        return { ok: true };
      },
      getProvider: () => provider(),
    },
  });
  await assert.rejects(
    summarizeWithPiNativeCompact(ctx, summaryOptions(), async () => {
      throw new Error("Pi native compact failed");
    }),
    /Pi native compact failed/u,
  );

  const controller = new AbortController();
  await assert.rejects(
    summarizeWithPiNativeCompact(ctx, summaryOptions({ signal: controller.signal }), async () => {
      controller.abort();
      return compactResult("stale");
    }),
    /abort/iu,
  );
});
