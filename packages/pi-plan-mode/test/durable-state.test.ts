import { createHash } from "node:crypto";
import { createRegistry } from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import {
  applyHostMutation,
  fingerprint,
  initialState,
  MAX_RECEIPTS,
  recordHelper,
  type ToolAuthorization,
  validatedPlan,
  validatedQuestions,
  validateOptions,
  validateState,
  viewOf,
} from "../src/durable-state.js";
import type {
  DurablePlanMutation,
  DurablePlanOperation,
  DurablePlanOptions,
  DurablePlanState,
} from "../src/durable-types.js";
import { required } from "./durable-test-values.js";

const options: DurablePlanOptions = {
  registry: createRegistry(),
  registryVersion: "reviewed-v1",
  capabilities: [{ name: "read", policy: "read-only" }],
};
const question = {
  id: "choice",
  header: "Choice",
  question: "Which one?",
  options: [
    { label: "First", description: "Choose first." },
    { label: "Second", description: "Choose second." },
  ],
};
function identity(state: DurablePlanState) {
  return { workflowId: state.workflowId, revision: state.revision };
}
function planning() {
  const state = initialState(1);
  applyHostMutation(
    state,
    1,
    "start",
    { operationId: "start", expected: identity(state), workflowId: "workflow" },
    options,
  );
  return state;
}
function authorization(state: DurablePlanState): ToolAuthorization {
  return {
    owner: 1,
    workflowId: state.workflowId,
    revision: state.revision,
    registryVersion: options.registryVersion,
    mode: "plan",
  };
}
function ready() {
  const state = planning();
  recordHelper(state, 1, 10, "complete", { plan: "  EXACT PLAN\n" }, authorization(state), options.registryVersion);
  return state;
}
function mutation(state: DurablePlanState, operationId = "operation"): DurablePlanMutation {
  return { operationId, expected: identity(state) };
}

