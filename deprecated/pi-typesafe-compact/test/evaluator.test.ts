import assert from "node:assert/strict";
import { test } from "vitest";
import {
  batchHistoryUnits,
  evaluateHistoryUnits,
  JEV_EVALUATOR_MODEL,
  MAX_EVALUATOR_BATCH_UNITS,
  type TypeSafeSystemOneClient,
} from "../src/evaluator.js";
import type { HistoryUnit } from "../src/history-units.js";

function unit(index: number, content = `content-${index}`): HistoryUnit {
  return {
    id: `unit-${index}`,
    order: index,
    kind: "user-text",
    source: "history",
    label: "User",
    content,
  };
}

function clientWith(
  answer: (index: number, request: Record<string, unknown>) => unknown,
  observed: Record<string, unknown>[] = [],
): TypeSafeSystemOneClient {
  return {
    async systemOne(request) {
      observed.push(request as unknown as Record<string, unknown>);
      const names = Object.keys(request.questions);
      return {
        model: JEV_EVALUATOR_MODEL,
        answers: Object.fromEntries(names.map((name, index) => [name, answer(index, request as never)])),
        usage: { input_tokens: names.length * 2, output_tokens: names.length },
      } as never;
    },
  };
}

test("builds explicit jev-latest Noul requests and applies the inclusive threshold", async () => {
  const observed: Record<string, unknown>[] = [];
  const result = await evaluateHistoryUnits(
    clientWith((index) => ({ type: "noul", noul: [0, 0.4999, 0.5, 1][index] }), observed),
    [unit(0), unit(1), unit(2), unit(3)],
    new AbortController().signal,
  );
  assert.deepEqual(
    result.decisions.map(({ summarize, probability }) => [summarize, probability]),
    [
      [false, 0],
      [false, 0.4999],
      [true, 0.5],
      [true, 1],
    ],
  );
  assert.deepEqual(result.usage, { inputTokens: 8, outputTokens: 4 });
  assert.equal(observed.length, 1);
  assert.equal(observed[0]?.model, "jev-latest");
  const questions = observed[0]?.questions as Record<string, { type: string; criteria?: unknown }>;
  assert.equal(Object.keys(questions).length, 4);
  assert.ok(Object.values(questions).every((question) => question.type === "noul"));
  assert.match(JSON.stringify(questions), /Summarize this unit/u);
  assert.doesNotMatch(JSON.stringify(observed[0]), /api[-_ ]?key|secret-value/iu);
});

test("batches deterministically without changing source order", async () => {
  const units = Array.from({ length: MAX_EVALUATOR_BATCH_UNITS + 3 }, (_, index) => unit(index));
  assert.deepEqual(
    batchHistoryUnits(units).map((batch) => batch.length),
    [MAX_EVALUATOR_BATCH_UNITS, 3],
  );
  const observed: Record<string, unknown>[] = [];
  const result = await evaluateHistoryUnits(
    clientWith((index) => ({ type: "noul", noul: index % 2 }), observed),
    units,
    new AbortController().signal,
  );
  assert.equal(observed.length, 2);
  assert.deepEqual(
    result.decisions.map(({ unit: item }) => item.id),
    units.map(({ id }) => id),
  );
});

test("a single oversized evaluator item is rejected before transport", () => {
  assert.throws(() => batchHistoryUnits([unit(0, "x".repeat(100_000))]), /batch limit/u);
});

test.each([
  ["missing", undefined],
  ["wrong type", { type: "score", noul: 1 }],
  ["negative", { type: "noul", noul: -0.1 }],
  ["too large", { type: "noul", noul: 1.1 }],
  ["NaN", { type: "noul", noul: Number.NaN }],
])("rejects %s Noul answers", async (_label, answer) => {
  await assert.rejects(
    evaluateHistoryUnits(
      clientWith(() => answer),
      [unit(0)],
      new AbortController().signal,
    ),
    /invalid or missing Noul answer/u,
  );
});

test.each([
  [null, null, 0, 0],
  [null, 3, 0, 3],
  [7, null, 7, 0],
  [0, 0, 0, 0],
])("accepts unreported evaluator usage (%s, %s)", async (input, output, inputTokens, outputTokens) => {
  const client: TypeSafeSystemOneClient = {
    async systemOne() {
      return {
        model: JEV_EVALUATOR_MODEL,
        answers: { decision_000: { type: "noul", noul: 1 } },
        usage: { input_tokens: input, output_tokens: output },
      } as never;
    },
  };
  const result = await evaluateHistoryUnits(client, [unit(0)], new AbortController().signal);
  assert.equal(result.decisions[0]?.summarize, true);
  assert.deepEqual(result.usage, { inputTokens, outputTokens });
});

test("rejects invalid evaluator usage counts", async () => {
  const invalidUsage = {
    async systemOne() {
      return {
        model: "jev-latest",
        answers: { decision_000: { type: "noul", noul: 1 } },
        usage: { input_tokens: Number.NaN, output_tokens: 1 },
      } as never;
    },
  } as TypeSafeSystemOneClient;
  await assert.rejects(
    evaluateHistoryUnits(invalidUsage, [unit(0)], new AbortController().signal),
    /invalid usage counts/u,
  );
});

test("transport failures and cancellation remain observable", async () => {
  const failing = {
    async systemOne() {
      throw new Error("network failed");
    },
  } as TypeSafeSystemOneClient;
  await assert.rejects(evaluateHistoryUnits(failing, [unit(0)], new AbortController().signal), /network failed/u);

  const controller = new AbortController();
  const aborting = {
    async systemOne() {
      controller.abort();
      return {
        model: "jev-latest",
        answers: { decision_000: { type: "noul", noul: 1 } },
        usage: { input_tokens: 1, output_tokens: 1 },
      } as never;
    },
  } as TypeSafeSystemOneClient;
  await assert.rejects(evaluateHistoryUnits(aborting, [unit(0)], controller.signal), /abort/iu);
});
