import assert from "node:assert/strict";
import type { Usage } from "@earendil-works/pi-ai";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES } from "@earendil-works/pi-coding-agent";
import { Check } from "typebox/value";
import { test, vi } from "vitest";
import { createMockContext, createMockPi } from "../../../test/support.js";
import {
  type JevProvider,
  OPENROUTER_ENDPOINT,
  OPENROUTER_MODEL,
  TYPESAFE_ENDPOINT,
  TYPESAFE_MODEL,
} from "../src/client.js";
import jevExtension, {
  formatJevResult,
  type JevDecisionInput,
  type JevDecisionResponse,
  type jevToolParameters,
  normalizeJevInput,
  normalizeJevResponse,
  requestJevDecision,
  resolveJevProvider,
} from "../src/jev.js";

const decisionInput: JevDecisionInput = {
  state: "Help! My payouts have been failing for 3 days.",
  questions: {
    is_urgent: {
      type: "noul",
      instructions: "Does this message convey urgency?",
      criteria: {
        true: "Explicitly time-sensitive",
        false: "No urgency expressed",
      },
    },
    department: {
      type: "choice",
      instructions: "Which team should handle this?",
      criteria: {
        billing: "Payments, invoicing, refunds",
        technical: "Bugs, outages, integrations",
        sales: "Pricing, upgrades, new accounts",
      },
    },
    frustration: {
      type: "score",
      instructions: "How frustrated is the customer?",
      criteria: ["Calm", "Frustrated", "Very angry"],
    },
  },
};

const decisionResponse: JevDecisionResponse = {
  model: "typesafe/jev-1.13",
  answers: {
    is_urgent: { type: "noul", noul: 0.92 },
    department: {
      type: "choice",
      choice: "billing",
      probabilities: { billing: 0.84, technical: 0.12, sales: 0.04 },
      confidence: 0.8,
    },
    frustration: {
      type: "score",
      score: 1.6,
      legend: { "0": "Calm", "1": "Frustrated", "2": "Very angry" },
      probabilities: { "0": 0.05, "1": 0.3, "2": 0.65 },
      confidence: 0.78,
    },
  },
  usage: { input_tokens: 312, output_tokens: 48 },
};

function officialContext(auth: Record<string, unknown> = { apiKey: "sk-or-secret" }) {
  return createMockContext({
    modelRegistry: {
      getProviderAuth: async () => ({ auth }),
      getProvider: () => ({ baseUrl: "https://openrouter.ai/api/v1" }),
    },
  }).ctx;
}

function typeSafeProvider(apiKey = "ts-secret"): JevProvider {
  return {
    name: "TypeSafe",
    endpoint: TYPESAFE_ENDPOINT,
    model: TYPESAFE_MODEL,
    authorization: `Bearer ${apiKey}`,
    secrets: [apiKey, `Bearer ${apiKey}`],
  };
}

function registeredTool(
  fetchImpl: typeof fetch,
  env: Readonly<Record<string, string | undefined>> = { TYPESAFE_API_KEY: "ts-secret" },
  openRouterFallback = false,
) {
  const mock = createMockPi();
  jevExtension(mock.pi, { fetch: fetchImpl, env, settings: { openRouterFallback } });
  const tool = mock.tools.find((candidate) => candidate.name === "typesafe_question");
  assert.ok(tool);
  return tool as {
    name: string;
    description: string;
    promptSnippet: string;
    promptGuidelines: string[];
    parameters: typeof jevToolParameters;
    execute(
      toolCallId: string,
      params: unknown,
      signal: AbortSignal,
      onUpdate: undefined,
      ctx: ReturnType<typeof officialContext>,
    ): Promise<{ content: Array<{ type: "text"; text: string }>; details: { truncated: boolean }; usage?: Usage }>;
  };
}

