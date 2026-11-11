import assert from "node:assert/strict";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Api, Model, Usage } from "@earendil-works/pi-ai";
import type { SessionBeforeCompactEvent } from "@earendil-works/pi-coding-agent";
import { test } from "vitest";
import { createMockContext, createMockPi } from "../../../test/support.js";
import type { TypeSafeSystemOneClient } from "../src/evaluator.js";
import {
  appendFileOperations,
  fileOperationLists,
  TYPESAFE_COMPACT_DETAILS_KIND,
  TYPESAFE_COMPACT_DETAILS_VERSION,
  type TypeSafeCompactDetails,
} from "../src/history-units.js";
import type { TypeSafeCompactSettingsRuntime, TypeSafeCompactSettingsState } from "../src/settings.js";
import type { ActiveModelSummary, summarizeWithPiNativeCompact } from "../src/summary.js";
import { createTypeSafeCompactExtension } from "../src/typesafe-compact.js";

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

function settingsRuntime(
  input: Partial<TypeSafeCompactSettingsState> = {},
): TypeSafeCompactSettingsRuntime & { flushes: number } {
  let state: TypeSafeCompactSettingsState = {
    kind: "loaded",
    path: "/agent/pi-typesafe-compact.json",
    settings: { apiKey: "type-safe-secret" },
    document: { apiKey: "type-safe-secret" },
    ...input,
  };
  return {
    flushes: 0,
    get: () => structuredClone(state),
    async reload() {
      return structuredClone(state);
    },
    async setApiKey(apiKey) {
      state = { ...state, kind: "loaded", settings: { apiKey }, document: { apiKey } };
      return structuredClone(state);
    },
    async removeApiKey() {
      state = { ...state, kind: "loaded", settings: {}, document: {} };
      return structuredClone(state);
    },
    async flush() {
      this.flushes += 1;
    },
  };
}

function user(text: string, timestamp = 1): AgentMessage {
  return { role: "user", content: text, timestamp };
}

function compactEvent(
  reason: SessionBeforeCompactEvent["reason"] = "manual",
  overrides: Partial<SessionBeforeCompactEvent> = {},
): SessionBeforeCompactEvent {
  return {
    type: "session_before_compact",
    preparation: {
      firstKeptEntryId: "kept",
      messagesToSummarize: [user("summarize me")],
      turnPrefixMessages: [],
      isSplitTurn: false,
      tokensBefore: 12_345,
      previousSummary: undefined,
      fileOps: {
        read: new Set(["src/read.ts", "src/changed.ts"]),
        written: new Set(["src/new.ts"]),
        edited: new Set(["src/changed.ts"]),
      },
      settings: { enabled: true, reserveTokens: 10_000, keepRecentTokens: 20_000 },
    },
    branchEntries: [],
    customInstructions: undefined,
    reason,
    willRetry: reason === "overflow",
    signal: new AbortController().signal,
    ...overrides,
  };
}

function evaluator(probabilities: readonly number[], onRequest?: () => void): TypeSafeSystemOneClient {
  return {
    async systemOne(request) {
      onRequest?.();
      const names = Object.keys(request.questions);
      return {
        model: "jev-latest",
        answers: Object.fromEntries(
          names.map((name, index) => [name, { type: "noul", noul: probabilities[index] ?? 1 }]),
        ),
        usage: { input_tokens: names.length * 2, output_tokens: names.length },
      } as never;
    },
  };
}

function setup(
  options: {
    runtime?: TypeSafeCompactSettingsRuntime;
    client?: TypeSafeSystemOneClient;
    summarize?: (options: Parameters<typeof summarizeWithPiNativeCompact>[1]) => Promise<ActiveModelSummary>;
    context?: Record<string, unknown>;
  } = {},
) {
  const mock = createMockPi();
  const runtime = options.runtime ?? settingsRuntime();
  const selected: string[][] = [];
  createTypeSafeCompactExtension({
    settingsRuntime: runtime,
    clientFactory: () => options.client ?? evaluator([1]),
    summarize: async (_ctx, summaryOptions) => {
      selected.push(summaryOptions.selectedUnits.map((unit) => unit.content));
      if (options.summarize) return options.summarize(summaryOptions);
      const { readFiles, modifiedFiles } = fileOperationLists(summaryOptions.preparation.fileOps);
      return {
        text: appendFileOperations("Pi-native compact summary", readFiles, modifiedFiles),
        usage,
      };
    },
  })(mock.pi);
  const context = createMockContext({
    hasUI: true,
    mode: "tui",
    model,
    thinkingLevel: "high",
    sessionManager: {
      getSessionId: () => "session",
      getBranch: () => [],
      getEntries: () => [],
    },
    ...options.context,
  });
  return { mock, runtime, selected, ...context };
}