describe("durable workflow transitions", () => {
  it("constructs inactive views without mutating state and keeps accepted plan bytes exact", () => {
    expect(viewOf(undefined, 1)).toMatchObject({ phase: "inactive", workflowId: null, revision: 0, forked: false });
    const state = ready();
    expect(state.plan).toBe("  EXACT PLAN\n");
    const view = viewOf(state, 1);
    view.plan = "changed";
    expect(state.plan).toBe("  EXACT PLAN\n");
  });
  it("completion is a proposal, host approval freezes its exact revision and creates pending intent", () => {
    const state = ready();
    expect(state.approval).toBeUndefined();
    const revision = state.revision;
    applyHostMutation(state, 1, "approve", mutation(state), options);
    expect(state).toMatchObject({
      phase: "handoff_pending",
      approval: { planRevision: revision },
      delivery: { kind: "approve", content: "  EXACT PLAN\n", revision: revision + 1 },
    });
    expect(state.approval?.requestId).toBe(state.delivery?.requestId);
  });
  it("revision immediately invalidates the previous implementable plan", () => {
    const state = ready();
    applyHostMutation(state, 1, "revise", { ...mutation(state), feedback: "Change the approach" }, options);
    expect(state.phase).toBe("planning");
    expect(state.plan).toBeUndefined();
    expect(() => applyHostMutation(state, 1, "approve", mutation(state, "approve"), options)).toThrow();
  });
  it("question cancellation does not invent or submit answers", () => {
    const state = planning();
    recordHelper(state, 1, 11, "question", { questions: [question] }, authorization(state), options.registryVersion);
    applyHostMutation(state, 1, "cancel_question", mutation(state), options);
    expect(state.phase).toBe("planning");
    expect(state.question).toBeUndefined();
    expect(state.delivery).toBeUndefined();
  });
  it("answers validate the batch and preserve exact custom text and notes", () => {
    const state = planning();
    recordHelper(state, 1, 11, "question", { questions: [question] }, authorization(state), options.registryVersion);
    const answer = {
      id: question.id,
      header: question.header,
      question: question.question,
      answer: "  raw answer\n",
      note: "  raw note\n",
      wasCustom: true,
    };
    applyHostMutation(state, 1, "answer", { ...mutation(state), batchId: 11, answers: [answer] }, options);
    expect(JSON.parse(required(required(state.delivery).content)).answers[0]).toEqual(answer);
    expect(state.question).toBeUndefined();
    expect(state.phase).toBe("planning");
  });
  it("duplicate operations are no-ops, but changed payloads with the same ID fail", () => {
    const state = ready();
    const input = mutation(state);
    const first = applyHostMutation(state, 1, "approve", input, options);
    const snapshot = structuredClone(state);
    expect(applyHostMutation(state, 1, "approve", structuredClone(input), options)).toEqual({
      receipt: first.receipt,
      duplicate: true,
    });
    expect(state).toEqual(snapshot);
    expect(() =>
      applyHostMutation(state, 1, "approve", { ...input, expected: { ...input.expected, revision: 999 } }, options),
    ).toThrow(/different payload/);
  });
  it("start without a prompt accepts undefined and retries with an omitted prompt", () => {
    const state = initialState(1);
    const input = { operationId: "start", expected: identity(state), workflowId: "workflow" };
    const first = applyHostMutation(state, 1, "start", { ...input, prompt: undefined }, options);
    const before = structuredClone(state);
    expect(first.receipt.status).toBe("done");
    expect(state.delivery).toBeUndefined();
    expect(applyHostMutation(state, 1, "start", input, options)).toEqual({
      receipt: first.receipt,
      duplicate: true,
    });
    expect(() => applyHostMutation(state, 1, "start", { ...input, prompt: "changed" }, options)).toThrow(
      /different payload/,
    );
    expect(state).toEqual(before);
  });
  it.each([true, false])("answers omit undefined optionals and replay exactly (custom=%s)", (wasCustom) => {
    const state = planning();
    recordHelper(state, 1, 11, "question", { questions: [question] }, authorization(state), options.registryVersion);
    const answer = {
      id: question.id,
      header: question.header,
      question: question.question,
      answer: wasCustom ? "  custom answer\n" : "First",
      wasCustom,
      ...(wasCustom ? {} : { optionIndex: 1 }),
    };
    const input = { ...mutation(state), batchId: 11, answers: [answer] };
    const first = applyHostMutation(
      state,
      1,
      "answer",
      { ...input, answers: [{ ...answer, optionIndex: answer.optionIndex, note: undefined }] },
      options,
    );
    const before = structuredClone(state);
    expect(JSON.parse(required(required(state.delivery).content)).answers).toEqual([answer]);
    expect(applyHostMutation(state, 1, "answer", input, options)).toEqual({
      receipt: first.receipt,
      duplicate: true,
    });
    expect(() =>
      applyHostMutation(state, 1, "answer", { ...input, answers: [{ ...answer, note: "changed" }] }, options),
    ).toThrow(/different payload/);
    expect(state).toEqual(before);
  });
  it("concurrent approval and revision cannot both use the same ready revision", () => {
    const state = ready();
    const expected = identity(state);
    applyHostMutation(state, 1, "approve", { operationId: "approve", expected }, options);
    expect(() =>
      applyHostMutation(state, 1, "revise", { operationId: "revise", expected, feedback: "change" }, options),
    ).toThrow(/Stale/);
  });
  it("forks retain reviewable plans but mask delivery, questions, receipts, and authorization", () => {
    const state = ready();
    applyHostMutation(state, 1, "approve", mutation(state), options);
    const view = viewOf(state, 2);
    expect(view).toMatchObject({
      forked: true,
      phase: "inactive",
      plan: "  EXACT PLAN\n",
      receipts: [],
      helperReceipts: [],
    });
    expect(view.approval).toBeUndefined();
    expect(view.delivery).toBeUndefined();
    expect(() => applyHostMutation(state, 2, "approve", mutation(state, "fork-approve"), options)).toThrow(/Fork/);
    expect(() =>
      applyHostMutation(state, 2, "start", { ...mutation(state, "fork-start"), workflowId: "workflow" }, options),
    ).toThrow(/new identity/);
    applyHostMutation(state, 2, "start", { ...mutation(state, "fork-start"), workflowId: "fork-workflow" }, options);
    expect(state).toMatchObject({ owner: 2, workflowId: "fork-workflow", phase: "planning", helperReceipts: [] });
    expect(state.plan).toBeUndefined();
    expect(state.approval).toBeUndefined();
  });
  it("explicit discard remains possible after the host changes registry version", () => {
    const state = ready();
    applyHostMutation(state, 1, "discard", mutation(state), { ...options, registryVersion: "reviewed-v2" });
    expect(state).toMatchObject({ phase: "inactive", closing: true, delivery: { kind: "discard" } });
  });
  it("bounded receipt history rejects evicted operation retries through stale revisions", () => {
    const state = planning();
    const old = mutation(state, "old");
    applyHostMutation(state, 1, "discard", old, options);
    delete state.delivery;
    delete state.closing;
    for (let i = 0; i < MAX_RECEIPTS; i++) {
      applyHostMutation(state, 1, "start", { ...mutation(state, `start-${i}`), workflowId: `workflow-${i}` }, options);
      applyHostMutation(state, 1, "discard", mutation(state, `discard-${i}`), options);
      delete state.delivery;
      delete state.closing;
    }
    expect(state.receipts).toHaveLength(MAX_RECEIPTS);
    expect(() => applyHostMutation(state, 1, "discard", old, options)).toThrow(/Stale/);
  });
  it.each<DurablePlanOperation>(["answer", "cancel_question", "revise", "approve", "discard"])(
    "inactive workflow rejects %s before effect",
    (kind) => {
      const state = initialState(1);
      const before = structuredClone(state);
      expect(() => applyHostMutation(state, 1, kind, mutation(state), options)).toThrow();
      expect(state).toEqual(before);
    },
  );
});