test("registers one stable Jev decision tool with all supported question types", () => {
  const tool = registeredTool(vi.fn<typeof fetch>());
  assert.equal(tool.name, "typesafe_question");
  assert.match(tool.description, /noul, choice, and score/);
  assert.match(tool.promptSnippet, /typed noul, choice, or score/);
  assert.match(tool.promptGuidelines[0] ?? "", /Use typesafe_question/);

  assert.equal(Check(tool.parameters, decisionInput), true);
  for (const invalidQuestion of [
    { type: "noul", instructions: "Q", criteria: { true: "yes" } },
    { type: "choice", instructions: "Q" },
    { type: "choice", instructions: "Q", criteria: { only: null } },
    { type: "score", instructions: "Q" },
    { type: "score", instructions: "Q", criteria: ["only"] },
  ]) {
    assert.equal(Check(tool.parameters, { state: "x", questions: { q: invalidQuestion } }), false);
  }
  assert.equal(
    Check(tool.parameters, {
      state: "x",
      questions: { q: { type: "noul", instructions: "Q" } },
    }),
    true,
  );

  const second = registeredTool(vi.fn<typeof fetch>());
  assert.deepEqual(
    {
      name: second.name,
      description: second.description,
      promptSnippet: second.promptSnippet,
      promptGuidelines: second.promptGuidelines,
      parameters: second.parameters,
    },
    {
      name: tool.name,
      description: tool.description,
      promptSnippet: tool.promptSnippet,
      promptGuidelines: tool.promptGuidelines,
      parameters: tool.parameters,
    },
  );
});

test("tool prefers the official TypeSafe API and returns validated JSON", async () => {
  const controller = new AbortController();
  const getProviderAuth = vi.fn(async () => ({ auth: { apiKey: "sk-or-secret" } }));
  const ctx = createMockContext({
    modelRegistry: {
      getProviderAuth,
      getProvider: () => ({ baseUrl: "https://openrouter.ai/api/v1" }),
    },
  }).ctx;
  const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
    assert.equal(input, TYPESAFE_ENDPOINT);
    assert.equal(init?.method, "POST");
    assert.notEqual(init?.signal, controller.signal);
    assert.equal(init?.signal instanceof AbortSignal, true);
    const headers = new Headers(init?.headers);
    assert.equal(headers.get("authorization"), "Bearer ts-secret");
    assert.equal(headers.get("content-type"), "application/json");
    const sdkHeader = headers.get("x-typesafe-sdk");
    assert.match(sdkHeader ?? "", /^typesafe-sdk\//u);
    assert.equal(headers.get("user-agent"), sdkHeader);
    assert.deepEqual(JSON.parse(String(init?.body)), {
      model: TYPESAFE_MODEL,
      state: decisionInput.state,
      questions: decisionInput.questions,
    });
    return new Response(JSON.stringify(decisionResponse), { status: 200 });
  });
  const tool = registeredTool(fetchImpl);

  const result = await tool.execute("call-1", decisionInput, controller.signal, undefined, ctx);

  assert.equal(getProviderAuth.mock.calls.length, 0);
  assert.equal(fetchImpl.mock.calls.length, 1);
  assert.deepEqual(JSON.parse(result.content[0]?.text ?? ""), decisionResponse);
  assert.equal(result.details.truncated, false);
  assert.deepEqual(result.usage, {
    input: 312,
    output: 48,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 360,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  });
});

test("tool uses enabled Pi-resolved OpenRouter fallback only without a TypeSafe key", async () => {
  const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
    assert.equal(input, OPENROUTER_ENDPOINT);
    assert.deepEqual(init?.headers, {
      Authorization: "Bearer sk-or-secret",
      "Content-Type": "application/json",
    });
    const headers = new Headers(init?.headers);
    assert.equal(headers.has("x-typesafe-sdk"), false);
    assert.deepEqual(JSON.parse(String(init?.body)), {
      model: OPENROUTER_MODEL,
      state: decisionInput.state,
      questions: decisionInput.questions,
    });
    return new Response(JSON.stringify(decisionResponse), { status: 200 });
  });
  const tool = registeredTool(fetchImpl, {}, true);

  await tool.execute("call-1", decisionInput, new AbortController().signal, undefined, officialContext());

  assert.equal(fetchImpl.mock.calls.length, 1);
});