test.each([
  ["manual", false],
  ["threshold", false],
  ["overflow", true],
] as const)("%s compaction preserves Pi boundaries and active-model usage", async (reason, willRetry) => {
  const state = setup();
  const handler = state.mock.events.get("session_before_compact")?.[0];
  assert.ok(handler);
  const event = compactEvent(reason);
  assert.equal(event.willRetry, willRetry);
  const result = (await handler(event, state.ctx)) as {
    compaction: {
      summary: string;
      firstKeptEntryId: string;
      tokensBefore: number;
      usage: Usage;
      details: TypeSafeCompactDetails;
    };
  };
  assert.equal(result.compaction.firstKeptEntryId, "kept");
  assert.equal(result.compaction.tokensBefore, 12_345);
  assert.deepEqual(result.compaction.usage, usage);
  assert.match(result.compaction.summary, /Pi-native compact summary/u);
  assert.match(result.compaction.summary, /<read-files>\nsrc\/read.ts/u);
  assert.match(result.compaction.summary, /<modified-files>\nsrc\/new.ts\nsrc\/changed.ts/u);
  assert.equal(result.compaction.details.evaluator.summarized, 1);
  assert.deepEqual(state.selected, [["summarize me"]]);
  assert.equal(state.statuses.get("typesafe-compact"), undefined);
});

test("post-compaction history that exceeds the active model budget falls back to Pi native", async () => {
  const state = setup({
    client: evaluator([0]),
    context: { model: { ...model, contextWindow: 256, maxTokens: 64 } },
  });
  const event = compactEvent("overflow");
  event.preparation.firstKeptEntryId = "suffix";
  event.preparation.messagesToSummarize = [user("x".repeat(2_000))];
  event.preparation.settings = { enabled: true, reserveTokens: 64, keepRecentTokens: 64 };
  event.branchEntries = [
    {
      type: "message",
      id: "suffix",
      parentId: null,
      timestamp: "2026-09-19T00:00:00.000Z",
      message: user("kept suffix", 2),
    },
  ];

  const handler = state.mock.events.get("session_before_compact")?.[0];
  assert.equal(await handler?.(event, state.ctx), undefined);
  assert.match(state.notifications[0]?.message ?? "", /active model token budget/u);
});

test("split-turn tool calls and results are independently selected and retained", async () => {
  const assistant = {
    role: "assistant",
    content: [{ type: "toolCall", id: "call", name: "read", arguments: { path: "a" } }],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage,
    stopReason: "toolUse",
    timestamp: 2,
  } as AgentMessage;
  const resultMessage: AgentMessage = {
    role: "toolResult",
    toolCallId: "call",
    toolName: "read",
    content: [{ type: "text", text: "tool output" }],
    isError: false,
    timestamp: 3,
  };
  const state = setup({ client: evaluator([1, 0]) });
  const handler = state.mock.events.get("session_before_compact")?.[0];
  const event = compactEvent("overflow");
  event.preparation.messagesToSummarize = [];
  event.preparation.turnPrefixMessages = [assistant, resultMessage];
  event.preparation.isSplitTurn = true;
  const result = (await handler?.(event, state.ctx)) as {
    compaction: { summary: string; details: TypeSafeCompactDetails };
  };
  assert.deepEqual(state.selected, [[expectToolCall()]]);
  assert.equal(result.compaction.details.evaluator.summarized, 1);
  assert.equal(result.compaction.details.evaluator.retained, 1);
  assert.equal(result.compaction.details.retainedUnits[0]?.kind, "tool-result-text");
  assert.match(result.compaction.summary, /tool output/u);
});

function expectToolCall(): string {
  return '{"id":"call","name":"read","arguments":{"path":"a"}}';
}