describe("durable validation and helper replay", () => {
  it("helper replay is exact and does not increment the revision again", () => {
    const state = planning();
    const auth = authorization(state);
    const input = { plan: "exact" };
    recordHelper(state, 1, 10, "complete", input, auth, options.registryVersion);
    const before = structuredClone(state);
    recordHelper(state, 1, 10, "complete", input, auth, options.registryVersion);
    expect(state).toEqual(before);
    expect(() => recordHelper(state, 1, 10, "complete", { plan: "different" }, auth, options.registryVersion)).toThrow(
      /replay/,
    );
    applyHostMutation(state, 1, "discard", mutation(state), options);
    expect(() => recordHelper(state, 1, 10, "complete", input, auth, options.registryVersion)).toThrow(/replay/);
  });
  it.each(["", " ", "x".repeat(50_001)])("rejects invalid plan length or blank content", (plan) => {
    expect(() => validatedPlan({ plan })).toThrow();
  });
  it("accepts exactly 50,000 JavaScript characters without truncation", () => {
    const plan = "界".repeat(50_000);
    expect(validatedPlan({ plan })).toBe(plan);
  });
  it("bounds questions, IDs, headers, options and aggregate serialization", () => {
    for (const questions of [
      [],
      Array(4).fill(question),
      [{ ...question, id: "bad id" }],
      [{ ...question, header: "x".repeat(13) }],
      [{ ...question, question: "x".repeat(1_001) }],
      [{ ...question, options: [] }],
      [question, question],
    ]) {
      expect(() => validatedQuestions({ questions })).toThrow();
    }
    expect(validatedQuestions({ questions: [question] })).toEqual([question]);
  });
  it.each(["edit", "write", "update_plan", "plan_mode_question", "plan_mode_complete"])(
    "cannot mark %s as a reviewed planning capability",
    (name) => {
      expect(() => validateOptions({ ...options, capabilities: [{ name, policy: "read-only" }] })).toThrow();
    },
  );
  it("registry versions and capability lists must be explicit, valid and bounded", () => {
    expect(() => validateOptions({ ...options, registryVersion: "" })).toThrow();
    expect(() =>
      validateOptions({ ...options, capabilities: [...options.capabilities, ...options.capabilities] }),
    ).toThrow();
    expect(() =>
      validateOptions({ ...options, capabilities: Array(129).fill({ name: "read", policy: "read-only" }) }),
    ).toThrow();
  });
  it("rejects unsupported state without overwriting it", () => {
    const state = { ...initialState(1), version: 2 } as unknown as DurablePlanState;
    expect(() => validateState(state)).toThrow(/Unsupported/);
    expect(state.version).toBe(2);
  });
  it("fingerprints are structural rather than object key order dependent", () => {
    expect(fingerprint({ a: 1, b: { c: 2, d: 3 } })).toBe(fingerprint({ b: { d: 3, c: 2 }, a: 1 }));
  });
  it.each([
    [{ optional: undefined }, {}],
    [{ a: 1, optional: undefined }, { a: 1 }],
    [
      { b: { optional: undefined, c: 2 }, a: 1 },
      { a: 1, b: { c: 2 } },
    ],
    [
      [{ optional: undefined, note: "" }, { nested: { optional: undefined } }],
      [{ note: "" }, { nested: {} }],
    ],
  ])("fingerprints omit undefined object properties: %j", (input, omitted) => {
    const before = structuredClone(input);
    expect(fingerprint(input)).toBe(fingerprint(omitted));
    expect(input).toEqual(before);
  });
  it.each([
    { label: "root", input: undefined },
    { label: "array element", input: [undefined] },
    { label: "later array element", input: [1, undefined] },
    { label: "object's array element", input: { nested: [undefined] } },
    { label: "nested array element", input: [{ nested: [undefined] }] },
  ])("fingerprints reject undefined at $label", ({ input }) => {
    expect(() => fingerprint(input)).toThrow("Operation payload must be JSON");
  });
  it.each<[unknown, string]>([
    [null, "null"],
    [true, "true"],
    [false, "false"],
    [0, "0"],
    [-0, "0"],
    [1.25, "1.25"],
    ["  exact\n界", '"  exact\\n界"'],
    [[], "[]"],
    [[null, false, 2, { b: 1, a: 0 }], '[null,false,2,{"a":0,"b":1}]'],
    [{ z: { b: 2, a: 1 }, a: [], "10": "ten", "2": "two" }, '{"2":"two","10":"ten","a":[],"z":{"a":1,"b":2}}'],
  ])("preserves existing valid JSON fingerprints: %j", (input, canonical) => {
    expect(fingerprint(input)).toBe(createHash("sha256").update(canonical).digest("hex"));
  });
});