test("a TypeSafe request failure does not switch providers", async () => {
  const getProviderAuth = vi.fn(async () => ({ auth: { apiKey: "sk-or-secret" } }));
  const ctx = createMockContext({
    modelRegistry: {
      getProviderAuth,
      getProvider: () => ({ baseUrl: "https://openrouter.ai/api/v1" }),
    },
  }).ctx;
  const fetchImpl = vi.fn<typeof fetch>(async () => new Response("overloaded", { status: 529 }));

  await assert.rejects(
    () => registeredTool(fetchImpl).execute("call-1", decisionInput, new AbortController().signal, undefined, ctx),
    /TypeSafe Jev request failed \(529\)/,
  );
  assert.equal(getProviderAuth.mock.calls.length, 0);
  assert.equal(fetchImpl.mock.calls.length, 1);
});

test("official TypeSafe SDK requests time out without retrying", async () => {
  vi.useFakeTimers();
  try {
    const fetchImpl = vi.fn<typeof fetch>(
      async (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          const abort = () => reject(init?.signal?.reason ?? new DOMException("timed out", "AbortError"));
          if (init?.signal?.aborted) abort();
          else init?.signal?.addEventListener("abort", abort, { once: true });
        }),
    );
    const pending = requestJevDecision(
      decisionInput,
      typeSafeProvider("secret"),
      new AbortController().signal,
      fetchImpl,
    );
    const rejection = assert.rejects(pending, /timed out after 10000ms/);

    await vi.advanceTimersByTimeAsync(10_000);
    await rejection;
    assert.equal(fetchImpl.mock.calls.length, 1);
  } finally {
    vi.useRealTimers();
  }
});

test("resolved OpenRouter Authorization header takes precedence over its API key", async () => {
  const ctx = officialContext({
    apiKey: "unused-key",
    headers: { authorization: "Bearer runtime-token" },
  });
  assert.deepEqual(await resolveJevProvider(ctx, {}, true), {
    name: "OpenRouter",
    endpoint: OPENROUTER_ENDPOINT,
    model: OPENROUTER_MODEL,
    authorization: "Bearer runtime-token",
    secrets: ["unused-key", "Bearer runtime-token", "runtime-token"],
  });
});

test("authentication and the OpenRouter fallback fail closed before network access", async () => {
  const getProviderAuth = vi.fn(async () => undefined);
  const missing = createMockContext({
    modelRegistry: {
      getProviderAuth,
      getProvider: () => ({ baseUrl: "https://openrouter.ai/api/v1" }),
    },
  }).ctx;
  await assert.rejects(() => resolveJevProvider(missing, {}), /openRouterFallback/);
  const fetchImpl = vi.fn<typeof fetch>();
  await assert.rejects(
    () =>
      registeredTool(fetchImpl, {}).execute("call-1", decisionInput, new AbortController().signal, undefined, missing),
    /openRouterFallback/,
  );
  assert.equal(getProviderAuth.mock.calls.length, 0);
  assert.equal(fetchImpl.mock.calls.length, 0);

  await assert.rejects(() => resolveJevProvider(missing, { TYPESAFE_API_KEY: "invalid key" }), /whitespace/);
  assert.deepEqual(await resolveJevProvider(missing, { TYPESAFE_API_KEY: "ts-secret" }, true), typeSafeProvider());
  assert.equal(getProviderAuth.mock.calls.length, 0);

  await assert.rejects(() => resolveJevProvider(missing, {}, true), /authentication is not configured/);
  assert.equal(getProviderAuth.mock.calls.length, 1);

  for (const modelRegistry of [
    {
      getProviderAuth: async () => ({ auth: { apiKey: "secret", baseUrl: "https://proxy.example/v1" } }),
      getProvider: () => ({ baseUrl: "https://openrouter.ai/api/v1" }),
    },
    {
      getProviderAuth: async () => ({ auth: { apiKey: "secret" } }),
      getProvider: () => ({ baseUrl: "https://proxy.example/v1" }),
    },
  ]) {
    const ctx = createMockContext({ modelRegistry }).ctx;
    await assert.rejects(() => resolveJevProvider(ctx, {}, true), /proxy base URL/);
  }

  const incompatible = officialContext({ headers: { Authorization: "Basic secret" } });
  await assert.rejects(() => resolveJevProvider(incompatible, {}, true), /Bearer credential/);
});