test("repeated compaction reevaluates prior retained units and uses only the prior compressed summary", async () => {
  const priorUnit = {
    id: "unit-000000",
    order: 0,
    kind: "user-text" as const,
    source: "history" as const,
    label: "User",
    content: "prior retained",
  };
  const priorDetails: TypeSafeCompactDetails = {
    kind: TYPESAFE_COMPACT_DETAILS_KIND,
    version: TYPESAFE_COMPACT_DETAILS_VERSION,
    compressedSummary: "pure prior summary",
    retainedUnits: [priorUnit],
    evaluator: {
      model: "jev-latest",
      evaluated: 1,
      summarized: 0,
      retained: 1,
      inputTokens: 1,
      outputTokens: 1,
    },
    readFiles: ["src/prior-read.ts"],
    modifiedFiles: ["src/prior-modified.ts"],
  };
  let previousSummary: string | undefined;
  const state = setup({
    client: evaluator([1, 0]),
    summarize: async (options) => {
      previousSummary = options.preparation.previousSummary;
      return { text: "updated" };
    },
  });
  const event = compactEvent();
  event.preparation.previousSummary = "visible summary with retained history";
  event.branchEntries = [
    {
      type: "compaction",
      id: "prior",
      parentId: "parent",
      timestamp: "2026-09-19T00:00:00.000Z",
      summary: event.preparation.previousSummary,
      firstKeptEntryId: "old-kept",
      tokensBefore: 1_000,
      details: priorDetails,
    },
  ];
  event.preparation.messagesToSummarize = [user("new retained")];
  const handler = state.mock.events.get("session_before_compact")?.[0];
  const result = (await handler?.(event, state.ctx)) as { compaction: { details: TypeSafeCompactDetails } };
  assert.equal(previousSummary, "pure prior summary");
  assert.deepEqual(state.selected, [["prior retained"]]);
  assert.equal(result.compaction.details.retainedUnits[0]?.content, "new retained");
  assert.deepEqual(new Set(result.compaction.details.readFiles), new Set(["src/prior-read.ts", "src/read.ts"]));
  assert.deepEqual(
    new Set(result.compaction.details.modifiedFiles),
    new Set(["src/prior-modified.ts", "src/new.ts", "src/changed.ts"]),
  );
});

test("session start reports invalid settings without exposing contents", async () => {
  const runtime = settingsRuntime({
    kind: "invalid",
    settings: {},
    document: undefined,
    issue: "invalid settings shape",
  });
  const state = setup({ runtime });
  const start = state.mock.events.get("session_start")?.[0];
  await start?.({ type: "session_start", reason: "startup" }, state.ctx);
  assert.match(state.notifications[0]?.message ?? "", /Invalid pi-typesafe-compact\.json/u);
  assert.match(state.notifications[0]?.message ?? "", /invalid settings shape/u);
});

test("missing or invalid key leaves Pi-native compaction untouched", async () => {
  for (const kind of ["missing", "invalid"] as const) {
    let clientCalls = 0;
    const runtime = settingsRuntime({ kind, settings: {}, document: kind === "missing" ? {} : undefined });
    const state = setup({
      runtime,
      client: evaluator([1], () => {
        clientCalls += 1;
      }),
    });
    const handler = state.mock.events.get("session_before_compact")?.[0];
    assert.equal(await handler?.(compactEvent(), state.ctx), undefined);
    assert.equal(clientCalls, 0);
    assert.deepEqual(state.notifications, []);
  }
});

test("evaluator and summarizer failures warn without secrets and fall back to Pi native", async () => {
  const evaluatorFailure = setup({
    client: {
      async systemOne() {
        throw new Error("request type-safe-secret failed");
      },
    } as TypeSafeSystemOneClient,
  });
  const handler = evaluatorFailure.mock.events.get("session_before_compact")?.[0];
  assert.equal(await handler?.(compactEvent(), evaluatorFailure.ctx), undefined);
  assert.match(evaluatorFailure.notifications[0]?.message ?? "", /Pi-native compaction/u);
  assert.doesNotMatch(evaluatorFailure.notifications[0]?.message ?? "", /type-safe-secret/u);

  const summaryFailure = setup({
    summarize: async () => {
      throw new Error("summary \u202efailed\u001b[31m");
    },
  });
  const summaryHandler = summaryFailure.mock.events.get("session_before_compact")?.[0];
  assert.equal(await summaryHandler?.(compactEvent(), summaryFailure.ctx), undefined);
  const lifecycleWarning = summaryFailure.notifications[0]?.message ?? "";
  assert.match(lifecycleWarning, /summary failed/u);
  assert.equal(lifecycleWarning.includes("\u202e"), false);
  assert.equal(lifecycleWarning.includes("\u001b"), false);
});

test("model changes after evaluation cancel publication instead of using stale context", async () => {
  let summarizeCalls = 0;
  let contextRef: ReturnType<typeof createMockContext>["ctx"];
  const state = setup({
    client: evaluator([1], () => {
      (contextRef as unknown as { model: Model<Api> }).model = { ...model, id: "replacement" } as Model<Api>;
    }),
    summarize: async () => {
      summarizeCalls += 1;
      return { text: "should not happen" };
    },
  });
  contextRef = state.ctx;
  const handler = state.mock.events.get("session_before_compact")?.[0];
  assert.deepEqual(await handler?.(compactEvent(), state.ctx), { cancel: true });
  assert.equal(summarizeCalls, 0);
});

