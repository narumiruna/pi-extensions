import assert from "node:assert/strict";
import type { NoulQuestion, RequestOptions, SystemOneRequest, SystemOneResult } from "@typesafe-ai/sdk";
import { test } from "vitest";
import { JEV_MAX_STATE_BYTES } from "../src/constants.js";
import { JevEvaluator, type SystemOneClient } from "../src/jev-client.js";

class FakeClient implements SystemOneClient {
  readonly requests: Array<{
    request: SystemOneRequest<Record<string, NoulQuestion>>;
    options?: RequestOptions;
  }> = [];

  async systemOne(
    request: SystemOneRequest<Record<string, NoulQuestion>>,
    options?: RequestOptions,
  ): Promise<SystemOneResult<Record<string, NoulQuestion>>> {
    this.requests.push({ request, options });
    const state = request.state as { candidates: Array<{ text: string }> };
    const answers = Object.fromEntries(
      state.candidates.map((candidate, index) => [
        `candidate_${index}`,
        { type: "noul" as const, noul: candidate.text.includes("relevant") ? 0.9 : 0.1 },
      ]),
    );
    return { model: "jev-test", answers, usage: { input_tokens: 10, output_tokens: 2 } };
  }
}

test("Jev evaluator batches candidates, forwards cancellation, and aggregates typed scores and usage", async () => {
  const client = new FakeClient();
  const evaluator = new JevEvaluator("secret-key", client);
  const controller = new AbortController();
  const candidates = Array.from({ length: 9 }, (_, index) => ({
    id: `id-${index}`,
    path: `file-${index}.md`,
    text: index % 2 === 0 ? "relevant evidence" : "unrelated text",
  }));

  const result = await evaluator.evaluate("find evidence", candidates, "chunk", controller.signal);

  assert.equal(client.requests.length, 2);
  assert.equal(result.requests, 2);
  assert.equal(result.inputTokens, 20);
  assert.equal(result.outputTokens, 4);
  assert.equal(result.scores.get("id-0"), 0.9);
  assert.equal(result.scores.get("id-1"), 0.1);
  assert.equal(client.requests[0]?.options?.signal?.aborted, false);
  const questions = client.requests[0]?.request.questions ?? {};
  assert.match(JSON.stringify(questions.candidate_0), /untrusted data/);
});

test.each([
  [null, null, 0, 0],
  [null, 3, 0, 3],
  [7, null, 7, 0],
  [0, 0, 0, 0],
])("Jev evaluator accepts unreported usage (%s, %s)", async (input, output, inputTokens, outputTokens) => {
  const client: SystemOneClient = {
    async systemOne() {
      return {
        model: "jev-test",
        answers: { candidate_0: { type: "noul", noul: 0.9 } },
        usage: { input_tokens: input, output_tokens: output },
      };
    },
  };
  const result = await new JevEvaluator("secret-key", client).evaluate(
    "query",
    [{ id: "one", path: "one", text: "text" }],
    "file",
  );
  assert.equal(result.scores.get("one"), 0.9);
  assert.equal(result.inputTokens, inputTokens);
  assert.equal(result.outputTokens, outputTokens);
});

test("Jev evaluator keeps escaped candidate state within the provider request budget", async () => {
  const client = new FakeClient();
  const evaluator = new JevEvaluator("secret-key", client);
  await evaluator.evaluate(
    "bounded query",
    Array.from({ length: 3 }, (_, index) => ({
      id: String(index),
      path: `file-${index}.txt`,
      text: "\u0001".repeat(8 * 1024),
    })),
    "chunk",
  );

  assert.ok(client.requests.length > 1);
  for (const { request } of client.requests) {
    assert.ok(Buffer.byteLength(JSON.stringify(request.state), "utf8") <= JEV_MAX_STATE_BYTES);
  }
});

test("Jev evaluator rejects invalid responses and redacts the API key from errors", async () => {
  const invalid: SystemOneClient = {
    async systemOne() {
      throw new Error("request with secret-key failed");
    },
  };
  const evaluator = new JevEvaluator("secret-key", invalid);
  await assert.rejects(
    evaluator.evaluate("query", [{ id: "one", path: "one", text: "text" }], "file"),
    (error: Error) => error.message.includes("[REDACTED]") && !error.message.includes("secret-key"),
  );
});

test("Jev evaluator cancels sibling batches after the first request failure", async () => {
  let calls = 0;
  let markSiblingAborted: () => void = () => undefined;
  const siblingAborted = new Promise<void>((resolve) => {
    markSiblingAborted = resolve;
  });
  const client: SystemOneClient = {
    systemOne(_request, options) {
      calls += 1;
      if (calls === 1) return Promise.reject(new Error("first batch failed"));
      return new Promise((_resolve, reject) => {
        const abort = () => {
          markSiblingAborted();
          reject(options?.signal?.reason ?? new DOMException("Aborted", "AbortError"));
        };
        if (options?.signal?.aborted) abort();
        else options?.signal?.addEventListener("abort", abort, { once: true });
      });
    },
  };
  const evaluator = new JevEvaluator("secret-key", client);
  await assert.rejects(
    evaluator.evaluate(
      "query",
      Array.from({ length: 9 }, (_, index) => ({ id: String(index), path: `${index}.md`, text: "candidate" })),
      "file",
    ),
    /first batch failed/,
  );
  await siblingAborted;
  assert.equal(calls, 2);
});

test("Jev evaluator stops before requests when cancelled", async () => {
  const client = new FakeClient();
  const evaluator = new JevEvaluator("secret-key", client);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    evaluator.evaluate("query", [{ id: "one", path: "one", text: "text" }], "file", controller.signal),
    (error: unknown) => Boolean(error instanceof Error && error.name === "AbortError"),
  );
  assert.equal(client.requests.length, 0);
});