test("normalizes structured questions and enforces per-type criteria", () => {
  const structured = normalizeJevInput({
    state: { ticket: ["failed", 3, true, null] },
    questions: {
      risk: {
        type: "noul",
        instructions: { question: "Is this risky?" },
      },
      route: {
        type: "choice",
        instructions: ["Choose", "a route"],
        criteria: { allow: null, review: { when: "uncertain" } },
      },
      severity: {
        type: "score",
        instructions: "Rate severity",
        criteria: ["low", { level: "medium" }, ["high", "urgent"]],
      },
    },
  });
  assert.deepEqual(structured.state, { ticket: ["failed", 3, true, null] });

  const invalidCases: [unknown, RegExp][] = [
    [{ state: 1, questions: { q: { type: "noul", instructions: "Q" } } }, /state must be/],
    [{ state: "x", questions: {} }, /at least one/],
    [
      {
        state: "x",
        questions: { q: { type: "noul", instructions: "Q", criteria: { true: "yes" } } },
      },
      /keys must exactly match/,
    ],
    [
      {
        state: "x",
        questions: { q: { type: "choice", instructions: "Q", criteria: { only: null } } },
      },
      /between 2 and 255/,
    ],
    [
      {
        state: "x",
        questions: { q: { type: "score", instructions: "Q", criteria: ["only"] } },
      },
      /between 2 and 10/,
    ],
    [
      {
        state: "x",
        questions: { q: { type: "unknown", instructions: "Q" } },
      },
      /must be noul, choice, or score/,
    ],
  ];
  for (const [value, pattern] of invalidCases) assert.throws(() => normalizeJevInput(value), pattern);
});