test.each(["session_start", "session_shutdown"] as const)(
  "%s in another session does not cancel active compaction",
  async (eventName) => {
    let releaseEvaluation = () => {};
    const evaluationGate = new Promise<void>((resolve) => {
      releaseEvaluation = resolve;
    });
    const baseClient = evaluator([1]);
    const state = setup({
      client: {
        async systemOne(request, options) {
          await evaluationGate;
          return baseClient.systemOne(request, options);
        },
      },
    });
    const compact = state.mock.events.get("session_before_compact")?.[0];
    const pending = compact?.(compactEvent(), state.ctx);
    await Promise.resolve();

    const { ctx: otherContext } = createMockContext({
      hasUI: false,
      mode: "rpc",
      model,
      sessionManager: {
        getSessionId: () => "other-session",
        getBranch: () => [],
        getEntries: () => [],
      },
    });
    if (eventName === "session_start") {
      const start = state.mock.events.get("session_start")?.[0];
      await start?.({ type: "session_start", reason: "startup" }, otherContext);
    } else {
      const shutdown = state.mock.events.get("session_shutdown")?.[0];
      await shutdown?.({ type: "session_shutdown", reason: "quit" }, otherContext);
    }

    releaseEvaluation();
    const result = (await pending) as { compaction?: { summary: string } } | undefined;
    assert.match(result?.compaction?.summary ?? "", /Pi-native compact summary/u);
  },
);

test("session replacement aborts evaluation and clears the old status", async () => {
  let sessionId = "session";
  const client = {
    systemOne(_request: unknown, options?: { signal?: AbortSignal }) {
      return new Promise((_resolve, reject) => {
        options?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), {
          once: true,
        });
      });
    },
  } as TypeSafeSystemOneClient;
  const state = setup({
    client,
    context: {
      sessionManager: {
        getSessionId: () => sessionId,
        getBranch: () => [],
        getEntries: () => [],
      },
    },
  });
  const handler = state.mock.events.get("session_before_compact")?.[0];
  const start = state.mock.events.get("session_start")?.[0];
  const pending = handler?.(compactEvent(), state.ctx);
  await Promise.resolve();
  assert.equal(state.statuses.get("typesafe-compact"), "JEV evaluating history…");
  sessionId = "replacement";
  await start?.({ type: "session_start", reason: "new" }, state.ctx);
  assert.deepEqual(await pending, { cancel: true });
  assert.equal(state.statuses.get("typesafe-compact"), undefined);
});

test("session or model changes after active-model completion cancel stale publication", async () => {
  for (const change of ["session", "model"] as const) {
    let sessionId = "session";
    let contextRef: ReturnType<typeof createMockContext>["ctx"];
    const state = setup({
      context: {
        sessionManager: {
          getSessionId: () => sessionId,
          getBranch: () => [],
          getEntries: () => [],
        },
      },
      summarize: async () => {
        if (change === "session") sessionId = "replacement";
        else {
          (contextRef as unknown as { model: Model<Api> }).model = {
            ...model,
            id: "replacement",
          } as Model<Api>;
        }
        return { text: "stale summary" };
      },
    });
    contextRef = state.ctx;
    const handler = state.mock.events.get("session_before_compact")?.[0];
    assert.deepEqual(await handler?.(compactEvent(), state.ctx), { cancel: true });
  }
});

test("shutdown aborts in-flight evaluation, clears status, and flushes settings", async () => {
  const runtime = settingsRuntime();
  const client = {
    systemOne(_request: unknown, options?: { signal?: AbortSignal }) {
      return new Promise((_resolve, reject) => {
        options?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), {
          once: true,
        });
      });
    },
  } as TypeSafeSystemOneClient;
  const state = setup({ runtime, client });
  const handler = state.mock.events.get("session_before_compact")?.[0];
  const shutdown = state.mock.events.get("session_shutdown")?.[0];
  const pending = handler?.(compactEvent(), state.ctx);
  await Promise.resolve();
  assert.equal(state.statuses.get("typesafe-compact"), "JEV evaluating history…");
  await shutdown?.({ type: "session_shutdown", reason: "quit" }, state.ctx);
  assert.deepEqual(await pending, { cancel: true });
  assert.equal(state.statuses.get("typesafe-compact"), undefined);
  assert.equal((runtime as ReturnType<typeof settingsRuntime>).flushes, 1);
});