test("validation paths escape untrusted question ids", () => {
  const id = "unsafe\u001b]8;;https://evil.example\u0007link\u202ename";
  assert.throws(
    () => normalizeJevInput({ state: "x", questions: { [id]: { type: "noul", instructions: 1 } } }),
    (error: Error) => {
      assert.equal(error.message.includes("\u001b"), false);
      assert.equal(error.message.includes("\u0007"), false);
      assert.equal(error.message.includes("\u202e"), false);
      assert.match(error.message, /questions\["unsafe\\u001b/);
      assert.match(error.message, /\\u202e/);
      return true;
    },
  );
});

test("tool validation failures are terminal-safe and bounded before network access", async () => {
  const id = `unsafe\u001b]8;;https://evil.example\u0007${"x".repeat(DEFAULT_MAX_BYTES * 2)}\u202e`;
  const fetchImpl = vi.fn<typeof fetch>();
  await assert.rejects(
    () =>
      registeredTool(fetchImpl).execute(
        "call-1",
        { state: "x", questions: { [id]: { type: "noul", instructions: 1 } } },
        new AbortController().signal,
        undefined,
        officialContext(),
      ),
    (error: Error) => {
      assert.equal(error.message.includes("\u001b"), false);
      assert.equal(error.message.includes("\u0007"), false);
      assert.equal(error.message.includes("\u202e"), false);
      assert.ok(Buffer.byteLength(error.message, "utf8") <= 2048);
      return true;
    },
  );
  assert.equal(fetchImpl.mock.calls.length, 0);
});

test("rejects non-JSON and circular structured values", () => {
  assert.throws(
    () =>
      normalizeJevInput({
        state: { bad: Number.NaN },
        questions: { q: { type: "noul", instructions: "Q" } },
      }),
    /finite JSON numbers/,
  );
  const circular: Record<string, unknown> = {};
  circular.self = circular;
  assert.throws(
    () => normalizeJevInput({ state: circular, questions: { q: { type: "noul", instructions: "Q" } } }),
    /circular data/,
  );
});

test.each([
  [null, null, 0, 0],
  [null, 3, 0, 3],
  [7, null, 7, 0],
  [0, 0, 0, 0],
])("normalizes unreported SDK usage (%s, %s)", (input, output, inputTokens, outputTokens) => {
  const response = structuredClone(decisionResponse) as unknown as Record<string, unknown>;
  response.usage = { input_tokens: input, output_tokens: output };
  const normalized = normalizeJevResponse(response, decisionInput);
  assert.deepEqual(normalized.usage, { input_tokens: inputTokens, output_tokens: outputTokens });
  assert.equal(formatJevResult(normalized).usage?.totalTokens, (inputTokens ?? 0) + (outputTokens ?? 0));
});

test.each([
  {},
  { input_tokens: -1, output_tokens: 0 },
  { input_tokens: Number.NaN, output_tokens: 0 },
  { input_tokens: 0, output_tokens: 1.5 },
])("rejects invalid usage counts %j", (usage) => {
  const response = structuredClone(decisionResponse) as unknown as Record<string, unknown>;
  response.usage = usage;
  assert.throws(() => normalizeJevResponse(response, decisionInput), /non-negative input_tokens and output_tokens/);
});

test("normalizes OpenRouter token aliases and reports optional cost as Pi tool usage", () => {
  const response = structuredClone(decisionResponse) as unknown as Record<string, unknown>;
  response.usage = { prompt_tokens: 12, completion_tokens: 3, cost: 0.001 };
  const normalized = normalizeJevResponse(response, decisionInput);
  assert.deepEqual(normalized.usage, {
    input_tokens: 12,
    output_tokens: 3,
    cost: 0.001,
  });
  assert.deepEqual(formatJevResult(normalized).usage, {
    input: 12,
    output: 3,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 15,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.001 },
  });
});

test("response validation covers answer identity, ranges, distributions, and selected options", () => {
  const cases: [string, (response: JevDecisionResponse) => void, RegExp][] = [
    [
      "missing answer",
      (response) => {
        delete response.answers.is_urgent;
      },
      /keys must exactly match/,
    ],
    [
      "mismatched type",
      (response) => {
        response.answers.is_urgent = { type: "choice", choice: "x", probabilities: { x: 1 }, confidence: 1 };
      },
      /does not match/,
    ],
    [
      "noul outside range",
      (response) => {
        response.answers.is_urgent = { type: "noul", noul: 1.1 };
      },
      /between 0 and 1/,
    ],
    [
      "unknown choice",
      (response) => {
        const answer = response.answers.department;
        if (answer?.type === "choice") answer.choice = "unknown";
      },
      /requested options/,
    ],
    [
      "choice contradicts probabilities",
      (response) => {
        const answer = response.answers.department;
        if (answer?.type === "choice") answer.choice = "technical";
      },
      /highest-probability option/,
    ],
    [
      "missing probability",
      (response) => {
        const answer = response.answers.department;
        if (answer?.type === "choice") delete answer.probabilities.sales;
      },
      /keys must exactly match/,
    ],
    [
      "invalid probability sum",
      (response) => {
        const answer = response.answers.department;
        if (answer?.type === "choice") answer.probabilities = { billing: 0.2, technical: 0.2, sales: 0.2 };
      },
      /sum to 1/,
    ],
    [
      "score outside levels",
      (response) => {
        const answer = response.answers.frustration;
        if (answer?.type === "score") answer.score = 3;
      },
      /between 0 and 2/,
    ],
    [
      "score contradicts probabilities",
      (response) => {
        const answer = response.answers.frustration;
        if (answer?.type === "score") answer.probabilities = { "0": 1, "1": 0, "2": 0 };
      },
      /probability-weighted level distribution/,
    ],
    [
      "legend key mismatch",
      (response) => {
        const answer = response.answers.frustration;
        if (answer?.type === "score") delete answer.legend["2"];
      },
      /keys must exactly match/,
    ],
    [
      "legend value mismatch",
      (response) => {
        const answer = response.answers.frustration;
        if (answer?.type === "score") answer.legend["1"] = "Not the requested level";
      },
      /must match the requested score criterion/,
    ],
  ];

  for (const [name, mutate, pattern] of cases) {
    const response = structuredClone(decisionResponse);
    mutate(response);
    assert.throws(() => normalizeJevResponse(response, decisionInput), pattern, name);
  }
});

test("choice validation permits any option tied for highest probability", () => {
  const response = structuredClone(decisionResponse);
  const answer = response.answers.department;
  assert.equal(answer?.type, "choice");
  answer.choice = "technical";
  answer.probabilities = { billing: 0.48, technical: 0.48, sales: 0.04 };

  assert.deepEqual(normalizeJevResponse(response, decisionInput), response);
});

test("score legends compare structured criteria independent of object key order", () => {
  const input: JevDecisionInput = {
    state: "x",
    questions: {
      severity: {
        type: "score",
        instructions: "Rate severity",
        criteria: [
          { label: "low", metadata: { rank: 0, tags: ["routine"] } },
          { label: "high", metadata: { rank: 1, tags: ["urgent"] } },
        ],
      },
    },
  };
  const response: JevDecisionResponse = {
    model: "typesafe/jev-1.13",
    answers: {
      severity: {
        type: "score",
        score: 0.6,
        legend: {
          "0": { metadata: { tags: ["routine"], rank: 0 }, label: "low" },
          "1": { metadata: { tags: ["urgent"], rank: 1 }, label: "high" },
        },
        probabilities: { "0": 0.4, "1": 0.6 },
        confidence: 0.8,
      },
    },
  };

  assert.deepEqual(normalizeJevResponse(response, input), response);
});

test("score validation permits small probability-rounding differences", () => {
  const response = structuredClone(decisionResponse);
  const answer = response.answers.frustration;
  assert.equal(answer?.type, "score");
  answer.score = 1.63;
  assert.equal(normalizeJevResponse(response, decisionInput).answers.frustration?.type, "score");
});

test("HTTP failures are bounded, terminal-safe, and redact credentials", async () => {
  const secret = "sk-or-sensitive";
  const responseText = JSON.stringify({
    error: { message: `bad ${secret}\u001b]8;;https://evil.example\u0007link` },
  });
  const fetchImpl = vi.fn<typeof fetch>(async () => new Response(responseText, { status: 422 }));

  await assert.rejects(
    () => requestJevDecision(decisionInput, typeSafeProvider(secret), undefined, fetchImpl),
    (error: Error) => {
      assert.match(error.message, /failed \(422\)/);
      assert.match(error.message, /\[redacted\]/);
      assert.equal(error.message.includes(secret), false);
      assert.equal(error.message.includes("\u001b"), false);
      assert.ok(Buffer.byteLength(error.message, "utf8") < 2300);
      return true;
    },
  );
});

test("non-JSON, invalid, oversized, and oversized-request responses fail observably", async () => {
  const provider = typeSafeProvider("secret");
  await assert.rejects(
    () => requestJevDecision(decisionInput, provider, undefined, async () => new Response("not json", { status: 200 })),
    /non-JSON response/,
  );
  await assert.rejects(
    () =>
      requestJevDecision(
        decisionInput,
        provider,
        undefined,
        async () => new Response(JSON.stringify({ model: "jev", answers: {} }), { status: 200 }),
      ),
    /invalid response/,
  );
  await assert.rejects(
    () =>
      requestJevDecision(
        decisionInput,
        provider,
        undefined,
        async () => new Response("x".repeat(1024 * 1024 + 1), { status: 200 }),
      ),
    /response exceeds the (?:1|1\.0)MB/,
  );
  const fetchImpl = vi.fn<typeof fetch>();
  await assert.rejects(
    () =>
      requestJevDecision(
        { state: "x".repeat(1024 * 1024), questions: decisionInput.questions },
        provider,
        undefined,
        fetchImpl,
      ),
    /request exceeds the (?:1|1\.0)MB/,
  );
  assert.equal(fetchImpl.mock.calls.length, 0);
});

test("response limits reject declared and streamed overflow before buffering the complete body", async () => {
  const provider = typeSafeProvider("secret");
  let declaredBodyCancelled = false;
  const declaredBody = new ReadableStream<Uint8Array>({
    cancel() {
      declaredBodyCancelled = true;
    },
  });
  await assert.rejects(
    () =>
      requestJevDecision(
        decisionInput,
        provider,
        undefined,
        async () =>
          new Response(declaredBody, {
            status: 200,
            headers: { "Content-Length": String(1024 * 1024 + 1) },
          }),
      ),
    /response exceeds the (?:1|1\.0)MB/,
  );
  assert.equal(declaredBodyCancelled, true);

  let pulls = 0;
  let streamedBodyCancelled = false;
  const chunk = new Uint8Array(600 * 1024).fill(120);
  const streamedBody = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulls += 1;
      controller.enqueue(chunk);
    },
    cancel() {
      streamedBodyCancelled = true;
    },
  });
  await assert.rejects(
    () =>
      requestJevDecision(decisionInput, provider, undefined, async () => new Response(streamedBody, { status: 200 })),
    /response exceeds the (?:1|1\.0)MB/,
  );
  assert.equal(streamedBodyCancelled, true);
  assert.ok(pulls <= 3, `expected early stream cancellation, received ${pulls} pulls`);
});

test("fetch cancellation is preserved", async () => {
  const controller = new AbortController();
  controller.abort();
  const fetchImpl = vi.fn<typeof fetch>(async (_input, init) => {
    assert.notEqual(init?.signal, controller.signal);
    assert.equal(init?.signal?.aborted, true);
    throw new DOMException("cancelled", "AbortError");
  });
  await assert.rejects(
    () => requestJevDecision(decisionInput, typeSafeProvider("secret"), controller.signal, fetchImpl),
    (error: Error) => error.name === "AbortError",
  );
});

test("response body reading preserves cancellation and releases the stream", async () => {
  const controller = new AbortController();
  let bodyCancelled = false;
  const body = new ReadableStream<Uint8Array>({
    start() {
      queueMicrotask(() => controller.abort());
    },
    cancel() {
      bodyCancelled = true;
    },
  });
  await assert.rejects(
    () =>
      requestJevDecision(
        decisionInput,
        typeSafeProvider("secret"),
        controller.signal,
        async () => new Response(body, { status: 200 }),
      ),
    (error: Error) => error.name === "AbortError",
  );
  assert.equal(bodyCancelled, true);
});

test("model-visible output is terminal-safe and bounded", () => {
  const safeResponse = structuredClone(decisionResponse);
  safeResponse.model = "jev\u202eunsafe";
  const safeResult = formatJevResult(safeResponse);
  assert.equal((safeResult.content[0]?.text ?? "").includes("\u202e"), false);
  assert.match(safeResult.content[0]?.text ?? "", /\\u202e/);
  assert.equal(JSON.parse(safeResult.content[0]?.text ?? "").model, safeResponse.model);

  const answers: JevDecisionResponse["answers"] = {};
  for (let index = 0; index < 2500; index += 1) {
    answers[`question_${index}`] = { type: "noul", noul: 0.5 };
  }
  const bounded = formatJevResult({ model: "jev", answers });
  const text = bounded.content[0]?.text ?? "";
  assert.ok(Buffer.byteLength(text, "utf8") <= DEFAULT_MAX_BYTES);
  assert.ok(text.split("\n").length <= DEFAULT_MAX_LINES);
  assert.match(text, /Jev output truncated/);
  assert.equal(bounded.details.truncated, true);
});
